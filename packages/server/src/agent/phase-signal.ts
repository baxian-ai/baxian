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
  | { kind: 'pr-created'; token: string; prNumber: number; actorB64?: string }
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
const ACTOR_B64_RANGE = '[A-Za-z0-9_-]{1,256}';
const COMPACT_SIGNAL_RE_PR_CREATED = new RegExp(
  `\\[bx:(pr-created):(\\d+)(?::(${ACTOR_B64_RANGE}))?:(${TOKEN_RANGE})\\]`,
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
  actorB64?: string,
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
  actorB64?: string,
): string {
  if (kind === 'pr-created') {
    if (prNumber === undefined) {
      throw new Error('buildPhaseSignal(pr-created) requires prNumber');
    }
    return actorB64 === undefined
      ? `[bx:pr-created:${prNumber}:${token}]`
      : `[bx:pr-created:${prNumber}:${actorB64}:${token}]`;
  }
  if (kind === 'code-ready' && prNumber !== undefined) {
    return `[bx:code-ready:${prNumber}:${token}]`;
  }
  return `[bx:${kind}:${token}]`;
}

export function createSignalToken(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

export function decodeSignalActorId(actorB64: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(actorB64) || actorB64.length % 4 === 1) return undefined;
  const bytes = Buffer.from(actorB64, 'base64url');
  if (bytes.length === 0 || bytes.length > 128) return undefined;
  const text = bytes.toString('utf8');
  // 精确相等比较要求无损解码：无效 UTF-8 会被替换字符吞掉差异，一律拒收
  if (!Buffer.from(text, 'utf8').equals(bytes)) return undefined;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return undefined;
  }
  return text;
}

export function scanPhaseSignals(text: string): PhaseSignal[] {
  const stripped = stripSignalAnsi(text);
  const compact = stripped.replace(/\s+/g, '');
  const found: Array<{ index: number; signal: PhaseSignal }> = [];
  for (const m of compact.matchAll(COMPACT_SIGNAL_RE_PR_CREATED)) {
    const prNumber = Number.parseInt(m[2], 10);
    if (!Number.isFinite(prNumber)) continue;
    found.push({
      index: m.index ?? 0,
      signal: { kind: 'pr-created', prNumber, ...(m[3] !== undefined ? { actorB64: m[3] } : {}), token: m[4] },
    });
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
  // Absent on the bare legacy form; malformed ordinals reject the whole literal instead.
  seq?: number;
  raw: string;
  // Position in the compact scan text — orders ask/answer literals of ONE scan pass.
  index: number;
}

export interface AskAnswerSignal extends NeedInputSignal {
  kind: 'ask' | 'answer';
}

const NEED_INPUT_RE = new RegExp(`\\[bx:need-input:(${TOKEN_RANGE})(?::(\\d{1,4}))?\\]`, 'g');
const INPUT_RECEIVED_RE = new RegExp(`\\[bx:input-received:(${TOKEN_RANGE})(?::(\\d{1,4}))?\\]`, 'g');

// The exact transform scans run on — exported so callers can convert raw-buffer
// boundaries into scan-text coordinates (old/new-region split in the watcher).
export function compactSignalText(text: string): string {
  return stripSignalAnsi(text).replace(/\s+/g, '');
}

function trackBoundaryThroughStrip(
  text: string,
  boundary: number,
  pattern: RegExp,
): { text: string; boundary: number } {
  let out = '';
  let mapped = boundary;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    out += text.slice(last, start);
    if (boundary >= end) mapped -= m[0].length;
    else if (boundary > start) mapped -= boundary - start;
    last = end;
  }
  out += text.slice(last);
  return { text: out, boundary: mapped };
}

// Maps a raw offset of `text` into compactSignalText(text) coordinates by tracking
// every stripped span. Compacting the prefix on its own would misplace the boundary
// whenever an ANSI/OSC escape or whitespace run straddles it (the joined text strips
// what the prefix alone cannot), and a shifted boundary misclassifies brand-new
// literals as already-scanned tail.
export function compactBoundaryIndex(text: string, rawBoundary: number): number {
  let state = { text, boundary: Math.max(0, Math.min(rawBoundary, text.length)) };
  state = trackBoundaryThroughStrip(state.text, state.boundary, OSC_PATTERN);
  state = trackBoundaryThroughStrip(state.text, state.boundary, ANSI_PATTERN);
  state = trackBoundaryThroughStrip(state.text, state.boundary, /\s+/g);
  return state.boundary;
}

function scanAskAnswer(text: string, re: RegExp): NeedInputSignal[] {
  const compact = compactSignalText(text);
  const out: NeedInputSignal[] = [];
  for (const m of compact.matchAll(re)) {
    if (m[2] !== undefined) {
      const seq = Number.parseInt(m[2], 10);
      if (!Number.isFinite(seq) || seq < 1) continue;
      out.push({ token: m[1], seq, raw: m[0], index: m.index ?? 0 });
    } else {
      out.push({ token: m[1], raw: m[0], index: m.index ?? 0 });
    }
  }
  return out;
}

export function scanNeedInputSignals(text: string): NeedInputSignal[] {
  return scanAskAnswer(text, NEED_INPUT_RE);
}

export function scanInputReceivedSignals(text: string): NeedInputSignal[] {
  return scanAskAnswer(text, INPUT_RECEIVED_RE);
}

// Document order matters across the two families: an answer swallowed while idle must
// not out-of-order clear an ask that appears after it in the same window.
export function scanAskAnswerSignals(text: string): AskAnswerSignal[] {
  const merged: AskAnswerSignal[] = [
    ...scanNeedInputSignals(text).map(s => ({ ...s, kind: 'ask' as const })),
    ...scanInputReceivedSignals(text).map(s => ({ ...s, kind: 'answer' as const })),
  ];
  return merged.sort((a, b) => a.index - b.index);
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
