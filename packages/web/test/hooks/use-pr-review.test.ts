import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode, createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor, cleanup } from '@testing-library/react';
import type { PrReviewConversation } from '../../src/shared/index.js';

vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());

import { api } from '../../src/api.ts';
import { usePrReview } from '../../src/hooks/use-pr-review.ts';

const ghMock = vi.mocked(api.tasks.prReview);
const refreshMock = vi.mocked(api.tasks.prReviewRefresh);

function convo(items: number): PrReviewConversation {
  return {
    available: true,
    items: Array.from({ length: items }, (_, i) => ({ kind: 'issue-comment' as const, id: `c${i}` })),
  };
}

beforeEach(() => { ghMock.mockReset(); refreshMock.mockReset(); });
afterEach(() => cleanup());

describe('usePrReview', () => {
  it('fetches on mount and exposes the conversation', async () => {
    ghMock.mockResolvedValueOnce(convo(1));
    const { result } = renderHook(({ id, rev }) => usePrReview(id, rev), {
      initialProps: { id: 'task-a', rev: '1' },
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.data?.items).toHaveLength(1);
    expect(ghMock).toHaveBeenCalledWith('task-a');
  });

  it('keeps old data visible while refetching on a same-task revision bump', async () => {
    ghMock.mockResolvedValueOnce(convo(1));
    const { result, rerender } = renderHook(({ id, rev }) => usePrReview(id, rev), {
      initialProps: { id: 'task-a', rev: '1' },
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));

    let resolve2: (v: PrReviewConversation) => void = () => {};
    ghMock.mockReturnValueOnce(new Promise<PrReviewConversation>((r) => { resolve2 = r; }));
    rerender({ id: 'task-a', rev: '2' });

    expect(result.current.loaded).toBe(true);
    expect(result.current.data?.items).toHaveLength(1);

    resolve2(convo(3));
    await waitFor(() => expect(result.current.data?.items).toHaveLength(3));
  });

  it('drops to loading when taskId changes so stale data never shows', async () => {
    ghMock.mockResolvedValueOnce(convo(1));
    const { result, rerender } = renderHook(({ id, rev }) => usePrReview(id, rev), {
      initialProps: { id: 'task-a', rev: '1' },
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));

    let resolveB: (v: PrReviewConversation) => void = () => {};
    ghMock.mockReturnValueOnce(new Promise<PrReviewConversation>((r) => { resolveB = r; }));
    rerender({ id: 'task-b', rev: '1' });

    await waitFor(() => expect(result.current.loaded).toBe(false));
    expect(result.current.data).toBeNull();

    resolveB(convo(2));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.data?.items).toHaveLength(2);
  });

  it('refetches on the first revision arrival even after a successful undefined-revision load', async () => {
    ghMock.mockResolvedValueOnce(convo(1)).mockResolvedValueOnce(convo(3));
    const { result, rerender } = renderHook(({ id, rev }) => usePrReview(id, rev), {
      initialProps: { id: 'task-a', rev: undefined as string | undefined },
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(ghMock).toHaveBeenCalledTimes(1);
    rerender({ id: 'task-a', rev: '1:sha:review:7' });
    await waitFor(() => expect(result.current.data?.items).toHaveLength(3));
    expect(ghMock).toHaveBeenCalledTimes(2);
  });

  it('drops a late undefined-revision response arriving after the revision-keyed refetch', async () => {
    let resolveFirst: (v: PrReviewConversation) => void = () => {};
    ghMock
      .mockReturnValueOnce(new Promise<PrReviewConversation>((r) => { resolveFirst = r; }))
      .mockResolvedValueOnce(convo(3));
    const { result, rerender } = renderHook(({ id, rev }) => usePrReview(id, rev), {
      initialProps: { id: 'task-a', rev: undefined as string | undefined },
    });
    rerender({ id: 'task-a', rev: '1:sha:review:9' });
    await waitFor(() => expect(result.current.data?.items).toHaveLength(3));

    resolveFirst(convo(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.data?.items).toHaveLength(3);
    expect(ghMock).toHaveBeenCalledTimes(2);
  });

  it('refetches when the first result was unavailable and revision then resolves (no stale no-pr)', async () => {
    ghMock
      .mockResolvedValueOnce({ available: false, reason: 'no-pr', items: [] } as PrReviewConversation)
      .mockResolvedValueOnce(convo(1));
    const { result, rerender } = renderHook(({ id, rev }) => usePrReview(id, rev), {
      initialProps: { id: 'task-a', rev: undefined as string | undefined },
    });
    await waitFor(() => expect(result.current.data?.available).toBe(false));
    rerender({ id: 'task-a', rev: '1:sha:review' });
    await waitFor(() => expect(result.current.data?.available).toBe(true));
    expect(ghMock).toHaveBeenCalledTimes(2);
    expect(result.current.data?.items).toHaveLength(1);
  });

  it('refetches when the first result was available but errored (degraded), then revision resolves', async () => {
    ghMock
      .mockResolvedValueOnce({ available: true, error: 'reviews: gh: not found', items: [] } as PrReviewConversation)
      .mockResolvedValueOnce(convo(1));
    const { result, rerender } = renderHook(({ id, rev }) => usePrReview(id, rev), {
      initialProps: { id: 'task-a', rev: undefined as string | undefined },
    });
    await waitFor(() => expect(result.current.data?.error).toBe('reviews: gh: not found'));
    rerender({ id: 'task-a', rev: '1:sha:review' });
    await waitFor(() => expect(result.current.data?.error).toBeUndefined());
    expect(ghMock).toHaveBeenCalledTimes(2);
    expect(result.current.data?.items).toHaveLength(1);
  });

  it('loads under React StrictMode (mount→unmount→remount does not strand it loading)', async () => {
    ghMock.mockResolvedValue(convo(2));
    const { result } = renderHook(() => usePrReview('task-a', '1'), {
      wrapper: ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children),
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.data?.items).toHaveLength(2);
  });

  it('exposes an error when the fetch rejects', async () => {
    ghMock.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(({ id, rev }) => usePrReview(id, rev), {
      initialProps: { id: 'task-a', rev: '1' },
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.error).toBe('boom');
    expect(result.current.data).toBeNull();
  });

  it('refresh() posts the force endpoint and replaces the data', async () => {
    ghMock.mockResolvedValueOnce(convo(1));
    refreshMock.mockResolvedValueOnce({ ...convo(3), fetchedAt: '2026-07-29T00:00:00.000Z' });
    const { result } = renderHook(() => usePrReview('task-a', '1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.refresh());
    expect(result.current.refreshing).toBe(true);
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    expect(refreshMock).toHaveBeenCalledWith('task-a');
    expect(result.current.data?.items).toHaveLength(3);
    expect(result.current.data?.fetchedAt).toBe('2026-07-29T00:00:00.000Z');
    expect(result.current.refreshError).toBeNull();
  });

  it('a failed refresh keeps the current data and surfaces refreshError', async () => {
    ghMock.mockResolvedValueOnce(convo(2));
    refreshMock.mockRejectedValueOnce(new Error('rate limited'));
    const { result } = renderHook(() => usePrReview('task-a', '1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    expect(result.current.refreshError).toBe('rate limited');
    expect(result.current.data?.items).toHaveLength(2);
    expect(result.current.error).toBeNull();
  });

  it('a refresh resolving 200 with an errored payload keeps the data instead of clearing it', async () => {
    ghMock.mockResolvedValueOnce(convo(3));
    refreshMock.mockResolvedValue({
      available: true, items: [], error: 'issue-comments: HTTP 429', rateLimited: true,
    } as PrReviewConversation);
    const { result } = renderHook(() => usePrReview('task-a', '1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    expect(result.current.data?.items).toHaveLength(3);
    expect(result.current.refreshError).toBe('issue-comments: HTTP 429');
    expect(result.current.error).toBeNull();
  });

  it('a refresh resolving with a partial-failure payload (error, no rateLimited) is not applied either', async () => {
    ghMock.mockResolvedValueOnce(convo(2));
    refreshMock.mockResolvedValue({
      available: true,
      items: [{ kind: 'issue-comment' as const, id: 'partial' }],
      error: 'reviews: HTTP 500',
    } as PrReviewConversation);
    const { result } = renderHook(() => usePrReview('task-a', '1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    expect(result.current.data?.items).toHaveLength(2);
    expect(result.current.refreshError).toBe('reviews: HTTP 500');
  });

  it('a rate-limited refresh payload without error text falls back to a generic message', async () => {
    ghMock.mockResolvedValueOnce(convo(1));
    refreshMock.mockResolvedValue({ available: true, items: [], rateLimited: true } as PrReviewConversation);
    const { result } = renderHook(() => usePrReview('task-a', '1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    expect(result.current.data?.items).toHaveLength(1);
    expect(result.current.refreshError).toBe('rate limited');
  });

  it('a refresh result outlives an in-flight revision GET racing it', async () => {
    ghMock.mockResolvedValueOnce(convo(1));
    const { result, rerender } = renderHook(({ rev }) => usePrReview('task-a', rev), {
      initialProps: { rev: '1' },
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));

    let resolveStale: (v: PrReviewConversation) => void = () => {};
    ghMock.mockReturnValueOnce(new Promise<PrReviewConversation>((r) => { resolveStale = r; }));
    rerender({ rev: '2' });

    refreshMock.mockResolvedValueOnce(convo(5));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.data?.items).toHaveLength(5));

    resolveStale(convo(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.data?.items).toHaveLength(5);
  });

  it('ignores double-clicks while a refresh is already in flight', async () => {
    ghMock.mockResolvedValueOnce(convo(1));
    let resolveRefresh: (v: PrReviewConversation) => void = () => {};
    refreshMock.mockReturnValueOnce(new Promise<PrReviewConversation>((r) => { resolveRefresh = r; }));
    const { result } = renderHook(() => usePrReview('task-a', '1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.refresh());
    act(() => result.current.refresh());
    expect(refreshMock).toHaveBeenCalledTimes(1);
    resolveRefresh(convo(2));
    await waitFor(() => expect(result.current.refreshing).toBe(false));
  });

  it('drops a stale refresh that started before a revision bump and lands after the new GET began', async () => {
    ghMock.mockResolvedValueOnce(convo(1));
    const { result, rerender } = renderHook(({ rev }) => usePrReview('task-a', rev), {
      initialProps: { rev: '1' },
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));

    let resolveOldRefresh: (v: PrReviewConversation) => void = () => {};
    refreshMock.mockReturnValueOnce(new Promise<PrReviewConversation>((r) => { resolveOldRefresh = r; }));
    act(() => result.current.refresh());

    let resolveRev2Get: (v: PrReviewConversation) => void = () => {};
    ghMock.mockReturnValueOnce(new Promise<PrReviewConversation>((r) => { resolveRev2Get = r; }));
    rerender({ rev: '2' });

    resolveOldRefresh(convo(9));
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    expect(result.current.data?.items).toHaveLength(1);

    resolveRev2Get(convo(3));
    await waitFor(() => expect(result.current.data?.items).toHaveLength(3));
  });

  it('switching tasks voids the old refresh lock; A settling cannot unlock or pollute B', async () => {
    ghMock.mockResolvedValueOnce(convo(1));
    let resolveA: (v: PrReviewConversation) => void = () => {};
    refreshMock.mockReturnValueOnce(new Promise<PrReviewConversation>((r) => { resolveA = r; }));
    const { result, rerender } = renderHook(({ id }) => usePrReview(id, '1'), {
      initialProps: { id: 'task-a' },
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.refresh());
    expect(result.current.refreshing).toBe(true);

    ghMock.mockResolvedValueOnce(convo(2));
    rerender({ id: 'task-b' });
    expect(result.current.refreshing).toBe(false);
    await waitFor(() => expect(result.current.data?.items).toHaveLength(2));

    let resolveB: (v: PrReviewConversation) => void = () => {};
    refreshMock.mockReturnValueOnce(new Promise<PrReviewConversation>((r) => { resolveB = r; }));
    act(() => result.current.refresh());
    expect(result.current.refreshing).toBe(true);

    resolveA(convo(9));
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.refreshing).toBe(true);
    expect(result.current.data?.items).toHaveLength(2);

    resolveB(convo(5));
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    expect(result.current.data?.items).toHaveLength(5);
  });

  it('a revision bump also frees the refresh lock so the new context can refresh at once', async () => {
    ghMock.mockResolvedValueOnce(convo(1));
    let resolveOld: (v: PrReviewConversation) => void = () => {};
    refreshMock.mockReturnValueOnce(new Promise<PrReviewConversation>((r) => { resolveOld = r; }));
    const { result, rerender } = renderHook(({ rev }) => usePrReview('task-a', rev), {
      initialProps: { rev: '1' },
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.refresh());
    expect(result.current.refreshing).toBe(true);

    ghMock.mockResolvedValueOnce(convo(2));
    rerender({ rev: '2' });
    expect(result.current.refreshing).toBe(false);
    await waitFor(() => expect(result.current.data?.items).toHaveLength(2));

    refreshMock.mockResolvedValueOnce(convo(6));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.data?.items).toHaveLength(6));

    resolveOld(convo(9));
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.data?.items).toHaveLength(6);
    expect(result.current.refreshing).toBe(false);
  });

  it('drops a refresh response that lands after switching to another task', async () => {
    ghMock.mockResolvedValueOnce(convo(1));
    let resolveRefresh: (v: PrReviewConversation) => void = () => {};
    refreshMock.mockReturnValueOnce(new Promise<PrReviewConversation>((r) => { resolveRefresh = r; }));
    const { result, rerender } = renderHook(({ id }) => usePrReview(id, '1'), {
      initialProps: { id: 'task-a' },
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.refresh());

    ghMock.mockResolvedValueOnce(convo(2));
    rerender({ id: 'task-b' });
    await waitFor(() => expect(result.current.data?.items).toHaveLength(2));

    resolveRefresh(convo(9));
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.data?.items).toHaveLength(2);
  });
});

it('a successful force refresh cancels the queued partial retry so it cannot clobber fresh data', async () => {
  vi.useFakeTimers();
  try {
    ghMock.mockResolvedValue({ available: true, items: [], error: 'reviews: HTTP 500' } as PrReviewConversation);
    refreshMock.mockResolvedValueOnce(convo(4));
    const { result } = renderHook(() => usePrReview('task-c', 'rev-1'));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.data?.error).toBe('reviews: HTTP 500');
    expect(ghMock).toHaveBeenCalledTimes(1);

    act(() => result.current.refresh());
    await act(async () => { await Promise.resolve(); });
    expect(result.current.data?.items).toHaveLength(4);
    expect(result.current.data?.error).toBeUndefined();

    await act(async () => { vi.advanceTimersByTime(60_000); await Promise.resolve(); });
    expect(ghMock).toHaveBeenCalledTimes(1);
    expect(result.current.data?.items).toHaveLength(4);
    expect(result.current.data?.error).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it('an errored force refresh keeps the queued retry alive so the GET can still recover', async () => {
  vi.useFakeTimers();
  try {
    ghMock
      .mockResolvedValueOnce({ available: true, items: [], error: 'reviews: HTTP 500' } as PrReviewConversation)
      .mockResolvedValueOnce(convo(2));
    refreshMock.mockResolvedValueOnce({
      available: true, items: [], error: 'issue-comments: HTTP 429', rateLimited: true,
    } as PrReviewConversation);
    const { result } = renderHook(() => usePrReview('task-c2', 'rev-1'));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.data?.error).toBe('reviews: HTTP 500');

    act(() => result.current.refresh());
    await act(async () => { await Promise.resolve(); });
    expect(result.current.refreshError).toBe('issue-comments: HTTP 429');

    await act(async () => { vi.advanceTimersByTime(4_000); await Promise.resolve(); });
    expect(ghMock).toHaveBeenCalledTimes(2);
    expect(result.current.data?.items).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});

it('retries a partial-failure response with bounded backoff until the sources recover', async () => {
  vi.useFakeTimers();
  try {
    ghMock
      .mockResolvedValueOnce({ available: true, items: [], error: 'reviews: HTTP 500' } as PrReviewConversation)
      .mockResolvedValueOnce({ available: true, items: [{ kind: 'issue-comment', id: 'c1', body: 'ok' }] } as PrReviewConversation);
    const { result } = renderHook(() => usePrReview('task-r', 'rev-1'));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.data?.error).toBe('reviews: HTTP 500');

    await act(async () => { vi.advanceTimersByTime(4000); await Promise.resolve(); });
    expect(ghMock).toHaveBeenCalledTimes(2);
    expect(result.current.data?.error).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it('stops retrying a persistent partial failure after three attempts', async () => {
  vi.useFakeTimers();
  try {
    ghMock.mockResolvedValue({ available: true, items: [], error: 'reviews: HTTP 500' } as PrReviewConversation);
    renderHook(() => usePrReview('task-r2', 'rev-1'));
    await act(async () => { await Promise.resolve(); });
    for (let i = 0; i < 5; i++) {
      await act(async () => { vi.advanceTimersByTime(20000); await Promise.resolve(); });
    }
    expect(ghMock).toHaveBeenCalledTimes(4);
  } finally {
    vi.useRealTimers();
  }
});

it('retries a rate-limited response only after the platform-compliant delay', async () => {
  vi.useFakeTimers();
  try {
    ghMock
      .mockResolvedValueOnce({ available: true, items: [], error: 'issue-comments: HTTP 429', rateLimited: true } as PrReviewConversation)
      .mockResolvedValueOnce({ available: true, items: [{ kind: 'issue-comment', id: 'c1', body: 'ok' }] } as PrReviewConversation);
    const { result } = renderHook(() => usePrReview('task-rl', 'rev-1'));
    await act(async () => { await Promise.resolve(); });

    await act(async () => { vi.advanceTimersByTime(30000); await Promise.resolve(); });
    expect(ghMock).toHaveBeenCalledTimes(1);

    await act(async () => { vi.advanceTimersByTime(31000); await Promise.resolve(); });
    expect(ghMock).toHaveBeenCalledTimes(2);
    expect(result.current.data?.error).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it('gives a newly selected task its own retry budget even at the same revision', async () => {
  vi.useFakeTimers();
  try {
    ghMock.mockResolvedValue({ available: true, items: [], error: 'reviews: HTTP 500' } as PrReviewConversation);
    const { rerender } = renderHook(({ id }) => usePrReview(id, 'same-rev'), {
      initialProps: { id: 'task-a' },
    });
    await act(async () => { await Promise.resolve(); });
    for (let i = 0; i < 4; i++) {
      await act(async () => { vi.advanceTimersByTime(20000); await Promise.resolve(); });
    }
    const afterA = ghMock.mock.calls.length;

    rerender({ id: 'task-b' });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(20000); await Promise.resolve(); });
    expect(ghMock.mock.calls.length).toBeGreaterThan(afterA + 1);
  } finally {
    vi.useRealTimers();
  }
});

it('resets the retry budget when a new revision starts a fresh recovery cycle', async () => {
  vi.useFakeTimers();
  try {
    ghMock.mockResolvedValue({ available: true, items: [], error: 'reviews: HTTP 500' } as PrReviewConversation);
    const { rerender } = renderHook(({ rev }) => usePrReview('task-budget', rev), {
      initialProps: { rev: 'rev-1' },
    });
    await act(async () => { await Promise.resolve(); });
    for (let i = 0; i < 4; i++) {
      await act(async () => { vi.advanceTimersByTime(20000); await Promise.resolve(); });
    }
    const afterExhaustion = ghMock.mock.calls.length;
    expect(afterExhaustion).toBe(4);

    rerender({ rev: 'rev-2' });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(20000); await Promise.resolve(); });
    expect(ghMock.mock.calls.length).toBeGreaterThan(afterExhaustion + 1);
  } finally {
    vi.useRealTimers();
  }
});

it('grows the rate-limit wait exponentially while the platform keeps throttling', async () => {
  vi.useFakeTimers();
  try {
    ghMock.mockResolvedValue({ available: true, items: [], error: 'HTTP 429', rateLimited: true } as PrReviewConversation);
    renderHook(() => usePrReview('task-exp', 'rev-1'));
    await act(async () => { await Promise.resolve(); });

    await act(async () => { vi.advanceTimersByTime(60_000); await Promise.resolve(); });
    expect(ghMock).toHaveBeenCalledTimes(2);

    await act(async () => { vi.advanceTimersByTime(119_000); await Promise.resolve(); });
    expect(ghMock).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(2_000); await Promise.resolve(); });
    expect(ghMock).toHaveBeenCalledTimes(3);

    await act(async () => { vi.advanceTimersByTime(239_000); await Promise.resolve(); });
    expect(ghMock).toHaveBeenCalledTimes(3);
    await act(async () => { vi.advanceTimersByTime(2_000); await Promise.resolve(); });
    expect(ghMock).toHaveBeenCalledTimes(4);
  } finally {
    vi.useRealTimers();
  }
});
