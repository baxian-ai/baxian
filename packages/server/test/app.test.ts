import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../src/app.js';
import { createTestContext } from './helpers/context.js';
import type { TmuxProbePoller } from '../src/agent/tmux-probe-poller.js';
import type { BootstrapPoller } from '../src/agent/bootstrap-poller.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-app-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

describe('buildApp', () => {
  it('GET /health returns { status, startedAt }', async () => {
    const ctx = await createTestContext(tempDir);
    const app = await buildApp(ctx);
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('ok');
    expect(typeof body.startedAt).toBe('string');
    expect(new Date(body.startedAt).toISOString()).toBe(body.startedAt);
    await app.close();
  });

  it('GET /api/health returns 404 (old path removed)', async () => {
    const ctx = await createTestContext(tempDir);
    const app = await buildApp(ctx);
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('GET /health is exempt from token auth (also tolerant to cache-busting query strings)', async () => {
    const ctx = await createTestContext(tempDir);
    ctx.config = { ...ctx.config, server: { ...ctx.config.server, token: 's3cret' } };
    const app = await buildApp(ctx);

    const okRes = await app.inject({ method: 'GET', url: '/health' });
    expect(okRes.statusCode).toBe(200);

    const queryRes = await app.inject({ method: 'GET', url: '/health?cacheBust=123' });
    expect(queryRes.statusCode).toBe(200);

    const guardedRes = await app.inject({ method: 'GET', url: '/api/agents' });
    expect(guardedRes.statusCode).toBe(401);

    await app.close();
  });

  it('onClose hook stops tmuxProbePoller + GitHub poller (single poller)', async () => {
    const ctx = await createTestContext(tempDir);
    const tmuxProbeStop = vi.fn();
    const pollerStop = vi.fn();
    ctx.tmuxProbePoller = { start: vi.fn(), stop: tmuxProbeStop } as never;
    ctx.poller = { start: vi.fn(), stop: pollerStop, add: vi.fn(), poll: vi.fn() } as never;
    const app = await buildApp(ctx);
    await app.close();
    expect(tmuxProbeStop).toHaveBeenCalledTimes(1);
    expect(pollerStop).toHaveBeenCalledTimes(1);
  });

  it('onClose stops both tmuxProbePoller and bootstrapPoller', async () => {
    const ctx = await createTestContext(tempDir);
    const tmuxProbe = { stop: vi.fn() } as unknown as TmuxProbePoller;
    const bootstrap = { stop: vi.fn() } as unknown as BootstrapPoller;
    ctx.tmuxProbePoller = tmuxProbe;
    ctx.bootstrapPoller = bootstrap;
    const app = await buildApp(ctx);
    await app.close();
    expect(tmuxProbe.stop as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    expect(bootstrap.stop as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });

  it('onClose destroys all pane streamers (PTY teardown) and does NOT release the process lock', async () => {
    const ctx = await createTestContext(tempDir);
    const destroyAll = vi.fn(async () => undefined);
    ctx.paneStreamerManager = { destroyAll } as never;
    const app = await buildApp(ctx);
    await app.close();
    expect(destroyAll).toHaveBeenCalledTimes(1);
  });

  describe('allowedHosts', () => {
    function withAllowedHosts(ctx: Awaited<ReturnType<typeof createTestContext>>, hosts: string[]) {
      ctx.config = { ...ctx.config, server: { ...ctx.config.server, allowedHosts: hosts } };
    }

    it('accepts whitelisted Host header', async () => {
      const ctx = await createTestContext(tempDir);
      withAllowedHosts(ctx, ['baxian.dev', 'www.baxian.dev']);
      const app = await buildApp(ctx);
      const res = await app.inject({ method: 'GET', url: '/health', headers: { host: 'baxian.dev' } });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it('rejects non-whitelisted Host header with 404 (does not leak validation)', async () => {
      const ctx = await createTestContext(tempDir);
      withAllowedHosts(ctx, ['baxian.dev']);
      const app = await buildApp(ctx);
      const res = await app.inject({ method: 'GET', url: '/health', headers: { host: 'evil.example.com' } });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it('strips port from Host header before comparison', async () => {
      const ctx = await createTestContext(tempDir);
      withAllowedHosts(ctx, ['baxian.dev']);
      const app = await buildApp(ctx);
      const res = await app.inject({ method: 'GET', url: '/health', headers: { host: 'baxian.dev:8123' } });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it('omitted/empty allowedHosts accepts any Host (dev mode)', async () => {
      const ctx = await createTestContext(tempDir);
      const app = await buildApp(ctx);
      const res = await app.inject({ method: 'GET', url: '/health', headers: { host: 'anything.test' } });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it('accepts IPv6 literal Host header (uses request.hostname, not split on colon)', async () => {
      const ctx = await createTestContext(tempDir);
      withAllowedHosts(ctx, ['::1']);
      const app = await buildApp(ctx);
      const res = await app.inject({ method: 'GET', url: '/health', headers: { host: '[::1]:443' } });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it('matches Host case-insensitively (HTTP host names are case-insensitive per RFC 7230)', async () => {
      const ctx = await createTestContext(tempDir);
      withAllowedHosts(ctx, ['baxian.dev']);
      const app = await buildApp(ctx);
      const res = await app.inject({ method: 'GET', url: '/health', headers: { host: 'BAXIAN.DEV' } });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it('trims whitespace from configured allowedHosts entries', async () => {
      const ctx = await createTestContext(tempDir);
      withAllowedHosts(ctx, ['  baxian.dev  ']);
      const app = await buildApp(ctx);
      const res = await app.inject({ method: 'GET', url: '/health', headers: { host: 'baxian.dev' } });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it('strips port from configured entries — "baxian.dev:443" matches Host: baxian.dev', async () => {
      const ctx = await createTestContext(tempDir);
      withAllowedHosts(ctx, ['baxian.dev:443']);
      const app = await buildApp(ctx);
      const res = await app.inject({ method: 'GET', url: '/health', headers: { host: 'baxian.dev' } });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it('strips port from IPv6 bracketed entries — "[::1]:443" matches Host: [::1]:443', async () => {
      const ctx = await createTestContext(tempDir);
      withAllowedHosts(ctx, ['[::1]:443']);
      const app = await buildApp(ctx);
      const res = await app.inject({ method: 'GET', url: '/health', headers: { host: '[::1]:443' } });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it('hot-reload: replacing ctx.config takes effect on the very next request', async () => {
      const ctx = await createTestContext(tempDir);
      withAllowedHosts(ctx, ['baxian.dev']);
      const app = await buildApp(ctx);

      const before = await app.inject({ method: 'GET', url: '/health', headers: { host: 'late.example.com' } });
      expect(before.statusCode).toBe(404);

      ctx.config = { ...ctx.config, server: { ...ctx.config.server, allowedHosts: ['late.example.com'] } };

      const after = await app.inject({ method: 'GET', url: '/health', headers: { host: 'late.example.com' } });
      expect(after.statusCode).toBe(200);

      ctx.config = { ...ctx.config, server: { ...ctx.config.server, allowedHosts: undefined } };
      const open = await app.inject({ method: 'GET', url: '/health', headers: { host: 'anything.test' } });
      expect(open.statusCode).toBe(200);
      await app.close();
    });
  });

  describe('token auth scope', () => {
    it('token check decodes URL — percent-encoded /api cannot bypass Bearer auth (e.g. /%61pi/agents)', async () => {
      const ctx = await createTestContext(tempDir);
      ctx.config = { ...ctx.config, server: { ...ctx.config.server, token: 's3cret' } };
      const app = await buildApp(ctx);

      const raw = await app.inject({ method: 'GET', url: '/api/agents' });
      expect(raw.statusCode).toBe(401);

      const encoded = await app.inject({ method: 'GET', url: '/%61pi/agents' });
      expect(encoded.statusCode).toBe(401);
      await app.close();
    });

    it('malformed URL (lone %) is rejected with 400, not allowed through as a non-/api request', async () => {
      const ctx = await createTestContext(tempDir);
      ctx.config = { ...ctx.config, server: { ...ctx.config.server, token: 's3cret' } };
      const app = await buildApp(ctx);
      const res = await app.inject({ method: 'GET', url: '/api/%' });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it('token does NOT block static SPA shell (browser cannot attach Authorization on first nav)', async () => {
      const root = join(tempDir, 'web-token-static');
      await mkdir(join(root, 'assets'), { recursive: true });
      await writeFile(join(root, 'index.html'), '<!doctype html><html><body>shell</body></html>');
      await writeFile(join(root, 'assets', 'app.js'), 'console.log("ok");');
      const ctx = await createTestContext(tempDir);
      ctx.config = { ...ctx.config, server: { ...ctx.config.server, token: 's3cret' } };
      const app = await buildApp(ctx, { webRoot: root });

      const shell = await app.inject({ method: 'GET', url: '/' });
      expect(shell.statusCode).toBe(200);
      expect(shell.body).toContain('shell');

      const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.body).toContain('console.log');

      const spaRoute = await app.inject({ method: 'GET', url: '/projects/deep' });
      expect(spaRoute.statusCode).toBe(200);
      expect(spaRoute.body).toContain('shell');

      const guarded = await app.inject({ method: 'GET', url: '/api/agents' });
      expect(guarded.statusCode).toBe(401);
      await app.close();
    });
  });

  describe('static + SPA fallback', () => {
    async function seedWebRoot(dir: string): Promise<string> {
      const root = join(dir, 'web-dist');
      await mkdir(join(root, 'assets'), { recursive: true });
      await writeFile(join(root, 'index.html'), '<!doctype html><html><body>SPA shell</body></html>');
      await writeFile(join(root, 'assets', 'app.js'), 'console.log("app");');
      return root;
    }

    it('serves built index.html at /', async () => {
      const webRoot = await seedWebRoot(tempDir);
      const ctx = await createTestContext(tempDir);
      const app = await buildApp(ctx, { webRoot });
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('SPA shell');
      await app.close();
    });

    it('serves static assets verbatim', async () => {
      const webRoot = await seedWebRoot(tempDir);
      const ctx = await createTestContext(tempDir);
      const app = await buildApp(ctx, { webRoot });
      const res = await app.inject({ method: 'GET', url: '/assets/app.js' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('console.log("app")');
      await app.close();
    });

    it('falls back to index.html for unknown non-api paths (SPA routing)', async () => {
      const webRoot = await seedWebRoot(tempDir);
      const ctx = await createTestContext(tempDir);
      const app = await buildApp(ctx, { webRoot });
      const res = await app.inject({ method: 'GET', url: '/projects/some-deep/route' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('SPA shell');
      await app.close();
    });

    it('returns 404 JSON for unknown /api/* (no SPA shell leak)', async () => {
      const webRoot = await seedWebRoot(tempDir);
      const ctx = await createTestContext(tempDir);
      const app = await buildApp(ctx, { webRoot });
      const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toMatch(/json/);
      await app.close();
    });

    it('/api routes win over static (token-protected /api/agents still 401)', async () => {
      const webRoot = await seedWebRoot(tempDir);
      const ctx = await createTestContext(tempDir);
      ctx.config = { ...ctx.config, server: { ...ctx.config.server, token: 's3cret' } };
      const app = await buildApp(ctx, { webRoot });
      const res = await app.inject({ method: 'GET', url: '/api/agents' });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it('bare /api also returns API 404 JSON (does not fall through to SPA shell)', async () => {
      const webRoot = await seedWebRoot(tempDir);
      const ctx = await createTestContext(tempDir);
      const app = await buildApp(ctx, { webRoot });
      const res = await app.inject({ method: 'GET', url: '/api' });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toMatch(/json/);
      await app.close();
    });

    it('/api with query string returns API 404 JSON (not SPA)', async () => {
      const webRoot = await seedWebRoot(tempDir);
      const ctx = await createTestContext(tempDir);
      const app = await buildApp(ctx, { webRoot });
      const res = await app.inject({ method: 'GET', url: '/api?q=1' });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toMatch(/json/);
      await app.close();
    });

    it('non-GET/HEAD to unknown path returns 404 (not 200 SPA shell)', async () => {
      const webRoot = await seedWebRoot(tempDir);
      const ctx = await createTestContext(tempDir);
      const app = await buildApp(ctx, { webRoot });
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) {
        const res = await app.inject({ method, url: '/some-mistyped-route' });
        expect(res.statusCode).toBe(404);
        expect(res.body).not.toContain('SPA shell');
      }
      await app.close();
    });

    it('asset miss (URL ending with .js/.css/etc.) returns 404, NOT the SPA shell', async () => {
      const webRoot = await seedWebRoot(tempDir);
      const ctx = await createTestContext(tempDir);
      const app = await buildApp(ctx, { webRoot });
      for (const url of [
        '/assets/old-chunk-deadbeef.js',
        '/assets/styles-cafebabe.css',
        '/some-image.png',
        '/favicon.ico',
      ]) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(404);
        expect(res.body).not.toContain('SPA shell');
      }
      await app.close();
    });

    it('SPA fallback still serves index.html for extensionless deep routes (e.g. /projects/abc/123)', async () => {
      const webRoot = await seedWebRoot(tempDir);
      const ctx = await createTestContext(tempDir);
      const app = await buildApp(ctx, { webRoot });
      for (const url of ['/projects', '/projects/abc', '/projects/abc/123', '/dashboard']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('SPA shell');
      }
      await app.close();
    });

    it('SPA fallback serves index.html for dot-containing client routes (/users/alice.smith, /releases/v1.2.3)', async () => {
      const webRoot = await seedWebRoot(tempDir);
      const ctx = await createTestContext(tempDir);
      const app = await buildApp(ctx, { webRoot });
      for (const url of ['/users/alice.smith', '/releases/v1.2.3', '/a.b.c']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('SPA shell');
      }
      await app.close();
    });

    it('index.html is served with Cache-Control: no-cache (avoid stale shell after deploy)', async () => {
      const webRoot = await seedWebRoot(tempDir);
      const ctx = await createTestContext(tempDir);
      const app = await buildApp(ctx, { webRoot });

      const rootRes = await app.inject({ method: 'GET', url: '/' });
      expect(rootRes.headers['cache-control']).toContain('no-cache');

      const spaRes = await app.inject({ method: 'GET', url: '/projects/deep' });
      expect(spaRes.headers['cache-control']).toContain('no-cache');

      const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
      expect(asset.headers['cache-control']).toMatch(/max-age=\d+/);
      await app.close();
    });
  });
});
