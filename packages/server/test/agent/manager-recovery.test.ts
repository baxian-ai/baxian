import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentBindingFacts, BaxianConfig, BaxianEvent, TaskState } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
import { AgentManager, EnsureSessionError, canDispatchWithBinding } from '../../src/agent/manager.js';
import { PhaseSignalWatcher } from '../../src/agent/phase-signal-watcher.js';
import { buildPhaseSignal } from '../../src/agent/phase-signal.js';
import type { PaneStreamerManager } from '../../src/agent/pane-streamer-manager.js';
import type { SubscriberCallbacks } from '../../src/agent/pane-streamer.js';
import { TmuxManager } from '../../src/agent/tmux.js';
import { WorktreeManager } from '../../src/agent/worktree.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';
import { AgentStore } from '../../src/state/agent-store.js';
import { TaskStore } from '../../src/state/task-store.js';
import { LockManager } from '../../src/state/lock.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { registerEventHandlers } from '../../src/event/handlers.js';
import { SkillRegistry } from '../../src/skill/registry.js';
import { PostApproveStore } from '../../src/state/post-approve-store.js';
import { initStateDir } from '../../src/state/init.js';

const NOW = '2026-05-14T05:00:00.000Z';

const CONFIG: BaxianConfig = {
  review: { rounds: 10 },
  server: DEFAULT_SERVER_CONFIG,
  project: [{
    id: 'proj',
    repo: 'user/repo',
    merge: 'auto',
    agent: [[
      { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp/repo' },
      { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local', workdir: '/tmp/repo' },
    ]],
  }],
};

let tempDir: string;
let agentStore: AgentStore;
let taskStore: TaskStore;
let lockManager: LockManager;
let eventBus: EventBus;
let manager: AgentManager;
const events: BaxianEvent[] = [];

function noopRunner(): CommandRunner {
  return {
    exec: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    writeFile: vi.fn(async (): Promise<void> => undefined),
  };
}

function seedAgent(overrides: Partial<AgentBindingFacts> & { id: string }): Promise<void> {
  return agentStore.set({ projectId: 'proj', updatedAt: NOW, ...overrides });
}

function seedTask(overrides: Partial<TaskState> & { id: string }): Promise<void> {
  return taskStore.set({
    projectId: 'proj',
    title: 'T',
    description: 'D',
    preferredAgentId: 'dev-1',
    agentId: 'dev-1',
    branch: `bx/${overrides.id}`,
    reviewRound: 0,
    status: 'in_progress',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function mockEnsureSessionOk(overrides: Record<string, unknown> = {}): void {
  vi.spyOn(manager, 'ensureSession').mockResolvedValue({
    ok: true, createdSession: false, freshRuntime: false, paneId: '%1', workdir: '/tmp/repo',
    ...overrides,
  } as never);
}

interface RecoveryScenario {
  agents: (Partial<AgentBindingFacts> & { id: string })[];
  tasks?: (Partial<TaskState> & { id: string })[];
  locks?: string[];
  emit?: BaxianEvent[];
  ensureSession?: Record<string, unknown> | { reject: EnsureSessionError };
  removeImpl?: () => Promise<void>;
}

interface RecoveryHandles {
  removeSpy: ReturnType<typeof vi.spyOn>;
  watchSpy: ReturnType<typeof vi.spyOn>;
}

async function runRecovery(scenario: RecoveryScenario): Promise<RecoveryHandles> {
  for (const agent of scenario.agents) await seedAgent(agent);
  for (const task of scenario.tasks ?? []) await seedTask(task);
  for (const event of scenario.emit ?? []) await eventBus.emit(event);
  for (const id of scenario.locks ?? []) await lockManager.acquire(id);

  const session = scenario.ensureSession;
  if (session && 'reject' in session) {
    vi.spyOn(manager, 'ensureSession').mockRejectedValue(session.reject);
  } else {
    mockEnsureSessionOk(session ?? {});
  }

  const removeSpy = scenario.removeImpl
    ? vi.spyOn(WorktreeManager.prototype, 'remove').mockImplementation(scenario.removeImpl)
    : vi.spyOn(WorktreeManager.prototype, 'remove').mockResolvedValue(undefined);
  const watchSpy = vi.spyOn(manager, 'startRuntimeMenuWatch');

  await manager.recover();
  return { removeSpy, watchSpy };
}

async function expectRolledBack(taskId: string, agentId: string): Promise<void> {
  expect((await taskStore.get(taskId))?.status).toBe('pending');
  expect((await agentStore.get(agentId))?.taskId).toBeUndefined();
  expect(await lockManager.isLocked(agentId)).toBe(false);
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-recovery-'));
  await initStateDir(tempDir);

  agentStore = new AgentStore(join(tempDir, 'state', 'agents'));
  taskStore = new TaskStore(join(tempDir, 'state', 'tasks'));
  lockManager = new LockManager(join(tempDir, 'locks'));
  eventBus = new EventBus(new EventLog(join(tempDir, 'events')));
  events.length = 0;
  eventBus.on('*', (event) => { events.push(event); });

  manager = new AgentManager({
    config: CONFIG,
    agentStore,
    taskStore,
    lockManager,
    eventBus,
    skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
    runnerFactory: () => noopRunner(),
    postApproveStore: new PostApproveStore(join(tempDir, 'state', 'post-approve')),
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

describe('recover()', () => {
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

  it('redrives post-merge cleanup for a recovered merged-task binding', async () => {
    await seedAgent({ id: 'dev-1', taskId: 'task-merged', paneId: '%0' });
    await seedTask({ id: 'task-merged', prNumber: 42, reviewRound: 1, status: 'merged' });
    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, paneId: '%1', workdir: '/tmp/repo',
    });
    let paneIdSeenByCleanup: string | undefined;
    const cleanupSpy = vi.spyOn(manager, 'dispatchPostMergeCleanup').mockImplementation(async (agentId, ctx) => {
      paneIdSeenByCleanup = (await agentStore.get(agentId))?.paneId;
      await manager.releaseAgentForTask(agentId, ctx.taskId, 'idle');
    });

    await manager.recover();

    expect(cleanupSpy).toHaveBeenCalledWith('dev-1', {
      taskId: 'task-merged',
      branch: 'bx/task-merged',
    });
    expect(paneIdSeenByCleanup).toBe('%1');
    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(canDispatchWithBinding(state)).toBe(true);
  });

  it('redrives context compaction for a recovered done-task binding (terminal without pr)', async () => {
    await seedAgent({ id: 'dev-1', taskId: 'task-done', paneId: '%0' });
    await seedTask({ id: 'task-done', reviewMode: 'server', status: 'done' });
    mockEnsureSessionOk();
    let paneIdSeenByCompaction: string | undefined;
    const compactSpy = vi.spyOn(
      manager as never as { runPostMergeCompaction: (...a: unknown[]) => Promise<void> },
      'runPostMergeCompaction',
    ).mockImplementation(async (_tmux, _paneId, agentId, taskId) => {
      paneIdSeenByCompaction = (await agentStore.get(agentId as string))?.paneId;
      await manager.releaseAgentForTask(agentId as string, taskId as string, 'idle');
    });

    await manager.recover();

    await vi.waitFor(async () => {
      expect(compactSpy).toHaveBeenCalled();
      expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    });
    expect(paneIdSeenByCompaction).toBe('%1');
    expect(compactSpy.mock.calls[0]?.[2]).toBe('dev-1');
    expect(compactSpy.mock.calls[0]?.[3]).toBe('task-done');
  });

  it('redrives context compaction for a recovered merged binding without a PR (branch merge)', async () => {
    await seedAgent({ id: 'qa-1', taskId: 'task-branch-merged', paneId: '%0' });
    await seedTask({
      id: 'task-branch-merged', reviewMode: 'server', status: 'merged',
      preferredAgentId: 'dev-1', agentId: 'dev-1', qaAgentId: 'qa-1',
    });
    mockEnsureSessionOk();
    const cleanupSpy = vi.spyOn(manager, 'dispatchPostMergeCleanup').mockResolvedValue();
    const compactSpy = vi.spyOn(
      manager as never as { runPostMergeCompaction: (...a: unknown[]) => Promise<void> },
      'runPostMergeCompaction',
    ).mockImplementation(async (_tmux, _paneId, agentId, taskId) => {
      await manager.releaseAgentForTask(agentId as string, taskId as string, 'idle');
    });

    await manager.recover();

    await vi.waitFor(async () => {
      expect(compactSpy).toHaveBeenCalled();
      expect((await agentStore.get('qa-1'))?.taskId).toBeUndefined();
    });
    expect(cleanupSpy).not.toHaveBeenCalled();
  });

  it('releases a recovered cancelled-task binding without compaction', async () => {
    await runRecovery({
      agents: [{ id: 'dev-1', taskId: 'task-gone', paneId: '%0' }],
      tasks: [{ id: 'task-gone', status: 'cancelled' }],
    });
    const compactSpy = vi.spyOn(
      manager as never as { runPostMergeCompaction: (...a: unknown[]) => Promise<void> },
      'runPostMergeCompaction',
    );

    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(compactSpy).not.toHaveBeenCalled();
  });

  it('preserves Held state (status=awaiting_human + awaitingPhase/Reason/Since) when recovering an ack_unknown agent with active bound task', async () => {
    await runRecovery({
      agents: [{
        id: 'qa-1', taskId: 'task-active', paneId: '%0', status: 'awaiting_human',
        awaitingPhase: 'dispatch-failed:ack_unknown', awaitingReason: 'simulated ack_unknown', awaitingSince: NOW,
      }],
      tasks: [{ id: 'task-active', preferredAgentId: 'qa-1', agentId: 'qa-1', reviewRound: 1, status: 'review' }],
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

  it('does NOT roll back / remove worktree for a delivered task whose REPL was lost (freshRuntime=true, no marker)', async () => {
    const { removeSpy, watchSpy } = await runRecovery({
      agents: [{
        id: 'dev-1', taskId: 'task-1', startedAt: NOW,
        worktreePath: '/tmp/repo/.baxian-worktrees/task-1',
      }],
      tasks: [{ id: 'task-1' }],
      locks: ['dev-1'],
      ensureSession: { createdSession: true, freshRuntime: true },
    });

    expect(removeSpy).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.status).toBe('in_progress');
    expect((await agentStore.get('dev-1'))?.taskId).toBe('task-1');
    expect((await agentStore.get('dev-1'))?.worktreePath).toBe('/tmp/repo/.baxian-worktrees/task-1');
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

  it('removes the orphaned worktree before rolling back a mid-bootstrap recovery task (else re-dispatch hits a busy branch)', async () => {
    let boundWhenRemoved: string | undefined;
    const { removeSpy } = await runRecovery({
      agents: [{
        id: 'dev-1', taskId: 'task-1', startedAt: NOW, paneId: '%0',
        bootstrappingTaskId: 'task-1', worktreePath: '/tmp/repo/.baxian-worktrees/task-1',
      }],
      tasks: [{ id: 'task-1' }],
      locks: ['dev-1'],
      ensureSession: { paneId: '%0' },
      removeImpl: async () => { boundWhenRemoved = (await agentStore.get('dev-1'))?.taskId; },
    });

    expect(removeSpy).toHaveBeenCalledWith('/tmp/repo', '/tmp/repo/.baxian-worktrees/task-1');
    expect(boundWhenRemoved).toBe('task-1');
    await expectRolledBack('task-1', 'dev-1');
  });

  it('does NOT roll back a legacy in_progress binding (no bootstrap marker) on a live REPL — leaves worktree + binding intact', async () => {
    const { removeSpy, watchSpy } = await runRecovery({
      agents: [{
        id: 'dev-1', taskId: 'task-1', startedAt: NOW, paneId: '%0',
        worktreePath: '/tmp/repo/.baxian-worktrees/task-1',
      }],
      tasks: [{ id: 'task-1' }],
      locks: ['dev-1'],
    });

    expect(removeSpy).not.toHaveBeenCalled();
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
    const { removeSpy } = await runRecovery({
      agents: [{
        id: 'dev-1', taskId: 'task-1', startedAt: NOW, paneId: '%0',
        bootstrappingTaskId: 'task-1', worktreePath: '/tmp/repo/.baxian-worktrees/task-1',
      }],
      tasks: [{ id: 'task-1' }],
      locks: ['dev-1'],
      ensureSession: {
        reject: new EnsureSessionError({ createdSession: false, agentId: 'dev-1', dialogPending: true }, 'startup dialog'),
      },
    });

    expect(dialogSpy).not.toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalledWith('/tmp/repo', '/tmp/repo/.baxian-worktrees/task-1');
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
    const { removeSpy, watchSpy } = await runRecovery({
      agents: [{
        id: 'dev-1', taskId: 'task-1', startedAt: NOW, paneId: '%0',
        bootstrappingTaskId: 'task-1', worktreePath: '/tmp/repo/.baxian-worktrees/task-1',
      }],
      tasks: [{ id: 'task-1' }],
      emit: [{
        id: '', type: 'session.started', timestamp: new Date().toISOString(),
        projectId: 'proj', agentId: 'dev-1', taskId: 'task-1', data: { phase: 'develop' },
      }],
      locks: ['dev-1'],
    });

    expect(removeSpy).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.status).toBe('in_progress');
    const reattached = await agentStore.get('dev-1');
    expect(reattached?.taskId).toBe('task-1');
    expect(reattached?.bootstrappingTaskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    expect(watchSpy).toHaveBeenCalledWith('dev-1');
  });

  it('does NOT roll back a delivered task held on a failed marker-clear (bootstrap-marker-clear-failed)', async () => {
    const { removeSpy } = await runRecovery({
      agents: [{
        id: 'dev-1', taskId: 'task-1', startedAt: NOW, paneId: '%0',
        bootstrappingTaskId: 'task-1', status: 'awaiting_human', awaitingPhase: 'bootstrap-marker-clear-failed',
        awaitingReason: 'clear failed', awaitingSince: NOW,
        worktreePath: '/tmp/repo/.baxian-worktrees/task-1',
      }],
      tasks: [{ id: 'task-1' }],
      locks: ['dev-1'],
    });

    expect(removeSpy).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.status).toBe('in_progress');
    expect((await agentStore.get('dev-1'))?.taskId).toBe('task-1');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('clears unsafe runtime facts and fails active tasks when recovery cannot validate the session', async () => {
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
    expect((await taskStore.get('task-1'))?.status).toBe('failed');
    expect(await lockManager.isLocked('dev-1')).toBe(false);
    expect(events.some(e => e.type === 'human.intervention' && e.agentId === 'dev-1')).toBe(true);
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
    await seedTask({ id: 'task-approved', reviewRound: 1, status: 'approved' });
    await manager.setPostApproveCompletion('task-approved', {
      token: 'tok',
      approvedHeadSha: 'a'.repeat(40),
    });
    const watcher = {
      start: vi.fn(async () => true),
      stop: vi.fn(),
    };
    manager = new AgentManager({
      config: CONFIG,
      agentStore,
      taskStore,
      lockManager,
      eventBus: new EventBus(new EventLog(join(tempDir, 'events-2'))),
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => noopRunner(),
      postApproveStore: manager['postApproveStore'],
      phaseSignalWatcher: watcher as never,
    });

    await manager.setupRecoveredPostApproveSignals();

    expect(watcher.start).toHaveBeenCalledWith({
      taskId: 'task-approved',
      projectId: 'proj',
      agentId: 'dev-1',
      expectedKinds: 'pr-merge-ready',
      token: 'tok',
      skipSnapshot: false,
      recovered: true,
      onNeedInput: expect.any(Function),
    });
  });

  it('does not re-arm already merge-ready tasks with stale completion records', async () => {
    await seedTask({ id: 'task-merge-ready', reviewRound: 1, status: 'merge-ready' });
    await manager.setPostApproveCompletion('task-merge-ready', {
      token: 'tok',
      approvedHeadSha: 'a'.repeat(40),
    });
    const watcher = {
      start: vi.fn(async () => true),
      stop: vi.fn(),
    };
    manager = new AgentManager({
      config: CONFIG,
      agentStore,
      taskStore,
      lockManager,
      eventBus: new EventBus(new EventLog(join(tempDir, 'events-merge-ready'))),
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => noopRunner(),
      postApproveStore: manager['postApproveStore'],
      phaseSignalWatcher: watcher as never,
    });

    await manager.setupRecoveredPostApproveSignals();

    expect(watcher.start).not.toHaveBeenCalled();
  });

  it('replays a recovered pr-merge-ready snapshot for manual-merge projects', async () => {
    const token = 'posttok12345';
    await seedTask({ id: 'task-approved-manual', reviewRound: 1, status: 'approved' });
    await seedAgent({ id: 'dev-1', taskId: 'task-approved-manual', paneId: '%1' });
    await manager.setPostApproveCompletion('task-approved-manual', {
      token,
      approvedHeadSha: 'b'.repeat(40),
    });

    const manualConfig: BaxianConfig = {
      ...CONFIG,
      project: CONFIG.project.map(p => ({ ...p, merge: null })),
    };
    const eventsDir = join(tempDir, 'events-post-approve-manual');
    await mkdir(eventsDir, { recursive: true });
    const localBus = new EventBus(new EventLog(eventsDir));
    const watcher = new PhaseSignalWatcher({
      paneStreamerManager: snapshotPaneStreamerManager(`done\n${buildPhaseSignal('pr-merge-ready', token)}\n`),
      eventBus: localBus,
      resolveAgent: (id) => (
        id === 'dev-1' ? { ...CONFIG.project[0]!.agent[0]![0]!, projectId: 'proj' } : undefined
      ),
    });
    manager = new AgentManager({
      config: manualConfig,
      agentStore,
      taskStore,
      lockManager,
      eventBus: localBus,
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => noopRunner(),
      postApproveStore: manager['postApproveStore'],
      phaseSignalWatcher: watcher,
    });
    registerEventHandlers(localBus, manager);

    await manager.setupRecoveredPostApproveSignals();
    await waitForTaskStatus('task-approved-manual', 'merge-ready');

    expect((await taskStore.get('task-approved-manual'))?.status).toBe('merge-ready');
    await expect(manager.getPostApproveCompletion('task-approved-manual')).resolves.toBeNull();
  });
});

describe('setupRecoveredSpecSignals()', () => {
  async function buildManagerWithSpecWatcher() {
    const watcher = {
      start: vi.fn(async () => true),
      stop: vi.fn(),
      has: vi.fn(() => false),
    };
    const eventsDir = join(tempDir, 'events-spec');
    await mkdir(eventsDir, { recursive: true });
    const localBus = new EventBus(new EventLog(eventsDir));
    const localEvents: BaxianEvent[] = [];
    localBus.on('*', (event) => { localEvents.push(event); });
    manager = new AgentManager({
      config: CONFIG,
      agentStore,
      taskStore,
      lockManager,
      eventBus: localBus,
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => noopRunner(),
      postApproveStore: manager['postApproveStore'],
      phaseSignalWatcher: watcher as never,
    });
    return { watcher, events: localEvents };
  }

  it.each<[string, Partial<TaskState> & { id: string }, unknown]>([
    ['sets up spec-done|pr-created when phase is undefined (pre-spec-review) and status is in_progress',
      { id: 'task-1', signalToken: 'tok-ready' },
      {
        taskId: 'task-1', projectId: 'proj', agentId: 'dev-1',
        expectedKinds: ['spec-done', 'pr-created'], token: 'tok-ready',
        skipSnapshot: false, recovered: true, onNeedInput: expect.any(Function),
      }],
    ['sets up pr-created for code-phase tasks (dispatched after spec approval)',
      { id: 'task-code', phase: 'code', signalToken: 'tok-code' },
      {
        taskId: 'task-code', projectId: 'proj', agentId: 'dev-1',
        expectedKinds: ['pr-created'], token: 'tok-code', skipSnapshot: true, recovered: true,
        onNeedInput: expect.any(Function),
      }],
    ['sets up spec-reviewed for spec-phase review tasks',
      { id: 'task-2', qaAgentId: 'qa-1', specReviewRound: 1, phase: 'spec', signalToken: 'tok-review', status: 'review' },
      expect.objectContaining({
        taskId: 'task-2', projectId: 'proj', agentId: 'qa-1',
        expectedKinds: ['spec-reviewed'], token: 'tok-review',
        skipSnapshot: false, onReadFile: expect.any(Function), recovered: true,
      })],
    ['sets up spec-fixed for spec-phase fixing tasks',
      { id: 'task-3', qaAgentId: 'qa-1', specReviewRound: 1, phase: 'spec', signalToken: 'tok-fix', status: 'fixing' },
      {
        taskId: 'task-3', projectId: 'proj', agentId: 'dev-1',
        expectedKinds: ['spec-fixed'], token: 'tok-fix',
        skipSnapshot: false, recovered: true, onNeedInput: expect.any(Function),
      }],
    ['sets up pr-fixed for code-phase fixing tasks',
      { id: 'task-code-fix', qaAgentId: 'qa-1', reviewRound: 1, phase: 'code', signalToken: 'tok-prfix', status: 'fixing', prNumber: 60 },
      {
        taskId: 'task-code-fix', projectId: 'proj', agentId: 'dev-1',
        expectedKinds: ['pr-fixed'], token: 'tok-prfix',
        skipSnapshot: false, recovered: true, onNeedInput: expect.any(Function),
      }],
    ['sets up PR verdict-choice {pr-approved, pr-changes-requested} for review-phase tasks with qaAgentId',
      { id: 'task-pr-review', qaAgentId: 'qa-1', reviewRound: 1, status: 'review', signalToken: 'tok-verdict', prNumber: 50 },
      {
        taskId: 'task-pr-review', projectId: 'proj', agentId: 'qa-1',
        expectedKinds: ['pr-approved', 'pr-changes-requested'], token: 'tok-verdict',
        skipSnapshot: false, recovered: true, onNeedInput: expect.any(Function),
      }],
    ['sets up snapshot scan and read-file for github spec-review tasks',
      { id: 'task-gh-spec', qaAgentId: 'qa-1', specReviewRound: 1, status: 'review', phase: 'spec', reviewMode: 'github', signalToken: 'tok-spec' },
      expect.objectContaining({
        taskId: 'task-gh-spec', agentId: 'qa-1', expectedKinds: ['spec-reviewed'],
        skipSnapshot: false, onReadFile: expect.any(Function),
      })],
  ])('%s', async (_label, task, expectedArg) => {
    await seedTask(task);
    const { watcher } = await buildManagerWithSpecWatcher();

    await manager.setupRecoveredSpecSignals();

    expect(watcher.start).toHaveBeenCalledWith(expectedArg);
  });

  it.each<[string, Partial<TaskState> & { id: string }]>([
    ['skips tasks without signalToken', { id: 'task-4' }],
    ['skips terminal tasks even when signalToken is set', { id: 'task-5', signalToken: 'tok-stale', status: 'merged' }],
  ])('%s', async (_label, task) => {
    await seedTask(task);
    const { watcher } = await buildManagerWithSpecWatcher();

    await manager.setupRecoveredSpecSignals();

    expect(watcher.start).not.toHaveBeenCalled();
  });

  it('emits info intervention for each recovered spec-phase task', async () => {
    await seedTask({
      id: 'task-armed-1', qaAgentId: 'qa-1', specReviewRound: 1, phase: 'spec',
      signalToken: 'tok-armed-review', status: 'review',
    });
    await seedTask({
      id: 'task-armed-2', qaAgentId: 'qa-1', specReviewRound: 2, phase: 'spec',
      signalToken: 'tok-armed-fix', status: 'fixing',
    });
    const { watcher, events: localEvents } = await buildManagerWithSpecWatcher();

    await manager.setupRecoveredSpecSignals();

    expect(watcher.start).toHaveBeenCalledTimes(2);
    const setupInterventions = localEvents.filter(e =>
      e.type === 'human.intervention'
      && (e.data.phase as string) === 'spec-signal-setup-during-recovery',
    );
    expect(setupInterventions).toHaveLength(2);
    const taskIds = setupInterventions.map(e => e.taskId).sort();
    expect(taskIds).toEqual(['task-armed-1', 'task-armed-2']);
    const kinds = setupInterventions.map(e => e.data.kind as string).sort();
    expect(kinds).toEqual(['spec-fixed', 'spec-reviewed']);
  });

  it('skips snapshot and read-file for github code-phase tasks', async () => {
    await seedTask({
      id: 'task-gh-code', phase: 'code', reviewMode: 'github', signalToken: 'tok-code',
    });
    const { watcher } = await buildManagerWithSpecWatcher();

    await manager.setupRecoveredSpecSignals();

    const args = watcher.start.mock.calls[0][0] as Record<string, unknown>;
    expect(args.expectedKinds).toEqual(['pr-created']);
    expect(args.skipSnapshot).toBe(true);
    expect('onReadFile' in args).toBe(false);
  });

  it('does NOT emit intervention for pre-spec (spec-done|pr-created) recovered tasks', async () => {
    await seedTask({ id: 'task-pre-spec', signalToken: 'tok-pre-spec' });
    const { watcher, events: localEvents } = await buildManagerWithSpecWatcher();

    await manager.setupRecoveredSpecSignals();

    expect(watcher.start).toHaveBeenCalledTimes(1);
    expect(watcher.start.mock.calls[0]![0]).toMatchObject({
      expectedKinds: ['spec-done', 'pr-created'],
      token: 'tok-pre-spec',
    });
    const setupInterventions = localEvents.filter(e =>
      e.type === 'human.intervention'
      && (e.data.phase as string) === 'spec-signal-setup-during-recovery',
    );
    expect(setupInterventions).toHaveLength(0);
  });
});

describe('recover() deferred branches', () => {
  it('skips the post-merge redrive when the binding refresh does not land', async () => {
    await seedAgent({ id: 'dev-1', taskId: 'task-merged', paneId: '%0' });
    await seedTask({ id: 'task-merged', prNumber: 42, status: 'merged' });
    mockEnsureSessionOk();
    vi.spyOn(agentStore, 'update').mockImplementationOnce(async () => {});
    const cleanupSpy = vi.spyOn(manager, 'dispatchPostMergeCleanup').mockResolvedValue();
    vi.spyOn(WorktreeManager.prototype, 'remove').mockResolvedValue(undefined);

    await manager.recover();

    expect(cleanupSpy).not.toHaveBeenCalled();
  });

  it('falls through to the release path when the post-merge redrive throws', async () => {
    await seedAgent({ id: 'dev-1', taskId: 'task-merged', paneId: '%0' });
    await seedTask({ id: 'task-merged', prNumber: 42, status: 'merged' });
    await lockManager.acquire('dev-1');
    mockEnsureSessionOk();
    vi.spyOn(manager, 'dispatchPostMergeCleanup').mockRejectedValue(new Error('cleanup exploded'));
    vi.spyOn(WorktreeManager.prototype, 'remove').mockResolvedValue(undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await manager.recover();

    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('dispatchPostMergeCleanup'))).toBe(true);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
    warnSpy.mockRestore();
  });

  it('removes the reserved worktree when releasing a binding to a terminal task', async () => {
    const { removeSpy } = await runRecovery({
      agents: [{
        id: 'dev-1', taskId: 'task-dead', paneId: '%0',
        worktreePath: '/tmp/repo/.baxian-worktrees/wt',
      }],
      tasks: [{ id: 'task-dead', status: 'cancelled' }],
      locks: ['dev-1'],
    });

    expect(removeSpy).toHaveBeenCalledWith('/tmp/repo', '/tmp/repo/.baxian-worktrees/wt');
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('still releases the binding when the worktree removal fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runRecovery({
      agents: [{
        id: 'dev-1', taskId: 'task-dead', paneId: '%0',
        worktreePath: '/tmp/repo/.baxian-worktrees/wt',
      }],
      tasks: [{ id: 'task-dead', status: 'cancelled' }],
      locks: ['dev-1'],
      removeImpl: async () => { throw new Error('worktree locked'); },
    });

    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('worktree.remove failed'))).toBe(true);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
    warnSpy.mockRestore();
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

  it('rolls back an orphan session on recovery failure even when killSession fails, then fails the bound task', async () => {
    const killSpy = vi.spyOn(TmuxManager.prototype, 'killSession').mockRejectedValue(new Error('kill refused'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runRecovery({
      agents: [{ id: 'dev-1', taskId: 'task-1', paneId: '%0' }],
      tasks: [{ id: 'task-1' }],
      locks: ['dev-1'],
      ensureSession: {
        reject: new EnsureSessionError(
          { createdSession: true, agentId: 'dev-1' },
          'boot exploded mid-recovery',
        ),
      },
    });

    expect(killSpy).toHaveBeenCalledWith('dev-1');
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('killSession rollback failed'))).toBe(true);
    const state = await agentStore.get('dev-1');
    expect(state?.paneId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
    expect((await taskStore.get('task-1'))?.status).toBe('failed');
    expect(events.some(e => e.type === 'human.intervention'
      && (e.data as { phase?: string }).phase === 'recovery-failed')).toBe(true);
    warnSpy.mockRestore();
  });
});
