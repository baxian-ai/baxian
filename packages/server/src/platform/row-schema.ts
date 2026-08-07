import { PLATFORM_ACTOR_ID_MAX_BYTES, SHA_HEX_SOURCE } from './types.js';

export type NormalizedRow = Record<string, unknown>;

export class RowSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RowSchemaError';
  }
}

export const LINE_SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;

const SHA_RE = new RegExp(`^${SHA_HEX_SOURCE}$`);
const TIMESTAMP_SHAPE_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

type MapFieldKind = 'id' | 'actorId' | 'prNumber' | 'sha' | 'timestamp' | 'state' | 'boolean' | 'integer' | 'string';
const MAP_FIELD_KINDS: Readonly<Record<string, MapFieldKind>> = {
  prNumber: 'prNumber',
  prUrl: 'string', branch: 'string', targetBranch: 'string', title: 'string', body: 'string',
  author: 'string', prAuthor: 'string', reviewState: 'string', detailedMergeStatus: 'string',
  defaultBranch: 'string', path: 'string', state: 'state',
  headSha: 'sha', commitSha: 'sha',
  mergedAt: 'timestamp', updatedAt: 'timestamp', createdAt: 'timestamp',
  sourceProjectId: 'id', targetProjectId: 'id', remoteProjectId: 'id', id: 'id', discussionId: 'id', parentId: 'id',
  authorId: 'actorId', prAuthorId: 'actorId',
  draft: 'boolean', pushPermitted: 'boolean',
  line: 'integer', originalLine: 'integer',
};

const daysInMonth = (year: number, month: number): number =>
  [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;

function isRfc3339Timestamp(value: string): boolean {
  const m = TIMESTAMP_SHAPE_RE.exec(value);
  if (m === null) return false;
  const [, y, mo, d, h, mi, s, oh, om] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return false;
  if (h > 23 || mi > 59 || s > 59) return false;
  if (!Number.isNaN(oh) && (oh > 23 || om > 59)) return false;
  return !Number.isNaN(Date.parse(value));
}

const REQUIRED_NON_NULL: Record<string, readonly string[]> = {
  listPrs: ['prNumber', 'prUrl', 'branch', 'headSha', 'state', 'draft', 'updatedAt', 'targetProjectId', 'targetBranch'],
  prView: ['prUrl', 'branch', 'headSha', 'state', 'draft', 'targetProjectId', 'targetBranch'],
  projectView: ['defaultBranch'],
  branchView: ['remoteProjectId'],
  listComments: ['id'],
};

// undefined = field never mapped (rejected); explicit null keeps its documented meaning.
const REQUIRED_MAPPED: Record<string, Readonly<Record<string, string>>> = {
  listPrs: { sourceProjectId: 'use null when the source repository is gone' },
  prView: { sourceProjectId: 'use null when the source repository is gone' },
};

function normalizeField(field: string, value: unknown): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (value === null || value === undefined) return { ok: true, value };
  switch (MAP_FIELD_KINDS[field]) {
    case 'id':
      if (typeof value === 'number' && Number.isSafeInteger(value)) return { ok: true, value: String(value) };
      if (typeof value === 'string' && LINE_SAFE_ID_RE.test(value)) return { ok: true, value };
      return { ok: false, reason: `must be a safe integer or line-safe string (got ${JSON.stringify(value)})` };
    case 'actorId': {
      const id = normalizeField('id', value);
      if (!id.ok) return id;
      if (typeof id.value === 'string' && id.value.length > PLATFORM_ACTOR_ID_MAX_BYTES) {
        return { ok: false, reason: `must be at most ${PLATFORM_ACTOR_ID_MAX_BYTES} characters (got ${id.value.length})` };
      }
      return id;
    }
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
  rows: Record<string, unknown>[],
  opts?: { sourceKey?: string; requireMapped?: Readonly<Record<string, string>> },
): NormalizedRow[] {
  const label = opts?.sourceKey === undefined ? opName : `${opName}[${opts.sourceKey}]`;
  const violations: string[] = [];
  const required = REQUIRED_NON_NULL[opName] ?? [];
  const requiredMapped = { ...REQUIRED_MAPPED[opName], ...opts?.requireMapped };
  const normalized = rows.map((row, i) => {
    const out: NormalizedRow = {};
    for (const [field, value] of Object.entries(row)) {
      // versionTimeOf trusts a numeric versionTime blindly; only the internal projection may write it.
      if (field === 'versionTime') continue;
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
    for (const [field, hint] of Object.entries(requiredMapped)) {
      if (out[field] === undefined) {
        violations.push(`row ${i} field '${field}': missing (${hint})`);
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

export function versionTimestampOf(row: NormalizedRow): string | undefined {
  if (typeof row.updatedAt === 'string') return row.updatedAt;
  return typeof row.createdAt === 'string' ? row.createdAt : undefined;
}

export function versionTimeOf(row: NormalizedRow): number | undefined {
  if (typeof row.versionTime === 'number') return row.versionTime;
  const raw = versionTimestampOf(row);
  if (raw === undefined) return undefined;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? undefined : t;
}
