import { describe, it, expect, vi } from 'vitest';
import { BranchManager, DirtyWorkdirError } from '../../src/agent/branch.js';
import type { PaneStreamerManager } from '../../src/agent/pane-streamer-manager.js';
import type { SubscriberCallbacks } from '../../src/agent/pane-streamer.js';
import { buildPhaseSignal, type PhaseSignalKind } from '../../src/agent/phase-signal.js';
import { registerEventHandlers } from '../../src/event/handlers.js';
import type { AgentBindingFacts, AgentConfig, TaskState } from '../../src/shared/index.js';
import type { FakeRunnerOptions } from '../helpers/fake-runner.js';
import { createManagerSuiteRunner, useManagerSuiteHarness, workdirsOf } from '../helpers/manager-harness.js';

const NOW = '2026-05-14T05:00:00.000Z';
const SHA1 = 'a'.repeat(40);
const SIGNAL_EVENT_TYPES = ['spec.ready', 'pr.created', 'pr.fix.submitted', 'pr.updated'];

const harness = useManagerSuiteHarness();

const binding = (): Promise<AgentBindingFacts | null> => harness.agentStore.get('dev-1');
const signalEvents = () => harness.events.filter(e => SIGNAL_EVENT_TYPES.includes(e.type));
const frame = (kind: PhaseSignalKind, token: string): string =>
  kind === 'pr-created' || kind === 'spec-done' ? buildPhaseSignal(kind, token, 7) : buildPhaseSignal(kind as 'pr-fixed', token);

function suiteRunner(options: FakeRunnerOptions = {}) {
  const workdirs = workdirsOf(harness.config);
  return createManagerSuiteRunner({ workdirs, ...options });
}

async function rotateTask(taskId: string, signalToken: string): Promise<void> {
  const fresh = await harness.taskStore.get(taskId);
  await harness.taskStore.set({ ...fresh!, phase: 'code', signalToken });
}

async function seedHolder(taskId: string, task: Partial<TaskState>, agent: Partial<AgentBindingFacts> = {}): Promise<void> {
  await harness.seedTask({ id: taskId, status: 'in_progress', ...task });
  await harness.seedAgent({ id: 'dev-1', taskId, paneId: '%0', ...agent });
}

// 真实 PhaseSignalWatcher 接在按 agent 分流的假 streamer 上:用例向 pane 投帧,事件经 harness.eventBus 流出
function watchedManager(opts: {
  snapshot?: () => Promise<string>;
  onSubscribe?: () => Promise<void>;
  runner?: ReturnType<typeof suiteRunner>;
} = {}) {
  const listeners = new Map<string, Array<SubscriberCallbacks['onVisible']>>();
  const paneOf = (agentId: string) => listeners.get(agentId) ?? listeners.set(agentId, []).get(agentId)!;
  let subscribes = 0;
  const ensure = (agent: AgentConfig) => ({
    subscribeAtomic: async (cbs: SubscriberCallbacks) => {
      subscribes += 1;
      await opts.onSubscribe?.();
      paneOf(agent.id).push(cbs.onVisible);
      return {
        snapshot: { data: (await opts.snapshot?.()) ?? '', cols: 80, rows: 24 },
        snapshotSeq: 0,
        unsubscribe: () => { listeners.set(agent.id, paneOf(agent.id).filter(cb => cb !== cbs.onVisible)); },
      };
    },
  });
  const m = harness.createManager({
    paneStreamerManager: { ensure } as unknown as PaneStreamerManager,
    ...(opts.runner ? { runnerFactory: () => opts.runner! } : {}),
  });
  return {
    m,
    post: (agentId: string, signal: string) => { for (const cb of [...paneOf(agentId)]) cb?.(`${signal}\n`, 1); },
    listening: (agentId: string) => paneOf(agentId).length,
    subscribes: () => subscribes,
  };
}

describe('AgentManager.redispatchTaskPromptAfterReplRestart', () => {
  it.each([
    { status: 'in_progress', phase: undefined, kind: 'spec-done', eventType: 'spec.ready' },
    { status: 'in_progress', phase: 'code', kind: 'pr-created', eventType: 'pr.created' },
    { status: 'fixing', phase: 'code', kind: 'pr-fixed', eventType: 'pr.fix.submitted' },
    { status: 'approved', phase: 'code', kind: 'pr-merge-ready', eventType: 'pr.updated' },
  ] as const)('preserves uncertain $status/$phase delivery after a transient post-Enter failure', async ({ kind, eventType, ...task }) => {
    let entered = false;
    let dropped = false;
    const runner = suiteRunner({
      onExec: command => {
        if (runner.pastedPrompts.length > 0 && /send-keys -t %0 (?:-- )?\S*Enter/.test(command)) entered = true;
        if (entered && !dropped && command.includes('capture-pane')) {
          dropped = true;
          throw new Error('one-off SSH capture failure after Enter');
        }
      },
    });
    const { m, post } = watchedManager({ runner });
    const taskId = 'task-replay-unknown';
    await seedHolder(taskId, {
      ...task, signalToken: 'initial-token',
      ...(task.status === 'approved' ? {
        postApproveGeneration: 'feedfeedfeed', postApproveHeadSha: SHA1,
        postApproveToken: 'initial-post-token', postApprovePhase: 'installed',
      } : {}),
    }, task.phase === undefined ? { bootstrappingTaskId: taskId } : {});

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', taskId)).resolves.toBe(true);

    expect(dropped).toBe(true);
    expect(runner.pastedPrompts).toHaveLength(1);
    const held = await binding();
    const afterReplay = await harness.taskStore.get(taskId);
    expect(held).toMatchObject({ status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown' });
    if (task.phase === undefined) expect(held?.bootstrappingTaskId).toBe(taskId);
    expect(held?.awaitingReason).toContain('one-off SSH capture failure after Enter');
    expect(held?.awaitingReason).not.toContain('retry the current step');

    const resumed = await m.resumeAgent('dev-1');
    expect(resumed).toMatchObject({ resumed: false, reason: expect.stringContaining('terminal') });
    expect(resumed.reason).not.toContain('uncertain review dispatch');
    await expect(m.advanceTask(taskId)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Prompt may still be running') });

    expect(await binding()).toEqual(held);
    expect(await harness.taskStore.get(taskId)).toEqual(afterReplay);
    expect(runner.pastedPrompts).toHaveLength(1);
    const token = task.status === 'approved' ? afterReplay!.postApproveToken! : afterReplay!.signalToken!;
    post('dev-1', frame(kind, token));
    await vi.waitFor(() => expect(signalEvents()).toEqual([
      expect.objectContaining({ type: eventType, taskId, agentId: 'dev-1' }),
    ]));
  });

  it.each([
    { phase: undefined, kind: 'spec-done', reviewPhase: 'spec' },
    { phase: 'code', kind: 'pr-created', reviewPhase: 'code' },
  ] as const)('allows recovery after late $kind proves an uncertain Dev prompt advanced', async ({ phase, kind, reviewPhase }) => {
    let entered = false;
    let dropped = false;
    const runner = suiteRunner({
      onExec: command => {
        if (runner.pastedPrompts.length > 0 && /send-keys -t %0 (?:-- )?\S*Enter/.test(command)) entered = true;
        if (entered && !dropped && command.includes('capture-pane')) {
          dropped = true;
          throw new Error('one-off SSH capture failure after Enter');
        }
      },
    });
    const { m, post } = watchedManager({ runner });
    const taskId = 'task-late-outcome';
    vi.spyOn(m, 'platformVerifyPrBinding').mockResolvedValue({
      ok: true, prUrl: 'https://github.com/user/repo/pull/7', headSha: SHA1,
      branch: `bx/${taskId}`, targetBranch: 'main',
    });
    registerEventHandlers(harness.eventBus, m);
    await seedHolder(taskId, { phase, signalToken: 'initial-token' }, { bootstrappingTaskId: taskId });
    await m.redispatchTaskPromptAfterReplRestart('dev-1', taskId);
    const held = await binding();
    expect(held?.awaitingPhase).toBe('dispatch-failed:ack_unknown');
    expect(runner.pastedPrompts).toHaveLength(1);
    await expect(m.resumeAgent('dev-1')).resolves.toMatchObject({ resumed: false });

    post('dev-1', frame(kind, (await harness.taskStore.get(taskId))!.signalToken!));
    await vi.waitFor(() => expect(harness.events.some(event => event.type === 'human.intervention'
      && event.data.phase === 'git-review-dispatch-failed')).toBe(true));
    const advanced = await harness.taskStore.get(taskId);
    expect(advanced).toMatchObject({ status: 'review', phase: reviewPhase, reviewDispatch: { phase: 'pending' } });

    await expect(m.resumeAgent('dev-1')).resolves.toMatchObject({ resumed: true, releasedBinding: false });
    expect((await harness.taskStore.get(taskId))?.signalToken).toBe(advanced?.signalToken);
    expect(runner.pastedPrompts).toHaveLength(1);
    await expect(m.advanceTask(taskId, { executor: 'qa' })).resolves.toMatchObject({ status: 'review' });
    expect(runner.pastedPrompts).toHaveLength(2);
    expect(runner.pastedPrompts[1]?.pane).toBe('%1');
    expect((await binding())?.awaitingPhase).toBeUndefined();
  });

  async function rotatedTaskToken(taskId: string, oldToken: string): Promise<string> {
    const token = (await harness.taskStore.get(taskId))?.signalToken;
    expect(token).toEqual(expect.any(String));
    expect(token).not.toBe(oldToken);
    return token!;
  }

  it.each(['spec-ready', 'merge-ready', 'max_rounds'] as const)('does not replay a task awaiting a %s decision', async (status) => {
    await seedHolder('task-human-gate', { status, signalToken: 'gate-token' });

    expect(await harness.manager.redispatchTaskPromptAfterReplRestart('dev-1', 'task-human-gate')).toBe(false);

    expect(harness.runner.pastedPrompts).toEqual([]);
    expect((await harness.taskStore.get('task-human-gate'))?.signalToken).toBe('gate-token');
    expect((await binding())?.awaitingPhase).toBeUndefined();
  });

  it.each([
    ['spec-done', 'spec.ready'],
    ['pr-created', 'pr.created'],
  ] as const)('replays the initial develop prompt for a delivered dev holder and arms %s on the rotated token only', async (kind, eventType) => {
    const { m, post } = watchedManager();
    await seedHolder('task-dev-restart', { signalToken: 'dev-token-1' });

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-dev-restart')).toBe(true);

    const newToken = await rotatedTaskToken('task-dev-restart', 'dev-token-1');
    expect(harness.runner.pastedPrompts).toEqual([{ pane: '%0', body: expect.stringContaining(`token: ${newToken}`) }]);
    expect(harness.runner.pastedPrompts[0]!.body).not.toContain('token: dev-token-1');
    // 已交付过的 holder 在脏 Workdir 上重放,不再要求 clean
    expect(BranchManager.prototype.assertClean).not.toHaveBeenCalled();
    expect((await binding())?.status).toBeUndefined();
    post('dev-1', frame(kind, 'dev-token-1'));
    expect(signalEvents()).toEqual([]);
    post('dev-1', frame(kind, newToken));
    await vi.waitFor(() => expect(signalEvents()).toEqual([
      expect.objectContaining({ type: eventType, taskId: 'task-dev-restart', agentId: 'dev-1' }),
    ]));
  });

  it('replays a git code phase and arms only pr-created on the rotated token', async () => {
    const { m, post } = watchedManager();
    await seedHolder('task-git-code-restart', { phase: 'code', specReviewRound: 2, signalToken: 'git-code-token' });

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-git-code-restart')).toBe(true);

    const newToken = await rotatedTaskToken('task-git-code-restart', 'git-code-token');
    expect((await binding())?.status).toBeUndefined();
    expect(harness.runner.pastedPrompts).toEqual([{ pane: '%0', body: expect.stringContaining(`token: ${newToken}`) }]);
    expect(BranchManager.prototype.assertClean).not.toHaveBeenCalled();
    post('dev-1', frame('spec-done', newToken));
    expect(signalEvents()).toEqual([]);
    post('dev-1', frame('pr-created', newToken));
    await vi.waitFor(() => expect(signalEvents()).toEqual([
      expect.objectContaining({ type: 'pr.created', taskId: 'task-git-code-restart' }),
    ]));
  });

  it('finalizes an interrupted git code bootstrap after replay', async () => {
    const m = harness.manager;
    await seedHolder(
      'task-git-code-boot-restart',
      { phase: 'code', specReviewRound: 1, signalToken: 'git-code-boot-token' },
      { bootstrappingTaskId: 'task-git-code-boot-restart' },
    );

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-git-code-boot-restart')).toBe(true);

    expect(harness.runner.pastedPrompts).toHaveLength(1);
    expect((await binding())?.status).toBeUndefined();
    expect((await binding())?.bootstrappingTaskId).toBeUndefined();
    expect(harness.events.some(e =>
      e.type === 'session.started' && e.taskId === 'task-git-code-boot-restart' && e.data.phase === 'code',
    )).toBe(true);
  });

  it('replays spec fixing from PR feedback and arms pr-fixed', async () => {
    const { m, post } = watchedManager();
    await seedHolder('task-git-spec-fix-restart', { status: 'fixing', phase: 'spec', specReviewRound: 2, signalToken: 'git-spec-fix-token' });

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-git-spec-fix-restart')).toBe(true);

    const newToken = await rotatedTaskToken('task-git-spec-fix-restart', 'git-spec-fix-token');
    expect((await binding())?.status).toBeUndefined();
    expect(harness.runner.pastedPrompts).toEqual([{ pane: '%0', body: expect.stringContaining(`token: ${newToken}`) }]);
    expect(BranchManager.prototype.assertClean).not.toHaveBeenCalled();
    post('dev-1', frame('pr-fixed', newToken));
    await vi.waitFor(() => expect(signalEvents()).toEqual([
      expect.objectContaining({ type: 'pr.fix.submitted', taskId: 'task-git-spec-fix-restart' }),
    ]));
  });

  it.each([
    ['code', 'task-dev-fix-restart', 'dev-fix-token'],
    [undefined, 'task-dev-fix-nophase-restart', 'dev-fix-nophase-token'],
  ] as const)('replays the PR-feedback fix prompt for a github fixing pass (phase=%s) and arms pr-fixed', async (phase, taskId, oldToken) => {
    const { m, post } = watchedManager();
    await seedHolder(taskId, { status: 'fixing', reviewRound: 1, signalToken: oldToken, ...(phase ? { phase } : {}) });

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', taskId)).toBe(true);

    const newToken = await rotatedTaskToken(taskId, oldToken);
    expect(harness.runner.pastedPrompts).toEqual([{ pane: '%0', body: expect.stringContaining(`token: ${newToken}`) }]);
    expect(BranchManager.prototype.assertClean).not.toHaveBeenCalled();
    post('dev-1', frame('pr-fixed', oldToken));
    expect(signalEvents()).toEqual([]);
    post('dev-1', frame('pr-fixed', newToken));
    await vi.waitFor(() => expect(signalEvents()).toEqual([
      expect.objectContaining({ type: 'pr.fix.submitted', taskId }),
    ]));
  });

  it('arms replay watchers without consuming the stale pane snapshot', async () => {
    // 订阅时 pane 上已经留着一帧新 token 的完成信号:重派武装必须跳过它,只认之后的活帧
    const { m, post } = watchedManager({
      snapshot: async () => frame('spec-done', (await harness.taskStore.get('task-snap-restart'))!.signalToken!),
    });
    await seedHolder('task-snap-restart', { signalToken: 'snap-token-1' });

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-snap-restart')).toBe(true);

    const newToken = await rotatedTaskToken('task-snap-restart', 'snap-token-1');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(signalEvents()).toEqual([]);
    post('dev-1', frame('spec-done', newToken));
    await vi.waitFor(() => expect(signalEvents()).toEqual([
      expect.objectContaining({ type: 'spec.ready', taskId: 'task-snap-restart' }),
    ]));
  });

  it('a replay arm replaces only its own agent entry: another agent watching the same task keeps firing', async () => {
    const { m, post } = watchedManager();
    await seedHolder('task-scope-restart', { signalToken: 'scope-token-1' });
    expect(await m.setupPhaseSignal('task-scope-restart', 'qa-1', ['pr-fixed'], { tokenOverride: 'qa-side-token' })).toBe(true);

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-scope-restart')).toBe(true);

    post('qa-1', frame('pr-fixed', 'qa-side-token'));
    await vi.waitFor(() => expect(signalEvents()).toEqual([
      expect.objectContaining({ type: 'pr.fix.submitted', taskId: 'task-scope-restart', agentId: 'qa-1' }),
    ]));
  });

  it('tears down the replay arm and aborts the paste when the pass advances during arming', async () => {
    const { m, listening } = watchedManager({ onSubscribe: () => rotateTask('task-arm-drift', 'arm-rotated-2') });
    await seedHolder('task-arm-drift', { signalToken: 'arm-stale-1' });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-arm-drift')).resolves.toBe(false);

    expect(harness.runner.pastedPrompts).toEqual([]);
    expect(listening('dev-1')).toBe(0);
  });

  it('aborts the paste when the pass rotates after arming but before inject', async () => {
    let armed = false;
    const { m, listening } = watchedManager({ onSubscribe: async () => { armed = true; } });
    await seedHolder('task-paste-drift', { signalToken: 'paste-stale-1' });
    let drifted = false;
    const realUpdate = harness.agentStore.update.bind(harness.agentStore);
    vi.spyOn(harness.agentStore, 'update').mockImplementation(async (id, updater) => {
      if (armed && !drifted) {
        drifted = true;
        await rotateTask('task-paste-drift', 'paste-rotated-2');
      }
      return realUpdate(id, updater);
    });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-paste-drift')).resolves.toBe(false);

    expect(harness.runner.pastedPrompts).toEqual([]);
    expect(listening('dev-1')).toBe(0);
  });

  it('finalizes the bootstrap marker and delivery evidence after replaying an interrupted initial develop', async () => {
    const m = harness.manager;
    await seedHolder('task-boot-replay', { signalToken: 'boot-token-1' }, { bootstrappingTaskId: 'task-boot-replay' });

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-boot-replay')).toBe(true);

    expect(harness.runner.pastedPrompts).toHaveLength(1);
    // 未交付过的初始 develop 仍要求 clean Workdir
    expect(BranchManager.prototype.assertClean).toHaveBeenCalled();
    expect((await binding())?.bootstrappingTaskId).toBeUndefined();
    expect(harness.events.some(e =>
      e.type === 'session.started' && e.taskId === 'task-boot-replay' && e.data.phase === 'develop',
    )).toBe(true);
  });

  it('preserves a dirty bootstrap hold on Resume and delivers through Advance after the workdir is fixed', async () => {
    const taskId = 'task-dirty-bootstrap';
    const m = harness.manager;
    await seedHolder(taskId, { signalToken: 'dirty-bootstrap-token' }, { bootstrappingTaskId: taskId });
    const error = new DirtyWorkdirError((await binding())!.workdir!);
    vi.mocked(BranchManager.prototype.assertClean).mockRejectedValueOnce(error);

    await expect(m.advanceTask(taskId)).rejects.toMatchObject({
      status: 409, message: expect.stringContaining(error.message),
    });
    expect(harness.events.some(event => event.type === 'task.updated' && event.data.operation === 'advance')).toBe(false);

    const held = await binding();
    expect(held).toMatchObject({
      status: 'awaiting_human',
      awaitingPhase: 'dirty-workdir',
      bootstrappingTaskId: taskId,
    });
    expect(held?.awaitingReason).toContain(error.message);
    expect(held?.awaitingReason).toMatch(/commit.*stash/);
    expect(harness.runner.pastedPrompts).toEqual([]);

    await expect(m.resumeAgent('dev-1')).resolves.toMatchObject({ resumed: false, releasedBinding: false });
    expect(await binding()).toEqual(held);
    expect(harness.runner.pastedPrompts).toEqual([]);

    await m.advanceTask(taskId);

    expect(harness.runner.pastedPrompts).toHaveLength(1);
    expect((await binding())?.status).toBeUndefined();
    expect((await binding())?.bootstrappingTaskId).toBeUndefined();
    expect(harness.events.some(e => e.type === 'session.started' && e.taskId === taskId)).toBe(true);
  });

  it('keeps the bootstrap marker and holds the rotated pass when the replay is not delivered', async () => {
    let handedOff = false;
    // 会话探测期间绑定换手(lockToken 被继任者改写):continueSession 在 ensure 之后放弃投递
    const runner = suiteRunner({
      onExec: async (command) => {
        if (!command.includes('tmux list-sessions') || handedOff) return;
        handedOff = true;
        await harness.agentStore.update('dev-1', latest => (latest ? { ...latest, lockToken: 'successor-token' } : latest));
      },
    });
    const m = harness.createManager({ runnerFactory: () => runner });
    await seedHolder('task-boot-keep', { signalToken: 'boot-token-2' }, { bootstrappingTaskId: 'task-boot-keep' });

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-boot-keep')).toBe(true);

    expect(await rotatedTaskToken('task-boot-keep', 'boot-token-2')).toEqual(expect.any(String));
    expect(runner.pastedPrompts).toEqual([]);
    expect((await binding())?.bootstrappingTaskId).toBe('task-boot-keep');
    expect((await binding())?.awaitingPhase).toBe('restart-redispatch-failed');
    expect(harness.events.some(e => e.type === 'session.started' && e.taskId === 'task-boot-keep')).toBe(false);
  });

  it('hold CAS distinguishes generations rewritten within the same millisecond', async () => {
    const m = harness.manager;
    await harness.seedTask({ id: 'task-aba-hold', status: 'in_progress' });
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-aba-hold', paneId: '%0' });
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-07-01T00:00:00.000Z') });
    try {
      await m.markAwaitingHuman('dev-1', 'hold-x', 'first generation');
      const gen1 = await harness.agentStore.get('dev-1');
      const entry = {
        phase: gen1?.awaitingPhase,
        since: gen1?.awaitingSince,
        nonce: gen1?.awaitingNonce,
      };

      await m.clearAwaitingHuman('dev-1');
      await m.markAwaitingHuman('dev-1', 'hold-x', 'second generation');
      const gen2 = await harness.agentStore.get('dev-1');
      expect(gen2?.awaitingSince).toBe(gen1?.awaitingSince);
      expect(gen2?.awaitingNonce).not.toBe(gen1?.awaitingNonce);

      expect(await m.clearAwaitingHuman('dev-1', { expectedHold: entry })).toBe(false);
      expect((await harness.agentStore.get('dev-1'))?.status).toBe('awaiting_human');
      expect((await harness.agentStore.get('dev-1'))?.awaitingReason).toBe('second generation');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([undefined, 'code'] as const)('does not replay a delivered bootstrap after repeated retries (phase=%s)', async (phase) => {
    const m = harness.manager;
    await seedHolder('task-boot-delivered', { phase, signalToken: 'boot-token-3' }, {
      bootstrappingTaskId: 'task-boot-delivered',
      status: 'awaiting_human',
      awaitingPhase: 'bootstrap-marker-clear-failed',
      awaitingReason: 'marker clear failed after delivery',
      awaitingSince: NOW,
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-boot-delivered')).toBe(true);
    }

    expect(harness.runner.pastedPrompts).toEqual([]);
    expect(harness.runner.exec.mock.calls.some(c => (c[0] as string).includes('tmux'))).toBe(false);
    const state = await binding();
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('bootstrap-marker-clear-failed');
    expect(state?.bootstrappingTaskId).toBe('task-boot-delivered');
    expect((await harness.taskStore.get('task-boot-delivered'))?.signalToken).toBe('boot-token-3');
    expect(state?.awaitingReason).toMatch(/already delivered/);
  });

  it('aborts the replay before arming when the pass moved on mid-dispatch', async () => {
    let drifted = false;
    const runner = suiteRunner({
      onExec: async (command) => {
        if (!command.includes('tmux list-sessions') || drifted) return;
        drifted = true;
        await rotateTask('task-drift-restart', 'rotated-token-2');
      },
    });
    const { m, subscribes } = watchedManager({ runner });
    await seedHolder('task-drift-restart', { signalToken: 'stale-token-1' });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-drift-restart')).resolves.toBe(false);

    expect(subscribes()).toBe(0);
    expect(runner.pastedPrompts).toEqual([]);
  });

  it('rotates an embedded git post-approve token without losing episode metadata', async () => {
    const { m, post } = watchedManager();
    await seedHolder('task-postapprove-git-restart', {
      status: 'approved',
      signalToken: 'task-token-git',
      postApproveGeneration: 'feedfeedfeed',
      postApproveHeadSha: SHA1,
      postApproveToken: 'git-pa-token-1',
      postApprovePhase: 'installed',
      redispatchCount: 4,
      pendingRedispatch: true,
      consumedFeedback: { review_1: 17 },
    });

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-postapprove-git-restart')).toBe(true);

    const task = await harness.taskStore.get('task-postapprove-git-restart');
    expect(task?.postApproveToken).not.toBe('git-pa-token-1');
    expect(task?.signalToken).toBe('task-token-git');
    expect(task).toMatchObject({
      postApproveGeneration: 'feedfeedfeed',
      postApproveHeadSha: SHA1,
      postApprovePhase: 'delivered',
      redispatchCount: 4,
      pendingRedispatch: false,
      consumedFeedback: { review_1: 17 },
    });
    expect(harness.runner.pastedPrompts).toEqual([{ pane: '%0', body: expect.stringContaining(`token: ${task!.postApproveToken}`) }]);
    post('dev-1', buildPhaseSignal('pr-merge-ready', 'git-pa-token-1'));
    expect(signalEvents()).toEqual([]);
    post('dev-1', buildPhaseSignal('pr-merge-ready', task!.postApproveToken!));
    await vi.waitFor(() => expect(signalEvents()).toEqual([
      expect.objectContaining({ type: 'pr.updated', taskId: 'task-postapprove-git-restart' }),
    ]));
  });

  it.each([false, true])('does not replay a delivered post-approve prompt when its delivery write fails (persisted=%s)', async (persisted) => {
    const taskId = 'task-delivered-write-failed';
    const { m, post } = watchedManager();
    await seedHolder(taskId, {
      status: 'approved', phase: 'code', signalToken: 'task-token',
      postApproveGeneration: 'feedfeedfeed', postApproveHeadSha: SHA1,
      postApproveToken: 'old-post-token', postApprovePhase: 'installed', pendingRedispatch: true,
    });
    let failed = false;
    const realSet = harness.taskStore.set.bind(harness.taskStore);
    vi.spyOn(harness.taskStore, 'set').mockImplementation(async task => {
      if (!failed && task.id === taskId && task.postApprovePhase === 'delivered') {
        failed = true;
        if (persisted) await realSet(task);
        throw new Error('one-off delivery persistence failure');
      }
      return realSet(task);
    });

    await expect(m.advanceTask(taskId)).rejects.toMatchObject({
      status: 409, message: expect.stringContaining('one-off delivery persistence failure'),
    });
    expect(failed).toBe(true);
    expect(harness.runner.pastedPrompts).toHaveLength(1);
    const afterDelivery = await harness.taskStore.get(taskId);

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(m.advanceTask(taskId)).rejects.toMatchObject({ status: 409 });
      await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', taskId)).resolves.toBe(true);
    }
    await expect(m.resumeAgent('dev-1')).resolves.toMatchObject({ resumed: false });

    expect(await binding()).toMatchObject({
      status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown',
      awaitingReason: expect.stringContaining('already delivered'),
    });
    expect(await harness.taskStore.get(taskId)).toEqual(afterDelivery);
    expect(afterDelivery?.postApproveToken).not.toBe('old-post-token');
    expect(afterDelivery?.postApprovePhase).toBe(persisted ? 'delivered' : 'installed');
    expect(harness.runner.pastedPrompts).toHaveLength(1);
    expect(harness.events.some(event => event.type === 'task.updated' && event.data.operation === 'advance')).toBe(false);
    post('dev-1', buildPhaseSignal('pr-merge-ready', afterDelivery!.postApproveToken!));
    await vi.waitFor(() => expect(signalEvents()).toEqual([
      expect.objectContaining({ type: 'pr.updated', taskId }),
    ]));
  });

  it.each([
    ['neither completion nor approved head survive', { signalToken: 'tok-x' }],
    ['only a drifted latestHeadSha is persisted', { latestHeadSha: 'unreviewed-sha-B' }],
  ] as const)('holds the post-approve replay when %s', async (_label, task) => {
    const m = harness.manager;
    await seedHolder('task-postapprove-lost', { status: 'approved', ...task });

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-postapprove-lost')).toBe(true);

    expect(harness.runner.pastedPrompts).toEqual([]);
    expect(await m.getPostApproveCompletion('task-postapprove-lost')).toBeNull();
    const held = await binding();
    expect(held?.status).toBe('awaiting_human');
    expect(held?.awaitingPhase).toBe('restart-redispatch-failed');
    expect(held?.awaitingReason).toMatch(/no complete post-approve episode/);
  });

  it('markAwaitingHuman reports whether the hold generation write landed', async () => {
    const m = harness.manager;
    await harness.seedTask({ id: 'task-mark-cas', status: 'in_progress', signalToken: 'mc-T1' });
    await harness.seedAgent({
      id: 'dev-1', taskId: 'task-mark-cas',
      status: 'awaiting_human', awaitingPhase: 'phase-a', awaitingReason: 'r', awaitingSince: NOW,
    });

    expect(await m.markAwaitingHuman('dev-1', 'phase-b', 'r2', {
      expectedTaskId: 'task-mark-cas',
      expectedHold: { phase: 'phase-x', since: NOW },
    })).toBe(false);
    expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBe('phase-a');

    expect(await m.markAwaitingHuman('dev-1', 'phase-b', 'r2', {
      expectedTaskId: 'task-mark-cas',
      expectedHold: { phase: 'phase-a', since: NOW },
    })).toBe(true);
    expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBe('phase-b');
  });

  it('aborts the replay when the entry hold vanished before the clear', async () => {
    const m = harness.manager;
    await seedHolder('task-entry-clear', { signalToken: 'ec-T1' }, {
      status: 'awaiting_human',
      awaitingPhase: 'restart-redispatch-failed',
      awaitingReason: 'pre-restart hold',
      awaitingSince: NOW,
    });
    const realGet = harness.taskStore.get.bind(harness.taskStore);
    let reads = 0;
    vi.spyOn(harness.taskStore, 'get').mockImplementation(async (id) => {
      const value = await realGet(id);
      if (id === 'task-entry-clear') {
        reads += 1;
        if (reads === 2) await m.clearAwaitingHuman('dev-1');
      }
      return value;
    });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-entry-clear')).resolves.toBe(false);
    expect(harness.runner.pastedPrompts).toEqual([]);
  });

  it('a successor hold landing after the currentness read still survives the clear', async () => {
    const m = harness.manager;
    await seedHolder('task-hold-cas', { signalToken: 'hc-T1' });
    const realGet = harness.taskStore.get.bind(harness.taskStore);
    let reads = 0;
    vi.spyOn(harness.taskStore, 'get').mockImplementation(async (id) => {
      const value = await realGet(id);
      if (id === 'task-hold-cas') {
        reads += 1;
        if (reads === 2 && value) {
          await m.markAwaitingHuman(
            'dev-1',
            'code-dispatch-failed',
            'successor hold after currentness read',
            expect.objectContaining({ expectedTaskId: 'task-hold-cas' }),
          );
          await harness.taskStore.set({ ...value, phase: 'code', signalToken: 'hc-T2' });
        }
      }
      return value;
    });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-hold-cas')).resolves.toBe(false);
    const state = await binding();
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('code-dispatch-failed');
    expect(state?.awaitingReason).toBe('successor hold after currentness read');
  });

  it('a stale replay never clears a hold written by the successor pass', async () => {
    const m = harness.manager;
    await seedHolder('task-hold-race', { signalToken: 'hr-T1' });
    const realGet = harness.taskStore.get.bind(harness.taskStore);
    let hooked = false;
    vi.spyOn(harness.taskStore, 'get').mockImplementation(async (id) => {
      const value = await realGet(id);
      if (id === 'task-hold-race' && !hooked && value) {
        hooked = true;
        await m.markAwaitingHuman(
          'dev-1',
          'code-dispatch-failed',
          'successor hold',
          expect.objectContaining({ expectedTaskId: 'task-hold-race' }),
        );
        await harness.taskStore.set({ ...value, phase: 'code', signalToken: 'hr-T2' });
      }
      return value;
    });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-hold-race')).resolves.toBe(false);
    const state = await binding();
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('code-dispatch-failed');
    expect(state?.awaitingReason).toBe('successor hold');
  });

  it.each([
    { status: 'in_progress', phase: undefined },
    { status: 'in_progress', phase: 'code' },
    { status: 'fixing', phase: 'code' },
  ] as const)('keeps a $status/$phase transport failure separate from workdir cleanup', async (task) => {
    const { m } = watchedManager({ onSubscribe: async () => { throw new Error('subscribe transport down'); } });
    await seedHolder('task-arm-fail', { ...task, signalToken: 'arm-fail-1' });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-arm-fail')).resolves.toBe(true);

    expect(harness.runner.pastedPrompts).toEqual([]);
    const held = await binding();
    expect(held?.status).toBe('awaiting_human');
    expect(held?.awaitingPhase).toBe('restart-redispatch-failed');
    expect(held?.awaitingReason).toMatch(/failed to arm/);
    expect(held?.awaitingReason).not.toMatch(/commit|stash/i);
    expect(BranchManager.prototype.assertClean).not.toHaveBeenCalled();
  });

  it('a post-clear replay throw is held on the live generation, not the stale entry hold', async () => {
    const runner = suiteRunner({ rules: [{ match: 'paste-buffer', reply: { outcome: 'refused' } }] });
    const { m } = watchedManager({ runner });
    await seedHolder('task-throw-held', { signalToken: 'throw-held-1' }, {
      status: 'awaiting_human', awaitingPhase: 'restart-redispatch-failed', awaitingSince: NOW,
    });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-throw-held')).resolves.toBe(true);

    expect(runner.pastedPrompts).toEqual([]);
    const held = await binding();
    expect(held?.status).toBe('awaiting_human');
    expect(held?.awaitingPhase).toBe('restart-redispatch-failed');
    expect(held?.awaitingSince).not.toBe(NOW);
  });

  it('a replay throw after a successor rotation exits without holding the successor', async () => {
    const runner = suiteRunner({
      rules: [{ match: 'paste-buffer', reply: { outcome: 'refused' } }],
      onExec: async (command) => {
        if (command.includes('paste-buffer')) await rotateTask('task-throw-rotated', 'throw-rot-2');
      },
    });
    const { m } = watchedManager({ runner });
    await seedHolder('task-throw-rotated', { signalToken: 'throw-rot-1' });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-throw-rotated')).resolves.toBe(false);

    expect(runner.pastedPrompts).toEqual([]);
    expect((await binding())?.status).not.toBe('awaiting_human');
  });

  it('exits quietly when the arm failed because the pass already moved on', async () => {
    const { m } = watchedManager({
      onSubscribe: async () => {
        await rotateTask('task-arm-fail-drift', 'arm-fail-rotated');
        throw new Error('subscribe transport down');
      },
    });
    await seedHolder('task-arm-fail-drift', { signalToken: 'arm-fail-2' });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-arm-fail-drift')).resolves.toBe(false);

    expect(harness.runner.pastedPrompts).toEqual([]);
    expect((await binding())?.status).toBeUndefined();
  });

  it('aborts the paste when the pass rotates while waiting for the pane mutex', async () => {
    const { m, listening } = watchedManager();
    await seedHolder('task-mutex-drift', { signalToken: 'mutex-stale-1' });
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve; });
    harness.runner.writeFile.mockImplementationOnce(async () => { await uploadGate; });
    // 图片上传持有 pane 互斥;重派在 injectAndAwaitAck 门口排队
    const upload = m.attachImageToRunningAgent('dev-1', Buffer.from('png'), 'png');
    await vi.waitFor(() => expect(harness.runner.writeFile).toHaveBeenCalled());
    const realGet = harness.taskStore.get.bind(harness.taskStore);
    let readsAfterArm = 0;
    vi.spyOn(harness.taskStore, 'get').mockImplementation(async (id) => {
      const value = await realGet(id);
      // 武装后的第二次读是 pre-inject 守卫;它放行后、拿到互斥前换代
      if (id === 'task-mutex-drift' && listening('dev-1') > 0 && ++readsAfterArm === 2) {
        await rotateTask('task-mutex-drift', 'mutex-rotated-2');
        releaseUpload();
      }
      return value;
    });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-mutex-drift')).resolves.toBe(false);
    await upload;

    expect(readsAfterArm).toBeGreaterThanOrEqual(2);
    expect(harness.runner.pastedPrompts).toEqual([{ pane: '%0', body: expect.stringMatching(/\.png $/) }]);
    expect(listening('dev-1')).toBe(0);
  });

  it('holds an in-flight holder whose signal token is missing', async () => {
    const m = harness.manager;
    await seedHolder('task-no-token', {});

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-no-token')).toBe(true);

    expect(harness.runner.pastedPrompts).toEqual([]);
    const held = await binding();
    expect(held?.status).toBe('awaiting_human');
    expect(held?.awaitingPhase).toBe('restart-redispatch-failed');
    expect(held?.awaitingReason).toMatch(/no signal token/);
  });

  it('leaves non-working statuses to the waiting transition', async () => {
    const m = harness.manager;
    await harness.seedTask({
      id: 'task-in-review',
      status: 'review',
      phase: 'code',
      qaAgentId: 'qa-1',
      signalToken: 'tok-b',
    });
    await harness.seedTask({
      id: 'task-spec-ready',
      status: 'spec-ready',
      phase: 'spec',
      signalToken: 'tok-c',
    });
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-in-review', paneId: '%0' });

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-in-review')).toBe(false);
    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-spec-ready')).toBe(false);
    expect(harness.runner.pastedPrompts).toEqual([]);
    expect((await binding())?.status).toBeUndefined();
  });
});

describe('AgentManager.advanceTask', () => {
  it.each(([
    { status: 'in_progress', phase: undefined },
    { status: 'in_progress', phase: 'code' },
    { status: 'fixing', phase: 'code' },
    { status: 'approved', phase: 'code' },
  ] as const).flatMap(task => (['watcher', 'paste'] as const).map(failure => ({ ...task, failure }))))('reports $status/$phase $failure failures without auditing success', async ({ failure, ...task }) => {
    const taskId = `task-advance-${failure}`;
    const runner = suiteRunner(failure === 'paste'
      ? { rules: [{ match: 'paste-buffer', reply: { outcome: 'refused' } }] }
      : {});
    const { m } = watchedManager({
      runner,
      ...(failure === 'watcher' ? { onSubscribe: async () => { throw new Error('subscribe transport down'); } } : {}),
    });
    await seedHolder(taskId, {
      ...task, signalToken: 'advance-old-token',
      ...(task.status === 'approved' ? {
        postApproveGeneration: 'feedfeedfeed', postApproveHeadSha: SHA1,
        postApproveToken: 'advance-post-token', postApprovePhase: 'installed',
      } : {}),
    }, {
      status: 'awaiting_human', awaitingPhase: 'restart-redispatch-failed',
      awaitingReason: 'old failure', awaitingSince: NOW, awaitingNonce: 'old-hold',
    });

    await expect(m.advanceTask(taskId)).rejects.toMatchObject({
      status: 409, message: expect.stringContaining('Task prompt replay failed'),
    });

    const held = await binding();
    expect(held).toMatchObject({ status: 'awaiting_human', awaitingPhase: 'restart-redispatch-failed' });
    expect(held?.awaitingNonce).not.toBe('old-hold');
    expect(held?.awaitingReason).not.toBe('old failure');
    expect(runner.pastedPrompts).toEqual([]);
    expect(harness.events.some(event => event.type === 'task.updated' && event.data.operation === 'advance')).toBe(false);
  });

  it('reports an approved task with an incomplete completion episode as blocked', async () => {
    await seedHolder('task-advance-incomplete', { status: 'approved', signalToken: 'task-token' });

    await expect(harness.manager.advanceTask('task-advance-incomplete')).rejects.toMatchObject({
      status: 409, message: expect.stringContaining('no complete post-approve episode'),
    });

    expect(harness.runner.pastedPrompts).toEqual([]);
    expect(harness.events.some(event => event.type === 'task.updated' && event.data.operation === 'advance')).toBe(false);
  });

  it('surfaces a successor hold without overwriting it or auditing Advance success', async () => {
    const taskId = 'task-advance-successor-hold';
    const { m } = watchedManager({
      onSubscribe: async () => {
        await harness.manager.markAwaitingHuman('dev-1', 'successor-hold', 'Inspect the successor hold');
        throw new Error('subscribe transport down');
      },
    });
    await seedHolder(taskId, { phase: 'code', signalToken: 'entry-token' });

    await expect(m.advanceTask(taskId)).rejects.toMatchObject({
      status: 409, message: expect.stringContaining('Inspect the successor hold'),
    });

    expect(await binding()).toMatchObject({ status: 'awaiting_human', awaitingPhase: 'successor-hold' });
    expect(harness.runner.pastedPrompts).toEqual([]);
    expect(harness.events.some(event => event.type === 'task.updated' && event.data.operation === 'advance')).toBe(false);
  });

  it.each(['dispatch-failed:ack_unknown', 'dev-wait-gate-failed-after-qa-started'])('does not replay an uncertain %s delivery via Dev Advance', async (awaitingPhase) => {
    const taskId = 'task-advance-uncertain';
    await seedHolder(taskId, { phase: 'code', signalToken: 'uncertain-token' }, {
      status: 'awaiting_human', awaitingPhase, awaitingReason: 'delivery is uncertain', awaitingNonce: 'uncertain-hold',
    });
    const held = await binding();

    await expect(harness.manager.advanceTask(taskId)).rejects.toMatchObject({
      status: 409, message: expect.stringContaining('Prompt may still be running'),
    });
    await expect(harness.manager.redispatchTaskPromptAfterReplRestart('dev-1', taskId)).resolves.toBe(true);

    expect(await binding()).toEqual(held);
    expect((await harness.taskStore.get(taskId))?.signalToken).toBe('uncertain-token');
    expect(harness.runner.pastedPrompts).toEqual([]);
    expect(harness.events.some(event => event.type === 'task.updated' && event.data.operation === 'advance')).toBe(false);
  });

  it.each(['dirty-workdir', 'restart-redispatch-failed'].flatMap(reason =>
    (['in_progress', 'approved'] as const).map(status => ({ reason, status })),
  ))('invalidates old $reason attention on successful $status replay', async ({ reason, status }) => {
    const taskId = `task-attention-${status}`;
    await seedHolder(taskId, {
      status, phase: 'code', signalToken: 'attention-task-token',
      ...(status === 'approved' ? {
        postApproveGeneration: 'feedfeedfeed', postApproveHeadSha: SHA1,
        postApproveToken: 'attention-post-token', postApprovePhase: 'installed',
      } : {}),
    }, { status: 'awaiting_human', awaitingPhase: reason, awaitingSince: NOW });
    await harness.manager.recordTaskAttention({
      id: '', type: 'human.intervention', timestamp: NOW, projectId: 'proj', agentId: 'dev-1', taskId,
      data: { phase: reason, reason: 'retry the current step' },
    });
    expect((await harness.taskStore.get(taskId))?.attention?.reason).toBe(reason);

    const result = await harness.manager.advanceTask(taskId);

    expect(result.attention).toBeUndefined();
    if (status === 'approved') {
      expect(result.signalToken).toBe('attention-task-token');
      expect(result.postApproveToken).not.toBe('attention-post-token');
    } else {
      expect(result.signalToken).not.toBe('attention-task-token');
    }
    expect((await harness.taskStore.get(taskId))?.attention).toBeUndefined();
    expect((await binding())?.status).toBeUndefined();
    expect(harness.events.filter(event => event.type === 'task.updated' && event.taskId === taskId
      && event.data.operation === 'advance')).toHaveLength(1);
    expect(harness.runner.pastedPrompts).toHaveLength(1);
  });

  it.each([undefined, 'code'] as const)('rejects Dev Advance when the initial %s prompt was already delivered', async (phase) => {
    const taskId = 'task-advance-delivered';
    await seedHolder(taskId, { phase, signalToken: 'delivered-token' }, {
      status: 'awaiting_human',
      awaitingPhase: 'bootstrap-marker-clear-failed',
      bootstrappingTaskId: taskId,
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(harness.manager.advanceTask(taskId)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('already delivered'),
      });
    }

    expect(harness.runner.pastedPrompts).toEqual([]);
    expect((await harness.taskStore.get(taskId))?.signalToken).toBe('delivered-token');
    expect(await binding()).toMatchObject({
      awaitingPhase: 'bootstrap-marker-clear-failed', bootstrappingTaskId: taskId,
    });
    expect(harness.events.some(event => event.type === 'task.updated' && event.data.operation === 'advance')).toBe(false);
  });

  async function seedRevokedTask(id: string): Promise<void> {
    await harness.seedTask({
      id,
      status: 'approved',
      phase: 'code',
      prNumber: 42,
      latestHeadSha: SHA1,
      passProvenance: {
        sourceKey: 'issue-comments',
        id: 'pass-1',
        token: 'abcdef123456',
        failToken: '123456abcdef',
        anchorSha: SHA1,
      },
      postApproveRevoked: {
        generation: 'feedfeedfeed',
        reason: 'redispatch-cap',
        at: NOW,
      },
    });
  }

  it('replays the persisted Dev instruction for an in-progress task', async () => {
    const m = harness.manager;
    await seedHolder('task-advance-dev', { phase: 'code', signalToken: 'advance-token' });

    const result = await m.advanceTask('task-advance-dev', { executor: 'dev', note: 'manual replay' });

    expect(result.status).toBe('in_progress');
    const replayedToken = (await harness.taskStore.get('task-advance-dev'))?.signalToken;
    expect(replayedToken).not.toBe('advance-token');
    expect(harness.runner.pastedPrompts).toEqual([{ pane: '%0', body: expect.stringContaining(`token: ${replayedToken}`) }]);
    expect(harness.events.at(-1)).toMatchObject({
      type: 'task.updated',
      taskId: 'task-advance-dev',
      data: {
        operation: 'advance',
        action: 'dev',
        actor: 'human',
        provenance: 'human',
        note: 'manual replay',
      },
    });
  });

  it('routes a QA advance through the existing delivery and review guard', async () => {
    const m = harness.manager;
    const task = await harness.seedTask({
      id: 'task-advance-qa',
      status: 'fixing',
      phase: 'code',
      signalToken: 'advance-qa-token',
    });
    await harness.seedAgent({ id: 'dev-1', taskId: task.id, paneId: '%0' });
    await harness.seedAgent({ id: 'qa-1', paneId: '%1' });

    const updated = await m.advanceTask(task.id, {
      executor: 'qa',
      stage: 'code',
      prNumber: 42,
    });

    expect(updated).toMatchObject({
      status: 'review',
      prNumber: 42,
      deliveryConfirmation: { phase: 'code', source: 'human' },
    });
    expect(harness.runner.pastedPrompts).toEqual([{ pane: '%1', body: expect.stringContaining(`token: ${updated.signalToken}`) }]);
    expect((await harness.agentStore.get('qa-1'))?.taskId).toBe(task.id);
    expect(harness.events.at(-1)).toMatchObject({
      type: 'task.updated',
      taskId: task.id,
      data: {
        operation: 'advance',
        action: 'qa',
        actor: 'human',
        provenance: 'human',
        note: 'advance:qa',
      },
    });
  });

  it('rejects Review to Dev because only a request-changes verdict may start fixing', async () => {
    const m = harness.manager;
    await harness.seedTask({
      id: 'task-review-to-dev',
      status: 'review',
      phase: 'code',
      signalToken: 'review-token',
    });
    const replay = vi.spyOn(m, 'redispatchTaskPromptAfterReplRestart');

    await expect(m.advanceTask('task-review-to-dev', { executor: 'dev' }))
      .rejects.toMatchObject({ status: 409 });
    expect(replay).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation before restoring a revoked post-approve episode', async () => {
    const m = harness.manager;
    await seedRevokedTask('task-revoked-advance');

    await expect(m.advanceTask('task-revoked-advance', { executor: 'dev' }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('revalidates the accepted head before restoring a revoked post-approve episode', async () => {
    const m = harness.manager;
    await seedRevokedTask('task-restore-revoked');
    vi.spyOn(m, 'platformVerifyPrBinding').mockResolvedValue({
      ok: true,
      prUrl: 'https://github.com/user/repo/pull/42',
      headSha: SHA1,
      branch: 'bx/task-restore-revoked',
      targetBranch: 'main',
    });
    vi.spyOn(m, 'platformVerifyAcceptedPass').mockResolvedValue({
      kind: 'valid',
      pending: new Set(),
    });
    const replay = vi.spyOn(m, 'redispatchTaskPromptAfterReplRestart').mockResolvedValue(true);

    const result = await m.advanceTask('task-restore-revoked', {
      executor: 'dev',
      confirmRevoked: true,
    });

    expect(result.postApproveRevoked).toBeUndefined();
    expect(result.postApproveGeneration).toMatch(/^[0-9a-f]{12}$/);
    expect(result.postApproveToken).toMatch(/^[0-9a-f]{12}$/);
    expect(replay).toHaveBeenCalledWith('dev-1', 'task-restore-revoked');
  });

  it('refuses restoration when accepted-pass provenance changes during remote verification', async () => {
    const m = harness.manager;
    await seedRevokedTask('task-racing-revoked');
    vi.spyOn(m, 'platformVerifyPrBinding').mockResolvedValue({
      ok: true,
      prUrl: 'https://github.com/user/repo/pull/42',
      headSha: SHA1,
      branch: 'bx/task-racing-revoked',
      targetBranch: 'main',
    });
    vi.spyOn(m, 'platformVerifyAcceptedPass').mockImplementation(async () => {
      const fresh = (await harness.taskStore.get('task-racing-revoked'))!;
      await harness.taskStore.set({
        ...fresh,
        passProvenance: { ...fresh.passProvenance!, id: 'r-replaced' },
        updatedAt: new Date().toISOString(),
      });
      return { kind: 'valid', pending: new Set() };
    });
    const replay = vi.spyOn(m, 'redispatchTaskPromptAfterReplRestart');

    await expect(m.advanceTask('task-racing-revoked', {
      executor: 'dev',
      confirmRevoked: true,
    })).rejects.toMatchObject({ status: 409 });

    expect(replay).not.toHaveBeenCalled();
    expect((await harness.taskStore.get('task-racing-revoked'))?.postApproveRevoked)
      .toBeDefined();
  });
});
