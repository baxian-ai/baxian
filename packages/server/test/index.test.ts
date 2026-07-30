import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type AddressInfo } from 'node:net';
import {
  formatServerRunningMessage,
  pickExistingPath,
  startServer,
} from '../src/index.js';
import { ProcessLock, ProcessLockError } from '../src/state/process-lock.js';
import { writeFile } from 'node:fs/promises';
import { initStateDir } from '../src/state/init.js';
import { TaskStore } from '../src/state/task-store.js';
import { EventLog } from '../src/event/log.js';

let tempDir: string;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let warns: string[];
let errors: unknown[][];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-startup-test-'));
  warns = [];
  errors = [];
  warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warns.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  });
  errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
});

afterEach(async () => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  await rm(tempDir, { recursive: true });
});


describe('formatServerRunningMessage', () => {
  it('prints the default server URL in the startup line', () => {
    expect(formatServerRunningMessage('127.0.0.1', 3000, false)).toBe(
      'baxian server running on http://127.0.0.1:3000',
    );
  });

  it('uses the actual bound host instead of replacing wildcard bind addresses', () => {
    const message = formatServerRunningMessage('0.0.0.0', 8080, false);

    expect(message).toBe('baxian server running on http://0.0.0.0:8080');
    expect(message).not.toMatch(/Open .*browser/i);
  });

  it('formats HTTPS IPv6 hosts as a valid URL authority', () => {
    expect(formatServerRunningMessage('::', 3443, true)).toBe(
      'baxian server running on https://[::]:3443',
    );
  });
});

describe('startServer', () => {
  const QUIET_INTERVALS = {
    githubPollIntervalMs: 3_600_000,
    tmuxProbePollIntervalMs: 3_600_000,
    bootstrapRetryIntervalMs: 3_600_000,
  };

  function getFreePort(): Promise<number> {
    return new Promise((resolvePort) => {
      const srv = createServer();
      srv.listen(0, '127.0.0.1', () => {
        const port = (srv.address() as AddressInfo).port;
        srv.close(() => resolvePort(port));
      });
    });
  }

  async function writeConfig(
    server: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Promise<{ home: string; cfgPath: string; stateDir: string }> {
    const cfgPath = join(tempDir, 'baxian.json');
    await writeFile(
      cfgPath,
      JSON.stringify({ review: { rounds: 10 }, server, host: [], project: [], ...extra }),
    );
    return { home: tempDir, cfgPath, stateDir: tempDir };
  }

  it('boots the composed server, serves /health, consumes the restart sentinel, and shuts down on SIGINT', async () => {
    const port = await getFreePort();
    const { home, stateDir } = await writeConfig({ port, host: '127.0.0.1', ...QUIET_INTERVALS });
    await mkdir(join(stateDir, 'state'), { recursive: true });
    await writeFile(
      join(stateDir, 'state', 'restart-intent.json'),
      JSON.stringify({
        kind: 'restart',
        restartId: 'r-1',
        parentPid: process.pid,
        createdAt: Date.now(),
        ttlMs: 60_000,
        actor: 'test',
      }),
    );

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const sigintBefore = new Set(process.listeners('SIGINT'));
    const sigtermBefore = new Set(process.listeners('SIGTERM'));
    const exitBefore = new Set(process.listeners('exit'));

    try {
      await startServer(home);

      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const out = logs.join('\n');
      expect(out).toContain(`baxian server running on http://127.0.0.1:${port}`);
      expect(out).toContain('[startup] restart confirmed');
      expect(out).toContain('actor=test');

      const sigintHandler = process.listeners('SIGINT').find((l) => !sigintBefore.has(l));
      expect(sigintHandler).toBeDefined();
      sigintHandler!();
      await vi.waitFor(() => {
        expect(exitSpy).toHaveBeenCalledWith(130);
      }, { timeout: 15_000 });

      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    } finally {
      for (const l of process.listeners('SIGINT')) if (!sigintBefore.has(l)) process.removeListener('SIGINT', l);
      for (const l of process.listeners('SIGTERM')) if (!sigtermBefore.has(l)) process.removeListener('SIGTERM', l);
      for (const l of process.listeners('exit')) if (!exitBefore.has(l)) process.removeListener('exit', l);
      exitSpy.mockRestore();
      logSpy.mockRestore();
    }
  }, 30_000);

  it('emits a platform-binding intervention when an active task binding differs from live config', async () => {
    const port = await getFreePort();
    const cfgPath = join(tempDir, 'baxian.json');
    const stateDir = tempDir;
    await writeFile(cfgPath, JSON.stringify({
      review: { rounds: 3 },
      server: { port, host: '127.0.0.1', ...QUIET_INTERVALS },
      host: [],
      project: [
        { id: 'b-live', repo: 'https://github.com/owner/repo.git', merge: null, agent: [] },
      ],
    }));
    await initStateDir(stateDir);
    const now = new Date().toISOString();
    await new TaskStore(join(stateDir, 'state', 'tasks')).set({
      id: 'task-binding-mismatch', projectId: 'b-live', title: 'binding mismatch', description: 'binding audit',
      preferredAgentId: 'dev-retained', agentId: 'dev-retained', devAgentId: 'dev-retained',
      qaAgentId: 'qa-retained',
      reviewRound: 0, status: 'pending',
      platformBinding: { mode: 'server', repoKey: 'github.com/owner/repo', tool: 'gh' },
      createdAt: now, updatedAt: now,
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const sigintBefore = new Set(process.listeners('SIGINT'));
    const sigtermBefore = new Set(process.listeners('SIGTERM'));
    const exitBefore = new Set(process.listeners('exit'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await startServer(stateDir);

      const events = await new EventLog(join(stateDir, 'events'))
        .readDate(new Date().toISOString().slice(0, 10));
      expect(events).toContainEqual(expect.objectContaining({
        type: 'human.intervention',
        projectId: 'b-live',
        taskId: 'task-binding-mismatch',
        data: expect.objectContaining({
          phase: 'platform-binding-mismatch',
          reason: 'identity-mismatch',
          differences: ['mode'],
        }),
      }));

      const sigintHandler = process.listeners('SIGINT').find(listener => !sigintBefore.has(listener));
      expect(sigintHandler).toBeDefined();
      sigintHandler!();
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130), { timeout: 15_000 });
    } finally {
      for (const listener of process.listeners('SIGINT')) {
        if (!sigintBefore.has(listener)) process.removeListener('SIGINT', listener);
      }
      for (const listener of process.listeners('SIGTERM')) {
        if (!sigtermBefore.has(listener)) process.removeListener('SIGTERM', listener);
      }
      for (const listener of process.listeners('exit')) {
        if (!exitBefore.has(listener)) process.removeListener('exit', listener);
      }
      exitSpy.mockRestore();
      logSpy.mockRestore();
    }
  }, 30_000);

  it('fails fast with ProcessLockError when another instance holds the state lock', async () => {
    const { home, stateDir } = await writeConfig({ port: 3000, host: '127.0.0.1', ...QUIET_INTERVALS });
    await mkdir(stateDir, { recursive: true });
    const competitor = new ProcessLock(stateDir);
    await competitor.acquire();
    try {
      await expect(startServer(home)).rejects.toBeInstanceOf(ProcessLockError);
      expect(errors.flat().join(' ')).toContain('[startup] process lock acquisition failed');
    } finally {
      await competitor.release();
    }
  });

  it('releases the process lock when startup fails mid-way', async () => {
    const { home, stateDir } = await writeConfig({
      port: 3000,
      host: '127.0.0.1',
      https: { keyFile: join(tempDir, 'missing.key'), certFile: join(tempDir, 'missing.crt') },
      ...QUIET_INTERVALS,
    });
    const sigintBefore = new Set(process.listeners('SIGINT'));
    const sigtermBefore = new Set(process.listeners('SIGTERM'));
    const exitBefore = new Set(process.listeners('exit'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await expect(startServer(home)).rejects.toMatchObject({ code: 'ENOENT' });

      const reacquire = new ProcessLock(stateDir);
      await expect(reacquire.acquire()).resolves.not.toThrow();
      await reacquire.release();
    } finally {
      for (const l of process.listeners('SIGINT')) if (!sigintBefore.has(l)) process.removeListener('SIGINT', l);
      for (const l of process.listeners('SIGTERM')) if (!sigtermBefore.has(l)) process.removeListener('SIGTERM', l);
      for (const l of process.listeners('exit')) if (!exitBefore.has(l)) process.removeListener('exit', l);
      logSpy.mockRestore();
    }
  }, 30_000);
});

describe('pickExistingPath', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'pick-path-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true });
  });

  it('returns the first candidate that exists', async () => {
    await mkdir(join(base, 'a'));
    await mkdir(join(base, 'b'));
    expect(pickExistingPath(base, ['./a', './b'])).toBe(join(base, 'a'));
  });

  it('skips missing candidates and returns the first existing one', async () => {
    await mkdir(join(base, 'b'));
    expect(pickExistingPath(base, ['./missing', './b'])).toBe(join(base, 'b'));
  });

  it('falls back to the first candidate when none exist (caller surfaces ENOENT explicitly)', () => {
    expect(pickExistingPath(base, ['./nope-1', './nope-2'])).toBe(join(base, 'nope-1'));
  });

  it('treats files (not just dirs) as existing', async () => {
    await writeFile(join(base, 'a.txt'), 'hi');
    expect(pickExistingPath(base, ['./a.txt', './b'])).toBe(join(base, 'a.txt'));
  });
});
