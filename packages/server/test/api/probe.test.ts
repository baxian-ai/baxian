import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { createTestContext } from '../helpers/context.js';
import { probeRoutes, type ProbeRoutesOptions } from '../../src/api/probe.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';
import * as runnerModule from '../../src/agent/runner.js';

let tempDir: string;
let app: FastifyInstance;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-probe-test-'));
  const ctx = await createTestContext(tempDir);
  app = await buildApp(ctx);
});

afterEach(async () => {
  await app.close();
  await rm(tempDir, { recursive: true });
});

function makeStubRunner(impl: (cmd: string) => Promise<ExecResult>): CommandRunner {
  return { exec: async (cmd: string) => impl(cmd) };
}

async function buildProbeApp(options: ProbeRoutesOptions): Promise<FastifyInstance> {
  const probeApp = Fastify({ logger: false });
  await probeApp.register(probeRoutes, { prefix: '/api', ...options });
  return probeApp;
}

describe('POST /api/agents/probe', () => {
  it('returns runtimes + tmux for local mode', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/probe',
      payload: { mode: 'local' },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('tmux');
    expect(body).toHaveProperty('runtimes');
    expect(body.runtimes).toHaveProperty('claude-code');
    expect(body.runtimes).toHaveProperty('codex');
    expect(body).not.toHaveProperty('ssh');
  });

  it('returns 400 when remote mode missing host.hostname', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/probe',
      payload: { mode: 'remote' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when remote mode host has no hostname', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/probe',
      payload: { mode: 'remote', host: {} },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when mode is invalid', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/probe',
      payload: { mode: 'cloud' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns booleans for tmux/runtime ok fields (machine state-dependent)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/probe',
      payload: { mode: 'local' },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(typeof body.tmux.ok).toBe('boolean');
    expect(typeof body.runtimes['claude-code'].ok).toBe('boolean');
    expect(typeof body.runtimes['codex'].ok).toBe('boolean');
  });

  it('remote SSH unreachable: short-circuits with uniform "SSH 不通" messages', async () => {
    const probeApp = await buildProbeApp({
      localRunnerFactory: () => makeStubRunner(async (cmd) => {
        if (cmd.startsWith('ssh ')) return { stdout: '', stderr: 'kex_exchange_identification', exitCode: 255 };
        return { stdout: '/usr/bin/' + cmd.split(' ')[1], stderr: '', exitCode: 0 };
      }),
      remoteRunnerFactory: () => makeStubRunner(async () => {
        throw new Error('remote runner should not be called when ssh fails');
      }),
    });
    try {
      const response = await probeApp.inject({
        method: 'POST',
        url: '/api/agents/probe',
        payload: { mode: 'remote', host: { hostname: 'unreachable.example' } },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.ssh.ok).toBe(false);
      expect(body.ssh.message).toContain('SSH 不通');
      expect(body.tmux).toEqual({ ok: false, message: 'SSH 不通，无法探测' });
      expect(body.runtimes['claude-code']).toEqual({ ok: false, message: 'SSH 不通，无法探测' });
      expect(body.runtimes['codex']).toEqual({ ok: false, message: 'SSH 不通，无法探测' });
    } finally {
      await probeApp.close();
    }
  });

  it('remote SSH ok: continues to probe tmux + runtimes via remote runner', async () => {
    let remoteCalls = 0;
    const probeApp = await buildProbeApp({
      localRunnerFactory: () => makeStubRunner(async (cmd) => {
        if (cmd.startsWith('ssh ')) return { stdout: 'ok\n', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      remoteRunnerFactory: () => makeStubRunner(async (cmd) => {
        remoteCalls += 1;
        if (cmd === 'which tmux') return { stdout: '/usr/bin/tmux\n', stderr: '', exitCode: 0 };
        if (cmd === 'which claude') return { stdout: '/usr/bin/claude\n', stderr: '', exitCode: 0 };
        if (cmd === 'which codex') return { stdout: '', stderr: '', exitCode: 1 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    });
    try {
      const response = await probeApp.inject({
        method: 'POST',
        url: '/api/agents/probe',
        payload: { mode: 'remote', host: { hostname: 'reachable.example' } },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.ssh.ok).toBe(true);
      expect(remoteCalls).toBe(3);
      expect(body.tmux.ok).toBe(true);
      expect(body.runtimes['claude-code'].ok).toBe(true);
      expect(body.runtimes['codex'].ok).toBe(false);
    } finally {
      await probeApp.close();
    }
  });

  it('ensures the ssh mux dir before the first remote probe (probe runs before SshRunner on fresh process)', async () => {
    runnerModule.__resetMuxDirReadyForTests();
    const ensureSpy = vi.spyOn(runnerModule, 'ensureMuxDir').mockResolvedValue();
    const probeApp = await buildProbeApp({
      localRunnerFactory: () => makeStubRunner(async (cmd) => {
        if (cmd.startsWith('ssh ')) return { stdout: 'ok\n', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      remoteRunnerFactory: () => makeStubRunner(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    });
    try {
      const response = await probeApp.inject({
        method: 'POST',
        url: '/api/agents/probe',
        payload: { mode: 'remote', host: { hostname: 'reachable.example' } },
      });
      expect(response.statusCode).toBe(200);
      expect(ensureSpy).toHaveBeenCalled();
    } finally {
      await probeApp.close();
      ensureSpy.mockRestore();
    }
  });

  it('per-binary remoteShell: tmux probes match SshRunner default (-lc); claude / codex use login-interactive (tmux pane runtime)', async () => {
    const remoteOpts: Record<string, { remoteShell?: string } | undefined> = {};
    const probeApp = await buildProbeApp({
      localRunnerFactory: () => makeStubRunner(async (cmd) => {
        if (cmd.startsWith('ssh ')) return { stdout: 'ok\n', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      remoteRunnerFactory: () => ({
        exec: async (cmd: string, opts?: { remoteShell?: string }) => {
          if (cmd.startsWith('which ')) {
            const binary = cmd.slice('which '.length);
            remoteOpts[binary] = opts;
          }
          return { stdout: '/usr/bin/x\n', stderr: '', exitCode: 0 };
        },
      }),
    });
    try {
      const response = await probeApp.inject({
        method: 'POST',
        url: '/api/agents/probe',
        payload: { mode: 'remote', host: { hostname: 'reachable.example' } },
      });
      expect(response.statusCode).toBe(200);
      expect(remoteOpts['tmux']?.remoteShell ?? 'login').toBe('login');
      expect(remoteOpts['claude']?.remoteShell).toBe('login-interactive');
      expect(remoteOpts['codex']?.remoteShell).toBe('login-interactive');
    } finally {
      await probeApp.close();
    }
  });

  it('carries an inline host port into the ssh probe command', async () => {
    let sshCmd = '';
    const probeApp = await buildProbeApp({
      localRunnerFactory: () => makeStubRunner(async (cmd) => {
        if (cmd.includes('echo ok')) { sshCmd = cmd; return { stdout: 'ok', stderr: '', exitCode: 0 }; }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      remoteRunnerFactory: () => makeStubRunner(async () => ({ stdout: '/usr/bin/x\n', stderr: '', exitCode: 0 })),
    });
    try {
      const response = await probeApp.inject({
        method: 'POST',
        url: '/api/agents/probe',
        payload: { mode: 'remote', host: { hostname: 'h.example', port: 2222 } },
      });
      expect(response.statusCode).toBe(200);
      expect(sshCmd).toContain('-p 2222');
    } finally {
      await probeApp.close();
    }
  });

  it('runner exec failure per binary: timeout errors map to "probe timed out"', async () => {
    const probeApp = await buildProbeApp({
      localRunnerFactory: () => makeStubRunner(async () => {
        throw new Error('command timed out after 5000ms');
      }),
    });
    try {
      const response = await probeApp.inject({
        method: 'POST',
        url: '/api/agents/probe',
        payload: { mode: 'local' },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.tmux).toEqual({ ok: false, message: 'tmux probe timed out' });
      expect(body.runtimes['claude-code']).toEqual({ ok: false, message: 'claude probe timed out' });
      expect(body.runtimes['codex']).toEqual({ ok: false, message: 'codex probe timed out' });
    } finally {
      await probeApp.close();
    }
  });

  it('non-timeout / non-Error runner failures map to generic "probe failed"', async () => {
    const probeApp = await buildProbeApp({
      // non-Error throw exercises the String(err) fallback
      localRunnerFactory: () => makeStubRunner(async () => {
        throw 'spawn EPERM';
      }),
    });
    try {
      const response = await probeApp.inject({
        method: 'POST',
        url: '/api/agents/probe',
        payload: { mode: 'local' },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.tmux).toEqual({ ok: false, message: 'tmux probe failed' });
      expect(body.runtimes['claude-code']).toEqual({ ok: false, message: 'claude probe failed' });
      expect(body.runtimes['codex']).toEqual({ ok: false, message: 'codex probe failed' });
    } finally {
      await probeApp.close();
    }
  });

  it('returns 400 for an unknown hostId', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/probe',
      payload: { mode: 'remote', hostId: 'nope' },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toContain('unknown host id "nope"');
  });

  it('resolves a known hostId from config.host and probes that endpoint', async () => {
    let sshCmd = '';
    const probeApp = Fastify({ logger: false });
    probeApp.decorate('ctx', {
      config: { host: [{ id: 'box', hostname: 'stored.example', user: 'agent', port: 2200 }] },
    } as never);
    await probeApp.register(probeRoutes, {
      prefix: '/api',
      localRunnerFactory: () => makeStubRunner(async (cmd) => {
        if (cmd.includes('echo ok')) {
          sshCmd = cmd;
          return { stdout: 'ok', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      remoteRunnerFactory: () => makeStubRunner(async () => ({ stdout: '/usr/bin/x\n', stderr: '', exitCode: 0 })),
    });
    try {
      const response = await probeApp.inject({
        method: 'POST',
        url: '/api/agents/probe',
        payload: { mode: 'remote', hostId: 'box' },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.ssh.ok).toBe(true);
      expect(body.tmux.ok).toBe(true);
      expect(sshCmd).toContain('agent@stored.example');
      expect(sshCmd).toContain('-p 2200');
    } finally {
      await probeApp.close();
    }
  });

  it('local ssh runner throwing is treated as SSH unreachable (short-circuit, no crash)', async () => {
    const probeApp = await buildProbeApp({
      localRunnerFactory: () => makeStubRunner(async () => {
        throw new Error('spawn ssh ENOENT');
      }),
      remoteRunnerFactory: () => makeStubRunner(async () => {
        throw new Error('remote runner should not be called when ssh throws');
      }),
    });
    try {
      const response = await probeApp.inject({
        method: 'POST',
        url: '/api/agents/probe',
        payload: { mode: 'remote', host: { hostname: 'h.example' } },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.ssh.ok).toBe(false);
      expect(body.tmux).toEqual({ ok: false, message: 'SSH 不通，无法探测' });
      expect(body.runtimes['claude-code']).toEqual({ ok: false, message: 'SSH 不通，无法探测' });
      expect(body.runtimes['codex']).toEqual({ ok: false, message: 'SSH 不通，无法探测' });
    } finally {
      await probeApp.close();
    }
  });

  it('rejects an invalid inline host port with 400 (does not reach the ssh runner)', async () => {
    const probeApp = await buildProbeApp({
      localRunnerFactory: () => makeStubRunner(async () => {
        throw new Error('runner must not be called for an invalid port');
      }),
    });
    try {
      const response = await probeApp.inject({
        method: 'POST',
        url: '/api/agents/probe',
        payload: { mode: 'remote', host: { hostname: 'h.example', port: '2222; touch x' } },
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await probeApp.close();
    }
  });
});
