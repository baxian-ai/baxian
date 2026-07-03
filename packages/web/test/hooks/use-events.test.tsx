import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';
import {
  EventsClient,
  _resetEventsClientForTest,
} from '../../src/stores/events-store.ts';

vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());

import { api, getAuthToken } from '../../src/api.ts';
import type { TaskState } from '../../src/shared/index.js';
import { makeTask } from '../helpers/fixtures.ts';

const apiTasksList = vi.mocked(api.tasks.list);

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
  vi.mocked(getAuthToken).mockReturnValue(null);
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

describe('useAgents', () => {
  it('subscribes to the agents topic and flips loaded once the first list frame lands', async () => {
    const { useAgents } = await import('../../src/hooks/use-events.ts');
    const { result } = renderHook(() => useAgents());

    expect(result.current.loaded).toBe(false);
    expect(result.current.data).toBe(null);
    expect(result.current.error).toBe(null);

    const ws = MockWebSocket.lastInstance!;
    act(() => { ws.open(); });
    expect(ws.sent.some(s => s.includes('"topic":"agents"'))).toBe(true);

    act(() => {
      ws.push({ type: 'data', topic: 'agents', data: [{ id: 'dev-1' }, { id: 'qa-1' }] });
    });
    expect(result.current.loaded).toBe(true);
    expect(result.current.data?.map(a => a.id)).toEqual(['dev-1', 'qa-1']);
  });

  it('surfaces a topic error, then clears it when a later data frame lands (recovery is visible)', async () => {
    const { useAgents } = await import('../../src/hooks/use-events.ts');
    const { result } = renderHook(() => useAgents());

    const ws = MockWebSocket.lastInstance!;
    act(() => { ws.open(); });
    act(() => {
      ws.push({ type: 'error', topic: 'agents', code: 'snapshot_failed', message: 'boom' });
    });
    expect(result.current.error).toEqual({ code: 'snapshot_failed', message: 'boom' });
    expect(result.current.loaded).toBe(false);

    act(() => {
      ws.push({ type: 'data', topic: 'agents', data: [{ id: 'dev-1' }] });
    });
    expect(result.current.error).toBe(null);
    expect(result.current.loaded).toBe(true);
    expect(result.current.data?.map(a => a.id)).toEqual(['dev-1']);
  });
});

describe('useAgent', () => {
  it('distinguishes "not yet loaded" from "loaded with null" for a missing agent', async () => {
    const { useAgent } = await import('../../src/hooks/use-events.ts');
    const { result } = renderHook(() => useAgent('ghost'));

    expect(result.current.loaded).toBe(false);
    const ws = MockWebSocket.lastInstance!;
    act(() => { ws.open(); });
    expect(ws.sent.some(s => s.includes('"topic":"agent:ghost"'))).toBe(true);

    act(() => {
      ws.push({ type: 'data', topic: 'agent:ghost', data: null });
    });
    expect(result.current.loaded).toBe(true);
    expect(result.current.data).toBe(null);
  });

  it('resets data/loaded/error and resubscribes when agentId changes (no stale snapshot flash)', async () => {
    const { useAgent } = await import('../../src/hooks/use-events.ts');
    const { result, rerender } = renderHook(({ id }) => useAgent(id), {
      initialProps: { id: 'dev-1' },
    });

    const ws1 = MockWebSocket.lastInstance!;
    act(() => { ws1.open(); });
    act(() => {
      ws1.push({ type: 'error', topic: 'agent:dev-1', code: 'forbidden', message: 'nope' });
    });
    expect(result.current.error).toEqual({ code: 'forbidden', message: 'nope' });
    act(() => {
      ws1.push({ type: 'data', topic: 'agent:dev-1', data: { id: 'dev-1', runtimeStatus: 'idle' } });
    });
    expect(result.current.error).toBe(null);
    expect(result.current.loaded).toBe(true);
    expect(result.current.data?.id).toBe('dev-1');

    rerender({ id: 'qa-1' });
    expect(result.current.data).toBe(null);
    expect(result.current.loaded).toBe(false);
    expect(result.current.error).toBe(null);

    const ws2 = MockWebSocket.lastInstance!;
    expect(ws2).not.toBe(ws1);
    act(() => { ws2.open(); });
    expect(ws2.sent.some(s => s.includes('"topic":"agent:qa-1"'))).toBe(true);
    act(() => {
      ws2.push({ type: 'data', topic: 'agent:qa-1', data: { id: 'qa-1', runtimeStatus: 'busy' } });
    });
    expect(result.current.data?.id).toBe('qa-1');
    expect(result.current.loaded).toBe(true);
  });
});

describe('useTask', () => {
  it('distinguishes "not yet loaded" from "loaded with null" so missing tasks render NotFound, not Loading', async () => {
    const { useTask } = await import('../../src/hooks/use-events.ts');
    const { result } = renderHook(() => useTask('t-missing'));

    expect(result.current.loaded).toBe(false);
    expect(result.current.data).toBe(null);

    const ws = MockWebSocket.lastInstance!;
    act(() => {
      ws.open();
    });
    act(() => {
      ws.push({ type: 'data', topic: 'task:t-missing', data: null });
    });

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
      makeTask({ id: 't1', status: 'in_progress' }),
      makeTask({ id: 't2', status: 'pending' }),
    ]);
    const { useProjectTasks } = await import('../../src/hooks/use-events.ts');
    const { result } = renderHook(() => useProjectTasks('proj-1'));

    const ws = MockWebSocket.lastInstance!;
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
      let resolveRest!: (tasks: TaskState[]) => void;
      apiTasksList.mockImplementation(() => new Promise((res) => { resolveRest = res; }));
      const { useProjectTasks } = await import('../../src/hooks/use-events.ts');
      const { result } = renderHook(() => useProjectTasks('proj-1'));

      const ws1 = MockWebSocket.lastInstance!;
      act(() => { ws1.onclose?.(); });
      expect(apiTasksList).toHaveBeenCalled();

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

      await act(async () => {
        resolveRest([makeTask({ id: 't-stale', status: 'pending' })]);
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
