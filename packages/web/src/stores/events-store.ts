import type {
  AgentSnapshot,
  EventsClientMsg,
  EventsServerMsg,
  EventsTopic,
  TaskState,
} from '../shared/index.js';
import { getAuthToken } from '../api.ts';
import { ReconnectScheduler } from './reconnect-scheduler.ts';

export interface EventsErrorPayload {
  code: string;
  message: string;
}

export type EventsHandler<T> = (data: T) => void;
export type EventsErrorHandler = (err: EventsErrorPayload) => void;

interface TopicSubscribers {
  data: Set<EventsHandler<unknown>>;
  error: Set<EventsErrorHandler>;
}

type WebSocketFactory = (url: string, protocols?: string[]) => WebSocket;

function toHex(s: string): string {
  return Array.from(new TextEncoder().encode(s))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function defaultWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/api/realtime`;
}

const defaultWsFactory: WebSocketFactory = (url, protocols) =>
  protocols && protocols.length > 0
    ? new WebSocket(url, protocols)
    : new WebSocket(url);

export interface EventsClientOptions {
  wsUrl?: string;
  wsFactory?: WebSocketFactory;
  tokenProvider?: () => string | null;
}

export class EventsClient {
  private readonly wsUrl: string;
  private readonly wsFactory: WebSocketFactory;
  private readonly tokenProvider: () => string | null;

  private ws: WebSocket | null = null;
  private topics = new Map<EventsTopic, TopicSubscribers>();
  private cache = new Map<EventsTopic, unknown>();
  private outbox: EventsClientMsg[] = [];
  private readonly reconnectScheduler: ReconnectScheduler;
  private explicitlyClosed = false;

  constructor(opts: EventsClientOptions = {}) {
    this.wsUrl = opts.wsUrl ?? defaultWsUrl();
    this.wsFactory = opts.wsFactory ?? defaultWsFactory;
    this.tokenProvider = opts.tokenProvider ?? getAuthToken;
    this.reconnectScheduler = new ReconnectScheduler({
      reconnect: () => this.openSocket(),
      shouldReconnect: () => !this.explicitlyClosed && this.topics.size > 0,
    });
  }

  subscribe<T>(
    topic: EventsTopic,
    onData: EventsHandler<T>,
    onError?: EventsErrorHandler,
  ): () => void {
    let entry = this.topics.get(topic);
    const wasEmpty = !entry;
    if (!entry) {
      entry = { data: new Set(), error: new Set() };
      this.topics.set(topic, entry);
    }
    entry.data.add(onData as EventsHandler<unknown>);
    if (onError) entry.error.add(onError);

    if (wasEmpty) {
      this.ensureSocket();
      this.wsSendOrQueue({ op: 'subscribe', topic });
    } else if (this.cache.has(topic)) {
      queueMicrotask(() => {
        if (!this.topics.get(topic)?.data.has(onData as EventsHandler<unknown>)) return;
        if (!this.cache.has(topic)) return;
        onData(this.cache.get(topic) as T);
      });
    }

    return () => this.unsubscribe(topic, onData, onError);
  }

  close(): void {
    this.explicitlyClosed = true;
    this.reconnectScheduler.cancel();
    this.reconnectScheduler.reset();
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.topics.clear();
    this.cache.clear();
    this.outbox = [];
  }

  private unsubscribe<T>(
    topic: EventsTopic,
    onData: EventsHandler<T>,
    onError: EventsErrorHandler | undefined,
  ): void {
    const entry = this.topics.get(topic);
    if (!entry) return;
    entry.data.delete(onData as EventsHandler<unknown>);
    if (onError) entry.error.delete(onError);
    if (entry.data.size === 0 && entry.error.size === 0) {
      this.topics.delete(topic);
      this.cache.delete(topic);
      this.wsSendOrQueue({ op: 'unsubscribe', topic });
      if (this.topics.size === 0) this.teardownSocket();
    }
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
      this.ws
      && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
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
      console.warn('[events-client] WebSocket constructor threw:', err);
      this.broadcastConnectionError({
        code: 'connection_failed',
        message: err instanceof Error ? err.message : 'WebSocket constructor threw',
      });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    let opened = false;

    ws.onopen = () => {
      if (ws !== this.ws) return;
      opened = true;
      this.reconnectScheduler.reset();
      for (const topic of this.topics.keys()) {
        try {
          ws.send(JSON.stringify({ op: 'subscribe', topic } satisfies EventsClientMsg));
        } catch (err) {
          console.warn('[events-client] resubscribe send failed:', err);
        }
      }
      const pending = this.outbox;
      this.outbox = [];
      for (const m of pending) {
        if (m.op === 'subscribe' || m.op === 'unsubscribe') continue;
        try {
          ws.send(JSON.stringify(m));
        } catch (err) {
          console.warn('[events-client] outbox flush failed:', err);
        }
      }
    };

    ws.onmessage = (evt) => {
      if (ws !== this.ws) return;
      let msg: EventsServerMsg;
      try {
        const text = typeof evt.data === 'string' ? evt.data : String(evt.data);
        msg = JSON.parse(text) as EventsServerMsg;
      } catch {
        return;
      }
      this.handleMessage(msg);
    };

    ws.onclose = () => {
      if (ws !== this.ws) return;
      this.ws = null;
      if (this.explicitlyClosed) return;
      if (!opened) {
        this.broadcastConnectionError({
          code: 'connection_failed',
          message: 'WebSocket failed to connect (auth, network, or proxy issue)',
        });
      }
      if (this.topics.size === 0) return;
      this.scheduleReconnect();
    };

    ws.onerror = () => {};
  }

  private scheduleReconnect(): void {
    this.reconnectScheduler.schedule();
  }

  private broadcastConnectionError(payload: EventsErrorPayload): void {
    for (const entry of this.topics.values()) {
      for (const fn of [...entry.error]) {
        try {
          fn(payload);
        } catch (err) {
          console.error('[events-client] error handler threw on connection error:', err);
        }
      }
    }
  }

  private wsSendOrQueue(msg: EventsClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(msg));
        return;
      } catch (err) {
        console.warn('[events-client] send failed, will queue:', err);
      }
    }
    this.outbox.push(msg);
  }

  private handleMessage(msg: EventsServerMsg): void {
    switch (msg.type) {
      case 'data': {
        const entry = this.topics.get(msg.topic);
        this.cache.set(msg.topic, msg.data);
        if (!entry) return;
        for (const fn of [...entry.data]) {
          try {
            fn(msg.data);
          } catch (err) {
            console.error(`[events-client] handler threw on ${msg.topic}:`, err);
          }
        }
        break;
      }
      case 'error': {
        const payload = { code: msg.code, message: msg.message };
        if (msg.topic) {
          const entry = this.topics.get(msg.topic);
          if (entry) {
            for (const fn of [...entry.error]) {
              try {
                fn(payload);
              } catch (err) {
                console.error(`[events-client] error handler threw on ${msg.topic}:`, err);
              }
            }
          }
        } else {
          console.warn('[events-client] connection-level error:', msg.code, msg.message);
        }
        break;
      }
      case 'pong':
        break;
    }
  }
}

let singleton: EventsClient | null = null;

export function getEventsClient(): EventsClient {
  if (!singleton) singleton = new EventsClient();
  return singleton;
}

export function _resetEventsClientForTest(client?: EventsClient | null): void {
  if (singleton) singleton.close();
  singleton = client ?? null;
}

export type AgentsTopicData = AgentSnapshot[];
export type AgentTopicData = AgentSnapshot | null;
export type TaskTopicData = TaskState | null;
