import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { BaxianConfig, BaxianEvent, ProjectConfig } from '../../src/shared/index.js';
import {
  requesters,
  seedConfigPath,
  setupApiHarness,
  teardownApiHarness,
  JSON_HEADERS,
  type ApiHarness,
} from './helpers.js';

let harness: ApiHarness;
let tempDir: string;
let app: FastifyInstance;
const { get, patch } = requesters(() => app);

beforeEach(async () => {
  harness = await setupApiHarness('other');
  ({ tempDir, app } = harness);
});

afterEach(() => teardownApiHarness(harness));

describe('GET /api/events', () => {
  it('returns events for today (default)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const event: BaxianEvent = {
      id: 'evt-test-001',
      type: 'task.assigned',
      timestamp: `${today}T10:00:00Z`,
      projectId: 'proj',
      agentId: 'dev-1',
      taskId: 'task-001',
      data: {},
    };
    await app.ctx.eventLog.append(event);

    const response = await get('/api/events');
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as BaxianEvent[];
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('evt-test-001');
  });

  it('returns events for a specific date', async () => {
    const date = '2025-01-15';
    const event: BaxianEvent = {
      id: 'evt-test-002',
      type: 'session.started',
      timestamp: `${date}T10:00:00Z`,
      projectId: 'proj',
      data: {},
    };
    await app.ctx.eventLog.append(event);

    const response = await get(`/api/events?date=${date}`);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as BaxianEvent[];
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('evt-test-002');
  });
});

describe('GET /api/config', () => {
  it('returns current config', async () => {
    const response = await get('/api/config');
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as BaxianConfig;
    expect(body.server.port).toBe(3000);
    expect(body.project).toHaveLength(1);
  });

  it('redacts server.token when set', async () => {
    const token = 'super-secret-token';
    app.ctx.config = { ...app.ctx.config, server: { ...app.ctx.config.server, token } };
    const response = await get('/api/config', { headers: { Authorization: `Bearer ${token}` } });
    const body = JSON.parse(response.body) as BaxianConfig;
    expect(body.server.token).toBe('***');
  });

  it('redacts registry host passwords', async () => {
    app.ctx.config = { ...app.ctx.config, host: [{ id: 'box', hostname: 'h', password: 'reg-secret' }] };
    const response = await get('/api/config');
    const body = JSON.parse(response.body) as BaxianConfig;
    expect(body.host[0].password).toBe('***');
  });

  it('redacts a legacy inline agent.host password on GET /config and GET /projects', async () => {
    app.ctx.config = {
      ...app.ctx.config,
      project: [{
        id: 'proj', repo: 'user/repo', merge: null,
        agent: [[{ id: 'rdev', runtime: 'claude-code', role: 'dev', mode: 'remote', host: { hostname: 'legacy', password: 'inline-secret' } }]],
      }],
    };
    const cfg = JSON.parse((await get('/api/config')).body) as BaxianConfig;
    expect((cfg.project[0].agent[0][0].host as { password?: string }).password).toBe('***');

    const projects = JSON.parse((await get('/api/projects')).body) as ProjectConfig[];
    expect((projects[0].agent[0][0].host as { password?: string }).password).toBe('***');
  });

});

describe('PATCH /api/config', () => {
  it('preserves existing server.token when client round-trips the redacted placeholder', async () => {
    const original = 'real-token-value';
    await seedConfigPath(app, tempDir);
    app.ctx.config = { ...app.ctx.config, server: { ...app.ctx.config.server, token: original } };

    const response = await patch('/api/config', { server: { port: 3000, token: '***' } }, {
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${original}` },
    });
    expect(response.statusCode).toBe(200);
    expect(app.ctx.config.server.token).toBe(original);
  });

  it('clears server.token when client sends an explicit empty/whitespace value', async () => {
    const original = 'abc';
    await seedConfigPath(app, tempDir);
    app.ctx.config = { ...app.ctx.config, server: { ...app.ctx.config.server, token: original } };

    const response = await patch('/api/config', { server: { port: 3000, token: '   ' } }, {
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${original}` },
    });
    expect(response.statusCode).toBe(200);
    expect(app.ctx.config.server.token).toBeUndefined();
  });

  it('rejects host edits via PATCH /config (registry is managed via /hosts) and preserves current.host', async () => {
    await seedConfigPath(app, tempDir);
    app.ctx.config = { ...app.ctx.config, host: [{ id: 'box', hostname: 'h', port: 22, password: 'real-secret' }] };

    for (const hostPayload of [
      [{ id: 'box', hostname: 'moved', port: 2222 }],
      [{ id: 'box', hostname: 'h', port: 22, password: '***' }],
      null,
      'oops',
      { id: 'x' },
    ]) {
      const response = await patch('/api/config', { host: hostPayload }, { headers: JSON_HEADERS });
      expect(response.statusCode, JSON.stringify(hostPayload)).toBe(400);
    }
    expect(app.ctx.config.host[0].hostname).toBe('h');
    expect(app.ctx.config.host[0].password).toBe('real-secret');
  });

  it('returns 400 (not 500) for a malformed project on PATCH /config (host-ref guard runs post-validation)', async () => {
    await seedConfigPath(app, tempDir);
    for (const bad of [
      { id: 'bad' },
      'oops',
      [{ id: 'pp', repo: 'u/r', merge: null, agent: { not: 'array' } }],
    ]) {
      const response = await patch('/api/config', { project: bad }, { headers: JSON_HEADERS });
      expect(response.statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it('rejects changing the host of a live agent via PATCH /config project replace (409)', async () => {
    await seedConfigPath(app, tempDir);
    app.ctx.config = {
      ...app.ctx.config,
      host: [{ id: 'box', hostname: 'h', port: 22 }, { id: 'box2', hostname: 'h2', port: 22 }],
      project: [{
        id: 'proj', repo: 'user/repo', merge: null,
        agent: [[{ id: 'rdev', runtime: 'claude-code', role: 'dev', mode: 'remote', host: 'box' }]],
      }],
    };
    app.ctx.tmuxSessionStatusStore.set('rdev', { tmuxSessionStatus: 'present' });

    const response = await patch('/api/config', {
      project: [{
        id: 'proj', repo: 'user/repo', merge: null,
        agent: [[{ id: 'rdev', runtime: 'claude-code', role: 'dev', mode: 'remote', host: 'box2' }]],
      }],
    }, { headers: JSON_HEADERS });
    expect(response.statusCode).toBe(409);
    expect((app.ctx.config.project[0].agent[0][0]).host).toBe('box');
  });

  it('rejects PATCH with out-of-range server.githubPollIntervalMs and preserves existing valid value', async () => {
    await seedConfigPath(app, tempDir);
    app.ctx.config = {
      ...app.ctx.config,
      server: { ...app.ctx.config.server, githubPollIntervalMs: 45000 },
    };

    for (const bad of [500, 1500.5, 2147483648]) {
      const response = await patch('/api/config', { server: { port: 3000, githubPollIntervalMs: bad } }, { headers: JSON_HEADERS });
      expect(response.statusCode).toBe(400);
      expect(app.ctx.config.server.githubPollIntervalMs).toBe(45000);
    }
  });

  it('accepts PATCH with valid server.githubPollIntervalMs and persists it', async () => {
    await seedConfigPath(app, tempDir);

    const response = await patch('/api/config', { server: { port: 3000, githubPollIntervalMs: 60000 } }, { headers: JSON_HEADERS });
    expect(response.statusCode).toBe(200);
    expect(app.ctx.config.server.githubPollIntervalMs).toBe(60000);
  });

  it('rejects non-object JSON bodies (primitive / array) with 400, not 500', async () => {
    await seedConfigPath(app, tempDir);

    for (const value of ['x', 123, true, null, [1, 2, 3]]) {
      const response = await patch('/api/config', JSON.stringify(value), { headers: JSON_HEADERS });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body) as { error?: string };
      expect(body.error).toBe('Invalid config');
    }
  });

  it('sweeps errorRecordStore by new auto-bootstrap id set on bulk config replace', async () => {
    await seedConfigPath(app, tempDir);
    app.ctx.config = {
      ...app.ctx.config,
      project: [{
        id: 'p1', repo: 'a/b', merge: null,
        agent: [[{ id: 'going-away', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true }]],
      }],
    };
    const sweepStaleBootstrapErrors = vi.fn().mockResolvedValue({ removed: 0 });
    app.ctx.errorRecordStore = { sweepStaleBootstrapErrors } as never;

    const response = await patch('/api/config', { project: [] }, { headers: JSON_HEADERS });
    expect(response.statusCode).toBe(200);
    expect(sweepStaleBootstrapErrors).toHaveBeenCalledTimes(1);
    expect(sweepStaleBootstrapErrors.mock.calls[0][0].size).toBe(0);
  });

  it('sweep treats agent transitioned to explicit workdir as no longer in auto-bootstrap', async () => {
    await seedConfigPath(app, tempDir);
    app.ctx.config = {
      ...app.ctx.config,
      project: [{
        id: 'p1', repo: 'a/b', merge: null,
        agent: [[{ id: 'becoming-manual', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true }]],
      }],
    };
    const sweepStaleBootstrapErrors = vi.fn().mockResolvedValue({ removed: 1 });
    app.ctx.errorRecordStore = { sweepStaleBootstrapErrors } as never;

    const response = await patch('/api/config', { project: [{
      id: 'p1', repo: 'a/b', merge: null,
      agent: [[{ id: 'becoming-manual', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/manual', yolo: true }]],
    }] }, { headers: JSON_HEADERS });
    expect(response.statusCode).toBe(200);
    const activeSet = sweepStaleBootstrapErrors.mock.calls[0][0] as Set<string>;
    expect(activeSet.has('becoming-manual')).toBe(false);
  });

  describe('restart-required diff', () => {
    async function patchAndRead(payload: unknown): Promise<{ statusCode: number; body: { restartRequired: boolean; note: string } }> {
      await seedConfigPath(app, tempDir);
      const response = await patch('/api/config', payload, { headers: JSON_HEADERS });
      return { statusCode: response.statusCode, body: JSON.parse(response.body) };
    }

    it('hot-reloads when only review/poller/token changes (restartRequired=false)', async () => {
      const agentReplace = vi.spyOn(app.ctx.agentManager, 'replaceConfig');
      const tmuxReplace = vi.fn();
      const bootstrapReplace = vi.fn();
      const pollerReplace = vi.fn();
      app.ctx.tmuxProbePoller = { replaceConfig: tmuxReplace, stop: vi.fn() } as never;
      app.ctx.bootstrapPoller = { replaceConfig: bootstrapReplace, stop: vi.fn() } as never;
      app.ctx.poller = { replaceConfig: pollerReplace, stop: vi.fn() } as never;

      const { statusCode, body } = await patchAndRead({
        review: { rounds: 5 },
        server: { port: 3000, githubPollIntervalMs: 60000 },
      });
      expect(statusCode).toBe(200);
      expect(body.restartRequired).toBe(false);
      expect(agentReplace).toHaveBeenCalledTimes(1);
      expect(tmuxReplace).toHaveBeenCalledTimes(1);
      expect(bootstrapReplace).toHaveBeenCalledTimes(1);
      expect(pollerReplace).toHaveBeenCalledTimes(1);
    });

    it('requires restart when server.port changes (no replaceConfig calls)', async () => {
      const agentReplace = vi.spyOn(app.ctx.agentManager, 'replaceConfig');
      const pollerReplace = vi.fn();
      app.ctx.poller = { replaceConfig: pollerReplace, stop: vi.fn() } as never;

      const { statusCode, body } = await patchAndRead({ server: { port: 4444 } });
      expect(statusCode).toBe(200);
      expect(body.restartRequired).toBe(true);
      expect(body.note).toMatch(/restart/);
      expect(agentReplace).not.toHaveBeenCalled();
      expect(pollerReplace).not.toHaveBeenCalled();
    });

    it('requires restart when server.host changes', async () => {
      app.ctx.config = { ...app.ctx.config, server: { ...app.ctx.config.server, host: '0.0.0.0' } };
      const { statusCode, body } = await patchAndRead({ server: { port: 3000, host: '127.0.0.1' } });
      expect(statusCode).toBe(200);
      expect(body.restartRequired).toBe(true);
    });

    it('requires restart when server.https toggles or its key/cert paths change', async () => {
      const tmpA = join(tempDir, 'a.key');
      const tmpB = join(tempDir, 'b.key');
      const tmpCert = join(tempDir, 'a.cert');
      await Promise.all([
        writeFile(tmpA, 'k'), writeFile(tmpB, 'k2'), writeFile(tmpCert, 'c'),
      ]);
      app.ctx.config = {
        ...app.ctx.config,
        server: { ...app.ctx.config.server, https: { keyFile: tmpA, certFile: tmpCert } },
      };
      const { body } = await patchAndRead({
        server: { port: 3000, https: { keyFile: tmpB, certFile: tmpCert } },
      });
      expect(body.restartRequired).toBe(true);
    });

    it('does not require restart when allowedHosts changes', async () => {
      const pollerReplace = vi.fn();
      app.ctx.poller = { replaceConfig: pollerReplace, stop: vi.fn() } as never;
      const { body } = await patchAndRead({
        server: { port: 3000, allowedHosts: ['baxian.dev', 'admin.baxian.dev'] },
      });
      expect(body.restartRequired).toBe(false);
    });
  });
});

describe('GET /api/projects', () => {
  it('returns project list', async () => {
    const response = await get('/api/projects');
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as ProjectConfig[];
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('proj');
    expect(body[0].repo).toBe('user/repo');
  });
});

describe('GET /api/projects/:id', () => {
  it('returns project details for known id', async () => {
    const response = await get('/api/projects/proj');
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as ProjectConfig;
    expect(body.id).toBe('proj');
    expect(body.repo).toBe('user/repo');
  });

  it('returns 404 for unknown project', async () => {
    const response = await get('/api/projects/no-such-project');
    expect(response.statusCode).toBe(404);
  });
});
