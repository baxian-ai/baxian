import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import type { AgentSnapshot, EventsServerMsg, TaskState } from '../../src/shared/index.js';
import { buildApp, type AppContext } from '../../src/app.js';
import { createTestContext } from '../helpers/context.js';
import { EventBroker } from '../../src/event/broker.js';
import { EventPublisher } from '../../src/event/publish.js';

let tempDir: string;
let runningApp: FastifyInstance | null = null;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-eventsws-test-'));
});

afterEach(async () => {
  if (runningApp) {
    await runningApp.close();
    runningApp = null;
  }
  await rm(tempDir, { recursive: true });
});

async function startApp(opts: { configToken?: string; noBroker?: boolean } = {}): Promise<{
  app: FastifyInstance;
  port: number;
  ctx: AppContext;
  broker: EventBroker;
}> {
  const ctx = await createTestContext(tempDir);
  if (opts.configToken) {
    ctx.config = { ...ctx.config, server: { ...ctx.config.server, token: opts.configToken } };
  }
  const broker = new EventBroker();
  if (!opts.noBroker) {
    ctx.eventBroker = broker;
    const snapshotCtx = {
      agentManager: ctx.agentManager,
      agentStore: ctx.agentStore,
      taskStore: ctx.taskStore,
      tmuxSessionStatusStore: ctx.tmuxSessionStatusStore,
    };
    const publisher = new EventPublisher(broker, snapshotCtx, ctx.taskStore, { agentsDebounceMs: 0 });
    ctx.agentStore.onChange((kind, id) => publisher.publishAgentChange(kind, id));
    ctx.tmuxSessionStatusStore.onChange((kind, id) => publisher.publishAgentChange(kind, id));
    ctx.taskStore.onChange((kind, id) => publisher.publishTaskChange(kind, id));
  }
  const app = await buildApp(ctx);
  runningApp = app;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  return { app, port: address.port, ctx, broker };
}

function openWs(port: number, protocols?: string | string[]): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/api/realtime`, protocols, {
    headers: { origin: `http://127.0.0.1:${port}` },
  });
}

function waitOpen(ws: WebSocket): Promise<{ kind: 'open' } | { kind: 'error'; status?: number }> {
  return new Promise((resolve) => {
    ws.on('open', () => resolve({ kind: 'open' }));
    ws.on('unexpected-response', (_req, res) => resolve({ kind: 'error', status: res.statusCode }));
    ws.on('error', () => { });
  });
}

function nextMsg(ws: WebSocket): Promise<EventsServerMsg> {
  return new Promise((resolve) => {
    ws.once('message', (raw) => {
      resolve(JSON.parse(String(raw)) as EventsServerMsg);
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPredicate(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await sleep(10);
  }
  expect(predicate()).toBe(true);
}

describe('events ws plugin (/api/realtime)', () => {
  it('rejects with 401 when no token is presented and config requires one', async () => {
    const { port } = await startApp({ configToken: 'secret' });
    const ws = openWs(port);
    const result = await waitOpen(ws);
    expect(result).toEqual({ kind: 'error', status: 401 });
  });

  it('subscribe to "agents" returns initial snapshot then live updates', async () => {
    const { port, ctx } = await startApp();
    const ws = openWs(port);
    expect((await waitOpen(ws)).kind).toBe('open');

    ws.send(JSON.stringify({ op: 'subscribe', topic: 'agents' }));
    const initial = await nextMsg(ws);
    expect(initial.type).toBe('data');
    if (initial.type === 'data' && initial.topic === 'agents') {
      expect(Array.isArray(initial.data)).toBe(true);
    }

    await ctx.agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: 'task-live',
      updatedAt: new Date().toISOString(),
    });
    const update = await nextMsg(ws);
    expect(update.type).toBe('data');
    if (update.type === 'data' && update.topic === 'agents') {
      const dev1 = (update.data as AgentSnapshot[]).find((a) => a.id === 'dev-1');
      expect(dev1?.binding?.taskId).toBe('task-live');
    }
    ws.close();
  });

  it('subscribe to "task:<id>" returns null when the task is missing, then the task on set', async () => {
    const { port, ctx } = await startApp();
    const ws = openWs(port);
    expect((await waitOpen(ws)).kind).toBe('open');

    ws.send(JSON.stringify({ op: 'subscribe', topic: 'task:t-missing' }));
    const initial = await nextMsg(ws);
    expect(initial).toMatchObject({ type: 'data', topic: 'task:t-missing', data: null });

    const now = new Date().toISOString();
    await ctx.taskStore.set({
      id: 't-missing',
      projectId: 'proj',
      title: 'sample',
      description: '',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      devAgentId: 'dev-1',
      phase: 'code',
      reviewRound: 0,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
    const update = await nextMsg(ws);
    expect(update.type).toBe('data');
    if (update.type === 'data' && update.topic === 'task:t-missing') {
      const task = update.data as TaskState | null;
      expect(task?.id).toBe('t-missing');
      expect(task?.status).toBe('pending');
    }
    ws.close();
  });

  it('rejects invalid topics with an error frame, no broker subscription', async () => {
    const { port, broker } = await startApp();
    const ws = openWs(port);
    expect((await waitOpen(ws)).kind).toBe('open');
    ws.send(JSON.stringify({ op: 'subscribe', topic: 'wat' }));
    const reply = await nextMsg(ws);
    expect(reply).toMatchObject({ type: 'error', code: 'invalid_topic' });
    expect(broker.hasSubscribers('agents')).toBe(false);
    ws.close();
  });

  it('dup subscribe to a topic already active on this socket is a silent no-op (no re-snapshot race)', async () => {
    const { port, broker } = await startApp();
    const subscribeSpy = vi.spyOn(broker, 'subscribe');
    const ws = openWs(port);
    expect((await waitOpen(ws)).kind).toBe('open');
    const frames: EventsServerMsg[] = [];
    ws.on('message', (raw) => frames.push(JSON.parse(String(raw)) as EventsServerMsg));

    ws.send(JSON.stringify({ op: 'subscribe', topic: 'agents' }));
    await waitForPredicate(() => frames.filter((f) => f.type === 'data').length === 1);
    const initialDataFrames = frames.filter((f) => f.type === 'data').length;
    expect(initialDataFrames).toBe(1);
    expect(subscribeSpy).toHaveBeenCalledTimes(1);

    ws.send(JSON.stringify({ op: 'subscribe', topic: 'agents' }));
    ws.send(JSON.stringify({ op: 'ping' }));
    await waitForPredicate(() => frames.some((f) => f.type === 'pong'));
    await sleep(30);
    expect(frames.filter((f) => f.type === 'data').length).toBe(initialDataFrames);
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    expect(broker.hasSubscribers('agents')).toBe(true);
    ws.close();
  });

  it('ping → pong heartbeat', async () => {
    const { port } = await startApp();
    const ws = openWs(port);
    expect((await waitOpen(ws)).kind).toBe('open');
    ws.send(JSON.stringify({ op: 'ping' }));
    const reply = await nextMsg(ws);
    expect(reply).toEqual({ type: 'pong' });
    ws.close();
  });

  it('live publish during snapshot fetch is buffered and flushed AFTER snapshot in order', async () => {
    const { port, ctx, broker } = await startApp();

    let resolveFetch: ((task: { id: string; v: number } | null) => void) | null = null;
    const stalled = new Promise<{ id: string; v: number } | null>((r) => {
      resolveFetch = r;
    });
    const real = ctx.taskStore.get.bind(ctx.taskStore);
    ctx.taskStore.get = vi.fn(async (id: string) => {
      if (id === 't1') return (await stalled) as unknown as Awaited<ReturnType<typeof real>>;
      return real(id);
    });

    const ws = openWs(port);
    expect((await waitOpen(ws)).kind).toBe('open');
    const frames: EventsServerMsg[] = [];
    ws.on('message', (raw) => frames.push(JSON.parse(String(raw)) as EventsServerMsg));

    ws.send(JSON.stringify({ op: 'subscribe', topic: 'task:t1' }));
    await new Promise((r) => setTimeout(r, 30));

    broker.publish('task:t1', { id: 't1', v: 2 });

    resolveFetch!({ id: 't1', v: 1 });
    await new Promise((r) => setTimeout(r, 50));

    const dataFrames = frames.filter((f) => f.type === 'data') as Array<{ type: 'data'; data: { v: number } | null }>;
    expect(dataFrames.map((f) => f.data?.v)).toEqual([1, 2]);
    ws.close();
  });

  it('client unsubscribe during snapshot await skips the trailing snapshot send', async () => {
    const { port, ctx, broker } = await startApp();

    let resolveFetch: ((task: { id: string } | null) => void) | null = null;
    const stalled = new Promise<{ id: string } | null>((r) => {
      resolveFetch = r;
    });
    const real = ctx.taskStore.get.bind(ctx.taskStore);
    ctx.taskStore.get = vi.fn(async (id: string) => {
      if (id === 't2') return (await stalled) as unknown as Awaited<ReturnType<typeof real>>;
      return real(id);
    });

    const ws = openWs(port);
    expect((await waitOpen(ws)).kind).toBe('open');
    const frames: EventsServerMsg[] = [];
    ws.on('message', (raw) => frames.push(JSON.parse(String(raw)) as EventsServerMsg));

    ws.send(JSON.stringify({ op: 'subscribe', topic: 'task:t2' }));
    await new Promise((r) => setTimeout(r, 30));
    ws.send(JSON.stringify({ op: 'unsubscribe', topic: 'task:t2' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(broker.hasSubscribers('task:t2')).toBe(false);

    resolveFetch!({ id: 't2' });
    await new Promise((r) => setTimeout(r, 50));
    expect(frames.filter((f) => f.type === 'data')).toHaveLength(0);
    ws.close();
  });

  it('subscribe to "project-tasks:<id>" returns initial list, then live frames when tasks change', async () => {
    const { port, ctx } = await startApp();
    const ws = openWs(port);
    expect((await waitOpen(ws)).kind).toBe('open');

    ws.send(JSON.stringify({ op: 'subscribe', topic: 'project-tasks:proj' }));
    const initial = await nextMsg(ws);
    expect(initial.type).toBe('data');
    if (initial.type === 'data' && initial.topic === 'project-tasks:proj') {
      expect(initial.data).toEqual([]);
    }

    const now = new Date().toISOString();
    await ctx.taskStore.set({
      id: 'pt-1',
      projectId: 'proj',
      title: 'first',
      description: '',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      devAgentId: 'dev-1',
      phase: 'code',
      reviewRound: 1,
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
    });
    const update = await nextMsg(ws);
    expect(update.type).toBe('data');
    if (update.type === 'data' && update.topic === 'project-tasks:proj') {
      const list = update.data as TaskState[];
      expect(list.map(t => t.id)).toEqual(['pt-1']);
      expect(list[0].reviewRound).toBe(1);
    }
    ws.close();
  });

  it('project-tasks:<id> snapshot scopes by projectId so siblings do not bleed across project pages', async () => {
    const { port, ctx } = await startApp();
    const now = new Date().toISOString();
    await ctx.taskStore.set({
      id: 'p1-task',
      projectId: 'proj-a',
      title: 'a',
      description: '',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      devAgentId: 'dev-1',
      phase: 'code',
      reviewRound: 0,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
    await ctx.taskStore.set({
      id: 'p2-task',
      projectId: 'proj-b',
      title: 'b',
      description: '',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      devAgentId: 'dev-1',
      phase: 'code',
      reviewRound: 0,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });

    const ws = openWs(port);
    expect((await waitOpen(ws)).kind).toBe('open');
    ws.send(JSON.stringify({ op: 'subscribe', topic: 'project-tasks:proj-a' }));
    const initial = await nextMsg(ws);
    expect(initial.type).toBe('data');
    if (initial.type === 'data' && initial.topic === 'project-tasks:proj-a') {
      const ids = (initial.data as TaskState[]).map(t => t.id);
      expect(ids).toEqual(['p1-task']);
    }
    ws.close();
  });

  it('project-tasks:<id> snapshot excludes terminal (已处理) tasks so the realtime frame stays bounded', async () => {
    const { port, ctx } = await startApp();
    const now = new Date().toISOString();
    const base = {
      projectId: 'proj',
      title: 't',
      description: '',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      devAgentId: 'dev-1',
      phase: 'code',
      reviewRound: 0,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.taskStore.set({ ...base, id: 'open-1', status: 'in_progress' });
    await ctx.taskStore.set({ ...base, id: 'open-2', status: 'pending' });
    await ctx.taskStore.set({ ...base, id: 'done-1', status: 'merged' });
    await ctx.taskStore.set({ ...base, id: 'done-2', status: 'cancelled' });

    const ws = openWs(port);
    expect((await waitOpen(ws)).kind).toBe('open');
    ws.send(JSON.stringify({ op: 'subscribe', topic: 'project-tasks:proj' }));
    const initial = await nextMsg(ws);
    expect(initial.type).toBe('data');
    if (initial.type === 'data' && initial.topic === 'project-tasks:proj') {
      const ids = (initial.data as TaskState[]).map((t) => t.id).sort();
      expect(ids).toEqual(['open-1', 'open-2']);
    }
    ws.close();
  });

  it('a task transitioning to a terminal status drops out of the live project-tasks frame', async () => {
    const { port, ctx } = await startApp();
    const now = new Date().toISOString();
    const base = {
      projectId: 'proj',
      title: 't',
      description: '',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      devAgentId: 'dev-1',
      phase: 'code',
      reviewRound: 0,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.taskStore.set({ ...base, id: 'pt-1', status: 'in_progress' });

    const ws = openWs(port);
    expect((await waitOpen(ws)).kind).toBe('open');
    ws.send(JSON.stringify({ op: 'subscribe', topic: 'project-tasks:proj' }));
    const initial = await nextMsg(ws);
    if (initial.type === 'data' && initial.topic === 'project-tasks:proj') {
      expect((initial.data as TaskState[]).map((t) => t.id)).toEqual(['pt-1']);
    }

    await ctx.taskStore.set({ ...base, id: 'pt-1', status: 'merged', updatedAt: new Date().toISOString() });
    const update = await nextMsg(ws);
    expect(update.type).toBe('data');
    if (update.type === 'data' && update.topic === 'project-tasks:proj') {
      expect(update.data as TaskState[]).toEqual([]);
    }
    ws.close();
  });

  it('socket close releases broker subscriptions', async () => {
    const { port, broker } = await startApp();
    const ws = openWs(port);
    expect((await waitOpen(ws)).kind).toBe('open');
    ws.send(JSON.stringify({ op: 'subscribe', topic: 'agents' }));
    await nextMsg(ws);
    expect(broker.hasSubscribers('agents')).toBe(true);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(broker.hasSubscribers('agents')).toBe(false);
  });

  it('rejects with 403 when Origin host does not match Host', async () => {
    const { port } = await startApp();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/realtime`, undefined, {
      headers: { origin: 'http://evil.example' },
    });
    const result = await waitOpen(ws);
    expect(result).toEqual({ kind: 'error', status: 403 });
  });

  it('subscribe without a configured broker returns broker_unavailable', async () => {
    const { port } = await startApp({ noBroker: true });
    const ws = openWs(port);
    expect((await waitOpen(ws)).kind).toBe('open');
    ws.send(JSON.stringify({ op: 'subscribe', topic: 'agents' }));
    const reply = await nextMsg(ws);
    expect(reply).toMatchObject({ type: 'error', topic: 'agents', code: 'broker_unavailable' });
    ws.close();
  });

  it('snapshot fetch failure sends snapshot_failed but keeps the live subscription flowing', async () => {
    const { port, ctx, broker } = await startApp();
    ctx.taskStore.get = vi.fn(async () => { throw new Error('disk gone'); });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const ws = openWs(port);
      expect((await waitOpen(ws)).kind).toBe('open');
      const frames: EventsServerMsg[] = [];
      ws.on('message', (raw) => frames.push(JSON.parse(String(raw)) as EventsServerMsg));

      ws.send(JSON.stringify({ op: 'subscribe', topic: 'task:t9' }));
      await waitForPredicate(() => frames.some((f) => f.type === 'error'));
      expect(frames[0]).toMatchObject({ type: 'error', topic: 'task:t9', code: 'snapshot_failed', message: 'disk gone' });

      broker.publish('task:t9', { id: 't9', status: 'pending' });
      await waitForPredicate(() => frames.some((f) => f.type === 'data'));
      expect(frames.filter((f) => f.type === 'data')).toEqual([
        { type: 'data', topic: 'task:t9', data: { id: 't9', status: 'pending' } },
      ]);
      ws.close();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('a throwing broker unsubscribe is contained and the topic can be re-subscribed', async () => {
    const { port, broker } = await startApp();
    const subscribeSpy = vi.spyOn(broker, 'subscribe')
      .mockReturnValueOnce(() => { throw new Error('unsub boom'); });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const ws = openWs(port);
      expect((await waitOpen(ws)).kind).toBe('open');
      const frames: EventsServerMsg[] = [];
      ws.on('message', (raw) => frames.push(JSON.parse(String(raw)) as EventsServerMsg));

      ws.send(JSON.stringify({ op: 'subscribe', topic: 'agents' }));
      await waitForPredicate(() => frames.filter((f) => f.type === 'data').length === 1);

      ws.send(JSON.stringify({ op: 'unsubscribe', topic: 'agents' }));
      await waitForPredicate(() => warnSpy.mock.calls.some(
        (c) => String(c[0]).includes('[events-ws] broker unsubscribe failed:'),
      ));

      ws.send(JSON.stringify({ op: 'subscribe', topic: 'agents' }));
      await waitForPredicate(() => frames.filter((f) => f.type === 'data').length === 2);
      expect(subscribeSpy).toHaveBeenCalledTimes(2);
      ws.close();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('invalid JSON payload returns invalid_message', async () => {
    const { port } = await startApp();
    const ws = openWs(port);
    expect((await waitOpen(ws)).kind).toBe('open');
    ws.send('{oops');
    const reply = await nextMsg(ws);
    expect(reply).toMatchObject({ type: 'error', code: 'invalid_message', message: 'failed to parse JSON' });
    ws.close();
  });

  it('JSON without an op string returns invalid_message', async () => {
    const { port } = await startApp();
    const ws = openWs(port);
    expect((await waitOpen(ws)).kind).toBe('open');
    ws.send(JSON.stringify({ foo: 1 }));
    const reply = await nextMsg(ws);
    expect(reply).toMatchObject({ type: 'error', code: 'invalid_message', message: 'message must have { op: string }' });
    ws.close();
  });

  it('unknown op returns unknown_op with the offending op echoed', async () => {
    const { port } = await startApp();
    const ws = openWs(port);
    expect((await waitOpen(ws)).kind).toBe('open');
    ws.send(JSON.stringify({ op: 'dance' }));
    const reply = await nextMsg(ws);
    expect(reply).toMatchObject({ type: 'error', code: 'unknown_op', message: 'unknown op: dance' });
    ws.close();
  });

  it('a throwing unsubscribe during socket close does not take the server down', async () => {
    const { port, broker } = await startApp();
    vi.spyOn(broker, 'subscribe').mockReturnValueOnce(() => { throw new Error('unsub boom'); });

    const ws = openWs(port);
    expect((await waitOpen(ws)).kind).toBe('open');
    ws.send(JSON.stringify({ op: 'subscribe', topic: 'agents' }));
    await nextMsg(ws);
    ws.close();
    await sleep(50);

    const ws2 = openWs(port);
    expect((await waitOpen(ws2)).kind).toBe('open');
    ws2.send(JSON.stringify({ op: 'ping' }));
    expect(await nextMsg(ws2)).toEqual({ type: 'pong' });
    ws2.close();
  });

  it('transport-level socket errors are logged without crashing the server', async () => {
    const { port } = await startApp();
    const ws = openWs(port);
    expect((await waitOpen(ws)).kind).toBe('open');
    const inner = (ws as unknown as { _socket: { write: (b: Buffer) => boolean } })._socket;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      inner.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
      await sleep(100);
      const ws2 = openWs(port);
      expect((await waitOpen(ws2)).kind).toBe('open');
      ws2.close();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('subscribe to "agent:<id>" returns the single-agent snapshot', async () => {
    const { port, ctx } = await startApp();
    await ctx.agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: 'task-42',
      updatedAt: new Date().toISOString(),
    });

    const ws = openWs(port);
    expect((await waitOpen(ws)).kind).toBe('open');
    ws.send(JSON.stringify({ op: 'subscribe', topic: 'agent:dev-1' }));
    const initial = await nextMsg(ws);
    expect(initial.type).toBe('data');
    if (initial.type === 'data' && initial.topic === 'agent:dev-1') {
      const snapshot = initial.data as AgentSnapshot | null;
      expect(snapshot?.id).toBe('dev-1');
      expect(snapshot?.binding?.taskId).toBe('task-42');
    }
    ws.close();
  });
});
