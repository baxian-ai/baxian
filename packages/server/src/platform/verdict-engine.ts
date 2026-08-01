import { rowBodyDigest, rowTokens } from './markers.js';
import { versionTimeOf, versionTimestampOf, type NormalizedRow } from './row-schema.js';
import type { CommentSourceClass } from './types.js';

export interface VerdictSourceScan {
  key: string;
  sourceClass: CommentSourceClass;
  ok: boolean;
  scanStartedAt: number;
  rows: NormalizedRow[];
}

interface VerdictTokenPair {
  passToken: string;
  failToken: string;
}

export interface VerdictInput {
  taskId: string;
  prNumber: number;
  anchorSha: string;
  pair: VerdictTokenPair;
  sources: VerdictSourceScan[];
  visibilityLagMs: number;
}

interface VerdictCarrier {
  sourceKey: string;
  id: string;
  bodyDigest: string;
}

export interface VerdictDecision {
  kind: 'pass' | 'fail';
  token: string;
  anchorSha: string;
  conflict: boolean;
  carrier: VerdictCarrier;
  submittedAt?: string;
}

export interface PassProvenanceRecord {
  token: string;
  failToken: string;
  anchorSha: string;
  carrier: VerdictCarrier;
}

interface PassCandidate {
  token: string;
  recordedScanAt: number;
}

interface TokenMatch {
  sourceKey: string;
  row: NormalizedRow;
}

function isProtocolCarrier(row: NormalizedRow): boolean {
  return versionTimeOf(row) !== undefined;
}

export function deadTokens(sources: VerdictSourceScan[]): Set<string> {
  const dead = new Set<string>();
  for (const s of sources) {
    if (s.sourceClass !== 'reviews') continue;
    for (const row of s.rows) {
      if (row.reviewState !== 'DISMISSED' || !isProtocolCarrier(row)) continue;
      for (const m of rowTokens(row)) dead.add(m.token);
    }
  }
  return dead;
}

export function recheckPassProvenance(
  record: PassProvenanceRecord,
  sources: VerdictSourceScan[],
): { ok: true } | { ok: false; reason: string } {
  if (sources.some(s => !s.ok)) return { ok: false, reason: 'source-scan-incomplete' };
  const row = sources.find(s => s.key === record.carrier.sourceKey)?.rows.find(r => String(r.id) === record.carrier.id);
  if (row === undefined) return { ok: false, reason: 'carrier-row-missing' };
  if (rowBodyDigest(row) !== record.carrier.bodyDigest) return { ok: false, reason: 'carrier-body-edited' };
  if (!rowTokens(row).some(m => m.kind === 'pass' && m.token === record.token
    && m.anchorSha === record.anchorSha.toLowerCase())) {
    return { ok: false, reason: 'carrier-token-missing' };
  }
  const dead = deadTokens(sources);
  if (dead.has(record.token)) return { ok: false, reason: 'token-dismissed' };
  const anchor = record.anchorSha.toLowerCase();
  for (const s of sources) {
    for (const r of s.rows) {
      if (!isProtocolCarrier(r)) continue;
      for (const m of rowTokens(r)) {
        if (m.kind === 'fail' && m.token === record.failToken && m.anchorSha === anchor && !dead.has(m.token)) {
          return { ok: false, reason: 'fail-token-present' };
        }
      }
    }
  }
  return { ok: true };
}

export class VerdictEngine {
  private readonly candidates = new Map<string, PassCandidate>();

  evaluate(input: VerdictInput): VerdictDecision | undefined {
    if (input.sources.some(s => !s.ok)) return undefined;

    const anchor = input.anchorSha.toLowerCase();
    const dead = deadTokens(input.sources);
    let passMatch: TokenMatch | undefined;
    let failMatch: TokenMatch | undefined;
    for (const s of input.sources) {
      for (const row of s.rows) {
        if (!isProtocolCarrier(row)) continue;
        for (const m of rowTokens(row)) {
          if (m.anchorSha !== anchor || dead.has(m.token)) continue;
          if (m.kind === 'fail' && m.token === input.pair.failToken) failMatch ??= { sourceKey: s.key, row };
          if (m.kind === 'pass' && m.token === input.pair.passToken) passMatch ??= { sourceKey: s.key, row };
        }
      }
    }

    const key = `${input.taskId}:${input.prNumber}`;
    if (failMatch) {
      this.candidates.delete(key);
      return this.decision('fail', input.pair.failToken, anchor, passMatch !== undefined, failMatch);
    }
    if (!passMatch) {
      this.candidates.delete(key);
      return undefined;
    }

    const minScanStart = Math.min(...input.sources.map(s => s.scanStartedAt));
    const fence = minScanStart - input.visibilityLagMs;
    const vt = versionTimeOf(passMatch.row);
    if (vt === undefined || vt >= fence) {
      this.candidates.delete(key);
      return undefined;
    }
    const candidate = this.candidates.get(key);
    if (candidate === undefined || candidate.token !== input.pair.passToken) {
      this.candidates.set(key, { token: input.pair.passToken, recordedScanAt: minScanStart });
      return undefined;
    }
    if (minScanStart <= candidate.recordedScanAt) return undefined;
    return this.decision('pass', input.pair.passToken, anchor, false, passMatch);
  }

  recheckPassProvenance(
    record: PassProvenanceRecord,
    sources: VerdictSourceScan[],
  ): { ok: true } | { ok: false; reason: string } {
    return recheckPassProvenance(record, sources);
  }

  dropCandidate(taskId: string, prNumber: number): void {
    this.candidates.delete(`${taskId}:${prNumber}`);
  }

  dropTask(taskId: string): void {
    for (const key of this.candidates.keys()) {
      if (key.startsWith(`${taskId}:`)) this.candidates.delete(key);
    }
  }

  private decision(
    kind: 'pass' | 'fail', token: string, anchorSha: string, conflict: boolean, match: TokenMatch,
  ): VerdictDecision {
    return {
      kind, token, anchorSha, conflict,
      carrier: { sourceKey: match.sourceKey, id: String(match.row.id), bodyDigest: rowBodyDigest(match.row) },
      submittedAt: versionTimestampOf(match.row),
    };
  }
}
