import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LockManager } from '../../src/state/lock.js';
import { initStateDir } from '../../src/state/init.js';

let tempDir: string;
let locks: LockManager;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-test-'));
  await initStateDir(tempDir);
  locks = new LockManager(join(tempDir, 'locks'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

describe('LockManager', () => {
  it('acquires a lock successfully', async () => {
    const acquired = await locks.acquire('dev-1');
    expect(acquired).toBe(true);
  });

  it('reports lock status', async () => {
    expect(await locks.isLocked('dev-1')).toBe(false);
    await locks.acquire('dev-1');
    expect(await locks.isLocked('dev-1')).toBe(true);
  });

  it('fails to acquire an already-held lock', async () => {
    await locks.acquire('dev-1');
    const second = await locks.acquire('dev-1');
    expect(second).toBe(false);
  });

  it('releases a lock', async () => {
    await locks.acquire('dev-1');
    await locks.release('dev-1');
    expect(await locks.isLocked('dev-1')).toBe(false);
  });

  it('allows re-acquisition after release', async () => {
    await locks.acquire('dev-1');
    await locks.release('dev-1');
    const acquired = await locks.acquire('dev-1');
    expect(acquired).toBe(true);
  });

  it('release is no-op for unlocked agent', async () => {
    await locks.release('dev-1');
    expect(await locks.isLocked('dev-1')).toBe(false);
    expect(await locks.acquire('dev-1')).toBe(true);
  });

  it('manages independent locks for different agents', async () => {
    await locks.acquire('dev-1');
    const acquired = await locks.acquire('qa-1');
    expect(acquired).toBe(true);
  });

  it('records and reports the owner of a lock', async () => {
    await locks.acquire('dev-1', 'task-42');
    expect(await locks.ownerOf('dev-1')).toBe('task-42');
  });

  it('ownerOf is null for an unlocked agent and for a lock acquired without an owner', async () => {
    expect(await locks.ownerOf('dev-1')).toBeNull();
    await locks.acquire('dev-1');
    expect(await locks.ownerOf('dev-1')).toBeNull();
  });

  it('ownerOf reflects the new owner after release + re-acquire', async () => {
    await locks.acquire('dev-1', 'task-a');
    await locks.release('dev-1');
    await locks.acquire('dev-1', 'task-b');
    expect(await locks.ownerOf('dev-1')).toBe('task-b');
  });
});
