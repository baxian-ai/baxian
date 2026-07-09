import type {
  StreamClientMsg,
  StreamServerMsg,
  StreamSubMode,
} from '../shared/index.js';
import { getAuthToken } from '../api.ts';
import { ReconnectScheduler } from './reconnect-scheduler.ts';
import { defaultWsFactory, toHex, wsUrl, type WebSocketFactory } from './ws-shared.ts';

export interface SnapshotPayload {
  cols: number;
  rows: number;
  data: string;
}

export interface StreamErrorPayload {
  code: string;
  message: string;
}

export interface SubscribeArgs {
  agentId: string;
  mode: StreamSubMode;
  onSnapshot: (msg: SnapshotPayload) => void;
  onData: (data: string) => void;
  onError?: (msg: StreamErrorPayload) => void;
  onSessionGone?: () => void;
}

export interface PaneStreamHandle {
  subscriberId: string;
  unsubscribe: () => void;
}

interface Subscription {
  subscriberId: string;
  agentId: string;
  mode: StreamSubMode;
  onSnapshot: (msg: SnapshotPayload) => void;
  onData: (data: string) => void;
  onError?: (msg: StreamErrorPayload) => void;
  onSessionGone?: () => void;
  lastSize?: { cols: number; rows: number };
  snapshotSeq?: number;
}

let subscriberCounter = 0;
function genSubscriberId(): string {
  subscriberCounter++;
  const rand = Math.random().toString(36).slice(2, 8);
  return `sub-${Date.now().toString(36)}-${subscriberCounter}-${rand}`;
}

function defaultWsUrl(): string {
  return wsUrl('/api/stream');
}

export interface PaneStreamClientOptions {
  wsUrl?: string;
  wsFactory?: WebSocketFactory;
  tokenProvider?: () => string | null;
}

export class PaneStreamClient {
  private readonly wsUrl: string;
  private readonly wsFactory: WebSocketFactory;
  private readonly tokenProvider: () => string | null;

  private ws: WebSocket | null = null;
  private subs = new Map<string, Subscription>();
  private snapshotPending = new Set<string>();
  private preSubscribeQueue = new Map<string, Array<{ seq: number; data: string }>>();
  private outbox: StreamClientMsg[] = [];
  private readonly reconnectScheduler: ReconnectScheduler;
  private explicitlyClosed = false;

  constructor(opts: PaneStreamClientOptions = {}) {
    this.wsUrl = opts.wsUrl ?? defaultWsUrl();
    this.wsFactory = opts.wsFactory ?? defaultWsFactory;
    this.tokenProvider = opts.tokenProvider ?? getAuthToken;
    this.reconnectScheduler = new ReconnectScheduler({
      reconnect: () => this.openSocket(),
      shouldReconnect: () => !this.explicitlyClosed && this.subs.size > 0,
    });
  }

  subscribe(args: SubscribeArgs): PaneStreamHandle {
    const subscriberId = genSubscriberId();
    const sub: Subscription = {
      subscriberId,
      agentId: args.agentId,
      mode: args.mode,
      onSnapshot: args.onSnapshot,
      onData: args.onData,
      onError: args.onError,
      onSessionGone: args.onSessionGone,
    };
    this.subs.set(subscriberId, sub);
    this.snapshotPending.add(subscriberId);
    this.preSubscribeQueue.set(subscriberId, []);

    this.ensureSocket();
    this.wsSendOrQueue({
      op: 'subscribe',
      subscriberId,
      agentId: args.agentId,
      mode: args.mode,
    });

    return {
      subscriberId,
      unsubscribe: () => this.unsubscribe(subscriberId),
    };
  }

  send(subscriberId: string, data: string): void {
    if (!this.subs.has(subscriberId)) return;
    if (this.snapshotPending.has(subscriberId)) {
      this.outbox.push({ op: 'input', subscriberId, data });
      return;
    }
    this.wsSendOrQueue({ op: 'input', subscriberId, data });
  }

  resize(subscriberId: string, cols: number, rows: number): void {
    const sub = this.subs.get(subscriberId);
    if (!sub) return;
    sub.lastSize = { cols, rows };
    if (this.snapshotPending.has(subscriberId)) return;
    this.wsSendOrQueue({ op: 'resize', subscriberId, cols, rows });
  }

  ping(): void {
    this.wsSendOrQueue({ op: 'ping' });
  }

  close(): void {
    this.explicitlyClosed = true;
    this.reconnectScheduler.cancel();
    this.reconnectScheduler.reset();
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.subs.clear();
    this.snapshotPending.clear();
    this.preSubscribeQueue.clear();
    this.outbox = [];
  }

  private unsubscribe(subscriberId: string): void {
    if (!this.subs.has(subscriberId)) return;
    this.subs.delete(subscriberId);
    this.snapshotPending.delete(subscriberId);
    this.preSubscribeQueue.delete(subscriberId);
    this.wsSendOrQueue({ op: 'unsubscribe', subscriberId });
    if (this.subs.size === 0) this.teardownSocket();
  }

  private teardownSocket(): void {
    this.reconnectScheduler.cancel();
    this.reconnectScheduler.reset();
    this.outbox = [];
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  private ensureSocket(): void {
    if (this.explicitlyClosed) return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.openSocket();
  }

  private openSocket(): void {
    if (this.explicitlyClosed) return;
    this.reconnectScheduler.cancel();
    const token = this.tokenProvider();
    const protocols = token ? [`baxian.token.${toHex(token)}`] : undefined;
    let ws: WebSocket;
    try {
      ws = this.wsFactory(this.wsUrl, protocols);
    } catch (err) {
      console.warn('[pane-stream] WebSocket constructor threw:', err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.reconnectScheduler.reset();
      for (const sub of this.subs.values()) {
        this.snapshotPending.add(sub.subscriberId);
        this.preSubscribeQueue.set(sub.subscriberId, []);
        sub.snapshotSeq = undefined;
        try {
          ws.send(
            JSON.stringify({
              op: 'subscribe',
              subscriberId: sub.subscriberId,
              agentId: sub.agentId,
              mode: sub.mode,
            } satisfies StreamClientMsg),
          );
        } catch (err) {
          console.warn('[pane-stream] resubscribe send failed:', err);
        }
      }
      const pending = this.outbox;
      this.outbox = [];
      for (const m of pending) {
        if (m.op === 'subscribe') continue;
        if ('subscriberId' in m && m.subscriberId) {
          if (!this.subs.has(m.subscriberId)) continue;
          if (this.snapshotPending.has(m.subscriberId) && m.op !== 'unsubscribe') {
            this.outbox.push(m);
            continue;
          }
        }
        try {
          ws.send(JSON.stringify(m));
        } catch (err) {
          console.warn('[pane-stream] outbox flush failed:', err);
        }
      }
    };

    ws.onmessage = (evt) => {
      if (ws !== this.ws) return;
      let msg: StreamServerMsg;
      try {
        const text = typeof evt.data === 'string' ? evt.data : String(evt.data);
        msg = JSON.parse(text) as StreamServerMsg;
      } catch {
        return;
      }
      this.handleMessage(msg);
    };

    ws.onclose = () => {
      if (ws !== this.ws) return;
      this.ws = null;
      if (this.explicitlyClosed) return;
      if (this.subs.size === 0) return;
      this.scheduleReconnect();
    };

    ws.onerror = () => {};
  }

  private scheduleReconnect(): void {
    this.reconnectScheduler.schedule();
  }

  private wsSendOrQueue(msg: StreamClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(msg));
        return;
      } catch (err) {
        console.warn('[pane-stream] send failed, will queue:', err);
      }
    }
    this.outbox.push(msg);
  }

  private handleMessage(msg: StreamServerMsg): void {
    switch (msg.type) {
      case 'snapshot':
        this.handleSnapshot(msg);
        break;
      case 'subscribed':
        this.handleSubscribed(msg);
        break;
      case 'data':
        this.dispatch(msg);
        break;
      case 'session_gone':
        for (const sub of [...this.subs.values()]) {
          if (sub.agentId === msg.agentId) sub.onSessionGone?.();
        }
        break;
      case 'error': {
        if (msg.subscriberId) {
          const sub = this.subs.get(msg.subscriberId);
          sub?.onError?.({ code: msg.code, message: msg.message });
        } else {
          console.warn('[pane-stream] connection-level error:', msg.code, msg.message);
        }
        break;
      }
      case 'pong':
        break;
    }
  }

  private handleSnapshot(msg: Extract<StreamServerMsg, { type: 'snapshot' }>): void {
    const sub = this.subs.get(msg.subscriberId);
    if (!sub) return;
    sub.onSnapshot({ cols: msg.cols, rows: msg.rows, data: msg.data });
  }

  private handleSubscribed(msg: Extract<StreamServerMsg, { type: 'subscribed' }>): void {
    const sub = this.subs.get(msg.subscriberId);
    if (!sub) return;
    sub.snapshotSeq = msg.snapshotSeq;
    if (!sub.lastSize) sub.lastSize = { cols: msg.cols, rows: msg.rows };
    this.snapshotPending.delete(msg.subscriberId);

    const queued = this.preSubscribeQueue.get(msg.subscriberId);
    this.preSubscribeQueue.delete(msg.subscriberId);
    if (queued) {
      for (const item of queued) {
        if (item.seq > msg.snapshotSeq) sub.onData(item.data);
      }
    }

    if (sub.mode === 'full' && sub.lastSize) {
      this.wsSendOrQueue({
        op: 'resize',
        subscriberId: sub.subscriberId,
        cols: sub.lastSize.cols,
        rows: sub.lastSize.rows,
      });
    }
    this.flushOutboxForSub(msg.subscriberId);
  }

  private flushOutboxForSub(subscriberId: string): void {
    if (this.outbox.length === 0) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const remaining: StreamClientMsg[] = [];
    for (const m of this.outbox) {
      if (
        'subscriberId' in m
        && m.subscriberId === subscriberId
        && m.op !== 'subscribe'
      ) {
        try {
          this.ws.send(JSON.stringify(m));
        } catch (err) {
          console.warn('[pane-stream] flushOutboxForSub send failed:', err);
        }
      } else {
        remaining.push(m);
      }
    }
    this.outbox = remaining;
  }

  private dispatch(msg: Extract<StreamServerMsg, { type: 'data' }>): void {
    for (const sub of this.subs.values()) {
      if (sub.agentId !== msg.agentId) continue;
      if (this.snapshotPending.has(sub.subscriberId)) {
        const q = this.preSubscribeQueue.get(sub.subscriberId);
        if (q) q.push({ seq: msg.seq, data: msg.data });
      } else {
        sub.onData(msg.data);
      }
    }
  }
}

let singleton: PaneStreamClient | null = null;

export function getPaneStreamClient(): PaneStreamClient {
  if (!singleton) singleton = new PaneStreamClient();
  return singleton;
}

export function _resetPaneStreamClientForTest(client?: PaneStreamClient | null): void {
  if (singleton) singleton.close();
  singleton = client ?? null;
}
