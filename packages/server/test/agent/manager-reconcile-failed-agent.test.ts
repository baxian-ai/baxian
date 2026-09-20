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
import { createManagerHarness, repoStoreStandIn } from '../helpers/manager-harness.js';
import { fakeRunner, type FakeRunner } from '../helpers/fake-runner.js';
import { makeTask } from '../helpers/fixtures.js';
import type { ExecOptions, ExecResult } from '../../src/agent/runner.js';
import { DEFAULT_TMUX_PROBE_TIMEOUT_MS } from '../../src/shared/constants.js';

const NOW = '2026-04-28T10:00:00Z';
const SESSION_ABSENT: Partial<ExecResult> = { stdout: '' };

let tempDir: string;
let agentStore: AgentStore;
let taskStore: TaskStore;
let lockManager: LockManager;
let eventBus: EventBus;
let manager: AgentManager;
let errorRecordStore: ErrorRecordStore;
let events: BaxianEvent[];
let runner: FakeRunner;
// null 时 list-sessions 交给 fake 的会话模型求值
let sessionSnapshotReply: ((command: string, options?: ExecOptions) => Partial<ExecResult>) | null;
let onExecHook: (command: string) => void | Promise<void>;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-reconcile-'));
  errorRecordStore = new ErrorRecordStore(join(tempDir, 'state', 'errors'));
  sessionSnapshotReply = () => SESSION_ABSENT;
  onExecHook = () => undefined;
  runner = fakeRunner({
    rules: [{
      match: command => command.includes('tmux list-sessions') && sessionSnapshotReply !== null,
      reply: (command, options) => sessionSnapshotReply!(command, options),
    }],
    onExec: command => onExecHook(command),
  });
  const harness = await createManagerHarness(tempDir, {
    deps: {
      errorRecordStore,
      runnerFactory: () => runner,
      platformRunner: runner,
      repoStoreFactory: repoStoreStandIn(tempDir),
      compactIdlePollMs: 1,
      readyStableSpacingMs: 1,
      runtimeLivenessProbeMs: 1,
      bootstrapTimeoutsMs: { trustDialog: 300, waitReplReady: 1_000 },
    },
  });
  ({ manager, agentStore, taskStore, lockManager, eventBus, events } = harness);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function seedBoundAgent(): Promise<void> {
  await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'task-old', workdir: '/tmp/repo', startedAt: NOW, paneId: 'P-1', updatedAt: NOW });
  await taskStore.set(makeTask({ id: 'task-old', phase: 'code', createdAt: NOW, updatedAt: NOW }));
}

// 让 reconcile 停在 task-lock 临界区内(failBoundTasksLocked 的首次 list)
function gateFirstTaskList(): { release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const realList = taskStore.list.bind(taskStore);
  vi.spyOn(taskStore, 'list').mockImplementationOnce(async (filter) => { await gate; return realList(filter); });
  return { release };
}

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

  it('leaves the binding, its task and the error log untouched when stillCurrent has turned false by the time the task lock is acquired', async () => {
    await seedBoundAgent();
    const { release } = gateFirstTaskList();
    const lockHolder = manager.failTasksForAgent('nobody', 'holds the task lock while the reconcile queues behind it');
    let current = true;
    const reconcile = manager.reconcileFailedAgent('dev-1', { stillCurrent: () => current });
    current = false;
    release();
    await lockHolder;

    expect(await reconcile).toBe(false);
    expect(await agentStore.get('dev-1')).toMatchObject({ taskId: 'task-old', paneId: 'P-1', startedAt: NOW });
    expect((await agentStore.get('dev-1'))?.status).toBeUndefined();
    expect((await taskStore.get('task-old'))?.status).toBe('in_progress');
    expect(events.filter(e => e.type === 'agent.recovered')).toHaveLength(0);
    expect(await errorRecordStore.latestForAgent('dev-1')).toBeUndefined();
  });

  it('a stillCurrent guard that stays true reconciles exactly like the default', async () => {
    await seedBoundAgent();

    expect(await manager.reconcileFailedAgent('dev-1', { stillCurrent: () => true })).toBe(true);

    expect(await agentStore.get('dev-1')).toMatchObject({ status: 'awaiting_human', awaitingPhase: 'runtime-missing' });
    expect((await taskStore.get('task-old'))?.status).toBe('failed');
  });

  it('decides once at the binding write: a guard that flips false right after it still fails the task, so a hold never lands without its task failure', async () => {
    await seedBoundAgent();
    let reads = 0;
    const stillCurrent = (): boolean => reads++ === 0;

    expect(await manager.reconcileFailedAgent('dev-1', { stillCurrent })).toBe(true);

    expect(reads).toBe(1);
    expect(await agentStore.get('dev-1')).toMatchObject({ status: 'awaiting_human', awaitingPhase: 'runtime-missing', taskId: 'task-old' });
    expect((await taskStore.get('task-old'))?.status).toBe('failed');
    expect(events.some(e => e.type === 'task.updated' && e.taskId === 'task-old')).toBe(true);
    expect(events.filter(e => e.type === 'agent.recovered')).toHaveLength(1);
    expect(await errorRecordStore.latestForAgent('dev-1')).toMatchObject({ reason: 'TMUX_SESSION_ABSENT', taskId: 'task-old' });
  });

  it('holds the binding and fails the task inside one task-lock section: a fail-tasks sweep queued behind the reconcile finds the task already failed', async () => {
    await seedBoundAgent();
    const { release } = gateFirstTaskList();

    const reconcile = manager.reconcileFailedAgent('dev-1');
    await new Promise(resolve => setTimeout(resolve, 20));
    const sweep = manager.failTasksForAgent('dev-1', 'queued behind the reconcile');
    release();
    await reconcile;

    expect(await sweep).toEqual({ failedTaskIds: [], projectIds: [] });
    expect(events.filter(e => e.type === 'task.updated' && e.taskId === 'task-old')).toHaveLength(1);
    expect(await agentStore.get('dev-1')).toMatchObject({ awaitingPhase: 'runtime-missing' });
  });

  it('a session rebuilt while the reconcile waits for the lifecycle chain turns the reconcile into a no-op: retry and restart rebuild on that same chain', async () => {
    await seedBoundAgent();
    sessionSnapshotReply = null;
    runner.sessions.drop('dev-1');
    let reconcile: Promise<boolean> | undefined;
    onExecHook = async (command) => {
      if (!command.includes('tmux new-session') || reconcile) return;
      // 重建已持有生命周期链,此刻发起的 reconcile 只能排在它后面
      reconcile = manager.reconcileFailedAgent('dev-1', { stillCurrent: () => true });
      await new Promise(resolve => setTimeout(resolve, 20));
    };

    const rebuilt = await manager.ensureSession('dev-1', 'runtime');

    expect(rebuilt.createdSession).toBe(true);
    expect(runner.sessions.present('dev-1')).toBe(true);
    expect(await reconcile).toBe(false);
    expect(await agentStore.get('dev-1')).toMatchObject({ taskId: 'task-old', paneId: 'P-1', startedAt: NOW });
    expect((await agentStore.get('dev-1'))?.status).toBeUndefined();
    expect((await taskStore.get('task-old'))?.status).toBe('in_progress');
    expect(events.filter(e => e.type === 'agent.recovered')).toHaveLength(0);
    expect(await errorRecordStore.latestForAgent('dev-1')).toBeUndefined();
  });

  it('an inconclusive session re-probe (transport failure) leaves the binding, its task and the error log untouched', async () => {
    await seedBoundAgent();
    sessionSnapshotReply = () => ({ stderr: 'ssh: connect to host box: Connection timed out', exitCode: 255 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await manager.reconcileFailedAgent('dev-1')).toBe(false);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('session re-probe inconclusive'), expect.anything());
    expect(await agentStore.get('dev-1')).toMatchObject({ taskId: 'task-old', paneId: 'P-1' });
    expect((await taskStore.get('task-old'))?.status).toBe('in_progress');
    expect(await errorRecordStore.latestForAgent('dev-1')).toBeUndefined();
    warn.mockRestore();
  });

  it.each([
    ['claimed by another agent', '4242|1700000000|$1|other-agent\n'],
    ['unclaimed', '4242|1700000000|$1|\n'],
  ])('a same-name session %s is absent for this agent, exactly as the probe poller reads it: the binding is held and the task failed', async (_label, line) => {
    await seedBoundAgent();
    sessionSnapshotReply = () => ({ stdout: line });

    expect(await manager.reconcileFailedAgent('dev-1')).toBe(true);

    expect(await agentStore.get('dev-1')).toMatchObject({ taskId: 'task-old', status: 'awaiting_human', awaitingPhase: 'runtime-missing' });
    expect((await taskStore.get('task-old'))?.status).toBe('failed');
    expect(events.filter(e => e.type === 'agent.recovered')).toHaveLength(1);
    expect(await errorRecordStore.latestForAgent('dev-1')).toMatchObject({ reason: 'TMUX_SESSION_ABSENT' });
  });

  it('the re-probe runs under server.tmuxProbeTimeoutMs; a timeout is inconclusive and leaves the binding and its task untouched, and a later conclusive probe on the same lifecycle chain still reconciles', async () => {
    await seedBoundAgent();
    let seenTimeout: number | undefined;
    sessionSnapshotReply = (_command, options) => {
      seenTimeout = options?.timeout;
      throw new Error(`Command timed out after ${options?.timeout}ms`);
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await manager.reconcileFailedAgent('dev-1')).toBe(false);

    expect(seenTimeout).toBe(DEFAULT_TMUX_PROBE_TIMEOUT_MS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('session re-probe inconclusive'), expect.anything());
    expect(await agentStore.get('dev-1')).toMatchObject({ taskId: 'task-old', paneId: 'P-1' });
    expect((await taskStore.get('task-old'))?.status).toBe('in_progress');
    warn.mockRestore();

    sessionSnapshotReply = () => SESSION_ABSENT;
    expect(await manager.reconcileFailedAgent('dev-1')).toBe(true);
    expect(await agentStore.get('dev-1')).toMatchObject({ status: 'awaiting_human', awaitingPhase: 'runtime-missing' });
    expect((await taskStore.get('task-old'))?.status).toBe('failed');
  });

  it('holds the lifecycle chain across the commit: a lifecycle operation queued behind the reconcile sees the hold and the task failure already applied', async () => {
    await seedBoundAgent();
    const { release } = gateFirstTaskList();
    const reconcile = manager.reconcileFailedAgent('dev-1');
    await new Promise(resolve => setTimeout(resolve, 20));
    let observed: { binding: string | undefined; task: string | undefined } | undefined;
    onExecHook = async (command) => {
      if (!command.includes('tmux list-sessions') || observed) return;
      observed = {
        binding: (await agentStore.get('dev-1'))?.awaitingPhase,
        task: (await taskStore.get('task-old'))?.status,
      };
    };
    // DELETE 清理与 reconcile 共用同一条生命周期链;它的首条 tmux 探测就是排队后的观察点
    const cleanup = manager.cleanupRemovedAgentRuntime(['dev-1']);
    release();
    await reconcile;
    await cleanup;

    expect(observed).toEqual({ binding: 'runtime-missing', task: 'failed' });
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
