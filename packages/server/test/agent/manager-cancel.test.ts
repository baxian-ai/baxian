import { afterEach, describe, it, expect, vi } from 'vitest';
import type { TaskState } from '../../src/shared/index.js';
import type { AgentManagerDeps } from '../../src/agent/manager.js';
import { TmuxManager } from '../../src/agent/tmux.js';
import { AGENT_STORE_NOOP } from '../../src/state/agent-store.js';
import { createManagerSuiteRunner, paneRefOf, useManagerSuiteHarness, workdirsOf } from '../helpers/manager-harness.js';
import { fakeRunner, type FakeRunner, type FakeRunnerOptions, type FakeRunnerRule } from '../helpers/fake-runner.js';
import { makeTask } from '../helpers/fixtures.js';

const NOW = '2026-05-14T05:00:00.000Z';
const PANE = { 'dev-1': '%0', 'qa-1': '%1' } as const;
type AgentId = keyof typeof PANE;
const RUNTIME = { 'dev-1': 'claude-code', 'qa-1': 'codex' } as const;

const harness = useManagerSuiteHarness();
// 假时钟用例一旦超时,finally 不会执行;这里兜底还原,避免拖垮后续用例
afterEach(() => { vi.useRealTimers(); });

const holdEvents = () => harness.events.filter(
  e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'cancel-interrupt-failed',
);

// if-shell 内层的 'Escape' 被 shell 转义成 '\''Escape'\'';只取非字面按键
const keyOf = (cmd: string): string | undefined => /send-keys -t %\d+ (?:-- )?'(?:\\'')?([^'\\]+)/.exec(cmd)?.[1];
const isKey = (cmd: string, paneId: string, key: string): boolean =>
  cmd.includes(`send-keys -t ${paneId} `) && keyOf(cmd) === key;
const interruptKeys = (runner: FakeRunner, paneId: string): string[] => runner.sentKeys
  .filter(cmd => cmd.includes(`send-keys -t ${paneId} `))
  .map(keyOf)
  .filter((key): key is 'Escape' | 'C-c' => key === 'Escape' || key === 'C-c');
// liveness 采样不带 -e(ansi:false);waitReplReady 与诊断抓屏都带 -e
const isLivenessCapture = (cmd: string): boolean => cmd.includes('capture-pane') && !cmd.includes(' -e ');
// 释放阶段的就绪探针与 liveness 采样同形;只有 C-c 之前的那些才可能是 liveness 采样
const livenessCapturesBeforeClear = (runner: FakeRunner, paneId: string): string[] => {
  const trace = runner.exec.mock.calls.map(c => String(c[0]));
  const at = trace.findIndex(cmd => isKey(cmd, paneId, 'C-c'));
  return trace.slice(0, at === -1 ? trace.length : at).filter(isLivenessCapture);
};

// live runtime:working 只能由 Escape 结束(ackHoldCaptures: Infinity),清稿确认窗口压到毫秒级
function liveManager(runnerOptions: FakeRunnerOptions = {}, deps: Partial<AgentManagerDeps> = {}): FakeRunner {
  const workdirs = workdirsOf(harness.config);
  const runner = createManagerSuiteRunner({ workdirs, ackHoldCaptures: Infinity, ...runnerOptions });
  harness.manager = harness.createManager({ runnerFactory: () => runner, cleanComposerWaitMs: 300, ...deps });
  return runner;
}

async function bindTask(agentId: AgentId, overrides: Partial<TaskState> = {}): Promise<string> {
  const t = await harness.seedTask(overrides);
  await harness.seedAgent({ id: agentId, taskId: t.id, paneId: PANE[agentId] });
  return t.id;
}

type CancelOutcome = 'released' | 'held';
async function outcomeFor(agentId: AgentId, taskId: string): Promise<CancelOutcome> {
  expect((await harness.taskStore.get(taskId))?.status).toBe('cancelled');
  const state = await harness.agentStore.get(agentId);
  if (state?.awaitingPhase === 'cancel-interrupt-failed') {
    expect(state.taskId).toBe(taskId);
    expect(await harness.lockManager.isLocked(agentId)).toBe(true);
    return 'held';
  }
  expect(state?.taskId).toBeUndefined();
  expect(await harness.lockManager.isLocked(agentId)).toBe(false);
  return 'released';
}

// ESC 后生产硬等 10 s 的 ready 窗口才做 liveness 判定:假时钟推进等待,setImmediate 保持真实让 store I/O 落定
function fakeClock() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  const step = async (totalMs: number, until: () => boolean = () => false): Promise<void> => {
    for (let elapsed = 0; elapsed < totalMs && !until(); elapsed += 100) {
      await vi.advanceTimersByTimeAsync(100);
      await new Promise(resolve => setImmediate(resolve));
    }
  };
  // 真实 I/O 的完成期限不能用累计虚拟时间衡量。
  const settle = async <T>(pending: Promise<T>): Promise<T> => {
    let done = false;
    pending.then(() => { done = true; }, () => { done = true; });
    const realDeadline = performance.now() + 60_000;
    while (!done && performance.now() < realDeadline) {
      for (let turn = 0; turn < 20 && !done; turn++) {
        await new Promise(resolve => setImmediate(resolve));
      }
      if (done) break;
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(done).toBe(true);
    return pending;
  };
  return { step, settle };
}
async function onFakeClock<T>(run: (clock: ReturnType<typeof fakeClock>) => Promise<T>): Promise<T> {
  const clock = fakeClock();
  try {
    return await run(clock);
  } finally {
    vi.useRealTimers();
  }
}
const cancelOnFakeClock = (taskId: string): Promise<TaskState> =>
  onFakeClock(clock => clock.settle(harness.manager.cancelTask(taskId)));

// 在指定命令处把 fake runner 卡住直到 release():让一个公共操作持有 pane mutex
function execGate(match: (cmd: string) => boolean) {
  let release!: () => void;
  let arrive!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { arrive = resolve; });
  let armed = true;
  const onExec = async (cmd: string): Promise<void> => {
    if (!armed || !match(cmd)) return;
    armed = false;
    arrive();
    await released;
  };
  return { onExec, reached, release };
}

// 往 idle composer 里放一段未提交的草稿:单行按人手敲入,多行只能经 tmux buffer 粘贴(send-keys -l 不接受换行)
const typeDraft = async (runner: FakeRunner, agentId: AgentId, text: string): Promise<void> => {
  const tmux = new TmuxManager(runner);
  const pane = paneRefOf(PANE[agentId], agentId);
  if (!text.includes('\n')) {
    await tmux.sendKeysLiteral(pane, text, RUNTIME[agentId]);
    return;
  }
  const { buf } = await tmux.stagePromptBuffer(pane.paneId, text, agentId);
  await tmux.pasteStagedBuffer(pane, buf, RUNTIME[agentId]);
  runner.pastedPrompts.length = 0;
};

const paneTitleRule = (title: () => string): FakeRunnerRule =>
  ({ match: 'pane_title', reply: () => ({ stdout: `BX_PANE_OK${title()}\n` }) });

const markCancelClearing = (agentId: AgentId) => harness.agentStore.update(
  agentId,
  s => (s ? { ...s, status: 'awaiting_human', awaitingPhase: 'cancel-clearing' } : AGENT_STORE_NOOP),
);

describe('AgentManager runtime menu marker', () => {
  it('emits one pending intervention and one matching resolution when the menu closes', async () => {
    let captures = 0;
    const runner = fakeRunner({
      rules: [{
        match: 'capture-pane',
        reply: () => {
          captures += 1;
          const frame = captures <= 2
            ? 'Enter to confirm · Esc to cancel'
            : '⏵⏵ bypass permissions on /tmp/repo\n\n>';
          return { stdout: `BX_PANE_OK\n${frame}` };
        },
      }],
    });
    harness.manager = harness.createManager({ runnerFactory: () => runner, runtimeMenuPollIntervalMs: 5 });
    await harness.seedTask();
    await harness.seedAgent({
      id: 'dev-1',
      taskId: 'task-1',
      paneId: '%0',
    });

    harness.manager.startRuntimeMenuWatch('dev-1');
    try {
      await vi.waitFor(() => {
        expect(harness.events.some(event =>
          event.type === 'human.intervention' &&
          event.data.phase === 'agent_runtime_menu_resolved'
        )).toBe(true);
      }, { interval: 5 });
    } finally {
      harness.manager.stopRuntimeMenuWatch('dev-1');
    }

    const interventions = harness.events.filter(e => e.type === 'human.intervention');
    expect(interventions.map(event => event.data.phase)).toEqual([
      'agent_runtime_menu_pending',
      'agent_runtime_menu_resolved',
    ]);
    expect(interventions[1].data.previousPhase).toBe('agent_runtime_menu_pending');
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBe('task-1');
  });

  it('emits the pending/resolved pair for a model picker (skipStateUpdate rules bypass the poller, only this watcher notifies)', async () => {
    let captures = 0;
    const runner = fakeRunner({
      rules: [{
        match: 'capture-pane',
        reply: () => {
          captures += 1;
          const frame = captures <= 2
            ? 'Select model\n❯ 1. Fable\n  2. Opus\nEnter to set as default · Esc to cancel'
            : '⏵⏵ bypass permissions on /tmp/repo\n\n>';
          return { stdout: `BX_PANE_OK\n${frame}` };
        },
      }],
    });
    harness.manager = harness.createManager({ runnerFactory: () => runner, runtimeMenuPollIntervalMs: 5 });
    await harness.seedTask();
    await harness.seedAgent({
      id: 'dev-1',
      taskId: 'task-1',
      paneId: '%0',
    });

    harness.manager.startRuntimeMenuWatch('dev-1');
    try {
      await vi.waitFor(() => {
        expect(harness.events.some(event =>
          event.type === 'human.intervention' &&
          event.data.phase === 'agent_runtime_menu_resolved'
        )).toBe(true);
      }, { interval: 5 });
    } finally {
      harness.manager.stopRuntimeMenuWatch('dev-1');
    }

    const interventions = harness.events.filter(e => e.type === 'human.intervention');
    expect(interventions.map(event => event.data.phase)).toEqual([
      'agent_runtime_menu_pending',
      'agent_runtime_menu_resolved',
    ]);
  });
});

describe('cancelTask interrupts (ESC) then releases dev and qa panes without clearing', () => {
  it('sends ESC to both working panes, never /clear, clears the interrupted prompts and both bindings', async () => {
    const runner = liveManager();
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await harness.manager.injectTextToAgent('dev-1', 'dev prompt', { expectedTaskId: t.id });
    await harness.manager.injectTextToAgent('qa-1', 'qa prompt', { expectedTaskId: t.id });
    expect(runner.sessions.pane('dev-1')!.phase).toBe('working');
    expect(runner.sessions.pane('qa-1')!.phase).toBe('working');

    const cancelled = await cancelOnFakeClock(t.id);

    expect(cancelled.status).toBe('cancelled');
    expect(interruptKeys(runner, '%0')).toEqual(['Escape', 'C-c']);
    expect(interruptKeys(runner, '%1')).toEqual(['Escape', 'C-c']);
    expect(runner.sentKeys.some(k => k.includes('/clear'))).toBe(false);
    for (const id of ['dev-1', 'qa-1'] as const) {
      expect(runner.sessions.pane(id)).toMatchObject({ phase: 'idle', composer: '' });
      expect((await harness.agentStore.get(id))?.taskId).toBeUndefined();
      expect(await harness.lockManager.isLocked(id)).toBe(false);
    }
  });

  it('skips interrupt and release when the agent has been rebound to a new task (race protection)', async () => {
    const runner = liveManager();
    const oldTask = await harness.seedTask({ id: 'task-old' });
    const newTask = await harness.seedTask({ id: 'task-new' });
    await harness.seedAgent({ id: 'dev-1', taskId: oldTask.id, paneId: '%0' });

    // 绑定在 cancel 标记之后、逐 agent 检查之前被换掉:两次读之间没有外部命令,只能在 store 读上交错
    const realAgentGet = harness.agentStore.get.bind(harness.agentStore);
    let devGets = 0;
    let switched = false;
    vi.spyOn(harness.agentStore, 'get').mockImplementation(async (id: string) => {
      if (id === 'dev-1' && !switched && ++devGets >= 2) {
        switched = true;
        const cur = await realAgentGet(id);
        if (cur) {
          await harness.agentStore.set({ ...cur, taskId: newTask.id, updatedAt: new Date().toISOString() });
        }
      }
      return realAgentGet(id);
    });

    const cancelled = await harness.manager.cancelTask(oldTask.id);

    expect(cancelled.status).toBe('cancelled');
    expect(runner.sentKeys).toEqual([]);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBe(newTask.id);
  });

  it('preserves the binding and emits one intervention when ESC does not stop the turn (no /clear, no C-c)', async () => {
    const runner = liveManager({ agents: { 'dev-1': { interrupt: 'ignored-live' } } });
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    runner.sessions.markWorking('dev-1');

    const cancelled = await cancelOnFakeClock(t.id);

    expect(cancelled.status).toBe('cancelled');
    expect(interruptKeys(runner, '%0')).toEqual(['Escape']);
    expect(runner.sentKeys.some(k => k.includes('/clear'))).toBe(false);
    expect(runner.sessions.pane('dev-1')!.phase).toBe('working');
    const stateAfter = await harness.agentStore.get('dev-1');
    expect(stateAfter).toMatchObject({ taskId: t.id, status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed' });
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
    expect(holdEvents()).toEqual([expect.objectContaining({ projectId: 'proj', agentId: 'dev-1', taskId: t.id })]);
  });

  it('keeps the mutex-busy hold reason and emits a single intervention when an in-flight upload keeps the pane mutex past the wait window', async () => {
    const gate = execGate(cmd => cmd.includes('paste-buffer'));
    const runner = liveManager({ onExec: gate.onExec }, { cancelInterruptGuardWaitMs: 30, compactIdlePollMs: 5 });
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    const upload = harness.manager.injectTextToAgent('dev-1', 'in flight', { expectedTaskId: t.id });
    await gate.reached;

    const cancelled = await harness.manager.cancelTask(t.id);

    expect(cancelled.status).toBe('cancelled');
    const dev = await harness.agentStore.get('dev-1');
    expect(dev).toMatchObject({ taskId: t.id, awaitingPhase: 'cancel-interrupt-failed' });
    expect(dev?.awaitingReason).toContain('pane mutex');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
    expect(runner.sentKeys).toEqual([]);
    expect(holdEvents()).toHaveLength(1);
    gate.release();
    await upload.catch(() => undefined);
  });

  it('keeps waiting for a busy pane mutex across a custom dispatch ack window instead of giving up at the default wait', async () => {
    const gate = execGate(cmd => cmd.includes('paste-buffer'));
    const runner = liveManager({ onExec: gate.onExec }, { dispatchAckTimeoutMs: 60_000, compactIdlePollMs: 50 });
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    const upload = harness.manager.injectTextToAgent('dev-1', 'in flight', { expectedTaskId: t.id });
    await gate.reached;

    await onFakeClock(async clock => {
      const cancel = harness.manager.cancelTask(t.id);
      await vi.waitFor(async () => {
        expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBe('cancel-clearing');
      });
      await clock.step(40_000);
      expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBe('cancel-clearing');
      expect(interruptKeys(runner, '%0')).toEqual([]);

      gate.release();
      await clock.settle(upload);
      expect((await clock.settle(cancel)).status).toBe('cancelled');
    });

    expect(interruptKeys(runner, '%0')).toEqual(['Escape', 'C-c']);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(runner.sessions.pane('dev-1')).toMatchObject({ phase: 'idle', composer: '' });
  });

  it('releases neither agent until both panes are interrupted, so a slow qa interrupt cannot expose a freed dev', async () => {
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    let devStillHeldDuringQaInterrupt: boolean | undefined;
    liveManager({
      onExec: async cmd => {
        if (!isKey(cmd, '%1', 'Escape')) return;
        devStillHeldDuringQaInterrupt =
          (await harness.agentStore.get('dev-1'))?.taskId === t.id && (await harness.lockManager.isLocked('dev-1'));
      },
    });

    await cancelOnFakeClock(t.id);

    expect(devStillHeldDuringQaInterrupt).toBe(true);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await harness.agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
    expect(await harness.lockManager.isLocked('qa-1')).toBe(false);
  });

  it('refuses Resume while cancel cleanup is in flight, and the worker still completes both releases', async () => {
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    let resumeDuringCancel: { resumed: boolean; reason?: string } | undefined;
    liveManager({
      onExec: async cmd => {
        if (isKey(cmd, '%1', 'Escape')) resumeDuringCancel = await harness.manager.resumeAgent('dev-1');
      },
    });

    await cancelOnFakeClock(t.id);

    expect(resumeDuringCancel?.resumed).toBe(false);
    expect(resumeDuringCancel?.reason).toContain('in progress');
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await harness.agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
    expect(await harness.lockManager.isLocked('qa-1')).toBe(false);
  });

  it('a duplicate cancel of an already-cancelling task does not clear the in-flight guard early', async () => {
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    let resumeAfterDuplicateCancel: { resumed: boolean; reason?: string } | undefined;
    liveManager({
      onExec: async cmd => {
        if (!isKey(cmd, '%1', 'Escape')) return;
        await harness.manager.cancelTask(t.id);
        resumeAfterDuplicateCancel = await harness.manager.resumeAgent('dev-1');
      },
    });

    await cancelOnFakeClock(t.id);

    expect(resumeAfterDuplicateCancel?.resumed).toBe(false);
    expect(resumeAfterDuplicateCancel?.reason).toContain('in progress');
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await harness.agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
    expect(await harness.lockManager.isLocked('qa-1')).toBe(false);
  });

  it('a dev whose interrupt fails does not strand qa — qa is still interrupted and released', async () => {
    const runner = liveManager({ agents: { 'dev-1': { interrupt: 'ignored-live' } } });
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    runner.sessions.markWorking('dev-1');

    await cancelOnFakeClock(t.id);

    const dev = await harness.agentStore.get('dev-1');
    expect(dev).toMatchObject({ status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed', taskId: t.id });
    expect(interruptKeys(runner, '%0')).toEqual(['Escape']);
    expect(interruptKeys(runner, '%1')).toEqual(['Escape', 'C-c']);
    expect((await harness.agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('qa-1')).toBe(false);
  });

  it('does not stale-mark a rebound agent when it is reassigned mid-cleanup (release+reassign race)', async () => {
    const t = await harness.seedTask();
    await harness.taskStore.set(makeTask({ id: 'task-new' }));
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    liveManager({
      onExec: async cmd => {
        if (!isKey(cmd, '%0', 'Escape')) return;
        await harness.agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'task-new', paneId: '%0', updatedAt: new Date().toISOString() });
      },
    });

    await cancelOnFakeClock(t.id);

    const dev = await harness.agentStore.get('dev-1');
    expect(dev?.taskId).toBe('task-new');
    expect(dev?.status).not.toBe('awaiting_human');
    expect(dev?.awaitingPhase).toBeUndefined();
  });

  it('refuses release of a cancel-clearing pane unless it is cancel\'s own (fromCancelCleanup)', async () => {
    const t = await harness.seedTask({ status: 'cancelled' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });

    expect(await harness.manager.releaseAgentForTask('dev-1', t.id, 'idle')).toBe(false);
    expect(await harness.manager.releaseAgentForTask('dev-1', t.id, 'idle', { allowAwaitingHuman: true })).toBe(false);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);

    expect(await harness.manager.releaseAgentForTask('dev-1', t.id, 'idle', { allowAwaitingHuman: true, fromCancelCleanup: true })).toBe(true);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('blocks a concurrent terminal-task escape release while cancel is mid-cleanup', async () => {
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    let escapeReleaseResult: boolean | undefined;
    liveManager({
      onExec: async cmd => {
        if (escapeReleaseResult !== undefined || keyOf(cmd) !== 'Escape') return;
        escapeReleaseResult = await harness.manager.releaseAgentForTask('qa-1', t.id, 'idle');
      },
    });

    const cancelled = await cancelOnFakeClock(t.id);

    expect(cancelled.status).toBe('cancelled');
    expect(escapeReleaseResult).toBe(false);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await harness.agentStore.get('qa-1'))?.taskId).toBeUndefined();
  });

  it('cancel of one task does not block a rebound agent release by its new task', async () => {
    await harness.taskStore.set(makeTask({ id: 'task-old', agentId: 'dev-1', qaAgentId: 'qa-1' }));
    await harness.taskStore.set(makeTask({ id: 'task-new', agentId: 'dev-1' }));
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-new', paneId: '%0' });
    await harness.seedAgent({ id: 'qa-1', taskId: 'task-old', paneId: '%1' });
    let devReleaseByNewTask: boolean | undefined;
    liveManager({
      onExec: async cmd => {
        if (devReleaseByNewTask !== undefined || keyOf(cmd) !== 'Escape') return;
        devReleaseByNewTask = await harness.manager.releaseAgentForTask('dev-1', 'task-new', 'idle');
      },
    });

    await cancelOnFakeClock('task-old');

    expect(devReleaseByNewTask).toBe(true);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await harness.agentStore.get('qa-1'))?.taskId).toBeUndefined();
  });

  it('a stale cancel does not disturb the cancel-clearing hold of the agent\'s real owner', async () => {
    await harness.taskStore.set(makeTask({ id: 'task-a', agentId: 'dev-1' }));
    await harness.taskStore.set(makeTask({ id: 'task-b', agentId: 'dev-1' }));
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-a', paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });

    await harness.manager.cancelTask('task-b');

    const dev = await harness.agentStore.get('dev-1');
    expect(dev?.taskId).toBe('task-a');
    expect(dev?.awaitingPhase).toBe('cancel-clearing');
    expect(await harness.manager.releaseAgentForTask('dev-1', 'task-a', 'idle')).toBe(false);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBe('task-a');
  });

  it('Resume releases a stale cancel-clearing hold whose task already reached a terminal status', async () => {
    const t = await harness.seedTask({ status: 'cancelled' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });

    const res = await harness.manager.resumeAgent('dev-1');
    expect(res.resumed).toBe(true);
    expect(res.releasedBinding).toBe(true);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
  });

  it('recover() holds a cancel-clearing agent bound to a cancelled task (restart mid-cleanup)', async () => {
    await harness.taskStore.set(makeTask({ id: 'task-x', status: 'cancelled', agentId: 'dev-1' }));
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-x', paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });

    await harness.manager.recover();

    const dev = await harness.agentStore.get('dev-1');
    expect(dev?.taskId).toBe('task-x');
    expect(dev?.status).toBe('awaiting_human');
    expect(dev?.awaitingPhase).toBe('cancel-clearing');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });

  it('does not auto-release a cancel-interrupt-failed pane (escape/handler), but Resume can', async () => {
    const t = await harness.seedTask({ status: 'cancelled' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed' });

    expect(await harness.manager.releaseAgentForTask('dev-1', t.id, 'idle', { allowAwaitingHuman: true })).toBe(false);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);

    const res = await harness.manager.resumeAgent('dev-1');
    expect(res.resumed).toBe(true);
    expect(res.releasedBinding).toBe(true);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('recover() holds a cancel-interrupt-failed agent (restart) instead of auto-releasing it', async () => {
    await harness.taskStore.set(makeTask({ id: 'task-y', status: 'cancelled', agentId: 'dev-1' }));
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-y', paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed' });

    await harness.manager.recover();

    const dev = await harness.agentStore.get('dev-1');
    expect(dev?.taskId).toBe('task-y');
    expect(dev?.awaitingPhase).toBe('cancel-interrupt-failed');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });
});

describe('cancelTask: ESC, liveness probe and composer clearing', () => {
  const STUCK_COMPOSER = 'Title: 优化 Agent Pet 样式\n  1. Agent Pet 再放大一点点\n  2. ...';
  const BUSY_LOOKING_COMPOSER = '排查 codex 卡死，日志：\n  • Working (12s)\n  esc to interrupt';
  const LONG_COMPOSER = 'pasted diagnostics line\n'.repeat(14);
  const NODE_HUMAN_SESSION = 'running diagnostics…\n> \n';
  const RUNTIME_MENU = 'Select a model\n  Enter to confirm · Esc to cancel\n';
  const BLOCKER_OVER_PROMPT = 'Allow command `rm -rf`?\n  Press Enter to confirm or Esc to cancel\n› \n';
  const QUIET_OUTPUT = 'quiet build output\n  no spinner here\n';
  const SPINNER = [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'];

  async function cancelBound(agentId: AgentId, taskId: string): Promise<CancelOutcome> {
    await cancelOnFakeClock(taskId);
    return outcomeFor(agentId, taskId);
  }

  it.each([
    ['an empty composer', ''],
    ['an un-submitted draft', STUCK_COMPOSER],
    ['a draft whose text looks like a running turn ("Working" / "esc to interrupt")', BUSY_LOOKING_COMPOSER],
    ['a long multi-line draft', LONG_COMPOSER],
  ])('codex: ESC then C-c clears %s and confirms the clean composer before releasing (qa-1)', async (_name, draft) => {
    const runner = liveManager();
    const taskId = await bindTask('qa-1');
    if (draft) await typeDraft(runner, 'qa-1', draft);

    expect(await cancelBound('qa-1', taskId)).toBe('released');
    expect(interruptKeys(runner, '%1')).toEqual(['Escape', 'C-c']);
    expect(runner.sessions.pane('qa-1')).toMatchObject({ process: 'codex', phase: 'idle', composer: '' });
    // ESC 后已 ready 的 pane 直接清稿:C-c 之前不做任何 liveness 采样
    expect(livenessCapturesBeforeClear(runner, '%1')).toEqual([]);
  });

  it('claude-code: C-c clears a dirty composer and confirms the empty prompt (dev-1)', async () => {
    const runner = liveManager();
    const taskId = await bindTask('dev-1');
    await typeDraft(runner, 'dev-1', '修复 web terminal 乱码');

    expect(await cancelBound('dev-1', taskId)).toBe('released');
    expect(interruptKeys(runner, '%0')).toEqual(['Escape', 'C-c']);
    expect(runner.sessions.pane('dev-1')).toMatchObject({ process: 'claude', phase: 'idle', composer: '' });
  });

  it('claude-code: ESC restores the interrupted prompt into an idle-looking composer, and cancel still clears it (dev-1)', async () => {
    let composerBeforeClear: string | undefined;
    const runner = liveManager({
      onExec: cmd => {
        if (composerBeforeClear === undefined && cmd.includes('send-keys -l -t %0')) {
          composerBeforeClear = runner.sessions.pane('dev-1')!.composer;
        }
      },
    });
    const taskId = await bindTask('dev-1');
    await harness.manager.injectTextToAgent('dev-1', 'hold. Skip it and the task stalls.', { expectedTaskId: taskId });
    expect(runner.sessions.pane('dev-1')!.phase).toBe('working');

    expect(await cancelBound('dev-1', taskId)).toBe('released');
    expect(composerBeforeClear).toBe('hold. Skip it and the task stalls.');
    expect(interruptKeys(runner, '%0')).toEqual(['Escape', 'C-c']);
    expect(runner.sessions.pane('dev-1')).toMatchObject({ phase: 'idle', composer: '' });
  });

  it.each(['qa-1', 'dev-1'] as const)('%s: holds (no C-c) when the turn is still running after ESC (frames keep changing)', async (agentId) => {
    const runner = liveManager({ agents: { [agentId]: { interrupt: 'ignored-live' } } });
    const taskId = await bindTask(agentId);
    runner.sessions.markWorking(agentId);

    expect(await cancelBound(agentId, taskId)).toBe('held');
    expect(interruptKeys(runner, PANE[agentId])).toEqual(['Escape']);
    expect(runner.sessions.pane(agentId)!.phase).toBe('working');
    expect(holdEvents()).toHaveLength(1);
  });

  it('a turn that settles to a stable ready frame during the probe is NOT live: C-c proceeds (working→idle between grabs)', async () => {
    let livenessCaptures = 0;
    const runner = liveManager({
      agents: { 'qa-1': { interrupt: 'ignored-static' } },
      onExec: cmd => {
        if (isLivenessCapture(cmd) && ++livenessCaptures === 2) runner.sessions.setProcess('qa-1', 'codex');
      },
    });
    const taskId = await bindTask('qa-1');
    runner.sessions.markWorking('qa-1');

    expect(await cancelBound('qa-1', taskId)).toBe('released');
    expect(interruptKeys(runner, '%1')).toEqual(['Escape', 'C-c']);
    expect(runner.sessions.pane('qa-1')).toMatchObject({ phase: 'idle', composer: '' });
  });

  it('the final settling confirmation re-reads the OSC title: a new turn announced only by the title is live (holds, no C-c)', async () => {
    let title = 'codex';
    let livenessCaptures = 0;
    const runner = liveManager({
      agents: { 'qa-1': { interrupt: 'ignored-static' } },
      rules: [paneTitleRule(() => title)],
      onExec: cmd => {
        if (!isLivenessCapture(cmd)) return;
        livenessCaptures += 1;
        // 第三拍屏幕回到 ready;确认拍屏幕不变,只有标题宣告了新 turn
        if (livenessCaptures === 3) runner.sessions.setProcess('qa-1', 'codex');
        if (livenessCaptures === 4) title = '⠙ codex';
      },
    });
    const taskId = await bindTask('qa-1');
    runner.sessions.markWorking('qa-1');

    expect(await cancelBound('qa-1', taskId)).toBe('held');
    expect(interruptKeys(runner, '%1')).toEqual(['Escape']);
  });

  it('holds (no C-c) when the pane is no longer running the runtime (crashed to shell)', async () => {
    const runner = liveManager();
    const taskId = await bindTask('qa-1');
    runner.sessions.setProcess('qa-1', 'zsh');

    expect(await cancelBound('qa-1', taskId)).toBe('held');
    expect(interruptKeys(runner, '%1')).toEqual(['Escape']);
  });

  it('re-checks the foreground right before C-c: holds (no C-c) if the runtime crashed to a shell during the liveness window', async () => {
    let livenessCaptures = 0;
    let crashed = false;
    const runner = liveManager({
      agents: { 'qa-1': { interrupt: 'ignored-static' } },
      onExec: cmd => {
        if (isLivenessCapture(cmd)) livenessCaptures += 1;
        else if (!crashed && livenessCaptures >= 3 && cmd.includes('pane_current_command')) {
          crashed = true;
          runner.sessions.setProcess('qa-1', 'zsh');
        }
      },
    });
    const taskId = await bindTask('qa-1');
    runner.sessions.markWorking('qa-1');

    expect(await cancelBound('qa-1', taskId)).toBe('held');
    expect(livenessCaptures).toBeGreaterThanOrEqual(3);
    expect(interruptKeys(runner, '%1')).toEqual(['Escape']);
    expect(runner.sessions.pane('qa-1')!.process).toBe('zsh');
  });

  it('holds (no C-c) when the screen is static but the OSC braille title ADVANCES across samples (live turn)', async () => {
    let reads = 0;
    const runner = liveManager({
      agents: { 'qa-1': { interrupt: 'ignored-static' } },
      rules: [paneTitleRule(() => `${SPINNER[reads++ % SPINNER.length]} codex`)],
    });
    const taskId = await bindTask('qa-1');
    runner.sessions.markWorking('qa-1', QUIET_OUTPUT);

    expect(await cancelBound('qa-1', taskId)).toBe('held');
    expect(interruptKeys(runner, '%1')).toEqual(['Escape']);
  });

  it('does NOT treat a STALE static working-shaped OSC title as live — C-c proceeds and the refreshed title confirms ready', async () => {
    let title = '⠹ codex';
    const runner = liveManager({
      rules: [paneTitleRule(() => title)],
      // C-c 让 runtime 重绘,陈旧的标题才刷新回 idle
      onExec: cmd => { if (isKey(cmd, '%1', 'C-c')) title = 'codex'; },
    });
    const taskId = await bindTask('qa-1');
    await typeDraft(runner, 'qa-1', STUCK_COMPOSER);

    expect(await cancelBound('qa-1', taskId)).toBe('released');
    expect(interruptKeys(runner, '%1')).toEqual(['Escape', 'C-c']);
    expect(runner.sessions.pane('qa-1')!.composer).toBe('');
  });

  it('an ADVANCING OSC title is live even when the screen shows a ready-looking prompt', async () => {
    let reads = 0;
    const runner = liveManager({ rules: [paneTitleRule(() => `${SPINNER[reads++ % SPINNER.length]} codex`)] });
    const taskId = await bindTask('qa-1');

    expect(await cancelBound('qa-1', taskId)).toBe('held');
    expect(interruptKeys(runner, '%1')).toEqual(['Escape']);
  });

  it.each([
    ['a human `node` session that never shows a codex composer (`>` ≠ `›`)', { process: 'node', screen: NODE_HUMAN_SESSION }],
    ['a runtime menu that does not dismiss', { screen: RUNTIME_MENU }],
    ['a bare `›` under a permission/confirm blocker', { screen: BLOCKER_OVER_PROMPT }],
  ])('holds AFTER one C-c when the pane never returns to a clean composer: %s', async (_name, agent) => {
    const runner = liveManager({ agents: { 'qa-1': agent } });
    const taskId = await bindTask('qa-1');

    expect(await cancelBound('qa-1', taskId)).toBe('held');
    expect(interruptKeys(runner, '%1')).toEqual(['Escape', 'C-c']);
  });

  it('holds (no C-c) on a live turn with NO busy marker — sampled for change, not gated on busy markers', async () => {
    let lines = 0;
    const runner = liveManager({
      rules: [{ match: 'capture-pane', reply: () => ({ stdout: `BX_PANE_OK\nbuilding project…\n  compiled module ${++lines}\n` }) }],
    });
    const taskId = await bindTask('qa-1');

    expect(await cancelBound('qa-1', taskId)).toBe('held');
    expect(interruptKeys(runner, '%1')).toEqual(['Escape']);
  });

  it('waits for a busy pane mutex and proceeds once the in-flight upload releases it (no instant hold)', async () => {
    const gate = execGate(cmd => cmd.includes('paste-buffer'));
    const runner = liveManager({ onExec: gate.onExec }, { cancelInterruptGuardWaitMs: 2_000, compactIdlePollMs: 5 });
    const taskId = await bindTask('qa-1');
    const upload = harness.manager.injectTextToAgent('qa-1', 'in flight', { expectedTaskId: taskId });
    await gate.reached;

    await onFakeClock(async clock => {
      const cancel = harness.manager.cancelTask(taskId);
      await clock.step(200);
      expect(interruptKeys(runner, '%1')).toEqual([]);
      gate.release();
      await clock.settle(upload);
      await clock.settle(cancel);
    });

    expect(await outcomeFor('qa-1', taskId)).toBe('released');
    expect(interruptKeys(runner, '%1')).toEqual(['Escape', 'C-c']);
    expect(runner.sessions.pane('qa-1')).toMatchObject({ phase: 'idle', composer: '' });
  });

  it('holds the pane mutex until the composer clear and ready confirmation finish, so a concurrent Compact is refused (409)', async () => {
    // 卡在清稿的弄脏键上:此时 ESC 已发、ready 已确认,cancel 仍持有 pane mutex
    const gate = execGate(cmd => cmd.includes('send-keys -l -t %1'));
    const runner = liveManager({ onExec: gate.onExec });
    const taskId = await bindTask('qa-1');
    let clearing = false;
    void gate.reached.then(() => { clearing = true; });

    await onFakeClock(async clock => {
      const cancel = harness.manager.cancelTask(taskId);
      await clock.step(60_000, () => clearing);
      expect(clearing).toBe(true);
      await expect(harness.manager.compactAgent('qa-1')).rejects.toMatchObject({ status: 409 });
      gate.release();
      await clock.settle(cancel);
    });

    expect(await outcomeFor('qa-1', taskId)).toBe('released');
    expect(interruptKeys(runner, '%1')).toEqual(['Escape', 'C-c']);
  });

  it('releases the pane mutex once cancel finishes, so a later cancel on the same agent can interrupt again', async () => {
    const runner = liveManager({}, { cancelInterruptGuardWaitMs: 50, compactIdlePollMs: 5 });
    const first = await bindTask('qa-1', { id: 'task-first' });
    expect(await cancelBound('qa-1', first)).toBe('released');

    const second = await bindTask('qa-1', { id: 'task-second' });
    expect(await cancelBound('qa-1', second)).toBe('released');
    expect(interruptKeys(runner, '%1')).toEqual(['Escape', 'C-c', 'Escape', 'C-c']);
  });

  async function seedDispatchableTask(id: string): Promise<string> {
    await harness.seedTask({ id, signalToken: 'devtok123456' });
    await harness.seedAgent({ id: 'dev-1', taskId: id, paneId: '%0' });
    return id;
  }
  // 派单已写下 running 标记,接下来只剩等 pane mutex
  const dispatchReachedPaneMutex = (taskId: string): Promise<void> => vi.waitFor(async () => {
    expect((await harness.agentStore.get('dev-1'))?.bootstrappingTaskId).toBe(taskId);
  }, { interval: 5 });

  it('a dispatch whose bound task went terminal while waiting for the pane mutex is aborted before any paste', async () => {
    const gate = execGate(cmd => cmd.includes('paste-buffer'));
    const runner = liveManager({ onExec: gate.onExec });
    const taskId = await seedDispatchableTask('task-terminal-wait');
    const upload = harness.manager.injectTextToAgent('dev-1', 'in flight', { expectedTaskId: taskId });
    await gate.reached;
    const dispatch = harness.manager.startSession(taskId, 'dev-1', 'develop');
    await dispatchReachedPaneMutex(taskId);
    await harness.taskStore.set({ ...(await harness.taskStore.get(taskId))!, status: 'cancelled' });
    gate.release();

    await expect(dispatch).rejects.toThrow(/went terminal while waiting for pane mutex/);
    await upload;
    expect(runner.pastedPrompts.map(p => p.body)).toEqual(['in flight']);
  });

  it('a dispatch taken over by a cancel hold while waiting for the pane mutex is aborted before any paste', async () => {
    const gate = execGate(cmd => cmd.includes('paste-buffer'));
    const runner = liveManager({ onExec: gate.onExec });
    const taskId = await seedDispatchableTask('task-hold-wait');
    const upload = harness.manager.injectTextToAgent('dev-1', 'in flight', { expectedTaskId: taskId });
    await gate.reached;
    const dispatch = harness.manager.startSession(taskId, 'dev-1', 'develop');
    await dispatchReachedPaneMutex(taskId);
    await markCancelClearing('dev-1');
    gate.release();

    await expect(dispatch).rejects.toThrow(/taken over by cancel \(cancel-clearing\) while waiting for pane mutex/);
    await upload;
    expect(runner.pastedPrompts.map(p => p.body)).toEqual(['in flight']);
    expect((await harness.agentStore.get('dev-1'))).toMatchObject({ taskId, awaitingPhase: 'cancel-clearing' });
  });

  it('a dispatch re-checks the cancel hold after its pre-inject screen read: aborts before paste', async () => {
    let held = false;
    const runner = liveManager({
      onExec: async cmd => {
        if (held || !cmd.includes('capture-pane')) return;
        if ((await harness.agentStore.get('dev-1'))?.bootstrappingTaskId !== 'task-hold-before-paste') return;
        held = true;
        await markCancelClearing('dev-1');
      },
    });
    const taskId = await seedDispatchableTask('task-hold-before-paste');

    await expect(harness.manager.startSession(taskId, 'dev-1', 'develop')).rejects.toThrow(/taken over by cancel before paste/);
    expect(held).toBe(true);
    expect(runner.pastedPrompts).toEqual([]);
  });

  it('injectTextToAgent re-checks after the task read: aborts before paste if cancel lands during taskStore.get', async () => {
    const t = await harness.seedTask({ status: 'in_progress' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    const realGet = harness.taskStore.get.bind(harness.taskStore);
    vi.spyOn(harness.taskStore, 'get').mockImplementation(async (id: string) => {
      await markCancelClearing('qa-1');
      return realGet(id);
    });
    await expect(
      harness.manager.injectTextToAgent('qa-1', 'file body', { expectedTaskId: t.id }),
    ).rejects.toThrow(/taken over by cancel before paste/);
    expect(harness.runner.pastedPrompts).toEqual([]);
  });

  it('injectTextToAgent aborts before paste when a DELETE→recreate bumps the generation during pane resolution', async () => {
    const runner = liveManager({
      onExec: cmd => { if (cmd.includes('list-panes')) harness.manager.bumpDeletionGeneration('qa-1'); },
    });
    const t = await harness.seedTask({ id: 'task-rf-aba', status: 'in_progress' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await expect(
      harness.manager.injectTextToAgent('qa-1', 'file body', { expectedTaskId: t.id }),
    ).rejects.toThrow(/deleted or recreated before paste/);
    expect(runner.pastedPrompts).toEqual([]);
  });

  it('cleanupRemovedAgentRuntime bounds every tmux probe/kill with a deadline (no unbounded hang holding the tombstone)', async () => {
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });

    await harness.manager.cleanupRemovedAgentRuntime(['dev-1']);

    const tmuxCalls = harness.runner.exec.mock.calls.filter(([cmd]) => cmd.startsWith('tmux '));
    expect(tmuxCalls.length).toBeGreaterThanOrEqual(2);
    expect(tmuxCalls.every(([, opts]) => opts?.timeout === 15_000)).toBe(true);
    expect(harness.runner.sessions.present('dev-1')).toBe(false);
  });

  it('injectTextToAgent refuses to inject into a pane held by cancel cleanup', async () => {
    await harness.seedTask({ id: 'task-rf-hold', status: 'in_progress' });
    await harness.seedAgent({ id: 'qa-1', taskId: 'task-rf-hold', paneId: '%1', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await expect(
      harness.manager.injectTextToAgent('qa-1', 'file body', { expectedTaskId: 'task-rf-hold' }),
    ).rejects.toThrow(/taken over by cancel/);
    expect(harness.runner.pastedPrompts).toEqual([]);
  });

  it('injectTextToAgent refuses to inject when the bound task is already terminal', async () => {
    const t = await harness.seedTask({ id: 'task-rf-terminal', status: 'cancelled' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await expect(
      harness.manager.injectTextToAgent('qa-1', 'file body', { expectedTaskId: t.id }),
    ).rejects.toThrow(/terminal/);
    expect(harness.runner.pastedPrompts).toEqual([]);
  });

  it('injectTextToAgent refuses a newer lock generation for the same task', async () => {
    const t = await harness.seedTask({ id: 'task-rf-rebound', status: 'in_progress' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    const oldToken = await harness.acquireAgentLock('qa-1', t.id);
    expect(oldToken).toBeTruthy();
    await harness.agentStore.update('qa-1', state => ({ ...state!, lockToken: oldToken!, updatedAt: NOW }));
    const realGet = harness.taskStore.get.bind(harness.taskStore);
    vi.spyOn(harness.taskStore, 'get').mockImplementation(async (id: string) => {
      await harness.lockManager.releaseIfOwner('qa-1', t.id, oldToken!);
      const newToken = await harness.lockManager.acquire('qa-1', t.id);
      expect(newToken).toBeTruthy();
      await harness.agentStore.update('qa-1', state => ({ ...state!, lockToken: newToken!, updatedAt: NOW }));
      return realGet(id);
    });

    await expect(
      harness.manager.injectTextToAgent('qa-1', 'stale file body', { expectedTaskId: t.id }),
    ).rejects.toThrow(/exclusive lock changed/);
    expect(harness.runner.pastedPrompts).toEqual([]);
  });

  it('attachImageToRunningAgent refuses to paste into a pane held by cancel cleanup', async () => {
    await harness.seedTask({ id: 'task-img-hold', status: 'in_progress' });
    await harness.seedAgent({ id: 'qa-1', taskId: 'task-img-hold', paneId: '%1', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await expect(
      harness.manager.attachImageToRunningAgent('qa-1', Buffer.from('img'), 'png'),
    ).rejects.toThrow(/being cancelled/);
    expect(harness.runner.pastedPrompts).toEqual([]);
  });

  it('attachImageToRunningAgent refuses when the bound task is already terminal', async () => {
    const t = await harness.seedTask({ id: 'task-img-terminal', status: 'cancelled' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await expect(
      harness.manager.attachImageToRunningAgent('qa-1', Buffer.from('img'), 'png'),
    ).rejects.toThrow(/terminal/);
    expect(harness.runner.pastedPrompts).toEqual([]);
  });

  it('attachImageToRunningAgent re-checks cancel state AFTER the slow host write — refuses the paste if cancel landed', async () => {
    await harness.seedTask({ id: 'task-img-toctou', status: 'in_progress' });
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-img-toctou', paneId: '%0' });
    harness.runner.writeFile.mockImplementation(async () => { await markCancelClearing('dev-1'); });

    await expect(
      harness.manager.attachImageToRunningAgent('dev-1', Buffer.from('img'), 'png'),
    ).rejects.toThrow(/being cancelled/);
    expect(harness.runner.writeFile).toHaveBeenCalledTimes(1);
    expect(harness.runner.pastedPrompts).toEqual([]);
  });

  it('attachImageToRunningAgent re-checks the cancel hold AFTER its task read (closes the assertUploadStillValid gap)', async () => {
    await harness.seedTask({ id: 'task-img-taskgap', status: 'in_progress' });
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-img-taskgap', paneId: '%0' });
    const realGet = harness.taskStore.get.bind(harness.taskStore);
    vi.spyOn(harness.taskStore, 'get').mockImplementation(async (id: string) => {
      await markCancelClearing('dev-1');
      return realGet(id);
    });

    await expect(
      harness.manager.attachImageToRunningAgent('dev-1', Buffer.from('img'), 'png'),
    ).rejects.toThrow(/being cancelled/);
    expect(harness.runner.pastedPrompts).toEqual([]);
  });

  it('markAwaitingHuman does not let a generic hold overwrite a cancel-cleanup hold', async () => {
    await harness.seedAgent({ id: 'dev-1', taskId: 'tX', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });

    await harness.manager.markAwaitingHuman('dev-1', 'code-dispatch-failed', 'generic dispatch failure');
    expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBe('cancel-clearing');
  });

  it('markAwaitingHuman still allows the escalation cancel-clearing → cancel-interrupt-failed', async () => {
    await harness.seedAgent({ id: 'dev-1', taskId: 'tX', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await harness.manager.markAwaitingHuman('dev-1', 'cancel-interrupt-failed', 'interrupt failed');
    expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBe('cancel-interrupt-failed');
  });
});

describe('AgentManager.cancelTask release failure tolerance', () => {
  it('logs but completes the cancel when releaseAgentForTask throws', async () => {
    const runner = liveManager();
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    // E2: 释放阶段的内部异常(store/lock 状态机错误)在 runner 层造不出来,只能替换公共方法注入
    vi.spyOn(harness.manager, 'releaseAgentForTask').mockRejectedValue(new Error('release exploded'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const cancelled = await cancelOnFakeClock(t.id);

    expect(cancelled.status).toBe('cancelled');
    expect(interruptKeys(runner, '%0')).toEqual(['Escape', 'C-c']);
    expect(errSpy.mock.calls.some(c => String(c[0]).includes('releaseAgentForTask'))).toBe(true);
    errSpy.mockRestore();
  });
});
