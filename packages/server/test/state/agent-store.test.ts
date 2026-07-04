import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentStore, AGENT_STORE_NOOP } from '../../src/state/agent-store.js';
import { initStateDir } from '../../src/state/init.js';
import type { AgentBindingFacts } from '../../src/shared/index.js';

let tempDir: string;
let store: AgentStore;
const NOW = '2026-04-28T10:00:00Z';

function makeState(id: string, overrides: Partial<AgentBindingFacts> = {}): AgentBindingFacts {
  return { id, projectId: 'proj', updatedAt: NOW, ...overrides };
}

function agentsDir(): string {
  return join(tempDir, 'state', 'agents');
}

function captureChanges(): Array<['set' | 'delete', string]> {
  const fired: Array<['set' | 'delete', string]> = [];
  store.onChange((kind, id) => fired.push([kind, id]));
  return fired;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-test-'));
  await initStateDir(tempDir);
  store = new AgentStore(agentsDir());
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

describe('AgentStore', () => {
  it('returns null for nonexistent agent', async () => {
    expect(await store.get('nope')).toBeNull();
  });

  it('throws on unparseable JSON instead of reporting the binding as absent', async () => {
    await writeFile(join(agentsDir(), 'dev-1.json'), '{ corrupt');
    await expect(store.get('dev-1')).rejects.toThrow();
  });

  it('writes and reads durable binding facts', async () => {
    const state = makeState('dev-1', { taskId: 'task-001', paneId: '%1' });
    await store.set(state);
    const loaded = await store.get('dev-1');
    expect(loaded).toEqual(state);
  });

  it('overwrites existing binding facts', async () => {
    await store.set(makeState('dev-1', { taskId: 'task-a' }));
    await store.set(makeState('dev-1', { taskId: 'task-b' }));
    const loaded = await store.get('dev-1');
    expect(loaded!.taskId).toBe('task-b');
  });

  it('does not persist old status-like fields', async () => {
    const oldShape = {
      id: 'dev-1',
      projectId: 'proj',
      updatedAt: NOW,
      status: 'running',
      sessionStatus: 'ready',
      presence: 'present',
      bootstrapError: 'old error',
      busyAt: NOW,
      awaitingUserAt: NOW,
    };
    await store.set(oldShape as AgentBindingFacts);
    const disk = JSON.parse(
      await readFile(join(agentsDir(), 'dev-1.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(disk).toEqual({ id: 'dev-1', projectId: 'proj', updatedAt: NOW });
  });

  it('lists all agents', async () => {
    await store.set(makeState('dev-1'));
    await store.set(makeState('qa-1'));
    const all = await store.list();
    expect(all).toHaveLength(2);
    expect(all.map(a => a.id).sort()).toEqual(['dev-1', 'qa-1']);
  });

  it('returns empty list when no agents exist', async () => {
    expect(await store.list()).toEqual([]);
  });

  it('deletes agent state', async () => {
    await store.set(makeState('dev-1'));
    await store.delete('dev-1');
    expect(await store.get('dev-1')).toBeNull();
    expect(await store.list()).toHaveLength(0);
  });

  it('delete is no-op for nonexistent agent', async () => {
    await store.set(makeState('dev-1'));
    await store.delete('nope');
    expect(await store.get('dev-1')).not.toBeNull();
    expect(await store.list()).toHaveLength(1);
  });

  it('delete fires onChange("delete") on success', async () => {
    await store.set(makeState('dev-1'));
    const fired = captureChanges();
    await store.delete('dev-1');
    expect(fired).toEqual([['delete', 'dev-1']]);
  });

  it('delete fires onChange("delete") on ENOENT (idempotent semantics)', async () => {
    const fired = captureChanges();
    await store.delete('nonexistent');
    expect(fired).toEqual([['delete', 'nonexistent']]);
  });

  it('delete does NOT fire onChange when unlink fails for non-ENOENT reasons', async () => {
    const dir = join(agentsDir(), 'stuck.json');
    await mkdir(dir, { recursive: true });
    const fired = captureChanges();
    await store.delete('stuck');
    expect(fired).toEqual([]);
  });

  it('get/delete reject path-like ids so a store key cannot escape its dir', async () => {
    await store.set(makeState('dev-1'));
    for (const bad of ['../../../secret', '../dev-1', 'a/b', '..', 'dev 1']) {
      expect(await store.get(bad)).toBeNull();
    }
    const fired = captureChanges();
    await store.delete('../../../secret');
    expect(fired).toEqual([]);
    expect(await store.get('dev-1')).not.toBeNull();
  });
});

describe('AgentStore.update', () => {
  it('writes new state when existing is null', async () => {
    await store.update('dev-x', (existing) => {
      expect(existing).toBeNull();
      return makeState('dev-x', { taskId: 'task-1' });
    });
    expect((await store.get('dev-x'))?.taskId).toBe('task-1');
  });

  it('overwrites existing state when updater returns new AgentBindingFacts', async () => {
    await store.set(makeState('dev-x', { taskId: 'task-1' }));
    await store.update('dev-x', (existing) => ({
      ...existing!,
      taskId: 'task-2',
      updatedAt: NOW,
    }));
    expect((await store.get('dev-x'))?.taskId).toBe('task-2');
  });

  it('deletes file when updater returns null', async () => {
    await store.set(makeState('dev-x'));
    await store.update('dev-x', () => null);
    expect(await store.get('dev-x')).toBeNull();
  });

  it('skips write when updater returns AGENT_STORE_NOOP', async () => {
    await store.set(makeState('dev-x', { taskId: 'task-1' }));
    const before = await store.get('dev-x');
    await store.update('dev-x', () => AGENT_STORE_NOOP);
    expect(await store.get('dev-x')).toEqual(before);
  });

  it('persists in-place mutation when updater returns existing reference (NOT a no-op)', async () => {
    await store.set(makeState('dev-x', { taskId: 'task-1' }));
    await store.update('dev-x', (existing) => {
      existing!.taskId = 'task-2';
      return existing;
    });
    expect((await store.get('dev-x'))?.taskId).toBe('task-2');
  });

  it('propagates updater errors to caller and leaves store unchanged', async () => {
    await store.set(makeState('dev-x', { taskId: 'task-1' }));
    await expect(
      store.update('dev-x', () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
    expect((await store.get('dev-x'))?.taskId).toBe('task-1');
  });

  it('serializes concurrent updates of the same agent id (no lost updates)', async () => {
    await store.set(makeState('dev-x', { taskId: '0' }));
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, () =>
        store.update('dev-x', (existing) => ({
          ...existing!,
          taskId: String(parseInt(existing!.taskId!, 10) + 1),
          updatedAt: NOW,
        })),
      ),
    );
    expect((await store.get('dev-x'))?.taskId).toBe(String(N));
  });

  it('cross-agent updates both run to completion (no cross-id deadlock)', async () => {
    await store.set(makeState('dev-1'));
    await store.set(makeState('dev-2'));
    await Promise.all([
      store.update('dev-1', () => makeState('dev-1', { taskId: 'task-1' })),
      store.update('dev-2', () => makeState('dev-2', { taskId: 'task-2' })),
    ]);
    expect((await store.get('dev-1'))?.taskId).toBe('task-1');
    expect((await store.get('dev-2'))?.taskId).toBe('task-2');
  });

  it('does not poison the per-agent chain after an updater throws', async () => {
    await store.set(makeState('dev-x', { taskId: 'task-1' }));
    await expect(store.update('dev-x', () => { throw new Error('first'); })).rejects.toThrow();
    await store.update('dev-x', (existing) => ({ ...existing!, taskId: 'task-2', updatedAt: NOW }));
    expect((await store.get('dev-x'))?.taskId).toBe('task-2');
  });
});
