import { describe, it, expect } from 'vitest';
import type { TaskState } from '../../src/shared/index.js';
import type { AgentManagerDeps } from '../../src/agent/manager.js';
import { ReplNotReadyError } from '../../src/agent/tmux.js';
import { createManagerSuiteRunner, useManagerSuiteHarness } from '../helpers/manager-harness.js';
import type { FakeRunner, FakeRunnerOptions } from '../helpers/fake-runner.js';

const harness = useManagerSuiteHarness();

const CODEX_BUSY = '• Working (12s • esc to interrupt)\n  gpt-5.5 xhigh · ~/repo\n  permissions: YOLO mode\n';
// tmux keeps styled blank cells, so the separator rows arrive as single spaces
const CODEX_IDLE_STYLED_BLANKS =
  '─ Worked for 9m 16s ───────\n \n \n› Ask Codex to do anything\n \n  gpt-5.5 xhigh · ~/repo\n';
const BUSY_WINDOW = { cleanComposerWaitMs: 60 };

// probeReplPrompt 的抓屏形态(不带 -e);waitReplReady 与 adopt 的抓屏带 -e,不计入
const isReadyProbe = (cmd: string): boolean => cmd.includes('capture-pane -p -J -S 0');

function useRunner(options: FakeRunnerOptions = {}, timing: Partial<AgentManagerDeps> = {}): FakeRunner {
  const runner = createManagerSuiteRunner(options);
  harness.runner = runner;
  harness.manager = harness.createManager({ runnerFactory: () => runner, ...timing });
  return runner;
}

async function seedReview(): Promise<TaskState> {
  const task = await harness.seedTask({
    id: 'task-review',
    status: 'review',
    signalToken: 'tok123456789',
    latestHeadSha: 'a'.repeat(40),
    reviewHeadAnchorSha: 'a'.repeat(40),
    passToken: 'aaaaaaaaaaaa',
    failToken: 'bbbbbbbbbbbb',
  });
  await harness.seedAgent({ id: 'qa-1', taskId: task.id, paneId: '%1' });
  await harness.acquireAgentLock('qa-1', task.id);
  return task;
}

// review 派发前的 stableIdle 等待是 waitForReplPromptReady 的去抖入口
const reviewDispatch = (task: TaskState): Promise<boolean> => harness.manager.startSession(task.id, 'qa-1', 'review');
const cmds = (): string[] => harness.runner.exec.mock.calls.map(c => String(c[0]));
const before = (marker: string): string[] => {
  const at = cmds().findIndex(c => c.includes(marker));
  return at === -1 ? cmds() : cmds().slice(0, at);
};
// 预注入抓屏与就绪采样同一命令形态,清稿前的探针数减一才是采样数
const idleSamplesBeforeClear = (): number => before('send-keys -l').filter(isReadyProbe).length - 1;

// 第 n 次就绪探针之前把 pane 切成给定相位
function paneAtProbe(transitions: Record<number, 'busy' | 'idle' | 'exited'>): FakeRunnerOptions['onExec'] {
  let probes = 0;
  return cmd => {
    if (!isReadyProbe(cmd)) return;
    const next = transitions[++probes];
    if (next === 'busy') harness.runner.sessions.markWorking('qa-1', CODEX_BUSY);
    if (next === 'idle') harness.runner.sessions.setProcess('qa-1', 'codex');
    if (next === 'exited') harness.runner.sessions.setProcess('qa-1', 'zsh');
  };
}

describe('waitForReplPromptReady 完整判定优先', () => {
  it('钉底 composer 的空白分隔行不挡就绪判定(plain:compact 直接放行)', async () => {
    const runner = useRunner({ agents: { 'qa-1': { screen: CODEX_IDLE_STYLED_BLANKS } } });
    await harness.seedAgent({ id: 'qa-1', paneId: '%1' });

    await expect(harness.manager.compactAgent('qa-1')).resolves.toBeUndefined();

    expect(runner.sentKeys.some(k => k.includes('send-keys -l') && k.includes('/compact'))).toBe(true);
    expect(runner.sessions.pane('qa-1')!.phase).toBe('working');
  });

  it('钉底 composer 的空白分隔行不挡就绪判定(stableIdle:review 派发放行)', async () => {
    const runner = useRunner({ agents: { 'qa-1': { screen: CODEX_IDLE_STYLED_BLANKS } } });
    const task = await seedReview();

    await expect(reviewDispatch(task)).resolves.toBe(true);

    expect(runner.pastedPrompts).toEqual([{ pane: '%1', body: expect.stringContaining('token: tok123456789') }]);
  });

  it('screen-only ready 不得绕过 working 的 OSC 标题', async () => {
    const runner = useRunner({ agents: { 'qa-1': { title: '⠹ 分析' } } }, BUSY_WINDOW);
    const task = await seedReview();

    await expect(reviewDispatch(task)).rejects.toBeInstanceOf(ReplNotReadyError);

    expect(runner.pastedPrompts).toEqual([]);
  });
});

describe('waitForReplPromptReady plain 去抖', () => {
  // release 的就绪等待不带 stableIdle:走 waitReplReady 之后的忙碌轮询分支
  it('忙碌到超时抛 ReplNotReadyError:deferWhenBusy 的释放不落 hold,绑定与锁原样保留', async () => {
    const runner = useRunner({ onExec: paneAtProbe({ 1: 'busy' }) }, BUSY_WINDOW);
    const task = await harness.seedTask({ id: 'task-release-busy', status: 'review' });
    await harness.seedAgent({ id: 'qa-1', taskId: task.id, paneId: '%1' });
    await harness.acquireAgentLock('qa-1', task.id);

    await expect(harness.manager.releaseAgentForTask('qa-1', task.id, 'idle', { deferWhenBusy: true }))
      .rejects.toBeInstanceOf(ReplNotReadyError);

    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.taskId).toBe(task.id);
    expect(qa?.status).toBeUndefined();
    expect(await harness.lockManager.isLocked('qa-1')).toBe(true);
    expect(runner.sessions.pane('qa-1')!.phase).toBe('working');
  });
});

describe('waitForReplPromptReady stableIdle 去抖', () => {
  it('忙碌序列夹单帧假 idle:不判 ready,超时抛 ReplNotReadyError', async () => {
    let probes = 0;
    const runner = useRunner({
      ackHoldCaptures: 2,
      onExec: cmd => { if (isReadyProbe(cmd) && probes++ % 2 === 0) harness.runner.sessions.markWorking('qa-1'); },
    }, BUSY_WINDOW);
    const task = await seedReview();

    await expect(reviewDispatch(task)).rejects.toBeInstanceOf(ReplNotReadyError);

    expect(probes).toBeGreaterThanOrEqual(4);
    expect(runner.pastedPrompts).toEqual([]);
  });

  it('连续稳定 idle 帧达到阈值才返回;忙碌帧清零计数', async () => {
    const runner = useRunner({ onExec: paneAtProbe({ 2: 'busy', 3: 'idle' }) });
    const task = await seedReview();

    await expect(reviewDispatch(task)).resolves.toBe(true);

    expect(idleSamplesBeforeClear()).toBe(5);
    expect(runner.pastedPrompts).toHaveLength(1);
  });

  it('从头稳定 idle:恰好采样阈值帧数后返回', async () => {
    const runner = useRunner();
    const task = await seedReview();

    await expect(reviewDispatch(task)).resolves.toBe(true);

    expect(idleSamplesBeforeClear()).toBe(3);
    expect(runner.pastedPrompts).toHaveLength(1);
  });

  it('两帧 idle 后转忙:不足阈值不放行,超时抛 ReplNotReadyError', async () => {
    const runner = useRunner({ onExec: paneAtProbe({ 3: 'busy' }) }, BUSY_WINDOW);
    const task = await seedReview();

    await expect(reviewDispatch(task)).rejects.toBeInstanceOf(ReplNotReadyError);

    expect(runner.pastedPrompts).toEqual([]);
  });

  it('REPL 进程退出立即失败(非 ReplNotReadyError)', async () => {
    const runner = useRunner({ onExec: paneAtProbe({ 2: 'exited' }) });
    const task = await seedReview();

    const err: unknown = await reviewDispatch(task).catch(e => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ReplNotReadyError);
    expect(String(err)).toMatch(/not runtime/);
    expect(runner.pastedPrompts).toEqual([]);
  });

  it('手动 compact 在清稿前后都确认连续三帧 idle 才提交', async () => {
    const runner = useRunner();
    await harness.seedAgent({ id: 'qa-1', paneId: '%1' });

    await expect(harness.manager.compactAgent('qa-1')).resolves.toBeUndefined();

    expect(before('/compact').filter(isReadyProbe)).toHaveLength(6);
    expect(runner.sessions.pane('qa-1')!.phase).toBe('working');
  });
});
