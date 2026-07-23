import type { MappedRow } from './field-mapper.js';
import { MAP_FIELD_KINDS, SHA_HEX_SOURCE } from './types.js';

export type NormalizedRow = Record<string, unknown>;

export class RowSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RowSchemaError';
  }
}

// ack 线协议 <sourceKey>:<commentId>:<bodyDigest> 以冒号分段，id 含分隔符会让已处理反馈
// 永远无法被确认（spec §5.3 增量⑥）——行 schema 违例装机/首周期 fail loud 优于运行期静默卡死。
export const LINE_SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;

const SHA_RE = new RegExp(`^${SHA_HEX_SOURCE}$`);
// RFC3339 全形状锚定：缺 offset 的时间戳被 Date.parse 按主机时区解析，同一持久 cursor
// 会随部署主机漂移数小时（跳过/重放评论）；V8 还会把 2026-02-30Z 归一成 3 月 2 日而非拒绝，
// 故正则之外再做日历/量程校验，不把 Date.parse 当验证器。
const TIMESTAMP_SHAPE_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

const daysInMonth = (year: number, month: number): number =>
  [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;

function isRfc3339Timestamp(value: string): boolean {
  const m = TIMESTAMP_SHAPE_RE.exec(value);
  if (m === null) return false;
  const [, y, mo, d, h, mi, s, oh, om] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return false;
  // RFC3339 秒 60 仅服务闰秒，Date.parse 拒绝它——按可解析集合收敛到 0-59。
  if (h > 23 || mi > 59 || s > 59) return false;
  // V8 对 offset 不做量程校验（+99:99 被静默换算），必须在此闸住。
  if (!Number.isNaN(oh) && (oh > 23 || om > 59)) return false;
  return !Number.isNaN(Date.parse(value));
}

const REQUIRED_NON_NULL: Record<string, readonly string[]> = {
  listPrs: ['prNumber', 'prUrl', 'branch', 'headSha', 'state', 'draft', 'updatedAt', 'targetProjectId', 'targetBranch'],
  prView: ['prUrl', 'branch', 'headSha', 'state', 'draft', 'targetProjectId', 'targetBranch'],
  projectView: ['defaultBranch'],
  branchView: ['remoteProjectId'],
  // body 可空：GitHub 纯 APPROVED review 可无正文，一行 null body 不得 fail closed 整个评论源
  // （消费端对非 string body 一律按空文本处理：无令牌、无 ack、不合成反馈）。
  listComments: ['id'],
};

function normalizeField(field: string, value: unknown): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (value === null || value === undefined) return { ok: true, value };
  switch (MAP_FIELD_KINDS[field]) {
    case 'id':
      if (typeof value === 'number' && Number.isSafeInteger(value)) return { ok: true, value: String(value) };
      if (typeof value === 'string' && LINE_SAFE_ID_RE.test(value)) return { ok: true, value };
      return { ok: false, reason: `must be a safe integer or line-safe string (got ${JSON.stringify(value)})` };
    case 'prNumber':
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return { ok: true, value };
      return { ok: false, reason: `must be a positive safe integer (got ${JSON.stringify(value)})` };
    case 'sha':
      if (typeof value === 'string' && SHA_RE.test(value)) return { ok: true, value: value.toLowerCase() };
      return { ok: false, reason: `must be a hex sha (got ${JSON.stringify(value)})` };
    case 'timestamp':
      if (typeof value === 'string' && isRfc3339Timestamp(value)) return { ok: true, value };
      return { ok: false, reason: `must be an RFC3339 timestamp with explicit offset (got ${JSON.stringify(value)})` };
    case 'state':
      if (value === 'open' || value === 'closed') return { ok: true, value };
      return { ok: false, reason: `must be 'open' | 'closed' (got ${JSON.stringify(value)})` };
    case 'boolean':
      if (typeof value === 'boolean') return { ok: true, value };
      return { ok: false, reason: `must be a boolean (got ${JSON.stringify(value)})` };
    case 'integer':
      if (typeof value === 'number' && Number.isSafeInteger(value)) return { ok: true, value };
      return { ok: false, reason: `must be a safe integer (got ${JSON.stringify(value)})` };
    case 'string':
      if (typeof value === 'string') return { ok: true, value };
      return { ok: false, reason: `must be a string (got ${JSON.stringify(value)})` };
    case undefined:
      return { ok: true, value };
  }
}

export function validateRows(
  opName: string,
  rows: MappedRow[],
  opts?: { sourceKey?: string },
): NormalizedRow[] {
  const label = opts?.sourceKey === undefined ? opName : `${opName}[${opts.sourceKey}]`;
  const violations: string[] = [];
  const required = REQUIRED_NON_NULL[opName] ?? [];
  const normalized = rows.map((row, i) => {
    const out: NormalizedRow = {};
    for (const [field, value] of Object.entries(row)) {
      const r = normalizeField(field, value);
      if (r.ok) {
        out[field] = r.value;
      } else {
        violations.push(`row ${i} field '${field}': ${r.reason}`);
      }
    }
    for (const field of required) {
      if (out[field] === null || out[field] === undefined) {
        violations.push(`row ${i} field '${field}': required, got ${JSON.stringify(row[field] ?? null)}`);
      }
    }
    return out;
  });
  if (violations.length > 0) {
    const shown = violations.slice(0, 5).join('; ');
    const more = violations.length > 5 ? ` (+${violations.length - 5} more)` : '';
    throw new RowSchemaError(`op ${label}: ${shown}${more}`);
  }
  return normalized;
}

// 版本时间的字段偏好单点定义：verdict 的 submittedAt 与水位排序必须用同一时间源。
export function versionTimestampOf(row: NormalizedRow): string | undefined {
  if (typeof row.updatedAt === 'string') return row.updatedAt;
  return typeof row.createdAt === 'string' ? row.createdAt : undefined;
}

export function versionTimeOf(row: NormalizedRow): number | undefined {
  // 投影行（markers.projectCommentRow）携解析结果 stash，同一行每周期免重复 Date.parse。
  if (typeof row.versionTime === 'number') return row.versionTime;
  const raw = versionTimestampOf(row);
  if (raw === undefined) return undefined;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? undefined : t;
}
