import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PaneStreamClient } from '../../src/stores/pane-stream-store.ts';

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

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    MockWebSocket.instances.push(this);
  }

  send(payload: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('not open');
    }
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  // helpers
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

function ackSubscribe(ws: MockWebSocket, subscriberId: string, opts: { data: string; seq: number }): void {
  ws.push({ type: 'snapshot', subscriberId, cols: 80, rows: 24, data: opts.data, snapshotSeq: opts.seq });
  ws.push({ type: 'subscribed', subscriberId, agentId: 'dev-1', cols: 80, rows: 24, snapshotSeq: opts.seq });
}

function makeClient(opts: { wsUrl?: string } = {}): { client: PaneStreamClient; lastWs: () => MockWebSocket } {
  const factory = (url: string, protocols?: string[]) => {
    return new MockWebSocket(url, protocols) as unknown as WebSocket;
  };
  const client = new PaneStreamClient({
    wsUrl: opts.wsUrl ?? 'ws://test.local/api/stream',
    wsFactory: factory,
    tokenProvider: () => null,
  });
  return {
    client,
    lastWs: () => MockWebSocket.instances[MockWebSocket.instances.length - 1],
  };
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.useFakeTimers();
  // expose constructor for runtime readyState constants used by store
  (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket;
});

describe('PaneStreamClient', () => {
  it('subscribe before WS open queues subscribe and sends after onopen', () => {
    const { client, lastWs } = makeClient();
    const onSnapshot = vi.fn();
    const onData = vi.fn();
    client.subscribe({ agentId: 'dev-1', mode: 'preview', onSnapshot, onData });

    const ws = lastWs();
    expect(ws.sent).toHaveLength(0);
    expect(ws.readyState).toBe(MockWebSocket.CONNECTING);

    ws.open();
    const sent = ws.sentParsed();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ op: 'subscribe', agentId: 'dev-1', mode: 'preview' });
  });

  it('does not send client-controlled lifecycle flags on subscribe or reconnect resubscribe', () => {
    const { client, lastWs } = makeClient();
    const h = client.subscribe({
      agentId: 'dev-1',
      mode: 'full',
      onSnapshot: vi.fn(),
      onData: vi.fn(),
    });
    const ws1 = lastWs();
    ws1.open();
    expect(ws1.sentParsed()[0]).toMatchObject({
      op: 'subscribe',
      subscriberId: h.subscriberId,
      agentId: 'dev-1',
      mode: 'full',
    });
    expect(ws1.sentParsed()[0]).not.toHaveProperty('reportLifecycle');

    ws1.closeFromServer();
    vi.advanceTimersByTime(500);
    const ws2 = lastWs();
    ws2.open();
    expect(ws2.sentParsed()[0]).toMatchObject({
      op: 'subscribe',
      subscriberId: h.subscriberId,
      agentId: 'dev-1',
      mode: 'full',
    });
    expect(ws2.sentParsed()[0]).not.toHaveProperty('reportLifecycle');
  });

  it('snapshot delivers cols/rows/data via onSnapshot', () => {
    const { client, lastWs } = makeClient();
    const onSnapshot = vi.fn();
    const onData = vi.fn();
    const handle = client.subscribe({ agentId: 'dev-1', mode: 'full', onSnapshot, onData });
    const ws = lastWs();
    ws.open();
    ackSubscribe(ws, handle.subscriberId, { data: 'INIT', seq: 5 });
    expect(onSnapshot).toHaveBeenCalledWith({ cols: 80, rows: 24, data: 'INIT' });
    expect(onData).not.toHaveBeenCalled();
  });

  it('live data during snapshotPending is queued, then flushed in order with seq>snapshotSeq', () => {
    const { client, lastWs } = makeClient();
    const onSnapshot = vi.fn();
    const onData = vi.fn();
    const handle = client.subscribe({ agentId: 'dev-1', mode: 'preview', onSnapshot, onData });
    const ws = lastWs();
    ws.open();
    ws.push({ type: 'data', agentId: 'dev-1', data: 'A', seq: 3 });
    ws.push({ type: 'data', agentId: 'dev-1', data: 'B', seq: 6 });
    ws.push({ type: 'snapshot', subscriberId: handle.subscriberId, cols: 80, rows: 24, data: 'SNAP', snapshotSeq: 5 });
    ws.push({ type: 'data', agentId: 'dev-1', data: 'C', seq: 7 });
    ws.push({ type: 'subscribed', subscriberId: handle.subscriberId, agentId: 'dev-1', cols: 80, rows: 24, snapshotSeq: 5 });

    expect(onSnapshot).toHaveBeenCalledWith({ cols: 80, rows: 24, data: 'SNAP' });
    expect(onData.mock.calls.map((c) => c[0])).toEqual(['B', 'C']);
  });

  it('two subs of same agent, only second is pending — first sees live immediately, second skips snapshot-included data', () => {
    const { client, lastWs } = makeClient();
    const onSnap1 = vi.fn();
    const onData1 = vi.fn();
    const h1 = client.subscribe({ agentId: 'dev-1', mode: 'full', onSnapshot: onSnap1, onData: onData1 });
    const ws = lastWs();
    ws.open();
    ackSubscribe(ws, h1.subscriberId, { data: 'INIT', seq: 0 });

    const onSnap2 = vi.fn();
    const onData2 = vi.fn();
    const h2 = client.subscribe({ agentId: 'dev-1', mode: 'preview', onSnapshot: onSnap2, onData: onData2 });

    // Live data while h2 is pending; h1 sees immediately, h2 queues.
    ws.push({ type: 'data', agentId: 'dev-1', data: 'X', seq: 4 });
    expect(onData1).toHaveBeenCalledWith('X');

    ackSubscribe(ws, h2.subscriberId, { data: 'INIT_X', seq: 4 });

    expect(onSnap2).toHaveBeenCalledWith({ cols: 80, rows: 24, data: 'INIT_X' });
    // 'X' had seq=4, snapshotSeq for h2 = 4 → not greater, must be skipped (already in snapshot).
    expect(onData2).not.toHaveBeenCalled();

    // New live event after h2 active should flow to both.
    ws.push({ type: 'data', agentId: 'dev-1', data: 'Y', seq: 5 });
    expect(onData1).toHaveBeenCalledWith('Y');
    expect(onData2).toHaveBeenCalledWith('Y');
  });

  it('reconnect resubscribes all subs and snapshot restores screen', () => {
    const { client, lastWs } = makeClient();
    const onSnap = vi.fn();
    const onData = vi.fn();
    const h = client.subscribe({ agentId: 'dev-1', mode: 'full', onSnapshot: onSnap, onData });
    const ws1 = lastWs();
    ws1.open();
    ackSubscribe(ws1, h.subscriberId, { data: 'BEFORE', seq: 1 });
    expect(onSnap).toHaveBeenCalledTimes(1);

    ws1.closeFromServer();
    vi.advanceTimersByTime(500);
    const ws2 = lastWs();
    expect(ws2).not.toBe(ws1);

    ws2.open();
    const sent = ws2.sentParsed();
    expect(sent[0]).toMatchObject({ op: 'subscribe', subscriberId: h.subscriberId, agentId: 'dev-1', mode: 'full' });

    ackSubscribe(ws2, h.subscriberId, { data: 'AFTER', seq: 9 });
    expect(onSnap).toHaveBeenCalledTimes(2);
    expect(onSnap.mock.calls[1][0]).toEqual({ cols: 80, rows: 24, data: 'AFTER' });
  });

  it('resize before subscribed is stashed and re-sent after subscribed', () => {
    const { client, lastWs } = makeClient();
    const h = client.subscribe({ agentId: 'dev-1', mode: 'full', onSnapshot: vi.fn(), onData: vi.fn() });
    const ws = lastWs();
    ws.open();
    // Simulate component calling resize before server has acked subscribe.
    client.resize(h.subscriberId, 120, 40);
    // No resize op should have been emitted yet.
    expect(ws.sentParsed().filter((m) => m.op === 'resize')).toHaveLength(0);

    ackSubscribe(ws, h.subscriberId, { data: '', seq: 0 });

    const resizes = ws.sentParsed().filter((m) => m.op === 'resize');
    expect(resizes).toHaveLength(1);
    expect(resizes[0]).toMatchObject({ subscriberId: h.subscriberId, cols: 120, rows: 40 });
  });

  it('session_gone fires onSessionGone for matching agent subs only', () => {
    const { client, lastWs } = makeClient();
    const aGone = vi.fn();
    const bGone = vi.fn();
    client.subscribe({ agentId: 'dev-1', mode: 'preview', onSnapshot: vi.fn(), onData: vi.fn(), onSessionGone: aGone });
    client.subscribe({ agentId: 'qa-1', mode: 'preview', onSnapshot: vi.fn(), onData: vi.fn(), onSessionGone: bGone });
    const ws = lastWs();
    ws.open();
    ws.push({ type: 'session_gone', agentId: 'dev-1' });
    expect(aGone).toHaveBeenCalledTimes(1);
    expect(bGone).not.toHaveBeenCalled();
  });

  it('per-subscriber error routes onError', () => {
    const { client, lastWs } = makeClient();
    const onError = vi.fn();
    const h = client.subscribe({ agentId: 'dev-1', mode: 'full', onSnapshot: vi.fn(), onData: vi.fn(), onError });
    const ws = lastWs();
    ws.open();
    ws.push({ type: 'error', subscriberId: h.subscriberId, code: 'tmux_too_old', message: 'need 3.4+' });
    expect(onError).toHaveBeenCalledWith({ code: 'tmux_too_old', message: 'need 3.4+' });
  });

  it('unsubscribe removes sub state and stops subsequent dispatch', () => {
    const { client, lastWs } = makeClient();
    const onData = vi.fn();
    const h = client.subscribe({ agentId: 'dev-1', mode: 'preview', onSnapshot: vi.fn(), onData });
    const ws = lastWs();
    ws.open();
    ackSubscribe(ws, h.subscriberId, { data: '', seq: 0 });
    h.unsubscribe();
    ws.push({ type: 'data', agentId: 'dev-1', data: 'late', seq: 1 });
    expect(onData).not.toHaveBeenCalled();
    const sent = ws.sentParsed();
    expect(sent.some((m) => m.op === 'unsubscribe' && m.subscriberId === h.subscriberId)).toBe(true);
  });

  it('closes socket when last subscriber unsubscribes', () => {
    const { client, lastWs } = makeClient();
    const h = client.subscribe({ agentId: 'dev-1', mode: 'preview', onSnapshot: vi.fn(), onData: vi.fn() });
    const ws = lastWs();
    ws.open();
    expect(ws.readyState).toBe(MockWebSocket.OPEN);
    h.unsubscribe();
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });

  it('skips reconnect when subs is empty', () => {
    const { client, lastWs } = makeClient();
    const h = client.subscribe({ agentId: 'dev-1', mode: 'preview', onSnapshot: vi.fn(), onData: vi.fn() });
    const ws = lastWs();
    ws.open();
    h.unsubscribe();
    // unsubscribe path tore down ws; advancing past every backoff must not
    // open a fresh ws because there are no consumers left.
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('cancels pending reconnect when subscribe forces a new socket', () => {
    const { client, lastWs } = makeClient();
    const h1 = client.subscribe({ agentId: 'dev-1', mode: 'preview', onSnapshot: vi.fn(), onData: vi.fn() });
    const ws1 = lastWs();
    ws1.open();
    ws1.closeFromServer();
    // After unsubscribe→teardown, a *fresh* subscribe goes through ensureSocket→openSocket:
    // we want exactly one new ws opened, with no straggler from the backoff timer.
    h1.unsubscribe();
    client.subscribe({ agentId: 'dev-2', mode: 'preview', onSnapshot: vi.fn(), onData: vi.fn() });
    const before = MockWebSocket.instances.length;
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances.length).toBe(before);
  });

  it('send() during ws OPEN but sub still pending parks input, then flushes on subscribed', () => {
    const { client, lastWs } = makeClient();
    const h = client.subscribe({ agentId: 'dev-1', mode: 'full', onSnapshot: vi.fn(), onData: vi.fn() });
    const ws = lastWs();
    ws.open();
    // ws is OPEN, subscribe was forwarded, but server hasn't ack'd yet → sub is pending.
    client.send(h.subscriberId, 'pre-ack-keystroke');
    expect(ws.sentParsed().some((m) => m.op === 'input')).toBe(false);
    ackSubscribe(ws, h.subscriberId, { data: '', seq: 0 });
    const inputs = ws.sentParsed().filter((m) => m.op === 'input');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ subscriberId: h.subscriberId, data: 'pre-ack-keystroke' });
  });

  it('input queued during sub-pending is flushed once subscribed acks (not lost)', () => {
    const { client, lastWs } = makeClient();
    const h = client.subscribe({ agentId: 'dev-1', mode: 'full', onSnapshot: vi.fn(), onData: vi.fn() });
    const ws = lastWs();
    ws.open();
    ws.closeFromServer();
    // Disconnected: input goes to outbox.
    client.send(h.subscriberId, 'typed-while-down');
    vi.advanceTimersByTime(500);
    const ws2 = lastWs();
    expect(ws2).not.toBe(ws);
    ws2.open();
    // Right after onopen, the sub is back in pending; outbox flush MUST NOT
    // drop the input. It belongs in outbox until subscribed ack arrives.
    expect(ws2.sentParsed().some((m) => m.op === 'input')).toBe(false);
    ackSubscribe(ws2, h.subscriberId, { data: '', seq: 0 });
    const inputs = ws2.sentParsed().filter((m) => m.op === 'input');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ subscriberId: h.subscriberId, data: 'typed-while-down' });
  });
});
