import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import { createTestContext } from '../helpers/context.js';
import { hostRoutes } from '../../src/api/hosts.js';
import * as loader from '../../src/config/loader.js';
import { ConfigValidationError } from '../../src/config/loader.js';
import type { AppContext } from '../../src/app.js';
import type { CommandRunner } from '../../src/agent/runner.js';
import type { ProjectConfig } from '../../src/shared/index.js';

let tempDir: string;
let ctx: AppContext;
let openApps: FastifyInstance[];

interface Captured { cmd: string; env?: Record<string, string> }

function remoteAgentProject(): ProjectConfig {
  return {
    id: 'proj', repo: 'https://github.com/user/repo.git', merge: null,
    agent: [[
      { id: 'rdev', runtime: 'claude-code', role: 'dev', mode: 'remote', host: 'box' },
      { id: 'rqa', runtime: 'codex', role: 'qa', mode: 'remote', host: 'box' },
    ]],
  };
}

async function buildHostApp(runner: CommandRunner): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate('ctx', ctx);
  await app.register(hostRoutes, { prefix: '/api', localRunnerFactory: () => runner });
  await app.ready();
  openApps.push(app);
  return app;
}

async function makeApp(ok: boolean): Promise<{ app: FastifyInstance; calls: Captured[] }> {
  const calls: Captured[] = [];
  const runner: CommandRunner = {
    exec: async (cmd, options) => {
      calls.push({ cmd, env: options?.env });
      return { stdout: ok ? 'ok' : '', stderr: ok ? '' : 'auth denied', exitCode: ok ? 0 : 1 };
    },
    writeFile: async () => undefined,
    execWithStdin: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  };
  return { app: await buildHostApp(runner), calls };
}

beforeEach(async () => {
  openApps = [];
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-hosts-test-'));
  ctx = await createTestContext(tempDir);
  ctx.configPath = join(tempDir, 'baxian.json');
  await writeFile(ctx.configPath, JSON.stringify(ctx.config, null, 2));
});

afterEach(async () => {
  await Promise.all(openApps.map((a) => a.close()));
  await rm(tempDir, { recursive: true });
});

describe('POST /api/hosts', () => {
  it('checks connectivity, generates an id from the alias, and persists (password redacted on read)', async () => {
    const { app } = await makeApp(true);
    const res = await app.inject({
      method: 'POST', url: '/api/hosts',
      payload: { hostname: 'h.example.com', alias: 'Prod DB', user: 'agent', password: 'sekret' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.host.id).toBe('prod-db');
    expect(body.host.password).toBe('***');
    expect(ctx.config.host[0].password).toBe('sekret');
  });

  it('rejects with 400 and does NOT persist when connectivity fails', async () => {
    const { app } = await makeApp(false);
    const res = await app.inject({
      method: 'POST', url: '/api/hosts',
      payload: { hostname: 'h.example.com', alias: 'box' },
    });
    expect(res.statusCode).toBe(400);
    expect(ctx.config.host).toHaveLength(0);
  });

  it('forces a fresh authenticated connection (noMux) for the connectivity check', async () => {
    const { app, calls } = await makeApp(true);
    await app.inject({ method: 'POST', url: '/api/hosts', payload: { hostname: 'h', alias: 'box' } });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toContain('ControlPath=none');
    expect(calls[0].cmd).not.toContain('cm-%C');
  });

  it('passes the submitted password to the check via env, never via argv', async () => {
    const { app, calls } = await makeApp(true);
    await app.inject({
      method: 'POST', url: '/api/hosts',
      payload: { hostname: 'h', alias: 'box', password: 'pw123' },
    });
    expect(calls[0].cmd).not.toContain('pw123');
    expect(calls[0].env?.BAXIAN_SSH_PASSWORD).toBe('pw123');
  });

  it('persists no port when none is given, and the probe omits -p so ~/.ssh/config Port is honored', async () => {
    const { app, calls } = await makeApp(true);
    const res = await app.inject({
      method: 'POST', url: '/api/hosts',
      payload: { hostname: 'nas.local', alias: 'NAS', user: 'agent' },
    });
    expect(res.statusCode).toBe(201);
    expect(ctx.config.host[0].port).toBeUndefined();
    expect(calls[0].cmd).not.toContain('-p ');
  });
});

describe('POST /api/hosts id generation', () => {
  it('appends a numeric suffix when the slug collides with an existing host id', async () => {
    const { app } = await makeApp(true);
    const first = await app.inject({
      method: 'POST', url: '/api/hosts',
      payload: { hostname: 'h1.example', alias: 'box' },
    });
    const second = await app.inject({
      method: 'POST', url: '/api/hosts',
      payload: { hostname: 'h2.example', alias: 'box' },
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(JSON.parse(first.body).host.id).toBe('box');
    expect(JSON.parse(second.body).host.id).toBe('box-2');
    expect(ctx.config.host.map(h => h.id)).toEqual(['box', 'box-2']);
  });

  it('falls back to host-<n> when every suffixed candidate is taken', async () => {
    ctx.config.host = [
      { id: 'box', hostname: 'seed.example' },
      ...Array.from({ length: 998 }, (_, i) => ({ id: `box-${i + 2}`, hostname: 'seed.example' })),
    ];
    const { app } = await makeApp(true);
    const res = await app.inject({
      method: 'POST', url: '/api/hosts',
      payload: { hostname: 'h.example', alias: 'box' },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).host.id).toBe('host-1000');
  });
});

describe('host routes without a configPath', () => {
  it('POST / PATCH / DELETE return 500 before any connectivity check', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h' }];
    ctx.configPath = undefined;
    const { app, calls } = await makeApp(true);
    const post = await app.inject({ method: 'POST', url: '/api/hosts', payload: { hostname: 'h.example' } });
    const patch = await app.inject({ method: 'PATCH', url: '/api/hosts/box', payload: { alias: 'x' } });
    const del = await app.inject({ method: 'DELETE', url: '/api/hosts/box' });
    for (const res of [post, patch, del]) {
      expect.soft(res.statusCode).toBe(500);
      expect.soft(JSON.parse(res.body).error).toMatch(/No config path/);
    }
    expect(calls).toHaveLength(0);
    expect(ctx.config.host).toHaveLength(1);
  });
});

describe('GET /api/hosts', () => {
  it('redacts passwords', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', port: 22, password: 'secret' }];
    const { app } = await makeApp(true);
    const res = await app.inject({ method: 'GET', url: '/api/hosts' });
    expect(JSON.parse(res.body)[0].password).toBe('***');
  });
});

describe('PATCH /api/hosts/:id', () => {
  beforeEach(() => {
    ctx.config.host = [{ id: 'box', hostname: 'h', port: 22, user: 'u', password: 'orig' }];
  });

  it('editing a portless host does not resurrect a default port (stays undefined → ~/.ssh/config)', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', user: 'u' }];
    const { app } = await makeApp(true);
    const res = await app.inject({
      method: 'PATCH', url: '/api/hosts/box',
      payload: { alias: 'renamed' },
    });
    expect(res.statusCode).toBe(200);
    expect(ctx.config.host[0].port).toBeUndefined();
    expect(ctx.config.host[0].alias).toBe('renamed');
  });

  it('keeps the existing password when the field is omitted', async () => {
    const { app } = await makeApp(true);
    const res = await app.inject({
      method: 'PATCH', url: '/api/hosts/box',
      payload: { alias: 'renamed' },
    });
    expect(res.statusCode).toBe(200);
    expect(ctx.config.host[0].password).toBe('orig');
    expect(ctx.config.host[0].alias).toBe('renamed');
  });

  it('clears the stored password when an explicit empty string is sent (switch back to key auth)', async () => {
    const { app } = await makeApp(true);
    const res = await app.inject({
      method: 'PATCH', url: '/api/hosts/box',
      payload: { password: '' },
    });
    expect(res.statusCode).toBe(200);
    expect(ctx.config.host[0].password).toBeUndefined();
  });

  it('rejects an endpoint change on a password host without an explicit password (no secret exfiltration)', async () => {
    const { app, calls } = await makeApp(true);
    const res = await app.inject({
      method: 'PATCH', url: '/api/hosts/box',
      payload: { hostname: 'attacker.host' },
    });
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('allows an endpoint change on a password host when an explicit password is provided', async () => {
    const { app, calls } = await makeApp(true);
    const res = await app.inject({
      method: 'PATCH', url: '/api/hosts/box',
      payload: { hostname: 'new.host', password: 'newpw' },
    });
    expect(res.statusCode).toBe(200);
    expect(calls.some(c => c.env?.BAXIAN_SSH_PASSWORD === 'newpw')).toBe(true);
  });

  it('blocks a structural change while a referencing agent is live', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', port: 22, user: 'u' }];
    ctx.config.project = [remoteAgentProject()];
    ctx.tmuxSessionStatusStore.set('rdev', { tmuxSessionStatus: 'present' });
    const { app } = await makeApp(true);
    const res = await app.inject({
      method: 'PATCH', url: '/api/hosts/box',
      payload: { hostname: 'moved.example.com' },
    });
    expect(res.statusCode).toBe(409);
    expect(ctx.config.host[0].hostname).toBe('h');
  });

  it('allows a non-structural change (alias) even with a live referencing agent', async () => {
    ctx.config.project = [remoteAgentProject()];
    ctx.tmuxSessionStatusStore.set('rdev', { tmuxSessionStatus: 'present' });
    const { app } = await makeApp(true);
    const res = await app.inject({
      method: 'PATCH', url: '/api/hosts/box',
      payload: { alias: 'still-fine' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('treats a port:22 edit of a portless password host as an endpoint change (no secret exfiltration via undefined↔22)', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', user: 'u', password: 'orig' }];
    const { app, calls } = await makeApp(true);
    const res = await app.inject({
      method: 'PATCH', url: '/api/hosts/box',
      payload: { port: 22 },
    });
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('blocks a port:22 edit of a portless host while a referencing agent is live (undefined↔22 is structural)', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', user: 'u' }];
    ctx.config.project = [remoteAgentProject()];
    ctx.tmuxSessionStatusStore.set('rdev', { tmuxSessionStatus: 'present' });
    const { app } = await makeApp(true);
    const res = await app.inject({
      method: 'PATCH', url: '/api/hosts/box',
      payload: { port: 22 },
    });
    expect(res.statusCode).toBe(409);
    expect(ctx.config.host[0].port).toBeUndefined();
  });

  it('clears the port when port:null is sent, so a host wrongly saved as 22 falls back to ~/.ssh/config', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', port: 22, user: 'u' }];
    const { app } = await makeApp(true);
    const res = await app.inject({
      method: 'PATCH', url: '/api/hosts/box',
      payload: { port: null },
    });
    expect(res.statusCode).toBe(200);
    expect(ctx.config.host[0].port).toBeUndefined();
  });

  it('returns 404 for an unknown host id', async () => {
    const { app } = await makeApp(true);
    const res = await app.inject({ method: 'PATCH', url: '/api/hosts/nope', payload: { alias: 'x' } });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toMatch(/not found/);
  });

  it('rejects with 400 and keeps the config when the connectivity check fails', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', user: 'u' }];
    const { app } = await makeApp(false);
    const res = await app.inject({
      method: 'PATCH', url: '/api/hosts/box',
      payload: { alias: 'renamed' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/SSH 不通/);
    expect(ctx.config.host[0].alias).toBeUndefined();
  });
});

describe('PATCH /api/hosts/:id revalidation inside the config lock', () => {
  function gatedApp(execAfterGate: (cmd: string) => { stdout: string; stderr: string; exitCode: number }) {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    const runner: CommandRunner = {
      exec: async (cmd) => {
        if (first) {
          first = false;
          await gate;
        }
        return execAfterGate(cmd);
      },
      writeFile: async () => undefined,
      execWithStdin: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    };
    return { runner, release: () => release() };
  }

  it('404 when the host is deleted while the connectivity check is in flight', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', user: 'u' }];
    const { runner, release } = gatedApp(() => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
    const app = await buildHostApp(runner);
    const pending = app.inject({ method: 'PATCH', url: '/api/hosts/box', payload: { alias: 'renamed' } });
    await new Promise((r) => setTimeout(r, 20));
    ctx.config.host = [];
    release();
    const res = await pending;
    expect(res.statusCode).toBe(404);
    expect(ctx.config.host).toHaveLength(0);
  });

  it('409 when a referencing agent goes live while the connectivity check is in flight', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', user: 'u' }];
    ctx.config.project = [remoteAgentProject()];
    const { runner, release } = gatedApp(() => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
    const app = await buildHostApp(runner);
    const pending = app.inject({ method: 'PATCH', url: '/api/hosts/box', payload: { hostname: 'moved.example' } });
    await new Promise((r) => setTimeout(r, 20));
    ctx.tmuxSessionStatusStore.set('rdev', { tmuxSessionStatus: 'present' });
    release();
    const res = await pending;
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(/rdev/);
    expect(ctx.config.host[0].hostname).toBe('h');
  });

  it('re-checks connectivity when the host row changed under the probe, and rejects the unchecked combo', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', user: 'u' }];
    let calls = 0;
    const { runner, release } = gatedApp((cmd) => {
      calls += 1;
      return cmd.includes('h2')
        ? { stdout: '', stderr: 'no route to h2', exitCode: 1 }
        : { stdout: 'ok', stderr: '', exitCode: 0 };
    });
    const app = await buildHostApp(runner);
    const pending = app.inject({ method: 'PATCH', url: '/api/hosts/box', payload: { alias: 'renamed' } });
    await new Promise((r) => setTimeout(r, 20));
    ctx.config.host = [{ id: 'box', hostname: 'h2', user: 'u' }];
    release();
    const res = await pending;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/SSH 不通/);
    expect(calls).toBe(2);
    expect(ctx.config.host[0].alias).toBeUndefined();
  });
});

describe('host persist validation failures', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POST maps ConfigValidationError to 400 Invalid host and persists nothing', async () => {
    const { app } = await makeApp(true);
    vi.spyOn(loader, 'prepareConfig').mockImplementation(() => {
      throw new ConfigValidationError([{ path: 'host.0.hostname', message: 'bad hostname' }]);
    });
    const res = await app.inject({ method: 'POST', url: '/api/hosts', payload: { hostname: 'h.example' } });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Invalid host');
    expect(body.details).toEqual([{ path: 'host.0.hostname', message: 'bad hostname' }]);
    expect(ctx.config.host).toHaveLength(0);
  });

  it('POST rethrows unknown persist errors as 500', async () => {
    const { app } = await makeApp(true);
    vi.spyOn(loader, 'prepareConfig').mockImplementation(() => {
      throw new Error('disk full');
    });
    const res = await app.inject({ method: 'POST', url: '/api/hosts', payload: { hostname: 'h.example' } });
    expect(res.statusCode).toBe(500);
    expect(ctx.config.host).toHaveLength(0);
  });

  it('PATCH maps ConfigValidationError to 400 Invalid host and keeps the stored host', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', user: 'u' }];
    const { app } = await makeApp(true);
    vi.spyOn(loader, 'prepareConfig').mockImplementation(() => {
      throw new ConfigValidationError([{ path: 'host.0.port', message: 'bad port' }]);
    });
    const res = await app.inject({ method: 'PATCH', url: '/api/hosts/box', payload: { alias: 'renamed' } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Invalid host');
    expect(ctx.config.host[0].alias).toBeUndefined();
  });

  it('PATCH rethrows unknown persist errors as 500', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', user: 'u' }];
    const { app } = await makeApp(true);
    vi.spyOn(loader, 'prepareConfig').mockImplementation(() => {
      throw new Error('disk full');
    });
    const res = await app.inject({ method: 'PATCH', url: '/api/hosts/box', payload: { alias: 'renamed' } });
    expect(res.statusCode).toBe(500);
    expect(ctx.config.host[0].alias).toBeUndefined();
  });
});

describe('DELETE /api/hosts/:id', () => {
  it('refuses (409) when an agent still references the host', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', user: 'u' }];
    ctx.config.project = [remoteAgentProject()];
    const { app } = await makeApp(true);
    const res = await app.inject({ method: 'DELETE', url: '/api/hosts/box' });
    expect(res.statusCode).toBe(409);
    expect(ctx.config.host).toHaveLength(1);
  });

  it('deletes an unreferenced host', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', user: 'u' }];
    const { app } = await makeApp(true);
    const res = await app.inject({ method: 'DELETE', url: '/api/hosts/box' });
    expect(res.statusCode).toBe(200);
    expect(ctx.config.host).toHaveLength(0);
  });

  it('returns 404 for an unknown host id', async () => {
    const { app } = await makeApp(true);
    const res = await app.inject({ method: 'DELETE', url: '/api/hosts/nope' });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toMatch(/not found/);
  });
});

describe('POST /api/hosts/check', () => {
  it('resolves an omitted password to the stored one for an existing host', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', user: 'u', password: 'stored-pw' }];
    const { app, calls } = await makeApp(true);
    const res = await app.inject({
      method: 'POST', url: '/api/hosts/check',
      payload: { id: 'box', hostname: 'h', user: 'u' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    expect(calls[0].env?.BAXIAN_SSH_PASSWORD).toBe('stored-pw');
  });

  it('uses the submitted password for a new host (no id)', async () => {
    const { app, calls } = await makeApp(true);
    await app.inject({
      method: 'POST', url: '/api/hosts/check',
      payload: { hostname: 'h', password: 'fresh-pw' },
    });
    expect(calls[0].env?.BAXIAN_SSH_PASSWORD).toBe('fresh-pw');
  });

  it('does NOT reuse the stored password when checking a different endpoint (no exfiltration)', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'real.host', user: 'u', port: 22, password: 'stored-pw' }];
    const { app, calls } = await makeApp(true);
    await app.inject({
      method: 'POST', url: '/api/hosts/check',
      payload: { id: 'box', hostname: 'attacker.host', user: 'u', port: 22 },
    });
    expect(calls[0].cmd).toContain('attacker.host');
    expect(calls[0].env?.BAXIAN_SSH_PASSWORD).toBeUndefined();
  });

  it('still reuses the stored password when checking the same endpoint', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'real.host', user: 'u', port: 22, password: 'stored-pw' }];
    const { app, calls } = await makeApp(true);
    await app.inject({
      method: 'POST', url: '/api/hosts/check',
      payload: { id: 'box', hostname: 'real.host', user: 'u', port: 22 },
    });
    expect(calls[0].env?.BAXIAN_SSH_PASSWORD).toBe('stored-pw');
  });

  it('does NOT reuse the stored password when a portless host is checked with an explicit port:22 (undefined↔22 is a different endpoint)', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'real.host', user: 'u', password: 'stored-pw' }];
    const { app, calls } = await makeApp(true);
    await app.inject({
      method: 'POST', url: '/api/hosts/check',
      payload: { id: 'box', hostname: 'real.host', user: 'u', port: 22 },
    });
    expect(calls[0].env?.BAXIAN_SSH_PASSWORD).toBeUndefined();
  });

  it('rejects a non-integer (string) port with 400 and never invokes the ssh runner (injection guard)', async () => {
    const { app, calls } = await makeApp(true);
    const res = await app.inject({
      method: 'POST', url: '/api/hosts/check',
      payload: { hostname: 'h', port: '22; touch pwned' },
    });
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('rejects an out-of-range port with 400 and never invokes the ssh runner', async () => {
    const { app, calls } = await makeApp(true);
    const res = await app.inject({
      method: 'POST', url: '/api/hosts/check',
      payload: { hostname: 'h', port: 70000 },
    });
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe('host routes reject malformed (non-string) fields with 400, never 500', () => {
  it('POST/PATCH/check reject a truthy non-string hostname', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', port: 22 }];
    const { app, calls } = await makeApp(true);
    const post = await app.inject({ method: 'POST', url: '/api/hosts', payload: { hostname: 123 } });
    const patch = await app.inject({ method: 'PATCH', url: '/api/hosts/box', payload: { hostname: 123 } });
    const check = await app.inject({ method: 'POST', url: '/api/hosts/check', payload: { hostname: 123 } });
    expect(post.statusCode).toBe(400);
    expect(patch.statusCode).toBe(400);
    expect(check.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('rejects a non-string optional field (e.g. numeric alias)', async () => {
    const { app } = await makeApp(true);
    const res = await app.inject({ method: 'POST', url: '/api/hosts', payload: { hostname: 'h', alias: 7 } });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /api/hosts/:id streamer invalidation + concurrency', () => {
  it('tears down referencing streamers when the password changes', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', port: 22, user: 'u', password: 'orig' }];
    ctx.config.project = [remoteAgentProject()];
    const destroyed: Array<{ id: string; silent?: boolean }> = [];
    (ctx as unknown as { paneStreamerManager: unknown }).paneStreamerManager = {
      has: () => true,
      destroy: async (agentId: string, opts?: { silent?: boolean }) => { destroyed.push({ id: agentId, silent: opts?.silent }); },
    };
    const { app } = await makeApp(true);
    const res = await app.inject({ method: 'PATCH', url: '/api/hosts/box', payload: { password: 'newpw' } });
    expect(res.statusCode).toBe(200);
    expect(destroyed).toContainEqual({ id: 'rdev', silent: undefined });
  });

  it('blocks a structural change when an active web terminal streamer references the host (even if binding looks idle)', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', port: 22, user: 'u' }];
    ctx.config.project = [remoteAgentProject()];
    (ctx as unknown as { paneStreamerManager: unknown }).paneStreamerManager = {
      has: (agentId: string) => agentId === 'rdev',
      destroy: async () => undefined,
    };
    const { app } = await makeApp(true);
    const res = await app.inject({ method: 'PATCH', url: '/api/hosts/box', payload: { hostname: 'moved.example' } });
    expect(res.statusCode).toBe(409);
    expect(ctx.config.host[0].hostname).toBe('h');
  });

  it('does NOT tear down streamers when only a non-credential field (alias) changes', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', port: 22, user: 'u', password: 'orig' }];
    ctx.config.project = [remoteAgentProject()];
    const destroyed: string[] = [];
    (ctx as unknown as { paneStreamerManager: unknown }).paneStreamerManager = {
      has: () => true,
      destroy: async (agentId: string) => { destroyed.push(agentId); },
    };
    const { app } = await makeApp(true);
    await app.inject({ method: 'PATCH', url: '/api/hosts/box', payload: { alias: 'renamed' } });
    expect(destroyed).toHaveLength(0);
  });

  it('concurrent PATCHes to different fields do not clobber each other (rebased inside the lock)', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', port: 22, user: 'u', password: 'orig', alias: 'A' }];
    const { app } = await makeApp(true);
    await Promise.all([
      app.inject({ method: 'PATCH', url: '/api/hosts/box', payload: { password: 'newpw' } }),
      app.inject({ method: 'PATCH', url: '/api/hosts/box', payload: { alias: 'B-alias' } }),
    ]);
    expect(ctx.config.host[0].password).toBe('newpw');
    expect(ctx.config.host[0].alias).toBe('B-alias');
  });
});

describe('PATCH /api/hosts/:id connectivity re-check on concurrent connection edits', () => {
  it('never persists a host combination that was never connectivity-checked', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'old.example', port: 22, user: 'u', password: 'orig' }];
    const runner: CommandRunner = {
      exec: async (cmd, options) => {
        const bad = cmd.includes('new.example') && options?.env?.BAXIAN_SSH_PASSWORD === 'newpw';
        return { stdout: bad ? '' : 'ok', stderr: bad ? 'unreachable combo' : '', exitCode: bad ? 1 : 0 };
      },
      writeFile: async () => undefined,
      execWithStdin: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    };
    const app = await buildHostApp(runner);

    await Promise.all([
      app.inject({ method: 'PATCH', url: '/api/hosts/box', payload: { hostname: 'new.example' } }),
      app.inject({ method: 'PATCH', url: '/api/hosts/box', payload: { password: 'newpw' } }),
    ]);

    const h = ctx.config.host[0];
    expect(h.hostname === 'new.example' && h.password === 'newpw').toBe(false);
  });
});
