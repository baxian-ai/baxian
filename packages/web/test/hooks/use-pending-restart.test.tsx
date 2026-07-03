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

function healthResponse(startedAt: string): Response {
  return new Response(JSON.stringify({ status: 'ok', startedAt }), { status: 200 });
}

function installDefaultFetchMock(startedAt = 'STABLE') {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const u = String(url);
    if (u === '/health') return healthResponse(startedAt);
    throw new Error(`unexpected url ${u}`);
  });
}

function installRestartFetchMock(opts: {
  startedAt: string;
  restart: { status: number; body: unknown };
  onRestart?: (advance: (next: string) => void) => void;
}) {
  let current = opts.startedAt;
  const advance = (next: string): void => { current = next; };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const u = String(url);
    if (u === '/health') return healthResponse(current);
    if (u.endsWith('/api/restart')) {
      opts.onRestart?.(advance);
      return new Response(JSON.stringify(opts.restart.body), { status: opts.restart.status });
    }
    throw new Error(`unexpected url ${u}`);
  });
  return { advance };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const STORAGE_KEY = 'baxian.pendingRestart';

function seedPersisted(count: number, baselineStartedAt: string): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ count, baselineStartedAt }));
}

function readPersisted() {
  return JSON.parse(localStorage.getItem(STORAGE_KEY)!);
}

function fireCrossTabStorage(oldValue: string | null, newValue: string | null): void {
  if (newValue === null) localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, newValue);
  window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, oldValue, newValue }));
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
    seedPersisted(5, 'OLD');
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
    seedPersisted(3, 'STABLE');

    const { result } = renderHook(() => usePendingRestart(), { wrapper });
    expect(result.current.count).toBe(3);
    expect(result.current.phase).toBe('pending');

    await new Promise(r => setTimeout(r, 10));
    expect(result.current.count).toBe(3);
    expect(result.current.phase).toBe('pending');
  });

  it('triggerRestart success: polls until startedAt changes, clears count', async () => {
    installRestartFetchMock({
      startedAt: 'OLD',
      restart: { status: 202, body: { acceptedAt: '2026' } },
      onRestart: (advance) => advance('NEW'),
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
    installRestartFetchMock({
      startedAt: 'A',
      restart: { status: 409, body: { error: 'already' } },
      onRestart: (advance) => advance('B'),
    });

    const { result } = renderHook(() => usePendingRestart(), { wrapper });
    act(() => { result.current.flagDirty(); });
    await act(async () => { await result.current.triggerRestart(); });
    expect(result.current.phase).toBe('idle');
  });

  it('triggerRestart preserves same-tab dirty changes made while polling for the new startedAt', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { advance } = installRestartFetchMock({
      startedAt: 'OLD',
      restart: { status: 202, body: { acceptedAt: '2026' } },
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

    advance('NEW');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await triggerPromise;
    });

    expect(result.current.phase).toBe('pending');
    expect(result.current.count).toBe(1);
    expect(readPersisted()).toEqual({ count: 1, baselineStartedAt: 'NEW' });
    vi.useRealTimers();
  });

  it('triggerRestart preserves cross-tab dirty changes made while polling for the new startedAt', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { advance } = installRestartFetchMock({
      startedAt: 'OLD',
      restart: { status: 202, body: { acceptedAt: '2026' } },
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
      fireCrossTabStorage(
        JSON.stringify({ count: 1, baselineStartedAt: 'OLD' }),
        JSON.stringify({ count: 2, baselineStartedAt: 'OLD' }),
      );
    });
    expect(result.current.count).toBe(2);

    advance('NEW');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await triggerPromise;
    });

    expect(result.current.phase).toBe('pending');
    expect(result.current.count).toBe(1);
    expect(readPersisted()).toEqual({ count: 1, baselineStartedAt: 'NEW' });
    vi.useRealTimers();
  });

  it('triggerRestart 401 switches to failed', async () => {
    installRestartFetchMock({
      startedAt: 'X',
      restart: { status: 401, body: { error: 'unauth' } },
    });

    const { result } = renderHook(() => usePendingRestart(), { wrapper });
    act(() => { result.current.flagDirty(); });
    await act(async () => { await result.current.triggerRestart(); });
    expect(result.current.phase).toBe('failed');
    expect(result.current.error).toMatch(/unauth/);
  });

  it('cross-tab sync: when another same-origin tab clears the storage (restart succeeded there), this tab transitions to idle without remount', async () => {
    seedPersisted(5, 'STABLE');
    installDefaultFetchMock('STABLE');

    const { result } = renderHook(() => usePendingRestart(), { wrapper });
    expect(result.current.count).toBe(5);
    expect(result.current.phase).toBe('pending');

    await new Promise(r => setTimeout(r, 10));
    expect(result.current.count).toBe(5);

    act(() => {
      fireCrossTabStorage(JSON.stringify({ count: 5, baselineStartedAt: 'STABLE' }), null);
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

    const persisted = readPersisted();
    expect(persisted.count).toBe(3);
    expect(persisted.baselineStartedAt).toBe('STABLE');
  });

  it('corrupt persisted JSON falls back to a clean idle state instead of crashing the app shell', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    const { result } = renderHook(() => usePendingRestart(), { wrapper });
    expect(result.current.phase).toBe('idle');
    expect(result.current.count).toBe(0);
  });

  it('a throwing localStorage.setItem (quota/private mode) does not break in-memory dirty tracking', () => {
    const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      const { result } = renderHook(() => usePendingRestart(), { wrapper });
      act(() => { result.current.flagDirty(); });
      expect(setItemSpy).toHaveBeenCalled();
      expect(result.current.count).toBe(1);
      expect(result.current.phase).toBe('pending');
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it('another tab clearing storage mid-restart keeps THIS tab\'s dirty-during-restart count', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { advance } = installRestartFetchMock({
      startedAt: 'OLD',
      restart: { status: 202, body: { acceptedAt: '2026' } },
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

    act(() => {
      fireCrossTabStorage(JSON.stringify({ count: 2, baselineStartedAt: 'OLD' }), null);
    });
    expect(result.current.count).toBe(1);
    expect(result.current.phase).toBe('restarting');

    advance('NEW');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await triggerPromise;
    });
    expect(result.current.phase).toBe('pending');
    expect(result.current.count).toBe(1);
    vi.useRealTimers();
  });

  it('cross-tab count updates while NOT restarting drive phase pending↔idle, and a null baseline clears it', async () => {
    const { result } = renderHook(() => usePendingRestart(), { wrapper });
    expect(result.current.phase).toBe('idle');

    act(() => {
      fireCrossTabStorage(null, JSON.stringify({ count: 3, baselineStartedAt: 'STABLE' }));
    });
    expect(result.current.count).toBe(3);
    expect(result.current.phase).toBe('pending');

    act(() => {
      fireCrossTabStorage(
        JSON.stringify({ count: 3, baselineStartedAt: 'STABLE' }),
        JSON.stringify({ count: 0, baselineStartedAt: null }),
      );
    });
    expect(result.current.count).toBe(0);
    expect(result.current.phase).toBe('idle');

    await new Promise(r => setTimeout(r, 10));
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('a garbage cross-tab storage payload is ignored without disturbing local state', () => {
    const { result } = renderHook(() => usePendingRestart(), { wrapper });
    act(() => { result.current.flagDirty(); });
    expect(result.current.count).toBe(1);

    act(() => {
      fireCrossTabStorage(JSON.stringify({ count: 1, baselineStartedAt: null }), '{not json');
    });
    expect(result.current.count).toBe(1);
    expect(result.current.phase).toBe('pending');
  });

  it('triggerRestart fails fast when the pre-restart /health probe is unreachable', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('server unreachable'));

    const { result } = renderHook(() => usePendingRestart(), { wrapper });
    await act(async () => { await result.current.triggerRestart(); });

    expect(result.current.phase).toBe('failed');
    expect(result.current.error).toMatch(/获取重启前 startedAt 失败/);
    expect(result.current.error).toMatch(/server unreachable/);
  });

  it('transient /health failures while the server reboots are tolerated until startedAt changes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    let current = 'OLD';
    let healthDown = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u === '/health') {
        if (healthDown) throw new Error('connection refused');
        return healthResponse(current);
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

    healthDown = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(result.current.phase).toBe('restarting');

    healthDown = false;
    current = 'NEW';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await triggerPromise;
    });
    expect(result.current.phase).toBe('idle');
    expect(result.current.count).toBe(0);
    vi.useRealTimers();
  });

  it('usePendingRestart outside the provider throws a descriptive error', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => usePendingRestart())).toThrow(
      /usePendingRestart must be used inside PendingRestartProvider/,
    );
    consoleError.mockRestore();
  });

  it('triggerRestart 30s timeout switches to failed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    installRestartFetchMock({
      startedAt: 'STUCK',
      restart: { status: 202, body: { acceptedAt: '2026' } },
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
