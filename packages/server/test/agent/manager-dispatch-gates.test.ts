import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { TaskState } from '../../src/shared/index.js';
import type { AgentManagerDeps } from '../../src/agent/manager.js';
import { AgentManager, EnsureSessionError } from '../../src/agent/manager.js';
import { MAX_PROMPT_BYTES } from '../../src/agent/prompt.js';
import { BranchManager, DirtyWorkdirError, ReviewHeadMismatchError } from '../../src/agent/branch.js';
import { DriverOpError } from '../../src/platform/types.js';
import type { FakeRunner, FakeRunnerOptions, FakeRunnerRule } from '../helpers/fake-runner.js';
import { createManagerSuiteRunner, useManagerSuiteHarness } from '../helpers/manager-harness.js';

const NOW = '2026-05-14T05:00:00.000Z';
const GIT_BINDING = { repoKey: 'github.com/user/repo' };
const CONTEXT_OPTION = '@baxian-context-task-id';
// 既不是 ready 也不是信任对话框的启动遮挡:adopt 把它分类为 startup-dialog
const STARTUP_DIALOG = 'Auto-updating…\nPress enter to continue\n';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
// 提示构建阶段的两类真实故障:正文超限、任务附图已不在 staging 目录
const PROMPT_STAGE_FAILURES: Array<{ reason: string; task: Partial<TaskState> }> = [
  { reason: 'prompt_too_large', task: { description: 'x'.repeat(MAX_PROMPT_BYTES) } },
  { reason: 'task_image_missing', task: { images: ['gone.png'] } },
];
const LAUNCH_FAILS: FakeRunnerRule = {
  match: cmd => cmd.includes('send-keys -l') && cmd.includes(' claude'),
  reply: { exitCode: 1, stderr: 'launch failed' },
};
const KILL_FAILS: FakeRunnerRule = { match: 'kill-session', reply: { exitCode: 1, stderr: 'kill failed' } };
const PASTE_REFUSED: FakeRunnerRule = { match: 'paste-buffer', reply: { outcome: 'refused' } };
// killSessionRef({ kind: 'emptyOr', claim: 'dev-1' }) 渲染出的 if-shell 条件片段
const EMPTY_OR_DEV1 = '#{||:#{==:#{@baxian-agent-id},},#{==:#{@baxian-agent-id},dev-1}}';

const harness = useManagerSuiteHarness();

const bodies = (runner: FakeRunner = harness.runner): string[] => runner.pastedPrompts.map(p => p.body);
const cmds = (runner: FakeRunner = harness.runner): string[] => runner.exec.mock.calls.map(c => c[0] as string);
const contextWrites = (runner: FakeRunner = harness.runner): string[] =>
  cmds(runner).filter(c => c.includes('set-option') && c.includes(CONTEXT_OPTION));

// 依次在 runner 轨迹里找到每个片段,且每个都出现在前一个之后
function traceOrder(runner: FakeRunner, needles: string[]): boolean {
  const trace = cmds(runner);
  let from = 0;
  for (const needle of needles) {
    const at = trace.findIndex((c, i) => i >= from && c.includes(needle));
    if (at === -1) return false;
    from = at + 1;
  }
  return true;
}

type LiveRunnerOptions = Omit<FakeRunnerOptions, 'onExec'> & {
  onExec?: (cmd: string, runner: FakeRunner) => void | Promise<void>;
};

// 自定义 runner 后 manager 必须重建;onExec 收到 runner 本身,便于在目标命令处改模型
function liveRunner({ onExec, ...options }: LiveRunnerOptions = {}, deps: Partial<AgentManagerDeps> = {}): FakeRunner {
  const runner: FakeRunner = createManagerSuiteRunner({
    ...options,
    ...(onExec ? { onExec: (cmd: string) => onExec(cmd, runner) } : {}),
  });
  harness.manager = harness.createManager({ runnerFactory: () => runner, ...deps });
  return runner;
}

async function stageImage(taskId: string, filename: string): Promise<void> {
  const dir = join(harness.tempDir, 'state', 'task-images', taskId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), PNG);
}

function expectDialogHold(runner: FakeRunner, agentId: string): Promise<void> {
  return (async () => {
    expect(cmds(runner).some(c => c.includes('kill-session'))).toBe(false);
    expect(runner.sessions.present(agentId)).toBe(true);
    expect(await harness.agentStore.get(agentId)).toMatchObject({
      status: 'awaiting_human',
      awaitingPhase: 'agent_dialog_pending',
    });
  })();
}

describe('AgentManager.startSession pre/mid-dispatch gates', () => {
  it('aborts before ensureSession when the exact task lock is missing', async () => {
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    const state = (await harness.agentStore.get('dev-1'))!;
    await harness.lockManager.releaseIfOwner('dev-1', t.id, state.lockToken!);
    await harness.agentStore.update('dev-1', binding => binding);
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).resolves.toBe(false);

    expect(harness.runner.exec).not.toHaveBeenCalled();
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

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).resolves.toBe(false);
    expect(harness.runner.exec).not.toHaveBeenCalled();
  });

  it('aborts when the pre-create status is outside the phase expectation', async () => {
    const t = await harness.seedTask({ status: 'review' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).resolves.toBe(false);
    expect(harness.runner.exec).not.toHaveBeenCalled();
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
    const runner = liveRunner({ session: 'absent', rules: [LAUNCH_FAILS] });

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).rejects.toMatchObject({
      name: 'EnsureSessionError',
      partial: expect.objectContaining({ createdSession: true }),
    });

    expect(traceOrder(runner, ['tmux new-session', 'send-keys -l', 'kill-session'])).toBe(true);
    // 回滚用 emptyOr 而不是 equals:未认领的会话也要被收走(策略选项是外部契约)
    expect(cmds(runner).find(c => c.includes('kill-session'))).toContain(EMPTY_OR_DEV1);
    expect(runner.sessions.present('dev-1')).toBe(false);
    expect(runner.pastedPrompts).toEqual([]);
  });

  it('still rethrows the ensureSession error when the rollback killSession also fails', async () => {
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id });
    const runner = liveRunner({ session: 'absent', rules: [LAUNCH_FAILS, KILL_FAILS] });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).rejects.toBeInstanceOf(EnsureSessionError);

    expect(traceOrder(runner, ['tmux new-session', 'kill-session'])).toBe(true);
    expect(runner.sessions.present('dev-1')).toBe(true);
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('created-session rollback') && String(c[0]).includes('failed'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('rethrows without killSession when the runtime is blocked on a startup dialog: agent held, task failed', async () => {
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id });
    const runner = liveRunner({ agents: { 'dev-1': { screen: STARTUP_DIALOG } } });

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).rejects.toMatchObject({
      partial: expect.objectContaining({ dialogPending: true, handled: true }),
    });

    await expectDialogHold(runner, 'dev-1');
    expect((await harness.taskStore.get(t.id))?.status).toBe('failed');
    expect(harness.events.some(e => e.type === 'task.updated' && e.taskId === t.id
      && (e.data as { reason?: string }).reason === 'agent_dialog_pending_runtime')).toBe(true);
  });

  it.each(PROMPT_STAGE_FAILURES)('$reason at the prompt stage fails the dispatch and parks the fixed Workdir', async ({ task, reason }) => {
    const t = await harness.seedTask({ signalToken: 'dispatch12345', ...task });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).rejects.toMatchObject({
      name: 'DispatchTerminalError',
      reason,
    });
    expect(BranchManager.prototype.parkOnDefaultDetached).toHaveBeenCalledWith('/tmp/repo');
    expect(harness.runner.pastedPrompts).toEqual([]);
  });

  it.each([
    { name: 'task disappears mid-dispatch', fresh: null },
    { name: 'task turns terminal mid-dispatch', fresh: { status: 'cancelled' as const } },
    { name: 'task status leaves the phase expectation mid-dispatch', fresh: { status: 'review' as const } },
  ])('parks the fixed Workdir and aborts when the $name', async ({ fresh }) => {
    const t = await harness.seedTask({ signalToken: 'dispatch12345' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    const realGet = harness.taskStore.get.bind(harness.taskStore);
    let calls = 0;
    // 前两次读是 pre-create 门;第三次是 checkout 之后、粘贴之前的复核
    vi.spyOn(harness.taskStore, 'get').mockImplementation(async (id) => {
      calls += 1;
      if (calls >= 3) return fresh === null ? null : { ...t, ...fresh };
      return realGet(id);
    });

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).resolves.toBe(false);
    expect(BranchManager.prototype.parkOnDefaultDetached).toHaveBeenCalledWith('/tmp/repo');
    expect(harness.runner.pastedPrompts).toEqual([]);
  });

  it('aborts without cleanup when the bound agent loses ownership mid-dispatch', async () => {
    const t = await harness.seedTask({ signalToken: 'dispatch12345', images: ['g.png'] });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await stageImage(t.id, 'g.png');
    // 图片落到宿主机的那一刻(checkout 之后、粘贴之前)绑定被夺走
    harness.runner.writeFile.mockImplementation(async () => {
      await harness.agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: NOW });
    });

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).resolves.toBe(false);
    expect(harness.runner.writeFile).toHaveBeenCalled();
    expect(BranchManager.prototype.parkOnDefaultDetached).not.toHaveBeenCalled();
    expect(harness.runner.pastedPrompts).toEqual([]);
  });

  it('aborts without cleanup when an unbound-phase agent gets reassigned mid-dispatch', async () => {
    const t = await harness.seedTask({
      status: 'review', signalToken: 'tok123456789', latestHeadSha: 'a'.repeat(40),
      reviewHeadAnchorSha: 'a'.repeat(40), passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb',
    });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id });
    let checkoutDone = false;
    vi.mocked(BranchManager.prototype.switchToRemoteBranchDetached).mockImplementation(async () => { checkoutDone = true; });
    // review 阶段 checkout 与粘贴之间没有外部命令:在粘贴前复核读任务的那一刻改绑定
    const realGet = harness.taskStore.get.bind(harness.taskStore);
    vi.spyOn(harness.taskStore, 'get').mockImplementation(async (id) => {
      if (checkoutDone) await harness.agentStore.set({ id: 'qa-1', projectId: 'proj', taskId: 'stolen-task', updatedAt: NOW });
      return realGet(id);
    });

    await expect(harness.manager.startSession(t.id, 'qa-1', 'review')).resolves.toBe(false);
    expect(checkoutDone).toBe(true);
    expect(BranchManager.prototype.parkOnDefaultDetached).not.toHaveBeenCalled();
    expect(harness.runner.pastedPrompts).toEqual([]);
  });

  it('review phase checks out the exact verified remote head in the fixed Workdir', async () => {
    const latestHeadSha = 'a'.repeat(40);
    const t = await harness.seedTask({
      status: 'review', qaAgentId: 'qa-1', signalToken: 'tok123456789', latestHeadSha,
      reviewHeadAnchorSha: latestHeadSha, passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb',
    });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id });

    await expect(harness.manager.startSession(t.id, 'qa-1', 'review')).resolves.toBe(true);
    expect(BranchManager.prototype.switchToRemoteBranchDetached).toHaveBeenCalledWith('/tmp/qa-repo', t.branch, latestHeadSha);
    expect(harness.runner.pastedPrompts).toEqual([{ pane: '%1', body: expect.stringContaining('phase: review') }]);
  });

  it('keeps same-task context when a start dispatch is retried', async () => {
    const t = await harness.seedTask({
      title: 'Already delivered title',
      description: 'Already delivered description',
      signalToken: 'dispatch12345',
    });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    harness.runner.sessions.seed('dev-1', { options: { [CONTEXT_OPTION]: t.id } });

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).resolves.toBe(true);

    const [prompt] = bodies();
    expect(prompt).toContain(`task: ${t.id}`);
    expect(prompt).toContain('phase: develop');
    expect(prompt).not.toContain('Already delivered title');
    expect(prompt).not.toContain('Already delivered description');
    expect(prompt).not.toContain('Task contract');
    expect(prompt).not.toContain('Protocol:');
    expect(contextWrites()).toEqual([]);
    expect(harness.runner.sessions.option('dev-1', CONTEXT_OPTION)).toBe(t.id);
  });

  it('injects the full start prompt without /clear, then remembers the task on a task switch', async () => {
    const t = await harness.seedTask({
      title: 'Switched-to title',
      description: 'Switched-to description',
      signalToken: 'dispatch12345',
    });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    harness.runner.sessions.seed('dev-1', { options: { [CONTEXT_OPTION]: 'task-before-this-one' } });

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).resolves.toBe(true);

    expect(harness.runner.sentKeys.some(k => k.includes('/clear'))).toBe(false);
    const [prompt] = bodies();
    expect(prompt).toContain('title: Switched-to title');
    expect(prompt).toContain('Switched-to description');
    expect(harness.runner.sessions.option('dev-1', CONTEXT_OPTION)).toBe(t.id);
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
    const detachedSpy = vi.spyOn(BranchManager.prototype, 'switchToRemoteBranchDetached')
      .mockRejectedValueOnce(new ReviewHeadMismatchError(t.branch!, oldHeadSha, newHeadSha))
      .mockResolvedValue(undefined);
    vi.spyOn(harness.manager, 'platformFetchPrView').mockResolvedValue({ headSha: newHeadSha } as never);

    await expect(harness.manager.startSession(t.id, 'qa-1', 'review')).resolves.toBe(true);

    expect(detachedSpy).toHaveBeenNthCalledWith(1, '/tmp/qa-repo', t.branch, oldHeadSha);
    expect(detachedSpy).toHaveBeenNthCalledWith(2, '/tmp/qa-repo', t.branch, newHeadSha);
    expect((await harness.taskStore.get(t.id))?.latestHeadSha).toBe(newHeadSha);
    expect(harness.runner.pastedPrompts).toHaveLength(1);
  });

  it('warns but keeps the delivered dispatch when both marker-clear and the hold fail', async () => {
    const t = await harness.seedTask({
      id: 'task-deliver-hold-fails',
      branch: 'bx/task-deliver-hold-fails',
      signalToken: 'dispatch12345',
    });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');

    const realUpdate = harness.agentStore.update.bind(harness.agentStore);
    let failures = 0;
    // 提示粘贴之后的前两次绑定写入依次是清标记与写 hold
    vi.spyOn(harness.agentStore, 'update').mockImplementation(async (id, updater) => {
      if (harness.runner.pastedPrompts.length > 0 && failures < 2) { failures += 1; throw new Error('binding write blip'); }
      return realUpdate(id, updater);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).resolves.toBe(true);
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('hold after marker-clear failure'))).toBe(true);
    expect(await harness.agentStore.get('dev-1')).toMatchObject({ taskId: t.id, bootstrappingTaskId: t.id });
    expect((await harness.agentStore.get('dev-1'))?.status).toBeUndefined();
    warnSpy.mockRestore();
  });

  it('releases the binding and lock after parking the Workdir when paste fails definitively', async () => {
    const t = await harness.seedTask({ signalToken: 'dispatch12345' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');
    const runner = liveRunner({ rules: [PASTE_REFUSED] });

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).rejects.toThrow(/withheld/);
    expect(BranchManager.prototype.parkOnDefaultDetached).toHaveBeenCalledWith('/tmp/repo');
    const state = await harness.agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(state?.paneId).toBe('%0');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
    expect(runner.pastedPrompts).toEqual([]);
  });

  it('holds the binding and lock when a failed dispatch checkout cannot be parked', async () => {
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');
    liveRunner({ rules: [PASTE_REFUSED] });
    vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockRejectedValue(new Error('checkout park failed'));

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
    liveRunner({
      rules: [PASTE_REFUSED],
      onExec: async cmd => {
        if (cmd.includes('paste-buffer')) await harness.agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'new-owner-task', updatedAt: NOW });
      },
    });

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).rejects.toThrow(/withheld/);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBe('new-owner-task');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });

  it('rethrows the paste error even when the cleanup write itself fails', async () => {
    const t = await harness.seedTask({ signalToken: 'dispatch12345' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');
    let pasteAttempted = false;
    liveRunner({
      rules: [PASTE_REFUSED],
      onExec: cmd => { if (cmd.includes('paste-buffer')) pasteAttempted = true; },
    });
    const realUpdate = harness.agentStore.update.bind(harness.agentStore);
    vi.spyOn(harness.agentStore, 'update').mockImplementation(async (id, updater) => {
      if (pasteAttempted) throw new Error('cleanup write blip');
      return realUpdate(id, updater);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).rejects.toThrow(/withheld/);
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
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    return t;
  }

  it('post-approve without a completion token is skipped', async () => {
    const t = await harness.seedTask({ status: 'approved' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'post-approve', { signalToken: 'tok' }))
      .resolves.toBe(false);
    expect(harness.runner.exec).not.toHaveBeenCalled();
  });

  it('bound phase is skipped when the agent no longer holds the task', async () => {
    const t = await harness.seedTask({ status: 'fixing' });
    await harness.seedAgent({ id: 'dev-1', taskId: 'other-task', paneId: '%0' });

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix')).resolves.toBe(false);
  });

  it('unbound phase is skipped when the agent is bound to a different task', async () => {
    const t = await harness.seedTask({
      status: 'review', signalToken: 'tok123456789',
      reviewHeadAnchorSha: 'a'.repeat(40), passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb',
    });
    await harness.seedAgent({ id: 'qa-1', taskId: 'other-task', paneId: '%1' });

    await expect(harness.manager.continueSession(t.id, 'qa-1', 'recheck')).resolves.toBe(false);
  });

  it('a dirty checkout blocks a dev continuation unless allowDirtyWorkdir marks it as in-flight resume', async () => {
    const t = await seedContinueFix();
    vi.mocked(BranchManager.prototype.assertClean)
      .mockRejectedValue(new DirtyWorkdirError('/tmp/repo'));

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix')).rejects.toBeInstanceOf(DirtyWorkdirError);
    expect(harness.runner.pastedPrompts).toEqual([]);
    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix', { allowDirtyWorkdir: true }))
      .resolves.toBe(true);
    expect(harness.runner.pastedPrompts).toEqual([{ pane: '%0', body: expect.stringContaining('phase: fix') }]);
  });

  it.each([
    { context: 'unknown', marker: null },
    { context: 'another task', marker: 'task-before-this-one' },
  ])('injects the full continuation without /clear, then remembers the task on $context context', async ({ marker }) => {
    const t = await seedContinueFix({
      title: 'Context boundary title',
      description: 'Context boundary description',
    });
    if (marker) harness.runner.sessions.seed('dev-1', { options: { [CONTEXT_OPTION]: marker } });

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix')).resolves.toBe(true);

    const trace = cmds();
    const pasteAt = trace.findIndex(c => c.includes('paste-buffer'));
    const rememberAt = trace.findIndex(c => c.includes('set-option') && c.includes(CONTEXT_OPTION));
    expect(pasteAt).toBeGreaterThanOrEqual(0);
    expect(rememberAt).toBeGreaterThan(pasteAt);
    const [prompt] = bodies();
    expect(prompt).toContain('title: Context boundary title');
    expect(prompt).toContain('Context boundary description');
    expect(harness.runner.sentKeys.some(k => k.includes('/clear'))).toBe(false);
    expect(harness.runner.sessions.option('dev-1', CONTEXT_OPTION)).toBe(t.id);
  });

  it('keeps same-task context and sends only the next phase increment', async () => {
    const t = await seedContinueFix({
      title: 'Preserved context title',
      description: 'Preserved context description',
    });
    harness.runner.sessions.seed('dev-1', { options: { [CONTEXT_OPTION]: t.id } });

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix')).resolves.toBe(true);

    const [prompt] = bodies();
    expect(prompt).toContain(`task: ${t.id}`);
    expect(prompt).toContain('phase: fix');
    expect(prompt).toContain('token: tok123456789');
    expect(prompt).not.toContain('Preserved context title');
    expect(prompt).not.toContain('Preserved context description');
    expect(prompt).not.toContain('Task contract');
    expect(prompt).not.toContain('Protocol:');
    expect(contextWrites()).toEqual([]);
  });

  it('restores the task branch checkout when a dev continuation left it and the tree is clean', async () => {
    const t = await seedContinueFix();
    vi.mocked(BranchManager.prototype.currentRef).mockResolvedValue(null);
    const switchSpy = vi.mocked(BranchManager.prototype.switchToTaskBranch);

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix')).resolves.toBe(true);
    expect(switchSpy).toHaveBeenCalledWith('/tmp/repo', t.id, t.branch, true, { requireExistingWork: true });
    expect(harness.runner.pastedPrompts).toHaveLength(1);
  });

  it('restores the checkout on an allowDirtyWorkdir continuation too (switch enforces cleanliness itself)', async () => {
    const t = await seedContinueFix();
    vi.mocked(BranchManager.prototype.currentRef).mockResolvedValue('refs/heads/other-branch');
    const switchSpy = vi.mocked(BranchManager.prototype.switchToTaskBranch);

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix', { allowDirtyWorkdir: true }))
      .resolves.toBe(true);
    expect(switchSpy).toHaveBeenCalledWith('/tmp/repo', t.id, t.branch, true, { requireExistingWork: true });
    expect(harness.runner.pastedPrompts).toHaveLength(1);
  });

  it('hands the branchLocalCleaned credential to the checkout restore and clears it on success', async () => {
    const t = await seedContinueFix({
      branchLocalCleaned: { remoteTipSha: 'b'.repeat(40), updatedAt: NOW },
    });
    vi.mocked(BranchManager.prototype.currentRef).mockResolvedValue(null);
    const switchSpy = vi.mocked(BranchManager.prototype.switchToTaskBranch);

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix')).resolves.toBe(true);
    expect(switchSpy).toHaveBeenCalledWith(
      '/tmp/repo', t.id, t.branch, true,
      { requireExistingWork: true, restorableRemoteTip: 'b'.repeat(40) },
    );
    expect((await harness.taskStore.get(t.id))?.branchLocalCleaned).toBeUndefined();
  });

  it('a checkout mismatch on a dirty tree stays fail-closed and never dispatches', async () => {
    const t = await seedContinueFix();
    vi.mocked(BranchManager.prototype.currentRef).mockResolvedValue('refs/heads/other-branch');
    vi.mocked(BranchManager.prototype.switchToTaskBranch)
      .mockRejectedValue(new DirtyWorkdirError('/tmp/repo'));

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix', { allowDirtyWorkdir: true }))
      .rejects.toBeInstanceOf(DirtyWorkdirError);
    expect(harness.runner.pastedPrompts).toEqual([]);
    expect(harness.runner.execWithStdin).not.toHaveBeenCalled();
  });

  async function pasteDevelopContinuation(overrides: Partial<TaskState>): Promise<string> {
    const t = await harness.seedTask({ status: 'in_progress', signalToken: 'tok123456789', ...overrides });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'develop', {
      signalToken: 'tok123456789',
      allowDirtyWorkdir: true,
    })).resolves.toBe(true);
    return bodies()[0]!;
  }

  it('a develop continuation carries only the rotating token', async () => {
    const prompt = await pasteDevelopContinuation({});

    expect(prompt).toContain('token: tok123456789');
    expect(prompt).not.toMatch(/^(?:spec-)?signal:/m);
  });

  it('rethrows without killSession when the runtime is blocked on a startup dialog: agent held, task failed', async () => {
    const t = await seedContinueFix();
    const runner = liveRunner({ agents: { 'dev-1': { screen: STARTUP_DIALOG } } });

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix')).rejects.toMatchObject({
      partial: expect.objectContaining({ dialogPending: true, handled: true }),
    });

    await expectDialogHold(runner, 'dev-1');
    expect((await harness.taskStore.get(t.id))?.status).toBe('failed');
    expect(runner.pastedPrompts).toEqual([]);
  });

  it('kills the orphan session when ensureSession fails after creating one', async () => {
    const t = await seedContinueFix();
    const runner = liveRunner({ session: 'absent', rules: [LAUNCH_FAILS, KILL_FAILS] });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix')).rejects.toMatchObject({
      name: 'EnsureSessionError',
      partial: expect.objectContaining({ createdSession: true }),
    });
    expect(traceOrder(runner, ['tmux new-session', 'send-keys -l', 'kill-session'])).toBe(true);
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('created-session rollback') && String(c[0]).includes('failed'))).toBe(true);
    expect(runner.pastedPrompts).toEqual([]);
    warnSpy.mockRestore();
  });

  it.each(PROMPT_STAGE_FAILURES)('$reason at the prompt stage fails the continuation', async ({ task, reason }) => {
    const t = await seedContinueFix(task);

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix')).rejects.toMatchObject({
      name: 'DispatchTerminalError',
      reason,
    });
    expect(harness.runner.pastedPrompts).toEqual([]);
  });

  it.each([
    { name: 'terminal', fresh: { status: 'cancelled' as const } },
    { name: 'missing', fresh: null },
    { name: 'status-drifted', fresh: { status: 'review' as const } },
  ])('skips the paste when the task is $name at the pre-paste gate', async ({ fresh }) => {
    const t = await seedContinueFix();
    const realGet = harness.taskStore.get.bind(harness.taskStore);
    let calls = 0;
    vi.spyOn(harness.taskStore, 'get').mockImplementation(async (id) => {
      calls += 1;
      if (calls >= 2) return fresh === null ? null : { ...t, ...fresh };
      return realGet(id);
    });

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix')).resolves.toBe(false);
    expect(harness.runner.pastedPrompts).toEqual([]);
  });

  it('skips the paste when the bound agent loses the binding pre-paste', async () => {
    const t = await seedContinueFix();
    const realGet = harness.agentStore.get.bind(harness.agentStore);
    let calls = 0;
    vi.spyOn(harness.agentStore, 'get').mockImplementation(async (id) => {
      calls += 1;
      if (calls >= 2) return { id: 'dev-1', projectId: 'proj', updatedAt: NOW };
      return realGet(id);
    });

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'fix')).resolves.toBe(false);
    expect(harness.runner.pastedPrompts).toEqual([]);
  });

  it('skips the paste when an unbound-phase agent gets reassigned pre-paste', async () => {
    const t = await harness.seedTask({
      status: 'review', signalToken: 'tok123456789',
      reviewHeadAnchorSha: 'a'.repeat(40), passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb',
    });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    const realGet = harness.agentStore.get.bind(harness.agentStore);
    let calls = 0;
    // 前两次读是 pre-paste 与 ensure 之后的绑定复核;第三次是提示构建之后、粘贴之前的复核
    vi.spyOn(harness.agentStore, 'get').mockImplementation(async (id) => {
      calls += 1;
      if (calls >= 3) return { id: 'qa-1', projectId: 'proj', taskId: 'stolen-task', updatedAt: NOW };
      return realGet(id);
    });

    await expect(harness.manager.continueSession(t.id, 'qa-1', 'recheck')).resolves.toBe(false);
    expect(harness.runner.pastedPrompts).toEqual([]);
  });

  it('post-approve skips the paste when the completion token rotates before injection', async () => {
    const t = await harness.seedTask({
      status: 'approved',
      postApproveToken: 'tok', postApproveHeadSha: 'a'.repeat(40), postApproveGeneration: 'abcdef012345', postApprovePhase: 'installed',
    });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    let rotated = false;
    // 会话确认后读任务上下文标记的那一刻(注入之前)完成令牌轮换
    const runner = liveRunner({
      onExec: async cmd => {
        if (rotated || !cmd.includes(CONTEXT_OPTION)) return;
        rotated = true;
        const fresh = (await harness.taskStore.get(t.id))!;
        await harness.taskStore.set({ ...fresh, postApproveToken: 'rotated', updatedAt: new Date().toISOString() });
      },
    });

    await expect(harness.manager.continueSession(t.id, 'dev-1', 'post-approve', { signalToken: 'tok' }))
      .resolves.toBe(false);
    expect(rotated).toBe(true);
    expect(runner.pastedPrompts).toEqual([]);
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
      ok: true, prUrl: 'https://github.com/user/repo/pull/42', headSha: SHA, branch: 'bx/task-1', targetBranch: 'main',
    });
    await expect(manager.verifyPaneSignalPrNumber('nope', 12)).resolves.toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
  });

  it('returns undefined for a task without branch', async () => {
    const { manager, verify } = driverManager({
      ok: true, prUrl: 'https://github.com/user/repo/pull/42', headSha: SHA, branch: 'bx/task-1', targetBranch: 'main',
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
      ok: true, prUrl: 'https://github.com/user/repo/pull/42', headSha: SHA, branch: 'bx/task-1', targetBranch: 'main',
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
