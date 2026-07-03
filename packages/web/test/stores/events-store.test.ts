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
  protocols?: string | string[];
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  sent: string[] = [];
  failSends = false;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    MockWebSocket.instances.push(this);
  }

  send(payload: string): void {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error('not open');
    if (this.failSends) throw new Error('send failed');
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

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.useFakeTimers();
  (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.WebSocket = originalWebSocket;
});

function makeClient(opts: { token?: string | null } = {}): { client: EventsClient; lastWs: () => MockWebSocket } {
  const factory = (url: string, protocols?: string[]) =>
    new MockWebSocket(url, protocols) as unknown as WebSocket;
  const client = new EventsClient({
    wsUrl: 'ws://test.local/api/realtime',
    wsFactory: factory,
    tokenProvider: () => opts.token ?? null,
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
    ws.push({ type: 'data', topic: 'agents', data: [{ id: 'NEW' }] });

    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 0));
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
    client.subscribe('task:t1', handlerTask);
    const unsubAgents = client.subscribe('agents', handlerAgents);
    const ws1 = lastWs();
    ws1.open();
    ws1.closeFromServer();
    unsubAgents();
    client.subscribe('agents', handlerAgents);
    vi.advanceTimersByTime(500);
    const ws2 = lastWs();
    expect(ws2).not.toBe(ws1);
    ws2.open();

    const sentOps = ws2.sentParsed();
    expect(sentOps.filter((m) => m.op === 'unsubscribe')).toHaveLength(0);
    const subs = sentOps.filter((m) => m.op === 'subscribe' && m.topic === 'agents');
    expect(subs).toHaveLength(1);

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
    vi.advanceTimersByTime(60_000);
    const after = MockWebSocket.instances.length;
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances.length).toBe(after);
  });

  it('encodes the auth token as a hex WebSocket subprotocol', () => {
    const { client, lastWs } = makeClient({ token: 'ab' });
    client.subscribe('agents', vi.fn());
    expect(lastWs().protocols).toEqual(['baxian.token.6162']);
  });

  it('defaults: derives the ws URL from location and passes the token subprotocol to global WebSocket', () => {
    const client = new EventsClient({ tokenProvider: () => 'ab' });
    client.subscribe('agents', vi.fn());
    const ws = MockWebSocket.instances[0];
    const expectedProto = location.protocol === 'https:' ? 'wss' : 'ws';
    expect(ws.url).toBe(`${expectedProto}://${location.host}/api/realtime`);
    expect(ws.protocols).toEqual(['baxian.token.6162']);
    client.close();
  });

  it('defaults: without a token the global WebSocket is constructed with no subprotocols', () => {
    const client = new EventsClient({ wsUrl: 'ws://test.local/api/realtime', tokenProvider: () => null });
    client.subscribe('agents', vi.fn());
    expect(MockWebSocket.instances[0].protocols).toBeUndefined();
    client.close();
  });

  it('close() shuts the socket, clears all state, and blocks any later subscribe from reopening', () => {
    const { client, lastWs } = makeClient();
    const handler = vi.fn();
    client.subscribe('agents', handler);
    const ws = lastWs();
    ws.open();
    ws.push({ type: 'data', topic: 'agents', data: [{ id: 'dev-1' }] });
    expect(handler).toHaveBeenCalledTimes(1);

    client.close();
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);

    const countBefore = MockWebSocket.instances.length;
    client.subscribe('agents', handler);
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances.length).toBe(countBefore);
  });

  it('wsFactory throwing broadcasts connection_failed with the thrown message and schedules a reconnect', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let shouldThrow = true;
    const client = new EventsClient({
      wsUrl: 'ws://test.local/api/realtime',
      wsFactory: (url) => {
        if (shouldThrow) throw new Error('CSP blocked');
        return new MockWebSocket(url) as unknown as WebSocket;
      },
      tokenProvider: () => null,
    });
    const onError = vi.fn();
    client.subscribe('agents', vi.fn(), onError);
    expect(onError).toHaveBeenCalledWith({ code: 'connection_failed', message: 'CSP blocked' });
    expect(MockWebSocket.instances).toHaveLength(0);

    shouldThrow = false;
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
    consoleWarn.mockRestore();
  });

  it('resubscribe send failure on reconnect is contained (warn, no throw)', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, lastWs } = makeClient();
    client.subscribe('agents', vi.fn());
    const ws = lastWs();
    ws.failSends = true;
    expect(() => ws.open()).not.toThrow();
    expect(ws.sent).toHaveLength(0);
    expect(consoleWarn).toHaveBeenCalledWith('[events-client] resubscribe send failed:', expect.any(Error));
    consoleWarn.mockRestore();
  });

  it('malformed server frames are ignored and later valid frames still dispatch', () => {
    const { client, lastWs } = makeClient();
    const handler = vi.fn();
    client.subscribe('agents', handler);
    const ws = lastWs();
    ws.open();
    expect(() => ws.onmessage?.({ data: 'not json {' })).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
    ws.push({ type: 'data', topic: 'agents', data: [{ id: 'dev-1' }] });
    expect(handler).toHaveBeenCalledWith([{ id: 'dev-1' }]);
  });

  it('a throwing error handler does not stop the connection error from reaching other topics', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, lastWs } = makeClient();
    const bad = vi.fn(() => { throw new Error('handler boom'); });
    const good = vi.fn();
    client.subscribe('agents', vi.fn(), bad);
    client.subscribe('task:t1', vi.fn(), good);
    lastWs().closeFromServer();
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalledWith(expect.objectContaining({ code: 'connection_failed' }));
    expect(consoleError).toHaveBeenCalledWith(
      '[events-client] error handler threw on connection error:',
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it('send failure on an OPEN socket queues the op instead of losing it, and reconnect restores both topics', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, lastWs } = makeClient();
    client.subscribe('agents', vi.fn());
    const ws1 = lastWs();
    ws1.open();

    ws1.failSends = true;
    expect(() => client.subscribe('task:t1', vi.fn())).not.toThrow();
    expect(consoleWarn).toHaveBeenCalledWith('[events-client] send failed, will queue:', expect.any(Error));

    ws1.closeFromServer();
    vi.advanceTimersByTime(500);
    const ws2 = lastWs();
    expect(ws2).not.toBe(ws1);
    ws2.open();
    const topics = ws2.sentParsed().filter((m) => m.op === 'subscribe').map((m) => m.topic);
    expect(topics).toEqual(expect.arrayContaining(['agents', 'task:t1']));
    consoleWarn.mockRestore();
  });

  it('a throwing data handler does not block other subscribers of the same topic', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, lastWs } = makeClient();
    const bad = vi.fn(() => { throw new Error('render boom'); });
    const good = vi.fn();
    client.subscribe('agents', bad);
    client.subscribe('agents', good);
    const ws = lastWs();
    ws.open();
    ws.push({ type: 'data', topic: 'agents', data: [{ id: 'dev-1' }] });
    expect(good).toHaveBeenCalledWith([{ id: 'dev-1' }]);
    expect(consoleError).toHaveBeenCalledWith('[events-client] handler threw on agents:', expect.any(Error));
    consoleError.mockRestore();
  });

  it('a throwing topic error handler does not block other error handlers of the same topic', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, lastWs } = makeClient();
    const bad = vi.fn(() => { throw new Error('err boom'); });
    const good = vi.fn();
    client.subscribe('task:t1', vi.fn(), bad);
    client.subscribe('task:t1', vi.fn(), good);
    const ws = lastWs();
    ws.open();
    ws.push({ type: 'error', topic: 'task:t1', code: 'snapshot_failed', message: 'boom' });
    expect(good).toHaveBeenCalledWith({ code: 'snapshot_failed', message: 'boom' });
    expect(consoleError).toHaveBeenCalledWith(
      '[events-client] error handler threw on task:t1:',
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it('a connection-level error frame (no topic) is logged, not routed to topic handlers', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, lastWs } = makeClient();
    const onError = vi.fn();
    client.subscribe('agents', vi.fn(), onError);
    const ws = lastWs();
    ws.open();
    ws.push({ type: 'error', code: 'unauthorized', message: 'bad token' });
    expect(onError).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledWith('[events-client] connection-level error:', 'unauthorized', 'bad token');
    consoleWarn.mockRestore();
  });

  it('pong frames are silently accepted', () => {
    const { client, lastWs } = makeClient();
    const handler = vi.fn();
    const onError = vi.fn();
    client.subscribe('agents', handler, onError);
    const ws = lastWs();
    ws.open();
    expect(() => ws.push({ type: 'pong' })).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
