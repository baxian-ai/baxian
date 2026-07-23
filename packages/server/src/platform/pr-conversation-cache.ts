import type { PrReviewItem, TaskState } from '../shared/index.js';

export const PR_CONVERSATION_CACHE_TTL_MS = 60_000;
// 限流结果必须服务端共享退避：只靠客户端计时挡不住刷新、第二个浏览器与重复 mount，
// 而限流期间继续打平台可能导致集成被封禁（GitHub 明示）。
export const PR_CONVERSATION_RATE_LIMIT_TTL_MS = 60_000;
// 窗口过期后仍记住连击一段时间：立即遗忘会让每次重试都从 60s 起，指数增长永不生效。
const RATE_LIMIT_STRIKE_MEMORY_MS = 10 * 60_000;
// 与 poller 的限流退避同上限：无封顶的 2^n 会在连续五六次后把端点锁死数小时，
// 平台早已恢复也无法自愈（进入长窗口后连重建都不再发生，计数也就永不清零）。
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

// web/src/shared/pr-review.ts 的 prReviewRevision 字段必须是本函数的前缀子集：
// 前端触发重拉的任何变化在服务端必然 miss，服务端仅追加 miss 条件（repoKey 仅服务端可见）。
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
    // 退避按 task 生效（同 task 任何请求在窗口内都不得再打平台），但 payload 绑定 revision：
    // 换绑 PR/仓库后 revision 变化，只回退避状态，绝不把旧 PR 的评论挂到新 PR 名下。
    const throttled = this.rateLimited.get(key);
    if (throttled !== undefined) {
      if (this.now() < throttled.until) {
        return throttled.revision === revision
          ? throttled.payload
          : { items: [], error: throttled.payload.error ?? 'rate limited', rateLimited: true };
      }
      // 窗口已过：放行本次重建，但保留连击计数（并丢掉 payload 只留状态）供指数增长使用。
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
    // revision 不同：直接取代注册，旧构建继续跑但落定时不再拥有写入权。
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
    // 退避条目同样参与全局回收与容量上限，否则历史限流任务会让这张表无界增长。
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

  // 连续限流按指数增长（60 / 120 / 240…），成功即清零——客户端计时保护不了其他客户端。
  private noteRateLimited(key: string, revision: string, payload: PrConversationPayload): void {
    const strikes = (this.rateLimited.get(key)?.strikes ?? 0) + 1;
    const wait = Math.min(PR_CONVERSATION_RATE_LIMIT_TTL_MS * 2 ** (strikes - 1), RATE_LIMIT_MAX_WAIT_MS);
    // 超过单项上限的 payload 只留退避状态：限流条目与普通条目共用一份字节预算，
    // 否则这张表能在 stats() 之外常驻上百 MiB。
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

  // 退避表与普通条目共享总字节上限；淘汰只丢 payload、保留退避状态（连击计数不能因内存压力清零）。
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
