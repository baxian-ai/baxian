import { randomUUID } from 'node:crypto';


export type PhaseSignalKind =
  | 'spec-fixed'
  | 'pr-created'
  | 'pr-approved'
  | 'pr-changes-requested'
  | 'pr-fixed'
  | 'pr-merge-ready'
  | 'spec-done'
  | 'spec-reviewed'
  | 'code-done'
  | 'code-reviewed'
  | 'code-fixed'
  | 'code-ready'
  | 'greeting';

export const PHASE_SIGNAL_KINDS: readonly PhaseSignalKind[] = [
  'spec-fixed',
  'pr-created',
  'pr-approved',
  'pr-changes-requested',
  'pr-fixed',
  'pr-merge-ready',
  'spec-done',
  'spec-reviewed',
  'code-done',
  'code-reviewed',
  'code-fixed',
  'code-ready',
  'greeting',
] as const;

export type PhaseSignal =
  | { kind: 'spec-fixed'; token: string }
  | { kind: 'pr-created'; token: string; prNumber: number }
  | { kind: 'pr-approved'; token: string }
  | { kind: 'pr-changes-requested'; token: string }
  | { kind: 'pr-fixed'; token: string }
  | { kind: 'pr-merge-ready'; token: string }
  | { kind: 'spec-done'; token: string }
  | { kind: 'spec-reviewed'; token: string }
  | { kind: 'code-done'; token: string }
  | { kind: 'code-reviewed'; token: string }
  | { kind: 'code-fixed'; token: string }
  | { kind: 'code-ready'; token: string; prNumber?: number }
  | { kind: 'greeting'; token: string };

const VALID_KINDS = new Set<PhaseSignalKind>(PHASE_SIGNAL_KINDS);

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC_PATTERN = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;

const TOKEN_RANGE = '[A-Za-z0-9_-]{6,64}';
const COMPACT_SIGNAL_RE_PR_CREATED = new RegExp(
  `\\[bx:(pr-created):(\\d+):(${TOKEN_RANGE})\\]`,
  'g',
);
const COMPACT_SIGNAL_RE_PLAIN = new RegExp(
  `\\[bx:(spec-fixed|pr-approved|pr-changes-requested|pr-fixed|pr-merge-ready|spec-done|spec-reviewed|code-done|code-reviewed|code-fixed|greeting):(${TOKEN_RANGE})\\]`,
  'g',
);
const COMPACT_SIGNAL_RE_CODE_READY = new RegExp(
  `\\[bx:(code-ready)(?::(\\d+))?:(${TOKEN_RANGE})\\]`,
  'g',
);

export function stripSignalAnsi(text: string): string {
  return text.replace(OSC_PATTERN, '').replace(ANSI_PATTERN, '');
}

export function buildPhaseSignal(
  kind: Exclude<PhaseSignalKind, 'pr-created' | 'code-ready'>,
  token: string,
): string;
export function buildPhaseSignal(
  kind: 'pr-created',
  token: string,
  prNumber: number,
): string;
export function buildPhaseSignal(
  kind: 'code-ready',
  token: string,
  prNumber?: number,
): string;
export function buildPhaseSignal(
  kind: PhaseSignalKind,
  token: string,
  prNumber?: number,
): string {
  if (kind === 'pr-created') {
    if (prNumber === undefined) {
      throw new Error('buildPhaseSignal(pr-created) requires prNumber');
    }
    return `[bx:pr-created:${prNumber}:${token}]`;
  }
  if (kind === 'code-ready' && prNumber !== undefined) {
    return `[bx:code-ready:${prNumber}:${token}]`;
  }
  return `[bx:${kind}:${token}]`;
}

export function createSignalToken(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

export function buildPhaseSignalTemplate(kind: PhaseSignalKind): string {
  if (kind === 'pr-created') return '[bx:pr-created:<pr_number>:<token>]';
  return `[bx:${kind}:<token>]`;
}

export function scanPhaseSignals(text: string): PhaseSignal[] {
  const stripped = stripSignalAnsi(text);
  const compact = stripped.replace(/\s+/g, '');
  const found: Array<{ index: number; signal: PhaseSignal }> = [];
  for (const m of compact.matchAll(COMPACT_SIGNAL_RE_PR_CREATED)) {
    const prNumber = Number.parseInt(m[2], 10);
    if (!Number.isFinite(prNumber)) continue;
    found.push({ index: m.index ?? 0, signal: { kind: 'pr-created', prNumber, token: m[3] } });
  }
  for (const m of compact.matchAll(COMPACT_SIGNAL_RE_CODE_READY)) {
    const prNumber = m[2] === undefined ? undefined : Number.parseInt(m[2], 10);
    if (prNumber !== undefined && !Number.isFinite(prNumber)) continue;
    found.push({
      index: m.index ?? 0,
      signal: { kind: 'code-ready', token: m[3], ...(prNumber !== undefined ? { prNumber } : {}) },
    });
  }
  for (const m of compact.matchAll(COMPACT_SIGNAL_RE_PLAIN)) {
    const kind = m[1] as PhaseSignalKind;
    if (kind === 'pr-created') continue;
    if (!VALID_KINDS.has(kind)) continue;
    found.push({ index: m.index ?? 0, signal: { kind, token: m[2] } as PhaseSignal });
  }
  found.sort((a, b) => a.index - b.index);
  return found.map(f => f.signal);
}

export interface NeedInputSignal {
  token: string;
  raw: string;
}

const NEED_INPUT_RE = new RegExp(`\\[bx:need-input:(${TOKEN_RANGE})\\]`, 'g');

export function scanNeedInputSignals(text: string): NeedInputSignal[] {
  const compact = stripSignalAnsi(text).replace(/\s+/g, '');
  const out: NeedInputSignal[] = [];
  for (const m of compact.matchAll(NEED_INPUT_RE)) {
    out.push({ token: m[1], raw: m[0] });
  }
  return out;
}

export interface ReadFileSignal {
  file: string;
  startLine: number;
  endLine: number;
  raw: string;
}

const READ_FILE_RE = /\[bx:read-file:([^:\]]{1,512}):(\d{1,7})-(\d{1,7})\]/g;

export function scanReadFileSignals(text: string): ReadFileSignal[] {
  const compact = stripSignalAnsi(text).replace(/\s+/g, '');
  const out: ReadFileSignal[] = [];
  for (const m of compact.matchAll(READ_FILE_RE)) {
    const startLine = Number.parseInt(m[2], 10);
    const endLine = Number.parseInt(m[3], 10);
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) continue;
    out.push({ file: m[1], startLine, endLine, raw: m[0] });
  }
  return out;
}
