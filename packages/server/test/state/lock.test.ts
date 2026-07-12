import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LockManager } from '../../src/state/lock.js';
import { initStateDir } from '../../src/state/init.js';

let tempDir: string;
let locks: LockManager;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-lock-'));
  await initStateDir(tempDir);
  locks = new LockManager(join(tempDir, 'locks'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

describe('LockManager', () => {
  it('persists the task owner and a unique generation token', async () => {
    const token = await locks.acquire('dev-1', 'task-42');

    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(await locks.claimOf('dev-1')).toMatchObject({
      agentId: 'dev-1',
      taskId: 'task-42',
      token,
    });
    expect(await locks.isOwner('dev-1', 'task-42', token!)).toBe(true);
  });

  it('lets only one of two concurrent tasks acquire an agent', async () => {
    const [a, b] = await Promise.all([
      locks.acquire('dev-1', 'task-a'),
      locks.acquire('dev-1', 'task-b'),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('releases only when task and token both match', async () => {
    const token = (await locks.acquire('dev-1', 'task-a'))!;

    expect(await locks.releaseIfOwner('dev-1', 'task-b', token)).toBe(false);
    expect(await locks.releaseIfOwner('dev-1', 'task-a', 'stale-token')).toBe(false);
    expect(await locks.isLocked('dev-1')).toBe(true);
    expect(await locks.releaseIfOwner('dev-1', 'task-a', token)).toBe(true);
    expect(await locks.isLocked('dev-1')).toBe(false);
  });

  it('a delayed old release cannot remove a newly acquired generation', async () => {
    const oldToken = (await locks.acquire('dev-1', 'task-a'))!;
    await locks.releaseIfOwner('dev-1', 'task-a', oldToken);
    const newToken = (await locks.acquire('dev-1', 'task-b'))!;

    expect(await locks.releaseIfOwner('dev-1', 'task-a', oldToken)).toBe(false);
    expect(await locks.isOwner('dev-1', 'task-b', newToken)).toBe(true);
  });

  it('lists exact claims so startup recovery can reclaim maintenance locks safely', async () => {
    const devToken = await locks.acquire('dev-1', 'maintenance:branch-reconcile');
    const qaToken = await locks.acquire('qa-1', 'task-42');

    expect(await locks.listClaims()).toEqual([
      expect.objectContaining({ agentId: 'dev-1', taskId: 'maintenance:branch-reconcile', token: devToken }),
      expect.objectContaining({ agentId: 'qa-1', taskId: 'task-42', token: qaToken }),
    ]);
  });
});
