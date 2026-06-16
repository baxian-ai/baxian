import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BaxianConfig, BaxianEvent } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
import { AgentManager, EnsureSessionError, canDispatchWithBinding } from '../../src/agent/manager.js';
import { WorktreeManager } from '../../src/agent/worktree.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';
import { AgentStore } from '../../src/state/agent-store.js';
import { TaskStore } from '../../src/state/task-store.js';
import { LockManager } from '../../src/state/lock.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
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
  await rm(tempDir, { recursive: true, force: true });
});

describe('recover()', () => {
  it('revalidates persisted bindings and clears creationToken on success', async () => {
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: 'task-1',
      // legacy binding: no bootstrappingTaskId → revalidate the live REPL, don't roll back
      creationToken: 'tok',
      updatedAt: NOW,
    });
    await taskStore.set({
      id: 'task-1',
      projectId: 'proj',
      title: 'T',
      description: 'D',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      branch: 'bx/task-1',
      reviewRound: 0,
      status: 'in_progress',
      createdAt: NOW,
      updatedAt: NOW,
    });
    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true,
      createdSession: false,
      freshRuntime: false,
      paneId: '%1',
      workdir: '/tmp/repo',
    });
    const watchSpy = vi.spyOn(manager, 'startRuntimeMenuWatch');

    await manager.recover();

    const state = await agentStore.get('dev-1');
    expect(state?.paneId).toBe('%1');
    expect(state?.creationToken).toBeUndefined();
    expect(state?.taskId).toBe('task-1');
    expect(watchSpy).toHaveBeenCalledWith('dev-1');
  });

  it('redrives post-merge cleanup for a recovered merged-task binding', async () => {
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: 'task-merged', paneId: '%0', updatedAt: NOW,
    });
    await taskStore.set({
      id: 'task-merged', projectId: 'proj', title: 'T', description: 'D',
      preferredAgentId: 'dev-1', agentId: 'dev-1', prNumber: 42, branch: 'bx/task-merged',
      reviewRound: 1, status: 'merged', createdAt: NOW, updatedAt: NOW,
    });
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
      prNumber: 42,
      taskId: 'task-merged',
      branch: 'bx/task-merged',
    });
    expect(paneIdSeenByCleanup).toBe('%1');
    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(canDispatchWithBinding(state)).toBe(true);
  });

  it('preserves Held state (status=awaiting_human + awaitingPhase/Reason/Since) when recovering an ack_unknown agent with active bound task', async () => {
    // REPL-ready doesn't prove the prompt finished; operator must keep Resume/cancel/DELETE. Only dialog_pending is resolved by recover.
    await agentStore.set({
      id: 'qa-1', projectId: 'proj',
      taskId: 'task-active', paneId: '%0',
      status: 'awaiting_human',
      awaitingPhase: 'dispatch-failed:ack_unknown',
      awaitingReason: 'simulated ack_unknown',
      awaitingSince: NOW,
      updatedAt: NOW,
    });
    await taskStore.set({
      id: 'task-active', projectId: 'proj',
      title: 'T', description: 'D', preferredAgentId: 'qa-1',
      agentId: 'qa-1', branch: 'bx/task-active', reviewRound: 1,
      status: 'review', // active
      createdAt: NOW, updatedAt: NOW,
    });
    await lockManager.acquire('qa-1');
    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%1', workdir: '/tmp/repo',
    });

    await manager.recover();

    const state = await agentStore.get('qa-1');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('dispatch-failed:ack_unknown');
    expect(state?.awaitingReason).toBe('simulated ack_unknown');
    expect(state?.awaitingSince).toBe(NOW);
    expect(state?.taskId).toBe('task-active');
    expect(state?.paneId).toBe('%1'); // pane 已刷新到 recover 探到的最新 id
    expect(await lockManager.isLocked('qa-1')).toBe(true);
  });

  it('preserves Held state for agent_dialog_pending + active bound task (crash window before task fail)', async () => {
    // Crash between markAwaitingHuman and transitionTaskStatus leaves a real Held state; recover must preserve it, not silently clear.
    await agentStore.set({
      id: 'dev-1', projectId: 'proj',
      taskId: 'task-active', paneId: '%0',
      status: 'awaiting_human',
      awaitingPhase: 'agent_dialog_pending',
      awaitingReason: 'CLI update notice',
      awaitingSince: NOW,
      updatedAt: NOW,
    });
    await taskStore.set({
      id: 'task-active', projectId: 'proj',
      title: 'T', description: 'D', preferredAgentId: 'dev-1',
      agentId: 'dev-1', branch: 'bx/task-active', reviewRound: 0,
      status: 'in_progress', // active
      createdAt: NOW, updatedAt: NOW,
    });
    await lockManager.acquire('dev-1');
    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%1', workdir: '/tmp/repo',
    });

    await manager.recover();

    const state = await agentStore.get('dev-1');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('agent_dialog_pending');
    expect(state?.awaitingReason).toBe('CLI update notice');
    expect(state?.taskId).toBe('task-active');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('clears Held state (status=ok) when recovering an agent_dialog_pending agent (recover dismissed the dialog)', async () => {
    // 对比测：agent_dialog_pending 是 recover 直接解决的 phase——ensureSession 成功 = dialog 已 dismissed → 切 ok。
    await agentStore.set({
      id: 'dev-1', projectId: 'proj',
      paneId: '%0',
      status: 'awaiting_human',
      awaitingPhase: 'agent_dialog_pending',
      awaitingReason: 'CLI update notice',
      awaitingSince: NOW,
      updatedAt: NOW,
    });
    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%1', workdir: '/tmp/repo',
    });

    await manager.recover();

    const state = await agentStore.get('dev-1');
    // status='ok' 在 normalizeBinding 内被规范化为 undefined（status 字段只存 awaiting_human）
    expect(state?.status).toBeUndefined();
    expect(state?.awaitingPhase).toBeUndefined();
    expect(state?.awaitingReason).toBeUndefined();
    expect(state?.awaitingSince).toBeUndefined();
  });

  it('rolls back a mid-bootstrap develop task even when recovery rebuilds a fresh REPL (marker set)', async () => {
    // Bootstrap crashed before ack AND the tmux session died: marker present → roll back regardless of
    // freshRuntime. Nothing ran (prompt never delivered), so there's no work to lose.
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', startedAt: NOW,
      bootstrappingTaskId: 'task-1', updatedAt: NOW,
    });
    await taskStore.set({
      id: 'task-1', projectId: 'proj', title: 'T', description: 'D',
      preferredAgentId: 'dev-1', agentId: 'dev-1', branch: 'bx/task-1', reviewRound: 0,
      status: 'in_progress', createdAt: NOW, updatedAt: NOW,
    });
    await lockManager.acquire('dev-1');
    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: true, freshRuntime: true, paneId: '%1', workdir: '/tmp/repo',
    });
    const watchSpy = vi.spyOn(manager, 'startRuntimeMenuWatch');

    await manager.recover();

    expect((await taskStore.get('task-1'))?.status).toBe('pending');
    expect((await taskStore.get('task-1'))?.agentId).toBe('');
    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
    expect(watchSpy).not.toHaveBeenCalled();
  });

  it('does NOT roll back / remove worktree for a delivered task whose REPL was lost (freshRuntime=true, no marker)', async () => {
    // Host reboot after the prompt was delivered (marker cleared): recover rebuilds a fresh REPL. Treating
    // freshRuntime as "missing" would `worktree remove --force` completed-but-unpushed work and re-dispatch.
    // The marker is absent, so leave the worktree + binding intact (the pre-existing recover behavior).
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', startedAt: NOW,
      worktreePath: '/tmp/repo/.baxian-worktrees/task-1', updatedAt: NOW,
      // delivered: no bootstrappingTaskId (cleared after ack)
    });
    await taskStore.set({
      id: 'task-1', projectId: 'proj', title: 'T', description: 'D',
      preferredAgentId: 'dev-1', agentId: 'dev-1', branch: 'bx/task-1', reviewRound: 0,
      status: 'in_progress', createdAt: NOW, updatedAt: NOW,
    });
    await lockManager.acquire('dev-1');
    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: true, freshRuntime: true, paneId: '%1', workdir: '/tmp/repo',
    });
    const removeSpy = vi.spyOn(WorktreeManager.prototype, 'remove').mockResolvedValue(undefined);
    const watchSpy = vi.spyOn(manager, 'startRuntimeMenuWatch');

    await manager.recover();

    expect(removeSpy).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.status).toBe('in_progress');
    expect((await agentStore.get('dev-1'))?.taskId).toBe('task-1');
    expect((await agentStore.get('dev-1'))?.worktreePath).toBe('/tmp/repo/.baxian-worktrees/task-1');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    expect(watchSpy).toHaveBeenCalledWith('dev-1');
  });

  it('rolls back an in_progress develop task whose live REPL is mid-bootstrap (bootstrappingTaskId set, never ack\'d)', async () => {
    // The new-dispatch gap: startSession wrote the running-binding (marking bootstrappingTaskId) + the REPL
    // went ready, then crashed BEFORE injectAndAwaitAck. On restart ensureSession adopts the live REPL
    // (freshRuntime=false), but the marker positively says the prompt never landed → roll back.
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', startedAt: NOW, paneId: '%0',
      bootstrappingTaskId: 'task-1', updatedAt: NOW,
    });
    await taskStore.set({
      id: 'task-1', projectId: 'proj', title: 'T', description: 'D',
      preferredAgentId: 'dev-1', agentId: 'dev-1', branch: 'bx/task-1', reviewRound: 0,
      status: 'in_progress', createdAt: NOW, updatedAt: NOW,
    });
    await lockManager.acquire('dev-1');
    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%0', workdir: '/tmp/repo',
    });
    const watchSpy = vi.spyOn(manager, 'startRuntimeMenuWatch');

    await manager.recover();

    expect((await taskStore.get('task-1'))?.status).toBe('pending');
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
    expect(watchSpy).not.toHaveBeenCalled();
  });

  it('removes the orphaned worktree before rolling back a mid-bootstrap recovery task (else re-dispatch hits a busy branch)', async () => {
    // startSession had already created+persisted the worktree (branch bx/task-1) and the bootstrap marker
    // before the crash. The rollback must `git worktree remove` it first — rollbackFailedDispatch only
    // drops the field — or the next dispatch's `git worktree add -B bx/task-1` fails on the busy branch.
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', startedAt: NOW, paneId: '%0',
      bootstrappingTaskId: 'task-1', worktreePath: '/tmp/repo/.baxian-worktrees/task-1', updatedAt: NOW,
    });
    await taskStore.set({
      id: 'task-1', projectId: 'proj', title: 'T', description: 'D',
      preferredAgentId: 'dev-1', agentId: 'dev-1', branch: 'bx/task-1', reviewRound: 0,
      status: 'in_progress', createdAt: NOW, updatedAt: NOW,
    });
    await lockManager.acquire('dev-1');
    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%0', workdir: '/tmp/repo',
    });
    let boundWhenRemoved: string | undefined;
    const removeSpy = vi.spyOn(WorktreeManager.prototype, 'remove').mockImplementation(async () => {
      // Capture binding at removal time to prove the worktree is gone BEFORE the binding is cleared.
      boundWhenRemoved = (await agentStore.get('dev-1'))?.taskId;
    });

    await manager.recover();

    expect(removeSpy).toHaveBeenCalledWith('/tmp/repo', '/tmp/repo/.baxian-worktrees/task-1');
    expect(boundWhenRemoved).toBe('task-1');
    expect((await taskStore.get('task-1'))?.status).toBe('pending');
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('does NOT roll back a legacy in_progress binding (no bootstrap marker) on a live REPL — leaves worktree + binding intact', async () => {
    // Rolling upgrade: a develop task dispatched by an older build has no bootstrappingTaskId, but its
    // prompt may be running in the still-live REPL that recover adopts (freshRuntime=false). Treating the
    // missing marker as "never delivered" would remove the worktree out from under the running prompt and
    // re-open the task for a duplicate dispatch — so recover must leave it alone and just re-attach.
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', startedAt: NOW, paneId: '%0',
      worktreePath: '/tmp/repo/.baxian-worktrees/task-1', updatedAt: NOW,
      // legacy: NO bootstrappingTaskId
    });
    await taskStore.set({
      id: 'task-1', projectId: 'proj', title: 'T', description: 'D',
      preferredAgentId: 'dev-1', agentId: 'dev-1', branch: 'bx/task-1', reviewRound: 0,
      status: 'in_progress', createdAt: NOW, updatedAt: NOW,
    });
    await lockManager.acquire('dev-1');
    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%1', workdir: '/tmp/repo',
    });
    const removeSpy = vi.spyOn(WorktreeManager.prototype, 'remove').mockResolvedValue(undefined);
    const watchSpy = vi.spyOn(manager, 'startRuntimeMenuWatch');

    await manager.recover();

    expect(removeSpy).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.status).toBe('in_progress');
    expect((await taskStore.get('task-1'))?.agentId).toBe('dev-1');
    expect((await agentStore.get('dev-1'))?.taskId).toBe('task-1');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    expect(watchSpy).toHaveBeenCalledWith('dev-1');
  });

  it('rolls back a mid-bootstrap task that comes back blocked on a startup dialog (not held forever)', async () => {
    // recover()'s ensureSession throws dialogPending. The marker says the prompt was never ack'd, and an
    // active task can't be Resumed past a dialog — so roll back instead of markDialogPending; the
    // re-dispatch handles the dialog fresh.
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', startedAt: NOW, paneId: '%0',
      bootstrappingTaskId: 'task-1', worktreePath: '/tmp/repo/.baxian-worktrees/task-1', updatedAt: NOW,
    });
    await taskStore.set({
      id: 'task-1', projectId: 'proj', title: 'T', description: 'D',
      preferredAgentId: 'dev-1', agentId: 'dev-1', branch: 'bx/task-1', reviewRound: 0,
      status: 'in_progress', createdAt: NOW, updatedAt: NOW,
    });
    await lockManager.acquire('dev-1');
    vi.spyOn(manager, 'ensureSession').mockRejectedValue(
      new EnsureSessionError({ createdSession: false, agentId: 'dev-1', dialogPending: true }, 'startup dialog'),
    );
    const removeSpy = vi.spyOn(WorktreeManager.prototype, 'remove').mockResolvedValue(undefined);
    const dialogSpy = vi.spyOn(
      manager as never as { markDialogPending: (...a: unknown[]) => Promise<void> }, 'markDialogPending',
    ).mockResolvedValue(undefined);

    await manager.recover();

    expect(dialogSpy).not.toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalledWith('/tmp/repo', '/tmp/repo/.baxian-worktrees/task-1');
    expect((await taskStore.get('task-1'))?.status).toBe('pending');
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('rolls back a mid-bootstrap task previously held on a dialog once its REPL recovers (marker still set)', async () => {
    // Held agent_dialog_pending + marker present (never ack'd): once the dialog resolves (ensureSession ok),
    // the awaiting_human state must not shield the confirmed-undelivered marker from rollback.
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', startedAt: NOW, paneId: '%0',
      bootstrappingTaskId: 'task-1', status: 'awaiting_human', awaitingPhase: 'agent_dialog_pending',
      awaitingReason: 'CLI update notice', awaitingSince: NOW, updatedAt: NOW,
    });
    await taskStore.set({
      id: 'task-1', projectId: 'proj', title: 'T', description: 'D',
      preferredAgentId: 'dev-1', agentId: 'dev-1', branch: 'bx/task-1', reviewRound: 0,
      status: 'in_progress', createdAt: NOW, updatedAt: NOW,
    });
    await lockManager.acquire('dev-1');
    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%1', workdir: '/tmp/repo',
    });

    await manager.recover();

    expect((await taskStore.get('task-1'))?.status).toBe('pending');
    const rolled = await agentStore.get('dev-1');
    expect(rolled?.taskId).toBeUndefined();
    // Held state must be cleared too, else the now-unbound agent stays non-dispatchable (no Resume needed).
    expect(rolled?.status).toBeUndefined();
    expect(rolled?.awaitingPhase).toBeUndefined();
    expect(canDispatchWithBinding(rolled)).toBe(true);
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('does NOT roll back a mid-bootstrap task when a session.started event proves delivery (stale marker)', async () => {
    // The marker-clear and its held fallback both failed after the prompt was delivered, leaving a stale
    // marker. The session.started event lives in a separate log (durable proof) — recover must not
    // re-dispatch a running prompt; it clears the stale marker and re-attaches.
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', startedAt: NOW, paneId: '%0',
      bootstrappingTaskId: 'task-1', worktreePath: '/tmp/repo/.baxian-worktrees/task-1', updatedAt: NOW,
    });
    await taskStore.set({
      id: 'task-1', projectId: 'proj', title: 'T', description: 'D',
      preferredAgentId: 'dev-1', agentId: 'dev-1', branch: 'bx/task-1', reviewRound: 0,
      status: 'in_progress', createdAt: NOW, updatedAt: NOW,
    });
    await eventBus.emit({
      id: '', type: 'session.started', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1', data: { phase: 'develop' },
    });
    await lockManager.acquire('dev-1');
    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%1', workdir: '/tmp/repo',
    });
    const removeSpy = vi.spyOn(WorktreeManager.prototype, 'remove').mockResolvedValue(undefined);
    const watchSpy = vi.spyOn(manager, 'startRuntimeMenuWatch');

    await manager.recover();

    expect(removeSpy).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.status).toBe('in_progress');
    const reattached = await agentStore.get('dev-1');
    expect(reattached?.taskId).toBe('task-1');
    expect(reattached?.bootstrappingTaskId).toBeUndefined(); // stale marker cleared
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    expect(watchSpy).toHaveBeenCalledWith('dev-1');
  });

  it('does NOT roll back a delivered task held on a failed marker-clear (bootstrap-marker-clear-failed)', async () => {
    // Marker present but the hold phase says the prompt WAS delivered (clear write blipped) — its prompt is
    // running, so preserve the binding + worktree; recover must not treat it as never-delivered.
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', startedAt: NOW, paneId: '%0',
      bootstrappingTaskId: 'task-1', status: 'awaiting_human', awaitingPhase: 'bootstrap-marker-clear-failed',
      awaitingReason: 'clear failed', awaitingSince: NOW,
      worktreePath: '/tmp/repo/.baxian-worktrees/task-1', updatedAt: NOW,
    });
    await taskStore.set({
      id: 'task-1', projectId: 'proj', title: 'T', description: 'D',
      preferredAgentId: 'dev-1', agentId: 'dev-1', branch: 'bx/task-1', reviewRound: 0,
      status: 'in_progress', createdAt: NOW, updatedAt: NOW,
    });
    await lockManager.acquire('dev-1');
    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%1', workdir: '/tmp/repo',
    });
    const removeSpy = vi.spyOn(WorktreeManager.prototype, 'remove').mockResolvedValue(undefined);

    await manager.recover();

    expect(removeSpy).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.status).toBe('in_progress');
    expect((await agentStore.get('dev-1'))?.taskId).toBe('task-1');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('clears unsafe runtime facts and fails active tasks when recovery cannot validate the session', async () => {
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: 'task-1',
      paneId: '%0',
      creationToken: 'tok',
      updatedAt: NOW,
    });
    await taskStore.set({
      id: 'task-1',
      projectId: 'proj',
      title: 'T',
      description: 'D',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      branch: 'bx/task-1',
      reviewRound: 0,
      status: 'in_progress',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await lockManager.acquire('dev-1');
    vi.spyOn(manager, 'ensureSession').mockRejectedValue(
      new EnsureSessionError({ createdSession: false, agentId: 'dev-1' }, 'session claim mismatch'),
    );

    await manager.recover();

    const state = await agentStore.get('dev-1');
    expect(state?.paneId).toBeUndefined();
    expect(state?.creationToken).toBeUndefined();
    expect((await taskStore.get('task-1'))?.status).toBe('failed');
    expect(await lockManager.isLocked('dev-1')).toBe(false);
    expect(events.some(e => e.type === 'human.intervention' && e.agentId === 'dev-1')).toBe(true);
  });
});

describe('setupRecoveredPostApproveSignals()', () => {
  it('sets up approved tasks with stored completion records', async () => {
    await taskStore.set({
      id: 'task-approved',
      projectId: 'proj',
      title: 'T',
      description: 'D',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      branch: 'bx/task-approved',
      reviewRound: 1,
      status: 'approved',
      createdAt: NOW,
      updatedAt: NOW,
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
    });
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

  it('sets up spec-done|pr-created when phase is undefined (pre-spec-review) and status is in_progress', async () => {
    await taskStore.set({
      id: 'task-1',
      projectId: 'proj',
      title: 'T',
      description: 'D',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      branch: 'bx/task-1',
      reviewRound: 0,
      status: 'in_progress',
      signalToken: 'tok-ready',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const { watcher } = await buildManagerWithSpecWatcher();

    await manager.setupRecoveredSpecSignals();

    expect(watcher.start).toHaveBeenCalledWith({
      taskId: 'task-1',
      projectId: 'proj',
      agentId: 'dev-1',
      expectedKinds: ['spec-done', 'pr-created'],
      token: 'tok-ready',
      // pre-spec spec-done has only the pane channel (no poller backstop, agents
      // don't re-emit), so the snapshot must be scanned on recovery.
      skipSnapshot: false,
      recovered: true,
    });
  });

  it('sets up pr-created for code-phase tasks (dispatched after spec approval)', async () => {
    await taskStore.set({
      id: 'task-code',
      projectId: 'proj',
      title: 'T',
      description: 'D',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      branch: 'bx/task-code',
      reviewRound: 0,
      status: 'in_progress',
      phase: 'code',
      signalToken: 'tok-code',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const { watcher } = await buildManagerWithSpecWatcher();

    await manager.setupRecoveredSpecSignals();

    expect(watcher.start).toHaveBeenCalledWith({
      taskId: 'task-code',
      projectId: 'proj',
      agentId: 'dev-1',
      expectedKinds: ['pr-created'],
      token: 'tok-code',
      skipSnapshot: true,
      recovered: true,
    });
  });

  it('sets up spec-reviewed for spec-phase review tasks', async () => {
    await taskStore.set({
      id: 'task-2',
      projectId: 'proj',
      title: 'T',
      description: 'D',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      qaAgentId: 'qa-1',
      branch: 'bx/task-2',
      reviewRound: 0,
      specReviewRound: 1,
      phase: 'spec',
      signalToken: 'tok-review',
      status: 'review',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const { watcher } = await buildManagerWithSpecWatcher();

    await manager.setupRecoveredSpecSignals();

    expect(watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-2',
      projectId: 'proj',
      agentId: 'qa-1',
      expectedKinds: ['spec-reviewed'],
      token: 'tok-review',
      // spec phase always uses server protocol (pane signals are the only verdict
      // channel — no poller backstop), so snapshot scan and read-file are enabled.
      skipSnapshot: false,
      onReadFile: expect.any(Function),
      recovered: true,
    }));
  });

  it('sets up spec-fixed for spec-phase fixing tasks', async () => {
    await taskStore.set({
      id: 'task-3',
      projectId: 'proj',
      title: 'T',
      description: 'D',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      qaAgentId: 'qa-1',
      branch: 'bx/task-3',
      reviewRound: 0,
      specReviewRound: 1,
      phase: 'spec',
      signalToken: 'tok-fix',
      status: 'fixing',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const { watcher } = await buildManagerWithSpecWatcher();

    await manager.setupRecoveredSpecSignals();

    expect(watcher.start).toHaveBeenCalledWith({
      taskId: 'task-3',
      projectId: 'proj',
      agentId: 'dev-1',
      expectedKinds: ['spec-fixed'],
      token: 'tok-fix',
      // spec phase always uses server protocol — scan snapshot on recovery.
      skipSnapshot: false,
      recovered: true,
    });
  });

  it('sets up pr-fixed for code-phase fixing tasks', async () => {
    await taskStore.set({
      id: 'task-code-fix',
      projectId: 'proj',
      title: 'T',
      description: 'D',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      qaAgentId: 'qa-1',
      branch: 'bx/task-code-fix',
      reviewRound: 1,
      phase: 'code',
      signalToken: 'tok-prfix',
      status: 'fixing',
      prNumber: 60,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const { watcher } = await buildManagerWithSpecWatcher();

    await manager.setupRecoveredSpecSignals();

    expect(watcher.start).toHaveBeenCalledWith({
      taskId: 'task-code-fix',
      projectId: 'proj',
      agentId: 'dev-1',
      expectedKinds: ['pr-fixed'],
      token: 'tok-prfix',
      // pr-fixed is a one-shot completion signal: scan snapshot on recovery so an
      // already-echoed signal isn't lost (handler is replay-safe via token+status).
      skipSnapshot: false,
      recovered: true,
    });
  });

  it('sets up PR verdict-choice {pr-approved, pr-changes-requested} for review-phase tasks with qaAgentId', async () => {
    await taskStore.set({
      id: 'task-pr-review',
      projectId: 'proj',
      title: 'T',
      description: 'D',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      qaAgentId: 'qa-1',
      branch: 'bx/task-pr-review',
      reviewRound: 1,
      // phase undefined or 'code' is both fine; 'spec' is excluded.
      status: 'review',
      signalToken: 'tok-verdict',
      prNumber: 50,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const { watcher } = await buildManagerWithSpecWatcher();

    await manager.setupRecoveredSpecSignals();

    expect(watcher.start).toHaveBeenCalledWith({
      taskId: 'task-pr-review',
      projectId: 'proj',
      agentId: 'qa-1',
      expectedKinds: ['pr-approved', 'pr-changes-requested'],
      token: 'tok-verdict',
      // PR verdict recovery scans the snapshot: QA may have echoed before
      // review.submitted persisted, so we re-read scrollback (token rotation
      // gates stale verdicts). Other phases stay skipSnapshot=true.
      skipSnapshot: false,
      recovered: true,
    });
  });

  it('skips tasks without signalToken', async () => {
    await taskStore.set({
      id: 'task-4',
      projectId: 'proj',
      title: 'T',
      description: 'D',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      branch: 'bx/task-4',
      reviewRound: 0,
      status: 'in_progress',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const { watcher } = await buildManagerWithSpecWatcher();

    await manager.setupRecoveredSpecSignals();

    expect(watcher.start).not.toHaveBeenCalled();
  });

  it('skips terminal tasks even when signalToken is set', async () => {
    await taskStore.set({
      id: 'task-5',
      projectId: 'proj',
      title: 'T',
      description: 'D',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      branch: 'bx/task-5',
      reviewRound: 0,
      signalToken: 'tok-stale',
      status: 'merged',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const { watcher } = await buildManagerWithSpecWatcher();

    await manager.setupRecoveredSpecSignals();

    expect(watcher.start).not.toHaveBeenCalled();
  });

  it('emits info intervention for each recovered spec-phase task', async () => {
    await taskStore.set({
      id: 'task-armed-1',
      projectId: 'proj',
      title: 'T',
      description: 'D',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      qaAgentId: 'qa-1',
      branch: 'bx/task-armed-1',
      reviewRound: 0,
      specReviewRound: 1,
      phase: 'spec',
      signalToken: 'tok-armed-review',
      status: 'review',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await taskStore.set({
      id: 'task-armed-2',
      projectId: 'proj',
      title: 'T',
      description: 'D',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      qaAgentId: 'qa-1',
      branch: 'bx/task-armed-2',
      reviewRound: 0,
      specReviewRound: 2,
      phase: 'spec',
      signalToken: 'tok-armed-fix',
      status: 'fixing',
      createdAt: NOW,
      updatedAt: NOW,
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

  it('sets up snapshot scan and read-file for github spec-review tasks', async () => {
    await taskStore.set({
      id: 'task-gh-spec', projectId: 'proj', title: 'T', description: 'D',
      preferredAgentId: 'dev-1', agentId: 'dev-1', qaAgentId: 'qa-1',
      branch: 'bx/task-gh-spec', reviewRound: 0, specReviewRound: 1,
      status: 'review', phase: 'spec', reviewMode: 'github',
      signalToken: 'tok-spec', createdAt: NOW, updatedAt: NOW,
    });
    const { watcher } = await buildManagerWithSpecWatcher();

    await manager.setupRecoveredSpecSignals();

    expect(watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-gh-spec',
      agentId: 'qa-1',
      expectedKinds: ['spec-reviewed'],
      skipSnapshot: false,
      onReadFile: expect.any(Function),
    }));
  });

  it('skips snapshot and read-file for github code-phase tasks', async () => {
    await taskStore.set({
      id: 'task-gh-code', projectId: 'proj', title: 'T', description: 'D',
      preferredAgentId: 'dev-1', agentId: 'dev-1',
      branch: 'bx/task-gh-code', reviewRound: 0,
      status: 'in_progress', phase: 'code', reviewMode: 'github',
      signalToken: 'tok-code', createdAt: NOW, updatedAt: NOW,
    });
    const { watcher } = await buildManagerWithSpecWatcher();

    await manager.setupRecoveredSpecSignals();

    // 唯一任务 → calls[0] 稳定；objectContaining 无法断言键不存在，需 raw access。
    const args = watcher.start.mock.calls[0][0] as Record<string, unknown>;
    expect(args.expectedKinds).toEqual(['pr-created']);
    expect(args.skipSnapshot).toBe(true);
    expect('onReadFile' in args).toBe(false);
  });

  it('does NOT emit intervention for pre-spec (spec-done|pr-created) recovered tasks', async () => {
    await taskStore.set({
      id: 'task-pre-spec',
      projectId: 'proj',
      title: 'T',
      description: 'D',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      branch: 'bx/task-pre-spec',
      reviewRound: 0,
      status: 'in_progress',
      signalToken: 'tok-pre-spec',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const { watcher, events: localEvents } = await buildManagerWithSpecWatcher();

    await manager.setupRecoveredSpecSignals();

    // watcher 应 set up spec-done|pr-created (auto fire 仍可工作)。
    expect(watcher.start).toHaveBeenCalledTimes(1);
    expect(watcher.start.mock.calls[0]![0]).toMatchObject({
      expectedKinds: ['spec-done', 'pr-created'],
      token: 'tok-pre-spec',
    });
    // 但 intervention 不应 emit — pre-spec 阶段等不到 signal 不算 stuck。
    const setupInterventions = localEvents.filter(e =>
      e.type === 'human.intervention'
      && (e.data.phase as string) === 'spec-signal-setup-during-recovery',
    );
    expect(setupInterventions).toHaveLength(0);
  });
});
