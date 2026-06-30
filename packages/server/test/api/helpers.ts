import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/app.js';
import { createTestContext } from '../helpers/context.js';

export interface ApiHarness {
  tempDir: string;
  app: FastifyInstance;
}

export async function setupApiHarness(label: string): Promise<ApiHarness> {
  const tempDir = await mkdtemp(join(tmpdir(), `baxian-${label}-test-`));
  const ctx = await createTestContext(tempDir);
  const app = await buildApp(ctx);
  return { tempDir, app };
}

export async function teardownApiHarness(harness?: ApiHarness): Promise<void> {
  if (!harness) return;
  const { app, tempDir } = harness;
  await app.close();
  await rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

type Inject = FastifyInstance['inject'];

export interface RequestHelpers {
  get(url: string, opts?: InjectOptions): ReturnType<Inject>;
  post(url: string, payload?: unknown, opts?: InjectOptions): ReturnType<Inject>;
  put(url: string, payload?: unknown, opts?: InjectOptions): ReturnType<Inject>;
  patch(url: string, payload?: unknown, opts?: InjectOptions): ReturnType<Inject>;
  del(url: string, opts?: InjectOptions): ReturnType<Inject>;
}

export function requesters(getApp: () => FastifyInstance): RequestHelpers {
  return {
    get: (url, opts) => getApp().inject({ method: 'GET', url, ...opts }),
    post: (url, payload, opts) => getApp().inject({ method: 'POST', url, payload, ...opts }),
    put: (url, payload, opts) => getApp().inject({ method: 'PUT', url, payload, ...opts }),
    patch: (url, payload, opts) => getApp().inject({ method: 'PATCH', url, payload, ...opts }),
    del: (url, opts) => getApp().inject({ method: 'DELETE', url, ...opts }),
  };
}

export function expectStatus(
  response: LightMyRequestResponse,
  status: number,
  errorMatch?: RegExp,
  label?: string,
): void {
  expect.soft(response.statusCode, label).toBe(status);
  if (errorMatch) expect.soft(JSON.parse(response.body).error, label).toMatch(errorMatch);
}

export async function seedConfigPath(app: FastifyInstance, tempDir: string): Promise<string> {
  const configPath = join(tempDir, 'baxian.json');
  await writeFile(configPath, '{}');
  app.ctx.configPath = configPath;
  return configPath;
}

export const JSON_HEADERS = { 'Content-Type': 'application/json' };
