import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';
import {
  EventsClient,
  _resetEventsClientForTest,
} from '../../src/stores/events-store.ts';

const { apiTasksList } = vi.hoisted(() => ({ apiTasksList: vi.fn() }));
vi.mock('../../src/api.ts', () => ({
  api: { tasks: { list: apiTasksList } },
  getAuthToken: () => null,
}));

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static lastInstance: MockWebSocket | undefined;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = MockWebSocket.CONNECTING;
  url: string;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.lastInstance = this;
  }

  send(payload: string): void {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error('not open');
    this.sent.push(payload);
  }
  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
  push(msg: object): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

beforeEach(() => {
  MockWebSocket.lastInstance = undefined;
  apiTasksList.mockReset();
  (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket;
  _resetEventsClientForTest(
    new EventsClient({
      wsUrl: 'ws://test.local/api/realtime',
      wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
      tokenProvider: () => null,
    }),
  );
});

afterEach(() => {
  cleanup();
  _resetEventsClientForTest(null);
});

describe('useTask', () => {
  it('distinguishes "not yet loaded" from "loaded with null" so missing tasks render NotFound, not Loading', async () => {
    const { useTask } = await import('../../src/hooks/use-events.ts');
    const { result } = renderHook(() => useTask('t-missing'));

    // First render: never received anything.
    expect(result.current.loaded).toBe(false);
    expect(result.current.data).toBe(null);

    const ws = MockWebSocket.lastInstance!;
    act(() => {
      ws.open();
    });
    act(() => {
      ws.push({ type: 'data', topic: 'task:t-missing', data: null });
    });

    // Server replied with `null` snapshot — task is gone. loaded=true says
    // "we heard from the server"; the page can now switch from spinner to
    // not-found UI.
    expect(result.current.loaded).toBe(true);
    expect(result.current.data).toBe(null);
  });

  it('flips loaded to true once any data frame (including a task object) lands', async () => {
    const { useTask } = await import('../../src/hooks/use-events.ts');
    const { result } = renderHook(() => useTask('t1'));

    const ws = MockWebSocket.lastInstance!;
    act(() => {
      ws.open();
    });
    act(() => {
      ws.push({
        type: 'data',
        topic: 'task:t1',
        data: { id: 't1', status: 'pending' },
      });
    });

    expect(result.current.loaded).toBe(true);
    expect(result.current.data?.id).toBe('t1');
  });
});

describe('useProjectTasks', () => {
  it('subscribes to project-tasks:<id> and surfaces incoming list updates', async () => {
    const { useProjectTasks } = await import('../../src/hooks/use-events.ts');
    const { result } = renderHook(() => useProjectTasks('proj-1'));

    expect(result.current.loaded).toBe(false);
    expect(result.current.data).toBe(null);

    const ws = MockWebSocket.lastInstance!;
    act(() => { ws.open(); });
    expect(ws.sent.some(s => s.includes('"topic":"project-tasks:proj-1"'))).toBe(true);

    act(() => {
      ws.push({
        type: 'data',
        topic: 'project-tasks:proj-1',
        data: [{ id: 't1', status: 'in_progress' }, { id: 't2', status: 'pending' }],
      });
    });
    expect(result.current.loaded).toBe(true);
    expect(result.current.data?.map(t => t.id)).toEqual(['t1', 't2']);

    act(() => {
      ws.push({
        type: 'data',
        topic: 'project-tasks:proj-1',
        data: [{ id: 't1', status: 'review' }, { id: 't2', status: 'pending' }, { id: 't3', status: 'pending' }],
      });
    });
    expect(result.current.data?.map(t => t.id)).toEqual(['t1', 't2', 't3']);
    expect(result.current.data?.[0].status).toBe('review');
  });

  it('no projectId means no subscription is opened (avoids subscribing to project-tasks:undefined)', async () => {
    const { useProjectTasks } = await import('../../src/hooks/use-events.ts');
    renderHook(() => useProjectTasks(undefined));

    expect(MockWebSocket.lastInstance).toBe(undefined);
    expect(apiTasksList).not.toHaveBeenCalled();
  });

  it('falls back to REST when realtime fails on connect so users still see tasks instead of an empty page', async () => {
    apiTasksList.mockResolvedValue([
      { id: 't1', status: 'in_progress' },
      { id: 't2', status: 'pending' },
    ]);
    const { useProjectTasks } = await import('../../src/hooks/use-events.ts');
    const { result } = renderHook(() => useProjectTasks('proj-1'));

    const ws = MockWebSocket.lastInstance!;
    // Simulate WS connect failure: socket closes before opening, mirroring proxy
    // / auth rejection. EventsClient.onclose treats !opened as broadcastable error.
    act(() => { ws.onclose?.(); });

    expect(result.current.error).toEqual({
      code: 'connection_failed',
      message: 'WebSocket failed to connect (auth, network, or proxy issue)',
    });
    expect(apiTasksList).toHaveBeenCalledWith('proj-1');

    await waitFor(() => {
      expect(result.current.data?.map(t => t.id)).toEqual(['t1', 't2']);
      expect(result.current.loaded).toBe(true);
    });
    // WS error stays visible so the user knows realtime updates won't arrive.
    expect(result.current.error?.code).toBe('connection_failed');
  });

  it('REST fallback only runs once even when realtime emits multiple errors during reconnect attempts', async () => {
    apiTasksList.mockResolvedValue([]);
    const { useProjectTasks } = await import('../../src/hooks/use-events.ts');
    renderHook(() => useProjectTasks('proj-1'));

    const ws = MockWebSocket.lastInstance!;
    act(() => { ws.onclose?.(); });
    act(() => { ws.onclose?.(); });
    act(() => { ws.onclose?.(); });

    expect(apiTasksList).toHaveBeenCalledTimes(1);
  });

  it('does not invoke REST when WS connects normally — no extra API surface on the happy path', async () => {
    const { useProjectTasks } = await import('../../src/hooks/use-events.ts');
    const { result } = renderHook(() => useProjectTasks('proj-1'));

    const ws = MockWebSocket.lastInstance!;
    act(() => { ws.open(); });
    act(() => {
      ws.push({
        type: 'data',
        topic: 'project-tasks:proj-1',
        data: [{ id: 't1', status: 'pending' }],
      });
    });

    expect(result.current.data?.map(t => t.id)).toEqual(['t1']);
    expect(apiTasksList).not.toHaveBeenCalled();
  });

  it('drops the REST result when WS reconnects with a fresher snapshot in between (no stale-overwrite race)', async () => {
    vi.useFakeTimers();
    try {
      let resolveRest!: (tasks: { id: string; status: string }[]) => void;
      apiTasksList.mockImplementation(() => new Promise((res) => { resolveRest = res; }));
      const { useProjectTasks } = await import('../../src/hooks/use-events.ts');
      const { result } = renderHook(() => useProjectTasks('proj-1'));

      const ws1 = MockWebSocket.lastInstance!;
      act(() => { ws1.onclose?.(); });
      expect(apiTasksList).toHaveBeenCalled();

      // Auto-reconnect fires a fresh socket via the configured backoff.
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      const ws2 = MockWebSocket.lastInstance!;
      expect(ws2).not.toBe(ws1);
      act(() => { ws2.open(); });
      act(() => {
        ws2.push({
          type: 'data',
          topic: 'project-tasks:proj-1',
          data: [{ id: 't-fresh', status: 'in_progress' }],
        });
      });
      expect(result.current.data?.map(t => t.id)).toEqual(['t-fresh']);

      // Stale REST resolves AFTER WS already delivered — must not overwrite.
      await act(async () => {
        resolveRest([{ id: 't-stale', status: 'pending' }]);
        await Promise.resolve();
      });
      expect(result.current.data?.map(t => t.id)).toEqual(['t-fresh']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the WS error visible when REST fallback also fails (no silent suppression)', async () => {
    apiTasksList.mockRejectedValue(new Error('REST 500'));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { useProjectTasks } = await import('../../src/hooks/use-events.ts');
    const { result } = renderHook(() => useProjectTasks('proj-1'));

    const ws = MockWebSocket.lastInstance!;
    act(() => { ws.onclose?.(); });
    await waitFor(() => {
      expect(apiTasksList).toHaveBeenCalled();
    });
    await act(async () => { await Promise.resolve(); });

    expect(result.current.error?.code).toBe('connection_failed');
    expect(result.current.data).toBe(null);
    expect(result.current.loaded).toBe(false);
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });
});
