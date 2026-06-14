import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventsClient } from '../../src/stores/events-store.ts';

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
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

  closeFromServer(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  push(msg: object): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  sentParsed(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.useFakeTimers();
  (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket;
});

afterEach(() => {
  // Some tests (C1) flip to real timers mid-body to flush microtasks; reset
  // explicitly so the next test's beforeEach lands on a clean fake-timer state.
  vi.useRealTimers();
});

function makeClient(): { client: EventsClient; lastWs: () => MockWebSocket } {
  const factory = (url: string) => new MockWebSocket(url) as unknown as WebSocket;
  const client = new EventsClient({
    wsUrl: 'ws://test.local/api/realtime',
    wsFactory: factory,
    tokenProvider: () => null,
  });
  return {
    client,
    lastWs: () => MockWebSocket.instances[MockWebSocket.instances.length - 1],
  };
}

describe('EventsClient', () => {
  it('subscribe before WS open queues the op and sends on onopen', () => {
    const { client, lastWs } = makeClient();
    client.subscribe('agents', vi.fn());
    const ws = lastWs();
    expect(ws.sent).toHaveLength(0);
    ws.open();
    expect(ws.sentParsed()).toEqual([{ op: 'subscribe', topic: 'agents' }]);
  });

  it('data frame fans out to all topic subscribers', () => {
    const { client, lastWs } = makeClient();
    const a = vi.fn();
    const b = vi.fn();
    client.subscribe('agents', a);
    client.subscribe('agents', b);
    const ws = lastWs();
    ws.open();
    ws.push({ type: 'data', topic: 'agents', data: [{ id: 'dev-1' }] });
    expect(a).toHaveBeenCalledWith([{ id: 'dev-1' }]);
    expect(b).toHaveBeenCalledWith([{ id: 'dev-1' }]);
  });

  it('cache: late local subscriber gets the last data immediately (microtask)', async () => {
    const { client, lastWs } = makeClient();
    client.subscribe('agents', vi.fn());
    const ws = lastWs();
    ws.open();
    ws.push({ type: 'data', topic: 'agents', data: [{ id: 'dev-1' }] });
    const late = vi.fn();
    client.subscribe('agents', late);
    expect(late).not.toHaveBeenCalled();
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 0));
    expect(late).toHaveBeenCalledWith([{ id: 'dev-1' }]);
  });

  it('only sends one server-side subscribe per topic regardless of local subscribers', () => {
    const { client, lastWs } = makeClient();
    client.subscribe('agents', vi.fn());
    client.subscribe('agents', vi.fn());
    const ws = lastWs();
    ws.open();
    const subs = ws.sentParsed().filter((m) => m.op === 'subscribe' && m.topic === 'agents');
    expect(subs).toHaveLength(1);
  });

  it('unsubscribing the last local subscriber sends unsubscribe and tears down the socket', () => {
    const { client, lastWs } = makeClient();
    const unsub = client.subscribe('agents', vi.fn());
    const ws = lastWs();
    ws.open();
    expect(ws.readyState).toBe(MockWebSocket.OPEN);
    unsub();
    expect(ws.sentParsed().some((m) => m.op === 'unsubscribe' && m.topic === 'agents')).toBe(true);
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });

  it('per-subscriber error is delivered only to the topic owners', () => {
    const { client, lastWs } = makeClient();
    const errA = vi.fn();
    const errB = vi.fn();
    client.subscribe('task:t1', vi.fn(), errA);
    client.subscribe('task:t2', vi.fn(), errB);
    const ws = lastWs();
    ws.open();
    ws.push({ type: 'error', topic: 'task:t1', code: 'snapshot_failed', message: 'boom' });
    expect(errA).toHaveBeenCalledWith({ code: 'snapshot_failed', message: 'boom' });
    expect(errB).not.toHaveBeenCalled();
  });

  it('late subscriber reads CURRENT cache at microtask time, not the value captured at subscribe', async () => {
    const { client, lastWs } = makeClient();
    client.subscribe('agents', vi.fn());
    const ws = lastWs();
    ws.open();
    ws.push({ type: 'data', topic: 'agents', data: [{ id: 'OLD' }] });

    const late = vi.fn();
    client.subscribe('agents', late);
    // Before the microtask runs, a fresh ws message updates the cache. The
    // pre-fix bug captured 'OLD' synchronously and would still deliver it,
    // overwriting the live 'NEW' the same handler already saw.
    ws.push({ type: 'data', topic: 'agents', data: [{ id: 'NEW' }] });

    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 0));
    // late was called once via live dispatch (NEW), and once via the
    // microtask. After the fix, the microtask reads the latest cache, so the
    // microtask delivery is also NEW — never an OLD overwrite.
    const args = late.mock.calls.map((c) => (c[0] as Array<{ id: string }>)[0].id);
    expect(args).not.toContain('OLD');
    expect(args).toContain('NEW');
  });

  it('connection-level failure is broadcast to every topic onError handler', () => {
    const { client, lastWs } = makeClient();
    const errAgents = vi.fn();
    const errTask = vi.fn();
    client.subscribe('agents', vi.fn(), errAgents);
    client.subscribe('task:t1', vi.fn(), errTask);
    const ws = lastWs();
    // close-without-open: simulates 401/403/network-down on initial handshake.
    ws.closeFromServer();
    expect(errAgents).toHaveBeenCalledWith(expect.objectContaining({ code: 'connection_failed' }));
    expect(errTask).toHaveBeenCalledWith(expect.objectContaining({ code: 'connection_failed' }));
  });

  it('graceful close (drop AFTER successful open) is treated as transient — no connection_failed broadcast', () => {
    const { client, lastWs } = makeClient();
    const onError = vi.fn();
    client.subscribe('agents', vi.fn(), onError);
    const ws = lastWs();
    ws.open();
    ws.closeFromServer();
    expect(onError).not.toHaveBeenCalled();
  });

  it('stale unsubscribe in outbox does NOT undo a re-subscribe done during the same disconnect window', () => {
    const { client, lastWs } = makeClient();
    const handlerAgents = vi.fn();
    const handlerTask = vi.fn();
    // 'task:t1' keeps topics non-empty across the unsubscribe — otherwise
    // teardownSocket would clear outbox and the bug wouldn't trigger.
    client.subscribe('task:t1', handlerTask);
    const unsubAgents = client.subscribe('agents', handlerAgents);
    const ws1 = lastWs();
    ws1.open();
    ws1.closeFromServer();
    // CONNECTING window: drop 'agents' then re-subscribe to it. Outbox now
    // contains [unsub agents, sub agents]; topics map ends with 'agents' active.
    unsubAgents();
    client.subscribe('agents', handlerAgents);
    vi.advanceTimersByTime(500);
    const ws2 = lastWs();
    expect(ws2).not.toBe(ws1);
    ws2.open();

    const sentOps = ws2.sentParsed();
    // Reconnect's onopen loop re-issues subscribe for every active topic.
    // After the fix, the stale unsubscribe is dropped — server keeps the
    // sub, client keeps receiving updates.
    expect(sentOps.filter((m) => m.op === 'unsubscribe')).toHaveLength(0);
    const subs = sentOps.filter((m) => m.op === 'subscribe' && m.topic === 'agents');
    expect(subs).toHaveLength(1);

    // Verify the live path actually delivers post-reconnect.
    ws2.push({ type: 'data', topic: 'agents', data: [{ id: 'dev-1' }] });
    expect(handlerAgents).toHaveBeenCalledWith([{ id: 'dev-1' }]);
  });

  it('reconnect re-subscribes every active topic and skips background reconnect when no subs', () => {
    const { client, lastWs } = makeClient();
    const handler = vi.fn();
    const unsub = client.subscribe('agents', handler);
    const ws1 = lastWs();
    ws1.open();
    ws1.closeFromServer();
    vi.advanceTimersByTime(500);
    const ws2 = lastWs();
    expect(ws2).not.toBe(ws1);
    ws2.open();
    expect(ws2.sentParsed()).toEqual([{ op: 'subscribe', topic: 'agents' }]);

    unsub();
    // No more subs: socket teardown wins, reconnect timers should not produce
    // a new ws even after every backoff slot has elapsed.
    vi.advanceTimersByTime(60_000);
    const after = MockWebSocket.instances.length;
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances.length).toBe(after);
  });
});
