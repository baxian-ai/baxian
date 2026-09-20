import { describe, it, expect, vi } from 'vitest';
import type { AgentBindingFacts, TaskState } from '../../src/shared/index.js';
import { ReplNotReadyError } from '../../src/agent/tmux.js';
import { BranchManager } from '../../src/agent/branch.js';
import { createManagerSuiteRunner, useManagerSuiteHarness } from '../helpers/manager-harness.js';
import { RUNTIME_PROFILES, type FakeRunner, type FakeRunnerRule } from '../helpers/fake-runner.js';
import { makeTask } from '../helpers/fixtures.js';

const NOW = '2026-04-28T10:00:00Z';

const harness = useManagerSuiteHarness();

const cmdsOf = (runner: FakeRunner): string[] => runner.exec.mock.calls.map(c => String(c[0]));
const cmds = (): string[] => cmdsOf(harness.runner);
const ctrlCs = (): string[] => harness.runner.sentKeys.filter(k => k.includes('C-c'));
const interventionPhases = (): string[] => harness.events
  .filter(e => e.type === 'human.intervention')
  .map(e => String((e.data as { phase?: string }).phase));

// 静态忙碌帧不随 capture 回落,release 的 ready 等待只能超时;节拍压到 10ms
function markBusy(agentId: 'dev-1' | 'qa-1'): void {
  const runtime = agentId === 'dev-1' ? 'claude-code' : 'codex';
  harness.runner.sessions.markWorking(agentId, RUNTIME_PROFILES[runtime].workingFrame);
  harness.manager = harness.createManager({ cleanComposerWaitMs: 10 });
}

function useRuledRunner(rules: FakeRunnerRule[]): () => void {
  return () => {
    harness.manager = harness.createManager({ runnerFactory: () => createManagerSuiteRunner({ rules }) });
  };
}

async function seedActiveBinding(): Promise<void> {
  await harness.taskStore.set(makeTask({
    id: 'task-001',
    phase: 'code',
    platformBinding: undefined,
    createdAt: NOW,
    updatedAt: NOW,
  }));
  await harness.agentStore.set({
    id: 'dev-1',
    projectId: 'proj',
    taskId: 'task-001',
    workdir: '/tmp/repo',
    paneId: '%0',
    startedAt: NOW,
    updatedAt: NOW,
  });
  await harness.lockManager.acquire('dev-1', 'task-001');
}

function rewriteDevDuringBranchCleanup(patch: Partial<AgentBindingFacts>): void {
  vi.spyOn(BranchManager.prototype, 'cleanupTaskBranch').mockImplementation(async () => {
    await harness.agentStore.update('dev-1', state => (state
      ? { ...state, ...patch, updatedAt: new Date().toISOString() }
      : state));
    return { status: 'deleted' };
  });
}

describe('releaseAgentForTask binding transitions', () => {
  it('waiting mode keeps the task binding and lock after the ready gate passes', async () => {
    await seedActiveBinding();
    expect((await harness.agentStore.get('dev-1'))?.lockToken).toBeUndefined();

    expect(await harness.manager.releaseAgentForTask('dev-1', 'task-001', 'waiting')).toBe(true);

    const state = await harness.agentStore.get('dev-1');
    expect(state?.taskId).toBe('task-001');
    expect(state?.lockToken).toEqual(expect.any(String));
    expect(state?.workdir).toBe('/tmp/repo');
    expect(state?.startedAt).toBe(NOW);
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });

  it('idle mode clears the task binding, keeps the fixed Workdir, and releases the lock', async () => {
    await seedActiveBinding();

    expect(await harness.manager.releaseAgentForTask('dev-1', 'task-001', 'idle')).toBe(true);

    const state = await harness.agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(state?.workdir).toBe('/tmp/repo');
    expect(state?.startedAt).toBeUndefined();
    expect(state?.paneId).toBe('%0');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
    expect(ctrlCs()).toEqual([]);
  });

  it('idle mode preserves the latest pane fact from the update closure', async () => {
    await seedActiveBinding();
    rewriteDevDuringBranchCleanup({ paneId: '%9' });

    expect(await harness.manager.releaseAgentForTask('dev-1', 'task-001', 'idle')).toBe(true);

    const state = await harness.agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(state?.startedAt).toBeUndefined();
    expect(state?.paneId).toBe('%9');
    expect(state?.workdir).toBe('/tmp/repo');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
  });

  it('idle mode holds when Workdir changes during checkout cleanup', async () => {
    await seedActiveBinding();
    rewriteDevDuringBranchCleanup({ workdir: '/tmp/repo-new' });

    expect(await harness.manager.releaseAgentForTask('dev-1', 'task-001', 'idle')).toBe(false);

    expect(await harness.agentStore.get('dev-1')).toMatchObject({
      taskId: 'task-001',
      workdir: '/tmp/repo-new',
      status: 'awaiting_human',
      awaitingPhase: 'branch-cleanup-pending',
    });
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
    expect(interventionPhases()).toContain('branch-cleanup-pending');
  });

  it('absent-tmux reconciliation holds the binding without deadlocking against a waiting transition', async () => {
    await seedActiveBinding();
    harness.runner.sessions.drop('dev-1');

    const release = harness.manager.releaseAgentForTask('dev-1', 'task-001', 'waiting');
    const reconcile = harness.manager.reconcileFailedAgent('dev-1');
    await Promise.all([release, reconcile]);

    const state = await harness.agentStore.get('dev-1');
    expect(state?.taskId).toBe('task-001');
    expect(state).toMatchObject({ status: 'awaiting_human', awaitingPhase: 'runtime-missing' });
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
    expect((await harness.taskStore.get('task-001'))?.status).toBe('failed');
  });

  it('idle release proceeds without a pane after confirming the tmux session is absent', async () => {
    await seedActiveBinding();
    await harness.agentStore.update('dev-1', state => ({ ...state!, paneId: undefined }));
    harness.runner.sessions.drop('dev-1');

    expect(await harness.manager.releaseAgentForTask('dev-1', 'task-001', 'idle')).toBe(true);

    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
    expect(cmds().some(c => c.includes("has-session -t '=dev-1'"))).toBe(true);
  });

  it('idle release treats a persisted pane as stale when the tmux session is absent', async () => {
    await seedActiveBinding();
    harness.runner.sessions.drop('dev-1');

    expect(await harness.manager.releaseAgentForTask('dev-1', 'task-001', 'idle')).toBe(true);

    const state = await harness.agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(state?.paneId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
    expect(cmds().some(cmd => cmd.includes("-t '%0'"))).toBe(false);
  });

  it('idle release replaces a stale persisted pane with the unique live pane in the claimed session', async () => {
    await seedActiveBinding();
    const runner = createManagerSuiteRunner({ agents: { 'dev-1': { paneId: '%9' } } });
    harness.manager = harness.createManager({ runnerFactory: () => runner });

    expect(await harness.manager.releaseAgentForTask('dev-1', 'task-001', 'idle')).toBe(true);

    const state = await harness.agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(state?.paneId).toBe('%9');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
    expect(cmdsOf(runner).some(cmd => cmd.includes("-t '%9'"))).toBe(true);
    expect(cmdsOf(runner).some(cmd => cmd.includes("-t '%0'"))).toBe(false);
  });

  it.each([
    ['zero panes', () => harness.runner.sessions.dropPane('dev-1', '%0')],
    // 外部 split-window:模型只持有单 pane,多 pane 只能由 list-panes 回包造出
    ['multiple panes', useRuledRunner([{ match: 'tmux list-panes', reply: { stdout: '%0 claude\n%10 zsh\n' } }])],
    ['claim mismatch', () => harness.runner.sessions.reclaim('dev-1', 'other-agent')],
    ['session probe error', useRuledRunner([{ match: 'tmux has-session', reply: { stderr: 'ssh: connection timed out', exitCode: 255 } }])],
    ['claim probe error', useRuledRunner([{ match: 'tmux list-sessions', reply: { stderr: 'tmux probe failed', exitCode: 2 } }])],
    ['pane probe error', useRuledRunner([{ match: 'tmux list-panes', reply: { stderr: 'tmux list failed', exitCode: 2 } }])],
  ])('idle release holds on %s', async (_label, arrange) => {
    await seedActiveBinding();
    arrange();

    expect(await harness.manager.releaseAgentForTask('dev-1', 'task-001', 'idle')).toBe(false);

    expect(await harness.agentStore.get('dev-1')).toMatchObject({
      taskId: 'task-001',
      paneId: '%0',
      status: 'awaiting_human',
      awaitingPhase: 'branch-cleanup-pending',
    });
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
    expect(BranchManager.prototype.cleanupTaskBranch).not.toHaveBeenCalled();
    expect(interventionPhases()).toEqual(['branch-cleanup-pending']);
  });

  it('stops before checkout cleanup when task ownership rotates during pane validation', async () => {
    await seedActiveBinding();
    const originalClaim = await harness.lockManager.claimOf('dev-1');
    await harness.agentStore.update('dev-1', latest => ({
      ...latest!,
      lockToken: originalClaim!.token,
      updatedAt: new Date().toISOString(),
    }));
    const state = (await harness.agentStore.get('dev-1'))!;
    let rotated = false;
    const runner = createManagerSuiteRunner({
      agents: { 'dev-1': { paneId: '%9' } },
      onExec: async (cmd) => {
        if (rotated || !cmd.includes('tmux list-panes')) return;
        rotated = true;
        await harness.lockManager.releaseIfOwner('dev-1', 'task-001', state.lockToken!);
        const nextToken = await harness.lockManager.acquire('dev-1', 'task-next');
        await harness.agentStore.update('dev-1', latest => ({
          ...latest!,
          taskId: 'task-next',
          lockToken: nextToken!,
          workdir: '/tmp/repo-next',
          updatedAt: new Date().toISOString(),
        }));
      },
    });
    harness.manager = harness.createManager({ runnerFactory: () => runner });

    expect(await harness.manager.releaseAgentForTask('dev-1', 'task-001', 'idle')).toBe(false);

    expect(rotated).toBe(true);
    expect(await harness.agentStore.get('dev-1')).toMatchObject({
      taskId: 'task-next',
      workdir: '/tmp/repo-next',
      paneId: '%0',
    });
    expect(await harness.lockManager.ownerOf('dev-1')).toBe('task-next');
    expect(BranchManager.prototype.cleanupTaskBranch).not.toHaveBeenCalled();
  });
});

describe('releaseAgentForTask does not interrupt the REPL', () => {
  it('idle release on busy pane: keeps binding and lock, no C-c sent', async () => {
    await seedActiveBinding();
    markBusy('dev-1');

    expect(await harness.manager.releaseAgentForTask('dev-1', 'task-001', 'idle')).toBe(false);

    expect(await harness.agentStore.get('dev-1')).toMatchObject({
      taskId: 'task-001',
      status: 'awaiting_human',
      awaitingPhase: 'branch-cleanup-pending',
    });
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
    expect(ctrlCs()).toEqual([]);
    expect(harness.runner.sessions.pane('dev-1')?.phase).toBe('working');
  });

  it('waiting release on busy pane: keeps binding but updates updatedAt, no C-c sent', async () => {
    await seedActiveBinding();
    markBusy('dev-1');

    expect(await harness.manager.releaseAgentForTask('dev-1', 'task-001', 'waiting')).toBe(true);

    const state = await harness.agentStore.get('dev-1');
    expect(state?.taskId).toBe('task-001');
    expect(state?.updatedAt).not.toBe(NOW);
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
    expect(ctrlCs()).toEqual([]);
    expect(harness.runner.sessions.pane('dev-1')?.phase).toBe('working');
  });
});

describe('AgentManager.releaseAgentForTask waiting-mode gate', () => {
  it('refuses the waiting transition when the bound task is no longer active', async () => {
    const t = await harness.seedTask({ status: 'cancelled' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(harness.manager.releaseAgentForTask('dev-1', t.id, 'waiting')).resolves.toBe(false);

    expect((await harness.agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('not active'))).toBe(true);
    warnSpy.mockRestore();
  });
});

describe('AgentManager.releaseAgentForTask idle-mode expectedHold gate', () => {
  const HELD = { phase: 'checkout-preparation-failed', since: NOW, nonce: 'gen-a' };

  async function seedHeldQa(): Promise<TaskState> {
    const t = await harness.seedTask({ status: 'review', qaAgentId: 'qa-1' });
    await harness.seedAgent({
      id: 'qa-1', taskId: t.id, paneId: '%1',
      status: 'awaiting_human', awaitingPhase: HELD.phase,
      awaitingReason: 'repl not ready', awaitingSince: HELD.since, awaitingNonce: HELD.nonce,
    });
    await harness.acquireAgentLock('qa-1', t.id);
    return t;
  }

  async function seedBoundQa(status: TaskState['status'] = 'review'): Promise<TaskState> {
    const t = await harness.seedTask({ status, qaAgentId: 'qa-1' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await harness.acquireAgentLock('qa-1', t.id);
    return t;
  }

  it('releases and clears the hold when the expected generation matches', async () => {
    const t = await seedHeldQa();

    const released = await harness.manager.releaseAgentForTask('qa-1', t.id, 'idle', {
      allowAwaitingHuman: true,
      expectedHold: HELD,
    });

    expect(released).toBe(true);
    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.taskId).toBeUndefined();
    expect(qa?.status).toBeUndefined();
    expect(await harness.lockManager.isLocked('qa-1')).toBe(false);
    expect(BranchManager.prototype.parkOnDefaultDetached).toHaveBeenCalledWith('/tmp/qa-repo');
  });

  it('keeps the hold and the binding when the hold generation does not match', async () => {
    const t = await seedHeldQa();

    const released = await harness.manager.releaseAgentForTask('qa-1', t.id, 'idle', {
      allowAwaitingHuman: true,
      expectedHold: { ...HELD, nonce: 'gen-z' },
    });

    expect(released).toBe(false);
    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.status).toBe('awaiting_human');
    expect(qa?.awaitingNonce).toBe('gen-a');
    expect(await harness.lockManager.isLocked('qa-1')).toBe(true);
  });

  it('refuses a mismatched hold generation before any workdir side effect', async () => {
    const t = await harness.seedTask({ status: 'review', qaAgentId: 'qa-1' });
    await harness.seedAgent({
      id: 'qa-1', taskId: t.id, paneId: '%1',
      status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown',
      awaitingReason: 'prompt may be running', awaitingSince: NOW, awaitingNonce: 'gen-b',
    });
    await harness.acquireAgentLock('qa-1', t.id);

    const released = await harness.manager.releaseAgentForTask('qa-1', t.id, 'idle', {
      allowAwaitingHuman: true,
      expectedHold: HELD,
    });

    expect(released).toBe(false);
    expect(BranchManager.prototype.parkOnDefaultDetached).not.toHaveBeenCalled();
    expect(cmds()).toEqual([]);
    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.awaitingPhase).toBe('dispatch-failed:ack_unknown');
    expect(await harness.lockManager.isLocked('qa-1')).toBe(true);
  });

  it('QA REPL 仍忙（真实等待超时）→ 抛 ReplNotReadyError 且不落 hold（忙碌不是清理失败，可再排队）', async () => {
    const t = await seedBoundQa();
    markBusy('qa-1');

    await expect(harness.manager.releaseAgentForTask('qa-1', t.id, 'idle', { deferWhenBusy: true }))
      .rejects.toBeInstanceOf(ReplNotReadyError);

    expect(BranchManager.prototype.parkOnDefaultDetached).not.toHaveBeenCalled();
    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.status).toBeUndefined();
    expect(qa?.awaitingPhase).toBeUndefined();
    expect(await harness.lockManager.isLocked('qa-1')).toBe(true);
    expect(ctrlCs()).toEqual([]);
  });

  it('未声明 deferWhenBusy 的普通释放（终态/清理路径）遇忙仍落 hold 并告警', async () => {
    const t = await seedBoundQa('merged');
    markBusy('qa-1');

    const released = await harness.manager.releaseAgentForTask('qa-1', t.id, 'idle');

    expect(released).toBe(false);
    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.status).toBe('awaiting_human');
    expect(qa?.awaitingPhase).toBe('branch-cleanup-pending');
    expect(interventionPhases()).toEqual(['branch-cleanup-pending']);
  });

  it('dev REPL 忙仍按 branch-cleanup-pending 落 hold（分支清理凭据不可丢）', async () => {
    const t = await harness.seedTask({ status: 'review', agentId: 'dev-1', branch: 'bx/task-review' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1', t.id);
    markBusy('dev-1');

    const released = await harness.manager.releaseAgentForTask('dev-1', t.id, 'idle', { deferWhenBusy: true });

    expect(released).toBe(false);
    const dev = await harness.agentStore.get('dev-1');
    expect(dev?.status).toBe('awaiting_human');
    expect(dev?.awaitingPhase).toBe('branch-cleanup-pending');
    expect(BranchManager.prototype.cleanupTaskBranch).not.toHaveBeenCalled();
  });

  it('refuses an expectedHold release when the hold was already cleared', async () => {
    const t = await harness.seedTask({ status: 'review', qaAgentId: 'qa-1' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id });
    await harness.acquireAgentLock('qa-1', t.id);

    const released = await harness.manager.releaseAgentForTask('qa-1', t.id, 'idle', {
      allowAwaitingHuman: true,
      expectedHold: HELD,
    });

    expect(released).toBe(false);
    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(await harness.lockManager.isLocked('qa-1')).toBe(true);
  });

  it('aborts before checkout cleanup when the hold is rewritten during runtime inspection', async () => {
    const t = await seedHeldQa();
    let rewritten = false;
    const runner = createManagerSuiteRunner({
      onExec: async (cmd) => {
        if (rewritten || !cmd.includes('tmux has-session')) return;
        rewritten = true;
        const held = await harness.agentStore.get('qa-1');
        await harness.agentStore.set({
          ...held!,
          awaitingPhase: 'dispatch-failed:ack_unknown',
          awaitingReason: 'prompt may be running',
          awaitingNonce: 'gen-b',
          updatedAt: new Date().toISOString(),
        });
      },
    });
    harness.manager = harness.createManager({ runnerFactory: () => runner });

    const released = await harness.manager.releaseAgentForTask('qa-1', t.id, 'idle', {
      allowAwaitingHuman: true,
      expectedHold: HELD,
    });

    expect(released).toBe(false);
    expect(rewritten).toBe(true);
    expect(BranchManager.prototype.parkOnDefaultDetached).not.toHaveBeenCalled();
    expect((await harness.agentStore.get('qa-1'))?.awaitingPhase).toBe('dispatch-failed:ack_unknown');
    expect(await harness.lockManager.isLocked('qa-1')).toBe(true);
  });

  it('does not let a cleanup failure overwrite a hold rewritten mid-release', async () => {
    const t = await seedHeldQa();
    vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockImplementation(async () => {
      const held = await harness.agentStore.get('qa-1');
      await harness.agentStore.set({
        ...held!,
        awaitingPhase: 'dispatch-failed:ack_unknown',
        awaitingReason: 'prompt may be running',
        awaitingNonce: 'gen-b',
        updatedAt: new Date().toISOString(),
      });
      throw new Error('park failed');
    });

    const released = await harness.manager.releaseAgentForTask('qa-1', t.id, 'idle', {
      allowAwaitingHuman: true,
      expectedHold: HELD,
    });

    expect(released).toBe(false);
    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.awaitingPhase).toBe('dispatch-failed:ack_unknown');
    expect(qa?.awaitingNonce).toBe('gen-b');
    expect(await harness.lockManager.isLocked('qa-1')).toBe(true);
  });

  it('hold 先取得 agent lease 时，release 等待并在任何 checkout 副作用前拒绝', async () => {
    const t = await seedBoundQa();
    const realUpdate = harness.agentStore.update.bind(harness.agentStore);
    let entered!: () => void;
    let unblock!: () => void;
    const updateEntered = new Promise<void>(resolve => { entered = resolve; });
    const updateUnblocked = new Promise<void>(resolve => { unblock = resolve; });
    vi.spyOn(harness.agentStore, 'update').mockImplementationOnce(async (...args) => {
      entered();
      await updateUnblocked;
      return realUpdate(...args);
    });

    const hold = harness.manager.markAwaitingHuman('qa-1', 'dispatch-failed:ack_unknown', 'prompt unknown', {
      expectedTaskId: t.id,
    });
    await updateEntered;
    const release = harness.manager.releaseAgentForTask('qa-1', t.id, 'idle');
    await Promise.resolve();
    expect(BranchManager.prototype.parkOnDefaultDetached).not.toHaveBeenCalled();

    unblock();
    await expect(hold).resolves.toBe(true);
    await expect(release).resolves.toBe(false);
    expect(BranchManager.prototype.parkOnDefaultDetached).not.toHaveBeenCalled();
    expect(cmds()).toEqual([]);
    expect(await harness.agentStore.get('qa-1')).toMatchObject({
      taskId: t.id,
      status: 'awaiting_human',
      awaitingPhase: 'dispatch-failed:ack_unknown',
    });
  });

  it('release 先取得 agent lease 时，hold 不会在 park 期间落库并在解绑后被 CAS 拒绝', async () => {
    const t = await seedBoundQa();
    harness.runner.sessions.drop('qa-1');
    let parkEntered!: () => void;
    let unblockPark!: () => void;
    const parked = new Promise<void>(resolve => { parkEntered = resolve; });
    const parkUnblocked = new Promise<void>(resolve => { unblockPark = resolve; });
    vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockImplementation(async () => {
      parkEntered();
      await parkUnblocked;
    });

    const release = harness.manager.releaseAgentForTask('qa-1', t.id, 'idle');
    await parked;
    const hold = harness.manager.markAwaitingHuman('qa-1', 'dispatch-failed:ack_unknown', 'prompt unknown', {
      expectedTaskId: t.id,
    });
    await Promise.resolve();
    expect((await harness.agentStore.get('qa-1'))?.status).not.toBe('awaiting_human');

    unblockPark();
    await expect(release).resolves.toBe(true);
    await expect(hold).resolves.toBe(false);
    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.taskId).toBeUndefined();
    expect(qa?.status).toBeUndefined();
    expect(qa?.paneId).toBeUndefined();
    expect(await harness.lockManager.isLocked('qa-1')).toBe(false);
  });

  it('agent operation lease advances after a failed predecessor', async () => {
    const t = await harness.seedTask({ status: 'review', qaAgentId: 'qa-1' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id });
    vi.spyOn(harness.agentStore, 'update').mockRejectedValueOnce(new Error('store down'));

    await expect(harness.manager.markAwaitingHuman(
      'qa-1', 'checkout-preparation-failed', 'first hold', { expectedTaskId: t.id },
    )).rejects.toThrow('store down');
    await expect(harness.manager.markAwaitingHuman(
      'qa-1', 'dispatch-failed:ack_unknown', 'second hold', { expectedTaskId: t.id },
    )).resolves.toBe(true);

    expect(await harness.agentStore.get('qa-1')).toMatchObject({
      status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown',
    });
  });
});

describe('dispatchGitFixToDev QA release', () => {
  // dev 已绑在别的任务上,fix 的 dev 取锁必然失败:用例只看 QA 释放分支
  async function seedFixingWithBoundQa(opts: { lock?: boolean } = {}): Promise<TaskState> {
    const t = await harness.seedTask({ status: 'fixing', agentId: 'dev-1', qaAgentId: 'qa-1', signalToken: 'tok-fix' });
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-other', paneId: '%0' });
    if (opts.lock === false) {
      await harness.agentStore.set({ id: 'qa-1', projectId: 'proj', taskId: t.id, paneId: '%1', workdir: '/tmp/qa-repo', updatedAt: NOW });
    } else {
      await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    }
    return t;
  }

  it('QA REPL 仍忙（判决已发、总结未打完）→ 延后释放：保持绑定、不落 hold、不发释放失败干预', async () => {
    const t = await seedFixingWithBoundQa();
    markBusy('qa-1');

    await harness.manager.dispatchGitFixToDev(t.id);

    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.status).toBeUndefined();
    expect(qa?.awaitingPhase).toBeUndefined();
    expect(await harness.lockManager.ownerOf('qa-1')).toBe(t.id);
    expect(interventionPhases()).not.toContain('qa-release-failed-but-dev-dispatched');
    expect(interventionPhases()).toContain('dev-acquire-failed-fix');
  });

  it('QA 清理真正失败（落 hold）→ 仍发 qa-release-failed-but-dev-dispatched', async () => {
    const t = await seedFixingWithBoundQa();
    vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockRejectedValue(new Error('git checkout failed'));

    await harness.manager.dispatchGitFixToDev(t.id);

    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.status).toBe('awaiting_human');
    expect(qa?.awaitingPhase).toBe('branch-cleanup-pending');
    expect(interventionPhases()).toContain('qa-release-failed-but-dev-dispatched');
  });

  it('QA 释放因非忙碌原因被拒（不再持有任务锁）→ 不落 hold 但仍发 qa-release-failed-but-dev-dispatched', async () => {
    const t = await seedFixingWithBoundQa({ lock: false });

    await harness.manager.dispatchGitFixToDev(t.id);

    expect(cmds().some(c => c.includes('has-session') || c.includes('capture-pane'))).toBe(false);
    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.status).toBeUndefined();
    expect(interventionPhases()).toContain('qa-release-failed-but-dev-dispatched');
  });

  it('QA 已在 hold 中且 REPL 忙 → 不延后，沿用 hold 路径并告警', async () => {
    const t = await seedFixingWithBoundQa();
    await harness.agentStore.update('qa-1', latest => ({
      ...latest!,
      status: 'awaiting_human',
      awaitingPhase: 'branch-cleanup-pending',
      awaitingSince: new Date().toISOString(),
    }));
    markBusy('qa-1');

    await harness.manager.dispatchGitFixToDev(t.id);

    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.status).toBe('awaiting_human');
    expect(qa?.awaitingPhase).toBe('branch-cleanup-pending');
    expect(interventionPhases()).toContain('qa-release-failed-but-dev-dispatched');
  });

  it('hold 在快照后、释放取锁前被 Resume 清除且 REPL 仍忙 → 按锁内绑定延后，不再误落 branch-cleanup-pending', async () => {
    const t = await seedFixingWithBoundQa();
    await harness.agentStore.update('qa-1', latest => ({
      ...latest!,
      status: 'awaiting_human',
      awaitingPhase: 'branch-cleanup-pending',
      awaitingSince: new Date().toISOString(),
    }));
    markBusy('qa-1');
    const readBinding = harness.agentStore.get.bind(harness.agentStore);
    let resumedInWindow = false;
    vi.spyOn(harness.agentStore, 'get').mockImplementation(async (id) => {
      const snapshot = await readBinding(id);
      if (id === 'qa-1' && !resumedInWindow) {
        resumedInWindow = true;
        expect((await harness.manager.resumeAgent('qa-1')).resumed).toBe(true);
      }
      return snapshot;
    });

    await harness.manager.dispatchGitFixToDev(t.id);

    expect(resumedInWindow).toBe(true);
    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.status).not.toBe('awaiting_human');
    expect(qa?.awaitingPhase).toBeUndefined();
    expect(interventionPhases()).not.toContain('branch-cleanup-pending');
    expect(interventionPhases()).not.toContain('qa-release-failed-but-dev-dispatched');
    expect(interventionPhases()).toContain('dev-acquire-failed-fix');
  });
});
