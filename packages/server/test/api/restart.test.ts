import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../../src/app.js';
import { createTestContext } from '../helpers/context.js';
import type { RestartCoordinator } from '../../src/lifecycle/restart.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-restart-route-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

function fakeCoord(): RestartCoordinator {
  let restarting = false;
  return {
    isRestarting: vi.fn(() => restarting),
    beginRestart: vi.fn(({ actor: _ }: { actor: string }) => {
      restarting = true;
    }),
    execute: vi.fn(async () => {}),
  } as unknown as RestartCoordinator;
}

describe('POST /api/restart', () => {
  it('returns 503 when no coordinator wired', async () => {
    const ctx = await createTestContext(tempDir);
    const app = await buildApp(ctx);
    const res = await app.inject({ method: 'POST', url: '/api/restart' });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it('returns 202 + acceptedAt when coordinator idle', async () => {
    const ctx = await createTestContext(tempDir);
    const coord = fakeCoord();
    ctx.restartCoordinator = coord;
    const app = await buildApp(ctx);
    const res = await app.inject({
      method: 'POST',
      url: '/api/restart',
      headers: { 'x-baxian-actor': 'tester' },
    });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(typeof body.acceptedAt).toBe('string');
    expect(coord.beginRestart).toHaveBeenCalledWith({ actor: 'tester' });
    await new Promise(r => setImmediate(r));
    expect(coord.execute).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('defaults actor to "unknown" when header missing', async () => {
    const ctx = await createTestContext(tempDir);
    const coord = fakeCoord();
    ctx.restartCoordinator = coord;
    const app = await buildApp(ctx);
    await app.inject({ method: 'POST', url: '/api/restart' });
    expect(coord.beginRestart).toHaveBeenCalledWith({ actor: 'unknown' });
    await app.close();
  });

  it('returns 409 when already restarting', async () => {
    const ctx = await createTestContext(tempDir);
    const coord = fakeCoord();
    (coord.isRestarting as ReturnType<typeof vi.fn>) = vi.fn(() => true);
    ctx.restartCoordinator = coord;
    const app = await buildApp(ctx);
    const res = await app.inject({ method: 'POST', url: '/api/restart' });
    expect(res.statusCode).toBe(409);
    expect(coord.beginRestart).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects unauth when token configured', async () => {
    const ctx = await createTestContext(tempDir);
    ctx.config = { ...ctx.config, server: { ...ctx.config.server, token: 's3cret' } };
    ctx.restartCoordinator = fakeCoord();
    const app = await buildApp(ctx);
    const res = await app.inject({ method: 'POST', url: '/api/restart' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('accepts auth when token correct', async () => {
    const ctx = await createTestContext(tempDir);
    ctx.config = { ...ctx.config, server: { ...ctx.config.server, token: 's3cret' } };
    ctx.restartCoordinator = fakeCoord();
    const app = await buildApp(ctx);
    const res = await app.inject({
      method: 'POST',
      url: '/api/restart',
      headers: { authorization: 'Bearer s3cret' },
    });
    expect(res.statusCode).toBe(202);
    await app.close();
  });
});
