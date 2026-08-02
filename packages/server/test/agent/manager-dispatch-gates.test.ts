import { describe, it, expect, vi } from 'vitest';
import type { TaskState } from '../../src/shared/index.js';
import { AgentManager, EnsureSessionError } from '../../src/agent/manager.js';
import { PromptSizeError } from '../../src/agent/prompt.js';
import { TmuxManager } from '../../src/agent/tmux.js';
import { BranchManager, DirtyWorkdirError, ReviewHeadMismatchError } from '../../src/agent/branch.js';
import { DriverOpError } from '../../src/platform/types.js';
import {
  paneRefOf,
  TEST_SESSION_REF,
  useManagerSuiteHarness,
} from '../helpers/manager-harness.js';

const NOW = '2026-05-14T05:00:00.000Z';

const GIT_BINDING = { repoKey: 'github.com/user/repo' };

function stubImagePathsThrow(mgr: AgentManager, err: Error): void {
  vi.spyOn(
    mgr as unknown as { imagePathsForDispatch: () => Promise<string[]> },
    'imagePathsForDispatch',
  ).mockRejectedValue(err);
}

const harness = useManagerSuiteHarness();

describe('AgentManager.startSession pre/mid-dispatch gates', () => {
  it('aborts before ensureSession when the exact task lock is missing', async () => {
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    const state = (await harness.agentStore.get('dev-1'))!;
    await harness.lockManager.releaseIfOwner('dev-1', t.id, state.lockToken!);
    await harness.agentStore.update('dev-1', binding => binding);
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
    const ensureSpy = vi.spyOn(harness.manager, 'ensureSession');

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).resolves.toBe(false);

    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it('aborts before ensureSession when the task disappears at the pre-create gate', async () => {
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    const realGet = harness.taskStore.get.bind(harness.taskStore);
    let calls = 0;
    vi.spyOn(harness.taskStore, 'get').mockImplementation(async (id) => {
      calls += 1;
      return calls >= 2 ? null : realGet(id);
    });
    const ensureSpy = vi.spyOn(harness.manager, 'ensureSession');

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).resolves.toBe(false);
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it('aborts when the pre-create status is outside the phase expectation', async () => {
    const t = await harness.seedTask({ status: 'review' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    const ensureSpy = vi.spyOn(harness.manager, 'ensureSession');

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).resolves.toBe(false);
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it('aborts a bound-phase dispatch when the agent is not bound to the task', async () => {
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1' });

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).resolves.toBe(false);
  });

  it('aborts an unbound-phase dispatch when the agent is already bound elsewhere', async () => {
    const t = await harness.seedTask({ status: 'review' });
    await harness.seedAgent({ id: 'qa-1', taskId: 'some-other-task' });

    await expect(harness.manager.startSession(t.id, 'qa-1', 'review')).resolves.toBe(false);
  });

  it('kills the orphan session when ensureSession fails after creating one', async () => {
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id });
    vi.spyOn(harness.manager, 'ensureSession').mockRejectedValue(
      new EnsureSessionError({ createdSession: true, agentId: 'dev-1', sessionRef: { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' }, genAtCreate: 0 }, 'session boot boom'),
    );
    const killSpy = vi.spyOn(TmuxManager.prototype, 'killSessionRef').mockResolvedValue('killed');

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).rejects.toThrow('session boot boom');
    expect(killSpy).toHaveBeenCalledWith(
      { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' },
      { kind: 'emptyOr', claim: 'dev-1' },
    );
  });

  it('still rethrows the ensureSession error when the rollback killSession also fails', async () => {
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id });
    vi.spyOn(harness.manager, 'ensureSession').mockRejectedValue(
      new EnsureSessionError({ createdSession: true, agentId: 'dev-1', sessionRef: { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' }, genAtCreate: 0 }, 'session boot boom'),
    );
    vi.spyOn(TmuxManager.prototype, 'killSessionRef').mockRejectedValue(new Error('kill failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).rejects.toThrow('session boot boom');
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('created-session rollback') && String(c[0]).includes('failed'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('rethrows without killSession when the dialog handler claims the ensureSession failure', async () => {
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id });
    vi.spyOn(harness.manager, 'ensureSession').mockRejectedValue(
      new EnsureSessionError({ createdSession: true, agentId: 'dev-1', sessionRef: { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' }, genAtCreate: 0 }, 'dialog blocked'),
    );
    vi.spyOn(harness.manager, 'handleDialogPendingFromRuntime').mockResolvedValue(true);
    const killSpy = vi.spyOn(TmuxManager.prototype, 'killSessionRef').mockResolvedValue('killed');

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).rejects.toThrow('dialog blocked');
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('maps PromptSizeError to DispatchTerminalError(prompt_too_large) and parks the fixed Workdir', async () => {
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    harness.stubEnsureSession(harness.manager);
    const parkSpy = vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue();
    stubImagePathsThrow(harness.manager, new PromptSizeError(999_999));

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).rejects.toMatchObject({
      name: 'DispatchTerminalError',
      reason: 'prompt_too_large',
    });
    expect(parkSpy).toHaveBeenCalledWith('/tmp/repo');
  });

  it.each([
    { name: 'task disappears mid-dispatch', fresh: null },
    { name: 'task turns terminal mid-dispatch', fresh: { status: 'cancelled' as const } },
    { name: 'task status leaves the phase expectation mid-dispatch', fresh: { status: 'review' as const } },
  ])('parks the fixed Workdir and aborts when the $name', async ({ fresh }) => {
    const t = await harness.seedTask({ signalToken: 'dispatch12345' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    harness.stubEnsureSession(harness.manager);
    const parkSpy = vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue();
    harness.stubInject(harness.manager, async () => ({ acked: true, composerDelivered: true }));
    const realGet = harness.taskStore.get.bind(harness.taskStore);
    let calls = 0;
    vi.spyOn(harness.taskStore, 'get').mockImplementation(async (id) => {
      calls += 1;
      if (calls >= 3) return fresh === null ? null : { ...t, ...fresh };
      return realGet(id);
    });

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).resolves.toBe(false);
    expect(parkSpy).toHaveBeenCalledWith('/tmp/repo');
  });

  it('aborts without cleanup when the bound agent loses ownership mid-dispatch', async () => {
    const t = await harness.seedTask({ signalToken: 'dispatch12345' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    harness.stubEnsureSession(harness.manager);
    const parkSpy = vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue();
    let checkoutFinished = false;
    vi.spyOn(
      harness.manager as unknown as { imagePathsForDispatch: (...args: unknown[]) => Promise<string[]> },
      'imagePathsForDispatch',
    ).mockImplementation(async () => {
      checkoutFinished = true;
      return [];
    });
    const realGet = harness.agentStore.get.bind(harness.agentStore);
    vi.spyOn(harness.agentStore, 'get').mockImplementation(async (id) => {
      if (checkoutFinished) return { id: 'dev-1', projectId: 'proj', updatedAt: NOW };
      return realGet(id);
    });

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).resolves.toBe(false);
    expect(parkSpy).not.toHaveBeenCalled();
  });

  it('aborts without cleanup when an unbound-phase agent gets reassigned mid-dispatch', async () => {
    const t = await harness.seedTask({
      status: 'review', signalToken: 'tok123456789', latestHeadSha: 'a'.repeat(40),
      reviewHeadAnchorSha: 'a'.repeat(40), passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb',
    });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id });
    harness.stubEnsureSession(harness.manager);
    const parkSpy = vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue();
    let checkoutFinished = false;
    vi.spyOn(
      harness.manager as unknown as { imagePathsForDispatch: (...args: unknown[]) => Promise<string[]> },
      'imagePathsForDispatch',
    ).mockImplementation(async () => {
      checkoutFinished = true;
      return [];
    });
    const realGet = harness.agentStore.get.bind(harness.agentStore);
    vi.spyOn(harness.agentStore, 'get').mockImplementation(async (id) => {
      if (checkoutFinished) return { id: 'qa-1', projectId: 'proj', taskId: 'stolen-task', updatedAt: NOW };
      return realGet(id);
    });

    await expect(harness.manager.startSession(t.id, 'qa-1', 'review')).resolves.toBe(false);
    expect(parkSpy).not.toHaveBeenCalled();
  });

  it('review phase checks out the exact verified remote head in the fixed Workdir', async () => {
    const latestHeadSha = 'a'.repeat(40);
    const t = await harness.seedTask({
      status: 'review', qaAgentId: 'qa-1', signalToken: 'tok123456789', latestHeadSha,
      reviewHeadAnchorSha: latestHeadSha, passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb',
    });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id });
    harness.stubEnsureSession(harness.manager);
    const detachedSpy = vi.spyOn(BranchManager.prototype, 'switchToRemoteBranchDetached')
      .mockResolvedValue(undefined);
    harness.stubInject(harness.manager, async () => ({ acked: true, composerDelivered: true }));

    await expect(harness.manager.startSession(t.id, 'qa-1', 'review')).resolves.toBe(true);
    expect(detachedSpy).toHaveBeenCalledWith('/tmp/qa-repo', t.branch, latestHeadSha);
  });

  it('keeps same-task context when a start dispatch is retried', async () => {
    const t = await harness.seedTask({
      title: 'Already delivered title',
      description: 'Already delivered description',
      signalToken: 'dispatch12345',
    });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    harness.stubEnsureSession(harness.manager, { sessionRef: TEST_SESSION_REF });
    vi.spyOn(TmuxManager.prototype, 'getSessionOptionByRef').mockResolvedValue(t.id);
    const rememberSpy = vi.spyOn(
      harness.manager as unknown as { rememberTaskContext: (...args: unknown[]) => Promise<void> },
      'rememberTaskContext',
    ).mockResolvedValue(undefined);
    let prompt = '';
    harness.stubInject(harness.manager, async (_tmux, _pane, value) => {
      prompt = value;
      return { acked: true, composerDelivered: true };
    });

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).resolves.toBe(true);

    expect(rememberSpy).not.toHaveBeenCalled();
    expect(prompt).toContain(`task: ${t.id}`);
    expect(prompt).toContain('phase: develop');
    expect(prompt).not.toContain('Already delivered title');
    expect(prompt).not.toContain('Already delivered description');
    expect(prompt).not.toContain('Protocol:');
  });

  it('injects the full start prompt without /clear, then remembers the task on a task switch', async () => {
    const t = await harness.seedTask({
      title: 'Switched-to title',
      description: 'Switched-to description',
      signalToken: 'dispatch12345',
    });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    harness.stubEnsureSession(harness.manager, { sessionRef: TEST_SESSION_REF });
    vi.spyOn(TmuxManager.prototype, 'getSessionOptionByRef').mockResolvedValue('task-before-this-one');
    const sendKeysSpy = vi.spyOn(TmuxManager.prototype, 'sendKeysLiteral').mockResolvedValue(undefined);
    const rememberSpy = vi.spyOn(
      harness.manager as unknown as { rememberTaskContext: (...args: unknown[]) => Promise<void> },
      'rememberTaskContext',
    ).mockResolvedValue(undefined);
    let prompt = '';
    harness.stubInject(harness.manager, async (_tmux, _pane, value) => {
      prompt = value;
      return { acked: true, composerDelivered: true };
    });

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).resolves.toBe(true);

    expect(sendKeysSpy).not.toHaveBeenCalledWith(expect.anything(), '/clear');
    expect(prompt).toContain('title: Switched-to title');
    expect(prompt).toContain('Switched-to description');
    expect(rememberSpy).toHaveBeenCalledWith(
      expect.any(TmuxManager),
      'dev-1',
      TEST_SESSION_REF,
      t.id,
    );
  });

  it('refreshes a moved PR head and retries the exact detached checkout once', async () => {
    const oldHeadSha = 'a'.repeat(40);
    const newHeadSha = 'b'.repeat(40);
    const t = await harness.seedTask({
      status: 'review', qaAgentId: 'qa-1', prNumber: 17,
      platformBinding: GIT_BINDING, passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb',
      signalToken: 'tok123456789', latestHeadSha: oldHeadSha, reviewHeadAnchorSha: oldHeadSha,
    });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id });
    harness.stubEnsureSession(harness.manager, { freshRuntime: true });
    const detachedSpy = vi.spyOn(BranchManager.prototype, 'switchToRemoteBranchDetached')
      .mockRejectedValueOnce(new ReviewHeadMismatchError(t.branch!, oldHeadSha, newHeadSha))
      .mockResolvedValue(undefined);
    vi.spyOn(harness.manager, 'platformFetchPrView').mockResolvedValue({ headSha: newHeadSha } as never);
    harness.stubInject(harness.manager, async () => ({ acked: true, composerDelivered: true }));

    await expect(harness.manager.startSession(t.id, 'qa-1', 'review')).resolves.toBe(true);

    expect(detachedSpy).toHaveBeenNthCalledWith(1, '/tmp/qa-repo', t.branch, oldHeadSha);
    expect(detachedSpy).toHaveBeenNthCalledWith(2, '/tmp/qa-repo', t.branch, newHeadSha);
    expect((await harness.taskStore.get(t.id))?.latestHeadSha).toBe(newHeadSha);
  });

  it('warns but keeps the delivered dispatch when both marker-clear and the hold fail', async () => {
    const t = await harness.seedTask({
      id: 'task-deliver-hold-fails',
      branch: 'bx/task-deliver-hold-fails',
      signalToken: 'dispatch12345',
    });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');
    harness.stubEnsureSession(harness.manager);

    let afterAck = false;
    let threwOnce = false;
    harness.stubInject(harness.manager, async () => { afterAck = true; return { acked: true, composerDelivered: true }; });
    const realUpdate = harness.agentStore.update.bind(harness.agentStore);
    vi.spyOn(harness.agentStore, 'update').mockImplementation(async (id, updater) => {
      if (afterAck && !threwOnce) { threwOnce = true; throw new Error('marker-clear write blip'); }
      return realUpdate(id, updater);
    });
    vi.spyOn(harness.manager, 'markAwaitingHuman').mockRejectedValue(new Error('hold write failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).resolves.toBe(true);
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('hold after marker-clear failure'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('releases the binding and lock after parking the Workdir when paste fails definitively', async () => {
    const t = await harness.seedTask({ signalToken: 'dispatch12345' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');
    harness.stubEnsureSession(harness.manager);
    const parkSpy = vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue();
    harness.stubInject(harness.manager, async () => { throw new Error('paste failed'); });

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).rejects.toThrow('paste failed');
    expect(parkSpy).toHaveBeenCalledWith('/tmp/repo');
    const state = await harness.agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(state?.paneId).toBe('%0');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
  });

  it('holds the binding and lock when a failed dispatch checkout cannot be parked', async () => {
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');
    harness.stubEnsureSession(harness.manager);
    vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockRejectedValue(new Error('checkout park failed'));
    harness.stubInject(harness.manager, async () => { throw new Error('paste failed'); });

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).rejects.toMatchObject({
      partial: expect.objectContaining({ handled: true }),
      message: expect.stringContaining('checkout park failed'),
    });
    expect(await harness.agentStore.get('dev-1')).toMatchObject({
      taskId: t.id,
      status: 'awaiting_human',
      awaitingPhase: 'checkout-cleanup-failed',
    });
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });

  it('leaves the new owner untouched when the agent was reassigned while the paste was failing', async () => {
    const t = await harness.seedTask({ signalToken: 'dispatch12345' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');
    harness.stubEnsureSession(harness.manager);
    harness.stubInject(harness.manager, async () => {
      await harness.agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'new-owner-task', updatedAt: NOW });
      throw new Error('paste failed');
    });

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).rejects.toThrow('paste failed');
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBe('new-owner-task');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });

  it('rethrows the paste error even when the cleanup write itself fails', async () => {
    const t = await harness.seedTask({ signalToken: 'dispatch12345' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');
    harness.stubEnsureSession(harness.manager);
    harness.stubInject(harness.manager, async () => { throw new Error('paste failed'); });
    const realUpdate = harness.agentStore.update.bind(harness.agentStore);
    let updates = 0;
    vi.spyOn(harness.agentStore, 'update').mockImplementation(async (id, updater) => {
      updates += 1;
      if (updates >= 3) throw new Error('cleanup write blip');
      return realUpdate(id, updater);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).rejects.toThrow('paste failed');
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('cleanup agentStore failed'))).toBe(true);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
    warnSpy.mockRestore();
  });
});

describe('AgentManager.continueSession pre/mid-dispatch gates', () => {
  async function seedContinueFix(overrides: Partial<TaskState> = {}): Promise<TaskState> {
    const t = await harness.seedTask({
      status: 'fixing',
      signalToken: 'tok123456789',
      ...overrides,
    });
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    return t;
  }

  it('post-approve without a completion token is skipped', async () => {
    const t = await harness.seedTask({ status: 'approved' });
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    harness.stubEnsureSession(harness.manager);
    const ensureSpy = vi.spyOn(harness.manager, 'ensureSession');

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'post-approve', { signalToken: 'tok' }))
      .resolves.toBe(false);
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it('bound phase is skipped when the agent no longer holds the task', async () => {
    const t = await harness.seedTask({ status: 'fixing' });
    await harness.seedAgent({
      id: 'dev-1', taskId: 'other-task', paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix')).resolves.toBe(false);
  });

  it('unbound phase is skipped when the agent is bound to a different task', async () => {
    const t = await harness.seedTask({
      status: 'review', signalToken: 'tok123456789',
      reviewHeadAnchorSha: 'a'.repeat(40), passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb',
    });
    await harness.seedAgent({
      id: 'qa-1', taskId: 'other-task', paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });

    await expect(harness.manager.continueSession(t.id, 'qa-1', 'recheck')).resolves.toBe(false);
  });

  it('a dirty checkout blocks a dev continuation unless allowDirtyWorkdir marks it as in-flight resume', async () => {
    const t = await seedContinueFix();
    harness.stubEnsureSession(harness.manager);
    harness.stubInject(harness.manager, async () => ({ acked: true, composerDelivered: true }));
    vi.mocked(BranchManager.prototype.assertClean)
      .mockRejectedValue(new DirtyWorkdirError('/tmp/repo/.baxian-worktrees/wt'));

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix')).rejects.toBeInstanceOf(DirtyWorkdirError);
    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix', { allowDirtyWorkdir: true }))
      .resolves.toBe(true);
  });

  it.each([
    { context: 'unknown', marker: null },
    { context: 'another task', marker: 'task-before-this-one' },
  ])('injects the full continuation without /clear, then remembers the task on $context context', async ({ marker }) => {
    const t = await seedContinueFix({
      title: 'Context boundary title',
      description: 'Context boundary description',
    });
    const order: string[] = [];
    let prompt = '';
    harness.stubEnsureSession(harness.manager, {
      pane: paneRefOf('%0', 'dev-1'),
      sessionRef: TEST_SESSION_REF,
    });
    vi.spyOn(TmuxManager.prototype, 'getSessionOptionByRef').mockResolvedValue(marker);
    const sendKeysSpy = vi.spyOn(TmuxManager.prototype, 'sendKeysLiteral').mockResolvedValue(undefined);
    const rememberSpy = vi.spyOn(
      harness.manager as unknown as { rememberTaskContext: (...args: unknown[]) => Promise<void> },
      'rememberTaskContext',
    ).mockImplementation(async () => {
      order.push('remember');
    });
    harness.stubInject(harness.manager, async (_tmux, _paneId, value) => {
      order.push('inject');
      prompt = value;
      return { acked: true, composerDelivered: true };
    });

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix')).resolves.toBe(true);
    expect(order).toEqual(['inject', 'remember']);
    expect(prompt).toContain('title: Context boundary title');
    expect(prompt).toContain('Context boundary description');
    expect(sendKeysSpy).not.toHaveBeenCalledWith(expect.anything(), '/clear');
    expect(rememberSpy).toHaveBeenCalledWith(
      expect.any(TmuxManager),
      'dev-1',
      TEST_SESSION_REF,
      t.id,
    );
  });

  it('keeps same-task context and sends only the next phase increment', async () => {
    const t = await seedContinueFix({
      title: 'Preserved context title',
      description: 'Preserved context description',
    });
    let prompt = '';
    harness.stubEnsureSession(harness.manager, {
      pane: paneRefOf('%0', 'dev-1'),
      sessionRef: TEST_SESSION_REF,
    });
    vi.spyOn(TmuxManager.prototype, 'getSessionOptionByRef').mockResolvedValue(t.id);
    const rememberSpy = vi.spyOn(
      harness.manager as unknown as { rememberTaskContext: (...args: unknown[]) => Promise<void> },
      'rememberTaskContext',
    ).mockResolvedValue(undefined);
    harness.stubInject(harness.manager, async (_tmux, _paneId, value) => {
      prompt = value;
      return { acked: true, composerDelivered: true };
    });

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix')).resolves.toBe(true);
    expect(rememberSpy).not.toHaveBeenCalled();
    expect(prompt).toContain(`task: ${t.id}`);
    expect(prompt).toContain('phase: fix');
    expect(prompt).toContain('token: tok123456789');
    expect(prompt).not.toContain('Preserved context title');
    expect(prompt).not.toContain('Preserved context description');
    expect(prompt).not.toContain('Protocol:');
  });

  it('restores the task branch checkout when a dev continuation left it and the tree is clean', async () => {
    const t = await seedContinueFix();
    harness.stubEnsureSession(harness.manager);
    harness.stubInject(harness.manager, async () => ({ acked: true, composerDelivered: true }));
    vi.mocked(BranchManager.prototype.currentRef).mockResolvedValue(null);
    const switchSpy = vi.mocked(BranchManager.prototype.switchToTaskBranch);

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix')).resolves.toBe(true);
    expect(switchSpy).toHaveBeenCalledWith(
      '/tmp/repo/.baxian-worktrees/wt', t.id, t.branch, true, { requireExistingWork: true },
    );
  });

  it('restores the checkout on an allowDirtyWorkdir continuation too (switch enforces cleanliness itself)', async () => {
    const t = await seedContinueFix();
    harness.stubEnsureSession(harness.manager);
    harness.stubInject(harness.manager, async () => ({ acked: true, composerDelivered: true }));
    vi.mocked(BranchManager.prototype.currentRef).mockResolvedValue('refs/heads/other-branch');
    const switchSpy = vi.mocked(BranchManager.prototype.switchToTaskBranch);

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix', { allowDirtyWorkdir: true }))
      .resolves.toBe(true);
    expect(switchSpy).toHaveBeenCalledWith(
      '/tmp/repo/.baxian-worktrees/wt', t.id, t.branch, true, { requireExistingWork: true },
    );
  });

  it('hands the branchLocalCleaned credential to the checkout restore and clears it on success', async () => {
    const t = await harness.seedTask({
      status: 'fixing',
      signalToken: 'tok123456789',
      branchLocalCleaned: { remoteTipSha: 'b'.repeat(40), updatedAt: NOW },
    });
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    harness.stubEnsureSession(harness.manager);
    harness.stubInject(harness.manager, async () => ({ acked: true, composerDelivered: true }));
    vi.mocked(BranchManager.prototype.currentRef).mockResolvedValue(null);
    const switchSpy = vi.mocked(BranchManager.prototype.switchToTaskBranch);

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix')).resolves.toBe(true);
    expect(switchSpy).toHaveBeenCalledWith(
      '/tmp/repo/.baxian-worktrees/wt', t.id, t.branch, true,
      { requireExistingWork: true, restorableRemoteTip: 'b'.repeat(40) },
    );
    expect((await harness.taskStore.get(t.id))?.branchLocalCleaned).toBeUndefined();
  });

  it('a checkout mismatch on a dirty tree stays fail-closed and never dispatches', async () => {
    const t = await seedContinueFix();
    harness.stubEnsureSession(harness.manager);
    const injectSpy = vi.spyOn(
      harness.manager as unknown as { injectAndAwaitAck: InjectAckFn },
      'injectAndAwaitAck',
    ).mockResolvedValue({ acked: true, composerDelivered: true });
    vi.mocked(BranchManager.prototype.currentRef).mockResolvedValue('refs/heads/other-branch');
    vi.mocked(BranchManager.prototype.switchToTaskBranch)
      .mockRejectedValue(new DirtyWorkdirError('/tmp/repo/.baxian-worktrees/wt'));

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix', { allowDirtyWorkdir: true }))
      .rejects.toBeInstanceOf(DirtyWorkdirError);
    expect(injectSpy).not.toHaveBeenCalled();
  });

  async function pasteDevelopContinuation(overrides: Partial<TaskState>): Promise<string> {
    const t = await harness.seedTask({ status: 'in_progress', signalToken: 'tok123456789', ...overrides });
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    harness.stubEnsureSession(harness.manager);
    const prompts: string[] = [];
    harness.stubInject(harness.manager, async (_tmux, _paneId, prompt) => {
      prompts.push(prompt);
      return { acked: true, composerDelivered: true };
    });

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'develop', {
      signalToken: 'tok123456789',
      allowDirtyWorkdir: true,
    })).resolves.toBe(true);
    return prompts[0]!;
  }

  it('a develop continuation carries only the rotating token', async () => {
    const prompt = await pasteDevelopContinuation({});

    expect(prompt).toContain('token: tok123456789');
    expect(prompt).not.toMatch(/^(?:spec-)?signal:/m);
  });

  it('rethrows without killSession when the dialog handler claims the ensureSession failure', async () => {
    const t = await seedContinueFix();
    vi.spyOn(harness.manager, 'ensureSession').mockRejectedValue(
      new EnsureSessionError({ createdSession: true, agentId: 'dev-1', sessionRef: { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' }, genAtCreate: 0 }, 'dialog blocked'),
    );
    vi.spyOn(harness.manager, 'handleDialogPendingFromRuntime').mockResolvedValue(true);
    const killSpy = vi.spyOn(TmuxManager.prototype, 'killSessionRef').mockResolvedValue('killed');

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix')).rejects.toThrow('dialog blocked');
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('kills the orphan session when ensureSession fails after creating one', async () => {
    const t = await seedContinueFix();
    vi.spyOn(harness.manager, 'ensureSession').mockRejectedValue(
      new EnsureSessionError({ createdSession: true, agentId: 'dev-1', sessionRef: { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' }, genAtCreate: 0 }, 'session boot boom'),
    );
    const killSpy = vi.spyOn(TmuxManager.prototype, 'killSessionRef').mockRejectedValue(new Error('kill failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix')).rejects.toThrow('session boot boom');
    expect(killSpy).toHaveBeenCalledWith(
      { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' },
      { kind: 'emptyOr', claim: 'dev-1' },
    );
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('created-session rollback') && String(c[0]).includes('failed'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('maps PromptSizeError to prompt_too_large', async () => {
    const t = await seedContinueFix();
    harness.stubEnsureSession(harness.manager);
    stubImagePathsThrow(harness.manager, new PromptSizeError(999_999));

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix')).rejects.toMatchObject({
      reason: 'prompt_too_large',
    });
  });

  it.each([
    { name: 'terminal', fresh: { status: 'cancelled' as const } },
    { name: 'missing', fresh: null },
    { name: 'status-drifted', fresh: { status: 'review' as const } },
  ])('skips the paste when the task is $name at the pre-paste gate', async ({ fresh }) => {
    const t = await seedContinueFix();
    harness.stubEnsureSession(harness.manager);
    harness.stubInject(harness.manager, async () => ({ acked: true, composerDelivered: true }));
    const realGet = harness.taskStore.get.bind(harness.taskStore);
    let calls = 0;
    vi.spyOn(harness.taskStore, 'get').mockImplementation(async (id) => {
      calls += 1;
      if (calls >= 2) return fresh === null ? null : { ...t, ...fresh };
      return realGet(id);
    });

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix')).resolves.toBe(false);
  });

  it('skips the paste when the bound agent loses the binding pre-paste', async () => {
    const t = await seedContinueFix();
    harness.stubEnsureSession(harness.manager);
    harness.stubInject(harness.manager, async () => ({ acked: true, composerDelivered: true }));
    const realGet = harness.agentStore.get.bind(harness.agentStore);
    let calls = 0;
    vi.spyOn(harness.agentStore, 'get').mockImplementation(async (id) => {
      calls += 1;
      if (calls >= 2) return { id: 'dev-1', projectId: 'proj', updatedAt: NOW };
      return realGet(id);
    });

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix')).resolves.toBe(false);
  });

  it('skips the paste when an unbound-phase agent gets reassigned pre-paste', async () => {
    const t = await harness.seedTask({
      status: 'review', signalToken: 'tok123456789',
      reviewHeadAnchorSha: 'a'.repeat(40), passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb',
    });
    await harness.seedAgent({
      id: 'qa-1', taskId: t.id, paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    harness.stubEnsureSession(harness.manager);
    harness.stubInject(harness.manager, async () => ({ acked: true, composerDelivered: true }));
    let promptBuilt = false;
    vi.spyOn(
      harness.manager as unknown as { imagePathsForDispatch: (...args: unknown[]) => Promise<string[]> },
      'imagePathsForDispatch',
    ).mockImplementation(async () => {
      promptBuilt = true;
      return [];
    });
    const realGet = harness.agentStore.get.bind(harness.agentStore);
    vi.spyOn(harness.agentStore, 'get').mockImplementation(async (id) => {
      if (promptBuilt) return { id: 'qa-1', projectId: 'proj', taskId: 'stolen-task', updatedAt: NOW };
      return realGet(id);
    });

    await expect(harness.manager.continueSession(t.id, 'qa-1', 'recheck')).resolves.toBe(false);
  });

  it('post-approve skips the paste when the completion token rotates before injection', async () => {
    const t = await harness.seedTask({ status: 'approved' });
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    harness.stubEnsureSession(harness.manager);
    harness.stubInject(harness.manager, async () => ({ acked: true, composerDelivered: true }));
    let calls = 0;
    vi.spyOn(harness.manager, 'getPostApproveCompletion').mockImplementation(async () => {
      calls += 1;
      return { token: calls === 1 ? 'tok' : 'rotated', approvedHeadSha: 'sha' };
    });

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'post-approve', { signalToken: 'tok' }))
      .resolves.toBe(false);
  });
});

describe('AgentManager.verifyPaneSignalPrNumber', () => {
  const SHA = 'a'.repeat(40);

  type Verification = Awaited<ReturnType<AgentManager['platformVerifyPrBinding']>>;

  function driverManager(result: Verification | Error) {
    const manager = harness.createManager();
    const verify = vi.spyOn(manager, 'platformVerifyPrBinding');
    if (result instanceof Error) verify.mockRejectedValue(result);
    else verify.mockResolvedValue(result);
    return { manager, verify };
  }

  it('returns undefined for an unknown task', async () => {
    const { manager, verify } = driverManager({
      ok: true, headSha: SHA, branch: 'bx/task-1', targetBranch: 'main',
    });
    await expect(manager.verifyPaneSignalPrNumber('nope', 12)).resolves.toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
  });

  it('returns undefined for a task without branch', async () => {
    const { manager, verify } = driverManager({
      ok: true, headSha: SHA, branch: 'bx/task-1', targetBranch: 'main',
    });
    await harness.seedTask({ branch: undefined });
    await expect(manager.verifyPaneSignalPrNumber('task-1', 12)).resolves.toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
  });

  it('surfaces a driver probe failure instead of collapsing it into a negative verification', async () => {
    const { manager, verify } = driverManager(new Error('driver failed'));
    await harness.seedTask();
    await expect(manager.verifyPaneSignalPrNumber('task-1', 12)).rejects.toThrow('driver failed');
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('does not retry a platform rate-limit response on the short network backoff', async () => {
    const { manager, verify } = driverManager(new DriverOpError('secondary rate limit', {
      opName: 'prView', errorClass: 'RATE_LIMIT', exitCode: 1,
    }));
    await harness.seedTask();

    await expect(manager.verifyPaneSignalPrNumber('task-1', 12)).rejects.toThrow('secondary rate limit');

    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when the driver cannot verify the PR', async () => {
    const { manager } = driverManager({ ok: false, reason: 'unverifiable' });
    await harness.seedTask();
    await expect(manager.verifyPaneSignalPrNumber('task-1', 12)).resolves.toBeUndefined();
  });

  it('returns undefined when the PR head branch does not match the task branch', async () => {
    const { manager } = driverManager({ ok: false, reason: 'branch', prBranch: 'bx/other-task' });
    await harness.seedTask();
    await expect(manager.verifyPaneSignalPrNumber('task-1', 12)).resolves.toBeUndefined();
  });

  it('returns the driver-verified head ref, sha, and target branch', async () => {
    const { manager, verify } = driverManager({
      ok: true, headSha: SHA, branch: 'bx/task-1', targetBranch: 'main',
    });
    await harness.seedTask();
    await expect(manager.verifyPaneSignalPrNumber('task-1', 12)).resolves.toEqual({
      headRefName: 'bx/task-1',
      headSha: SHA,
      targetBranch: 'main',
    });
    expect(verify).toHaveBeenCalledWith('task-1', 12);
  });
});
