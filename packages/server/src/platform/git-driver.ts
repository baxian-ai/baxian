import { SINGLE_RESOURCE_OPS, type CommentSourceOp, type DriverOp, type DriverSpec } from './types.js';
import { renderCommand, type RenderContext } from './command-renderer.js';
import { runDriverPreflightSteps, type DriverPreflightStepResult } from './preflight-exec.js';
import { parseJsonResponse, parseJsonPagedPage } from './response-parser.js';
import { mapResponse } from './field-mapper.js';
import { validateRows, type NormalizedRow } from './row-schema.js';
import { isGitHubRepo, repoSlug, parseRepoUrlParts } from '../shared/git-url.js';
import { isRecord } from '../shared/index.js';
import { createHash } from 'node:crypto';

export const DRIVER_MAX_BUFFER = 64 * 1024 * 1024;
export const DRIVER_EXEC_TIMEOUT_MS = 60_000;
// listPrs 的 10 页封顶是发现窗口（v1 §6，正常终止）；评论源无业务水位上限，
// 命中 100 页即 fail closed——「最终必有空页」不是声明式输出可验证的契约（spec §5.3 增量⑦）。
export const LIST_PRS_PAGE_CAP = 10;
export const COMMENT_SOURCE_PAGE_CAP = 100;
const STDERR_TAIL_CHARS = 500;

export interface DriverExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type DriverExec = (command: string, opts: { timeout: number; maxBuffer: number }) => Promise<DriverExecResult>;

export class DriverOpError extends Error {
  constructor(
    message: string,
    readonly info: { opName: string; errorClass?: string; exitCode?: number; stderrTail?: string },
  ) {
    super(message);
    this.name = 'DriverOpError';
  }
}

// 跨 HTTP/日志边界的错误一律有界投影：DriverOpError 的 message 携 stderr 尾部，
// RowSchemaError 等会把非法值整个 JSON.stringify 进 message（实测可达数 MiB）——
// 未知错误只保留类名与截断后的短摘要，原文不出边界。
const SAFE_ERROR_SUMMARY_CHARS = 200;

export function safeDriverErrorText(err: unknown): string {
  if (err instanceof DriverOpError) {
    const cls = err.info.errorClass ? `, class ${err.info.errorClass}` : '';
    return `op ${err.info.opName} failed (exit ${err.info.exitCode ?? 'n/a'}${cls})`;
  }
  if (err instanceof Error) {
    const head = err.message.slice(0, SAFE_ERROR_SUMMARY_CHARS);
    const clipped = err.message.length > SAFE_ERROR_SUMMARY_CHARS ? '…' : '';
    return `${err.name}: ${head}${clipped}`;
  }
  return String(err).slice(0, SAFE_ERROR_SUMMARY_CHARS);
}

export interface OpVars {
  prNumber?: number;
  expectedHeadSha?: string;
  remoteProjectId?: string;
  branch?: string;
}

export function buildDriverRunContext(repoUrl: string, binary: string): RenderContext {
  const t = repoUrl.trim();
  if (isGitHubRepo(t)) {
    return { scheme: 'https', hostname: 'github.com', host: 'github.com', repoPath: repoSlug(t), binary };
  }
  // 与 repoIdentityKey 同一分解（shared/git-url）：cursor 身份与命令渲染对同一 URL 的解读不分叉。
  const parts = parseRepoUrlParts(t);
  if (parts === null) throw new Error(`cannot derive driver context from repo URL: ${t}`);
  return {
    scheme: parts.scheme,
    hostname: parts.hostname,
    host: parts.port === '' ? parts.hostname : `${parts.hostname}:${parts.port}`,
    repoPath: parts.path,
    binary,
  };
}

const tail = (s: string) => (s.length > STDERR_TAIL_CHARS ? s.slice(-STDERR_TAIL_CHARS) : s);

interface PagedOpts {
  pageCap: number;
  capBehavior: 'stop' | 'fail';
  // 分页进度身份按行契约由各 op 入口声明（listPrs=prNumber、评论源=id），
  // 通用 runner 不内嵌 op 名假设——第三个分页 op 会被迫显式选择而非静默继承。
  idField: 'prNumber' | 'id';
  sourceKey?: string;
  shouldStop?: (pageRows: NormalizedRow[], page: number) => boolean;
  // 页内投影钩子（spec v1 §6 页内管线）：调用方在页内折算并释放原文，跨页只聚合投影行。
  projectPage?: (pageRows: NormalizedRow[]) => NormalizedRow[];
}

export class GitDriver {
  private readonly errorMatchers: Array<{ class: string; regexes: RegExp[] }>;
  readonly preflightIdentity: string;

  constructor(
    private readonly plugin: { spec: DriverSpec; manifest?: { minToolVersion: string } },
    private readonly ctx: RenderContext,
    private readonly exec: DriverExec,
  ) {
    this.preflightIdentity = createHash('sha256').update(JSON.stringify({
      preflight: plugin.spec.preflight,
      minToolVersion: plugin.manifest?.minToolVersion ?? '',
      ctx,
    }), 'utf8').digest('hex');
    // 声明期常量模式一次编译（无 g 标志，test 无 lastIndex 状态）；失败风暴期每次 exec 免重编译。
    this.errorMatchers = plugin.spec.errorClasses.map(c => ({
      class: c.class,
      regexes: c.regex.map(r => new RegExp(r)),
    }));
  }

  get visibilityLagMs(): number {
    return this.plugin.spec.visibilityLagSeconds * 1000;
  }

  get commentSources(): CommentSourceOp[] {
    return this.plugin.spec.commentSources;
  }

  async runPreflightSteps(): Promise<DriverPreflightStepResult[]> {
    // 限流失败折叠成普通结果会绕过 poller 的 RateLimitAbort 退避，持续加重 secondary limit。
    let rateLimited: string | undefined;
    const results = await runDriverPreflightSteps(
      (cmd) => this.exec(cmd, { timeout: DRIVER_EXEC_TIMEOUT_MS, maxBuffer: DRIVER_MAX_BUFFER }),
      this.plugin.spec.preflight,
      { ...this.ctx, minToolVersion: this.plugin.manifest?.minToolVersion ?? '' },
      (step, rawOutput) => {
        if (this.classify(rawOutput) === 'RATE_LIMIT') rateLimited = step;
      },
    );
    if (rateLimited !== undefined) {
      throw new DriverOpError(`preflight ${rateLimited} failed (class RATE_LIMIT)`, {
        opName: rateLimited, errorClass: 'RATE_LIMIT',
      });
    }
    return results;
  }

  classify(text: string): string | undefined {
    for (const c of this.errorMatchers) {
      if (c.regexes.some(r => r.test(text))) return c.class;
    }
    return undefined;
  }

  async runOp(opName: string, vars: OpVars = {}): Promise<NormalizedRow[]> {
    const op = this.namedOp(opName);
    if (op.parse === 'json-paged') {
      throw new DriverOpError(`op ${opName} is paged; use the paged runner`, { opName });
    }
    let rows: NormalizedRow[];
    try {
      const result = await this.execRendered(opName, op, vars);
      rows = result === 'treated-success' || op.parse === undefined
        ? []
        : validateRows(opName, mapResponse(opName, op, parseJsonResponse(result.stdout)));
    } catch (e) {
      // optional op 不可用仅能力降级、不计健康度（spec §5.3/§7 listApprovals 语义）；生命周期
      // 必需 op 与评论源在加载期即拒绝 optional。降级只吞执行失败（DriverOpError）——命令
      // 成功后的 parse/schema 错误是插件缺陷，照常 fail loud。
      if (op.optional === true && e instanceof DriverOpError) return [];
      throw e;
    }
    // 单资源 op 的空/多行响应是 fail-open 洞：null/标量被归一成零行后上层只会静默跳过，
    // 项目/PR 永久停摆而健康度仍显示成功——按 op 契约恰好一行，违例 fail closed。
    // 检查对 parse 缺失/treated-success 的零行同样生效（加载期契约之外的运行时纵深）。
    if (SINGLE_RESOURCE_OPS.has(opName) && rows.length !== 1) {
      throw new DriverOpError(
        `op ${opName} must yield exactly one row (got ${rows.length})`,
        { opName },
      );
    }
    return rows;
  }

  async runListPrs(
    vars: OpVars,
    shouldStop?: (pageRows: NormalizedRow[], page: number) => boolean,
  ): Promise<NormalizedRow[]> {
    return this.runPaged('listPrs', this.namedOp('listPrs'), vars, {
      pageCap: LIST_PRS_PAGE_CAP, capBehavior: 'stop', idField: 'prNumber', shouldStop,
    });
  }

  async runCommentSource(
    source: CommentSourceOp,
    vars: OpVars,
    projectPage?: (pageRows: NormalizedRow[]) => NormalizedRow[],
    shouldStop?: (pageRows: NormalizedRow[], page: number) => boolean,
  ): Promise<NormalizedRow[]> {
    return this.runPaged('listComments', source, vars, {
      pageCap: COMMENT_SOURCE_PAGE_CAP, capBehavior: 'fail', idField: 'id', sourceKey: source.key, projectPage, shouldStop,
    });
  }

  private namedOp(opName: string): DriverOp {
    const op = this.plugin.spec.ops[opName];
    if (!op) throw new DriverOpError(`op ${opName} is not declared by the driver`, { opName });
    return op;
  }

  private async execRendered(
    opName: string,
    op: DriverOp,
    vars: OpVars & { page?: number },
  ): Promise<DriverExecResult | 'treated-success'> {
    const cmd = renderCommand(op, { ...this.ctx, ...vars });
    const result = await this.exec(cmd, { timeout: DRIVER_EXEC_TIMEOUT_MS, maxBuffer: DRIVER_MAX_BUFFER });
    if (result.exitCode === 0) {
      if (op.responseEnvelope === 'graphql') this.assertGraphqlEnvelope(opName, result);
      return result;
    }
    const output = `${result.stderr}\n${result.stdout}`;
    const cls = this.classify(output);
    if (cls !== undefined && op.treatAsSuccess?.includes(cls)) return 'treated-success';
    throw new DriverOpError(
      `op ${opName} failed (exit ${result.exitCode}${cls ? `, class ${cls}` : ''}): ${tail(output.trim())}`,
      { opName, errorClass: cls, exitCode: result.exitCode, stderrTail: tail(output.trim()) },
    );
  }

  private assertGraphqlEnvelope(opName: string, result: DriverExecResult): void {
    const { stdout, stderr } = result;
    const errorInfo = () => ({
      opName,
      errorClass: this.classify(`${stderr}\n${stdout}`),
      exitCode: 0,
      stderrTail: tail(stdout),
    });
    let payload: unknown;
    try {
      payload = parseJsonResponse(stdout);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new DriverOpError(`op ${opName} returned an invalid GraphQL envelope: ${message}`, errorInfo());
    }
    if (!isRecord(payload)) {
      throw new DriverOpError(`op ${opName} returned a malformed GraphQL envelope`, errorInfo());
    }
    const errors = payload.errors;
    if (errors !== undefined && !Array.isArray(errors)) {
      throw new DriverOpError(`op ${opName} returned malformed GraphQL errors`, errorInfo());
    }
    if (Array.isArray(errors) && errors.length > 0) {
      throw new DriverOpError(`op ${opName} failed with GraphQL errors: ${tail(JSON.stringify(errors))}`, errorInfo());
    }
    if (!Object.hasOwn(payload, 'data')) {
      throw new DriverOpError(`op ${opName} returned a GraphQL envelope without data`, errorInfo());
    }
  }

  private async runPaged(rowOp: string, op: DriverOp, vars: OpVars, opts: PagedOpts): Promise<NormalizedRow[]> {
    const label = opts.sourceKey === undefined ? rowOp : `${rowOp}[${opts.sourceKey}]`;
    const { idField } = opts;
    const all: NormalizedRow[] = [];
    // 页码分页在扫描期间有排序前移时，相邻页可部分重叠（GitHub sort=updated 已知形态）：
    // 同身份同内容 = 位移重复、静默去重；同身份异内容 = 同扫描内版本冲突，fail closed 下轮重扫。
    const seen = new Map<string, string>();
    let prevIds: Set<string> | undefined;
    for (let page = 1; page <= opts.pageCap; page++) {
      const result = await this.execRendered(label, op, { ...vars, page });
      if (result === 'treated-success') {
        throw new DriverOpError(`op ${label}: treatAsSuccess is not valid on a paged read`, { opName: label });
      }
      const rawPage = parseJsonPagedPage(result.stdout);
      if (rawPage.length === 0) return all;
      // 投影先于指纹：指纹对原文 stringify 会把整页 body 再序列化一遍并在 seen 里滞留到扫描
      // 结束，绕开「跨页只聚合投影行」的内存界；bodyDigest 已入投影行，任何正文差异仍必然
      // 改变指纹，冲突检测语义等价。
      const rows = validateRows(
        rowOp,
        mapResponse(rowOp, op, rawPage),
        opts.sourceKey === undefined ? undefined : { sourceKey: opts.sourceKey },
      );
      const projected = opts.projectPage === undefined ? rows : opts.projectPage(rows);
      const ids = new Set(projected.map(r => String(r[idField])));
      // flatten 源可能整页映射零行，空集合相等不构成「后端未消费 {page}」的证据。
      if (prevIds !== undefined && prevIds.size > 0 && ids.size === prevIds.size && [...ids].every(i => prevIds!.has(i))) {
        throw new DriverOpError(
          `op ${label}: pagination did not advance at page ${page} (backend ignoring {page}?)`,
          { opName: label },
        );
      }
      prevIds = ids;
      for (const row of projected) {
        const key = String(row[idField]);
        const fingerprint = JSON.stringify(row);
        const prior = seen.get(key);
        if (prior === undefined) {
          seen.set(key, fingerprint);
          all.push(row);
          continue;
        }
        if (prior === fingerprint) continue;
        throw new DriverOpError(
          `op ${label}: conflicting duplicate row for ${idField}=${key} across pages (mid-scan mutation)`,
          { opName: label },
        );
      }
      if (opts.shouldStop?.(projected, page) === true) return all;
    }
    if (opts.capBehavior === 'fail') {
      throw new DriverOpError(
        `op ${label}: exceeded page cap ${opts.pageCap} (refusing silent truncation)`,
        { opName: label },
      );
    }
    return all;
  }
}
