import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PollerSnapshot } from '../../src/shared/index.js';
import { buildApp } from '../../src/app.js';
import { createTestContext } from '../helpers/context.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-pollers-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

describe('GET /api/pollers', () => {
  it('returns [] when no poller is configured (legacy ctx)', async () => {
    const ctx = await createTestContext(tempDir);
    const app = await buildApp(ctx);
    const response = await app.inject({ method: 'GET', url: '/api/pollers' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual([]);
    await app.close();
  });

  it('returns snapshots from poller', async () => {
    const ctx = await createTestContext(tempDir);
    const sample: PollerSnapshot[] = [
      {
        repo: 'user/repo',
        projectId: 'proj',
        intervalMs: 30_000,
        isPolling: false,
        consecutiveFailures: 0,
        health: 'healthy',
        lastPollEndedAt: '2026-05-12T01:00:00.000Z',
      },
    ];
    ctx.poller = {
      snapshots: () => sample,
      stop: () => undefined,
    } as never;
    const app = await buildApp(ctx);
    const response = await app.inject({ method: 'GET', url: '/api/pollers' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(sample);
    await app.close();
  });

  it('requires bearer token when server.token is set', async () => {
    const ctx = await createTestContext(tempDir);
    ctx.config = { ...ctx.config, server: { ...ctx.config.server, token: 's3cret' } };
    ctx.poller = { snapshots: () => [], stop: () => undefined } as never;
    const app = await buildApp(ctx);

    const unauth = await app.inject({ method: 'GET', url: '/api/pollers' });
    expect(unauth.statusCode).toBe(401);

    const authed = await app.inject({
      method: 'GET',
      url: '/api/pollers',
      headers: { authorization: 'Bearer s3cret' },
    });
    expect(authed.statusCode).toBe(200);

    await app.close();
  });
});
