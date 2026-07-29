import type { CommentSourceOp } from './types.js';
import { DriverOpError, safeDriverErrorText } from './git-driver.js';
import { versionTimeOf, type NormalizedRow } from './row-schema.js';
import { classifyCommentSource, rowBodyDigest, rowTokens, stripBaxianMarkerLines, type CommentSourceClass } from './markers.js';
import { MAX_INLINE_CONTENT_BYTES } from '../shared/index.js';
import type { PrReviewItem, PrReviewItemKind } from '../shared/index.js';

export interface TimelineSourceReader {
  readonly commentSources: CommentSourceOp[];
  runCommentSource(
    source: CommentSourceOp,
    vars: { prNumber: number },
    projectPage?: (pageRows: NormalizedRow[]) => NormalizedRow[],
    shouldStop?: (pageRows: NormalizedRow[], page: number) => boolean,
  ): Promise<NormalizedRow[]>;
}

const TIMELINE_MAX_ITEMS = 2_000;
const TIMELINE_PAYLOAD_MAX_BYTES = 2 * 1024 * 1024;
const TIMELINE_FRAMING_RESERVE = 8 * 1024;
const TIMELINE_MAX_BYTES = TIMELINE_PAYLOAD_MAX_BYTES - TIMELINE_FRAMING_RESERVE;

const KIND_BY_CLASS: Record<CommentSourceClass, PrReviewItemKind> = {
  reviews: 'review',
  threaded: 'review-comment',
  'top-level': 'issue-comment',
};

interface TimelineEntry {
  item: PrReviewItem;
  sortTime?: number;
}

export async function buildDriverReviewTimeline(
  driver: TimelineSourceReader,
  prNumber: number,
): Promise<{ items: PrReviewItem[]; error?: string; rateLimited?: boolean; truncated?: boolean }> {
  const entries: TimelineEntry[] = [];
  const errors: string[] = [];
  let rateLimited = false;
  let truncated = false;
  const sourceCount = Math.max(driver.commentSources.length, 1);
  const itemQuota = Math.max(1, Math.floor(TIMELINE_MAX_ITEMS / sourceCount));
  const byteQuota = Math.max(1, Math.floor(TIMELINE_MAX_BYTES / sourceCount));
  for (const source of driver.commentSources) {
    const kind = KIND_BY_CLASS[classifyCommentSource(source)];
    const collected: TimelineEntry[] = [];
    let sourceBytes = 0;
    let sourceTruncated = false;
    const markTruncated = (): void => {
      sourceTruncated = true;
      truncated = true;
    };
    const overQuota = (): boolean => {
      if (sourceTruncated) return true;
      if (collected.length >= itemQuota || sourceBytes >= byteQuota) {
        markTruncated();
        return true;
      }
      return false;
    };
    const seenRows = new Map<string, string>();
    const admit = (pageRows: NormalizedRow[]): void => {
      for (const row of pageRows) {
        compactRowForTimeline(row);
        if (row.system === true) continue;
        const id = String(row.id);
        const digest = String(row.bodyDigest ?? '');
        if (seenRows.get(id) === digest) continue;
        seenRows.set(id, digest);
        const entry = projectRow(source.key, kind, row);
        const size = Buffer.byteLength(JSON.stringify(entry.item), 'utf8') + 1;
        if (collected.length >= itemQuota || sourceBytes + size > byteQuota) {
          markTruncated();
          break;
        }
        sourceBytes += size;
        collected.push(entry);
      }
    };
    let pagedInline = false;
    let rows: NormalizedRow[];
    try {
      rows = await driver.runCommentSource(
        source,
        { prNumber },
        pageRows => {
          pagedInline = true;
          admit(pageRows);
          return pageRows.map(r => ({ id: r.id, bodyDigest: r.bodyDigest }));
        },
        () => overQuota(),
      );
      if (!pagedInline) admit(rows);
      entries.push(...collected);
    } catch (err) {
      console.warn(`[review-timeline] source ${source.key} failed:`, safeDriverErrorText(err));
      errors.push(`${source.key}: ${safeDriverErrorText(err)}`);
      if (err instanceof DriverOpError && err.info.errorClass === 'RATE_LIMIT') {
        rateLimited = true;
        break;
      }
      continue;
    }
  }
  sortTimeline(entries);
  return {
    items: entries.map(e => e.item),
    ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
    ...(rateLimited ? { rateLimited: true } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

interface TimelineBodyStash {
  timelineToken?: ReturnType<typeof rowTokens>[number];
  timelineBody: { body?: string; bodyTruncated?: boolean };
}

function compactRowForTimeline(row: NormalizedRow): void {
  const token = rowTokens(row)[0];
  if (row.bodyDigest === undefined) row.bodyDigest = rowBodyDigest(row);
  const body = sizedBody(stripBaxianMarkerLines(typeof row.body === 'string' ? row.body : ''));
  (row as NormalizedRow & TimelineBodyStash).timelineToken = token;
  (row as NormalizedRow & TimelineBodyStash).timelineBody = body;
  delete row.body;
}

function timelineStash(row: NormalizedRow): TimelineBodyStash {
  const stashed = row as NormalizedRow & Partial<TimelineBodyStash>;
  if (stashed.timelineBody !== undefined) {
    return { timelineToken: stashed.timelineToken, timelineBody: stashed.timelineBody };
  }
  return {
    timelineToken: rowTokens(row)[0],
    timelineBody: sizedBody(stripBaxianMarkerLines(typeof row.body === 'string' ? row.body : '')),
  };
}

function projectRow(sourceKey: string, kind: PrReviewItemKind, row: NormalizedRow): TimelineEntry {
  const id = String(row.id);
  const { timelineToken: token, timelineBody } = timelineStash(row);
  const line = typeof row.line === 'number' ? row.line
    : typeof row.originalLine === 'number' ? row.originalLine : undefined;
  const createdAt = typeof row.createdAt === 'string' ? row.createdAt
    : typeof row.updatedAt === 'string' ? row.updatedAt : undefined;
  const threaded = kind === 'review-comment' && row.discussionId !== null && row.discussionId !== undefined;
  const isReply = row.parentId !== null && row.parentId !== undefined && String(row.parentId) !== String(row.id);
  return {
    item: {
      kind,
      id,
      sourceKey,
      threadKey: `${sourceKey}:${threaded ? String(row.discussionId) : id}`,
      ...(typeof row.author === 'string' && row.author !== '' ? { author: row.author } : {}),
      ...timelineBody,
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(token !== undefined
        ? {
          verdict: token.kind === 'pass' ? 'approve' as const : 'request-changes' as const,
          roundToken: token.token,
          anchorSha: token.anchorSha,
        }
        : {}),
      ...(typeof row.reviewState === 'string' ? { reviewState: row.reviewState } : {}),
      ...(typeof row.path === 'string' ? { path: row.path } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(typeof row.commitSha === 'string' ? { commitSha: row.commitSha } : {}),
      ...(isReply ? { inReplyTo: true } : {}),
    },
    sortTime: versionTimeOf(row),
  };
}

function sizedBody(raw: string): { body?: string; bodyTruncated?: boolean } {
  const trimmed = raw.replace(/\n+$/, '');
  const buf = Buffer.from(trimmed, 'utf8');
  if (buf.byteLength <= MAX_INLINE_CONTENT_BYTES) {
    return trimmed !== '' ? { body: trimmed } : {};
  }
  let cut = MAX_INLINE_CONTENT_BYTES;
  while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--;
  return { body: buf.subarray(0, cut).toString('utf8'), bodyTruncated: true };
}

function sortTimeline(entries: TimelineEntry[]): void {
  const rank = (e: TimelineEntry): number =>
    (e.item.kind === 'review' || e.item.verdict !== undefined ? 1 : 0);
  entries.sort((a, b) => {
    if (a.sortTime !== undefined && b.sortTime !== undefined) {
      if (a.sortTime !== b.sortTime) return a.sortTime - b.sortTime;
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
    }
    if (a.sortTime !== undefined) return -1;
    if (b.sortTime !== undefined) return 1;
    return 0;
  });
}
