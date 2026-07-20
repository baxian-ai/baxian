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
import { BranchManager } from '../../src/agent/branch.js';
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
      { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local', workdir: '/tmp/qa-repo' },
      { id: 'research-1', runtime: 'claude-code', role: 'research', mode: 'local', workdir: '/tmp/research-repo' },
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

const REF = { sessionId: '$1', serverPid: '4242', serverStart: '1700000000' };

function noopRunner(): CommandRunner {
  return {
    exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
      const sessionName = cmd.match(/session_name},([^}]+)}/)?.[1];
      if (sessionName && cmd.includes('tmux list-sessions')) {
        return { stdout: `4242|1700000000|$1|${sessionName}\n`, stderr: '', exitCode: 0 };
      }
      const claim = cmd.match(/@baxian-agent-id},([^}]+)}/)?.[1];
      if (claim && cmd.includes('tmux list-panes')) {
        const runtime = claim === 'qa-1' ? 'codex' : 'claude';
        return { stdout: `%1 ${runtime}\n`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('display-message') && cmd.includes('pane_current_command')) {
        return { stdout: 'BX_PANE_OKclaude\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane')) {
        return { stdout: 'BX_PANE_OK\n⏵⏵ bypass permissions on /tmp/repo\n\n>', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
    writeFile: vi.fn(async (): Promise<void> => undefined),
  };
}

async function seedAgent(overrides: Partial<AgentBindingFacts> & { id: string }): Promise<void> {
  await agentStore.set({ projectId: 'proj', updatedAt: NOW, ...overrides });
  if (!overrides.taskId || await lockManager.isLocked(overrides.id)) return;
  const token = await lockManager.acquire(overrides.id, overrides.taskId);
  if (!token) return;
  await agentStore.update(overrides.id, latest => latest?.taskId === overrides.taskId
    ? { ...latest, lockToken: token, updatedAt: new Date().toISOString() }
    : latest);
}

function seedTask(overrides: Partial<TaskState> & { id: string }): Promise<void> {
  return taskStore.set({
    projectId: 'proj',
    title: 'T',
    description: 'D',
    preferredAgentId: 'dev-1',
    agentId: 'dev-1',
    devAgentId: 'dev-1',
    branch: `bx/${overrides.id}`,
    reviewRound: 0,
    status: 'in_progress',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
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
  for (const task of scenario.tasks ?? []) await seedTask(task);
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
  it('reclaims orphaned maintenance and task locks but preserves an exactly bound task lock', async () => {
    const maintenanceToken = await lockManager.acquire('dev-1', 'maintenance:branch-reconcile');
    const orphanedTaskToken = await lockManager.acquire('orphan-1', 'task-orphaned');
    await seedTask({ id: 'task-live', status: 'review', qaAgentId: 'qa-1' });
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
    await seedTask({ id: 'task-stale-lock' });
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

  it('redrives post-merge cleanup for a recovered merged-task binding', async () => {
    await seedAgent({ id: 'dev-1', taskId: 'task-merged', paneId: '%0' });
    await seedTask({ id: 'task-merged', prNumber: 42, reviewRound: 1, status: 'merged' });
    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%1',
      pane: { session: REF, paneId: '%1', claim: 'dev-1' }, sessionRef: REF, workdir: '/tmp/repo',
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
    ).mockImplementation(async (_tmux, _pane, agentId, taskId) => {
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
    ).mockImplementation(async (_tmux, _pane, agentId, taskId) => {
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

  it('rolls back an undelivered Research bootstrap without changing its stable participants', async () => {
    await runRecovery({
      agents: [{ id: 'research-1', taskId: 'task-research', bootstrappingTaskId: 'task-research' }],
      tasks: [{
        id: 'task-research',
        preferredAgentId: 'research-1',
        agentId: 'research-1',
        devAgentId: 'dev-1',
        researchAgentId: 'research-1',
        phase: 'research',
      }],
    });

    await expectRolledBack('task-research', 'research-1');
    expect(await taskStore.get('task-research')).toMatchObject({
      devAgentId: 'dev-1',
      researchAgentId: 'research-1',
      phase: 'research',
    });
  });

  it('releases a Dev bootstrap marker left behind before a spec-ready code transition', async () => {
    await runRecovery({
      agents: [{
        id: 'dev-1',
        taskId: 'task-spec-ready',
        bootstrappingTaskId: 'task-spec-ready',
        workdir: '/tmp/repo',
      }],
      tasks: [{
        id: 'task-spec-ready',
        preferredAgentId: 'research-1',
        agentId: 'research-1',
        devAgentId: 'dev-1',
        researchAgentId: 'research-1',
        phase: 'spec',
        status: 'spec-ready',
      }],
    });

    expect(await taskStore.get('task-spec-ready')).toMatchObject({
      status: 'spec-ready',
      agentId: 'research-1',
      devAgentId: 'dev-1',
    });
    expect(await agentStore.get('dev-1')).toMatchObject({ workdir: '/tmp/repo' });
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await agentStore.get('dev-1'))?.bootstrappingTaskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

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
    await seedTask({ id: 'task-1', signalToken: 'replay-tok-1' });
    vi.spyOn(manager, 'continueSession').mockResolvedValue(true);
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
    expect((await taskStore.get('task-1'))?.status).toBe('failed');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
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
    await seedTask({
      id: 'task-approved', reviewRound: 1, status: 'approved',
      postApproveHeadSha: 'a'.repeat(40),
    });
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
      needInputInherit: true,
      needInputSnapshotBlind: true,


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

  it('a stored completion without a persisted approved head is not re-armed', async () => {
    await seedTask({ id: 'task-approved-headless', reviewRound: 1, status: 'approved' });
    await manager.setPostApproveCompletion('task-approved-headless', {
      token: 'tok-a',
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
      eventBus: new EventBus(new EventLog(join(tempDir, 'events-headless'))),
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => noopRunner(),
      postApproveStore: manager['postApproveStore'],
      phaseSignalWatcher: watcher as never,
    });

    await manager.setupRecoveredPostApproveSignals();

    expect(watcher.start).not.toHaveBeenCalled();
    await expect(manager.getPostApproveCompletion('task-approved-headless')).resolves.toMatchObject({
      token: 'tok-a',
    });
  });

  it('a stored completion bound to another episode head is retired without re-arming', async () => {
    await seedTask({ id: 'task-approved-crossed', reviewRound: 1, status: 'approved' });
    await manager.setPostApproveCompletion('task-approved-crossed', {
      token: 'tok-a',
      approvedHeadSha: 'a'.repeat(40),
    });
    const seeded = await taskStore.get('task-approved-crossed');
    await taskStore.set({ ...seeded!, postApproveHeadSha: 'c'.repeat(40) });
    const watcher = {
      start: vi.fn(async () => true),
      stop: vi.fn(),
    };
    manager = new AgentManager({
      config: CONFIG,
      agentStore,
      taskStore,
      lockManager,
      eventBus: new EventBus(new EventLog(join(tempDir, 'events-crossed'))),
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => noopRunner(),
      postApproveStore: manager['postApproveStore'],
      phaseSignalWatcher: watcher as never,
    });

    await manager.setupRecoveredPostApproveSignals();

    expect(watcher.start).not.toHaveBeenCalled();
    await expect(manager.getPostApproveCompletion('task-approved-crossed')).resolves.toBeNull();
  });

  it('a leftover completion from a previous approved episode cannot push a rebooted approved task to merge-ready', async () => {
    const token = 'stalepasstok';
    // Episode A left its completion behind; episode B re-approved but crashed before persisting its head.
    await seedTask({ id: 'task-approved-leftover', reviewRound: 2, status: 'approved' });
    await seedAgent({ id: 'dev-1', taskId: 'task-approved-leftover', paneId: '%1' });
    await manager.setPostApproveCompletion('task-approved-leftover', {
      token,
      approvedHeadSha: 'a'.repeat(40),
    });

    const manualConfig: BaxianConfig = {
      ...CONFIG,
      project: CONFIG.project.map(p => ({ ...p, merge: null })),
    };
    const eventsDir = join(tempDir, 'events-post-approve-leftover');
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
    await new Promise(resolve => setTimeout(resolve, 100));

    expect((await taskStore.get('task-approved-leftover'))?.status).toBe('approved');
    await expect(manager.getPostApproveCompletion('task-approved-leftover')).resolves.toMatchObject({
      token,
    });
  });

  it('replays a recovered pr-merge-ready snapshot for manual-merge projects', async () => {
    const token = 'posttok12345';
    await seedTask({
      id: 'task-approved-manual', reviewRound: 1, status: 'approved',
      postApproveHeadSha: 'b'.repeat(40),
    });
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
    ['sets up spec-done|pr-created when Dev-SDD has not chosen a path yet',
      { id: 'task-1', signalToken: 'tok-ready' },
      {
        taskId: 'task-1', projectId: 'proj', agentId: 'dev-1',
        expectedKinds: ['spec-done', 'pr-created'], token: 'tok-ready',
        skipSnapshot: false, recovered: true, needInputInherit: true, needInputSnapshotBlind: true,       }],
    ['sets up spec-done for an in-progress Research task',
      {
        id: 'task-research',
        preferredAgentId: 'research-1',
        agentId: 'research-1',
        researchAgentId: 'research-1',
        phase: 'research',
        signalToken: 'tok-research',
      },
      {
        taskId: 'task-research', projectId: 'proj', agentId: 'research-1',
        expectedKinds: ['spec-done'], token: 'tok-research',
        skipSnapshot: false, recovered: true, needInputInherit: true, needInputSnapshotBlind: true,       }],
    ['sets up pr-created for code-phase tasks (dispatched after spec approval)',
      { id: 'task-code', phase: 'code', signalToken: 'tok-code' },
      {
        taskId: 'task-code', projectId: 'proj', agentId: 'dev-1',
        expectedKinds: ['pr-created'], token: 'tok-code', skipSnapshot: true, recovered: true,
        needInputInherit: true, needInputSnapshotBlind: true,
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
        skipSnapshot: false, recovered: true, needInputInherit: true, needInputSnapshotBlind: true,       }],
    ['sets up pr-fixed for code-phase fixing tasks',
      { id: 'task-code-fix', qaAgentId: 'qa-1', reviewRound: 1, phase: 'code', signalToken: 'tok-prfix', status: 'fixing', prNumber: 60 },
      {
        taskId: 'task-code-fix', projectId: 'proj', agentId: 'dev-1',
        expectedKinds: ['pr-fixed'], token: 'tok-prfix',
        skipSnapshot: false, recovered: true, needInputInherit: true, needInputSnapshotBlind: true,       }],
    ['sets up PR verdict-choice {pr-approved, pr-changes-requested} for review-phase tasks with qaAgentId',
      { id: 'task-pr-review', qaAgentId: 'qa-1', reviewRound: 1, status: 'review', signalToken: 'tok-verdict', prNumber: 50 },
      {
        taskId: 'task-pr-review', projectId: 'proj', agentId: 'qa-1',
        expectedKinds: ['pr-approved', 'pr-changes-requested'], token: 'tok-verdict',
        skipSnapshot: false, recovered: true, needInputInherit: true, needInputSnapshotBlind: true,       }],
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

  it('does not recover read-file for server code review without a known fallback mode', async () => {
    await seedTask({
      id: 'task-server-code-review',
      qaAgentId: 'qa-1',
      phase: 'code',
      reviewMode: 'server',
      status: 'review',
      reviewRound: 1,
      signalToken: 'tok-code-review',
    });
    const { watcher } = await buildManagerWithSpecWatcher();

    await manager.setupRecoveredSpecSignals();

    const args = watcher.start.mock.calls[0][0] as Record<string, unknown>;
    expect(args.expectedKinds).toEqual(['code-reviewed']);
    expect(args.skipSnapshot).toBe(false);
    expect('onReadFile' in args).toBe(false);
  });

  it('recovers read-file for server batch continuations', async () => {
    await seedTask({
      id: 'task-server-code-batch',
      qaAgentId: 'qa-1',
      phase: 'code',
      reviewMode: 'server',
      status: 'review',
      reviewRound: 1,
      batchIndex: 1,
      batchTotal: 2,
      signalToken: 'tok-code-batch',
    });
    const { watcher } = await buildManagerWithSpecWatcher();

    await manager.setupRecoveredSpecSignals();

    expect(watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      expectedKinds: ['code-reviewed'],
      onReadFile: expect.any(Function),
      skipSnapshot: false,
    }));
  });

  it('recovers read-file for a base-fallback server code review', async () => {
    await seedTask({
      id: 'task-server-code-base',
      qaAgentId: 'qa-1',
      phase: 'code',
      reviewMode: 'server',
      status: 'review',
      reviewRound: 1,
      reviewCheckoutMode: 'base',
      signalToken: 'tok-code-base',
    });
    const { watcher } = await buildManagerWithSpecWatcher();

    await manager.setupRecoveredSpecSignals();

    expect(watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      expectedKinds: ['code-reviewed'],
      onReadFile: expect.any(Function),
      skipSnapshot: false,
    }));
  });

  it('does NOT recover read-file for a head-mode server code review', async () => {
    await seedTask({
      id: 'task-server-code-head',
      qaAgentId: 'qa-1',
      phase: 'code',
      reviewMode: 'server',
      status: 'review',
      reviewRound: 1,
      reviewCheckoutMode: 'head',
      signalToken: 'tok-code-head',
    });
    const { watcher } = await buildManagerWithSpecWatcher();

    await manager.setupRecoveredSpecSignals();

    const args = watcher.start.mock.calls[0][0] as Record<string, unknown>;
    expect('onReadFile' in args).toBe(false);
  });

  it('does NOT emit intervention for recovered pre-spec Dev-SDD tasks', async () => {
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

    await manager.recover();

    expect(cleanupSpy).not.toHaveBeenCalled();
  });

  it('falls through to the release path when the post-merge redrive throws', async () => {
    await seedAgent({ id: 'dev-1', taskId: 'task-merged', paneId: '%0' });
    await seedTask({ id: 'task-merged', prNumber: 42, status: 'merged' });
    await acquireBoundLock('dev-1');
    mockEnsureSessionOk();
    vi.spyOn(manager, 'dispatchPostMergeCleanup').mockRejectedValue(new Error('cleanup exploded'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await manager.recover();

    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('dispatchPostMergeCleanup'))).toBe(true);
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

  it('holds the orphan binding on recovery failure even when killSession fails, then fails the bound task', async () => {
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
    expect((await taskStore.get('task-1'))?.status).toBe('failed');
    expect(events.some(e => e.type === 'human.intervention'
      && (e.data as { phase?: string }).phase === 'recovery-failed')).toBe(true);
    warnSpy.mockRestore();
  });
});
