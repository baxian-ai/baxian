import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';

vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());

import { api, ApiError } from '../../src/api.ts';
import { useInterdiff } from '../../src/hooks/use-interdiff.ts';

const interdiffMock = vi.mocked(api.tasks.interdiff);

beforeEach(() => { interdiffMock.mockReset(); });
afterEach(() => cleanup());

describe('useInterdiff', () => {
  it('stays idle and never fetches when disabled', () => {
    const { result } = renderHook(({ e }) => useInterdiff('task-a', 2, e), { initialProps: { e: false } });
    expect(result.current.status).toBe('idle');
    expect(interdiffMock).not.toHaveBeenCalled();
  });

  it('loads then resolves to ready with the diff', async () => {
    interdiffMock.mockResolvedValueOnce({ diff: 'PATCH' });
    const { result } = renderHook(() => useInterdiff('task-a', 2, true));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current).toEqual({ status: 'ready', diff: 'PATCH' });
    expect(interdiffMock).toHaveBeenCalledWith('task-a', 2);
  });

  it('maps 404 → historical', async () => {
    interdiffMock.mockRejectedValueOnce(new ApiError(404, 'no anchor'));
    const { result } = renderHook(() => useInterdiff('task-a', 2, true));
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current).toEqual({ status: 'unavailable', reason: 'historical' });
  });

  it('maps 409 → released', async () => {
    interdiffMock.mockRejectedValueOnce(new ApiError(409, 'released'));
    const { result } = renderHook(() => useInterdiff('task-a', 2, true));
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect((result.current as { reason: string }).reason).toBe('released');
  });

  it('maps other errors → generic', async () => {
    interdiffMock.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useInterdiff('task-a', 2, true));
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect((result.current as { reason: string }).reason).toBe('generic');
  });

  it('returns to idle when re-disabled', async () => {
    interdiffMock.mockResolvedValueOnce({ diff: 'PATCH' });
    const { result, rerender } = renderHook(({ e }) => useInterdiff('task-a', 2, e), { initialProps: { e: true } });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    rerender({ e: false });
    await waitFor(() => expect(result.current.status).toBe('idle'));
  });
});
