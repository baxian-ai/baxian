import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  PendingRestartProvider,
  usePendingRestart,
} from '../../src/hooks/use-pending-restart.tsx';

const wrapper = ({ children }: { children: ReactNode }) => (
  <PendingRestartProvider>{children}</PendingRestartProvider>
);

function installDefaultFetchMock(startedAt = 'STABLE') {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const u = String(url);
    if (u === '/health') {
      return new Response(JSON.stringify({ status: 'ok', startedAt }), { status: 200 });
    }
    throw new Error(`unexpected url ${u}`);
  });
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  installDefaultFetchMock();
});

afterEach(() => {
  localStorage.clear();
});

describe('usePendingRestart', () => {
  it('starts idle with count 0', () => {
    const { result } = renderHook(() => usePendingRestart(), { wrapper });
    expect(result.current.phase).toBe('idle');
    expect(result.current.count).toBe(0);
  });

  it('flagDirty increments count and switches to pending', () => {
    const { result } = renderHook(() => usePendingRestart(), { wrapper });
    act(() => { result.current.flagDirty(); });
    expect(result.current.count).toBe(1);
    expect(result.current.phase).toBe('pending');
    act(() => { result.current.flagDirty(); });
    expect(result.current.count).toBe(2);
  });

  it('persists count to localStorage and recovers on remount', () => {
    const { result, unmount } = renderHook(() => usePendingRestart(), { wrapper });
    act(() => { result.current.flagDirty(); result.current.flagDirty(); });
    expect(result.current.count).toBe(2);
    unmount();
    const { result: fresh } = renderHook(() => usePendingRestart(), { wrapper });
    expect(fresh.current.count).toBe(2);
    expect(fresh.current.phase).toBe('pending');
  });

  it('mount-time reconcile clears stale state when /health.startedAt has already advanced past the persisted baseline (server restarted via CLI / other tab / page reload)', async () => {
    localStorage.setItem(
      'baxian.pendingRestart',
      JSON.stringify({ count: 5, baselineStartedAt: 'OLD' }),
    );
    installDefaultFetchMock('NEW');

    const { result } = renderHook(() => usePendingRestart(), { wrapper });
    expect(result.current.count).toBe(5);
    expect(result.current.phase).toBe('pending');

    await waitFor(() => {
      expect(result.current.count).toBe(0);
      expect(result.current.phase).toBe('idle');
    });
  });

  it('mount-time reconcile leaves persisted state alone when /health.startedAt still matches the baseline', async () => {
    localStorage.setItem(
      'baxian.pendingRestart',
      JSON.stringify({ count: 3, baselineStartedAt: 'STABLE' }),
    );

    const { result } = renderHook(() => usePendingRestart(), { wrapper });
    expect(result.current.count).toBe(3);
    expect(result.current.phase).toBe('pending');

    await new Promise(r => setTimeout(r, 10));
    expect(result.current.count).toBe(3);
    expect(result.current.phase).toBe('pending');
  });

  it('triggerRestart success: polls until startedAt changes, clears count', async () => {
    let currentStartedAt = 'OLD';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u === '/health') {
        return new Response(
          JSON.stringify({ status: 'ok', startedAt: currentStartedAt }),
          { status: 200 },
        );
      }
      if (u.endsWith('/api/restart')) {
        currentStartedAt = 'NEW';
        return new Response(JSON.stringify({ acceptedAt: '2026' }), { status: 202 });
      }
      throw new Error(`unexpected url ${u}`);
    });

    const { result } = renderHook(() => usePendingRestart(), { wrapper });
    act(() => { result.current.flagDirty(); });

    await act(async () => {
      await result.current.triggerRestart();
    });

    expect(result.current.phase).toBe('idle');
    expect(result.current.count).toBe(0);
  });

  it('triggerRestart 409 stays in restarting and resolves on startedAt change', async () => {
    let currentStartedAt = 'A';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u === '/health') {
        return new Response(
          JSON.stringify({ status: 'ok', startedAt: currentStartedAt }),
          { status: 200 },
        );
      }
      if (u.endsWith('/api/restart')) {
        currentStartedAt = 'B';
        return new Response(JSON.stringify({ error: 'already' }), { status: 409 });
      }
      throw new Error(`unexpected url ${u}`);
    });

    const { result } = renderHook(() => usePendingRestart(), { wrapper });
    act(() => { result.current.flagDirty(); });
    await act(async () => { await result.current.triggerRestart(); });
    expect(result.current.phase).toBe('idle');
  });

  it('triggerRestart preserves same-tab dirty changes made while polling for the new startedAt', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    let currentStartedAt = 'OLD';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u === '/health') {
        return new Response(
          JSON.stringify({ status: 'ok', startedAt: currentStartedAt }),
          { status: 200 },
        );
      }
      if (u.endsWith('/api/restart')) {
        return new Response(JSON.stringify({ acceptedAt: '2026' }), { status: 202 });
      }
      throw new Error(`unexpected url ${u}`);
    });

    const { result } = renderHook(() => usePendingRestart(), { wrapper });
    act(() => { result.current.flagDirty(); });

    let triggerPromise: Promise<void> | undefined;
    await act(async () => {
      triggerPromise = result.current.triggerRestart();
      await flushMicrotasks();
    });
    expect(result.current.phase).toBe('restarting');

    act(() => { result.current.flagDirty(); });
    expect(result.current.count).toBe(2);

    currentStartedAt = 'NEW';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await triggerPromise;
    });

    expect(result.current.phase).toBe('pending');
    expect(result.current.count).toBe(1);
    const persisted = JSON.parse(localStorage.getItem('baxian.pendingRestart')!);
    expect(persisted).toEqual({ count: 1, baselineStartedAt: 'NEW' });
    vi.useRealTimers();
  });

  it('triggerRestart preserves cross-tab dirty changes made while polling for the new startedAt', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    let currentStartedAt = 'OLD';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u === '/health') {
        return new Response(
          JSON.stringify({ status: 'ok', startedAt: currentStartedAt }),
          { status: 200 },
        );
      }
      if (u.endsWith('/api/restart')) {
        return new Response(JSON.stringify({ acceptedAt: '2026' }), { status: 202 });
      }
      throw new Error(`unexpected url ${u}`);
    });

    const { result } = renderHook(() => usePendingRestart(), { wrapper });
    act(() => { result.current.flagDirty(); });

    let triggerPromise: Promise<void> | undefined;
    await act(async () => {
      triggerPromise = result.current.triggerRestart();
      await flushMicrotasks();
    });
    expect(result.current.phase).toBe('restarting');

    act(() => {
      localStorage.setItem(
        'baxian.pendingRestart',
        JSON.stringify({ count: 2, baselineStartedAt: 'OLD' }),
      );
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'baxian.pendingRestart',
          oldValue: JSON.stringify({ count: 1, baselineStartedAt: 'OLD' }),
          newValue: JSON.stringify({ count: 2, baselineStartedAt: 'OLD' }),
        }),
      );
    });
    expect(result.current.count).toBe(2);

    currentStartedAt = 'NEW';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await triggerPromise;
    });

    expect(result.current.phase).toBe('pending');
    expect(result.current.count).toBe(1);
    const persisted = JSON.parse(localStorage.getItem('baxian.pendingRestart')!);
    expect(persisted).toEqual({ count: 1, baselineStartedAt: 'NEW' });
    vi.useRealTimers();
  });

  it('triggerRestart 401 switches to failed', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u === '/health') {
        return new Response(JSON.stringify({ status: 'ok', startedAt: 'X' }), { status: 200 });
      }
      if (u.endsWith('/api/restart')) {
        return new Response(JSON.stringify({ error: 'unauth' }), { status: 401 });
      }
      throw new Error(`unexpected ${u}`);
    });

    const { result } = renderHook(() => usePendingRestart(), { wrapper });
    act(() => { result.current.flagDirty(); });
    await act(async () => { await result.current.triggerRestart(); });
    expect(result.current.phase).toBe('failed');
    expect(result.current.error).toMatch(/unauth/);
  });

  it('cross-tab sync: when another same-origin tab clears the storage (restart succeeded there), this tab transitions to idle without remount', async () => {
    localStorage.setItem(
      'baxian.pendingRestart',
      JSON.stringify({ count: 5, baselineStartedAt: 'STABLE' }),
    );
    installDefaultFetchMock('STABLE');

    const { result } = renderHook(() => usePendingRestart(), { wrapper });
    expect(result.current.count).toBe(5);
    expect(result.current.phase).toBe('pending');

    await new Promise(r => setTimeout(r, 10));
    expect(result.current.count).toBe(5);

    act(() => {
      localStorage.removeItem('baxian.pendingRestart');
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'baxian.pendingRestart',
          oldValue: JSON.stringify({ count: 5, baselineStartedAt: 'STABLE' }),
          newValue: null,
        }),
      );
    });

    expect(result.current.count).toBe(0);
    expect(result.current.phase).toBe('idle');
  });

  it('flagDirty rapid bursts do not let stale closure count overwrite localStorage with a smaller value', async () => {
    let resolveFetch: ((value: Response) => void) | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise<Response>(r => { resolveFetch = r; }),
    );

    const { result } = renderHook(() => usePendingRestart(), { wrapper });

    act(() => {
      result.current.flagDirty();
      result.current.flagDirty();
      result.current.flagDirty();
    });
    expect(result.current.count).toBe(3);

    await act(async () => {
      resolveFetch?.(new Response(JSON.stringify({ status: 'ok', startedAt: 'STABLE' }), { status: 200 }));
      await new Promise(r => setTimeout(r, 0));
    });

    const persisted = JSON.parse(localStorage.getItem('baxian.pendingRestart')!);
    expect(persisted.count).toBe(3);
    expect(persisted.baselineStartedAt).toBe('STABLE');
  });

  it('triggerRestart 30s timeout switches to failed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u === '/health') {
        return new Response(JSON.stringify({ status: 'ok', startedAt: 'STUCK' }), { status: 200 });
      }
      if (u.endsWith('/api/restart')) {
        return new Response(JSON.stringify({ acceptedAt: '2026' }), { status: 202 });
      }
      throw new Error(`unexpected ${u}`);
    });

    const { result } = renderHook(() => usePendingRestart(), { wrapper });
    await act(async () => { result.current.flagDirty(); });

    await act(async () => {
      const triggerPromise = result.current.triggerRestart();
      await vi.advanceTimersByTimeAsync(31_000);
      await triggerPromise;
    });

    expect(result.current.phase).toBe('failed');
    vi.useRealTimers();
  });
});
