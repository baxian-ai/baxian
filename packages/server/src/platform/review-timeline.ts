import type { CommentSource, CommentSourceClass } from './types.js';
import { DriverOpError, safeDriverErrorText } from './types.js';
import { versionTimeOf, type NormalizedRow } from './row-schema.js';
import { rowBodyDigest, rowTokens, stripBaxianMarkerLines } from './markers.js';
import { MAX_INLINE_CONTENT_BYTES } from '../shared/index.js';
import type { PrReviewItem, PrReviewItemKind } from '../shared/index.js';

export interface TimelineSourceReader {
  readonly commentSources: readonly CommentSource[];
  listComments(
    source: CommentSource,
    prNumber: number,
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

export interface TimelinePayload {
  items: PrReviewItem[];
  error?: string;
  rateLimited?: boolean;
  truncated?: boolean;
}

interface SourceBucket {
  kind: PrReviewItemKind;
  collected: TimelineEntry[];
  bytes: number;
  truncated: boolean;
  seenRows: Map<string, string>;
}

export class TimelineCollector {
  private readonly buckets = new Map<string, SourceBucket>();
  private readonly itemQuota: number;
  private readonly byteQuota: number;
  private readonly errors: string[] = [];
  private rateLimitedFlag = false;

  constructor(sources: readonly CommentSource[]) {
    const sourceCount = Math.max(sources.length, 1);
    this.itemQuota = Math.max(1, Math.floor(TIMELINE_MAX_ITEMS / sourceCount));
    this.byteQuota = Math.max(1, Math.floor(TIMELINE_MAX_BYTES / sourceCount));
  }

  admitPage(source: CommentSource, pageRows: readonly NormalizedRow[]): void {
    const bucket = this.bucket(source);
    for (const row of pageRows) {
      const id = String(row.id);
      const digest = rowBodyDigest(row);
      if (bucket.seenRows.get(id) === digest) continue;
      bucket.seenRows.set(id, digest);
      const entry = projectRow(source.key, bucket.kind, row);
      const size = Buffer.byteLength(JSON.stringify(entry.item), 'utf8') + 1;
      if (bucket.collected.length >= this.itemQuota || bucket.bytes + size > this.byteQuota) {
        bucket.truncated = true;
        break;
      }
      bucket.bytes += size;
      bucket.collected.push(entry);
    }
  }

  overQuota(source: CommentSource): boolean {
    const bucket = this.bucket(source);
    if (bucket.truncated) return true;
    if (bucket.collected.length >= this.itemQuota || bucket.bytes >= this.byteQuota) {
      bucket.truncated = true;
      return true;
    }
    return false;
  }

  noteFailure(sourceKey: string, error: unknown): void {
    this.errors.push(`${sourceKey}: ${safeDriverErrorText(error)}`);
    this.buckets.delete(sourceKey);
    if (error instanceof DriverOpError && error.info.errorClass === 'RATE_LIMIT') {
      this.rateLimitedFlag = true;
    }
  }

  get rateLimited(): boolean {
    return this.rateLimitedFlag;
  }

  assemble(): TimelinePayload {
    const entries: TimelineEntry[] = [];
    let truncated = false;
    for (const bucket of this.buckets.values()) {
      entries.push(...bucket.collected);
      if (bucket.truncated) truncated = true;
    }
    sortTimeline(entries);
    return {
      items: entries.map(e => e.item),
      ...(this.errors.length > 0 ? { error: this.errors.join('; ') } : {}),
      ...(this.rateLimitedFlag ? { rateLimited: true } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
  }

  private bucket(source: CommentSource): SourceBucket {
    let bucket = this.buckets.get(source.key);
    if (!bucket) {
      bucket = {
        kind: KIND_BY_CLASS[source.category],
        collected: [],
        bytes: 0,
        truncated: false,
        seenRows: new Map(),
      };
      this.buckets.set(source.key, bucket);
    }
    return bucket;
  }
}

export async function buildDriverReviewTimeline(
  driver: TimelineSourceReader,
  prNumber: number,
): Promise<TimelinePayload> {
  const collector = new TimelineCollector(driver.commentSources);
  for (const source of driver.commentSources) {
    let pagedInline = false;
    try {
      const rows = await driver.listComments(
        source,
        prNumber,
        pageRows => {
          pagedInline = true;
          collector.admitPage(source, pageRows);
          return pageRows.map(r => ({ id: r.id, bodyDigest: rowBodyDigest(r) }));
        },
        () => collector.overQuota(source),
      );
      if (!pagedInline) collector.admitPage(source, rows);
    } catch (err) {
      console.warn(`[review-timeline] source ${source.key} failed:`, safeDriverErrorText(err));
      collector.noteFailure(source.key, err);
      if (collector.rateLimited) break;
    }
  }
  return collector.assemble();
}

function projectRow(sourceKey: string, kind: PrReviewItemKind, row: NormalizedRow): TimelineEntry {
  const id = String(row.id);
  const token = rowTokens(row)[0];
  const timelineBody = sizedBody(stripBaxianMarkerLines(typeof row.body === 'string' ? row.body : ''));
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
