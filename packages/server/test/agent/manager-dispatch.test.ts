import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { BaxianConfig } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
import type { AgentManagerDeps } from '../../src/agent/manager.js';
import { ReplNotReadyError } from '../../src/agent/tmux.js';
import { BranchManager, DirtyWorkdirError, ReviewHeadMismatchError } from '../../src/agent/branch.js';
import { classifyScreen } from '../../src/agent/detect/classify.js';
import type { FakeRunner, FakeRunnerOptions } from '../helpers/fake-runner.js';
import { createManagerSuiteRunner, useManagerSuiteHarness } from '../helpers/manager-harness.js';

const GIT_BINDING = { repoKey: 'github.com/user/repo' };
const REVIEW_HEAD = 'a'.repeat(40);
const harness = useManagerSuiteHarness();

const bodies = (runner: FakeRunner = harness.runner): string[] => runner.pastedPrompts.map(p => p.body);
const cmds = (runner: FakeRunner = harness.runner): string[] => runner.exec.mock.calls.map(c => c[0] as string);

type LiveRunnerOptions = Omit<FakeRunnerOptions, 'onExec'> & {
  workdirs?: Record<string, string>;
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

// 注入前置检查是「读标题 → 抓屏」相邻两步;就绪等待与 adopt 探测都是「读前台 → 抓屏」
function atPreInjectCapture(fn: (runner: FakeRunner) => void | Promise<void>): LiveRunnerOptions['onExec'] {
  let prev = '';
  let fired = false;
  return async (cmd, runner) => {
    const hit = !fired && cmd.includes('capture-pane') && prev.includes('pane_title');
    prev = cmd;
    if (!hit) return;
    fired = true;
    await fn(runner);
  };
}

describe('AgentManager.startSession status gate', () => {
  it('rejects terminal task even when bypassTaskStatusGate=true', async () => {
    await harness.seedTask({ status: 'cancelled' });
    await harness.seedAgent({ id: 'qa-1' });

    const result = await harness.manager.startSession('task-1', 'qa-1', 'review', {
      bypassTaskStatusGate: true,
    });
    expect(result).toBe(false);
    expect((await harness.taskStore.get('task-1'))?.status).toBe('cancelled');
  });
});

describe('AgentManager dispatch', () => {
  it('startSession develop prompt carries the compact inline completion contract', async () => {
    const t = await harness.seedTask({ id: 'task-spec-route-1', branch: 'bx/task-spec-route-1', signalToken: 'devtok1234ab' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');

    const ok = await harness.manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);
    expect(harness.runner.pastedPrompts).toHaveLength(1);
    expect(harness.runner.pastedPrompts[0]!.pane).toBe('%0');
    expect(bodies()[0]).toContain('token: devtok1234ab');
    expect(bodies()[0]).not.toMatch(/^(?:spec-)?signal:/m);
  });

  it('startSession assertOwner gates on generation: a DELETE→recreate during ensureSession aborts before checkout', async () => {
    const t = await harness.seedTask({ id: 'task-ss-aba', branch: 'bx/task-ss-aba', signalToken: 'ssaba1234ab' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');
    // adopt 的最后一步是回写 @baxian-workdir:此刻 DELETE→recreate,会话已拿到但代次已变
    const runner = liveRunner({
      onExec: cmd => { if (cmd.includes('@baxian-workdir')) harness.manager.bumpDeletionGeneration('dev-1'); },
    });

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).rejects.toThrow(/being deleted/);

    expect(cmds(runner).some(c => c.includes('@baxian-workdir'))).toBe(true);
    expect(BranchManager.prototype.switchToTaskBranch).not.toHaveBeenCalled();
    expect(runner.pastedPrompts).toEqual([]);
  });

  it('startSession develop prompt stays kind-free when the task snapshot has QA', async () => {
    const t = await harness.seedTask({
      id: 'task-hasqa-1',
      branch: 'bx/task-hasqa-1',
      qaAgentId: 'qa-1',
      signalToken: 'devtok5678cd',
    });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');

    const ok = await harness.manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);
    expect(bodies()[0]).toContain('token: devtok5678cd');
    expect(bodies()[0]).not.toMatch(/^(?:spec-)?signal:/m);
  });

  it('startSession marks bootstrappingTaskId during dispatch and clears it once the prompt is ack\'d', async () => {
    const t = await harness.seedTask({
      id: 'task-deliver-1',
      branch: 'bx/task-deliver-1',
      signalToken: 'deliver123456',
    });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');
    expect((await harness.agentStore.get('dev-1'))?.bootstrappingTaskId).toBeUndefined();

    let markerDuringPaste: string | undefined;
    liveRunner({
      onExec: async cmd => {
        if (cmd.includes('paste-buffer')) markerDuringPaste = (await harness.agentStore.get('dev-1'))?.bootstrappingTaskId;
      },
    });
    let markerAtSessionStarted: string | undefined = 'unset';
    harness.eventBus.on('session.started', async () => {
      markerAtSessionStarted = (await harness.agentStore.get('dev-1'))?.bootstrappingTaskId;
    });

    const ok = await harness.manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);
    expect(markerDuringPaste).toBe(t.id);
    expect(markerAtSessionStarted).toBeUndefined();
    expect((await harness.agentStore.get('dev-1'))?.bootstrappingTaskId).toBeUndefined();
  });

  it.each(['fix', 'post-approve'])(
    'leaves no bootstrap marker when an idle dev is reacquired for %s, since nothing clears it later',
    async (phase) => {
      const t = await harness.seedTask({
        id: 'task-fix-marker', branch: 'bx/task-fix-marker', status: 'fixing',
      });
      await harness.seedAgent({ id: 'dev-1' });

      const acquired = await harness.manager.acquireAgentForTask('dev-1', t.id, phase);

      expect(acquired).toBe(true);
      expect((await harness.agentStore.get('dev-1'))?.bootstrappingTaskId).toBeUndefined();
    },
  );

  it('marks the parked dev as bootstrapping again when the same task re-enters for code', async () => {
    const t = await harness.seedTask({
      id: 'task-code-marker', branch: 'bx/task-code-marker', status: 'spec-ready',
    });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });

    const acquired = await harness.manager.acquireAgentForTask('dev-1', t.id, 'code');

    expect(acquired).toBe(true);
    expect((await harness.agentStore.get('dev-1'))?.bootstrappingTaskId).toBe(t.id);
  });

  it.each(['review', 'recheck'])(
    'marks the QA binding as bootstrapping when the %s lease is acquired, before the workdir is prepared',
    async (qaPhase) => {
      const t = await harness.seedTask({
        id: 'task-qa-marker', branch: 'bx/task-qa-marker', status: 'review', qaAgentId: 'qa-1',
      });
      await harness.seedAgent({ id: 'qa-1' });

      const acquired = await harness.manager.acquireAgentForTask('qa-1', t.id, qaPhase);

      expect(acquired).toBe(true);
      expect((await harness.agentStore.get('qa-1'))?.bootstrappingTaskId).toBe(t.id);
    },
  );

  it('startSession holds (not destructively cleans up) when clearing the bootstrap marker fails after delivery', async () => {
    const t = await harness.seedTask({
      id: 'task-deliver-2',
      branch: 'bx/task-deliver-2',
      signalToken: 'deliver234567',
    });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');

    const realUpdate = harness.agentStore.update.bind(harness.agentStore);
    let threwOnce = false;
    vi.spyOn(harness.agentStore, 'update').mockImplementation(async (id, updater) => {
      // 提示粘贴之后的第一次绑定写入就是清 bootstrap 标记
      if (harness.runner.pastedPrompts.length > 0 && !threwOnce) { threwOnce = true; throw new Error('marker-clear write blip'); }
      return realUpdate(id, updater);
    });

    const ok = await harness.manager.startSession(t.id, 'dev-1', 'develop');

    expect(ok).toBe(true);
    expect(BranchManager.prototype.parkOnDefaultDetached).not.toHaveBeenCalled();
    expect(await harness.agentStore.get('dev-1')).toMatchObject({
      taskId: t.id,
      bootstrappingTaskId: t.id,
      status: 'awaiting_human',
      awaitingPhase: 'bootstrap-marker-clear-failed',
    });
  });

  it('startSession runs armBeforeInject before pasting the prompt', async () => {
    const t = await harness.seedTask({
      id: 'task-arm-before',
      branch: 'bx/task-arm-before',
      signalToken: 'armbefore1234',
    });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');

    let promptsAtArm = -1;
    const ok = await harness.manager.startSession(t.id, 'dev-1', 'develop', {
      armBeforeInject: async () => { promptsAtArm = harness.runner.pastedPrompts.length; return true; },
    });

    expect(ok).toBe(true);
    expect(promptsAtArm).toBe(0);
    expect(harness.runner.pastedPrompts).toHaveLength(1);
  });

  it('startSession aborts without pasting when armBeforeInject returns false', async () => {
    const t = await harness.seedTask({
      id: 'task-arm-abort',
      branch: 'bx/task-arm-abort',
      signalToken: 'armabort12345',
    });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');

    const ok = await harness.manager.startSession(t.id, 'dev-1', 'develop', {
      armBeforeInject: async () => false,
    });

    expect(ok).toBe(false);
    expect(harness.runner.pastedPrompts).toEqual([]);
    expect(harness.runner.sessions.pane('dev-1')!.phase).toBe('idle');
  });

  function managedCloneConfig(): BaxianConfig {
    return {
      review: { rounds: 2 },
      server: DEFAULT_SERVER_CONFIG,
      project: [{
        id: 'proj',
        repo: 'https://github.com/user/repo.git',
        merge: null,
        agent: [[
          { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local' },
          { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local' },
        ]],
      }],
    } as BaxianConfig;
  }

  // 托管 clone 没有配置 Workdir:RepoStore 替身(E4)给出 <tempDir>/<agentId>,pane 的 current_path 必须与之一致才能 adopt
  function managedClone(options: LiveRunnerOptions = {}, deps: Partial<AgentManagerDeps> = {}) {
    const workdirs = { 'dev-1': join(harness.tempDir, 'dev-1'), 'qa-1': join(harness.tempDir, 'qa-1') };
    const runner = liveRunner({ workdirs, ...options }, { config: managedCloneConfig(), ...deps });
    return { runner, workdirs };
  }

  async function seedReviewTask(id: string, overrides: Record<string, unknown> = {}) {
    return harness.seedTask({
      id, branch: `bx/${id}`, status: 'review',
      platformBinding: GIT_BINDING, passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb',
      latestHeadSha: REVIEW_HEAD, reviewHeadAnchorSha: REVIEW_HEAD, qaAgentId: 'qa-1',
      ...overrides,
    });
  }

  it('startSession develop surfaces an unresolvable origin/HEAD from fixed-Workdir branch switching', async () => {
    const { runner, workdirs } = managedClone();
    const t = await harness.seedTask({ id: 'task-nohead', branch: 'bx/task-nohead' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');
    const switchSpy = vi.spyOn(BranchManager.prototype, 'switchToTaskBranch')
      .mockRejectedValue(new Error('Cannot resolve commit origin/HEAD'));

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).rejects.toThrow(/origin\/HEAD/);

    expect(switchSpy).toHaveBeenCalledWith(workdirs['dev-1'], t.id, t.branch, true, {});
    expect(await harness.agentStore.get('dev-1')).toMatchObject({
      taskId: t.id,
      workdir: workdirs['dev-1'],
      status: 'awaiting_human',
      awaitingPhase: 'checkout-preparation-failed',
    });
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
    expect(runner.pastedPrompts).toEqual([]);
  });

  it('startSession holds the task and lock when the fixed Workdir is dirty', async () => {
    const { runner, workdirs } = managedClone();
    const t = await harness.seedTask({ id: 'task-dirty', branch: 'bx/task-dirty' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');
    vi.spyOn(BranchManager.prototype, 'switchToTaskBranch')
      .mockRejectedValue(new DirtyWorkdirError(workdirs['dev-1']));

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).rejects.toMatchObject({
      partial: expect.objectContaining({ handled: true }),
    });
    expect(await harness.agentStore.get('dev-1')).toMatchObject({
      taskId: t.id,
      status: 'awaiting_human',
      awaitingPhase: 'dirty-workdir',
    });
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
    expect(runner.pastedPrompts).toEqual([]);
  });

  it('startSession recheck 遇忙不落 hold：登记 qa-recheck pending 并抛 busyPending', async () => {
    const { runner } = managedClone({ ackHoldCaptures: Infinity }, { cleanComposerWaitMs: 50 });
    runner.sessions.markWorking('qa-1');
    const t = await seedReviewTask('task-busyq', { prNumber: 7, signalToken: 'tokA12345678' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await harness.acquireAgentLock('qa-1', t.id);

    await expect(harness.manager.startSession(t.id, 'qa-1', 'recheck', {
      dispatchPassToken: 'tokA12345678',
    })).rejects.toMatchObject({
      partial: expect.objectContaining({ handled: true, busyPending: true }),
    });
    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.status).toBeUndefined();
    expect(qa?.awaitingPhase).toBeUndefined();
    expect(qa?.taskId).toBe(t.id);
    expect(await harness.lockManager.isLocked('qa-1')).toBe(true);
    expect(runner.pastedPrompts).toEqual([]);
    expect(harness.manager.getPendingDispatchRetry(t.id)).toMatchObject({
      kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'tokA12345678',
      qaPhase: 'recheck',
    });
  });

  it('startSession recheck 遇 codex 补全浮层（manifest 判 idle）→ 与遇忙同路：登记 qa-recheck pending 并抛 busyPending', async () => {
    const popup = 'permissions: YOLO mode\n\n› $bax\n  $baxian-task  Dispatch\n\n  Press enter to insert or esc to close\n';
    const { runner } = managedClone(
      { agents: { 'qa-1': { screen: popup, title: '' } } },
      { cleanComposerWaitMs: 50, readyStableSpacingMs: 5 },
    );
    const t = await seedReviewTask('task-popup', { prNumber: 8, signalToken: 'tokP12345678' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await harness.acquireAgentLock('qa-1', t.id);

    await expect(harness.manager.startSession(t.id, 'qa-1', 'recheck', {
      dispatchPassToken: 'tokP12345678',
    })).rejects.toMatchObject({
      partial: expect.objectContaining({ handled: true, busyPending: true }),
    });
    expect(await harness.lockManager.isLocked('qa-1')).toBe(true);
    expect(runner.pastedPrompts).toEqual([]);
    expect(harness.manager.getPendingDispatchRetry(t.id)).toMatchObject({
      kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'tokP12345678', qaPhase: 'recheck',
    });
  });

  it('startSession 遇忙但 pass 已被接管（fence 令牌漂移）→ 不登记 pending，走原始失败路径', async () => {
    const { runner } = managedClone({ ackHoldCaptures: Infinity }, { cleanComposerWaitMs: 50 });
    runner.sessions.markWorking('qa-1');
    const t = await seedReviewTask('task-busysup', { prNumber: 9, signalToken: 'successor-tk' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await harness.acquireAgentLock('qa-1', t.id);

    await expect(harness.manager.startSession(t.id, 'qa-1', 'recheck', {
      dispatchPassToken: 'old-pass-tok1',
    })).rejects.toBeInstanceOf(ReplNotReadyError);
    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeUndefined();
  });

  it('startSession 遇忙且无 fence 令牌 → fail closed 不登记', async () => {
    const { runner } = managedClone({ ackHoldCaptures: Infinity }, { cleanComposerWaitMs: 50 });
    runner.sessions.markWorking('qa-1');
    const t = await seedReviewTask('task-busynof', { prNumber: 10, signalToken: 'tokNF1234567' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await harness.acquireAgentLock('qa-1', t.id);

    await expect(harness.manager.startSession(t.id, 'qa-1', 'recheck')).rejects.toBeInstanceOf(ReplNotReadyError);
    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeUndefined();
  });

  it('startSession 遇忙且令牌核验读失败 → fail closed 不登记', async () => {
    const { runner } = managedClone({ ackHoldCaptures: Infinity }, { cleanComposerWaitMs: 50 });
    runner.sessions.markWorking('qa-1');
    const t = await seedReviewTask('task-busyrd', { prNumber: 10, signalToken: 'tokNF1234567' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await harness.acquireAgentLock('qa-1', t.id);
    const realGet = harness.taskStore.get.bind(harness.taskStore);
    // 抓屏判忙之后的第一次任务读就是 pass 令牌核验
    vi.spyOn(harness.taskStore, 'get').mockImplementation(async (id) => {
      if (cmds(runner).some(c => c.includes('capture-pane'))) throw new Error('store read failed');
      return realGet(id);
    });

    await expect(harness.manager.startSession(t.id, 'qa-1', 'recheck', {
      dispatchPassToken: 'tokNF1234567',
    })).rejects.toBeInstanceOf(ReplNotReadyError);
    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeUndefined();
  });

  it('注入阶段预注入忙碌检查命中：同样登记 pending 而非 cleanup/release', async () => {
    const blocker = 'permissions: YOLO mode\n\n› \n\n• Ran rm -rf dist\n  Allow command?\n  press enter to confirm or esc to cancel\n';
    expect(classifyScreen('codex', blocker, 'codex').state).toBe('pending');
    // 就绪等待通过后、注入前置抓屏时才出现审批遮挡;workingTitle 取 idle 标题,让判定只看屏幕
    const { runner } = managedClone({
      agents: { 'qa-1': { workingTitle: 'codex' } },
      onExec: atPreInjectCapture(r => r.sessions.markWorking('qa-1', blocker)),
    });
    const t = await seedReviewTask('task-busyinj', { prNumber: 12, signalToken: 'tokINJ123456' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await harness.acquireAgentLock('qa-1', t.id);

    await expect(harness.manager.startSession(t.id, 'qa-1', 'recheck', {
      dispatchPassToken: 'tokINJ123456',
    })).rejects.toMatchObject({
      partial: expect.objectContaining({ handled: true, busyPending: true }),
    });
    expect(BranchManager.prototype.parkOnDefaultDetached).not.toHaveBeenCalled();
    expect(runner.pastedPrompts).toEqual([]);
    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.status).toBeUndefined();
    expect(harness.manager.getPendingDispatchRetry(t.id)).toMatchObject({
      kind: 'qa-recheck', signalToken: 'tokINJ123456',
    });
  });

  it('pending 登记按代保留预算：同代刷新沿用 since/alerted，pass 换代即重置', async () => {
    harness.manager.registerPendingDispatchRetry('task-gen', { kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'gen-a' });
    const first = harness.manager.getPendingDispatchRetry('task-gen')!;
    harness.manager.markPendingDispatchRetryBudgetAlerted('task-gen', { agentId: 'qa-1', signalToken: 'gen-a' });
    harness.manager.markPendingDispatchRetryBudgetAlerted('task-gen', { agentId: 'qa-1', signalToken: 'gen-stale' });

    harness.manager.registerPendingDispatchRetry('task-gen', { kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'gen-a' });
    const sameGen = harness.manager.getPendingDispatchRetry('task-gen')!;
    expect(sameGen.since).toBe(first.since);
    expect(sameGen.budgetAlerted).toBe(true);

    await new Promise(r => setTimeout(r, 2));
    harness.manager.registerPendingDispatchRetry('task-gen', { kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'gen-b' });
    const nextGen = harness.manager.getPendingDispatchRetry('task-gen')!;
    expect(nextGen.since).toBeGreaterThan(first.since);
    expect(nextGen.budgetAlerted).toBeUndefined();
  });

  it('startSession 携带 pass guard 到 paste fence：粘贴前 pass 令牌漂移则不粘贴', async () => {
    const t = await seedReviewTask('task-fence2', { prNumber: 14, signalToken: 'tokF212345678'.slice(0, 12) });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await harness.acquireAgentLock('qa-1', t.id);
    const { runner } = managedClone({
      onExec: atPreInjectCapture(async () => {
        const fresh = (await harness.taskStore.get(t.id))!;
        await harness.taskStore.set({ ...fresh, signalToken: 'rotated-mid99', updatedAt: new Date().toISOString() });
      }),
    });

    await expect(harness.manager.startSession(t.id, 'qa-1', 'recheck', {
      dispatchPassToken: t.signalToken,
    })).resolves.toBe(false);

    expect(runner.pastedPrompts).toEqual([]);
    expect(runner.execWithStdin).not.toHaveBeenCalled();
    expect(runner.sessions.pane('qa-1')).toMatchObject({ phase: 'idle', composer: '' });
  });

  it('paste fence 的 guard 同时复核任务状态：粘贴后、回车前 cancelled（token 未变）→ 不提交并清稿', async () => {
    const t = await seedReviewTask('task-fence4', { prNumber: 16, signalToken: 'cancel-tok88' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await harness.acquireAgentLock('qa-1', t.id);
    // 粘贴前的 revalidate 也会拦 terminal;只有粘贴之后才能证明回车前的 fence 自己复核了状态
    const { runner } = managedClone({
      onExec: async cmd => {
        if (!cmd.includes('paste-buffer')) return;
        const fresh = (await harness.taskStore.get(t.id))!;
        if (fresh.status === 'cancelled') return;
        await harness.taskStore.set({ ...fresh, status: 'cancelled', updatedAt: new Date().toISOString() });
      },
    });

    await expect(harness.manager.startSession(t.id, 'qa-1', 'recheck', {
      dispatchPassToken: 'cancel-tok88',
    })).resolves.toBe(false);

    expect(runner.pastedPrompts.map(p => p.pane)).toEqual(['%1']);
    expect(runner.sentKeys.some(k => /send-keys -t %1 .*Enter/.test(k))).toBe(false);
    expect(runner.sessions.pane('qa-1')).toMatchObject({ phase: 'idle', composer: '' });
  });

  it('startSession 成功只按代清除本次派发的 pending：successor 登记不受影响', async () => {
    const { runner } = managedClone();
    const t = await seedReviewTask('task-clearp', { prNumber: 11, signalToken: 'tokCL1234567' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await harness.acquireAgentLock('qa-1', t.id);
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'tokCL1234567' });

    expect(await harness.manager.startSession(t.id, 'qa-1', 'recheck', {
      dispatchPassToken: 'tokCL1234567',
    })).toBe(true);
    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeUndefined();

    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'succ-tok1234' });
    expect(await harness.manager.startSession(t.id, 'qa-1', 'recheck', {
      dispatchPassToken: 'tokCL1234567',
    })).toBe(true);
    expect(harness.manager.getPendingDispatchRetry(t.id)).toMatchObject({ signalToken: 'succ-tok1234' });
    expect(runner.pastedPrompts.map(p => p.pane)).toEqual(['%1', '%1']);
  });

  it('startSession develop switches the fixed Workdir to the exact baxian task branch', async () => {
    const { runner, workdirs } = managedClone();
    const t = await harness.seedTask({
      id: 'task-headok',
      branch: 'bx/task-headok',
      signalToken: 'headok123456',
    });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');
    const switchSpy = vi.mocked(BranchManager.prototype.switchToTaskBranch);

    const ok = await harness.manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);
    expect(switchSpy).toHaveBeenCalledWith(workdirs['dev-1'], t.id, t.branch, true, {});
    expect(runner.pastedPrompts).toEqual([{ pane: '%0', body: expect.stringContaining('phase: develop') }]);
  });

  it('startSession review checks out the remote PR branch detached in the QA Workdir', async () => {
    const { runner, workdirs } = managedClone();
    const t = await seedReviewTask('task-ghrev', { prNumber: 7, signalToken: 'revtok1234ab' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await harness.acquireAgentLock('qa-1');
    const switchSpy = vi.mocked(BranchManager.prototype.switchToRemoteBranchDetached);

    const ok = await harness.manager.startSession(t.id, 'qa-1', 'review');
    expect(ok).toBe(true);
    expect(switchSpy).toHaveBeenCalledWith(workdirs['qa-1'], t.branch, REVIEW_HEAD);
    expect(runner.pastedPrompts).toEqual([{ pane: '%1', body: expect.stringContaining('phase: review') }]);
  });

  it('resolves a moved review head through the driver, never the hardcoded gh path', async () => {
    const { runner, workdirs } = managedClone();
    const NEW = 'c'.repeat(40);
    const t = await seedReviewTask('task-moved', { prNumber: 7, signalToken: 'movtok123456' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await harness.acquireAgentLock('qa-1');

    const driverSpy = vi.spyOn(harness.manager, 'platformFetchPrView').mockResolvedValue({ headSha: NEW } as never);
    let call = 0;
    const switchSpy = vi.spyOn(BranchManager.prototype, 'switchToRemoteBranchDetached')
      .mockImplementation(async () => {
        if (call++ === 0) throw new ReviewHeadMismatchError('bx/task-moved', REVIEW_HEAD, NEW);
      });

    const ok = await harness.manager.startSession(t.id, 'qa-1', 'review');

    expect(ok).toBe(true);
    expect(driverSpy).toHaveBeenCalledWith('task-moved');
    expect(switchSpy).toHaveBeenLastCalledWith(workdirs['qa-1'], 'bx/task-moved', NEW);
    expect((await harness.taskStore.get(t.id))?.latestHeadSha).toBe(NEW);
    expect(runner.pastedPrompts).toHaveLength(1);
  });
});
