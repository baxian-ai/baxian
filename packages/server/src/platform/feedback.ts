import {
  ackCarrierKey, collectValidAcks, projectCommentRow,
  rowAcks, rowBodyDigest, rowHasBody, rowTokens,
  type AckCarrierRow,
} from './markers.js';
import { versionTimeOf, type NormalizedRow } from './row-schema.js';
import type { CommentSource, CommentSourceClass } from './types.js';
import { deadTokens, type VerdictSourceScan } from './verdict-engine.js';

export interface FeedbackSourceScan {
  key: string;
  sourceClass: CommentSourceClass;
  ok: boolean;
  rows: NormalizedRow[];
}

export interface PendingFeedbackResult {
  allSourcesOk: boolean;
  pending: Set<string>;
}

export interface CommentSourceReader {
  readonly commentSources: readonly CommentSource[];
  listComments(
    source: CommentSource,
    prNumber: number,
    projectPage?: (pageRows: NormalizedRow[]) => NormalizedRow[],
  ): Promise<NormalizedRow[]>;
}

export interface ScanRowCollector {
  admitPage(source: CommentSource, pageRows: readonly NormalizedRow[]): void;
  noteFailure(sourceKey: string, error: unknown): void;
}

export async function scanCommentSourcesOnce(
  driver: CommentSourceReader,
  prNumber: number,
  now: () => number,
  onFailure?: (key: string, error: unknown) => void,
  collector?: ScanRowCollector,
): Promise<VerdictSourceScan[]> {
  const scans: VerdictSourceScan[] = [];
  for (const source of driver.commentSources) {
    const scanStartedAt = now();
    try {
      let pagedInline = false;
      const rows = await driver.listComments(source, prNumber, pageRows => {
        pagedInline = true;
        collector?.admitPage(source, pageRows);
        for (const row of pageRows) projectCommentRow(row);
        return pageRows;
      });
      // A driver may return everything without ever calling projectPage; rows must still come out projected.
      if (!pagedInline) {
        collector?.admitPage(source, rows);
        for (const row of rows) projectCommentRow(row);
      }
      scans.push({ key: source.key, sourceClass: source.category, ok: true, scanStartedAt, rows });
    } catch (error) {
      scans.push({ key: source.key, sourceClass: source.category, ok: false, scanStartedAt, rows: [] });
      collector?.noteFailure(source.key, error);
      onFailure?.(source.key, error);
    }
  }
  return scans;
}

export function buildAckCarrierRows(scans: readonly FeedbackSourceScan[]): AckCarrierRow[] {
  return scans.flatMap(scan => scan.rows.map(row => ({
    sourceKey: scan.key,
    id: String(row.id),
    acks: rowAcks(row),
  })));
}

// digest identifies the comment revision for fix-dispatch dedupe; acks themselves match by id alone.
function unackedComment(
  row: NormalizedRow,
  sourceKey: string,
  settled: Set<string>,
): { id: string; digest: string } | undefined {
  if (versionTimeOf(row) === undefined) return undefined;
  if (!rowHasBody(row)) return undefined;
  const id = String(row.id);
  if (settled.has(ackCarrierKey(sourceKey, id))) return undefined;
  return { id, digest: rowBodyDigest(row) };
}

export function feedbackEventTarget(
  row: NormalizedRow,
  sourceKey: string,
  settled: Set<string>,
): { id: string; digest: string } | undefined {
  if (rowTokens(row).length > 0) return undefined;
  return unackedComment(row, sourceKey, settled);
}

export function collectPendingFeedback(scans: readonly FeedbackSourceScan[]): PendingFeedbackResult {
  const settled = collectValidAcks(buildAckCarrierRows(scans));
  const dead = deadTokens(scans.map(s => ({ ...s, scanStartedAt: 0 })));
  const pending = new Set<string>();
  for (const scan of scans) {
    if (!scan.ok) continue;
    for (const row of scan.rows) {
      const tokens = rowTokens(row);
      if (tokens.length > 0 && !tokens.some(t => t.kind === 'fail' && !dead.has(t.token))) continue;
      const target = unackedComment(row, scan.key, settled);
      if (target === undefined) continue;
      pending.add(ackCarrierKey(scan.key, target.id));
    }
  }
  return { allSourcesOk: scans.every(s => s.ok), pending };
}
