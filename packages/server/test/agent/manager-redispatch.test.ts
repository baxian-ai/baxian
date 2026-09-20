import { describe, it, expect, vi } from 'vitest';
import { BranchManager } from '../../src/agent/branch.js';
import type { PaneStreamerManager } from '../../src/agent/pane-streamer-manager.js';
import type { SubscriberCallbacks } from '../../src/agent/pane-streamer.js';
import { buildPhaseSignal, type PhaseSignalKind } from '../../src/agent/phase-signal.js';
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
  async function rotatedTaskToken(taskId: string, oldToken: string): Promise<string> {
    const token = (await harness.taskStore.get(taskId))?.signalToken;
    expect(token).toEqual(expect.any(String));
    expect(token).not.toBe(oldToken);
    return token!;
  }

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

  it('does not replay a delivered bootstrap held on a failed marker clear', async () => {
    const m = harness.manager;
    await seedHolder('task-boot-delivered', { signalToken: 'boot-token-3' }, {
      bootstrappingTaskId: 'task-boot-delivered',
      status: 'awaiting_human',
      awaitingPhase: 'bootstrap-marker-clear-failed',
      awaitingReason: 'marker clear failed after delivery',
      awaitingSince: NOW,
    });

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-boot-delivered')).toBe(true);

    expect(harness.runner.pastedPrompts).toEqual([]);
    expect(harness.runner.exec.mock.calls.some(c => (c[0] as string).includes('tmux'))).toBe(false);
    const state = await binding();
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('restart-redispatch-failed');
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

  it('escalates an own-generation arm failure into the recoverable hold path', async () => {
    const { m } = watchedManager({ onSubscribe: async () => { throw new Error('subscribe transport down'); } });
    await seedHolder('task-arm-fail', { signalToken: 'arm-fail-1' });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-arm-fail')).resolves.toBe(true);

    expect(harness.runner.pastedPrompts).toEqual([]);
    const held = await binding();
    expect(held?.status).toBe('awaiting_human');
    expect(held?.awaitingPhase).toBe('restart-redispatch-failed');
    expect(held?.awaitingReason).toMatch(/failed to arm/);
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
    expect(held?.awaitingReason).toMatch(/replaying the task prompt failed/);
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
