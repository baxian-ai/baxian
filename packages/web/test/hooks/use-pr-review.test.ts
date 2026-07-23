import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode, createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor, cleanup } from '@testing-library/react';
import type { PrReviewConversation } from '../../src/shared/index.js';

vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());

import { api } from '../../src/api.ts';
import { usePrReview } from '../../src/hooks/use-pr-review.ts';

const ghMock = vi.mocked(api.tasks.prReview);

function convo(items: number): PrReviewConversation {
  return {
    available: true,
    items: Array.from({ length: items }, (_, i) => ({ kind: 'issue-comment' as const, id: `c${i}` })),
  };
}

beforeEach(() => { ghMock.mockReset(); });
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
