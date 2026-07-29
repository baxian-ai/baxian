import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BaxianEvent } from '../../src/shared/index.js';
import type { AgentManager } from '../../src/agent/manager.js';
import type { AgentStore } from '../../src/state/agent-store.js';
import type { TaskStore } from '../../src/state/task-store.js';
import type { LockManager } from '../../src/state/lock.js';
import type { EventBus } from '../../src/event/bus.js';
import { ErrorRecordStore } from '../../src/state/error-record-store.js';
import { createManagerHarness } from '../helpers/manager-harness.js';
import { fakeRunner } from '../helpers/fake-runner.js';
import { makeTask } from '../helpers/fixtures.js';

const NOW = '2026-04-28T10:00:00Z';

let tempDir: string;
let agentStore: AgentStore;
let taskStore: TaskStore;
let lockManager: LockManager;
let eventBus: EventBus;
let manager: AgentManager;
let errorRecordStore: ErrorRecordStore;
let events: BaxianEvent[];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-reconcile-'));
  errorRecordStore = new ErrorRecordStore(join(tempDir, 'state', 'errors'));
  const runner = fakeRunner({ defaultResult: {} });
  const harness = await createManagerHarness(tempDir, {
    deps: {
      errorRecordStore,
      runnerFactory: () => runner,
      platformRunner: runner,
    },
  });
  ({ manager, agentStore, taskStore, lockManager, eventBus, events } = harness);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('AgentManager.reconcileFailedAgent', () => {
  it('holds the task binding and exact lock when tmux is missing, then fails the active task', async () => {
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: 'task-old',
      workdir: '/tmp/repo',
      startedAt: NOW,
      paneId: 'P-1',
      updatedAt: NOW,
    });
    await taskStore.set(makeTask({
      id: 'task-old',
      phase: 'code',
      branchCreatedByBaxian: undefined,
      platformBinding: undefined,
      createdAt: NOW,
      updatedAt: NOW,
    }));
    await lockManager.acquire('dev-1', 'task-old');

    expect(await manager.reconcileFailedAgent('dev-1')).toBe(true);

    expect(await agentStore.get('dev-1')).toMatchObject({
      id: 'dev-1',
      projectId: 'proj',
      workdir: '/tmp/repo',
    });
    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBe('task-old');
    expect(state?.workdir).toBe('/tmp/repo');
    expect(state?.paneId).toBeUndefined();
    expect(state?.creationToken).toBeUndefined();
    expect(state).toMatchObject({ status: 'awaiting_human', awaitingPhase: 'runtime-missing' });
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    expect((await taskStore.get('task-old'))?.status).toBe('failed');
    expect(events.some(e => e.type === 'agent.recovered' && e.agentId === 'dev-1')).toBe(true);
    expect(await errorRecordStore.latestForAgent('dev-1')).toMatchObject({
      reason: 'TMUX_SESSION_ABSENT',
      taskId: 'task-old',
    });
  });

  it('returns false when agent binding does not exist', async () => {
    expect(await manager.reconcileFailedAgent('dev-1')).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('does not throw when event emission fails', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: 'P-1', updatedAt: NOW });
    vi.spyOn(eventBus, 'emit').mockRejectedValueOnce(new Error('emit boom'));
    await expect(manager.reconcileFailedAgent('dev-1')).resolves.toBe(true);
    expect(await agentStore.get('dev-1')).toMatchObject({ id: 'dev-1', projectId: 'proj' });
  });

  it('does not repeatedly emit recovered once absent reconciliation has already cleared volatile binding facts', async () => {
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      workdir: '/tmp/repo',
      paneId: 'P-1',
      updatedAt: NOW,
    });

    expect(await manager.reconcileFailedAgent('dev-1')).toBe(true);
    expect(await manager.reconcileFailedAgent('dev-1')).toBe(false);

    expect(events.filter(e => e.type === 'agent.recovered')).toHaveLength(1);
  });

  it('does not clear a creationToken acquired after an earlier stale read', async () => {
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      workdir: '/tmp/repo',
      updatedAt: NOW,
    });
    const stalePrecheck = await agentStore.get('dev-1');
    expect(stalePrecheck?.creationToken).toBeUndefined();
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      workdir: '/tmp/repo',
      creationToken: 'create-new',
      paneId: 'P-new',
      updatedAt: NOW,
    });

    expect(await manager.reconcileFailedAgent('dev-1')).toBe(false);

    expect(await agentStore.get('dev-1')).toMatchObject({
      creationToken: 'create-new',
      paneId: 'P-new',
      workdir: '/tmp/repo',
    });
    expect(events.filter(e => e.type === 'agent.recovered')).toHaveLength(0);
    expect(await errorRecordStore.latestForAgent('dev-1')).toBeUndefined();
  });
});
