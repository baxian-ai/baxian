import { randomBytes } from 'node:crypto';
import {
  isRecord,
  MAX_INLINE_CONTENT_BYTES,
  MAX_READ_FILE_BYTES,
  REVIEW_EXCHANGE_DIR,
  REVIEW_INBOX_DIR,
  RESEARCH_DOCS_DIR,
  SPEC_DOC_RELPATH,
  mapWithConcurrency,
  FS_READ_CONCURRENCY,
  renderSpecDocuments,
  type AgentConfig,
  type Finding,
  type ReviewContentFileRef,
  type ReviewFindings,
  type ReviewResponse,
  type SpecDocument,
  type TaskPhase,
  type TaskState,
} from '../shared/index.js';
import { shellQuote, type CommandRunner, type ExecResult } from './runner.js';
import { GIT_NET_ENV, execNetwork } from './net-exec.js';
import { ancestorSymlinkGuard, ensureBaxianRuntimeDirsSafe, guardedRemoveClause, moveFileIntoPlace, stageFileGuarded, sweepStrayFile } from './repo-store.js';


export class ReviewExchangeError extends Error {
  constructor(
    public readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'ReviewExchangeError';
  }
}

export interface ReadContentResult {
  content: string;
  documents?: SpecDocument[];
  diffstat?: string;
  baseSha?: string;
  headSha?: string;
  headTree?: string;
  defaultBranch?: string;
}

export interface ReviewTransportDeps {
  createRunnerFor(agent: AgentConfig): CommandRunner;
  resolveWorkdir(agentId: string): string | undefined;
}


const SEVERITIES = new Set(['critical', 'major', 'minor']);
const VERDICTS = new Set(['approve', 'request-changes']);
const ACTIONS = new Set(['fix', 'reject', 'out-of-scope']);
const REVIEW_DIFF_MAX_BUFFER_BYTES = 256 * 1024 * 1024;
const SPEC_DOC_MAX_BYTES = 8 * 1024 * 1024;
const RESEARCH_DOC_MAX_BYTES = 1024 * 1024;
const RESEARCH_DOCS_TOTAL_MAX_BYTES = 8 * 1024 * 1024;
const RESEARCH_DOCS_MAX_COUNT = 64;

export function validateReviewFindings(raw: unknown): ReviewFindings {
  if (!isRecord(raw)) throw new ReviewExchangeError('schema', 'findings: not an object');
  if (typeof raw.round !== 'number' || !Number.isInteger(raw.round) || raw.round < 1) {
    throw new ReviewExchangeError('schema', 'findings.round must be a positive integer');
  }
  if (typeof raw.verdict !== 'string' || !VERDICTS.has(raw.verdict)) {
    throw new ReviewExchangeError('schema', `findings.verdict invalid: ${String(raw.verdict)}`);
  }
  if (!Array.isArray(raw.findings)) {
    throw new ReviewExchangeError('schema', 'findings.findings must be an array');
  }
  const ids = new Set<string>();
  for (const f of raw.findings) {
    if (!isRecord(f)) throw new ReviewExchangeError('schema', 'finding: not an object');
    if (typeof f.id !== 'string' || f.id.trim() === '') {
      throw new ReviewExchangeError('schema', 'finding.id must be a non-empty string');
    }
    if (ids.has(f.id)) throw new ReviewExchangeError('schema', `duplicate finding id: ${f.id}`);
    ids.add(f.id);
    if (typeof f.severity !== 'string' || !SEVERITIES.has(f.severity)) {
      throw new ReviewExchangeError('schema', `finding.severity invalid: ${String(f.severity)}`);
    }
    if (typeof f.message !== 'string' || f.message.trim() === '') {
      throw new ReviewExchangeError('schema', `finding.message missing for ${f.id}`);
    }
  }
  const verdict = raw.verdict as ReviewFindings['verdict'];
  if (verdict === 'approve') {
    const blocking = (raw.findings as Finding[]).find(f => f.severity !== 'minor');
    if (blocking) {
      throw new ReviewExchangeError(
        'verdict-conflict',
        `approve with ${blocking.severity} finding ${blocking.id}`,
      );
    }
  } else if ((raw.findings as Finding[]).length === 0) {
    throw new ReviewExchangeError('verdict-conflict', 'request-changes with no findings');
  }
  return raw as unknown as ReviewFindings;
}

export function validateReviewResponse(raw: unknown): ReviewResponse {
  if (!isRecord(raw)) throw new ReviewExchangeError('schema', 'response: not an object');
  if (typeof raw.round !== 'number' || !Number.isInteger(raw.round) || raw.round < 1) {
    throw new ReviewExchangeError('schema', 'response.round must be a positive integer');
  }
  if (!Array.isArray(raw.responses)) {
    throw new ReviewExchangeError('schema', 'response.responses must be an array');
  }
  const responseIds = new Set<string>();
  for (const r of raw.responses) {
    if (!isRecord(r)) throw new ReviewExchangeError('schema', 'response item: not an object');
    if (typeof r.findingId !== 'string' || r.findingId.trim() === '') {
      throw new ReviewExchangeError('schema', 'response.findingId must be a non-empty string');
    }
    if (responseIds.has(r.findingId)) {
      throw new ReviewExchangeError('schema', `duplicate response findingId: ${r.findingId}`);
    }
    responseIds.add(r.findingId);
    if (typeof r.action !== 'string' || !ACTIONS.has(r.action)) {
      throw new ReviewExchangeError('schema', `response.action invalid: ${String(r.action)}`);
    }
    if (typeof r.rationale !== 'string' || r.rationale.trim() === '') {
      throw new ReviewExchangeError('schema', `response.rationale missing for ${r.findingId}`);
    }
  }
  return raw as unknown as ReviewResponse;
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  let cut = maxBytes;
  while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--;
  return { text: buf.subarray(0, cut).toString('utf8'), truncated: true };
}

export class ReviewTransport {
  constructor(private readonly deps: ReviewTransportDeps) {}

  async clearDispatchOutputs(agent: AgentConfig, workdir: string, phase: string): Promise<void> {
    const resetsSpecDocuments = phase === 'develop' || phase === 'research';
    const paths = [
      `${workdir}/${REVIEW_EXCHANGE_DIR}/findings.json`,
      `${workdir}/${REVIEW_EXCHANGE_DIR}/response.json`,
      ...(resetsSpecDocuments ? [`${workdir}/${SPEC_DOC_RELPATH}`] : []),
    ];
    const runner = this.deps.createRunnerFor(agent);
    await this.ensureRuntimeDirs(runner, workdir);
    const result = await runner.exec(
      paths.map(p => guardedRemoveClause(workdir, p)).join(' && '),
    );
    if (result.exitCode !== 0) {
      throw new ReviewExchangeError(
        'artifact-cleanup-failed',
        `failed to clear stale dispatch outputs: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      );
    }
    if (resetsSpecDocuments) {
      const researchDir = `${workdir}/${RESEARCH_DOCS_DIR}`;
      const cleared = await runner.exec(guardedRemoveClause(workdir, researchDir, { recursive: true }));
      if (cleared.exitCode !== 0) {
        throw new ReviewExchangeError(
          'artifact-cleanup-failed',
          `failed to clear stale research docs: ${cleared.stderr.trim() || `exit ${cleared.exitCode}`}`,
        );
      }
      await this.ensureRuntimeDirs(runner, workdir);
    }
  }

  async readContent(task: TaskState, devAgent: AgentConfig, phase: TaskPhase): Promise<ReadContentResult> {
    const wt = this.requireWorkdir(devAgent.id);
    const runner = this.deps.createRunnerFor(devAgent);
    if (phase === 'spec') {
      const documents = await this.readSpecDocuments(devAgent);
      return { content: renderSpecDocuments(documents), documents };
    }
    const cd = `cd ${shellQuote(wt)} && `;
    let fetch: ExecResult;
    try {
      fetch = await execNetwork(runner, `${cd}${GIT_NET_ENV} git fetch origin --quiet`);
    } catch (err) {
      throw new ReviewExchangeError(
        'fetch-failed',
        `git fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (fetch.exitCode !== 0) {
      throw new ReviewExchangeError('fetch-failed', `git fetch failed: ${fetch.stderr.trim()}`);
    }
    const db = await runner.exec(`${cd}git symbolic-ref --short refs/remotes/origin/HEAD`);
    if (db.exitCode !== 0) {
      throw new ReviewExchangeError('default-branch-failed', `origin/HEAD unresolved: ${db.stderr.trim()}`);
    }
    const defaultBranch = db.stdout.trim().replace(/^origin\//, '') || 'main';
    const base = `origin/${defaultBranch}`;
    const head = await runner.exec(`${cd}git rev-parse HEAD`);
    if (head.exitCode !== 0 || head.stdout.trim() === '') {
      throw new ReviewExchangeError('head-failed', `git rev-parse HEAD failed: ${head.stderr.trim()}`);
    }
    const headSha = head.stdout.trim();
    const sha = await runner.exec(`${cd}git merge-base ${shellQuote(base)} ${shellQuote(headSha)}`);
    if (sha.exitCode !== 0) {
      throw new ReviewExchangeError('merge-base-failed', `git merge-base failed: ${sha.stderr.trim()}`);
    }
    const baseSha = sha.stdout.trim();
    const tree = await runner.exec(`${cd}git rev-parse ${shellQuote(`${headSha}^{tree}`)}`);
    if (tree.exitCode !== 0 || tree.stdout.trim() === '') {
      throw new ReviewExchangeError('head-tree-failed', `git rev-parse HEAD tree failed: ${tree.stderr.trim()}`);
    }
    const headTree = tree.stdout.trim();
    const stat = await runner.exec(
      `${cd}git -c core.quotepath=false diff --stat ${shellQuote(baseSha)} ${shellQuote(headSha)}`,
    );
    if (stat.exitCode !== 0) {
      throw new ReviewExchangeError('diffstat-failed', `git diff --stat failed: ${stat.stderr.trim()}`);
    }
    const diff = await runner.exec(
      `${cd}git -c core.quotepath=false diff --binary ${shellQuote(baseSha)} ${shellQuote(headSha)}`,
      { maxBuffer: REVIEW_DIFF_MAX_BUFFER_BYTES },
    );
    if (diff.exitCode !== 0) {
      throw new ReviewExchangeError('diff-failed', `git diff failed: ${diff.stderr.trim()}`);
    }
    return {
      content: diff.stdout,
      diffstat: stat.stdout,
      baseSha,
      headSha,
      headTree,
      defaultBranch,
    };
  }

  async readSpecDocuments(agent: AgentConfig): Promise<SpecDocument[]> {
    const workdir = this.requireWorkdir(agent.id);
    const runner = this.deps.createRunnerFor(agent);
    await this.ensureRuntimeDirs(runner, workdir);
    const specPath = `${workdir}/${SPEC_DOC_RELPATH}`;
    const researchDir = `${workdir}/${RESEARCH_DOCS_DIR}`;
    const [spec, listing] = await Promise.all([
      runner.exec(
        `if [ -f ${shellQuote(specPath)} ] && [ ! -L ${shellQuote(specPath)} ]; then cat ${shellQuote(specPath)}; else exit 4; fi`,
        { maxBuffer: SPEC_DOC_MAX_BYTES },
      ).catch((err: unknown) => {
        throw new ReviewExchangeError(
          'spec-too-large',
          `spec doc unreadable or too large: ${err instanceof Error ? err.message : String(err)}`,
        );
      }),
      runner.exec(
        `if find ${shellQuote(researchDir)} -maxdepth 1 -type l -name '*.md' -print -quit | grep -q .; then exit 5; fi; `
        + `find ${shellQuote(researchDir)} -maxdepth 1 -type f -name '*.md' -print0`,
      ),
    ]);
    if (spec.exitCode !== 0) {
      throw new ReviewExchangeError('spec-missing', `spec doc missing, unreadable, or a symlink: ${spec.stderr.trim()}`);
    }
    if (listing.exitCode !== 0) {
      throw new ReviewExchangeError(
        'research-docs-list-failed',
        `research docs listing failed or contains symlinks: ${listing.stderr.trim()}`,
      );
    }
    const relPaths = listing.stdout
      .split('\0')
      .filter(Boolean)
      .map(path => path.startsWith(`${workdir}/`) ? path.slice(workdir.length + 1) : path)
      .sort();
    if (relPaths.length > RESEARCH_DOCS_MAX_COUNT) {
      throw new ReviewExchangeError(
        'research-docs-too-many',
        `research docs exceed the ${RESEARCH_DOCS_MAX_COUNT}-file limit (${relPaths.length})`,
      );
    }
    const reads = await mapWithConcurrency(relPaths, FS_READ_CONCURRENCY, relPath =>
      runner.exec(`cat ${shellQuote(`${workdir}/${relPath}`)}`, { maxBuffer: RESEARCH_DOC_MAX_BYTES })
        .catch((err: unknown) => {
          throw new ReviewExchangeError(
            'research-doc-too-large',
            `research doc unreadable or too large: ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }),
    );
    let totalBytes = 0;
    const documents: SpecDocument[] = [{ relPath: SPEC_DOC_RELPATH, content: spec.stdout }];
    relPaths.forEach((relPath, index) => {
      const result = reads[index]!;
      if (result.exitCode !== 0) {
        throw new ReviewExchangeError('research-doc-unreadable', `research doc unreadable: ${relPath}`);
      }
      totalBytes += Buffer.byteLength(result.stdout, 'utf8');
      if (totalBytes > RESEARCH_DOCS_TOTAL_MAX_BYTES) {
        throw new ReviewExchangeError(
          'research-docs-too-large',
          `research docs exceed the ${RESEARCH_DOCS_TOTAL_MAX_BYTES}-byte total limit`,
        );
      }
      documents.push({ relPath, content: result.stdout });
    });
    return documents;
  }

  async replaceSpecDocuments(
    agent: AgentConfig,
    workdir: string,
    documents: readonly SpecDocument[],
    assertOwner: () => Promise<void>,
  ): Promise<void> {
    this.validateSpecDocuments(documents);
    const runner = this.deps.createRunnerFor(agent);
    const specPath = `${workdir}/${SPEC_DOC_RELPATH}`;
    const researchDir = `${workdir}/${RESEARCH_DOCS_DIR}`;
    await assertOwner();
    await this.ensureRuntimeDirs(runner, workdir);
    const cleared = await runner.exec(
      `${guardedRemoveClause(workdir, specPath)} && ${guardedRemoveClause(workdir, researchDir, { recursive: true })}`,
    );
    if (cleared.exitCode !== 0) {
      throw new ReviewExchangeError(
        'spec-seed-failed',
        `failed to clear old spec documents: ${cleared.stderr.trim() || `exit ${cleared.exitCode}`}`,
      );
    }
    await assertOwner();
    await this.ensureRuntimeDirs(runner, workdir);
    await mapWithConcurrency(documents, FS_READ_CONCURRENCY, async (document) => {
      await assertOwner();
      const final = `${workdir}/${document.relPath}`;
      const dir = final.slice(0, final.lastIndexOf('/'));
      const tmp = `${dir}/.tmp-${randomBytes(8).toString('hex')}`;
      try {
        await stageFileGuarded(runner, workdir, tmp, document.content);
        await assertOwner();
        await moveFileIntoPlace(runner, tmp, final, { guardRoot: workdir });
        await assertOwner();
      } catch (err) {
        await sweepStrayFile(runner, tmp, ancestorSymlinkGuard(workdir, tmp));
        if (err instanceof ReviewExchangeError) throw err;
        throw new ReviewExchangeError(
          'spec-seed-failed',
          `failed to write ${document.relPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  async readFindings(task: TaskState, qaAgent: AgentConfig): Promise<ReviewFindings | null> {
    const raw = await this.readExchangeFile(qaAgent, 'findings.json');
    if (raw === null) return null;
    return validateReviewFindings(this.parseJson(raw, 'findings.json'));
  }

  async readResponse(task: TaskState, devAgent: AgentConfig): Promise<ReviewResponse | null> {
    const raw = await this.readExchangeFile(devAgent, 'response.json');
    if (raw === null) return null;
    return validateReviewResponse(this.parseJson(raw, 'response.json'));
  }

  async deleteFindings(qaAgent: AgentConfig): Promise<void> {
    await this.deleteExchangeFile(qaAgent, 'findings.json');
  }

  async deleteResponse(devAgent: AgentConfig): Promise<void> {
    await this.deleteExchangeFile(devAgent, 'response.json');
  }

  async readHeadSha(devAgent: AgentConfig): Promise<string> {
    const wt = this.requireWorkdir(devAgent.id);
    const runner = this.deps.createRunnerFor(devAgent);
    const r = await runner.exec(`cd ${shellQuote(wt)} && git rev-parse HEAD`);
    if (r.exitCode !== 0 || r.stdout.trim() === '') {
      throw new ReviewExchangeError('head-failed', `git rev-parse HEAD failed: ${r.stderr.trim()}`);
    }
    return r.stdout.trim();
  }

  async readInterdiff(devAgent: AgentConfig, prevSha: string, curSha: string): Promise<string> {
    const wt = this.requireWorkdir(devAgent.id);
    const runner = this.deps.createRunnerFor(devAgent);
    // two-arg tree diff, not prev...cur — three-dot regresses to the whole patchset when the review head was rewritten (amend/squash/rebase, #515)
    const r = await runner.exec(
      `cd ${shellQuote(wt)} && git -c core.quotepath=false diff ${shellQuote(prevSha)} ${shellQuote(curSha)}`,
    );
    if (r.exitCode !== 0) {
      throw new ReviewExchangeError('interdiff-failed', `git diff failed: ${r.stderr.trim()}`);
    }
    return r.stdout;
  }

  async readFileRange(
    devAgent: AgentConfig,
    file: string,
    startLine: number,
    endLine: number,
  ): Promise<string> {
    if (file.startsWith('/')) throw new ReviewExchangeError('abs-path', file);
    if (file.split('/').includes('..')) throw new ReviewExchangeError('traversal', file);
    if (/[\x00-\x1f]/.test(file)) throw new ReviewExchangeError('ctrl-char', JSON.stringify(file));
    if (file.startsWith('-')) throw new ReviewExchangeError('leading-dash', file);
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine)
      || startLine < 1 || endLine < startLine || endLine - startLine > 200) {
      throw new ReviewExchangeError('range', `${startLine}-${endLine}`);
    }
    const wt = this.requireWorkdir(devAgent.id);
    const runner = this.deps.createRunnerFor(devAgent);
    const symlinkWalk =
      `p=${shellQuote(`${wt}/${file}`)}; ` +
      `while [ "$p" != ${shellQuote(wt)} ] && [ "$p" != "/" ] && [ -n "$p" ]; do ` +
      `if [ -L "$p" ]; then exit 9; fi; p=$(dirname "$p"); done`;
    const walk = await runner.exec(symlinkWalk);
    if (walk.exitCode !== 0) {
      throw new ReviewExchangeError('escape', file);
    }
    const r = await runner.exec(
      `sed -n ${shellQuote(`${startLine},${endLine}p`)} -- ${shellQuote(`${wt}/${file}`)}`,
    );
    if (r.exitCode !== 0) {
      throw new ReviewExchangeError('read-failed', r.stderr.trim());
    }
    const { text, truncated } = truncateUtf8(r.stdout, MAX_READ_FILE_BYTES);
    return truncated ? `${text}\n[truncated]` : text;
  }

  async deliverToInbox(
    agent: AgentConfig,
    workdir: string,
    filename: string,
    content: string,
  ): Promise<ReviewContentFileRef> {
    if (filename === '' || filename.includes('/') || filename.startsWith('.')) {
      throw new ReviewExchangeError('bad-filename', JSON.stringify(filename));
    }
    const wt = workdir.endsWith('/') ? workdir.slice(0, -1) : workdir;
    const dir = `${wt}/${REVIEW_INBOX_DIR}`;
    const tmp = `${dir}/.tmp-${randomBytes(6).toString('hex')}`;
    const final = `${dir}/${filename}`;
    const runner = this.deps.createRunnerFor(agent);
    await this.ensureRuntimeDirs(runner, wt);
    try {
      await stageFileGuarded(runner, wt, tmp, content);
      await moveFileIntoPlace(runner, tmp, final, { guardRoot: wt });
    } catch (err) {
      throw new ReviewExchangeError(
        'deliver-failed',
        `${filename}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { path: `${REVIEW_INBOX_DIR}/${filename}`, bytes: Buffer.byteLength(content, 'utf8') };
  }

  private async readExchangeFile(agent: AgentConfig, name: string): Promise<string | null> {
    const wt = this.requireWorkdir(agent.id);
    const runner = this.deps.createRunnerFor(agent);
    await this.ensureRuntimeDirs(runner, wt);
    const r = await runner.exec(`cat ${shellQuote(`${wt}/${REVIEW_EXCHANGE_DIR}/${name}`)}`);
    if (r.exitCode !== 0) {
      if (/no such file/i.test(r.stderr)) return null;
      throw new ReviewExchangeError('read-failed', `${name}: ${r.stderr.trim()}`);
    }
    return r.stdout;
  }

  private async deleteExchangeFile(agent: AgentConfig, name: string): Promise<void> {
    const wt = this.requireWorkdir(agent.id);
    const runner = this.deps.createRunnerFor(agent);
    await this.ensureRuntimeDirs(runner, wt);
    const target = `${wt}/${REVIEW_EXCHANGE_DIR}/${name}`;
    const rm = await runner.exec(guardedRemoveClause(wt, target));
    if (rm.exitCode !== 0) {
      throw new ReviewExchangeError(
        'artifact-cleanup-failed',
        `failed to delete ${target}: ${rm.stderr.trim() || `exit ${rm.exitCode}`}`,
      );
    }
  }

  private async ensureRuntimeDirs(runner: CommandRunner, workdir: string): Promise<void> {
    try {
      await ensureBaxianRuntimeDirsSafe(runner, workdir);
    } catch (err) {
      throw new ReviewExchangeError(
        'unsafe-runtime-path',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private validateSpecDocuments(documents: readonly SpecDocument[]): void {
    if (documents.length === 0 || documents[0]?.relPath !== SPEC_DOC_RELPATH) {
      throw new ReviewExchangeError('spec-seed-invalid', `documents must start with ${SPEC_DOC_RELPATH}`);
    }
    if (documents.length - 1 > RESEARCH_DOCS_MAX_COUNT) {
      throw new ReviewExchangeError('spec-seed-invalid', 'too many research documents');
    }
    const paths = documents.map(document => document.relPath);
    if (new Set(paths).size !== paths.length) {
      throw new ReviewExchangeError('spec-seed-invalid', 'document paths must be unique');
    }
    if (Buffer.byteLength(documents[0]!.content, 'utf8') > SPEC_DOC_MAX_BYTES) {
      throw new ReviewExchangeError('spec-seed-invalid', 'spec document exceeds the size limit');
    }
    let researchBytes = 0;
    const prefix = `${RESEARCH_DOCS_DIR}/`;
    for (const document of documents.slice(1)) {
      const name = document.relPath.slice(prefix.length);
      if (!document.relPath.startsWith(prefix) || name === '' || name.includes('/') || !name.endsWith('.md')) {
        throw new ReviewExchangeError('spec-seed-invalid', `invalid research document path: ${document.relPath}`);
      }
      const bytes = Buffer.byteLength(document.content, 'utf8');
      if (bytes > RESEARCH_DOC_MAX_BYTES) {
        throw new ReviewExchangeError('spec-seed-invalid', `${document.relPath} exceeds the size limit`);
      }
      researchBytes += bytes;
    }
    const sorted = [...paths.slice(1)].sort();
    if (paths.slice(1).some((path, index) => path !== sorted[index])) {
      throw new ReviewExchangeError('spec-seed-invalid', 'research document paths must be sorted');
    }
    if (researchBytes > RESEARCH_DOCS_TOTAL_MAX_BYTES) {
      throw new ReviewExchangeError('spec-seed-invalid', 'research documents exceed the total size limit');
    }
  }

  private parseJson(raw: string, label: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      throw new ReviewExchangeError('parse', `${label}: invalid JSON`);
    }
  }

  private requireWorkdir(agentId: string): string {
    const wt = this.deps.resolveWorkdir(agentId);
    if (!wt) throw new ReviewExchangeError('no-workdir', `agent ${agentId} has no Workdir`);
    return wt.endsWith('/') ? wt.slice(0, -1) : wt;
  }
}

export interface ServerPayloadInput {
  phase: string;
  taskPhase?: TaskPhase;
  specRound?: number;
  reviewRound: number;
  batch?: { index: number; total: number };
  serverContent?: string;
  forceContentFile?: boolean;
  serverDiffstat?: string;
  serverInterdiff?: string;
  serverPriorFindings?: string;
  serverPriorResponse?: string;
}

export interface ServerPayloadPromptOpts {
  serverContent?: string;
  serverContentFile?: ReviewContentFileRef;
  serverDiffstat?: string;
  serverDiffstatFile?: ReviewContentFileRef;
  serverInterdiff?: string;
  serverInterdiffFile?: ReviewContentFileRef;
  serverPriorFindings?: string;
  serverPriorFindingsFile?: ReviewContentFileRef;
  serverPriorResponse?: string;
  serverPriorResponseFile?: ReviewContentFileRef;
}

function serverPayloadRound(input: ServerPayloadInput): number {
  const specSide = input.phase === 'server-spec-review'
    || (input.phase === 'server-feedback' && input.taskPhase === 'spec');
  return specSide ? Math.max(input.specRound ?? 1, 1) : Math.max(input.reviewRound, 1);
}

function contentFilename(phase: string, round: number, batch?: { index: number; total: number }): string {
  if (phase === 'server-spec-review') return `spec-round-${round}.md`;
  return batch ? `diff-round-${round}-batch-${batch.index + 1}.patch` : `diff-round-${round}.patch`;
}

export async function resolveServerPayloads(
  transport: ReviewTransport,
  agent: AgentConfig,
  workdir: string,
  input: ServerPayloadInput,
): Promise<ServerPayloadPromptOpts> {
  if (input.phase === 'server-feedback' && input.serverContent !== undefined) {
    throw new ReviewExchangeError('unexpected-payload', 'server-feedback carries findings only');
  }
  const round = serverPayloadRound(input);
  const out: ServerPayloadPromptOpts = {};
  const place = async (
    value: string | undefined,
    filename: string,
    inlineKey: 'serverContent' | 'serverDiffstat' | 'serverInterdiff' | 'serverPriorFindings' | 'serverPriorResponse',
    fileKey: 'serverContentFile' | 'serverDiffstatFile' | 'serverInterdiffFile' | 'serverPriorFindingsFile' | 'serverPriorResponseFile',
    forceFile = false,
  ): Promise<void> => {
    if (value === undefined) return;
    if (!forceFile && Buffer.byteLength(value, 'utf8') <= MAX_INLINE_CONTENT_BYTES) {
      out[inlineKey] = value;
      return;
    }
    out[fileKey] = await transport.deliverToInbox(agent, workdir, filename, value);
  };
  await place(
    input.serverContent,
    contentFilename(input.phase, round, input.batch),
    'serverContent',
    'serverContentFile',
    input.forceContentFile,
  );
  await place(
    input.serverDiffstat,
    `diffstat-round-${round}.txt`,
    'serverDiffstat',
    'serverDiffstatFile',
  );
  await place(input.serverInterdiff, `interdiff-round-${round}.patch`, 'serverInterdiff', 'serverInterdiffFile');
  const findingsName = input.phase === 'server-feedback'
    ? `findings-round-${round}.json`
    : `prior-findings-round-${round}.json`;
  await place(input.serverPriorFindings, findingsName, 'serverPriorFindings', 'serverPriorFindingsFile');
  await place(input.serverPriorResponse, `prior-response-round-${round}.json`, 'serverPriorResponse', 'serverPriorResponseFile');
  return out;
}
