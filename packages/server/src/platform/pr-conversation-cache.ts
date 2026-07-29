import type { PrReviewItem, TaskState } from '../shared/index.js';

const PR_CONVERSATION_RATE_LIMIT_TTL_MS = 60_000;
const RATE_LIMIT_STRIKE_MEMORY_MS = 10 * 60_000;
const RATE_LIMIT_MAX_WAIT_MS = 900_000;
const PR_CONVERSATION_CACHE_MAX_ENTRIES = 64;
const PR_CONVERSATION_CACHE_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const PR_CONVERSATION_CACHE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

export interface PrConversationPayload {
  items: PrReviewItem[];
  error?: string;
  rateLimited?: boolean;
  truncated?: boolean;
  fetchedAt?: string;
}

type RevisionTask = Pick<
  TaskState,
  'reviewRound' | 'latestHeadSha' | 'status' | 'reviewDispatchedAt' | 'prFeedbackReceivedAt' | 'prNumber' | 'reviewConversationUpdatedAt' | 'closedUnmergedAnchor'
>;

function closedUnmergedAnchorSlot(task: Pick<TaskState, 'closedUnmergedAnchor'>): string {
  const anchor = task.closedUnmergedAnchor;
  if (anchor === undefined) return '';
  return `${anchor.generation}/${anchor.cleared === true ? 'reopened' : 'closed'}`;
}

export function prReviewCacheRevision(task: RevisionTask, repoKey: string): string {
  return [
    task.reviewRound,
    task.latestHeadSha ?? '',
    task.status,
    task.reviewDispatchedAt ?? '',
    task.prFeedbackReceivedAt ?? '',
    task.prNumber ?? '',
    task.reviewConversationUpdatedAt ?? '',
    closedUnmergedAnchorSlot(task),
    repoKey,
  ].join(':');
}

interface CacheEntry {
  revision: string;
  fetchedAt: number;
  payloadBytes: number;
  payload: PrConversationPayload;
}

interface RateLimitBackoff {
  until: number;
  strikes: number;
  revision: string;
  payload: PrConversationPayload;
  payloadBytes: number;
}

interface InflightBuild {
  revision: string;
  promise: Promise<PrConversationPayload>;
}

export interface PrConversationCacheOpts {
  maxEntries?: number;
  maxPayloadBytes?: number;
  maxTotalBytes?: number;
  now?: () => number;
}

export class PrConversationCache {
  private readonly maxEntries: number;
  private readonly maxPayloadBytes: number;
  private readonly maxTotalBytes: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly rateLimited = new Map<string, RateLimitBackoff>();
  private readonly inflight = new Map<string, InflightBuild>();
  // put() 建立的 conversationTime 下限：任务快照早于最后一次 poller 写入的 build 不得落盘
  private readonly putFloors = new Map<string, string>();
  private totalBytes = 0;

  constructor(opts: PrConversationCacheOpts = {}) {
    this.maxEntries = opts.maxEntries ?? PR_CONVERSATION_CACHE_MAX_ENTRIES;
    this.maxPayloadBytes = opts.maxPayloadBytes ?? PR_CONVERSATION_CACHE_MAX_PAYLOAD_BYTES;
    this.maxTotalBytes = opts.maxTotalBytes ?? PR_CONVERSATION_CACHE_MAX_TOTAL_BYTES;
    this.now = opts.now ?? Date.now;
  }

  async get(
    key: string,
    revision: string,
    build: () => Promise<PrConversationPayload>,
    conversationTime = '',
  ): Promise<PrConversationPayload> {
    this.sweepRateLimited();
    const entry = this.entries.get(key);
    if (entry && entry.revision === revision) {
      return this.stamped(entry);
    }
    return this.buildThrough(key, revision, build, conversationTime);
  }

  async force(
    key: string,
    revision: string,
    build: () => Promise<PrConversationPayload>,
    conversationTime = '',
  ): Promise<PrConversationPayload> {
    this.sweepRateLimited();
    return this.buildThrough(key, revision, build, conversationTime);
  }

  put(key: string, revision: string, payload: PrConversationPayload, conversationTime = ''): void {
    if (payload.error !== undefined || payload.rateLimited === true) return;
    this.sweepRateLimited();
    this.setPutFloor(key, conversationTime);
    this.inflight.delete(key);
    this.rateLimited.delete(key);
    this.store(key, revision, payload);
  }

  stats(): { entries: number; totalBytes: number } {
    return {
      entries: this.entries.size + this.rateLimited.size,
      totalBytes: this.totalBytes + this.rateLimitedBytes(),
    };
  }

  private async buildThrough(
    key: string,
    revision: string,
    build: () => Promise<PrConversationPayload>,
    conversationTime: string,
  ): Promise<PrConversationPayload> {
    const throttled = this.rateLimited.get(key);
    if (throttled !== undefined) {
      if (this.now() < throttled.until) {
        return throttled.revision === revision
          ? throttled.payload
          : { items: [], error: throttled.payload.error ?? 'rate limited', rateLimited: true };
      }
      this.rateLimited.set(key, {
        ...throttled,
        payload: { items: [], rateLimited: true },
        payloadBytes: 0,
      });
    }
    const running = this.inflight.get(key);
    if (running && running.revision === revision) {
      return running.promise;
    }
    const reg: InflightBuild = { revision, promise: Promise.resolve({ items: [] }) };
    reg.promise = (async () => {
      try {
        const payload = await build();
        if (this.inflight.get(key) === reg) {
          this.inflight.delete(key);
          if (payload.rateLimited) this.noteRateLimited(key, revision, payload);
          else {
            this.rateLimited.delete(key);
            if (!payload.error) {
              if (!this.fencedByPut(key, conversationTime)) {
                this.store(key, revision, payload);
              }
              return { ...payload, fetchedAt: new Date(this.now()).toISOString() };
            }
          }
        }
        return payload;
      } catch (err) {
        if (this.inflight.get(key) === reg) this.inflight.delete(key);
        throw err;
      }
    })();
    this.inflight.set(key, reg);
    return reg.promise;
  }

  private stamped(entry: CacheEntry): PrConversationPayload {
    return { ...entry.payload, fetchedAt: new Date(entry.fetchedAt).toISOString() };
  }

  private setPutFloor(key: string, conversationTime: string): void {
    this.putFloors.delete(key);
    this.putFloors.set(key, conversationTime);
    while (this.putFloors.size > this.maxEntries) {
      const oldest = this.putFloors.keys().next().value;
      if (oldest === undefined) break;
      this.putFloors.delete(oldest);
    }
  }

  private fencedByPut(key: string, conversationTime: string): boolean {
    const floor = this.putFloors.get(key);
    return floor !== undefined && conversationTime < floor;
  }

  private sweepRateLimited(): void {
    const now = this.now();
    for (const [key, backoff] of this.rateLimited) {
      if (now >= backoff.until + RATE_LIMIT_STRIKE_MEMORY_MS) this.rateLimited.delete(key);
    }
    while (this.rateLimited.size > this.maxEntries) {
      const oldest = this.rateLimited.keys().next().value;
      if (oldest === undefined) break;
      this.rateLimited.delete(oldest);
    }
  }

  private noteRateLimited(key: string, revision: string, payload: PrConversationPayload): void {
    const strikes = (this.rateLimited.get(key)?.strikes ?? 0) + 1;
    const wait = Math.min(PR_CONVERSATION_RATE_LIMIT_TTL_MS * 2 ** (strikes - 1), RATE_LIMIT_MAX_WAIT_MS);
    const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    const kept: PrConversationPayload = bytes > this.maxPayloadBytes
      ? { items: [], error: payload.error, rateLimited: true }
      : payload;
    this.rateLimited.delete(key);
    this.rateLimited.set(key, {
      until: this.now() + wait,
      strikes,
      revision,
      payload: kept,
      payloadBytes: kept === payload ? bytes : Buffer.byteLength(JSON.stringify(kept), 'utf8'),
    });
    this.enforceRateLimitBudget();
  }

  private rateLimitedBytes(): number {
    let total = 0;
    for (const backoff of this.rateLimited.values()) total += backoff.payloadBytes;
    return total;
  }

  private enforceRateLimitBudget(): void {
    while (
      this.rateLimited.size > this.maxEntries
      || this.totalBytes + this.rateLimitedBytes() > this.maxTotalBytes
    ) {
      const oldest = this.rateLimited.keys().next().value;
      if (oldest === undefined) return;
      const backoff = this.rateLimited.get(oldest)!;
      if (backoff.payloadBytes === 0 && this.rateLimited.size <= this.maxEntries) return;
      if (backoff.payloadBytes > 0) {
        this.rateLimited.delete(oldest);
        this.rateLimited.set(oldest, {
          ...backoff,
          payload: { items: [], error: backoff.payload.error, rateLimited: true },
          payloadBytes: 0,
        });
        continue;
      }
      this.rateLimited.delete(oldest);
    }
  }

  private store(key: string, revision: string, payload: PrConversationPayload): void {
    const { fetchedAt: _stale, ...bare } = payload;
    const payloadBytes = Buffer.byteLength(JSON.stringify(bare), 'utf8');
    if (payloadBytes > this.maxPayloadBytes) {
      this.remove(key);
      return;
    }
    this.remove(key);
    this.entries.set(key, { revision, fetchedAt: this.now(), payloadBytes, payload: bare });
    this.totalBytes += payloadBytes;
    this.evict();
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxTotalBytes) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) return;
      this.remove(oldestKey);
    }
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalBytes -= entry.payloadBytes;
  }
}
