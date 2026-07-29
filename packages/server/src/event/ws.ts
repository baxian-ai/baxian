import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type {
  EventsClientMsg,
  EventsServerMsg,
  EventsTopic,
} from '../shared/index.js';
import {
  extractTokenFromProtocols,
  isAllowedOrigin,
} from '../terminal/ws-auth.js';
import {
  buildAgentSnapshotById,
  buildAllAgentSnapshots,
} from '../state/snapshot.js';
import { isTaskOpen } from '../shared/index.js';

const TOPIC_PATTERN = /^(agents|agent:[A-Za-z0-9_-]+|task:[A-Za-z0-9_-]+|project-tasks:[A-Za-z0-9_-]+|pollers)$/;

export async function eventsWsPlugin(app: FastifyInstance): Promise<void> {
  app.get(
    '/realtime',
    {
      websocket: true,
      preValidation: async (request: FastifyRequest, reply: FastifyReply) => {
        const origin = request.headers.origin as string | undefined;
        const host = request.headers.host as string | undefined;
        if (!isAllowedOrigin(origin, host)) {
          return reply.status(403).send({ error: 'cross_origin_rejected' });
        }
        const configToken = app.ctx.config.server.token;
        if (configToken) {
          const protoHeader = request.headers['sec-websocket-protocol'] as string | string[] | undefined;
          const supplied = extractTokenFromProtocols(protoHeader);
          if (supplied !== configToken) {
            return reply.status(401).send({ error: 'unauthorized' });
          }
        }
      },
    },
    (socket, request) => handleConnection(app, socket, request),
  );
}

function handleConnection(
  app: FastifyInstance,
  socket: import('@fastify/websocket').WebSocket,
  request: FastifyRequest,
): void {
  const subs = new Map<EventsTopic, () => void>();

  function safeSend(msg: EventsServerMsg): void {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify(msg));
    } catch (err) {
      console.warn('[events-ws] send failed:', err);
    }
  }

  function sendData(topic: EventsTopic, data: unknown): void {
    safeSend({ type: 'data', topic, data } as EventsServerMsg);
  }

  async function handleSubscribe(topic: EventsTopic): Promise<void> {
    const broker = app.ctx.eventBroker;
    if (!broker) {
      safeSend({ type: 'error', topic, code: 'broker_unavailable', message: 'event broker not configured' });
      return;
    }

    if (subs.has(topic)) {
      return;
    }

    let buffer: unknown[] | null = [];
    const unsub = broker.subscribe(topic, (data) => {
      if (buffer !== null) buffer.push(data);
      else sendData(topic, data);
    });
    subs.set(topic, unsub);

    try {
      const snapshot = await fetchSnapshot(app, topic);
      if (!subs.has(topic)) {
        buffer = null;
        return;
      }
      sendData(topic, snapshot);
      const drain = buffer;
      buffer = null;
      for (const d of drain) sendData(topic, d);
    } catch (err) {
      buffer = null;
      console.warn(`[events-ws] snapshot fetch failed for ${topic}:`, err);
      safeSend({
        type: 'error',
        topic,
        code: 'snapshot_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function handleUnsubscribe(topic: EventsTopic): void {
    const unsub = subs.get(topic);
    if (!unsub) return;
    try {
      unsub();
    } catch (err) {
      console.warn('[events-ws] broker unsubscribe failed:', err);
    }
    subs.delete(topic);
  }

  socket.on('message', async (raw: { toString(): string }) => {
    let msg: EventsClientMsg;
    try {
      msg = JSON.parse(raw.toString()) as EventsClientMsg;
    } catch {
      safeSend({ type: 'error', code: 'invalid_message', message: 'failed to parse JSON' });
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof (msg as { op?: unknown }).op !== 'string') {
      safeSend({ type: 'error', code: 'invalid_message', message: 'message must have { op: string }' });
      return;
    }
    switch (msg.op) {
      case 'subscribe':
      case 'unsubscribe': {
        const topic = (msg as { topic?: unknown }).topic;
        if (typeof topic !== 'string' || !TOPIC_PATTERN.test(topic)) {
          safeSend({
            type: 'error',
            code: 'invalid_topic',
            message: 'topic must match agents | agent:<id> | task:<id> | project-tasks:<projectId> | pollers',
          });
          return;
        }
        if (msg.op === 'subscribe') await handleSubscribe(topic as EventsTopic);
        else handleUnsubscribe(topic as EventsTopic);
        break;
      }
      case 'ping':
        safeSend({ type: 'pong' });
        break;
      default:
        safeSend({
          type: 'error',
          code: 'unknown_op',
          message: `unknown op: ${(msg as { op: string }).op}`,
        });
    }
  });

  socket.on('close', () => {
    for (const unsub of subs.values()) {
      try {
        unsub();
      } catch {
      }
    }
    subs.clear();
  });

  socket.on('error', (err: unknown) => {
    console.warn('[events-ws] socket error:', err);
  });

  void request;
}

async function fetchSnapshot(
  app: FastifyInstance,
  topic: EventsTopic,
): Promise<unknown> {
  if (topic === 'agents') return await buildAllAgentSnapshots(app.ctx);
  if (topic === 'pollers') return app.ctx.poller?.snapshots() ?? [];
  if (topic.startsWith('agent:')) {
    return await buildAgentSnapshotById(app.ctx, topic.slice('agent:'.length));
  }
  if (topic.startsWith('task:')) {
    const task = await app.ctx.taskStore.get(topic.slice('task:'.length));
    return task;
  }
  if (topic.startsWith('project-tasks:')) {
    const tasks = await app.ctx.taskStore.list({ projectId: topic.slice('project-tasks:'.length) });
    return tasks.filter((t) => isTaskOpen(t.status));
  }
  throw new Error(`unsupported topic: ${topic}`);
}
