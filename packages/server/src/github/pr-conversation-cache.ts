import type { GithubReviewItem, TaskState } from '../shared/index.js';

export const PR_CONVERSATION_CACHE_TTL_MS = 60_000;
export const PR_CONVERSATION_CACHE_MAX_ENTRIES = 64;
export const PR_CONVERSATION_CACHE_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
export const PR_CONVERSATION_CACHE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

export interface PrConversationPayload {
  items: GithubReviewItem[];
  error?: string;
}

type RevisionTask = Pick<
  TaskState,
  'reviewRound' | 'latestHeadSha' | 'status' | 'reviewDispatchedAt' | 'prFeedbackReceivedAt' | 'prNumber'
>;

// web/src/shared/github-review.ts 的 githubReviewRevision 字段必须是本函数的前缀子集：
// 前端触发重拉的任何变化在服务端必然 miss，服务端仅追加 miss 条件（repoSlug 仅服务端可见）。
export function githubReviewRevision(task: RevisionTask, repoSlug: string): string {
  return [
    task.reviewRound,
    task.latestHeadSha ?? '',
    task.status,
    task.reviewDispatchedAt ?? '',
    task.prFeedbackReceivedAt ?? '',
    task.prNumber ?? '',
    repoSlug,
  ].join(':');
}

interface CacheEntry {
  revision: string;
  fetchedAt: number;
  payloadBytes: number;
  payload: PrConversationPayload;
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
    const running = this.inflight.get(key);
    if (running && running.revision === revision) {
      return running.promise;
    }
    // revision 不同：直接取代注册，旧构建继续跑但落定时不再拥有写入权。
    const reg: InflightBuild = { revision, promise: Promise.resolve({ items: [] }) };
    reg.promise = (async () => {
      try {
        const payload = await build();
        if (this.inflight.get(key) === reg) {
          this.inflight.delete(key);
          if (!payload.error) this.store(key, revision, payload);
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
    return { entries: this.entries.size, totalBytes: this.totalBytes };
  }

  private expired(entry: CacheEntry): boolean {
    return this.now() - entry.fetchedAt >= this.ttlMs;
  }

  private sweepExpired(): void {
    for (const [key, entry] of this.entries) {
      if (this.expired(entry)) this.remove(key);
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
    // store() 先 delete 再 set，Map 插入序即 fetchedAt 非降序，队首即最旧。
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
