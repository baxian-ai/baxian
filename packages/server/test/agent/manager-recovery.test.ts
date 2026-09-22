import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentBindingFacts, BaxianConfig, BaxianEvent, TaskState } from '../../src/shared/index.js';
import { canDispatchWithBinding, type AgentManager } from '../../src/agent/manager.js';
import { PhaseSignalWatcher } from '../../src/agent/phase-signal-watcher.js';
import { buildPhaseSignal } from '../../src/agent/phase-signal.js';
import type { PaneStreamerManager } from '../../src/agent/pane-streamer-manager.js';
import type { SubscriberCallbacks } from '../../src/agent/pane-streamer.js';
import { TmuxManager } from '../../src/agent/tmux.js';
import { BranchManager } from '../../src/agent/branch.js';
import type { AgentStore } from '../../src/state/agent-store.js';
import type { TaskStore } from '../../src/state/task-store.js';
import type { LockManager } from '../../src/state/lock.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { registerEventHandlers } from '../../src/event/handlers.js';
import type { PhaseSignalWatcherStartArgs } from '../../src/agent/phase-signal-watcher.js';
import { createManagerHarness, createManagerSuiteRunner, workdirsOf } from '../helpers/manager-harness.js';
import type { FakeRunner, FakeRunnerOptions } from '../helpers/fake-runner.js';
import type { RepoStore } from '../../src/agent/repo-store.js';
import type { AgentManagerDeps } from '../../src/agent/manager.js';
import { makeConfig } from '../helpers/fixtures.js';

const NOW = '2026-05-14T05:00:00.000Z';
// detectStartupDialog 认得的启动遮挡帧:adopt 时分类为 startup-dialog → EnsureSessionError(dialogPending)
const STARTUP_DIALOG_SCREEN = 'Press enter to continue';

let tempDir: string;
let config: BaxianConfig;
let agentStore: AgentStore;
let taskStore: TaskStore;
let lockManager: LockManager;
let eventBus: EventBus;
let manager: AgentManager;
let runner: FakeRunner;
let workdirFailures: Map<string, string>;
let createManager: Awaited<ReturnType<typeof createManagerHarness>>['createManager'];
let seedAgent: Awaited<ReturnType<typeof createManagerHarness>>['seedAgent'];
let seedHarnessTask: Awaited<ReturnType<typeof createManagerHarness>>['seedTask'];
let events: BaxianEvent[];

// 每个 agent 的 Workdir 准备可单独注入失败:git 仓库边界替身(spec E4),不是私有访问
const repoStoreFactory: NonNullable<AgentManagerDeps['repoStoreFactory']> =
  (_runner, _repo, _mode, _host, _cache, agentId, workdir) => ({
    ensure: async () => {
      const failure = workdirFailures.get(agentId);
      if (failure) throw new Error(failure);
      return workdir ?? join(tempDir, agentId);
    },
    refresh: async () => undefined,
  }) as unknown as RepoStore;

// 换一台带不同布置的 live runner(启动对话框帧、命令失败规则…),manager 经公共依赖重建
function useRunner(options: FakeRunnerOptions): FakeRunner {
  runner = createManagerSuiteRunner({ workdirs: workdirsOf(config), ...options });
  manager = createManager({ runnerFactory: () => runner });
  return runner;
}

function seedRecoveryTask(overrides: Partial<TaskState> & { id: string }): Promise<TaskState> {
  return seedHarnessTask({
    ...overrides,
    ...(overrides.phase !== undefined && !Object.hasOwn(overrides, 'deliveryConfirmation')
      ? { deliveryConfirmation: { phase: overrides.phase, source: 'signal', at: NOW } }
      : {}),
  });
}

function postApproveEpisode(token: string, headSha: string): Partial<TaskState> {
  return {
    postApproveGeneration: 'feedfeedfeed',
    postApproveHeadSha: headSha,
    postApproveToken: token,
    postApprovePhase: 'installed',
  };
}

interface RecoveryScenario {
  agents: (Partial<AgentBindingFacts> & { id: string })[];
  tasks?: (Partial<TaskState> & { id: string })[];
  locks?: string[];
  emit?: BaxianEvent[];
  // 运行时布置:会话消失 / claim 被占 / 启动对话框 / Workdir 故障,都经 runner 或公共依赖注入
  before?: () => void | Promise<void>;
  cleanupImpl?: () => Promise<void>;
}

interface RecoveryHandles {
  cleanupSpy: MockInstance<BranchManager['cleanupTaskBranch']>;
  watchSpy: MockInstance<AgentManager['startRuntimeMenuWatch']>;
}

async function runRecovery(scenario: RecoveryScenario): Promise<RecoveryHandles> {
  for (const agent of scenario.agents) await seedAgent(agent);
  for (const task of scenario.tasks ?? []) await seedRecoveryTask(task);
  for (const event of scenario.emit ?? []) await eventBus.emit(event);
  for (const id of scenario.locks ?? []) await acquireBoundLock(id);
  await scenario.before?.();

  const cleanupSpy = vi.spyOn(BranchManager.prototype, 'cleanupTaskBranch')
    .mockImplementation(async () => {
      await scenario.cleanupImpl?.();
      return { status: 'deleted' };
    });
  const watchSpy = vi.spyOn(manager, 'startRuntimeMenuWatch');

  await manager.recover();
  return { cleanupSpy, watchSpy };
}

async function expectRolledBack(taskId: string, agentId: string): Promise<void> {
  expect((await taskStore.get(taskId))?.status).toBe('pending');
  expect((await agentStore.get(agentId))?.taskId).toBeUndefined();
  expect(await lockManager.isLocked(agentId)).toBe(false);
}

async function acquireBoundLock(agentId: string, taskId?: string): Promise<string | null> {
  const binding = await agentStore.get(agentId);
  const owner = taskId ?? binding?.taskId ?? 'task-1';
  const existing = await lockManager.claimOf(agentId);
  if (existing?.taskId === owner) return existing.token;
  return lockManager.acquire(agentId, owner);
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-recovery-'));
  config = makeConfig({
    project: [{
      ...makeConfig().project[0]!,
      merge: 'auto',
    }],
  });
  workdirFailures = new Map();
  runner = createManagerSuiteRunner({ workdirs: workdirsOf(config) });
  const harness = await createManagerHarness(tempDir, {
    config,
    taskDefaults: {
      branchCreatedByBaxian: undefined,
      createdAt: NOW,
      updatedAt: NOW,
    },
    lockSeededAgents: true,
    deps: {
      runnerFactory: () => runner,
      repoStoreFactory,
      // live runtime 下 recover 真的等 idle/ack,节拍压到毫秒级
      compactIdlePollMs: 1,
      readyStableSpacingMs: 1,
      runtimeLivenessProbeMs: 1,
      cleanComposerWaitMs: 50,
      bootstrapTimeoutsMs: { trustDialog: 300, waitReplReady: 1_000 },
    },
  });
  // git 仓库边界(spec E4):分支切换/清理由 branch.test.ts 覆盖
  vi.spyOn(BranchManager.prototype, 'assertClean').mockResolvedValue(undefined);
  vi.spyOn(BranchManager.prototype, 'switchToTaskBranch').mockResolvedValue(undefined);
  vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue(undefined);
  vi.spyOn(BranchManager.prototype, 'cleanupTaskBranch').mockResolvedValue({ status: 'deleted' });
  vi.spyOn(BranchManager.prototype, 'currentRef').mockImplementation(async workdir => {
    const binding = (await harness.agentStore.list()).find(state => state.workdir === workdir && state.taskId);
    const boundTask = binding?.taskId ? await harness.taskStore.get(binding.taskId) : null;
    return boundTask?.branch ? `refs/heads/${boundTask.branch}` : null;
  });
  ({
    manager,
    createManager,
    agentStore,
    taskStore,
    lockManager,
    eventBus,
    seedAgent,
    seedTask: seedHarnessTask,
    events,
  } = harness);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

describe('recover()', () => {
  it.each([false, true])('uses delivery evidence rather than treating an unknown event type as harmless absence: delivered=%s', async (delivered) => {
    const date = new Date().toISOString().slice(0, 10);
    await seedAgent({ id: 'dev-1', taskId: 'task-1', bootstrappingTaskId: 'task-1', paneId: '%0' });
    await seedRecoveryTask({ id: 'task-1' });
    const event = {
      id: 'unknown', type: 'session.startd', timestamp: `${date}T00:00:00Z`,
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1', data: { phase: 'develop' },
    };
    await writeFile(join(tempDir, 'events', `${date}.jsonl`), `${JSON.stringify(event)}\n`);
    if (delivered) await eventBus.emit({ ...event, id: 'delivered', type: 'session.started' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { cleanupSpy } = await runRecovery({ agents: [] });
    expect(cleanupSpy).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.status).toBe('in_progress');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    const state = await agentStore.get('dev-1');
    if (delivered) {
      expect(state?.bootstrappingTaskId).toBeUndefined();
      expect(state?.status).not.toBe('awaiting_human');
    } else {
      expect(state).toMatchObject({ bootstrappingTaskId: 'task-1', awaitingPhase: 'recovery-failed' });
    }
  });

  it('preserves a confirmed delivery even when another event line is truncated', async () => {
    const date = new Date().toISOString().slice(0, 10);
    await seedAgent({ id: 'dev-1', taskId: 'task-1', bootstrappingTaskId: 'task-1', paneId: '%0' });
    await seedRecoveryTask({ id: 'task-1' });
    await eventBus.emit({
      id: 'delivered', type: 'session.started', timestamp: `${date}T00:00:00Z`,
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1', data: { phase: 'develop' },
    });
    await appendFile(join(tempDir, 'events', `${date}.jsonl`), '{"id":');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { cleanupSpy } = await runRecovery({ agents: [] });

    expect(cleanupSpy).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.status).toBe('in_progress');
    expect(await agentStore.get('dev-1')).toMatchObject({ taskId: 'task-1' });
    expect((await agentStore.get('dev-1'))?.bootstrappingTaskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it.each(['develop', 'code'] as const)(
    'holds a %s bootstrap when damaged history cannot prove whether it was delivered', async (phase) => {
      const date = new Date().toISOString().slice(0, 10);
      await seedAgent({ id: 'dev-1', taskId: 'task-1', bootstrappingTaskId: 'task-1', paneId: '%0' });
      await seedRecoveryTask({ id: 'task-1', ...(phase === 'code' ? { specReviewRound: 1 } : {}) });
      await writeFile(join(tempDir, 'events', `${date}.jsonl`), '{"id":');
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { cleanupSpy, watchSpy } = await runRecovery({ agents: [] });

      expect(cleanupSpy).not.toHaveBeenCalled();
      expect(watchSpy).not.toHaveBeenCalled();
      expect((await taskStore.get('task-1'))?.status).toBe('in_progress');
      expect(await agentStore.get('dev-1')).toMatchObject({
        taskId: 'task-1', bootstrappingTaskId: 'task-1',
        status: 'awaiting_human', awaitingPhase: 'recovery-failed',
      });
      expect(await lockManager.isLocked('dev-1')).toBe(true);
      const held = await agentStore.get('dev-1');
      const readHistory = vi.spyOn(eventBus, 'readRangeWithStatus');
      const pastedBefore = runner.pastedPrompts.length;
      await expect(manager.resumeAgent('dev-1')).resolves.toEqual({ resumed: true, releasedBinding: false });
      expect(readHistory).not.toHaveBeenCalled();
      // Resume 只清标记,不补派提示词
      expect(runner.pastedPrompts).toHaveLength(pastedBefore);
      expect((await taskStore.get('task-1'))?.status).toBe('in_progress');
      expect(await agentStore.get('dev-1')).toMatchObject({ taskId: 'task-1', lockToken: held?.lockToken });
      expect((await agentStore.get('dev-1'))?.status).not.toBe('awaiting_human');
      expect((await agentStore.get('dev-1'))?.bootstrappingTaskId).toBeUndefined();
      expect(await lockManager.isLocked('dev-1')).toBe(true);
    },
  );

  it('preserves the task and binding on an event log read failure', async () => {
    const date = new Date().toISOString().slice(0, 10);
    await seedAgent({ id: 'dev-1', taskId: 'task-1', bootstrappingTaskId: 'task-1', paneId: '%0' });
    await seedRecoveryTask({ id: 'task-1' });
    await mkdir(join(tempDir, 'events', `${date}.jsonl`));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { cleanupSpy } = await runRecovery({ agents: [] });

    expect(cleanupSpy).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.status).toBe('in_progress');
    expect((await agentStore.get('dev-1'))?.bootstrappingTaskId).toBe('task-1');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('reclaims orphaned maintenance and task locks but preserves an exactly bound task lock', async () => {
    const maintenanceToken = await lockManager.acquire('dev-1', 'maintenance:branch-reconcile');
    const orphanedTaskToken = await lockManager.acquire('orphan-1', 'task-orphaned');
    await seedRecoveryTask({ id: 'task-live', status: 'review', qaAgentId: 'qa-1' });
    await seedAgent({ id: 'qa-1', taskId: 'task-live' });
    const boundTaskToken = (await agentStore.get('qa-1'))?.lockToken;

    await manager.recover();

    expect(await lockManager.isOwner('dev-1', 'maintenance:branch-reconcile', maintenanceToken!)).toBe(false);
    expect(await lockManager.isOwner('orphan-1', 'task-orphaned', orphanedTaskToken!)).toBe(false);
    expect(await lockManager.isOwner('qa-1', 'task-live', boundTaskToken!)).toBe(true);
  });

  it('holds a bound agent without touching tmux when exclusive lock ownership is stale', async () => {
    await seedAgent({ id: 'dev-1', taskId: 'task-stale-lock', paneId: '%1' });
    await seedRecoveryTask({ id: 'task-stale-lock' });
    const before = (await agentStore.get('dev-1'))!;
    await lockManager.releaseIfOwner('dev-1', 'task-stale-lock', before.lockToken!);

    await manager.recover();

    // 没碰 tmux:runner 轨迹里这个 agent 一条命令都没有
    expect(runner.exec.mock.calls.some(c => String(c[0]).includes('dev-1'))).toBe(false);
    expect(await agentStore.get('dev-1')).toMatchObject({
      taskId: 'task-stale-lock',
      status: 'awaiting_human',
      awaitingPhase: 'recovery-lock-invalid',
    });
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('revalidates persisted bindings and clears creationToken on success', async () => {
    const { watchSpy } = await runRecovery({
      agents: [{ id: 'dev-1', taskId: 'task-1', creationToken: 'tok' }],
      tasks: [{ id: 'task-1' }],
    });

    const state = await agentStore.get('dev-1');
    expect(state?.paneId).toBe('%0');
    expect(state?.creationToken).toBeUndefined();
    expect(state?.taskId).toBe('task-1');
    expect(watchSpy).toHaveBeenCalledWith('dev-1');
  });

  it('releases a recovered merged-task binding directly, onto the refreshed pane', async () => {
    // 存的是上一代 pane;recover 必须先把探到的真实 pane 落盘,再走释放
    await seedAgent({ id: 'dev-1', taskId: 'task-merged', paneId: '%stale' });
    await seedRecoveryTask({ id: 'task-merged', prNumber: 42, reviewRound: 1, status: 'merged' });

    await manager.recover();

    const state = await agentStore.get('dev-1');
    expect(state?.paneId).toBe('%0');
    expect(state?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
    expect(canDispatchWithBinding(state)).toBe(true);
  });

  it('releases a recovered done-task binding (terminal without pr)', async () => {
    await seedAgent({ id: 'dev-1', taskId: 'task-done', paneId: '%0' });
    await seedRecoveryTask({ id: 'task-done', status: 'done' });

    await manager.recover();

    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(canDispatchWithBinding(state)).toBe(true);
  });

  it('releases a recovered merged QA binding without a PR (branch merge)', async () => {
    await seedAgent({ id: 'qa-1', taskId: 'task-branch-merged', paneId: '%0' });
    await seedRecoveryTask({
      id: 'task-branch-merged', status: 'merged',
      preferredAgentId: 'dev-1', agentId: 'dev-1', qaAgentId: 'qa-1',
    });

    await manager.recover();

    const state = await agentStore.get('qa-1');
    expect(state?.taskId).toBeUndefined();
    expect(canDispatchWithBinding(state)).toBe(true);
  });

  it('releases a recovered cancelled-task binding', async () => {
    await runRecovery({
      agents: [{ id: 'dev-1', taskId: 'task-gone', paneId: '%0' }],
      tasks: [{ id: 'task-gone', status: 'cancelled' }],
    });

    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('preserves Held state (status=awaiting_human + awaitingPhase/Reason/Since) when recovering an ack_unknown agent with active bound task', async () => {
    await runRecovery({
      agents: [{
        id: 'qa-1', taskId: 'task-active', paneId: '%0', status: 'awaiting_human',
        awaitingPhase: 'dispatch-failed:ack_unknown', awaitingReason: 'simulated ack_unknown', awaitingSince: NOW,
      }],
      tasks: [{ id: 'task-active', qaAgentId: 'qa-1', reviewRound: 1, status: 'review' }],
      locks: ['qa-1'],
    });

    const state = await agentStore.get('qa-1');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('dispatch-failed:ack_unknown');
    expect(state?.awaitingReason).toBe('simulated ack_unknown');
    expect(state?.awaitingSince).toBe(NOW);
    expect(state?.taskId).toBe('task-active');
    expect(state?.paneId).toBe('%1');
    expect(await lockManager.isLocked('qa-1')).toBe(true);
  });

  it('preserves Held state for agent_dialog_pending + active bound task (crash window before task fail)', async () => {
    await runRecovery({
      agents: [{
        id: 'dev-1', taskId: 'task-active', paneId: '%0', status: 'awaiting_human',
        awaitingPhase: 'agent_dialog_pending', awaitingReason: 'CLI update notice', awaitingSince: NOW,
      }],
      tasks: [{ id: 'task-active' }],
      locks: ['dev-1'],
    });

    const state = await agentStore.get('dev-1');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('agent_dialog_pending');
    expect(state?.awaitingReason).toBe('CLI update notice');
    expect(state?.taskId).toBe('task-active');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('clears Held state (status=ok) when recovering an agent_dialog_pending agent (recover dismissed the dialog)', async () => {
    await runRecovery({
      agents: [{
        id: 'dev-1', paneId: '%0', status: 'awaiting_human',
        awaitingPhase: 'agent_dialog_pending', awaitingReason: 'CLI update notice', awaitingSince: NOW,
      }],
    });

    const state = await agentStore.get('dev-1');
    expect(state?.status).toBeUndefined();
    expect(state?.awaitingPhase).toBeUndefined();
    expect(state?.awaitingReason).toBeUndefined();
    expect(state?.awaitingSince).toBeUndefined();
  });

  it('rolls back a mid-bootstrap develop task even when recovery rebuilds a fresh REPL (marker set)', async () => {
    const { watchSpy } = await runRecovery({
      agents: [{ id: 'dev-1', taskId: 'task-1', startedAt: NOW, bootstrappingTaskId: 'task-1' }],
      tasks: [{ id: 'task-1' }],
      locks: ['dev-1'],
      // 会话没了:recover 重建会话并重新起 REPL(createdSession + freshRuntime)
      before: () => runner.sessions.drop('dev-1'),
    });

    await expectRolledBack('task-1', 'dev-1');
    expect(runner.sessions.pane('dev-1')?.process).toBe('claude');
    expect((await taskStore.get('task-1'))?.agentId).toBe('');
    expect(watchSpy).not.toHaveBeenCalled();
  });

  it('releases a pending bootstrap binding when the next recovery succeeds', async () => {
    await seedAgent({
      id: 'dev-1', taskId: 'task-pending', bootstrappingTaskId: 'task-pending', paneId: '%0',
    });
    await seedRecoveryTask({ id: 'task-pending', status: 'pending' });
    await acquireBoundLock('dev-1');
    workdirFailures.set('dev-1', 'git fetch failed: transient network error');

    await manager.recover();
    expect(await agentStore.get('dev-1')).toMatchObject({
      taskId: 'task-pending',
      status: 'awaiting_human',
      awaitingPhase: 'recovery-failed',
    });
    expect((await taskStore.get('task-pending'))?.attention).toMatchObject({ reason: 'recovery-failed' });

    workdirFailures.delete('dev-1');
    const watchSpy = vi.spyOn(manager, 'startRuntimeMenuWatch');
    await manager.recover();

    expect((await taskStore.get('task-pending'))?.status).toBe('pending');
    expect((await taskStore.get('task-pending'))?.attention).toBeUndefined();
    expect(await agentStore.get('dev-1')).toMatchObject({ id: 'dev-1' });
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await agentStore.get('dev-1'))?.bootstrappingTaskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
    expect(watchSpy).not.toHaveBeenCalled();
  });

  it('does not roll back a delivered fixed-Workdir task whose REPL was lost', async () => {
    const { cleanupSpy, watchSpy } = await runRecovery({
      agents: [{
        id: 'dev-1', taskId: 'task-1', startedAt: NOW,
        workdir: '/tmp/repo',
      }],
      tasks: [{ id: 'task-1' }],
      locks: ['dev-1'],
      // 会话没了:recover 重建会话并重新起 REPL
      before: () => runner.sessions.drop('dev-1'),
    });

    expect(cleanupSpy).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.status).toBe('in_progress');
    expect((await agentStore.get('dev-1'))?.taskId).toBe('task-1');
    expect((await agentStore.get('dev-1'))?.workdir).toBe('/tmp/repo');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    expect(watchSpy).toHaveBeenCalledWith('dev-1');
  });

  it('rolls back an in_progress develop task whose live REPL is mid-bootstrap (bootstrappingTaskId set, never ack\'d)', async () => {
    const { watchSpy } = await runRecovery({
      agents: [{ id: 'dev-1', taskId: 'task-1', startedAt: NOW, paneId: '%0', bootstrappingTaskId: 'task-1' }],
      tasks: [{ id: 'task-1' }],
      locks: ['dev-1'],
    });

    await expectRolledBack('task-1', 'dev-1');
    expect(watchSpy).not.toHaveBeenCalled();
  });

  it('holds an interrupted code handoff for an explicit Resume instead of rolling it back', async () => {
    await runRecovery({
      agents: [{ id: 'dev-1', taskId: 'task-code', bootstrappingTaskId: 'task-code' }],
      tasks: [{ id: 'task-code', phase: 'code', specReviewRound: 1 }],
    });

    expect(await taskStore.get('task-code')).toMatchObject({
      status: 'in_progress',
      agentId: 'dev-1',
      phase: 'code',
    });
    expect(await agentStore.get('dev-1')).toMatchObject({
      taskId: 'task-code',
      status: 'awaiting_human',
      awaitingPhase: 'code-dispatch-failed',
      awaitingReason: expect.stringContaining('Code-phase handoff was interrupted'),
    });
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('clears a Dev bootstrap marker left behind at the spec-ready gate', async () => {
    await runRecovery({
      agents: [{
        id: 'dev-1',
        taskId: 'task-spec-ready',
        bootstrappingTaskId: 'task-spec-ready',
        workdir: '/tmp/repo',
      }],
      tasks: [{
        id: 'task-spec-ready',
        preferredAgentId: 'dev-1',
        agentId: 'dev-1',
        devAgentId: 'dev-1',
        phase: 'spec',
        status: 'spec-ready',
      }],
    });

    expect(await taskStore.get('task-spec-ready')).toMatchObject({
      status: 'spec-ready',
      agentId: 'dev-1',
      devAgentId: 'dev-1',
    });
    expect(await agentStore.get('dev-1')).toMatchObject({ workdir: '/tmp/repo', taskId: 'task-spec-ready' });
    expect((await agentStore.get('dev-1'))?.bootstrappingTaskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it.each(['spec-ready', 'max_rounds'] as const)(
    'releases a QA binding stranded after the %s verdict gate was persisted',
    async (status) => {
      await runRecovery({
        agents: [{
          id: 'qa-1',
          taskId: 'task-verdict-gate',
        }],
        tasks: [{
          id: 'task-verdict-gate',
          phase: 'spec',
          status,
        }],
      });

      expect(await taskStore.get('task-verdict-gate')).toMatchObject({
        status,
        qaAgentId: 'qa-1',
      });
      expect((await agentStore.get('qa-1'))?.taskId).toBeUndefined();
      expect(await lockManager.isLocked('qa-1')).toBe(false);
    },
  );

  it('rolls back a mid-bootstrap task without deleting the fixed Workdir', async () => {
    const { cleanupSpy } = await runRecovery({
      agents: [{
        id: 'dev-1', taskId: 'task-1', startedAt: NOW, paneId: '%0',
        bootstrappingTaskId: 'task-1', workdir: '/tmp/repo',
      }],
      tasks: [{ id: 'task-1' }],
      locks: ['dev-1'],
    });

    expect(cleanupSpy).not.toHaveBeenCalled();
    await expectRolledBack('task-1', 'dev-1');
  });

  it('does not roll back a delivered in_progress binding on a live REPL', async () => {
    const { cleanupSpy, watchSpy } = await runRecovery({
      agents: [{
        id: 'dev-1', taskId: 'task-1', startedAt: NOW, paneId: '%0',
        workdir: '/tmp/repo',
      }],
      tasks: [{ id: 'task-1' }],
      locks: ['dev-1'],
    });

    expect(cleanupSpy).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.status).toBe('in_progress');
    expect((await taskStore.get('task-1'))?.agentId).toBe('dev-1');
    expect((await agentStore.get('dev-1'))?.taskId).toBe('task-1');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    expect(watchSpy).toHaveBeenCalledWith('dev-1');
  });

  it('rolls back a mid-bootstrap task that comes back blocked on a startup dialog (not held forever)', async () => {
    const { cleanupSpy } = await runRecovery({
      agents: [{
        id: 'dev-1', taskId: 'task-1', startedAt: NOW, paneId: '%0',
        bootstrappingTaskId: 'task-1', workdir: '/tmp/repo',
      }],
      tasks: [{ id: 'task-1' }],
      locks: ['dev-1'],
      // REPL 卡在启动遮挡上:adopt 判 startup-dialog
      before: () => { useRunner({ agents: { 'dev-1': { screen: STARTUP_DIALOG_SCREEN } } }); },
    });

    // 回滚优先于停驻:没有写下 agent_dialog_pending
    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBeUndefined();
    expect((await agentStore.get('dev-1'))?.status).toBeUndefined();
    expect(cleanupSpy).not.toHaveBeenCalled();
    await expectRolledBack('task-1', 'dev-1');
  });

  it('rolls back a mid-bootstrap task previously held on a dialog once its REPL recovers (marker still set)', async () => {
    await runRecovery({
      agents: [{
        id: 'dev-1', taskId: 'task-1', startedAt: NOW, paneId: '%0',
        bootstrappingTaskId: 'task-1', status: 'awaiting_human', awaitingPhase: 'agent_dialog_pending',
        awaitingReason: 'CLI update notice', awaitingSince: NOW,
      }],
      tasks: [{ id: 'task-1' }],
      locks: ['dev-1'],
    });

    await expectRolledBack('task-1', 'dev-1');
    const rolled = await agentStore.get('dev-1');
    expect(rolled?.status).toBeUndefined();
    expect(rolled?.awaitingPhase).toBeUndefined();
    expect(canDispatchWithBinding(rolled)).toBe(true);
  });

  it('does NOT roll back a mid-bootstrap task when a session.started event proves delivery (stale marker)', async () => {
    const { cleanupSpy, watchSpy } = await runRecovery({
      agents: [{
        id: 'dev-1', taskId: 'task-1', startedAt: NOW, paneId: '%0',
        bootstrappingTaskId: 'task-1', workdir: '/tmp/repo',
      }],
      tasks: [{ id: 'task-1' }],
      emit: [{
        id: '', type: 'session.started', timestamp: new Date().toISOString(),
        projectId: 'proj', agentId: 'dev-1', taskId: 'task-1', data: { phase: 'develop' },
      }],
      locks: ['dev-1'],
    });

    expect(cleanupSpy).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.status).toBe('in_progress');
    const reattached = await agentStore.get('dev-1');
    expect(reattached?.taskId).toBe('task-1');
    expect(reattached?.bootstrappingTaskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    expect(watchSpy).toHaveBeenCalledWith('dev-1');
  });

  it('does NOT roll back a develop pass replayed by a takeover restart (marker finalized before recover)', async () => {
    await seedAgent({
      id: 'dev-1', taskId: 'task-1', startedAt: NOW, paneId: '%0',
      bootstrappingTaskId: 'task-1', workdir: '/tmp/repo',
    });
    await seedRecoveryTask({ id: 'task-1', signalToken: 'replay-tok-1' });
    await acquireBoundLock('dev-1');

    await expect(manager.redispatchTaskPromptAfterReplRestart('dev-1', 'task-1')).resolves.toBe(true);
    const replayed = await taskStore.get('task-1');
    expect(runner.pastedPrompts).toEqual([
      { pane: '%0', body: expect.stringContaining(`token: ${replayed!.signalToken!}`) },
    ]);
    expect(runner.pastedPrompts[0]!.body).toContain('phase: develop');

    const { cleanupSpy } = await runRecovery({ agents: [], tasks: [] });

    expect(cleanupSpy).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.status).toBe('in_progress');
    expect((await agentStore.get('dev-1'))?.taskId).toBe('task-1');
    expect((await agentStore.get('dev-1'))?.bootstrappingTaskId).toBeUndefined();
  });

  it('does NOT roll back a delivered task held on a failed marker-clear (bootstrap-marker-clear-failed)', async () => {
    const { cleanupSpy } = await runRecovery({
      agents: [{
        id: 'dev-1', taskId: 'task-1', startedAt: NOW, paneId: '%0',
        bootstrappingTaskId: 'task-1', status: 'awaiting_human', awaitingPhase: 'bootstrap-marker-clear-failed',
        awaitingReason: 'clear failed', awaitingSince: NOW,
        workdir: '/tmp/repo',
      }],
      tasks: [{ id: 'task-1' }],
      locks: ['dev-1'],
    });

    expect(cleanupSpy).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.status).toBe('in_progress');
    expect((await agentStore.get('dev-1'))?.taskId).toBe('task-1');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it.each([
    { phase: undefined, hold: 'dispatch-failed:ack_unknown', freshRuntime: false },
    { phase: 'code', hold: 'dispatch-failed:ack_unknown', freshRuntime: false },
    { phase: undefined, hold: 'dispatch-failed:ack_unknown', freshRuntime: true },
    { phase: 'code', hold: 'dispatch-failed:ack_unknown', freshRuntime: true },
    { phase: undefined, hold: 'dev-wait-gate-failed-after-qa-started', freshRuntime: false },
    { phase: 'code', hold: 'dev-wait-gate-failed-after-qa-started', freshRuntime: false },
  ] as const)('preserves an uncertain bootstrap across process recovery: $phase / $hold / fresh=$freshRuntime', async ({ phase, hold, freshRuntime }) => {
    const task = await seedRecoveryTask({
      id: 'task-uncertain-bootstrap', phase, signalToken: 'uncertain-token',
      ...(phase === 'code' ? { specReviewRound: 1 } : {}),
    });
    await seedAgent({
      id: 'dev-1', taskId: task.id, paneId: '%0', bootstrappingTaskId: task.id,
      status: 'awaiting_human', awaitingPhase: hold, awaitingReason: 'Enter sent; acknowledgement unavailable',
      awaitingSince: NOW, awaitingNonce: 'uncertain-hold',
    });
    const held = await agentStore.get('dev-1');
    if (freshRuntime) runner.sessions.drop('dev-1');

    for (let restart = 0; restart < 2; restart += 1) {
      manager = createManager();
      await manager.recover();

      expect(await taskStore.get(task.id)).toEqual(task);
      expect(await agentStore.get('dev-1')).toMatchObject({
        taskId: task.id, bootstrappingTaskId: task.id, lockToken: held?.lockToken,
        status: 'awaiting_human', awaitingPhase: hold, awaitingReason: held?.awaitingReason,
        awaitingSince: NOW, awaitingNonce: 'uncertain-hold',
      });
      expect(await lockManager.isLocked('dev-1')).toBe(true);
      await expect(manager.resumeAgent('dev-1')).resolves.toMatchObject({ resumed: false });
      await expect(manager.advanceTask(task.id)).rejects.toMatchObject({ status: 409 });
      await expect(manager.redispatchTaskPromptAfterReplRestart('dev-1', task.id)).resolves.toBe(true);
    }
    expect(runner.pastedPrompts).toEqual([]);
    expect(events.filter(event => event.type === 'session.started')).toEqual([]);
  });

  it('clears unsafe runtime facts but preserves the binding lock when recovery cannot validate the session', async () => {
    await runRecovery({
      agents: [{ id: 'dev-1', taskId: 'task-1', paneId: '%0', creationToken: 'tok' }],
      tasks: [{ id: 'task-1' }],
      locks: ['dev-1'],
      // 会话被别人认领:recover 拒绝接管外来会话
      before: () => runner.sessions.reclaim('dev-1', 'someone-else'),
    });

    const state = await agentStore.get('dev-1');
    expect(state?.awaitingReason).toContain('claim mismatch');
    expect(state?.paneId).toBeUndefined();
    expect(state?.creationToken).toBeUndefined();
    expect(state).toMatchObject({
      taskId: 'task-1',
      status: 'awaiting_human',
      awaitingPhase: 'recovery-failed',
    });
    expect((await taskStore.get('task-1'))?.status).toBe('in_progress');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    expect(events.some(e => e.type === 'human.intervention' && e.agentId === 'dev-1')).toBe(true);
  });

  it('keeps the task and partner alive with actionable attention when recovery fails', async () => {
    await seedAgent({ id: 'dev-1', taskId: 'task-1', paneId: '%0', startedAt: NOW });
    await seedAgent({ id: 'qa-1', taskId: 'task-1', paneId: '%2', startedAt: NOW });
    await seedRecoveryTask({ id: 'task-1', status: 'review', reviewRound: 1 });
    workdirFailures.set('dev-1', "git fetch failed: cannot lock ref 'refs/remotes/origin/HEAD'");

    await manager.recover();

    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('review');
    expect(task?.attention).toMatchObject({
      reason: 'recovery-failed',
      recommendedActions: ['verdict', 'cancel'],
    });
    expect(task?.attention?.runbook).toMatch(/Resume/);
    expect(await agentStore.get('dev-1')).toMatchObject({
      taskId: 'task-1',
      status: 'awaiting_human',
      awaitingPhase: 'recovery-failed',
    });
    expect((await agentStore.get('qa-1'))?.taskId).toBe('task-1');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    expect(await lockManager.isLocked('qa-1')).toBe(true);
    expect(events.some(e => e.type === 'task.updated'
      && (e.data as { status?: string }).status === 'failed')).toBe(false);
  });

  it('keeps shared attention until every recovery-failed participant is resumed', async () => {
    registerEventHandlers(eventBus, manager);
    await seedAgent({ id: 'dev-1', taskId: 'task-1', paneId: '%0', startedAt: NOW });
    await seedAgent({ id: 'qa-1', taskId: 'task-1', paneId: '%2', startedAt: NOW });
    await seedRecoveryTask({ id: 'task-1', status: 'review', reviewRound: 1 });
    workdirFailures.set('dev-1', 'git fetch failed: transient network error');
    workdirFailures.set('qa-1', 'git fetch failed: transient network error');

    await manager.recover();

    expect((await taskStore.get('task-1'))?.attention).toMatchObject({
      reason: 'recovery-failed',
      recommendedActions: expect.arrayContaining(['advance']),
    });
    await manager.resumeAgent('dev-1');
    expect((await taskStore.get('task-1'))?.attention).toMatchObject({ reason: 'recovery-failed' });
    await manager.resumeAgent('qa-1');
    expect((await taskStore.get('task-1'))?.attention).toBeUndefined();
  });

  it('releases a failed pending bootstrap on Resume so Advance can dispatch it again', async () => {
    registerEventHandlers(eventBus, manager);
    await seedAgent({
      id: 'dev-1', taskId: 'task-pending', paneId: '%0', startedAt: NOW,
      bootstrappingTaskId: 'task-pending',
    });
    await seedRecoveryTask({ id: 'task-pending', status: 'pending' });
    workdirFailures.set('dev-1', 'git fetch failed: transient network error');

    await manager.recover();

    expect(await agentStore.get('dev-1')).toMatchObject({
      taskId: 'task-pending',
      status: 'awaiting_human',
      awaitingPhase: 'recovery-failed',
    });
    expect((await taskStore.get('task-pending'))?.attention?.recommendedActions).toContain('advance');

    await expect(manager.resumeAgent('dev-1')).resolves.toMatchObject({
      resumed: true,
      releasedBinding: true,
    });
    expect(canDispatchWithBinding(await agentStore.get('dev-1'))).toBe(true);
    expect((await taskStore.get('task-pending'))?.attention).toBeUndefined();

    workdirFailures.delete('dev-1');
    const advanced = await manager.advanceTask('task-pending');
    expect(advanced.status).toBe('in_progress');
    expect(advanced.agentId).toBe('dev-1');
    expect(runner.pastedPrompts).toEqual([{ pane: '%0', body: expect.stringContaining('task-pending') }]);
  });

  it('does not attach recovery actions to a terminal task', async () => {
    await seedAgent({ id: 'dev-1', taskId: 'task-done', paneId: '%0', startedAt: NOW });
    await seedRecoveryTask({ id: 'task-done', status: 'done' });
    workdirFailures.set('dev-1', 'git fetch failed: transient network error');

    await manager.recover();

    await manager.recordTaskAttention({
      id: '', type: 'human.intervention', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-done',
      data: { phase: 'recovery-failed', note: 'should stay agent-scoped' },
    });

    expect((await taskStore.get('task-done'))?.attention).toBeUndefined();
    expect(await agentStore.get('dev-1')).toMatchObject({
      taskId: 'task-done',
      status: 'awaiting_human',
      awaitingPhase: 'recovery-failed',
    });
    const intervention = events.find(e => e.type === 'human.intervention'
      && e.agentId === 'dev-1'
      && (e.data as { phase?: string }).phase === 'recovery-failed');
    expect(intervention?.taskId).toBeUndefined();
  });

  it('does not tell an unbound failed agent to Resume', async () => {
    await seedAgent({ id: 'dev-1', paneId: '%0' });
    workdirFailures.set('dev-1', 'git fetch failed: transient network error');

    await manager.recover();

    const intervention = events.find(e => e.type === 'human.intervention'
      && e.agentId === 'dev-1'
      && (e.data as { phase?: string }).phase === 'recovery-failed');
    expect(intervention?.taskId).toBeUndefined();
    expect((intervention?.data as { note?: string }).note).toMatch(/Inspect or recreate/);
    expect((intervention?.data as { note?: string }).note).not.toMatch(/Resume/);
    expect((await agentStore.get('dev-1'))?.status).not.toBe('awaiting_human');
  });

  it('lets Advance replay an active Dev task after the recovery hold is resumed', async () => {
    registerEventHandlers(eventBus, manager);
    await seedAgent({ id: 'dev-1', taskId: 'task-1', paneId: '%0', startedAt: NOW });
    await seedRecoveryTask({ id: 'task-1' });
    workdirFailures.set('dev-1', 'git fetch failed: transient network error');
    await manager.recover();

    await expect(manager.resumeAgent('dev-1')).resolves.toMatchObject({ resumed: true });
    const replay = vi.spyOn(manager, 'redispatchTaskPromptAfterReplRestart').mockResolvedValue(true);
    const advanced = await manager.advanceTask('task-1');

    expect(replay).toHaveBeenCalledWith('dev-1', 'task-1');
    expect(advanced.status).toBe('in_progress');
  });
});

describe('setupRecoveredPostApproveSignals()', () => {
  function snapshotPaneStreamerManager(snapshot: string): PaneStreamerManager {
    const streamer = {
      subscribeAtomic: vi.fn(async (_cbs: SubscriberCallbacks) => ({
        snapshot: { data: snapshot },
        unsubscribe: vi.fn(),
      })),
    };
    return { ensure: vi.fn(() => streamer) } as unknown as PaneStreamerManager;
  }

  async function waitForTaskStatus(taskId: string, status: TaskState['status']): Promise<void> {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if ((await taskStore.get(taskId))?.status === status) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  it('sets up approved tasks with stored completion records', async () => {
    await seedRecoveryTask({
      id: 'task-approved', reviewRound: 1, status: 'approved',
      ...postApproveEpisode('tok', 'a'.repeat(40)),
    });
    const watcher = {
      start: vi.fn(async (_args: PhaseSignalWatcherStartArgs) => true),
      stop: vi.fn(),
    };
    manager = createManager({
      eventBus: new EventBus(new EventLog(join(tempDir, 'events-2'))),
      phaseSignalWatcher: watcher as never,
    });

    await manager.setupRecoveredPostApproveSignals();

    expect(watcher.start).toHaveBeenCalledWith({
      taskId: 'task-approved',
      projectId: 'proj',
      agentId: 'dev-1',
      expectedKinds: 'pr-merge-ready',
      token: 'tok',
      recovered: true,
      needInputInherit: true,
    });
  });

  it('reports an approved git task whose persisted post-approve episode is incomplete', async () => {
    await seedRecoveryTask({
      id: 'task-approved-incomplete', reviewRound: 1, status: 'approved',
    });

    await manager.setupRecoveredPostApproveSignals();

    expect(events.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'post-approve-recovery-incomplete-episode',
    });
  });

  it('replays a recovered pr-merge-ready snapshot for manual-merge projects', async () => {
    const token = 'posttok12345';
    await seedRecoveryTask({
      id: 'task-approved-manual', reviewRound: 1, status: 'approved',
      ...postApproveEpisode(token, 'b'.repeat(40)),
    });
    await seedAgent({ id: 'dev-1', taskId: 'task-approved-manual', paneId: '%1' });

    const manualConfig = makeConfig({
      ...config,
      project: config.project.map(p => ({ ...p, merge: null })),
    });
    const eventsDir = join(tempDir, 'events-post-approve-manual');
    await mkdir(eventsDir, { recursive: true });
    const localBus = new EventBus(new EventLog(eventsDir));
    const watcher = new PhaseSignalWatcher({
      paneStreamerManager: snapshotPaneStreamerManager(`done\n${buildPhaseSignal('pr-merge-ready', token)}\n`),
      eventBus: localBus,
      resolveAgent: (id) => (
        id === 'dev-1' ? { ...config.project[0]!.agent[0]![0]!, projectId: 'proj' } : undefined
      ),
    });
    manager = createManager({
      config: manualConfig,
      eventBus: localBus,
      phaseSignalWatcher: watcher,
    });
    registerEventHandlers(localBus, manager);
    vi.spyOn(manager, 'platformVerifyAcceptedPass').mockResolvedValue({ kind: 'valid', pending: new Set() });

    await manager.setupRecoveredPostApproveSignals();
    await waitForTaskStatus('task-approved-manual', 'merge-ready');

    expect((await taskStore.get('task-approved-manual'))?.status).toBe('merge-ready');
    await expect(manager.getPostApproveCompletion('task-approved-manual')).resolves.toBeNull();
  });
});

describe('git review dispatch recovery', () => {
  it('resets an unbound claimed lease to pending after restart', async () => {
    await seedRecoveryTask({
      id: 'task-unbound-claim', status: 'in_progress', phase: 'code',
      deliveryConfirmation: { phase: 'code', source: 'signal', at: NOW },
      prNumber: 42,
      signalToken: 'delivery-pass-1', qaAgentId: 'qa-1',
    });
    const begun = await manager.beginGitReviewPass('task-unbound-claim', {
      fromStatus: ['in_progress'], headSha: 'a'.repeat(40), bumpRound: true,
    });
    await manager.claimGitReviewDispatch('task-unbound-claim', begun!.task.reviewDispatch!.generation);

    await manager.recoverClaimedGitReviewDispatches();

    expect((await taskStore.get('task-unbound-claim'))?.reviewDispatch?.phase).toBe('pending');
  });

  it('marks a claimed lease uncertain when the QA binding may have received it', async () => {
    await seedRecoveryTask({
      id: 'task-bound-claim', status: 'in_progress', phase: 'code',
      deliveryConfirmation: { phase: 'code', source: 'signal', at: NOW },
      prNumber: 42,
      signalToken: 'delivery-pass-2', qaAgentId: 'qa-1',
    });
    const begun = await manager.beginGitReviewPass('task-bound-claim', {
      fromStatus: ['in_progress'], headSha: 'b'.repeat(40), bumpRound: true,
    });
    const claimed = await manager.claimGitReviewDispatch(
      'task-bound-claim', begun!.task.reviewDispatch!.generation,
    );
    await seedAgent({ id: 'qa-1', taskId: 'task-bound-claim' });

    await manager.recoverClaimedGitReviewDispatches();

    expect((await taskStore.get('task-bound-claim'))?.reviewDispatch).toMatchObject({
      phase: 'uncertain', claimId: claimed!.lease.claimId,
    });
    expect(events.find(event => event.type === 'human.intervention'
      && event.taskId === 'task-bound-claim')?.data).toMatchObject({
      phase: 'git-review-dispatch-recovery-uncertain',
      generation: begun!.task.reviewDispatch!.generation,
    });
  });
});

describe('setupRecoveredSpecSignals()', () => {
  async function buildManagerWithSpecWatcher() {
    const watcher = {
      start: vi.fn(async (_args: PhaseSignalWatcherStartArgs) => true),
      stop: vi.fn(),
      has: vi.fn(() => true),
      isSettling: vi.fn(() => false),
      awaitSettled: vi.fn(async () => undefined),
    };
    const eventsDir = join(tempDir, 'events-spec');
    await mkdir(eventsDir, { recursive: true });
    const localBus = new EventBus(new EventLog(eventsDir));
    const localEvents: BaxianEvent[] = [];
    localBus.on('*', (event) => { localEvents.push(event); });
    manager = createManager({
      eventBus: localBus,
      phaseSignalWatcher: watcher as never,
    });
    return { watcher, events: localEvents };
  }

  it.each<[string, Partial<TaskState> & { id: string }, Record<string, unknown>]>([
    ['sets up spec-done|pr-created before the development path is known',
      { id: 'task-initial', signalToken: 'tok-ready' },
      {
        taskId: 'task-initial', projectId: 'proj', agentId: 'dev-1',
        expectedKinds: ['spec-done', 'pr-created'], token: 'tok-ready',
        skipSnapshot: false, recovered: true, needInputInherit: true,
      }],
    ['sets up pr-created for code-phase development',
      { id: 'task-code', phase: 'code', signalToken: 'tok-code' },
      {
        taskId: 'task-code', projectId: 'proj', agentId: 'dev-1',
        expectedKinds: ['pr-created'], token: 'tok-code',
        skipSnapshot: false, recovered: true, needInputInherit: true,
      }],
    ['sets up pr-fixed for spec fixes',
      { id: 'task-spec-fix', phase: 'spec', status: 'fixing', signalToken: 'tok-spec-fix' },
      {
        taskId: 'task-spec-fix', projectId: 'proj', agentId: 'dev-1',
        expectedKinds: ['pr-fixed'], token: 'tok-spec-fix',
        skipSnapshot: false, recovered: true, needInputInherit: true,
      }],
    ['sets up pr-fixed for code fixes',
      { id: 'task-code-fix', phase: 'code', status: 'fixing', signalToken: 'tok-code-fix' },
      {
        taskId: 'task-code-fix', projectId: 'proj', agentId: 'dev-1',
        expectedKinds: ['pr-fixed'], token: 'tok-code-fix',
        skipSnapshot: false, recovered: true, needInputInherit: true,
      }],
  ])('%s', async (_label, task, expectedArg) => {
    await seedRecoveryTask(task);
    const { watcher } = await buildManagerWithSpecWatcher();

    await manager.setupRecoveredSpecSignals();

    expect(watcher.start).toHaveBeenCalledWith(expectedArg);
  });

  it.each([
    ['spec', 'task-spec-review'],
    ['code', 'task-code-review'],
  ] as const)('restores the passive platform watcher for %s review', async (phase, id) => {
    await seedRecoveryTask({
      id,
      phase,
      status: 'review',
      signalToken: `tok-${phase}-review`,
    });
    const { watcher, events: localEvents } = await buildManagerWithSpecWatcher();

    await manager.setupRecoveredSpecSignals();

    expect(watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      taskId: id,
      agentId: 'qa-1',
      expectedKinds: [],
      token: `tok-${phase}-review`,
      skipSnapshot: false,
      recovered: true,
    }));
    expect(localEvents.some(event =>
      event.type === 'human.intervention'
      && event.data.phase === 'phase-signal-setup-during-recovery')).toBe(false);
  });

  it.each<[string, Partial<TaskState> & { id: string }]>([
    ['skips tasks without signalToken', { id: 'task-no-token' }],
    ['skips terminal tasks even when signalToken is set', {
      id: 'task-terminal', signalToken: 'tok-stale', status: 'merged',
    }],
  ])('%s', async (_label, task) => {
    await seedRecoveryTask(task);
    const { watcher } = await buildManagerWithSpecWatcher();

    await manager.setupRecoveredSpecSignals();

    expect(watcher.start).not.toHaveBeenCalled();
  });

  it('reports a recovered fix signal without restoring the retired read-file side channel', async () => {
    await seedRecoveryTask({
      id: 'task-fixing',
      phase: 'code',
      status: 'fixing',
      signalToken: 'tok-fixing',
    });
    const { watcher, events: localEvents } = await buildManagerWithSpecWatcher();

    await manager.setupRecoveredSpecSignals();

    const args = watcher.start.mock.calls[0]![0];
    expect(args.expectedKinds).toEqual(['pr-fixed']);
    expect(args.skipSnapshot).toBe(false);
    expect('onReadFile' in args).toBe(false);
    expect(localEvents).toContainEqual(expect.objectContaining({
      type: 'human.intervention',
      taskId: 'task-fixing',
      data: expect.objectContaining({
        phase: 'phase-signal-setup-during-recovery',
        kind: 'pr-fixed',
      }),
    }));
  });

  it('does not report a stale recovery intervention after the snapshot advances the task generation', async () => {
    await seedRecoveryTask({
      id: 'task-fixing-snapshot',
      phase: 'code',
      status: 'fixing',
      signalToken: 'tok-fixing-snapshot',
    });
    const { watcher, events: localEvents } = await buildManagerWithSpecWatcher();
    watcher.isSettling.mockReturnValue(true);
    watcher.awaitSettled.mockImplementation(async () => {
      const task = (await taskStore.get('task-fixing-snapshot'))!;
      await taskStore.set({
        ...task,
        status: 'review',
        signalToken: 'tok-review-successor',
        updatedAt: new Date().toISOString(),
      });
      watcher.has.mockReturnValue(false);
    });

    await manager.setupRecoveredSpecSignals();

    expect(watcher.awaitSettled).toHaveBeenCalledWith('task-fixing-snapshot');
    expect(localEvents.some(event =>
      event.type === 'human.intervention'
      && event.data.phase === 'phase-signal-setup-during-recovery')).toBe(false);
  });

  it('restores only the passive review watcher for a task under review', async () => {
    await seedRecoveryTask({
      id: 'task-under-review',
      phase: 'code',
      status: 'review',
      signalToken: 'tok-review',
      prNumber: 42,
    });
    const { watcher } = await buildManagerWithSpecWatcher();

    await manager.setupRecoveredSpecSignals();

    expect(watcher.start).toHaveBeenCalledTimes(1);
    expect(watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-under-review',
      agentId: 'qa-1',
      expectedKinds: [],
      token: 'tok-review',
    }));
    expect(watcher.start).not.toHaveBeenCalledWith(expect.objectContaining({ agentId: 'dev-1' }));
  });
});

describe('recover() deferred branches', () => {
  it('skips the terminal-binding release when the binding refresh does not land', async () => {
    await seedAgent({ id: 'dev-1', taskId: 'task-merged', paneId: '%stale' });
    await seedRecoveryTask({ id: 'task-merged', prNumber: 42, status: 'merged' });
    await acquireBoundLock('dev-1');
    const realUpdate = agentStore.update.bind(agentStore);
    // 吞掉「写回刷新后 pane」的那次写(第一次是 ensureSession 写 Workdir)
    let devUpdates = 0;
    vi.spyOn(agentStore, 'update').mockImplementation(async (id, fn) => {
      if (id === 'dev-1' && ++devUpdates === 2) return 'noop';
      return realUpdate(id, fn);
    });

    await manager.recover();

    // pane 刷新没落盘 → 不释放:绑定与锁都留在原地
    expect((await agentStore.get('dev-1'))?.taskId).toBe('task-merged');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('falls through to the held-binding release path when the terminal release throws', async () => {
    await seedAgent({ id: 'dev-1', taskId: 'task-merged', paneId: '%0' });
    await seedRecoveryTask({ id: 'task-merged', prNumber: 42, status: 'merged' });
    await acquireBoundLock('dev-1');
    const realRelease = manager.releaseAgentForTask.bind(manager);
    let threw = false;
    // E2: 只让第一次释放失败、第二次成功是状态机内部的一次性故障,runner 层造不出「同一命令先失败后成功」
    vi.spyOn(manager, 'releaseAgentForTask').mockImplementation(async (agentId, taskId, mode, opts) => {
      if (!threw) { threw = true; throw new Error('release exploded'); }
      return realRelease(agentId, taskId, mode, opts);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await manager.recover();

    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
    // the fallback succeeds, so the first release's failure is only visible through this warning
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/releaseAgentForTask\(dev-1, task-merged\) failed/),
      expect.objectContaining({ message: 'release exploded' }),
    );
    warnSpy.mockRestore();
  });

  it('cleans the exact baxian branch when releasing a binding to a terminal task', async () => {
    const { cleanupSpy } = await runRecovery({
      agents: [{
        id: 'dev-1', taskId: 'task-dead', paneId: '%0',
        workdir: '/tmp/repo',
      }],
      tasks: [{ id: 'task-dead', status: 'cancelled', branchCreatedByBaxian: true }],
      locks: ['dev-1'],
    });

    expect(cleanupSpy).toHaveBeenCalledWith('/tmp/repo', expect.objectContaining({
      taskId: 'task-dead',
      taskBranch: 'bx/task-dead',
      branchCreatedByBaxian: true,
    }), expect.any(Function));
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('keeps the binding and lock when fixed-Workdir branch cleanup fails', async () => {
    await runRecovery({
      agents: [{
        id: 'dev-1', taskId: 'task-dead', paneId: '%0',
        workdir: '/tmp/repo',
      }],
      tasks: [{ id: 'task-dead', status: 'cancelled', branchCreatedByBaxian: true }],
      locks: ['dev-1'],
      cleanupImpl: async () => { throw new Error('branch cleanup failed'); },
    });

    expect(await agentStore.get('dev-1')).toMatchObject({
      taskId: 'task-dead',
      status: 'awaiting_human',
      awaitingPhase: 'branch-cleanup-pending',
      awaitingReason: expect.stringContaining('branch cleanup failed'),
    });
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('marks the agent dialog-pending and survives a crashing slow poll', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runRecovery({
      agents: [{ id: 'dev-1', paneId: '%0' }],
      before: () => {
        // REPL 卡在启动遮挡上;抓到这一帧之后后台慢轮询再取 runner 就拿不到了(公共依赖失效)
        let blocked = false;
        const dialogRunner = createManagerSuiteRunner({
          workdirs: workdirsOf(config),
          agents: { 'dev-1': { screen: STARTUP_DIALOG_SCREEN } },
          onExec: command => { if (command.includes('capture-pane')) blocked = true; },
        });
        runner = dialogRunner;
        manager = createManager({
          runnerFactory: () => {
            if (blocked) throw new Error('poll crashed');
            return dialogRunner;
          },
        });
      },
    });

    const state = await agentStore.get('dev-1');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('agent_dialog_pending');
    // the background poll crash is swallowed by design; its warning is the only diagnostic, so it must name the agent
    await vi.waitFor(() => {
      expect(warnSpy.mock.calls.some(call => /slowPoll.*dev-1/.test(String(call[0])))).toBe(true);
    });
    warnSpy.mockRestore();
  });

  it('holds the orphan binding on recovery failure even when killSession fails, keeping the task alive', async () => {
    const killSpy = vi.spyOn(TmuxManager.prototype, 'killSessionRef').mockRejectedValue(new Error('kill refused'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runRecovery({
      agents: [{ id: 'dev-1', taskId: 'task-1', paneId: '%0' }],
      tasks: [{ id: 'task-1' }],
      locks: ['dev-1'],
      before: () => {
        // 会话没了 → recover 新建会话,启动命令发不出去 → createdSession 的 partial 带着新会话 ref 回滚
        useRunner({ rules: [{ match: 'send-keys -l', reply: { stderr: 'boot exploded mid-recovery', exitCode: 1 } }] });
        runner.sessions.drop('dev-1');
      },
    });

    expect(killSpy).toHaveBeenCalledWith(
      { sessionId: expect.stringMatching(/^\$\d+$/), serverPid: '4242', serverStart: '1700000000' },
      { kind: 'emptyOr', claim: 'dev-1' },
    );
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('created-session rollback') && String(c[0]).includes('failed'))).toBe(true);
    const state = await agentStore.get('dev-1');
    expect(state?.paneId).toBeUndefined();
    expect(state).toMatchObject({ taskId: 'task-1', status: 'awaiting_human' });
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    expect((await taskStore.get('task-1'))?.status).toBe('in_progress');
    expect(events.some(e => e.type === 'human.intervention'
      && (e.data as { phase?: string }).phase === 'recovery-failed')).toBe(true);
    warnSpy.mockRestore();
  });
});
