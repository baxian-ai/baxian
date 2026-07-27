import { randomUUID } from 'node:crypto';

export type PhaseSignalKind =
  | 'pr-created'
  | 'pr-fixed'
  | 'pr-merge-ready'
  | 'spec-done'
  | 'greeting';

// spec §7：code 评审的裁决唯一经配对令牌评论产出，pane 侧只做 passive watch——
// 仍布防以维持 need-input 徽标、session-gone 干预与重启恢复订阅，但没有任何 kind 能完成它。
export const PASSIVE_VERDICT_WATCH: readonly PhaseSignalKind[] = [];

export const PHASE_SIGNAL_KINDS: readonly PhaseSignalKind[] = [
  'pr-created',
  'pr-fixed',
  'pr-merge-ready',
  'spec-done',
  'greeting',
] as const;

export type PhaseSignal =
  | { kind: 'pr-created'; token: string; prNumber: number; actorB64: string }
  | { kind: 'pr-fixed'; token: string }
  | { kind: 'pr-merge-ready'; token: string }
  | { kind: 'spec-done'; token: string; prNumber: number; actorB64: string }
  | { kind: 'greeting'; token: string };

const VALID_KINDS = new Set<PhaseSignalKind>(PHASE_SIGNAL_KINDS);

const TOKEN_RANGE = '[A-Za-z0-9_-]{6,64}';
const ACTOR_B64_RANGE = '[A-Za-z0-9_-]{1,256}';
const COMPACT_SIGNAL_RE_PR_DELIVERY = new RegExp(
  `\\[bx:(pr-created|spec-done):(\\d+):(${ACTOR_B64_RANGE}):(${TOKEN_RANGE})\\]`,
  'g',
);
const COMPACT_SIGNAL_RE_PLAIN = new RegExp(
  `\\[bx:(pr-fixed|pr-merge-ready|greeting):(${TOKEN_RANGE})\\]`,
  'g',
);
const COMPACT_ROOT_DONE_RE = new RegExp(`\\[bx:root-done:(${TOKEN_RANGE})\\]`, 'g');

export function buildPhaseSignal(
  kind: Exclude<PhaseSignalKind, 'pr-created' | 'spec-done'>,
  token: string,
): string;
export function buildPhaseSignal(
  kind: 'pr-created' | 'spec-done',
  token: string,
  prNumber: number,
  actorB64: string,
): string;
export function buildPhaseSignal(
  kind: PhaseSignalKind,
  token: string,
  prNumber?: number,
  actorB64?: string,
): string {
  if (kind === 'pr-created' || kind === 'spec-done') {
    if (prNumber === undefined || actorB64 === undefined) {
      throw new Error(`buildPhaseSignal(${kind}) requires prNumber and actorB64`);
    }
    return `[bx:${kind}:${prNumber}:${actorB64}:${token}]`;
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
  if (!Buffer.from(text, 'utf8').equals(bytes)) return undefined;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return undefined;
  }
  return text;
}

export interface PhaseSignalMatch {
  signal: PhaseSignal;
  raw: string;
  // compactSignalText coordinates, so callers can region-split against compactBoundaryIndex().
  index: number;
}

// raw PTY 字节直接进来，藏在 OSC/DCS/APC 里的 marker 会被当成真输出。
export function scanPhaseSignalMatches(visible: string): PhaseSignalMatch[] {
  const compact = compactSignalText(visible);
  const found: PhaseSignalMatch[] = [];
  for (const m of compact.matchAll(COMPACT_SIGNAL_RE_PR_DELIVERY)) {
    const prNumber = Number.parseInt(m[2], 10);
    if (!Number.isFinite(prNumber)) continue;
    found.push({
      index: m.index ?? 0,
      raw: m[0],
      signal: {
        kind: m[1] as 'pr-created' | 'spec-done',
        prNumber,
        actorB64: m[3],
        token: m[4],
      },
    });
  }
  for (const m of compact.matchAll(COMPACT_SIGNAL_RE_PLAIN)) {
    const kind = m[1] as PhaseSignalKind;
    if (kind === 'pr-created') continue;
    if (!VALID_KINDS.has(kind)) continue;
    found.push({ index: m.index ?? 0, raw: m[0], signal: { kind, token: m[2] } as PhaseSignal });
  }
  found.sort((a, b) => a.index - b.index);
  return found;
}

export function scanPhaseSignals(visible: string): PhaseSignal[] {
  return scanPhaseSignalMatches(visible).map(f => f.signal);
}

export function scanRootDoneSignals(visible: string): string[] {
  const compact = compactSignalText(visible);
  return [...compact.matchAll(COMPACT_ROOT_DONE_RE)].map(match => match[1]);
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

// The exact transform scans run on — exported so callers can convert visible-buffer
// boundaries into scan-text coordinates (old/new-region split in the watcher).
export function compactSignalText(visible: string): string {
  return visible.replace(/\s+/g, '');
}

// Maps an offset of `visible` into compactSignalText(visible) coordinates by tracking
// every stripped whitespace run. Compacting the prefix on its own would misplace the
// boundary whenever a whitespace run straddles it (the joined text strips what the
// prefix alone cannot), and a shifted boundary misclassifies brand-new literals as
// already-scanned tail.
export function compactBoundaryIndex(visible: string, boundary: number): number {
  const clamped = Math.max(0, Math.min(boundary, visible.length));
  let mapped = clamped;
  for (const m of visible.matchAll(/\s+/g)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (clamped >= end) mapped -= m[0].length;
    else if (clamped > start) mapped -= clamped - start;
    else break;
  }
  return mapped;
}

function scanAskAnswer(visible: string, re: RegExp): NeedInputSignal[] {
  const compact = compactSignalText(visible);
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

export function scanNeedInputSignals(visible: string): NeedInputSignal[] {
  return scanAskAnswer(visible, NEED_INPUT_RE);
}

export function scanInputReceivedSignals(visible: string): NeedInputSignal[] {
  return scanAskAnswer(visible, INPUT_RECEIVED_RE);
}

// Document order matters across the two families: an answer swallowed while idle must
// not out-of-order clear an ask that appears after it in the same window.
export function scanAskAnswerSignals(visible: string): AskAnswerSignal[] {
  const merged: AskAnswerSignal[] = [
    ...scanNeedInputSignals(visible).map(s => ({ ...s, kind: 'ask' as const })),
    ...scanInputReceivedSignals(visible).map(s => ({ ...s, kind: 'answer' as const })),
  ];
  return merged.sort((a, b) => a.index - b.index);
}
