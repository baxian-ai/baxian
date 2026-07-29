import type { PrReviewItem, TaskState } from '../shared/index.js';

export const PR_CONVERSATION_CACHE_TTL_MS = 60_000;
export const PR_CONVERSATION_RATE_LIMIT_TTL_MS = 60_000;
const RATE_LIMIT_STRIKE_MEMORY_MS = 10 * 60_000;
const RATE_LIMIT_MAX_WAIT_MS = 900_000;
export const PR_CONVERSATION_CACHE_MAX_ENTRIES = 64;
export const PR_CONVERSATION_CACHE_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
export const PR_CONVERSATION_CACHE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

export interface PrConversationPayload {
  items: PrReviewItem[];
  error?: string;
  rateLimited?: boolean;
  truncated?: boolean;
}

type RevisionTask = Pick<
  TaskState,
  'reviewRound' | 'latestHeadSha' | 'status' | 'reviewDispatchedAt' | 'prFeedbackReceivedAt' | 'prNumber' | 'reviewConversationUpdatedAt'
>;

export function prReviewCacheRevision(task: RevisionTask, repoKey: string): string {
  return [
    task.reviewRound,
    task.latestHeadSha ?? '',
    task.status,
    task.reviewDispatchedAt ?? '',
    task.prFeedbackReceivedAt ?? '',
    task.prNumber ?? '',
    task.reviewConversationUpdatedAt ?? '',
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
  ttlMs?: number;
  maxEntries?: number;
  maxPayloadBytes?: number;
  maxTotalBytes?: number;
  now?: () => number;
}

export class PrConversationCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxPayloadBytes: number;
  private readonly maxTotalBytes: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly rateLimited = new Map<string, RateLimitBackoff>();
  private readonly inflight = new Map<string, InflightBuild>();
  private totalBytes = 0;

  constructor(opts: PrConversationCacheOpts = {}) {
    this.ttlMs = opts.ttlMs ?? PR_CONVERSATION_CACHE_TTL_MS;
    this.maxEntries = opts.maxEntries ?? PR_CONVERSATION_CACHE_MAX_ENTRIES;
    this.maxPayloadBytes = opts.maxPayloadBytes ?? PR_CONVERSATION_CACHE_MAX_PAYLOAD_BYTES;
    this.maxTotalBytes = opts.maxTotalBytes ?? PR_CONVERSATION_CACHE_MAX_TOTAL_BYTES;
    this.now = opts.now ?? Date.now;
  }

  async get(
    key: string,
    revision: string,
    build: () => Promise<PrConversationPayload>,
  ): Promise<PrConversationPayload> {
    this.sweepExpired();
    const entry = this.entries.get(key);
    if (entry && entry.revision === revision && !this.expired(entry)) {
      return entry.payload;
    }
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
            if (!payload.error) this.store(key, revision, payload);
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

  stats(): { entries: number; totalBytes: number } {
    return {
      entries: this.entries.size + this.rateLimited.size,
      totalBytes: this.totalBytes + this.rateLimitedBytes(),
    };
  }

  private expired(entry: CacheEntry): boolean {
    return this.now() - entry.fetchedAt >= this.ttlMs;
  }

  private sweepExpired(): void {
    for (const [key, entry] of this.entries) {
      if (this.expired(entry)) this.remove(key);
    }
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
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    if (payloadBytes > this.maxPayloadBytes) {
      this.remove(key);
      return;
    }
    this.remove(key);
    this.entries.set(key, { revision, fetchedAt: this.now(), payloadBytes, payload });
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
