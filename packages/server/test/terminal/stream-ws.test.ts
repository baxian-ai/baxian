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
  await rm(tempDir, { recursive: true });
});

function createFakePty(): MinimalPty {
  return {
    onData() { return { dispose: () => undefined }; },
    onExit() { return { dispose: () => undefined }; },
    resize() { /* noop */ },
    write() { /* noop */ },
    kill() { /* noop */ },
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
    const ptyFactory: PtyFactory = () => createFakePty();
    ctx.paneStreamerManager = new PaneStreamerManager({
      runnerFactory: () => ({
        exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
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
    ws.on('error', () => { /* unexpected-response fires first for HTTP errors */ });
  });
}

// Messages can arrive back-to-back; queue them up so consumers can pull
// sequentially without race conditions vs. `ws.once('message', ...)`.
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
    await reader.next();  // snapshot
    await reader.next();  // subscribed (now active)
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
    await reader.next();  // snapshot
    await reader.next();  // subscribed
    send(ws, { op: 'resize', subscriberId: 'sub-1', cols: -1, rows: 10 });
    const m = await reader.next();
    expect(m.type).toBe('error');
    if (m.type === 'error') expect(m.code).toBe('invalid_size');
    ws.close();
  });

  it('enqueueInput rejection surfaces input_failed to subscriber', async () => {
    const { app, port: p, ctx } = await startApp({ withPaneStreamerManager: true });
    runningApp = app;
    // Override enqueueInput to reject with a known error
    ctx.paneStreamerManager!.enqueueInput = vi.fn().mockRejectedValue(new Error('load-buffer boom'));
    const ws = openWs(p);
    const reader = attachMessageReader(ws);
    await waitOpen(ws);
    send(ws, { op: 'subscribe', subscriberId: 'sub-1', agentId: 'dev-1', mode: 'full' });
    await reader.next();  // snapshot
    await reader.next();  // subscribed
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
});

describe('streamWsPlugin /api/stream — transport error handling', () => {
  it('does not crash on transport-level socket error (writes garbage bytes)', async () => {
    const { app, port: p } = await startApp({ withPaneStreamerManager: true });
    runningApp = app;
    const ws = openWs(p);
    await waitOpen(ws);
    // Bypass ws library framing and write bytes that aren't a valid WS
    // continuation — server-side ws will emit 'error' on the socket.
    const inner = (ws as unknown as { _socket: { write: (b: Buffer) => boolean } })._socket;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      inner.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
      // If error handler missing, server crashes here (Node uncaughtException).
      // Give it a tick to process, then verify a fresh connection still opens.
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
