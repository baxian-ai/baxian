import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import type { ReviewRound } from '../../src/shared/index.js';

vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());

import { api } from '../../src/api.ts';
import { useReviewRounds } from '../../src/hooks/use-review-rounds.ts';

const reviewsMock = vi.mocked(api.tasks.reviews);

function round(n: number, content: string): ReviewRound {
  return { round: n, phase: 'code', content, startedAt: 'now' };
}

beforeEach(() => { reviewsMock.mockReset(); });
afterEach(() => cleanup());

describe('useReviewRounds', () => {
  it('fetches on mount and exposes rounds', async () => {
    reviewsMock.mockResolvedValueOnce([round(1, 'a')]);
    const { result } = renderHook(({ id, rev }) => useReviewRounds(id, rev), {
      initialProps: { id: 'task-a', rev: '1' },
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.rounds).toHaveLength(1);
    expect(reviewsMock).toHaveBeenCalledWith('task-a');
  });

  it('keeps old rounds visible while refetching on a same-task revision bump', async () => {
    reviewsMock.mockResolvedValueOnce([round(1, 'a')]);
    const { result, rerender } = renderHook(({ id, rev }) => useReviewRounds(id, rev), {
      initialProps: { id: 'task-a', rev: '1' },
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));

    let resolve2: (v: ReviewRound[]) => void = () => {};
    reviewsMock.mockReturnValueOnce(new Promise<ReviewRound[]>((r) => { resolve2 = r; }));
    rerender({ id: 'task-a', rev: '2' });

    expect(result.current.loaded).toBe(true);
    expect(result.current.rounds).toHaveLength(1);

    resolve2([round(1, 'a'), round(2, 'b')]);
    await waitFor(() => expect(result.current.rounds).toHaveLength(2));
  });

  it('drops to a loading state when taskId changes so stale rounds never show', async () => {
    reviewsMock.mockResolvedValueOnce([round(1, 'a')]);
    const { result, rerender } = renderHook(({ id, rev }) => useReviewRounds(id, rev), {
      initialProps: { id: 'task-a', rev: '1' },
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.rounds).toHaveLength(1);

    let resolveB: (v: ReviewRound[]) => void = () => {};
    reviewsMock.mockReturnValueOnce(new Promise<ReviewRound[]>((r) => { resolveB = r; }));
    rerender({ id: 'task-b', rev: '1' });

    await waitFor(() => expect(result.current.loaded).toBe(false));
    expect(result.current.rounds).toBeNull();

    resolveB([round(1, 'b')]);
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.rounds?.[0].content).toBe('b');
  });
});
