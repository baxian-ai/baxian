import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import { createTestContext } from '../helpers/context.js';
import { hostRoutes } from '../../src/api/hosts.js';
import type { AppContext } from '../../src/app.js';
import type { CommandRunner } from '../../src/agent/runner.js';

let tempDir: string;
let ctx: AppContext;

interface Captured { cmd: string; env?: Record<string, string> }

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
  const app = Fastify({ logger: false });
  app.decorate('ctx', ctx);
  await app.register(hostRoutes, { prefix: '/api', localRunnerFactory: () => runner });
  await app.ready();
  return { app, calls };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-hosts-test-'));
  ctx = await createTestContext(tempDir);
  ctx.configPath = join(tempDir, 'baxian.json');
  await writeFile(ctx.configPath, JSON.stringify(ctx.config, null, 2));
});

afterEach(async () => {
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
    expect(ctx.config.host[0].password).toBe('sekret'); // stored in the clear in memory/disk
    await app.close();
  });

  it('rejects with 400 and does NOT persist when connectivity fails', async () => {
    const { app } = await makeApp(false);
    const res = await app.inject({
      method: 'POST', url: '/api/hosts',
      payload: { hostname: 'h.example.com', alias: 'box' },
    });
    expect(res.statusCode).toBe(400);
    expect(ctx.config.host).toHaveLength(0);
    await app.close();
  });

  it('forces a fresh authenticated connection (noMux) for the connectivity check (f-1)', async () => {
    const { app, calls } = await makeApp(true);
    await app.inject({ method: 'POST', url: '/api/hosts', payload: { hostname: 'h', alias: 'box' } });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toContain('ControlPath=none');
    expect(calls[0].cmd).not.toContain('cm-%C');
    await app.close();
  });

  it('passes the submitted password to the check via env, never via argv', async () => {
    const { app, calls } = await makeApp(true);
    await app.inject({
      method: 'POST', url: '/api/hosts',
      payload: { hostname: 'h', alias: 'box', password: 'pw123' },
    });
    expect(calls[0].cmd).not.toContain('pw123');
    expect(calls[0].env?.BAXIAN_SSH_PASSWORD).toBe('pw123');
    await app.close();
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
    await app.close();
  });
});

describe('GET /api/hosts', () => {
  it('redacts passwords', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', port: 22, password: 'secret' }];
    const { app } = await makeApp(true);
    const res = await app.inject({ method: 'GET', url: '/api/hosts' });
    expect(JSON.parse(res.body)[0].password).toBe('***');
    await app.close();
  });
});

describe('PATCH /api/hosts/:id', () => {
  beforeEach(() => {
    ctx.config.host = [{ id: 'box', hostname: 'h', port: 22, user: 'u', password: 'orig' }];
  });

  it('editing a portless host does not resurrect a default port (stays undefined → ~/.ssh/config)', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', user: 'u' }]; // no port, key auth
    const { app } = await makeApp(true);
    const res = await app.inject({
      method: 'PATCH', url: '/api/hosts/box',
      payload: { alias: 'renamed' },
    });
    expect(res.statusCode).toBe(200);
    expect(ctx.config.host[0].port).toBeUndefined();
    expect(ctx.config.host[0].alias).toBe('renamed');
    await app.close();
  });

  it('keeps the existing password when the field is omitted (f-3 preserve-current)', async () => {
    const { app } = await makeApp(true);
    const res = await app.inject({
      method: 'PATCH', url: '/api/hosts/box',
      payload: { alias: 'renamed' },
    });
    expect(res.statusCode).toBe(200);
    expect(ctx.config.host[0].password).toBe('orig');
    expect(ctx.config.host[0].alias).toBe('renamed');
    await app.close();
  });

  it('clears the stored password when an explicit empty string is sent (switch back to key auth)', async () => {
    const { app } = await makeApp(true);
    const res = await app.inject({
      method: 'PATCH', url: '/api/hosts/box',
      payload: { password: '' },
    });
    expect(res.statusCode).toBe(200);
    expect(ctx.config.host[0].password).toBeUndefined();
    await app.close();
  });

  it('rejects an endpoint change on a password host without an explicit password (no secret exfiltration)', async () => {
    const { app, calls } = await makeApp(true);
    const res = await app.inject({
      method: 'PATCH', url: '/api/hosts/box',
      payload: { hostname: 'attacker.host' },
    });
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0); // never probed → the stored password is never sent anywhere
    await app.close();
  });

  it('allows an endpoint change on a password host when an explicit password is provided', async () => {
    const { app, calls } = await makeApp(true);
    const res = await app.inject({
      method: 'PATCH', url: '/api/hosts/box',
      payload: { hostname: 'new.host', password: 'newpw' },
    });
    expect(res.statusCode).toBe(200);
    expect(calls.some(c => c.env?.BAXIAN_SSH_PASSWORD === 'newpw')).toBe(true);
    await app.close();
  });

  it('blocks a structural change while a referencing agent is live (f-1/f-2)', async () => {
    // Key host (no password) so the structural change reaches the live-agent guard rather than the
    // "endpoint change needs an explicit password" gate.
    ctx.config.host = [{ id: 'box', hostname: 'h', port: 22, user: 'u' }];
    ctx.config.project = [{
      id: 'proj', repo: 'user/repo', merge: null,
      agent: [[{ id: 'rdev', runtime: 'claude-code', role: 'dev', mode: 'remote', host: 'box' }]],
    }];
    ctx.tmuxSessionStatusStore.set('rdev', { tmuxSessionStatus: 'present' });
    const { app } = await makeApp(true);
    const res = await app.inject({
      method: 'PATCH', url: '/api/hosts/box',
      payload: { hostname: 'moved.example.com' },
    });
    expect(res.statusCode).toBe(409);
    expect(ctx.config.host[0].hostname).toBe('h'); // unchanged
    await app.close();
  });

  it('allows a non-structural change (alias) even with a live referencing agent', async () => {
    ctx.config.project = [{
      id: 'proj', repo: 'user/repo', merge: null,
      agent: [[{ id: 'rdev', runtime: 'claude-code', role: 'dev', mode: 'remote', host: 'box' }]],
    }];
    ctx.tmuxSessionStatusStore.set('rdev', { tmuxSessionStatus: 'present' });
    const { app } = await makeApp(true);
    const res = await app.inject({
      method: 'PATCH', url: '/api/hosts/box',
      payload: { alias: 'still-fine' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('treats a port:22 edit of a portless password host as an endpoint change (no secret exfiltration via undefined↔22)', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', user: 'u', password: 'orig' }]; // no port → honors ~/.ssh/config
    const { app, calls } = await makeApp(true);
    const res = await app.inject({
      method: 'PATCH', url: '/api/hosts/box',
      payload: { port: 22 }, // no explicit password
    });
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0); // stored password never sent to the :22 endpoint
    await app.close();
  });

  it('blocks a port:22 edit of a portless host while a referencing agent is live (undefined↔22 is structural)', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', user: 'u' }]; // key auth, no port
    ctx.config.project = [{
      id: 'proj', repo: 'user/repo', merge: null,
      agent: [[{ id: 'rdev', runtime: 'claude-code', role: 'dev', mode: 'remote', host: 'box' }]],
    }];
    ctx.tmuxSessionStatusStore.set('rdev', { tmuxSessionStatus: 'present' });
    const { app } = await makeApp(true);
    const res = await app.inject({
      method: 'PATCH', url: '/api/hosts/box',
      payload: { port: 22 },
    });
    expect(res.statusCode).toBe(409);
    expect(ctx.config.host[0].port).toBeUndefined(); // unchanged
    await app.close();
  });

  it('clears the port when port:null is sent, so a host wrongly saved as 22 falls back to ~/.ssh/config', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', port: 22, user: 'u' }]; // key auth, mis-saved 22
    const { app } = await makeApp(true);
    const res = await app.inject({
      method: 'PATCH', url: '/api/hosts/box',
      payload: { port: null },
    });
    expect(res.statusCode).toBe(200);
    expect(ctx.config.host[0].port).toBeUndefined();
    await app.close();
  });
});

describe('DELETE /api/hosts/:id', () => {
  it('refuses (409) when an agent still references the host', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', user: 'u' }];
    ctx.config.project = [{
      id: 'proj', repo: 'user/repo', merge: null,
      agent: [[{ id: 'rdev', runtime: 'claude-code', role: 'dev', mode: 'remote', host: 'box' }]],
    }];
    const { app } = await makeApp(true);
    const res = await app.inject({ method: 'DELETE', url: '/api/hosts/box' });
    expect(res.statusCode).toBe(409);
    expect(ctx.config.host).toHaveLength(1);
    await app.close();
  });

  it('deletes an unreferenced host', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', user: 'u' }];
    const { app } = await makeApp(true);
    const res = await app.inject({ method: 'DELETE', url: '/api/hosts/box' });
    expect(res.statusCode).toBe(200);
    expect(ctx.config.host).toHaveLength(0);
    await app.close();
  });
});

describe('POST /api/hosts/check', () => {
  it('resolves an omitted password to the stored one for an existing host (f-3)', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', user: 'u', password: 'stored-pw' }];
    const { app, calls } = await makeApp(true);
    const res = await app.inject({
      method: 'POST', url: '/api/hosts/check',
      payload: { id: 'box', hostname: 'h', user: 'u' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    expect(calls[0].env?.BAXIAN_SSH_PASSWORD).toBe('stored-pw');
    await app.close();
  });

  it('uses the submitted password for a new host (no id)', async () => {
    const { app, calls } = await makeApp(true);
    await app.inject({
      method: 'POST', url: '/api/hosts/check',
      payload: { hostname: 'h', password: 'fresh-pw' },
    });
    expect(calls[0].env?.BAXIAN_SSH_PASSWORD).toBe('fresh-pw');
    await app.close();
  });

  it('does NOT reuse the stored password when checking a different endpoint (no exfiltration)', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'real.host', user: 'u', port: 22, password: 'stored-pw' }];
    const { app, calls } = await makeApp(true);
    // Same id but a caller-chosen hostname, password omitted ('keep stored' intent).
    await app.inject({
      method: 'POST', url: '/api/hosts/check',
      payload: { id: 'box', hostname: 'attacker.host', user: 'u', port: 22 },
    });
    expect(calls[0].cmd).toContain('attacker.host');
    expect(calls[0].env?.BAXIAN_SSH_PASSWORD).toBeUndefined();
    await app.close();
  });

  it('still reuses the stored password when checking the same endpoint', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'real.host', user: 'u', port: 22, password: 'stored-pw' }];
    const { app, calls } = await makeApp(true);
    await app.inject({
      method: 'POST', url: '/api/hosts/check',
      payload: { id: 'box', hostname: 'real.host', user: 'u', port: 22 },
    });
    expect(calls[0].env?.BAXIAN_SSH_PASSWORD).toBe('stored-pw');
    await app.close();
  });

  it('does NOT reuse the stored password when a portless host is checked with an explicit port:22 (undefined↔22 is a different endpoint)', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'real.host', user: 'u', password: 'stored-pw' }]; // no port
    const { app, calls } = await makeApp(true);
    await app.inject({
      method: 'POST', url: '/api/hosts/check',
      payload: { id: 'box', hostname: 'real.host', user: 'u', port: 22 },
    });
    expect(calls[0].env?.BAXIAN_SSH_PASSWORD).toBeUndefined();
    await app.close();
  });

  it('rejects a non-integer (string) port with 400 and never invokes the ssh runner (injection guard)', async () => {
    const { app, calls } = await makeApp(true);
    const res = await app.inject({
      method: 'POST', url: '/api/hosts/check',
      payload: { hostname: 'h', port: '22; touch pwned' },
    });
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it('rejects an out-of-range port with 400 and never invokes the ssh runner', async () => {
    const { app, calls } = await makeApp(true);
    const res = await app.inject({
      method: 'POST', url: '/api/hosts/check',
      payload: { hostname: 'h', port: 70000 },
    });
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
    await app.close();
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
    expect(calls).toHaveLength(0); // never reached the ssh runner
    await app.close();
  });

  it('rejects a non-string optional field (e.g. numeric alias)', async () => {
    const { app } = await makeApp(true);
    const res = await app.inject({ method: 'POST', url: '/api/hosts', payload: { hostname: 'h', alias: 7 } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('PATCH /api/hosts/:id streamer invalidation + concurrency (round-7)', () => {
  it('tears down referencing streamers when the password changes', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', port: 22, user: 'u', password: 'orig' }];
    ctx.config.project = [{
      id: 'proj', repo: 'user/repo', merge: null,
      agent: [[{ id: 'rdev', runtime: 'claude-code', role: 'dev', mode: 'remote', host: 'box' }]],
    }];
    const destroyed: Array<{ id: string; silent?: boolean }> = [];
    (ctx as unknown as { paneStreamerManager: unknown }).paneStreamerManager = {
      has: () => true,
      destroy: async (agentId: string, opts?: { silent?: boolean }) => { destroyed.push({ id: agentId, silent: opts?.silent }); },
    };
    const { app } = await makeApp(true);
    const res = await app.inject({ method: 'PATCH', url: '/api/hosts/box', payload: { password: 'newpw' } });
    expect(res.statusCode).toBe(200);
    // Non-silent destroy so onSessionGone fires and open /api/stream sockets release + reconnect.
    expect(destroyed).toContainEqual({ id: 'rdev', silent: undefined });
    await app.close();
  });

  it('blocks a structural change when an active web terminal streamer references the host (even if binding looks idle)', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', port: 22, user: 'u' }];
    ctx.config.project = [{
      id: 'proj', repo: 'user/repo', merge: null,
      agent: [[{ id: 'rdev', runtime: 'claude-code', role: 'dev', mode: 'remote', host: 'box' }]],
    }];
    // No active task / paneId, tmux unknown — but a web terminal streamer is open.
    (ctx as unknown as { paneStreamerManager: unknown }).paneStreamerManager = {
      has: (agentId: string) => agentId === 'rdev',
      destroy: async () => undefined,
    };
    const { app } = await makeApp(true);
    const res = await app.inject({ method: 'PATCH', url: '/api/hosts/box', payload: { hostname: 'moved.example' } });
    expect(res.statusCode).toBe(409);
    expect(ctx.config.host[0].hostname).toBe('h');
    await app.close();
  });

  it('does NOT tear down streamers when only a non-credential field (alias) changes', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', port: 22, user: 'u', password: 'orig' }];
    ctx.config.project = [{
      id: 'proj', repo: 'user/repo', merge: null,
      agent: [[{ id: 'rdev', runtime: 'claude-code', role: 'dev', mode: 'remote', host: 'box' }]],
    }];
    const destroyed: string[] = [];
    (ctx as unknown as { paneStreamerManager: unknown }).paneStreamerManager = {
      has: () => true,
      destroy: async (agentId: string) => { destroyed.push(agentId); },
    };
    const { app } = await makeApp(true);
    await app.inject({ method: 'PATCH', url: '/api/hosts/box', payload: { alias: 'renamed' } });
    expect(destroyed).toHaveLength(0);
    await app.close();
  });

  it('concurrent PATCHes to different fields do not clobber each other (rebased inside the lock)', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'h', port: 22, user: 'u', password: 'orig', alias: 'A' }];
    const { app } = await makeApp(true);
    await Promise.all([
      app.inject({ method: 'PATCH', url: '/api/hosts/box', payload: { password: 'newpw' } }),
      app.inject({ method: 'PATCH', url: '/api/hosts/box', payload: { alias: 'B-alias' } }),
    ]);
    // Neither field reverted: the second writer rebased its patch onto the first writer's result.
    expect(ctx.config.host[0].password).toBe('newpw');
    expect(ctx.config.host[0].alias).toBe('B-alias');
    await app.close();
  });
});

describe('PATCH /api/hosts/:id connectivity re-check on concurrent connection edits (round-8)', () => {
  it('never persists a host combination that was never connectivity-checked', async () => {
    ctx.config.host = [{ id: 'box', hostname: 'old.example', port: 22, user: 'u', password: 'orig' }];
    const runner: CommandRunner = {
      exec: async (cmd, options) => {
        // Only the never-probed combination (new hostname + new password) is unreachable.
        const bad = cmd.includes('new.example') && options?.env?.BAXIAN_SSH_PASSWORD === 'newpw';
        return { stdout: bad ? '' : 'ok', stderr: bad ? 'unreachable combo' : '', exitCode: bad ? 1 : 0 };
      },
      writeFile: async () => undefined,
      execWithStdin: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    };
    const app = Fastify({ logger: false });
    app.decorate('ctx', ctx);
    await app.register(hostRoutes, { prefix: '/api', localRunnerFactory: () => runner });
    await app.ready();

    await Promise.all([
      app.inject({ method: 'PATCH', url: '/api/hosts/box', payload: { hostname: 'new.example' } }),
      app.inject({ method: 'PATCH', url: '/api/hosts/box', payload: { password: 'newpw' } }),
    ]);

    const h = ctx.config.host[0];
    expect(h.hostname === 'new.example' && h.password === 'newpw').toBe(false);
    await app.close();
  });
});
