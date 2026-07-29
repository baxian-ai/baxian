import { describe, it, expect } from 'vitest';
import type { PrReviewItem } from '../../src/shared/index.js';
import {
  PrConversationCache,
  prReviewCacheRevision,
  type PrConversationPayload,
} from '../../src/platform/pr-conversation-cache.js';

function convo(label: string, error?: string): PrConversationPayload {
  const items: PrReviewItem[] = [{ kind: 'issue-comment', id: label, body: label }];
  return { items, ...(error ? { error } : {}) };
}

const iso = (ms: number): string => new Date(ms).toISOString();

const stamped = (payload: PrConversationPayload, ms: number): PrConversationPayload =>
  ({ ...payload, fetchedAt: iso(ms) });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function counting(payload: PrConversationPayload) {
  let calls = 0;
  return {
    build: () => {
      calls++;
      return Promise.resolve(payload);
    },
    calls: () => calls,
  };
}

describe('prReviewCacheRevision (server)', () => {
  it('joins the web fields plus prNumber and repoSlug', () => {
    const rev = prReviewCacheRevision(
      {
        reviewRound: 3,
        latestHeadSha: 'abc123',
        status: 'review',
        reviewDispatchedAt: '2026-07-01T10:00:00Z',
        prFeedbackReceivedAt: '2026-07-02T11:00:00Z',
        prNumber: 7,
      },
      'owner/repo',
    );
    expect(rev).toBe('3:abc123:review:2026-07-01T10:00:00Z:2026-07-02T11:00:00Z:7:::owner/repo');
  });

  it('renders absent optional fields as empty slots', () => {
    const rev = prReviewCacheRevision({ reviewRound: 0, status: 'pending' }, 'o/r');
    expect(rev).toBe('0::pending::::::o/r');
  });

  it('changes on every closed-unmerged anchor transition, including re-close after reopen', () => {
    const base = { reviewRound: 1, status: 'review' as const, prNumber: 7 };
    const open = prReviewCacheRevision(base, 'o/r');
    const closed1 = prReviewCacheRevision({ ...base, closedUnmergedAnchor: { prNumber: 7, generation: 1 } }, 'o/r');
    const reopened1 = prReviewCacheRevision({ ...base, closedUnmergedAnchor: { prNumber: 7, generation: 1, cleared: true } }, 'o/r');
    const closed2 = prReviewCacheRevision({ ...base, closedUnmergedAnchor: { prNumber: 7, generation: 2 } }, 'o/r');
    expect(new Set([open, closed1, reopened1, closed2]).size).toBe(4);
  });

  it('changes when only prNumber changes', () => {
    const base = { reviewRound: 1, status: 'review' as const };
    expect(prReviewCacheRevision({ ...base, prNumber: 7 }, 'o/r'))
      .not.toBe(prReviewCacheRevision({ ...base, prNumber: 9 }, 'o/r'));
  });

  it('changes when only repoSlug changes', () => {
    const base = { reviewRound: 1, status: 'review' as const, prNumber: 7 };
    expect(prReviewCacheRevision(base, 'o/r'))
      .not.toBe(prReviewCacheRevision(base, 'o/moved'));
  });
});

describe('PrConversationCache', () => {
  it('serves a same-revision entry without rebuilding, keeping the original fetchedAt', async () => {
    let now = 5_000;
    const cache = new PrConversationCache({ now: () => now });
    const b = counting(convo('a'));
    expect(await cache.get('t1', 'r1', b.build)).toEqual(stamped(convo('a'), 5_000));
    now += 1_000;
    expect(await cache.get('t1', 'r1', b.build)).toEqual(stamped(convo('a'), 5_000));
    expect(b.calls()).toBe(1);
  });

  it('has no TTL: a same-revision entry stays valid across days', async () => {
    let now = 0;
    const cache = new PrConversationCache({ now: () => now });
    const b = counting(convo('a'));
    await cache.get('t1', 'r1', b.build);
    now += 3 * 24 * 60 * 60 * 1000;
    expect(await cache.get('t1', 'r1', b.build)).toEqual(stamped(convo('a'), 0));
    expect(b.calls()).toBe(1);
  });

  it('rebuilds when the revision changes', async () => {
    const cache = new PrConversationCache({ now: () => 0 });
    const b1 = counting(convo('a'));
    const b2 = counting(convo('b'));
    await cache.get('t1', 'r1', b1.build);
    expect(await cache.get('t1', 'r2', b2.build)).toEqual(stamped(convo('b'), 0));
    expect(b2.calls()).toBe(1);
  });

  it('does not cache payloads that carry an error and returns them unstamped', async () => {
    const cache = new PrConversationCache({ now: () => 0 });
    const failing = counting(convo('a', 'reviews: boom'));
    expect(await cache.get('t1', 'r1', failing.build)).toEqual(convo('a', 'reviews: boom'));
    await cache.get('t1', 'r1', failing.build);
    expect(failing.calls()).toBe(2);
  });

  it('shares one in-flight build across same-revision concurrent gets', async () => {
    const cache = new PrConversationCache({ now: () => 0 });
    const d = deferred<PrConversationPayload>();
    let calls = 0;
    const build = () => {
      calls++;
      return d.promise;
    };
    const p1 = cache.get('t1', 'r1', build);
    const p2 = cache.get('t1', 'r1', build);
    d.resolve(convo('a'));
    expect(await p1).toEqual(stamped(convo('a'), 0));
    expect(await p2).toEqual(stamped(convo('a'), 0));
    expect(calls).toBe(1);
  });

  it('does not share an in-flight build across revisions: the newer revision builds itself', async () => {
    const cache = new PrConversationCache({ now: () => 0 });
    const dA = deferred<PrConversationPayload>();
    const dB = deferred<PrConversationPayload>();
    const pA = cache.get('t1', 'rA', () => dA.promise);
    const pB = cache.get('t1', 'rB', () => dB.promise);
    dB.resolve(convo('b'));
    expect(await pB).toEqual(stamped(convo('b'), 0));
    dA.resolve(convo('a'));
    expect(await pA).toEqual(convo('a'));
  });

  it('a superseded build settling late neither overwrites the cache nor clears the successor registration', async () => {
    const cache = new PrConversationCache({ now: () => 0 });
    const dA = deferred<PrConversationPayload>();
    const dB = deferred<PrConversationPayload>();
    const pA = cache.get('t1', 'rA', () => dA.promise);
    const pB = cache.get('t1', 'rB', () => dB.promise);

    dA.resolve(convo('a'));
    await pA;

    let extraCalls = 0;
    const pB2 = cache.get('t1', 'rB', () => {
      extraCalls++;
      return Promise.resolve(convo('x'));
    });
    dB.resolve(convo('b'));
    expect(await pB).toEqual(stamped(convo('b'), 0));
    expect(await pB2).toEqual(stamped(convo('b'), 0));
    expect(extraCalls).toBe(0);

    const after = counting(convo('never'));
    expect(await cache.get('t1', 'rB', after.build)).toEqual(stamped(convo('b'), 0));
    expect(after.calls()).toBe(0);
  });

  it('propagates a rejected build, caches nothing, and recovers on the next get', async () => {
    const cache = new PrConversationCache({ now: () => 0 });
    await expect(
      cache.get('t1', 'r1', () => Promise.reject(new Error('gh exploded'))),
    ).rejects.toThrow('gh exploded');
    const ok = counting(convo('a'));
    expect(await cache.get('t1', 'r1', ok.build)).toEqual(stamped(convo('a'), 0));
    expect(ok.calls()).toBe(1);
  });

  it('does not cache payloads larger than maxPayloadBytes', async () => {
    const cache = new PrConversationCache({ now: () => 0, maxPayloadBytes: 64 });
    const big = counting(convo('x'.repeat(200)));
    await cache.get('t1', 'r1', big.build);
    await cache.get('t1', 'r1', big.build);
    expect(big.calls()).toBe(2);
    expect(cache.stats().entries).toBe(0);
  });

  it('evicts oldest entries by fetchedAt until within the total byte budget', async () => {
    let now = 0;
    const small = convo('s');
    const bytesOf = (p: PrConversationPayload) => Buffer.byteLength(JSON.stringify(p), 'utf8');
    const cache = new PrConversationCache({
      now: () => now,
      maxTotalBytes: bytesOf(small) * 2,
    });
    await cache.get('t1', 'r1', () => Promise.resolve(small));
    now = 1;
    await cache.get('t2', 'r1', () => Promise.resolve(small));
    now = 2;
    await cache.get('t3', 'r1', () => Promise.resolve(small));
    expect(cache.stats().entries).toBe(2);
    const rebuilt = counting(convo('s'));
    now = 3;
    await cache.get('t1', 'r1', rebuilt.build);
    expect(rebuilt.calls()).toBe(1);
  });

  it('evicts the oldest entry beyond maxEntries', async () => {
    let now = 0;
    const cache = new PrConversationCache({ now: () => now, maxEntries: 2 });
    await cache.get('t1', 'r1', () => Promise.resolve(convo('a')));
    now = 1;
    await cache.get('t2', 'r1', () => Promise.resolve(convo('b')));
    now = 2;
    await cache.get('t3', 'r1', () => Promise.resolve(convo('c')));
    expect(cache.stats().entries).toBe(2);
    const rebuilt = counting(convo('a'));
    await cache.get('t1', 'r1', rebuilt.build);
    expect(rebuilt.calls()).toBe(1);
  });
});

describe('PrConversationCache.put', () => {
  it('stores a payload that a same-revision get serves without building', async () => {
    const cache = new PrConversationCache({ now: () => 7_000 });
    cache.put('t1', 'r1', convo('warm'));
    const never = counting(convo('cold'));
    expect(await cache.get('t1', 'r1', never.build)).toEqual(stamped(convo('warm'), 7_000));
    expect(never.calls()).toBe(0);
  });

  it('replaces the previous entry so a revision-bumped get hits the new payload', async () => {
    const cache = new PrConversationCache({ now: () => 0 });
    await cache.get('t1', 'r1', () => Promise.resolve(convo('old')));
    cache.put('t1', 'r2', convo('new'));
    const never = counting(convo('cold'));
    expect(await cache.get('t1', 'r2', never.build)).toEqual(stamped(convo('new'), 0));
    expect(never.calls()).toBe(0);
  });

  it('ignores payloads carrying an error or a rate-limit flag', async () => {
    const cache = new PrConversationCache({ now: () => 0 });
    cache.put('t1', 'r1', convo('bad', 'reviews: boom'));
    cache.put('t1', 'r1', { items: [], rateLimited: true });
    const b = counting(convo('fresh'));
    expect(await cache.get('t1', 'r1', b.build)).toEqual(stamped(convo('fresh'), 0));
    expect(b.calls()).toBe(1);
  });

  it('drops oversize payloads instead of storing them', async () => {
    const cache = new PrConversationCache({ now: () => 0, maxPayloadBytes: 64 });
    cache.put('t1', 'r1', convo('x'.repeat(200)));
    expect(cache.stats().entries).toBe(0);
    const b = counting(convo('a'));
    await cache.get('t1', 'r1', b.build);
    expect(b.calls()).toBe(1);
  });

  it('supersedes an in-flight older-revision force so its late settle cannot clobber the warmed entry', async () => {
    const cache = new PrConversationCache({ now: () => 0 });
    const d = deferred<PrConversationPayload>();
    const pForce = cache.force('t1', 'r1', () => d.promise);
    cache.put('t1', 'r2', convo('warmed'));
    d.resolve(convo('stale-force'));
    expect(await pForce).toEqual(convo('stale-force'));

    const never = counting(convo('cold'));
    expect(await cache.get('t1', 'r2', never.build)).toEqual(stamped(convo('warmed'), 0));
    expect(never.calls()).toBe(0);
    expect(cache.stats().entries).toBe(1);
  });

  it('supersedes an in-flight older-revision get the same way', async () => {
    const cache = new PrConversationCache({ now: () => 0 });
    const d = deferred<PrConversationPayload>();
    const pGet = cache.get('t1', 'r1', () => d.promise);
    cache.put('t1', 'r2', convo('warmed'));
    d.resolve(convo('stale-get'));
    expect(await pGet).toEqual(convo('stale-get'));

    const never = counting(convo('cold'));
    expect(await cache.get('t1', 'r2', never.build)).toEqual(stamped(convo('warmed'), 0));
    expect(never.calls()).toBe(0);
  });

  it('fences a stale-snapshot force registered AFTER put(): its settle cannot clobber the warmed entry', async () => {
    const cache = new PrConversationCache({ now: () => 0 });
    cache.put('t1', 'r2', convo('warmed'), '2026-07-29T08:00:00.000Z');
    const d = deferred<PrConversationPayload>();
    const pForce = cache.force('t1', 'r1', () => d.promise, '2026-07-29T07:00:00.000Z');
    d.resolve(convo('stale-force'));
    expect(await pForce).toEqual(stamped(convo('stale-force'), 0));

    const never = counting(convo('cold'));
    expect(await cache.get('t1', 'r2', never.build, '2026-07-29T08:00:00.000Z'))
      .toEqual(stamped(convo('warmed'), 0));
    expect(never.calls()).toBe(0);
    expect(cache.stats().entries).toBe(1);
  });

  it('fences a post-put stale get the same way, including an empty legacy conversation time', async () => {
    const cache = new PrConversationCache({ now: () => 0 });
    cache.put('t1', 'r2', convo('warmed'), '2026-07-29T08:00:00.000Z');
    const d = deferred<PrConversationPayload>();
    const pGet = cache.get('t1', 'r1', () => d.promise, '');
    d.resolve(convo('stale-get'));
    expect(await pGet).toEqual(stamped(convo('stale-get'), 0));

    const never = counting(convo('cold'));
    expect(await cache.get('t1', 'r2', never.build, '2026-07-29T08:00:00.000Z'))
      .toEqual(stamped(convo('warmed'), 0));
    expect(never.calls()).toBe(0);
  });

  it('the floor is not a lock: a revision advance carrying an equal conversation time still stores', async () => {
    const cache = new PrConversationCache({ now: () => 0 });
    cache.put('t1', 'r2', convo('warmed'), '2026-07-29T08:00:00.000Z');
    const advanced = counting(convo('advanced'));
    await cache.get('t1', 'r3-after-push', advanced.build, '2026-07-29T08:00:00.000Z');
    expect(advanced.calls()).toBe(1);

    const never = counting(convo('cold'));
    expect(await cache.get('t1', 'r3-after-push', never.build, '2026-07-29T08:00:00.000Z'))
      .toEqual(stamped(convo('advanced'), 0));
    expect(never.calls()).toBe(0);
  });

  it('a newer put refreshes the floor rather than leaving the first one pinned', async () => {
    const cache = new PrConversationCache({ now: () => 0 });
    cache.put('t1', 'r2', convo('warm-2'), '2026-07-29T08:00:00.000Z');
    cache.put('t1', 'r3', convo('warm-3'), '2026-07-29T09:00:00.000Z');
    const between = counting(convo('between'));
    const result = await cache.force('t1', 'r2b', between.build, '2026-07-29T08:30:00.000Z');
    expect(result).toEqual(stamped(convo('between'), 0));
    const never = counting(convo('cold'));
    await cache.get('t1', 'r2b', never.build, '2026-07-29T08:30:00.000Z');
    expect(never.calls()).toBe(1);
  });

  it('clears an active rate-limit backoff for the key', async () => {
    let now = 0;
    const cache = new PrConversationCache({ now: () => now });
    await cache.get('t1', 'r1', async () => ({ items: [], error: 'rate limited', rateLimited: true }));
    now = 1_000;
    cache.put('t1', 'r1', convo('warm'));
    const never = counting(convo('cold'));
    expect(await cache.get('t1', 'r1', never.build)).toEqual(stamped(convo('warm'), 1_000));
    expect(never.calls()).toBe(0);
  });
});

describe('PrConversationCache.force', () => {
  it('rebuilds even when a same-revision entry exists, and stores the result', async () => {
    let now = 0;
    const cache = new PrConversationCache({ now: () => now });
    await cache.get('t1', 'r1', () => Promise.resolve(convo('stale')));
    now = 9_000;
    const b = counting(convo('fresh'));
    expect(await cache.force('t1', 'r1', b.build)).toEqual(stamped(convo('fresh'), 9_000));
    expect(b.calls()).toBe(1);
    const never = counting(convo('cold'));
    expect(await cache.get('t1', 'r1', never.build)).toEqual(stamped(convo('fresh'), 9_000));
    expect(never.calls()).toBe(0);
  });

  it('returns the throttled payload during a rate-limit backoff window without building', async () => {
    let now = 0;
    const cache = new PrConversationCache({ now: () => now });
    await cache.get('t1', 'r1', async () => ({ items: [], error: 'rate limited', rateLimited: true }));
    now = 30_000;
    const never = counting(convo('cold'));
    const result = await cache.force('t1', 'r1', never.build);
    expect(result.rateLimited).toBe(true);
    expect(never.calls()).toBe(0);
  });

  it('shares an in-flight same-revision build instead of stacking a second fetch', async () => {
    const cache = new PrConversationCache({ now: () => 0 });
    const d = deferred<PrConversationPayload>();
    let calls = 0;
    const build = () => {
      calls++;
      return d.promise;
    };
    const p1 = cache.get('t1', 'r1', build);
    const p2 = cache.force('t1', 'r1', build);
    d.resolve(convo('a'));
    expect(await p1).toEqual(stamped(convo('a'), 0));
    expect(await p2).toEqual(stamped(convo('a'), 0));
    expect(calls).toBe(1);
  });
});

describe('PrConversationCache rate-limit backoff', () => {
  it('serves a rate-limited payload from the backoff window instead of rebuilding', async () => {
    let now = 1_000;
    const cache = new PrConversationCache({ now: () => now });
    let builds = 0;
    const build = async () => {
      builds += 1;
      return { items: [], error: 'issue-comments: rate limited', rateLimited: true };
    };
    await cache.get('task-1', 'rev-1', build);
    await cache.get('task-1', 'rev-1', build);
    await cache.get('task-1', 'rev-2', build);
    expect(builds).toBe(1);

    now += 61_000;
    await cache.get('task-1', 'rev-1', build);
    expect(builds).toBe(2);
  });

  it('never serves another revision the throttled payload of the previous PR', async () => {
    const now = 1_000;
    const cache = new PrConversationCache({ now: () => now });
    let builds = 0;
    const build = async () => {
      builds += 1;
      return { items: [{ kind: 'issue-comment' as const, id: 'from-pr-a' }], error: 'rate limited', rateLimited: true };
    };
    await cache.get('task-1', 'revision-pr-a', build);
    const other = await cache.get('task-1', 'revision-pr-b', build);
    expect(builds).toBe(1);
    expect(other.rateLimited).toBe(true);
    expect(other.items).toEqual([]);
  });

  it('grows the shared backoff exponentially while the platform keeps throttling', async () => {
    let now = 0;
    const cache = new PrConversationCache({ now: () => now });
    let builds = 0;
    const build = async () => {
      builds += 1;
      return { items: [], error: 'rate limited', rateLimited: true };
    };
    await cache.get('t', 'r', build);
    now = 61_000;
    await cache.get('t', 'r', build);
    now = 122_000;
    await cache.get('t', 'r', build);
    expect(builds).toBe(2);
    now = 182_000;
    await cache.get('t', 'r', build);
    expect(builds).toBe(3);
  });

  it('caps the shared backoff so a long throttle cannot lock the endpoint for hours', async () => {
    let now = 0;
    const cache = new PrConversationCache({ now: () => now });
    let builds = 0;
    const build = async () => {
      builds += 1;
      return { items: [], error: 'rate limited', rateLimited: true };
    };
    for (let i = 0; i < 8; i++) {
      await cache.get('t', 'r', build);
      now += 16 * 60_000;
    }
    const before = builds;
    now += 15 * 60_000 + 1_000;
    await cache.get('t', 'r', build);
    expect(builds).toBe(before + 1);
  });

  it('counts throttled payloads against the shared byte budget', async () => {
    const big = 'b'.repeat(400 * 1024);
    const cache = new PrConversationCache({ maxPayloadBytes: 64 * 1024, maxTotalBytes: 256 * 1024 });
    for (const id of ['t1', 't2', 't3']) {
      await cache.get(id, 'r', async () => ({
        items: [{ kind: 'issue-comment' as const, id, body: big }],
        error: 'rate limited',
        rateLimited: true,
      }));
    }
    expect(cache.stats().totalBytes).toBeLessThanOrEqual(256 * 1024);
  });

  it('sweeps expired backoff entries instead of holding their payloads forever', async () => {
    let now = 0;
    const cache = new PrConversationCache({ now: () => now, maxEntries: 2 });
    const throttle = async () => ({ items: [], error: 'rate limited', rateLimited: true });
    for (const id of ['t1', 't2', 't3', 't4']) await cache.get(id, 'r', throttle);
    now = 10 * 60_000;
    await cache.get('t5', 'r', async () => ({ items: [] }));
    const internals = cache as unknown as { rateLimited: Map<string, unknown> };
    expect(internals.rateLimited.size).toBeLessThanOrEqual(2);
  });
});
