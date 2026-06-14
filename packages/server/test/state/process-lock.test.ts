import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessLock, ProcessLockError } from '../../src/state/process-lock.js';

// Probed: pick a high pid that ESRCH's right now. Avoids hard-coding "high"
// numbers that are wrong relative to platform pid_max (Linux can hit 4M).
function probeDeadPid(): number {
  for (let pid = 999_999; pid >= 100_000; pid--) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ESRCH') return pid;
    }
  }
  throw new Error('could not find a dead pid in [100000, 999999]');
}
const DEAD_PID = probeDeadPid();

describe('ProcessLock', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'baxian-process-lock-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('acquire writes a lock file with the current pid + timestamp', async () => {
    const lock = new ProcessLock(stateDir);
    const info = await lock.acquire();
    expect(info.pid).toBe(process.pid);
    expect(info.acquiredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(lock.isAcquired()).toBe(true);

    const raw = await readFile(lock.getPath(), 'utf-8');
    const parsed = JSON.parse(raw.trim());
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.acquiredAt).toBe(info.acquiredAt);
  });

  it('release deletes the lock file and clears acquired flag', async () => {
    const lock = new ProcessLock(stateDir);
    await lock.acquire();
    await lock.release();
    expect(lock.isAcquired()).toBe(false);
    await expect(access(lock.getPath())).rejects.toThrow();
  });

  it('release on a never-acquired lock is a noop (does not delete other lock files)', async () => {
    const lock = new ProcessLock(stateDir);
    // pre-create a lock file owned by another (real) process — ours
    await writeFile(
      lock.getPath(),
      `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
      { flag: 'wx' },
    );
    await lock.release();
    // file should still be there because we never acquired this instance
    const raw = await readFile(lock.getPath(), 'utf-8');
    expect(raw).toContain(`"pid":${process.pid}`);
  });

  it('rejects when another live baxian process already holds the lock', async () => {
    // Simulate another live process holding the lock by recording our own pid.
    await writeFile(
      join(stateDir, '.baxian-server.lock'),
      `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
      { flag: 'wx' },
    );
    const lock = new ProcessLock(stateDir);
    await expect(lock.acquire()).rejects.toBeInstanceOf(ProcessLockError);
  });

  it('refuses to auto-reclaim a stale lock (operator must verify + rm to avoid race)', async () => {
    await writeFile(
      join(stateDir, '.baxian-server.lock'),
      `${JSON.stringify({ pid: DEAD_PID, acquiredAt: '2020-01-01T00:00:00.000Z' })}\n`,
      { flag: 'wx' },
    );

    const lock = new ProcessLock(stateDir);
    await expect(lock.acquire()).rejects.toBeInstanceOf(ProcessLockError);

    // Stale file must remain — auto-unlink would race a concurrent reclaim.
    const raw = await readFile(lock.getPath(), 'utf-8');
    expect(JSON.parse(raw.trim()).pid).toBe(DEAD_PID);
  });

  it('refuses to auto-reclaim when the lock file is corrupted (still requires manual cleanup)', async () => {
    await writeFile(join(stateDir, '.baxian-server.lock'), 'not-json{garbage', { flag: 'wx' });
    const lock = new ProcessLock(stateDir);
    await expect(lock.acquire()).rejects.toBeInstanceOf(ProcessLockError);
  });

  it('preserves the existing lock info on the thrown error so callers can report PID/time', async () => {
    await writeFile(
      join(stateDir, '.baxian-server.lock'),
      `${JSON.stringify({ pid: process.pid, acquiredAt: '2025-12-31T23:59:00.000Z' })}\n`,
      { flag: 'wx' },
    );
    const lock = new ProcessLock(stateDir);
    try {
      await lock.acquire();
      throw new Error('expected acquire to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProcessLockError);
      const e = err as ProcessLockError;
      expect(e.existing?.pid).toBe(process.pid);
      expect(e.existing?.acquiredAt).toBe('2025-12-31T23:59:00.000Z');
      expect(e.message).toContain(String(process.pid));
    }
  });

  it('lock payload includes a per-instance ownerId (UUID) for owner-scoped release', async () => {
    const lock = new ProcessLock(stateDir);
    const info = await lock.acquire();
    expect(info.ownerId).toMatch(/^[0-9a-f-]{36}$/);
    const raw = await readFile(lock.getPath(), 'utf-8');
    expect(JSON.parse(raw.trim()).ownerId).toBe(info.ownerId);
  });

  it('release rejects when ownerId mismatch and preserves the intruder file', async () => {
    // throw is required so /api/restart aborts before spawning a child that can't acquire.
    const lock = new ProcessLock(stateDir);
    await lock.acquire();
    const intruderInfo = {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      ownerId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    };
    await writeFile(lock.getPath(), `${JSON.stringify(intruderInfo)}\n`);
    await expect(lock.release()).rejects.toBeInstanceOf(ProcessLockError);
    expect(lock.isAcquired()).toBe(false);
    const raw = await readFile(lock.getPath(), 'utf-8');
    expect(JSON.parse(raw.trim()).ownerId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('legacy lock file (no ownerId) with dead pid is treated as stale (acquire throws)', async () => {
    await writeFile(
      join(stateDir, '.baxian-server.lock'),
      `${JSON.stringify({ pid: DEAD_PID, acquiredAt: '2020-01-01T00:00:00.000Z' })}\n`,
      { flag: 'wx' },
    );
    const lock = new ProcessLock(stateDir);
    await expect(lock.acquire()).rejects.toBeInstanceOf(ProcessLockError);
  });

  it('legacy lock file (no ownerId) with live pid is treated as held (acquire throws)', async () => {
    // Same scenario but pid is alive — should throw "another server holds the lock"
    // rather than the stale path.
    await writeFile(
      join(stateDir, '.baxian-server.lock'),
      `${JSON.stringify({ pid: process.pid, acquiredAt: '2025-12-31T23:59:00.000Z' })}\n`,
      { flag: 'wx' },
    );
    const lock = new ProcessLock(stateDir);
    await expect(lock.acquire()).rejects.toThrow(/another baxian server appears to hold/);
  });

  it('release refuses to delete a malformed lock file (cannot prove ownership)', async () => {
    // After acquire, an external actor / corruption replaces the file with
    // unparseable content. release must not blindly unlink — owner-scoped
    // release promises "only delete what is provably ours".
    const lock = new ProcessLock(stateDir);
    await lock.acquire();
    await writeFile(lock.getPath(), 'not-json{garbage');
    await expect(lock.release()).rejects.toBeInstanceOf(ProcessLockError);
    // File must remain (refused-to-delete branch)
    const raw = await readFile(lock.getPath(), 'utf-8');
    expect(raw).toBe('not-json{garbage');
    // acquired state is kept so the caller can retry / surface the failure
    expect(lock.isAcquired()).toBe(true);
  });

  it('release on an already-deleted lock file clears state and returns', async () => {
    // External `rm` between acquire and release: missing branch should be
    // a clean noop, not a throw — the desired end-state is achieved.
    const lock = new ProcessLock(stateDir);
    await lock.acquire();
    await rm(lock.getPath(), { force: true });
    await lock.release();
    expect(lock.isAcquired()).toBe(false);
  });

  // releaseSync is the only path that runs from `process.once('exit', ...)`
  // — Node drops queued microtasks at that point, so async release would no-op.
  describe('releaseSync', () => {
    it('deletes the lock file when ownerId matches', async () => {
      const lock = new ProcessLock(stateDir);
      await lock.acquire();
      lock.releaseSync();
      expect(lock.isAcquired()).toBe(false);
      await expect(access(lock.getPath())).rejects.toThrow();
    });

    it('preserves the file on ownerId mismatch (cannot delete intruder lock)', async () => {
      const lock = new ProcessLock(stateDir);
      await lock.acquire();
      await writeFile(
        lock.getPath(),
        `${JSON.stringify({
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
          ownerId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        })}\n`,
      );
      lock.releaseSync();
      const raw = await readFile(lock.getPath(), 'utf-8');
      expect(JSON.parse(raw.trim()).ownerId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    });

    it('preserves the file when malformed (best-effort, cannot prove ownership)', async () => {
      const lock = new ProcessLock(stateDir);
      await lock.acquire();
      await writeFile(lock.getPath(), 'not-json{garbage');
      lock.releaseSync();
      const raw = await readFile(lock.getPath(), 'utf-8');
      expect(raw).toBe('not-json{garbage');
    });

    it('clears state when the file was already removed externally', async () => {
      const lock = new ProcessLock(stateDir);
      await lock.acquire();
      await rm(lock.getPath(), { force: true });
      lock.releaseSync();
      expect(lock.isAcquired()).toBe(false);
    });

    it('is a noop when never acquired', () => {
      const lock = new ProcessLock(stateDir);
      expect(() => lock.releaseSync()).not.toThrow();
      expect(lock.isAcquired()).toBe(false);
    });
  });
});
