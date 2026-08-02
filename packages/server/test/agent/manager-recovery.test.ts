import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentBindingFacts, BaxianConfig, BaxianEvent, TaskState } from '../../src/shared/index.js';
import { EnsureSessionError, canDispatchWithBinding, type AgentManager } from '../../src/agent/manager.js';
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
import { createManagerHarness } from '../helpers/manager-harness.js';
import { fakeRunner } from '../helpers/fake-runner.js';
import { makeConfig } from '../helpers/fixtures.js';

const NOW = '2026-05-14T05:00:00.000Z';

let tempDir: string;
let config: BaxianConfig;
let agentStore: AgentStore;
let taskStore: TaskStore;
let lockManager: LockManager;
let eventBus: EventBus;
let manager: AgentManager;
let createManager: Awaited<ReturnType<typeof createManagerHarness>>['createManager'];
let seedAgent: Awaited<ReturnType<typeof createManagerHarness>>['seedAgent'];
let seedHarnessTask: Awaited<ReturnType<typeof createManagerHarness>>['seedTask'];
let events: BaxianEvent[];

const REF = { sessionId: '$1', serverPid: '4242', serverStart: '1700000000' };

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

function mockEnsureSessionOk(overrides: Record<string, unknown> = {}): void {
  const paneId = (overrides.paneId as string | undefined) ?? '%1';
  vi.spyOn(manager, 'ensureSession').mockResolvedValue({
    ok: true, createdSession: false, freshRuntime: false, paneId,
    pane: { session: REF, paneId, claim: 'dev-1' }, sessionRef: REF, workdir: '/tmp/repo',
    ...overrides,
  } as never);
}

interface RecoveryScenario {
  agents: (Partial<AgentBindingFacts> & { id: string })[];
  tasks?: (Partial<TaskState> & { id: string })[];
  locks?: string[];
  emit?: BaxianEvent[];
  ensureSession?: Record<string, unknown> | { reject: EnsureSessionError };
  cleanupImpl?: () => Promise<void>;
}

interface RecoveryHandles {
  cleanupSpy: ReturnType<typeof vi.spyOn>;
  watchSpy: ReturnType<typeof vi.spyOn>;
}

async function runRecovery(scenario: RecoveryScenario): Promise<RecoveryHandles> {
  for (const agent of scenario.agents) await seedAgent(agent);
  for (const task of scenario.tasks ?? []) await seedRecoveryTask(task);
  for (const event of scenario.emit ?? []) await eventBus.emit(event);
  for (const id of scenario.locks ?? []) await acquireBoundLock(id);

  const session = scenario.ensureSession;
  if (session && 'reject' in session) {
    vi.spyOn(manager, 'ensureSession').mockRejectedValue(session.reject);
  } else {
    mockEnsureSessionOk(session ?? {});
  }

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
  const harness = await createManagerHarness(tempDir, {
    config,
    taskDefaults: {
      branchCreatedByBaxian: undefined,
      createdAt: NOW,
      updatedAt: NOW,
    },
    lockSeededAgents: true,
    deps: {
      runnerFactory: () => fakeRunner({
        agents: {
          'dev-1': { paneId: '%1' },
          'qa-1': { paneId: '%1' },
        },
      }),
    },
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
  it('reclaims orphaned maintenance and task locks but preserves an exactly bound task lock', async () => {
    const maintenanceToken = await lockManager.acquire('dev-1', 'maintenance:branch-reconcile');
    const orphanedTaskToken = await lockManager.acquire('orphan-1', 'task-orphaned');
    await seedRecoveryTask({ id: 'task-live', status: 'review', qaAgentId: 'qa-1' });
    await seedAgent({ id: 'qa-1', taskId: 'task-live' });
    const boundTaskToken = (await agentStore.get('qa-1'))?.lockToken;
    mockEnsureSessionOk();

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
    const ensureSpy = vi.spyOn(manager, 'ensureSession');

    await manager.recover();

    expect(ensureSpy).not.toHaveBeenCalled();
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
    expect(state?.paneId).toBe('%1');
    expect(state?.creationToken).toBeUndefined();
    expect(state?.taskId).toBe('task-1');
    expect(watchSpy).toHaveBeenCalledWith('dev-1');
  });

  it('releases a recovered merged-task binding directly, with the refreshed pane persisted first', async () => {
    await seedAgent({ id: 'dev-1', taskId: 'task-merged', paneId: '%0' });
    await seedRecoveryTask({ id: 'task-merged', prNumber: 42, reviewRound: 1, status: 'merged' });
    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%1',
      pane: { session: REF, paneId: '%1', claim: 'dev-1' }, sessionRef: REF, workdir: '/tmp/repo',
    });
    const realRelease = manager.releaseAgentForTask.bind(manager);
    let paneIdSeenByRelease: string | undefined;
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask').mockImplementation(async (agentId, taskId, mode, opts) => {
      paneIdSeenByRelease = (await agentStore.get(agentId))?.paneId;
      return realRelease(agentId, taskId, mode, opts);
    });

    await manager.recover();

    expect(releaseSpy).toHaveBeenCalledWith('dev-1', 'task-merged', 'idle');
    expect(paneIdSeenByRelease).toBe('%1');
    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(canDispatchWithBinding(state)).toBe(true);
  });

  it('releases a recovered done-task binding (terminal without pr)', async () => {
    await seedAgent({ id: 'dev-1', taskId: 'task-done', paneId: '%0' });
    await seedRecoveryTask({ id: 'task-done', status: 'done' });
    mockEnsureSessionOk();
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask');

    await manager.recover();

    expect(releaseSpy).toHaveBeenCalledWith('dev-1', 'task-done', 'idle');
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('releases a recovered merged QA binding without a PR (branch merge)', async () => {
    await seedAgent({ id: 'qa-1', taskId: 'task-branch-merged', paneId: '%0' });
    await seedRecoveryTask({
      id: 'task-branch-merged', status: 'merged',
      preferredAgentId: 'dev-1', agentId: 'dev-1', qaAgentId: 'qa-1',
    });
    mockEnsureSessionOk();
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask');

    await manager.recover();

    expect(releaseSpy).toHaveBeenCalledWith('qa-1', 'task-branch-merged', 'idle');
    expect((await agentStore.get('qa-1'))?.taskId).toBeUndefined();
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
      ensureSession: { createdSession: true, freshRuntime: true },
    });

    await expectRolledBack('task-1', 'dev-1');
    expect((await taskStore.get('task-1'))?.agentId).toBe('');
    expect(watchSpy).not.toHaveBeenCalled();
  });

  it('releases a pending bootstrap binding when the next recovery succeeds', async () => {
    await seedAgent({
      id: 'dev-1', taskId: 'task-pending', bootstrappingTaskId: 'task-pending', paneId: '%0',
    });
    await seedRecoveryTask({ id: 'task-pending', status: 'pending' });
    await acquireBoundLock('dev-1');
    vi.spyOn(manager, 'ensureSession')
      .mockRejectedValueOnce(new EnsureSessionError(
        { createdSession: false, agentId: 'dev-1' },
        'git fetch failed: transient network error',
      ))
      .mockResolvedValue({
        ok: true, createdSession: false, freshRuntime: false, paneId: '%1',
        pane: { session: REF, paneId: '%1', claim: 'dev-1' }, sessionRef: REF, workdir: '/tmp/repo',
      } as never);

    await manager.recover();
    expect(await agentStore.get('dev-1')).toMatchObject({
      taskId: 'task-pending',
      status: 'awaiting_human',
      awaitingPhase: 'recovery-failed',
    });
    expect((await taskStore.get('task-pending'))?.attention).toMatchObject({ reason: 'recovery-failed' });

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
      ensureSession: { createdSession: true, freshRuntime: true },
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
      ensureSession: { paneId: '%0' },
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
      ensureSession: { paneId: '%0' },
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
    const dialogSpy = vi.spyOn(
      manager as never as { markDialogPending: (...a: unknown[]) => Promise<void> }, 'markDialogPending',
    ).mockResolvedValue(undefined);
    const { cleanupSpy } = await runRecovery({
      agents: [{
        id: 'dev-1', taskId: 'task-1', startedAt: NOW, paneId: '%0',
        bootstrappingTaskId: 'task-1', workdir: '/tmp/repo',
      }],
      tasks: [{ id: 'task-1' }],
      locks: ['dev-1'],
      ensureSession: {
        reject: new EnsureSessionError({ createdSession: false, agentId: 'dev-1', dialogPending: true }, 'startup dialog'),
      },
    });

    expect(dialogSpy).not.toHaveBeenCalled();
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
    vi.spyOn(manager, 'continueSession').mockImplementation(async (_taskId, _agentId, _phase, opts) =>
      opts.guardBeforeInject?.() ?? true,
    );
    await expect(manager.redispatchTaskPromptAfterReplRestart('dev-1', 'task-1')).resolves.toBe(true);

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

  it('clears unsafe runtime facts but preserves the binding lock when recovery cannot validate the session', async () => {
    await runRecovery({
      agents: [{ id: 'dev-1', taskId: 'task-1', paneId: '%0', creationToken: 'tok' }],
      tasks: [{ id: 'task-1' }],
      locks: ['dev-1'],
      ensureSession: {
        reject: new EnsureSessionError({ createdSession: false, agentId: 'dev-1' }, 'session claim mismatch'),
      },
    });

    const state = await agentStore.get('dev-1');
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
    vi.spyOn(manager, 'ensureSession').mockImplementation(async (agentId) => {
      if (agentId === 'dev-1') {
        throw new EnsureSessionError(
          { createdSession: false, agentId },
          "git fetch failed: cannot lock ref 'refs/remotes/origin/HEAD'",
        );
      }
      return {
        ok: true, createdSession: false, freshRuntime: false, paneId: '%2',
        pane: { session: REF, paneId: '%2', claim: agentId }, sessionRef: REF, workdir: '/tmp/repo',
      } as never;
    });

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
    vi.spyOn(manager, 'ensureSession').mockImplementation(async (agentId) => {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        'git fetch failed: transient network error',
      );
    });

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
    vi.spyOn(manager, 'ensureSession').mockRejectedValue(new EnsureSessionError(
      { createdSession: false, agentId: 'dev-1' },
      'git fetch failed: transient network error',
    ));

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

    const start = vi.spyOn(manager, 'startSession').mockResolvedValue(true);
    const advanced = await manager.advanceTask('task-pending');
    expect(advanced.status).toBe('in_progress');
    expect(start).toHaveBeenCalledWith('task-pending', 'dev-1', 'develop');
  });

  it('does not attach recovery actions to a terminal task', async () => {
    await seedAgent({ id: 'dev-1', taskId: 'task-done', paneId: '%0', startedAt: NOW });
    await seedRecoveryTask({ id: 'task-done', status: 'done' });
    vi.spyOn(manager, 'ensureSession').mockRejectedValue(new EnsureSessionError(
      { createdSession: false, agentId: 'dev-1' },
      'git fetch failed: transient network error',
    ));

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
    vi.spyOn(manager, 'ensureSession').mockRejectedValue(new EnsureSessionError(
      { createdSession: false, agentId: 'dev-1' },
      'git fetch failed: transient network error',
    ));

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
    vi.spyOn(manager, 'ensureSession').mockRejectedValue(new EnsureSessionError(
      { createdSession: false, agentId: 'dev-1' },
      'git fetch failed: transient network error',
    ));
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
      start: vi.fn(async () => true),
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
    vi.spyOn(manager, 'platformVerifyAcceptedPass').mockResolvedValue({ ok: true, pendingCount: 0 });

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
      replyActorId: '77', replyActorStatus: 'verified', prNumber: 42,
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
      replyActorId: '77', replyActorStatus: 'verified', prNumber: 42,
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
      start: vi.fn(async () => true),
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

    const args = watcher.start.mock.calls[0]![0] as Record<string, unknown>;
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

  it('restores both the passive review watcher and an unverified PR delivery watcher', async () => {
    await seedRecoveryTask({
      id: 'task-pending-pr',
      phase: 'code',
      status: 'review',
      signalToken: 'tok-review',
      pendingPrSignalToken: 'tok-pending-pr',
      replyActorStatus: 'provisional',
      prNumber: 42,
    });
    const { watcher } = await buildManagerWithSpecWatcher();

    await manager.setupRecoveredSpecSignals();

    expect(watcher.start).toHaveBeenCalledTimes(2);
    expect(watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-pending-pr',
      agentId: 'qa-1',
      expectedKinds: [],
      token: 'tok-review',
      replaceScope: 'agent',
    }));
    expect(watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-pending-pr',
      agentId: 'dev-1',
      expectedKinds: ['pr-created'],
      token: 'tok-pending-pr',
      replaceScope: 'agent',
    }));
  });
});

describe('recover() deferred branches', () => {
  it('skips the terminal-binding release when the binding refresh does not land', async () => {
    await seedAgent({ id: 'dev-1', taskId: 'task-merged', paneId: '%0' });
    await seedRecoveryTask({ id: 'task-merged', prNumber: 42, status: 'merged' });
    mockEnsureSessionOk();
    vi.spyOn(agentStore, 'update').mockImplementationOnce(async () => {});
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);

    await manager.recover();

    expect(releaseSpy).not.toHaveBeenCalledWith('dev-1', 'task-merged', 'idle');
  });

  it('falls through to the held-binding release path when the terminal release throws', async () => {
    await seedAgent({ id: 'dev-1', taskId: 'task-merged', paneId: '%0' });
    await seedRecoveryTask({ id: 'task-merged', prNumber: 42, status: 'merged' });
    await acquireBoundLock('dev-1');
    mockEnsureSessionOk();
    const realRelease = manager.releaseAgentForTask.bind(manager);
    let threw = false;
    vi.spyOn(manager, 'releaseAgentForTask').mockImplementation(async (agentId, taskId, mode, opts) => {
      if (!threw) { threw = true; throw new Error('release exploded'); }
      return realRelease(agentId, taskId, mode, opts);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await manager.recover();

    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('releaseAgentForTask'))).toBe(true);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
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
    vi.spyOn(
      manager as unknown as { slowPollDialogPending: () => Promise<void> },
      'slowPollDialogPending',
    ).mockRejectedValue(new Error('poll crashed'));

    await runRecovery({
      agents: [{ id: 'dev-1', paneId: '%0' }],
      ensureSession: {
        reject: new EnsureSessionError(
          { createdSession: false, agentId: 'dev-1', dialogPending: true, lastScreen: 'Press enter to continue' },
          'blocked on startup dialog',
        ),
      },
    });

    const state = await agentStore.get('dev-1');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('agent_dialog_pending');
    await new Promise(r => setTimeout(r, 10));
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('slowPoll'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('holds the orphan binding on recovery failure even when killSession fails, keeping the task alive', async () => {
    const killSpy = vi.spyOn(TmuxManager.prototype, 'killSessionRef').mockRejectedValue(new Error('kill refused'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runRecovery({
      agents: [{ id: 'dev-1', taskId: 'task-1', paneId: '%0' }],
      tasks: [{ id: 'task-1' }],
      locks: ['dev-1'],
      ensureSession: {
        reject: new EnsureSessionError(
          { createdSession: true, agentId: 'dev-1', sessionRef: { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' }, genAtCreate: 0 },
          'boot exploded mid-recovery',
        ),
      },
    });

    expect(killSpy).toHaveBeenCalledWith(
      { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' },
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
