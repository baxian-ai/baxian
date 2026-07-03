import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode, createElement, type ReactNode } from 'react';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import type { GithubReviewConversation } from '../../src/shared/index.js';

vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());

import { api } from '../../src/api.ts';
import { useGithubReview } from '../../src/hooks/use-github-review.ts';

const ghMock = vi.mocked(api.tasks.githubReview);

function convo(items: number): GithubReviewConversation {
  return {
    available: true,
    items: Array.from({ length: items }, (_, i) => ({ kind: 'commit' as const, id: `c${i}` })),
  };
}

beforeEach(() => { ghMock.mockReset(); });
afterEach(() => cleanup());

describe('useGithubReview', () => {
  it('fetches on mount and exposes the conversation', async () => {
    ghMock.mockResolvedValueOnce(convo(1));
    const { result } = renderHook(({ id, rev }) => useGithubReview(id, rev), {
      initialProps: { id: 'task-a', rev: '1' },
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.data?.items).toHaveLength(1);
    expect(ghMock).toHaveBeenCalledWith('task-a');
  });

  it('keeps old data visible while refetching on a same-task revision bump', async () => {
    ghMock.mockResolvedValueOnce(convo(1));
    const { result, rerender } = renderHook(({ id, rev }) => useGithubReview(id, rev), {
      initialProps: { id: 'task-a', rev: '1' },
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));

    let resolve2: (v: GithubReviewConversation) => void = () => {};
    ghMock.mockReturnValueOnce(new Promise<GithubReviewConversation>((r) => { resolve2 = r; }));
    rerender({ id: 'task-a', rev: '2' });

    expect(result.current.loaded).toBe(true);
    expect(result.current.data?.items).toHaveLength(1);

    resolve2(convo(3));
    await waitFor(() => expect(result.current.data?.items).toHaveLength(3));
  });

  it('drops to loading when taskId changes so stale data never shows', async () => {
    ghMock.mockResolvedValueOnce(convo(1));
    const { result, rerender } = renderHook(({ id, rev }) => useGithubReview(id, rev), {
      initialProps: { id: 'task-a', rev: '1' },
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));

    let resolveB: (v: GithubReviewConversation) => void = () => {};
    ghMock.mockReturnValueOnce(new Promise<GithubReviewConversation>((r) => { resolveB = r; }));
    rerender({ id: 'task-b', rev: '1' });

    await waitFor(() => expect(result.current.loaded).toBe(false));
    expect(result.current.data).toBeNull();

    resolveB(convo(2));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.data?.items).toHaveLength(2);
  });

  it('skips the duplicate refetch once an available result has loaded (undefined→value)', async () => {
    ghMock.mockResolvedValue(convo(1));
    const { result, rerender } = renderHook(({ id, rev }) => useGithubReview(id, rev), {
      initialProps: { id: 'task-a', rev: undefined as string | undefined },
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(ghMock).toHaveBeenCalledTimes(1);
    rerender({ id: 'task-a', rev: '1:sha:review' });
    await Promise.resolve();
    expect(ghMock).toHaveBeenCalledTimes(1);
    expect(result.current.data?.items).toHaveLength(1);
  });

  it('refetches when the first result was unavailable and revision then resolves (no stale no-pr)', async () => {
    ghMock
      .mockResolvedValueOnce({ available: false, reason: 'no-pr', items: [] } as GithubReviewConversation)
      .mockResolvedValueOnce(convo(1));
    const { result, rerender } = renderHook(({ id, rev }) => useGithubReview(id, rev), {
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
      .mockResolvedValueOnce({ available: true, error: 'reviews: gh: not found', items: [] } as GithubReviewConversation)
      .mockResolvedValueOnce(convo(1));
    const { result, rerender } = renderHook(({ id, rev }) => useGithubReview(id, rev), {
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
    const { result } = renderHook(() => useGithubReview('task-a', '1'), {
      wrapper: ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children),
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.data?.items).toHaveLength(2);
  });

  it('exposes an error when the fetch rejects', async () => {
    ghMock.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(({ id, rev }) => useGithubReview(id, rev), {
      initialProps: { id: 'task-a', rev: '1' },
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.error).toBe('boom');
    expect(result.current.data).toBeNull();
  });
});
