import { shellQuote } from '../agent/runner.js';
import { CONTROL_CHAR_RE, isValidBranchName } from '../shared/constants.js';
import { ENV_KEY_PATTERN, SHA_HEX_SOURCE } from './types.js';

export interface RenderContext {
  scheme: 'http' | 'https';
  hostname: string;
  host: string;
  repoPath: string;
  binary: string;
  prNumber?: number;
  expectedHeadSha?: string;
  remoteProjectId?: string;
  branch?: string;
  page?: number;
}

export class PlaceholderValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaceholderValueError';
  }
}

const SHA_RE = new RegExp(`^${SHA_HEX_SOURCE}$`);
// String.replace 对全局正则自重置 lastIndex，模块级复用安全。
const PLACEHOLDER_RE = /\{([a-zA-Z]+)\}/g;

function placeholderValue(name: string, ctx: RenderContext & { minToolVersion?: string }): string {
  switch (name) {
    case 'scheme': return ctx.scheme;
    case 'hostname': return ctx.hostname;
    case 'host': return ctx.host;
    case 'hostUrl': return `${ctx.scheme}://${ctx.host}`;
    case 'repoPath': return ctx.repoPath;
    case 'repoPathEncoded': return encodeURIComponent(ctx.repoPath);
    case 'binary': return ctx.binary;
    case 'prNumber': {
      if (ctx.prNumber === undefined || !Number.isInteger(ctx.prNumber) || ctx.prNumber <= 0) {
        throw new PlaceholderValueError(`prNumber must be a positive integer (got ${ctx.prNumber})`);
      }
      return String(ctx.prNumber);
    }
    case 'expectedHeadSha': {
      if (ctx.expectedHeadSha === undefined || !SHA_RE.test(ctx.expectedHeadSha)) {
        throw new PlaceholderValueError(`expectedHeadSha must be hex sha (got ${ctx.expectedHeadSha})`);
      }
      return ctx.expectedHeadSha;
    }
    case 'remoteProjectId': {
      if (ctx.remoteProjectId === undefined
        || ctx.remoteProjectId.trim() !== ctx.remoteProjectId
        || ctx.remoteProjectId.length === 0
        || ctx.remoteProjectId.length > 512
        || CONTROL_CHAR_RE.test(ctx.remoteProjectId)) {
        throw new PlaceholderValueError(`remoteProjectId must be a bounded platform id (got ${ctx.remoteProjectId})`);
      }
      return ctx.remoteProjectId;
    }
    case 'branch': {
      if (ctx.branch === undefined) throw new PlaceholderValueError('branch required for {branch}');
      // 原样值进 URL 路径（GitHub refs 端点按字面 / 展开，spec §5.3 增量⑤）：入口同款
      // isValidBranchName 挡路径遍历——第二套渲染期专属谓词会与它各自漂移。
      if (!isValidBranchName(ctx.branch)) {
        throw new PlaceholderValueError(`branch has invalid shape (got ${ctx.branch})`);
      }
      return ctx.branch;
    }
    case 'branchEncoded': {
      if (ctx.branch === undefined) throw new PlaceholderValueError('branch required for {branchEncoded}');
      return encodeURIComponent(ctx.branch);
    }
    case 'page': {
      if (ctx.page === undefined || !Number.isInteger(ctx.page) || ctx.page <= 0) {
        throw new PlaceholderValueError(`page must be a positive integer (got ${ctx.page})`);
      }
      return String(ctx.page);
    }
    case 'minToolVersion': {
      if (ctx.minToolVersion === undefined) throw new PlaceholderValueError('minToolVersion unavailable');
      return ctx.minToolVersion;
    }
    default:
      throw new PlaceholderValueError(`unknown placeholder {${name}}`);
  }
}

function substitute(template: string, ctx: RenderContext & { minToolVersion?: string }): string {
  const escaped = template.replace(/\\\{/g, '\uE000').replace(/\\\}/g, '\uE001');
  return escaped
    .replace(PLACEHOLDER_RE, (_, name: string) => placeholderValue(name, ctx))
    .replace(/\uE000/g, '{')
    .replace(/\uE001/g, '}');
}

export function renderCommand(
  op: { argv: string[]; env?: Record<string, string> },
  ctx: RenderContext,
): string {
  const envPrefix = Object.entries(op.env ?? {})
    .map(([k, v]) => {
      if (!ENV_KEY_PATTERN.test(k)) {
        throw new PlaceholderValueError(`env key must match ${ENV_KEY_PATTERN} (got ${k})`);
      }
      return `${k}=${shellQuote(substitute(v, ctx))}`;
    })
    .join(' ');
  const argv = op.argv.map(a => shellQuote(substitute(a, ctx))).join(' ');
  return envPrefix === '' ? argv : `${envPrefix} ${argv}`;
}

export function renderFixMessage(
  template: string,
  ctx: RenderContext & { minToolVersion?: string },
): string {
  return substitute(template, ctx);
}
