import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type AddressInfo } from 'node:net';
import {
  formatServerRunningMessage,
  migrateLegacyPollerStateFile,
  pickExistingPath,
  startServer,
} from '../src/index.js';
import { ProcessLock, ProcessLockError } from '../src/state/process-lock.js';
import { readFile, writeFile, access } from 'node:fs/promises';

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

describe('migrateLegacyPollerStateFile', () => {
  let stateRoot: string;
  beforeEach(async () => {
    stateRoot = join(tempDir, 'state');
    await mkdir(stateRoot, { recursive: true });
  });

  it('renames a legacy `poller-${projectId}.json` to the new repo-keyed path', async () => {
    const legacy = join(stateRoot, 'poller-proj-a.json');
    const target = join(stateRoot, 'poller-owner%2Frepo.json');
    await writeFile(legacy, JSON.stringify({ pullsByHead: { 'bx/x': 'sha' } }));

    await migrateLegacyPollerStateFile(tempDir, ['proj-a'], target);

    await expect(readFile(target, 'utf-8')).resolves.toContain('bx/x');
    await expect(access(legacy)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the existing new-style file and does not clobber it when both exist', async () => {
    const legacy = join(stateRoot, 'poller-proj-b.json');
    const target = join(stateRoot, 'poller-owner%2Frepo2.json');
    await writeFile(legacy, JSON.stringify({ legacy: true }));
    await writeFile(target, JSON.stringify({ current: true }));

    await migrateLegacyPollerStateFile(tempDir, ['proj-b'], target);

    await expect(readFile(target, 'utf-8')).resolves.toContain('"current":true');
    await expect(readFile(legacy, 'utf-8')).resolves.toContain('"legacy":true');
  });

  it('is a silent no-op when no candidate legacy files exist (steady-state boot)', async () => {
    const target = join(stateRoot, 'poller-owner%2Frepo3.json');
    await expect(
      migrateLegacyPollerStateFile(tempDir, ['no-such-project'], target),
    ).resolves.toBeUndefined();
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('picks the first candidate that has a legacy file (shared-repo migration covers all duplicate projects)', async () => {
    const legacyForA = join(stateRoot, 'poller-a.json');
    await writeFile(legacyForA, JSON.stringify({ pullsByHead: { 'bx/old': 'sha-old' } }));
    const target = join(stateRoot, 'poller-shared%2Frepo.json');

    await migrateLegacyPollerStateFile(tempDir, ['x', 'a'], target);

    await expect(readFile(target, 'utf-8')).resolves.toContain('sha-old');
    await expect(access(legacyForA)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('first-found-wins: if multiple candidates have legacy files, only the first is migrated; the rest are left for manual cleanup', async () => {
    const legacyForX = join(stateRoot, 'poller-x.json');
    const legacyForA = join(stateRoot, 'poller-a.json');
    await writeFile(legacyForX, JSON.stringify({ from: 'x' }));
    await writeFile(legacyForA, JSON.stringify({ from: 'a' }));
    const target = join(stateRoot, 'poller-shared%2Frepo2.json');

    await migrateLegacyPollerStateFile(tempDir, ['x', 'a'], target);

    await expect(readFile(target, 'utf-8')).resolves.toContain('"from":"x"');
    await expect(access(legacyForX)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(legacyForA, 'utf-8')).resolves.toContain('"from":"a"');
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

  async function writeConfig(server: Record<string, unknown>): Promise<{ cfgPath: string; stateDir: string }> {
    const cfgPath = join(tempDir, 'baxian.json');
    await writeFile(
      cfgPath,
      JSON.stringify({ review: { rounds: 10 }, server, host: [], project: [] }),
    );
    return { cfgPath, stateDir: join(tempDir, '.baxian') };
  }

  it('boots the composed server, serves /health, consumes the restart sentinel, and shuts down on SIGINT', async () => {
    const port = await getFreePort();
    const { cfgPath, stateDir } = await writeConfig({ port, host: '127.0.0.1', ...QUIET_INTERVALS });
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
      await startServer(cfgPath);

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

  it('fails fast with ProcessLockError when another instance holds the state lock', async () => {
    const { cfgPath, stateDir } = await writeConfig({ port: 3000, host: '127.0.0.1', ...QUIET_INTERVALS });
    await mkdir(stateDir, { recursive: true });
    const competitor = new ProcessLock(stateDir);
    await competitor.acquire();
    try {
      await expect(startServer(cfgPath)).rejects.toBeInstanceOf(ProcessLockError);
      expect(errors.flat().join(' ')).toContain('[startup] process lock acquisition failed');
    } finally {
      await competitor.release();
    }
  });

  it('releases the process lock when startup fails mid-way (unreadable https key)', async () => {
    const { cfgPath, stateDir } = await writeConfig({
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
      await expect(startServer(cfgPath)).rejects.toMatchObject({ code: 'ENOENT' });

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
