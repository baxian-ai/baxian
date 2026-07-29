import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { buildApp, type AppContext } from '../../src/app.js';
import { createTestContext } from '../helpers/context.js';
import { PaneStreamerManager } from '../../src/agent/pane-streamer-manager.js';
import type { MinimalPty, PtyFactory } from '../../src/agent/pane-streamer.js';
import type { BaxianEvent, StreamServerMsg } from '../../src/shared/index.js';

let tempDir: string;
let runningApp: FastifyInstance | null = null;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-streamws-test-'));
});

afterEach(async () => {
  if (runningApp) {
    await runningApp.close();
    runningApp = null;
  }
  await rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function createProbeAwarePty(cmd: { args: string[] }): MinimalPty {
  const isProbe = cmd.args.some((a) => typeof a === 'string' && a.includes('tmux -V'));
  let dataCb: ((data: string) => void) | null = null;
  let exitCb: ((e: { exitCode: number }) => void) | null = null;
  if (isProbe) {
    queueMicrotask(() => {
      dataCb?.('tmux 3.0a\n');
      exitCb?.({ exitCode: 0 });
    });
  }
  return {
    onData(cb) { dataCb = cb; return { dispose: () => undefined }; },
    onExit(cb) { exitCb = cb; return { dispose: () => undefined }; },
    resize() { },
    write() { },
    kill() { },
  };
}

async function startApp(opts?: {
  configToken?: string;
  withPaneStreamerManager?: boolean;
}): Promise<{ app: FastifyInstance; port: number; ctx: AppContext }> {
  const ctx = await createTestContext(tempDir);
  if (opts?.configToken) {
    ctx.config = { ...ctx.config, server: { ...ctx.config.server, token: opts.configToken } };
  }
  if (opts?.withPaneStreamerManager) {
    const ptyFactory: PtyFactory = (cmd) => createProbeAwarePty(cmd);
    ctx.paneStreamerManager = new PaneStreamerManager({
      runnerFactory: () => ({
        exec: vi.fn().mockImplementation(async (cmd: string) => {
          if (cmd.includes('list-sessions')) {
            const name = /#\{==:#\{session_name\},([^}]+)\}/.exec(cmd)?.[1] ?? 'dev-1';
            return { stdout: `4242|1700000000|$1|${name}\n`, stderr: '', exitCode: 0 };
          }
          if (cmd.includes('display-message')) {
            return { stdout: '200 50 on latest |4242|1700000000|$1|dev-1|3.0a|#{e|<=:1,2}\n', stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        execWithStdin: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
      }),
      streamerDefaults: {
        ptyFactory,
        idleGraceMs: 50,
      },
    });
  }
  const app = await buildApp(ctx);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  return { app, port: address.port, ctx };
}

function openWs(p: number, opts?: { headers?: Record<string, string>; protocols?: string | string[] }): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${p}/api/stream`, opts?.protocols, {
    headers: opts?.headers,
  });
}

function waitForOpenOrError(ws: WebSocket): Promise<{ kind: 'open' } | { kind: 'error'; status?: number }> {
  return new Promise((resolve) => {
    ws.on('open', () => resolve({ kind: 'open' }));
    ws.on('unexpected-response', (_req, res) => resolve({ kind: 'error', status: res.statusCode }));
    ws.on('error', () => { });
  });
}

function attachMessageReader(ws: WebSocket): {
  next: (timeoutMs?: number) => Promise<StreamServerMsg>;
} {
  const queue: StreamServerMsg[] = [];
  const waiters: Array<(m: StreamServerMsg) => void> = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw)) as StreamServerMsg;
    const w = waiters.shift();
    if (w) w(msg);
    else queue.push(msg);
  });
  return {
    next: (timeoutMs = 2000) =>
      new Promise<StreamServerMsg>((resolve, reject) => {
        const queued = queue.shift();
        if (queued) return resolve(queued);
        const t = setTimeout(() => {
          const idx = waiters.indexOf(resolve);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error('msg timeout'));
        }, timeoutMs);
        waiters.push((m) => {
          clearTimeout(t);
          resolve(m);
        });
      }),
  };
}

function send(ws: WebSocket, obj: unknown): void {
  ws.send(JSON.stringify(obj));
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

const HEX = (s: string): string => Buffer.from(s, 'utf8').toString('hex');

async function waitOpen(ws: WebSocket): Promise<void> {
  await new Promise<void>((r) => ws.on('open', () => r()));
}

async function waitFor(cond: () => boolean, timeoutMs = 1500): Promise<void> {
  const started = Date.now();
  while (!cond() && Date.now() - started < timeoutMs) {
    await flushAsyncWork();
  }
  expect(cond()).toBe(true);
}

interface FakeStreamerCallbacks {
  onLive?: (data: string, seq: number) => void;
  onSessionGone?: () => void;
  onSnapshotRefresh?: (snapshot: { cols: number; rows: number; data: string }, seq: number) => void;
}

function makeFakeStreamer(): {
  streamer: {
    subscribeAtomic: ReturnType<typeof vi.fn>;
    getSnapshotAtomic: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    acquireFullHold: ReturnType<typeof vi.fn>;
  };
  callbacks: FakeStreamerCallbacks;
  unsubscribe: ReturnType<typeof vi.fn>;
  releaseFullHold: ReturnType<typeof vi.fn>;
} {
  const callbacks: FakeStreamerCallbacks = {};
  const unsubscribe = vi.fn();
  const releaseFullHold = vi.fn();
  const streamer = {
    subscribeAtomic: vi.fn(async (cbs: FakeStreamerCallbacks) => {
      Object.assign(callbacks, cbs);
      return { snapshot: { cols: 80, rows: 24, data: 'SNAP-LIVE' }, snapshotSeq: 7, unsubscribe };
    }),
    getSnapshotAtomic: vi.fn(async () => ({
      snapshot: { cols: 80, rows: 24, data: 'SNAP-ONLY' },
      snapshotSeq: 8,
    })),
    resize: vi.fn(async () => undefined),
    acquireFullHold: vi.fn(() => releaseFullHold),
  };
  return { streamer, callbacks, unsubscribe, releaseFullHold };
}

function fakePsm(
  streamer: ReturnType<typeof makeFakeStreamer>['streamer'],
  opts: { has?: boolean } = {},
): PaneStreamerManager {
  return {
    ensure: vi.fn(() => streamer),
    has: vi.fn(() => opts.has ?? true),
    enqueueInput: vi.fn(async () => undefined),
    destroyAll: vi.fn(async () => undefined),
  } as unknown as PaneStreamerManager;
}

async function subscribeActive(
  ws: WebSocket,
  reader: ReturnType<typeof attachMessageReader>,
  subscriberId: string,
  mode: 'preview' | 'full',
): Promise<void> {
  send(ws, { op: 'subscribe', subscriberId, agentId: 'dev-1', mode });
  expect((await reader.next()).type).toBe('snapshot');
  expect((await reader.next()).type).toBe('subscribed');
}

async function pingBarrier(ws: WebSocket, reader: ReturnType<typeof attachMessageReader>): Promise<StreamServerMsg> {
  send(ws, { op: 'ping' });
  return reader.next();
}

describe('streamWsPlugin /api/stream — preValidation', () => {
  it('rejects with 403 when Origin host does not match Host', async () => {
    const { app, port: p } = await startApp();
    runningApp = app;
    const ws = openWs(p, { headers: { Origin: 'http://evil.example' } });
    const r = await waitForOpenOrError(ws);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.status).toBe(403);
  });

  it('allows missing Origin (curl/Node clients)', async () => {
    const { app, port: p } = await startApp({ withPaneStreamerManager: true });
    runningApp = app;
    const ws = openWs(p);
    const r = await waitForOpenOrError(ws);
    expect(r.kind).toBe('open');
    ws.close();
  });

  it('rejects with 401 when token configured but client missing subprotocol', async () => {
    const { app, port: p } = await startApp({ configToken: 's3cret' });
    runningApp = app;
    const ws = openWs(p);
    const r = await waitForOpenOrError(ws);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.status).toBe(401);
  });

  it('rejects with 401 when subprotocol token does not match config', async () => {
    const { app, port: p } = await startApp({ configToken: 's3cret' });
    runningApp = app;
    const ws = openWs(p, { protocols: `baxian.token.${HEX('wrong')}` });
    const r = await waitForOpenOrError(ws);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.status).toBe(401);
  });

  it('accepts when subprotocol token matches config', async () => {
    const { app, port: p } = await startApp({ configToken: 's3cret', withPaneStreamerManager: true });
    runningApp = app;
    const ws = openWs(p, { protocols: `baxian.token.${HEX('s3cret')}` });
    const r = await waitForOpenOrError(ws);
    expect(r.kind).toBe('open');
    ws.close();
  });
});

describe('streamWsPlugin /api/stream — message dispatch', () => {
  it('returns invalid_message when JSON missing op field', async () => {
    const { app, port: p } = await startApp({ withPaneStreamerManager: true });
    runningApp = app;
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    send(ws, { foo: 'bar' });
    const m = await reader.next();
    expect(m.type).toBe('error');
    if (m.type === 'error') expect(m.code).toBe('invalid_message');
    ws.close();
  });

  it('returns invalid_message when input message missing data field', async () => {
    const { app, port: p } = await startApp({ withPaneStreamerManager: true });
    runningApp = app;
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    send(ws, { op: 'input', subscriberId: 'x' });
    const m = await reader.next();
    expect(m.type).toBe('error');
    if (m.type === 'error') expect(m.code).toBe('invalid_message');
    ws.close();
  });

  it('returns invalid_message when subscribe missing required fields', async () => {
    const { app, port: p } = await startApp({ withPaneStreamerManager: true });
    runningApp = app;
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    send(ws, { op: 'subscribe', subscriberId: 'x' });
    const m = await reader.next();
    expect(m.type).toBe('error');
    if (m.type === 'error') expect(m.code).toBe('invalid_message');
    ws.close();
  });

  it('ping returns pong', async () => {
    const { app, port: p } = await startApp({ withPaneStreamerManager: true });
    runningApp = app;
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    send(ws, { op: 'ping' });
    const m = await reader.next();
    expect(m.type).toBe('pong');
    ws.close();
  });
});

describe('streamWsPlugin /api/stream — subscribe state machine', () => {
  it('subscribe rejects unknown agentId with code unknown_agent', async () => {
    const { app, port: p } = await startApp({ withPaneStreamerManager: true });
    runningApp = app;
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    send(ws, { op: 'subscribe', subscriberId: 'sub-1', agentId: 'no-such-agent', mode: 'preview' });
    const m = await reader.next();
    expect(m.type).toBe('error');
    if (m.type === 'error') expect(m.code).toBe('unknown_agent');
    ws.close();
  });

  it('subscribe → snapshot then subscribed in order (preview mode)', async () => {
    const { app, port: p } = await startApp({ withPaneStreamerManager: true });
    runningApp = app;
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    send(ws, { op: 'subscribe', subscriberId: 'sub-1', agentId: 'dev-1', mode: 'preview' });
    const m1 = await reader.next();
    expect(m1.type).toBe('snapshot');
    const m2 = await reader.next();
    expect(m2.type).toBe('subscribed');
    ws.close();
  });

  it('duplicate subscriberId returns duplicate_subscriber_id', async () => {
    const { app, port: p } = await startApp({ withPaneStreamerManager: true });
    runningApp = app;
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    send(ws, { op: 'subscribe', subscriberId: 'sub-1', agentId: 'dev-1', mode: 'preview' });
    await reader.next();
    await reader.next();
    send(ws, { op: 'subscribe', subscriberId: 'sub-1', agentId: 'dev-1', mode: 'full' });
    const m = await reader.next();
    expect(m.type).toBe('error');
    if (m.type === 'error') expect(m.code).toBe('duplicate_subscriber_id');
    ws.close();
  });

  it('preview-mode subscriber sending input gets input_not_allowed_in_preview', async () => {
    const { app, port: p } = await startApp({ withPaneStreamerManager: true });
    runningApp = app;
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    send(ws, { op: 'subscribe', subscriberId: 'sub-1', agentId: 'dev-1', mode: 'preview' });
    await reader.next();
    await reader.next();
    send(ws, { op: 'input', subscriberId: 'sub-1', data: 'hi' });
    const m = await reader.next();
    expect(m.type).toBe('error');
    if (m.type === 'error') expect(m.code).toBe('input_not_allowed_in_preview');
    ws.close();
  });

  it('input from unknown subscriberId returns unknown_subscriber', async () => {
    const { app, port: p } = await startApp({ withPaneStreamerManager: true });
    runningApp = app;
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    send(ws, { op: 'input', subscriberId: 'never-subscribed', data: 'hi' });
    const m = await reader.next();
    expect(m.type).toBe('error');
    if (m.type === 'error') expect(m.code).toBe('unknown_subscriber');
    ws.close();
  });

  it('resize with invalid cols/rows returns invalid_size after subscribed', async () => {
    const { app, port: p } = await startApp({ withPaneStreamerManager: true });
    runningApp = app;
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    send(ws, { op: 'subscribe', subscriberId: 'sub-1', agentId: 'dev-1', mode: 'full' });
    await reader.next();
    await reader.next();
    send(ws, { op: 'resize', subscriberId: 'sub-1', cols: -1, rows: 10 });
    const m = await reader.next();
    expect(m.type).toBe('error');
    if (m.type === 'error') expect(m.code).toBe('invalid_size');
    ws.close();
  });

  it('enqueueInput rejection surfaces input_failed to subscriber', async () => {
    const { app, port: p, ctx } = await startApp({ withPaneStreamerManager: true });
    runningApp = app;
    ctx.paneStreamerManager!.enqueueInput = vi.fn().mockRejectedValue(new Error('load-buffer boom'));
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    send(ws, { op: 'subscribe', subscriberId: 'sub-1', agentId: 'dev-1', mode: 'full' });
    await reader.next();
    await reader.next();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      send(ws, { op: 'input', subscriberId: 'sub-1', data: 'hello' });
      const m = await reader.next();
      expect(m.type).toBe('error');
      if (m.type === 'error') {
        expect(m.code).toBe('input_failed');
        expect(m.message).toContain('load-buffer boom');
        expect(m.subscriberId).toBe('sub-1');
      }
    } finally {
      warnSpy.mockRestore();
    }
    ws.close();
  });

  it('ignores client lifecycle suppression and audits full-mode session boundaries before input', async () => {
    const { app, port: p, ctx } = await startApp({ withPaneStreamerManager: true });
    runningApp = app;
    const emitSpy = vi.spyOn(ctx.eventBus, 'emit');
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    send(ws, {
      op: 'subscribe',
      subscriberId: 'sub-1',
      agentId: 'dev-1',
      mode: 'full',
      reportLifecycle: false,
    });
    await reader.next();
    await reader.next();
    await flushAsyncWork();
    const phases = () => emitSpy.mock.calls
      .map(([event]) => event as BaxianEvent)
      .filter(event => event.type === 'human.intervention')
      .map(event => event.data.phase);
    const waitForPhase = async (phase: string) => {
      const started = Date.now();
      while (Date.now() - started < 1000) {
        if (phases().includes(phase)) return;
        await flushAsyncWork();
      }
      expect(phases()).toContain(phase);
    };
    await waitForPhase('attach');

    send(ws, { op: 'input', subscriberId: 'sub-1', data: 'hello\r' });
    await waitForPhase('input');

    send(ws, { op: 'unsubscribe', subscriberId: 'sub-1' });
    await waitForPhase('detach');
    ws.close();
  });

  it('submitting input clears the agent need-input badge', async () => {
    const { app, port: p, ctx } = await startApp({ withPaneStreamerManager: true });
    runningApp = app;
    await ctx.agentStore.set({
      id: 'dev-1',
      projectId: 'proj-a',
      taskId: 'task-1',
      needInput: { epoch: 1, askSeq: 1, answeredSeq: 0, at: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
    });
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    send(ws, { op: 'subscribe', subscriberId: 'sub-1', agentId: 'dev-1', mode: 'full' });
    await reader.next();
    await reader.next();

    send(ws, { op: 'input', subscriberId: 'sub-1', data: 'my answer\r' });
    const started = Date.now();
    while (Date.now() - started < 1000) {
      const binding = await ctx.agentStore.get('dev-1');
      if (binding && binding.needInput?.at === undefined) break;
      await flushAsyncWork();
    }
    const binding = await ctx.agentStore.get('dev-1');
    expect(binding?.needInput).toEqual({ epoch: 1, askSeq: 1, answeredSeq: 1 });
    expect(binding?.taskId).toBe('task-1');

    send(ws, { op: 'input', subscriberId: 'sub-1', data: 'plain keys no enter' });
    await flushAsyncWork();
    const after = await ctx.agentStore.get('dev-1');
    expect(after?.needInput?.at).toBeUndefined();
    ws.close();
  });

  it('keeps the need-input badge when the pane write fails', async () => {
    const { app, port: p, ctx } = await startApp({ withPaneStreamerManager: true });
    runningApp = app;
    const at = new Date().toISOString();
    await ctx.agentStore.set({
      id: 'dev-1',
      projectId: 'proj-a',
      taskId: 'task-1',
      needInput: { epoch: 1, askSeq: 1, answeredSeq: 0, at },
      updatedAt: new Date().toISOString(),
    });
    vi.spyOn(ctx.paneStreamerManager!, 'enqueueInput').mockRejectedValue(new Error('pane gone'));
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    send(ws, { op: 'subscribe', subscriberId: 'sub-1', agentId: 'dev-1', mode: 'full' });
    await reader.next();
    await reader.next();

    send(ws, { op: 'input', subscriberId: 'sub-1', data: 'my answer\r' });
    let sawInputFailed = false;
    for (let i = 0; i < 5 && !sawInputFailed; i++) {
      const msg = await reader.next();
      if (msg.type === 'error' && msg.code === 'input_failed') sawInputFailed = true;
    }
    expect(sawInputFailed).toBe(true);
    const binding = await ctx.agentStore.get('dev-1');
    expect(binding?.needInput).toEqual({ epoch: 1, askSeq: 1, answeredSeq: 0, at });
    ws.close();
  });
});

describe('streamWsPlugin /api/stream — transport error handling', () => {
  it('does not crash on transport-level socket error (writes garbage bytes)', async () => {
    const { app, port: p } = await startApp({ withPaneStreamerManager: true });
    runningApp = app;
    const ws = openWs(p);
    await waitOpen(ws);
    const inner = (ws as unknown as { _socket: { write: (b: Buffer) => boolean } })._socket;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      inner.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
      await new Promise((r) => setTimeout(r, 100));
      const ws2 = openWs(p);
      const r = await waitForOpenOrError(ws2);
      expect(r.kind).toBe('open');
      ws2.close();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('streamWsPlugin /api/stream — streamer unavailable & subscribe failures', () => {
  it('subscribe without a PaneStreamerManager returns streamer_unavailable and releases the sub', async () => {
    const { app, port: p } = await startApp();
    runningApp = app;
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    send(ws, { op: 'subscribe', subscriberId: 'sub-1', agentId: 'dev-1', mode: 'preview' });
    const m = await reader.next();
    expect(m.type).toBe('error');
    if (m.type === 'error') {
      expect(m.code).toBe('streamer_unavailable');
      expect(m.subscriberId).toBe('sub-1');
    }
    send(ws, { op: 'subscribe', subscriberId: 'sub-1', agentId: 'dev-1', mode: 'preview' });
    const m2 = await reader.next();
    if (m2.type === 'error') expect(m2.code).toBe('streamer_unavailable');
    ws.close();
  });

  it('psm.ensure throwing maps to subscribe_failed with the error message', async () => {
    const { app, port: p, ctx } = await startApp();
    runningApp = app;
    ctx.paneStreamerManager = {
      ensure: () => { throw new Error('kaboom'); },
      has: () => false,
      enqueueInput: vi.fn(),
      destroyAll: vi.fn(async () => undefined),
    } as unknown as PaneStreamerManager;
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    send(ws, { op: 'subscribe', subscriberId: 'sub-1', agentId: 'dev-1', mode: 'preview' });
    const m = await reader.next();
    expect(m.type).toBe('error');
    if (m.type === 'error') {
      expect(m.code).toBe('subscribe_failed');
      expect(m.message).toBe('kaboom');
    }
    ws.close();
  });

  it('tmux_too_old errors surface the dedicated error code', async () => {
    const { app, port: p, ctx } = await startApp();
    runningApp = app;
    const { streamer } = makeFakeStreamer();
    streamer.subscribeAtomic.mockRejectedValue(new Error('TMUX_TOO_OLD: need >= 3.2'));
    ctx.paneStreamerManager = fakePsm(streamer);
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    send(ws, { op: 'subscribe', subscriberId: 'sub-1', agentId: 'dev-1', mode: 'preview' });
    const m = await reader.next();
    expect(m.type).toBe('error');
    if (m.type === 'error') expect(m.code).toBe('tmux_too_old');
    ws.close();
  });

  it('session-not-found errors map to session_not_found', async () => {
    const { app, port: p, ctx } = await startApp();
    runningApp = app;
    const { streamer } = makeFakeStreamer();
    streamer.subscribeAtomic.mockRejectedValue(new Error("can't find session: dev-1"));
    ctx.paneStreamerManager = fakePsm(streamer);
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    send(ws, { op: 'subscribe', subscriberId: 'sub-1', agentId: 'dev-1', mode: 'full' });
    const m = await reader.next();
    expect(m.type).toBe('error');
    if (m.type === 'error') expect(m.code).toBe('session_not_found');
    ws.close();
  });
});

describe('streamWsPlugin /api/stream — shared agent streams (refcount)', () => {
  it('second subscriber reuses the live stream: snapshot-only path, no second subscribeAtomic', async () => {
    const { app, port: p, ctx } = await startApp();
    runningApp = app;
    const { streamer } = makeFakeStreamer();
    ctx.paneStreamerManager = fakePsm(streamer);
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);

    send(ws, { op: 'subscribe', subscriberId: 'sub-1', agentId: 'dev-1', mode: 'full' });
    const snap1 = await reader.next();
    expect(snap1).toMatchObject({ type: 'snapshot', subscriberId: 'sub-1', data: 'SNAP-LIVE', snapshotSeq: 7 });
    expect((await reader.next()).type).toBe('subscribed');

    send(ws, { op: 'subscribe', subscriberId: 'sub-2', agentId: 'dev-1', mode: 'preview' });
    const snap2 = await reader.next();
    expect(snap2).toMatchObject({ type: 'snapshot', subscriberId: 'sub-2', data: 'SNAP-ONLY', snapshotSeq: 8 });
    expect((await reader.next()).type).toBe('subscribed');

    expect(streamer.subscribeAtomic).toHaveBeenCalledTimes(1);
    expect(streamer.getSnapshotAtomic).toHaveBeenCalledTimes(1);
    ws.close();
  });

  it('live pane data is forwarded to the socket with agentId and seq', async () => {
    const { app, port: p, ctx } = await startApp();
    runningApp = app;
    const { streamer, callbacks } = makeFakeStreamer();
    ctx.paneStreamerManager = fakePsm(streamer);
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    await subscribeActive(ws, reader, 'sub-1', 'full');

    callbacks.onLive!('hello from pane', 42);
    const m = await reader.next();
    expect(m).toEqual({ type: 'data', agentId: 'dev-1', data: 'hello from pane', seq: 42 });
    ws.close();
  });

  it('session_gone releases every subscriber of that agent and tears the stream down once', async () => {
    const { app, port: p, ctx } = await startApp();
    runningApp = app;
    const { streamer, callbacks, unsubscribe } = makeFakeStreamer();
    ctx.paneStreamerManager = fakePsm(streamer);
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    await subscribeActive(ws, reader, 'sub-1', 'full');
    await subscribeActive(ws, reader, 'sub-2', 'preview');

    callbacks.onSessionGone!();
    const m = await reader.next();
    expect(m).toEqual({ type: 'session_gone', agentId: 'dev-1' });
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    send(ws, { op: 'input', subscriberId: 'sub-1', data: 'hi' });
    const m2 = await reader.next();
    expect(m2.type).toBe('error');
    if (m2.type === 'error') expect(m2.code).toBe('unknown_subscriber');
    ws.close();
  });

  it('streamer is unsubscribed only when the last subscriber of the agent leaves', async () => {
    const { app, port: p, ctx } = await startApp();
    runningApp = app;
    const { streamer, unsubscribe } = makeFakeStreamer();
    ctx.paneStreamerManager = fakePsm(streamer);
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    await subscribeActive(ws, reader, 'sub-1', 'full');
    await subscribeActive(ws, reader, 'sub-2', 'preview');

    send(ws, { op: 'unsubscribe', subscriberId: 'sub-2' });
    expect((await pingBarrier(ws, reader)).type).toBe('pong');
    expect(unsubscribe).not.toHaveBeenCalled();

    send(ws, { op: 'unsubscribe', subscriberId: 'sub-1' });
    expect((await pingBarrier(ws, reader)).type).toBe('pong');
    await waitFor(() => unsubscribe.mock.calls.length === 1);
    ws.close();
  });

  it('a throwing streamer unsubscribe is contained and the agent can be re-subscribed', async () => {
    const { app, port: p, ctx } = await startApp();
    runningApp = app;
    const { streamer, unsubscribe } = makeFakeStreamer();
    unsubscribe.mockImplementationOnce(() => { throw new Error('teardown boom'); });
    ctx.paneStreamerManager = fakePsm(streamer);
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    await subscribeActive(ws, reader, 'sub-1', 'preview');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      send(ws, { op: 'unsubscribe', subscriberId: 'sub-1' });
      expect((await pingBarrier(ws, reader)).type).toBe('pong');
      expect(warnSpy.mock.calls.some(
        (c) => String(c[0]).includes('[stream-ws] streamer.unsubscribe failed:'),
      )).toBe(true);

      await subscribeActive(ws, reader, 'sub-1', 'preview');
      expect(streamer.subscribeAtomic).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
    ws.close();
  });
});

describe('streamWsPlugin /api/stream — cancel during pending subscribe', () => {
  it('cancelling the creator mid-subscribe hands the unsub to surviving subscribers', async () => {
    const { app, port: p, ctx } = await startApp();
    runningApp = app;
    const { streamer, unsubscribe } = makeFakeStreamer();
    let resolveSub!: (v: unknown) => void;
    streamer.subscribeAtomic.mockImplementation(() => new Promise((r) => { resolveSub = r; }));
    ctx.paneStreamerManager = fakePsm(streamer);
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);

    send(ws, { op: 'subscribe', subscriberId: 'sub-1', agentId: 'dev-1', mode: 'full' });
    await waitFor(() => streamer.subscribeAtomic.mock.calls.length === 1);

    await subscribeActive(ws, reader, 'sub-2', 'preview');

    send(ws, { op: 'unsubscribe', subscriberId: 'sub-1' });
    expect((await pingBarrier(ws, reader)).type).toBe('pong');

    resolveSub({ snapshot: { cols: 80, rows: 24, data: 'SNAP-LIVE' }, snapshotSeq: 7, unsubscribe });
    await flushAsyncWork();
    expect((await pingBarrier(ws, reader)).type).toBe('pong');
    expect(unsubscribe).not.toHaveBeenCalled();

    send(ws, { op: 'unsubscribe', subscriberId: 'sub-2' });
    expect((await pingBarrier(ws, reader)).type).toBe('pong');
    await waitFor(() => unsubscribe.mock.calls.length === 1);
    ws.close();
  });

  it('cancelling the sole pending subscribe invokes and contains the post-cancel unsub', async () => {
    const { app, port: p, ctx } = await startApp();
    runningApp = app;
    const { streamer } = makeFakeStreamer();
    const lateUnsub = vi.fn(() => { throw new Error('late unsub boom'); });
    let resolveSub!: (v: unknown) => void;
    streamer.subscribeAtomic.mockImplementation(() => new Promise((r) => { resolveSub = r; }));
    ctx.paneStreamerManager = fakePsm(streamer);
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);

    send(ws, { op: 'subscribe', subscriberId: 'sub-1', agentId: 'dev-1', mode: 'full' });
    await waitFor(() => streamer.subscribeAtomic.mock.calls.length === 1);
    send(ws, { op: 'unsubscribe', subscriberId: 'sub-1' });
    expect((await pingBarrier(ws, reader)).type).toBe('pong');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      resolveSub({ snapshot: { cols: 80, rows: 24, data: 'SNAP-LIVE' }, snapshotSeq: 7, unsubscribe: lateUnsub });
      await waitFor(() => lateUnsub.mock.calls.length === 1);
      expect(warnSpy.mock.calls.some(
        (c) => String(c[0]).includes('[stream-ws] post-cancel unsub failed:'),
      )).toBe(true);
      expect((await pingBarrier(ws, reader)).type).toBe('pong');
    } finally {
      warnSpy.mockRestore();
    }
    ws.close();
  });
});

describe('streamWsPlugin /api/stream — pending-phase and mode guards', () => {
  it('input before the subscribed ack returns subscriber_not_ready', async () => {
    const { app, port: p, ctx } = await startApp();
    runningApp = app;
    const { streamer, unsubscribe } = makeFakeStreamer();
    let resolveSub!: (v: unknown) => void;
    streamer.subscribeAtomic.mockImplementation(() => new Promise((r) => { resolveSub = r; }));
    ctx.paneStreamerManager = fakePsm(streamer);
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);

    send(ws, { op: 'subscribe', subscriberId: 'sub-1', agentId: 'dev-1', mode: 'full' });
    await waitFor(() => streamer.subscribeAtomic.mock.calls.length === 1);
    send(ws, { op: 'input', subscriberId: 'sub-1', data: 'hi' });
    const m = await reader.next();
    expect(m.type).toBe('error');
    if (m.type === 'error') {
      expect(m.code).toBe('subscriber_not_ready');
      expect(m.message).toContain('pending');
    }
    resolveSub({ snapshot: { cols: 80, rows: 24, data: '' }, snapshotSeq: 1, unsubscribe });
    ws.close();
  });

  it('resize before the subscribed ack returns subscriber_not_ready', async () => {
    const { app, port: p, ctx } = await startApp();
    runningApp = app;
    const { streamer, unsubscribe } = makeFakeStreamer();
    let resolveSub!: (v: unknown) => void;
    streamer.subscribeAtomic.mockImplementation(() => new Promise((r) => { resolveSub = r; }));
    ctx.paneStreamerManager = fakePsm(streamer);
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);

    send(ws, { op: 'subscribe', subscriberId: 'sub-1', agentId: 'dev-1', mode: 'full' });
    await waitFor(() => streamer.subscribeAtomic.mock.calls.length === 1);
    send(ws, { op: 'resize', subscriberId: 'sub-1', cols: 80, rows: 24 });
    const m = await reader.next();
    expect(m.type).toBe('error');
    if (m.type === 'error') expect(m.code).toBe('subscriber_not_ready');
    resolveSub({ snapshot: { cols: 80, rows: 24, data: '' }, snapshotSeq: 1, unsubscribe });
    ws.close();
  });

  it('resize in preview mode returns resize_not_allowed_in_preview', async () => {
    const { app, port: p, ctx } = await startApp();
    runningApp = app;
    const { streamer } = makeFakeStreamer();
    ctx.paneStreamerManager = fakePsm(streamer);
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    await subscribeActive(ws, reader, 'sub-1', 'preview');
    send(ws, { op: 'resize', subscriberId: 'sub-1', cols: 80, rows: 24 });
    const m = await reader.next();
    expect(m.type).toBe('error');
    if (m.type === 'error') expect(m.code).toBe('resize_not_allowed_in_preview');
    ws.close();
  });

  it('resize with no active streamer for the agent returns streamer_unavailable', async () => {
    const { app, port: p, ctx } = await startApp();
    runningApp = app;
    const { streamer } = makeFakeStreamer();
    ctx.paneStreamerManager = fakePsm(streamer, { has: false });
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    await subscribeActive(ws, reader, 'sub-1', 'full');
    send(ws, { op: 'resize', subscriberId: 'sub-1', cols: 80, rows: 24 });
    const m = await reader.next();
    expect(m.type).toBe('error');
    if (m.type === 'error') {
      expect(m.code).toBe('streamer_unavailable');
      expect(m.agentId).toBe('dev-1');
    }
    ws.close();
  });

  it('resize forwards the sanitized size to the streamer without error frames', async () => {
    const { app, port: p, ctx } = await startApp();
    runningApp = app;
    const { streamer } = makeFakeStreamer();
    ctx.paneStreamerManager = fakePsm(streamer);
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    await subscribeActive(ws, reader, 'sub-1', 'full');
    send(ws, { op: 'resize', subscriberId: 'sub-1', cols: 120, rows: 40 });
    await waitFor(() => streamer.resize.mock.calls.length === 1);
    expect(streamer.resize).toHaveBeenCalledWith(120, 40);
    expect((await pingBarrier(ws, reader)).type).toBe('pong');
    ws.close();
  });

  it('a rejecting streamer.resize surfaces resize_failed', async () => {
    const { app, port: p, ctx } = await startApp();
    runningApp = app;
    const { streamer } = makeFakeStreamer();
    streamer.resize.mockRejectedValue(new Error('resize boom'));
    ctx.paneStreamerManager = fakePsm(streamer);
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    await subscribeActive(ws, reader, 'sub-1', 'full');
    send(ws, { op: 'resize', subscriberId: 'sub-1', cols: 100, rows: 30 });
    const m = await reader.next();
    expect(m.type).toBe('error');
    if (m.type === 'error') {
      expect(m.code).toBe('resize_failed');
      expect(m.message).toContain('resize boom');
    }
    ws.close();
  });

  it('input after the manager disappears returns streamer_unavailable', async () => {
    const { app, port: p, ctx } = await startApp();
    runningApp = app;
    const { streamer } = makeFakeStreamer();
    ctx.paneStreamerManager = fakePsm(streamer);
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    await subscribeActive(ws, reader, 'sub-1', 'full');

    ctx.paneStreamerManager = undefined;
    send(ws, { op: 'input', subscriberId: 'sub-1', data: 'hi' });
    const m = await reader.next();
    expect(m.type).toBe('error');
    if (m.type === 'error') expect(m.code).toBe('streamer_unavailable');
    ws.close();
  });
});

describe('streamWsPlugin /api/stream — malformed frames', () => {
  it('non-JSON payloads return invalid_message (failed to parse JSON)', async () => {
    const { app, port: p } = await startApp({ withPaneStreamerManager: true });
    runningApp = app;
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    ws.send('not-json{');
    const m = await reader.next();
    expect(m.type).toBe('error');
    if (m.type === 'error') {
      expect(m.code).toBe('invalid_message');
      expect(m.message).toBe('failed to parse JSON');
    }
    ws.close();
  });

  it('unsubscribe without subscriberId returns invalid_message', async () => {
    const { app, port: p } = await startApp({ withPaneStreamerManager: true });
    runningApp = app;
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    send(ws, { op: 'unsubscribe' });
    const m = await reader.next();
    expect(m.type).toBe('error');
    if (m.type === 'error') expect(m.code).toBe('invalid_message');
    ws.close();
  });

  it('resize with non-numeric cols returns invalid_message', async () => {
    const { app, port: p } = await startApp({ withPaneStreamerManager: true });
    runningApp = app;
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    send(ws, { op: 'resize', subscriberId: 'sub-1', cols: '80', rows: 24 });
    const m = await reader.next();
    expect(m.type).toBe('error');
    if (m.type === 'error') expect(m.code).toBe('invalid_message');
    ws.close();
  });

  it('unknown op returns unknown_op with the op echoed', async () => {
    const { app, port: p } = await startApp({ withPaneStreamerManager: true });
    runningApp = app;
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    send(ws, { op: 'launch' });
    const m = await reader.next();
    expect(m.type).toBe('error');
    if (m.type === 'error') {
      expect(m.code).toBe('unknown_op');
      expect(m.message).toBe('unknown op: launch');
    }
    ws.close();
  });
});

describe('streamWsPlugin /api/stream — intervention emit failure', () => {
  it('a failing eventBus.emit on attach is logged and the stream stays usable', async () => {
    const { app, port: p, ctx } = await startApp();
    runningApp = app;
    const { streamer } = makeFakeStreamer();
    ctx.paneStreamerManager = fakePsm(streamer);
    const emitSpy = vi.spyOn(ctx.eventBus, 'emit').mockRejectedValue(new Error('bus down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const ws = openWs(p);
      const reader = attachMessageReader(ws);
      await waitOpen(ws);
      await subscribeActive(ws, reader, 'sub-1', 'full');
      await waitFor(() => errorSpy.mock.calls.some(
        (c) => String(c[0]).includes('[stream-ws] failed to emit human.intervention'),
      ));
      expect((await pingBarrier(ws, reader)).type).toBe('pong');
      emitSpy.mockRestore();
      ws.close();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('streamWsPlugin /api/stream — pty unavailable', () => {
  it('returns 503 pty_unavailable when node-pty cannot be loaded', async () => {
    vi.resetModules();
    vi.doMock('node-pty', () => { throw new Error('pty missing'); });
    try {
      const { buildApp: freshBuildApp } = await import('../../src/app.js');
      const ctx = await createTestContext(tempDir);
      const app = await freshBuildApp(ctx as unknown as Parameters<typeof freshBuildApp>[0]);
      runningApp = app;
      await app.listen({ port: 0, host: '127.0.0.1' });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('failed to bind test server');
      const ws = openWs(address.port);
      const r = await waitForOpenOrError(ws);
      expect(r).toEqual({ kind: 'error', status: 503 });
    } finally {
      vi.doUnmock('node-pty');
      vi.resetModules();
    }
  });
});

describe('streamWsPlugin /api/stream — full-hold lifecycle + preview snapshot refresh', () => {
  it('full activate acquires a hold on the exact streamer; unsubscribe releases exactly once', async () => {
    const { streamer, releaseFullHold } = makeFakeStreamer();
    const { app, port: p } = await startApp();
    runningApp = app;
    app.ctx.paneStreamerManager = fakePsm(streamer);
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);

    await subscribeActive(ws, reader, 'sub-full', 'full');
    expect(streamer.acquireFullHold).toHaveBeenCalledTimes(1);
    expect(releaseFullHold).not.toHaveBeenCalled();

    send(ws, { op: 'unsubscribe', subscriberId: 'sub-full' });
    await waitFor(() => releaseFullHold.mock.calls.length === 1);
    send(ws, { op: 'unsubscribe', subscriberId: 'sub-full' });
    await flushAsyncWork();
    expect(releaseFullHold).toHaveBeenCalledTimes(1);
    ws.close();
  });

  it('preview subscribers never acquire a hold', async () => {
    const { streamer } = makeFakeStreamer();
    const { app, port: p } = await startApp();
    runningApp = app;
    app.ctx.paneStreamerManager = fakePsm(streamer);
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);

    await subscribeActive(ws, reader, 'sub-prev', 'preview');
    expect(streamer.acquireFullHold).not.toHaveBeenCalled();
    ws.close();
  });

  it('socket close releases an active full hold', async () => {
    const { streamer, releaseFullHold } = makeFakeStreamer();
    const { app, port: p } = await startApp();
    runningApp = app;
    app.ctx.paneStreamerManager = fakePsm(streamer);
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);

    await subscribeActive(ws, reader, 'sub-full', 'full');
    ws.close();
    await waitFor(() => releaseFullHold.mock.calls.length === 1);
  });

  it('session_gone releases the full hold via the shared releaseSub path', async () => {
    const { streamer, callbacks, releaseFullHold } = makeFakeStreamer();
    const { app, port: p } = await startApp();
    runningApp = app;
    app.ctx.paneStreamerManager = fakePsm(streamer);
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);

    await subscribeActive(ws, reader, 'sub-full', 'full');
    callbacks.onSessionGone?.();
    await waitFor(() => releaseFullHold.mock.calls.length === 1);
    ws.close();
  });

  it('onSnapshotRefresh re-baselines ACTIVE preview subscribers only; full subscribers never receive it', async () => {
    const { streamer, callbacks } = makeFakeStreamer();
    const { app, port: p } = await startApp();
    runningApp = app;
    app.ctx.paneStreamerManager = fakePsm(streamer);
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);

    await subscribeActive(ws, reader, 'sub-prev', 'preview');
    await subscribeActive(ws, reader, 'sub-full', 'full');

    callbacks.onSnapshotRefresh?.({ cols: 141, rows: 32, data: 'REFRESHED' }, 99);
    const msg = await reader.next();
    expect(msg).toMatchObject({
      type: 'snapshot',
      subscriberId: 'sub-prev',
      cols: 141,
      rows: 32,
      data: 'REFRESHED',
      snapshotSeq: 99,
    });
    const pong = await pingBarrier(ws, reader);
    expect(pong.type).toBe('pong');
    ws.close();
  });
});
