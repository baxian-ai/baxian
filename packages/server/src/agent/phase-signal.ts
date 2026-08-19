import { randomUUID } from 'node:crypto';

export type PhaseSignalKind =
  | 'pr-created'
  | 'pr-fixed'
  | 'pr-merge-ready'
  | 'spec-done'
  | 'greeting';

export const PASSIVE_VERDICT_WATCH: readonly PhaseSignalKind[] = [];

export const PHASE_SIGNAL_KINDS: readonly PhaseSignalKind[] = [
  'pr-created',
  'pr-fixed',
  'pr-merge-ready',
  'spec-done',
  'greeting',
] as const;

export type PhaseSignal =
  | { kind: 'pr-created'; token: string; prNumber: number }
  | { kind: 'pr-fixed'; token: string }
  | { kind: 'pr-merge-ready'; token: string }
  | { kind: 'spec-done'; token: string; prNumber: number }
  | { kind: 'greeting'; token: string };

const VALID_KINDS = new Set<PhaseSignalKind>(PHASE_SIGNAL_KINDS);

const TOKEN_RANGE = '[A-Za-z0-9_-]{6,64}';
const COMPACT_SIGNAL_RE_PR_DELIVERY = new RegExp(
  `\\[bx:(pr-created|spec-done):(\\d+):(${TOKEN_RANGE})\\]`,
  'g',
);
const COMPACT_SIGNAL_RE_PLAIN = new RegExp(
  `\\[bx:(pr-fixed|pr-merge-ready|greeting):(${TOKEN_RANGE})\\]`,
  'g',
);

export function buildPhaseSignal(
  kind: Exclude<PhaseSignalKind, 'pr-created' | 'spec-done'>,
  token: string,
): string;
export function buildPhaseSignal(
  kind: 'pr-created' | 'spec-done',
  token: string,
  prNumber: number,
): string;
export function buildPhaseSignal(
  kind: PhaseSignalKind,
  token: string,
  prNumber?: number,
): string {
  if (kind === 'pr-created' || kind === 'spec-done') {
    if (prNumber === undefined) {
      throw new Error(`buildPhaseSignal(${kind}) requires prNumber`);
    }
    return `[bx:${kind}:${prNumber}:${token}]`;
  }
  return `[bx:${kind}:${token}]`;
}

export function createSignalToken(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

export interface PhaseSignalMatch {
  signal: PhaseSignal;
  raw: string;
  index: number;
}

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
        token: m[3],
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

export interface NeedInputSignal {
  token: string;
  seq?: number;
  raw: string;
  index: number;
}

export interface AskAnswerSignal extends NeedInputSignal {
  kind: 'ask' | 'answer';
}

const NEED_INPUT_RE = new RegExp(`\\[bx:need-input:(${TOKEN_RANGE})(?::(\\d{1,4}))?\\]`, 'g');
const INPUT_RECEIVED_RE = new RegExp(`\\[bx:input-received:(${TOKEN_RANGE})(?::(\\d{1,4}))?\\]`, 'g');

export function compactSignalText(visible: string): string {
  return visible.replace(/\s+/g, '');
}

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

export function scanAskAnswerSignals(visible: string): AskAnswerSignal[] {
  const merged: AskAnswerSignal[] = [
    ...scanNeedInputSignals(visible).map(s => ({ ...s, kind: 'ask' as const })),
    ...scanInputReceivedSignals(visible).map(s => ({ ...s, kind: 'answer' as const })),
  ];
  return merged.sort((a, b) => a.index - b.index);
}
