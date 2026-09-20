import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentBindingFacts, BaxianEvent } from '../../src/shared/index.js';
import { AgentManager } from '../../src/agent/manager.js';
import { PhaseSignalWatcher } from '../../src/agent/phase-signal-watcher.js';
import { VisibleTextExtractor } from '../../src/agent/vt-visible-text.js';
import { useManagerSuiteHarness } from '../helpers/manager-harness.js';

const NOW = '2026-05-14T05:00:00.000Z';
const RETRY_MS = 20;

const harness = useManagerSuiteHarness();

describe('AgentManager need-input watermark persistence', () => {
  const commit = (over: Partial<{ agentId: string; taskId: string; epoch: number; askSeq: number; answeredSeq: number }> = {}) =>
    harness.manager.commitNeedInputWatermark({
      agentId: 'dev-1', taskId: 't-wm', epoch: 1, askSeq: 1, answeredSeq: 0, ...over,
    });

  async function seedWatermarkAgent(needInput?: { epoch: number; askSeq?: number; answeredSeq?: number; at?: string }): Promise<void> {
    await harness.seedAgent({ id: 'dev-1', taskId: 't-wm', ...(needInput ? { needInput } : {}) });
  }

  it('fences on taskId and on a stale epoch, in both directions', async () => {
    await seedWatermarkAgent({ epoch: 2 });
    expect(await commit({ taskId: 'other-task' })).toBe('fenced');
    expect(await commit({ epoch: 1, askSeq: 1, answeredSeq: 0 })).toBe('fenced');
    expect(await commit({ epoch: 1, askSeq: 1, answeredSeq: 1 })).toBe('fenced');
    expect((await harness.agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 2 });
  });

  it('merges monotonically within the epoch and derives the badge projection', async () => {
    await seedWatermarkAgent({ epoch: 1 });
    expect(await commit({ askSeq: 1, answeredSeq: 0 })).toBe('ok');
    const lit = (await harness.agentStore.get('dev-1'))?.needInput;
    expect(lit).toMatchObject({ epoch: 1, askSeq: 1, answeredSeq: 0 });
    expect(lit?.at).toBeDefined();

    expect(await commit({ askSeq: 1, answeredSeq: 1 })).toBe('ok');
    const cleared = (await harness.agentStore.get('dev-1'))?.needInput;
    expect(cleared).toEqual({ epoch: 1, askSeq: 1, answeredSeq: 1 });

    expect(await commit({ askSeq: 1, answeredSeq: 0 })).toBe('ok');
    expect((await harness.agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 1, askSeq: 1, answeredSeq: 1 });
  });

  it('writes a tombstone onto an empty same-epoch watermark (first-write-error recovery path)', async () => {
    await seedWatermarkAgent({ epoch: 3 });
    expect(await commit({ epoch: 3, askSeq: 1, answeredSeq: 1 })).toBe('ok');
    expect((await harness.agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 3, askSeq: 1, answeredSeq: 1 });
  });

  // A queued retry shows as one pending interval; a drained queue as none (the cancel must be real).
  describe('retry queue (interval clock)', () => {
    let m: AgentManager;
    const commitOn = (over: Partial<{ epoch: number; askSeq: number; answeredSeq: number }> = {}) =>
      m.commitNeedInputWatermark({ agentId: 'dev-1', taskId: 't-wm', epoch: 1, askSeq: 1, answeredSeq: 0, ...over });
    const tick = () => vi.advanceTimersByTimeAsync(RETRY_MS);

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      m = harness.createManager({ needInputRetryIntervalMs: RETRY_MS });
    });
    afterEach(() => { vi.useRealTimers(); });

    it('queues a failed commit, retries it on the interval, and stops the clock once written', async () => {
      await seedWatermarkAgent({ epoch: 1 });
      vi.spyOn(harness.agentStore, 'update').mockRejectedValueOnce(new Error('store down'));
      expect(await commitOn({ askSeq: 1, answeredSeq: 0 })).toBe('error');
      expect(vi.getTimerCount()).toBe(1);

      await tick();
      await vi.waitFor(async () =>
        expect((await harness.agentStore.get('dev-1'))?.needInput).toMatchObject({ epoch: 1, askSeq: 1, answeredSeq: 0 }));
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
    });

    it('a watermark raised while its retry is in flight is retried again instead of being dropped', async () => {
      await seedWatermarkAgent({ epoch: 1 });
      const real = harness.agentStore.update.bind(harness.agentStore);
      vi.spyOn(harness.agentStore, 'update').mockRejectedValueOnce(new Error('down'));
      expect(await commitOn({ askSeq: 1, answeredSeq: 1 })).toBe('error');

      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      vi.spyOn(harness.agentStore, 'update')
        .mockImplementationOnce((async (id: string, updater: never) => { await gate; return real(id, updater as never); }) as never)
        .mockRejectedValueOnce(new Error('down again'));
      await tick();
      expect(await commitOn({ askSeq: 2, answeredSeq: 1 })).toBe('error');
      release();
      await vi.waitFor(async () =>
        expect((await harness.agentStore.get('dev-1'))?.needInput).toMatchObject({ epoch: 1, askSeq: 1, answeredSeq: 1 }));
      expect(vi.getTimerCount()).toBe(1);

      await tick();
      await vi.waitFor(async () =>
        expect((await harness.agentStore.get('dev-1'))?.needInput).toMatchObject({ epoch: 1, askSeq: 2, answeredSeq: 1 }));
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
    });

    it('drops a queued item whose generation was superseded instead of writing it back', async () => {
      await seedWatermarkAgent({ epoch: 1 });
      vi.spyOn(harness.agentStore, 'update').mockRejectedValueOnce(new Error('down'));
      expect(await commitOn({ askSeq: 1, answeredSeq: 0 })).toBe('error');
      await harness.seedAgent({ id: 'dev-1', taskId: 't-wm', needInput: { epoch: 2 } });

      await tick();
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
      expect((await harness.agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 2 });
    });

    it('a web reply tombstones a queue-only pending ask, and the retry does not relight it', async () => {
      await seedWatermarkAgent({ epoch: 1 });
      vi.spyOn(harness.agentStore, 'update').mockRejectedValueOnce(new Error('down'));
      expect(await commitOn({ askSeq: 1, answeredSeq: 0 })).toBe('error');
      await m.notifyHumanTerminalInput('dev-1');
      expect((await harness.agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 1, askSeq: 1, answeredSeq: 1 });

      await tick();
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
      expect((await harness.agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 1, askSeq: 1, answeredSeq: 1 });
    });
  });

  it('confirmNeedInputAnswered settles the open question from the store', async () => {
    await seedWatermarkAgent({ epoch: 1, askSeq: 2, answeredSeq: 1, at: NOW });
    await harness.manager.notifyHumanTerminalInput('dev-1');
    expect((await harness.agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 1, askSeq: 2, answeredSeq: 2 });
  });

  it('release(waiting) strips the watermark and bumps the epoch on both success branches', async () => {
    const t = await harness.seedTask({ id: 't-wm', status: 'review', signalToken: 'tokRel1234567' });
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      needInput: { epoch: 3, askSeq: 1, answeredSeq: 0, at: NOW },
    });
    await harness.acquireAgentLock('dev-1');
    await harness.manager.releaseAgentForTask('dev-1', t.id, 'waiting');
    expect((await harness.agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 4 });
  });

  it('release(waiting, clearAwaitingHuman) whitelist branch also bumps (restart-repl path)', async () => {
    const t = await harness.seedTask({ id: 't-wm', status: 'review', signalToken: 'tokRel1234567' });
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'agent_dialog_pending', awaitingSince: NOW, awaitingNonce: 'n1',
      needInput: { epoch: 7, askSeq: 2, answeredSeq: 1, at: NOW },
    });
    await harness.acquireAgentLock('dev-1');
    await harness.manager.releaseAgentForTask('dev-1', t.id, 'waiting', {
      allowAwaitingHuman: true,
      clearAwaitingHuman: true,
      expectedHold: { phase: 'agent_dialog_pending', since: NOW, nonce: 'n1' },
    });
    const binding = await harness.agentStore.get('dev-1');
    expect(binding?.status).toBeUndefined();
    expect(binding?.needInput).toEqual({ epoch: 8 });
  });

  it('a stale-generation write after the release gate fences instead of relighting', async () => {
    const t = await harness.seedTask({ id: 't-wm', status: 'review', signalToken: 'tokRel1234567' });
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      needInput: { epoch: 3, askSeq: 1, answeredSeq: 0, at: NOW },
    });
    await harness.acquireAgentLock('dev-1');
    await harness.manager.releaseAgentForTask('dev-1', t.id, 'waiting');
    expect(await commit({ epoch: 3, askSeq: 1, answeredSeq: 0 })).toBe('fenced');
    expect((await harness.agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 4 });
  });
});

describe('AgentManager need-input cross-layer (real watcher)', () => {
  interface CrossStreamer {
    subscribeAtomic: (cbs: { onVisible: (data: string) => void; onSessionGone: () => void }) => Promise<{
      snapshot: { data: string };
      unsubscribe: () => void;
    }>;
    triggerLive: (data: string) => void;
    triggerSessionGone: () => void;
    failNextSubscribe: () => void;
    holdNextSubscribe: () => { release: () => void };
    setSnapshotData: (data: string) => void;
  }

  beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); });
  afterEach(() => { vi.useRealTimers(); });
  const tick = () => vi.advanceTimersByTimeAsync(RETRY_MS);

  function makeCrossLayer(): {
    m: AgentManager; streamer: CrossStreamer; captured: BaxianEvent[]; watcher: PhaseSignalWatcher;
  } {
    const lives: Array<(data: string) => void> = [];
    const gones: Array<() => void> = [];
    const decoder = new VisibleTextExtractor();
    let failNext = false;
    const holdQueue: Promise<void>[] = [];
    let snapshotData = '';
    const streamer: CrossStreamer = {
      subscribeAtomic: async (cbs) => {
        if (failNext) {
          failNext = false;
          throw new Error('subscribe transport down');
        }
        const gate = holdQueue.shift();
        if (gate) await gate;
        lives.push(cbs.onVisible);
        gones.push(cbs.onSessionGone);
        return { snapshot: { data: snapshotData }, unsubscribe: () => undefined };
      },
      triggerLive: (data) => {
        const visible = decoder.write(data);
        for (const fn of [...lives]) fn(visible);
      },
      triggerSessionGone: () => { for (const fn of [...gones]) fn(); },
      failNextSubscribe: () => { failNext = true; },
      holdNextSubscribe: () => {
        let release!: () => void;
        holdQueue.push(new Promise<void>(resolve => { release = resolve; }));
        return { release };
      },
      setSnapshotData: (data) => { snapshotData = data; },
    };
    const captured: BaxianEvent[] = [];
    const paneStreamerManager = { ensure: () => streamer } as never;
    const eventBus = {
      emit: async (event: BaxianEvent) => { captured.push(event); },
      subscribe: () => () => undefined,
    } as never;
    const owner: { m?: AgentManager } = {};
    const watcher = new PhaseSignalWatcher({
      paneStreamerManager,
      eventBus,
      resolveAgent: (id) => owner.m!.getAgentConfig(id),
      commitNeedInputWatermark: (intent) => owner.m!.commitNeedInputWatermark(intent),
      spawnTask: (intent) => owner.m!.spawnTaskFromSignal(intent),
    });
    const m = harness.createManager({ paneStreamerManager, eventBus, phaseSignalWatcher: watcher, needInputRetryIntervalMs: RETRY_MS });
    owner.m = m;
    return { m, streamer, captured, watcher };
  }

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
  };
  const waitForNeedInput = (
    expected: Partial<NonNullable<AgentBindingFacts['needInput']>>,
  ): Promise<void> => vi.waitFor(async () =>
    expect((await harness.agentStore.get('dev-1'))?.needInput).toMatchObject(expected));

  // E1: 武装/重装的交错矩阵(旧 token 抢占、bump 与 subscribe 之间的落定顺序、preparedReplay 的认领)没有任何
  // 公共入口能按用例要求的时序逐点触发 —— 派单入口只会走 fresh/replay 两条固定组合。这里只用它触发,
  // 断言全部落在 agentStore 的水位、watcher.has/claimArm 与事件上。
  const armVia = (
    m: AgentManager,
    token: string,
    opts: Record<string, unknown> = {},
  ): Promise<boolean> =>
    (m as never as {
      setupPhaseSignalWatcher: (
        taskId: string, agentId: string, kinds: readonly string[], token: string, opts: Record<string, unknown>,
      ) => Promise<boolean>;
    }).setupPhaseSignalWatcher('t-xl', 'dev-1', ['pr-created'], token, opts);

  async function queueViaFailedCommit(
    m: AgentManager, epoch: number, askSeq: number, answeredSeq: number,
  ): Promise<void> {
    const spy = vi.spyOn(harness.agentStore, 'update').mockRejectedValueOnce(new Error('store down'));
    expect(await m.commitNeedInputWatermark({ agentId: 'dev-1', taskId: 't-xl', epoch, askSeq, answeredSeq })).toBe('error');
    spy.mockRestore();
  }

  async function seedCross(needInput?: AgentBindingFacts['needInput']): Promise<void> {
    await harness.seedTask({ id: 't-xl', status: 'in_progress', signalToken: 'tokXL12345678' });
    await harness.seedAgent({ id: 'dev-1', taskId: 't-xl', paneId: '%0', ...(needInput ? { needInput } : {}) });
  }

  it.each(['return', 'throw'] as const)(
    'releases a replay hand-off claim when continueSession exits before arm (%s)',
    async (outcome) => {
      const { m, watcher } = makeCrossLayer();
      const oldToken = 'tokXL12345678';
      await seedCross();
      expect(await armVia(m, oldToken, { needInputMode: 'fresh' })).toBe(true);
      // E2: 「派单在武装之前就以 false 收场」是状态机内部的放弃分支(没有任何 tmux/git 故障能造出它);
      // throw 这一行用真实的 tmux 会话易主造出来。
      if (outcome === 'return') vi.spyOn(m, 'continueSession').mockResolvedValue(false);
      else harness.runner.sessions.seed('dev-1', { claim: 'someone-else' });

      expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 't-xl')).toBe(true);

      const newToken = (await harness.taskStore.get('t-xl'))!.signalToken!;
      expect(newToken).not.toBe(oldToken);
      expect(watcher.has('t-xl', 'dev-1')).toBe(false);
      expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBe('restart-redispatch-failed');
      const successorClaim = watcher.claimArm({
        taskId: 't-xl', agentId: 'dev-1', token: 'successor12345', replaceFromToken: newToken,
        onlyReplaceOwnToken: true, replaceScope: 'agent',
      });
      expect(successorClaim).not.toBeNull();
      watcher.releaseArm(successorClaim);
    },
  );

  it('rejects a conflicting pending hand-off before rotating persistent task state', async () => {
    const { m, watcher } = makeCrossLayer();
    const oldToken = 'tokXL12345678';
    await seedCross();
    expect(await armVia(m, oldToken, { needInputMode: 'fresh' })).toBe(true);
    const blocker = watcher.claimArm({
      taskId: 't-xl', agentId: 'dev-1', token: 'blocker123456', replaceFromToken: oldToken,
      onlyReplaceOwnToken: true, replaceScope: 'agent',
    });
    expect(blocker).not.toBeNull();
    const setSpy = vi.spyOn(harness.taskStore, 'set');

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 't-xl')).toBe(false);

    expect((await harness.taskStore.get('t-xl'))?.signalToken).toBe(oldToken);
    expect(setSpy).not.toHaveBeenCalled();
    // 冲突在旋转持久状态之前就挡住了:没有任何提示词被投出去
    expect(harness.runner.pastedPrompts).toEqual([]);
    expect(watcher.has('t-xl', 'dev-1')).toBe(true);
    watcher.releaseArm(blocker);
  });

  it.each(['installed', 'subscribe-failed'] as const)(
    'releases the replay claim after watcher start settles (%s)',
    async (outcome) => {
      const { m, streamer, watcher } = makeCrossLayer();
      const oldToken = 'tokXL12345678';
      await seedCross();
      expect(await armVia(m, oldToken, { needInputMode: 'fresh' })).toBe(true);
      if (outcome === 'subscribe-failed') streamer.failNextSubscribe();

      expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 't-xl')).toBe(true);

      const newToken = (await harness.taskStore.get('t-xl'))!.signalToken!;
      expect(watcher.has('t-xl', 'dev-1')).toBe(outcome === 'installed');
      const successorClaim = watcher.claimArm({
        taskId: 't-xl', agentId: 'dev-1', token: 'successor67890', replaceFromToken: newToken,
        onlyReplaceOwnToken: true, replaceScope: 'agent',
      });
      expect(successorClaim).not.toBeNull();
      watcher.releaseArm(successorClaim);
    },
  );

  it('restore re-arm persists the merged watermark so an error-queued answer cannot re-stick the badge', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);

    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await waitForNeedInput({ epoch: 1, askSeq: 1, answeredSeq: 0 });

    const real = harness.agentStore.update.bind(harness.agentStore);
    const spy = vi.spyOn(harness.agentStore, 'update').mockRejectedValueOnce(new Error('store down'));
    streamer.triggerLive('[bx:input-received:tokXL12345678:1]\n');
    await flush();
    spy.mockImplementation(real as never);
    expect((await harness.agentStore.get('dev-1'))?.needInput?.at).toBeDefined();

    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'restore', onlyReplaceOwnToken: true })).toBe(true);
    await flush();
    const wm = (await harness.agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 2, askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
  });

  it('a fresh same-token replay does not inherit old ordinals, so the new prompt lights from 1', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);
    streamer.triggerLive('[bx:need-input:tokXL12345678:3]\n');
    await waitForNeedInput({ epoch: 1, askSeq: 3 });

    expect(await armVia(m, 'tokXL12345678', {
      needInputMode: 'fresh', skipSnapshot: true, onlyReplaceOwnToken: true,
    })).toBe(true);
    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await flush();
    const wm = (await harness.agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 2, askSeq: 1, answeredSeq: 0 });
    expect(wm?.at).toBeDefined();
  });

  it('an own-token-fenced arm neither bumps the epoch nor fences the surviving watcher', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);
    const epochBefore = (await harness.agentStore.get('dev-1'))?.needInput?.epoch;

    expect(await armVia(m, 'tokOTHER123456', {
      needInputMode: 'fresh', onlyReplaceOwnToken: true,
    })).toBe(false);
    expect((await harness.agentStore.get('dev-1'))?.needInput?.epoch).toBe(epochBefore);

    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await waitForNeedInput({ epoch: 1, askSeq: 1, answeredSeq: 0 });
  });

  it('a failed re-subscribe migrates the surviving entry onto the bumped generation', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);

    streamer.failNextSubscribe();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'restore', onlyReplaceOwnToken: true })).toBe(false);
    expect((await harness.agentStore.get('dev-1'))?.needInput?.epoch).toBe(2);

    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await waitForNeedInput({ epoch: 2, askSeq: 1, answeredSeq: 0 });
  });

  it('a failed epoch bump arms with the badge disabled instead of ghost-fencing (watch survives)', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross({ epoch: 5 });
    const real = harness.agentStore.update.bind(harness.agentStore);
    const spy = vi.spyOn(harness.agentStore, 'update').mockRejectedValueOnce(new Error('store down'));
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);
    spy.mockImplementation(real as never);

    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await flush();
    expect((await harness.agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 5 });

    expect(await armVia(m, 'tokXL12345678', {
      needInputMode: 'fresh', skipSnapshot: true, onlyReplaceOwnToken: true,
    })).toBe(true);
    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await waitForNeedInput({ epoch: 6, askSeq: 1, answeredSeq: 0 });
  });

  it('restore migrates an answer whose write is still in flight when the entry already exited', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);
    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await waitForNeedInput({ epoch: 1, askSeq: 1, answeredSeq: 0 });

    const real = harness.agentStore.update.bind(harness.agentStore);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(harness.agentStore, 'update').mockImplementationOnce(
      (async (_id: string, _updater: never) => {
        await gate;
        throw new Error('store down');
      }) as never,
    );
    streamer.triggerLive('[bx:input-received:tokXL12345678:1]\n');
    streamer.triggerSessionGone();
    spy.mockImplementation(real as never);

    const armP = armVia(m, 'tokXL12345678', { needInputMode: 'restore', skipSnapshot: true });
    release();
    expect(await armP).toBe(true);
    await flush();
    const wm = (await harness.agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 2, askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an answer arriving after the bump updater ran but before its write settled is lifted to the new epoch', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);
    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await flush();

    const real = harness.agentStore.update.bind(harness.agentStore);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let failAnswer!: () => void;
    const answerFailure = new Promise<void>(resolve => { failAnswer = resolve; });
    const spy = vi.spyOn(harness.agentStore, 'update')
      .mockImplementationOnce((async (id: string, updater: never) => {
        const result = await real(id, updater as never);
        await gate;
        return result;
      }) as never)
      .mockImplementationOnce((async () => {
        await answerFailure;
        throw new Error('store down');
      }) as never);
    const armP = armVia(m, 'tokXL12345678', { needInputMode: 'restore', skipSnapshot: true });
    await waitForNeedInput({ epoch: 2 });
    streamer.triggerLive('[bx:input-received:tokXL12345678:1]\n');
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    streamer.triggerSessionGone();
    release();
    expect(await armP).toBe(true);
    spy.mockRestore();
    failAnswer();
    await flush();
    await tick();

    await vi.waitFor(async () => {
      const wm = (await harness.agentStore.get('dev-1'))?.needInput;
      expect(wm).toMatchObject({ epoch: 2, askSeq: 1, answeredSeq: 1 });
      expect(wm?.at).toBeUndefined();
    });
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
  });

  it('an answer consumed between the restore bump and the replacement subscribe still clears the badge', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);
    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await waitForNeedInput({ epoch: 1, askSeq: 1, answeredSeq: 0 });

    const gate = streamer.holdNextSubscribe();
    const armP = armVia(m, 'tokXL12345678', { needInputMode: 'restore', skipSnapshot: true });
    await waitForNeedInput({ epoch: 2 });
    streamer.triggerLive('[bx:input-received:tokXL12345678:1]\n');
    await flush();
    streamer.triggerSessionGone();
    gate.release();
    expect(await armP).toBe(true);
    await flush();

    const wm = (await harness.agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 2, askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
  });

  it('restore migrates an answer that starts while the bump is queued in the store chain', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);
    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await waitForNeedInput({ epoch: 1, askSeq: 1, answeredSeq: 0 });

    const real = harness.agentStore.update.bind(harness.agentStore);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(harness.agentStore, 'update').mockImplementation(
      (async (id: string, updater: never) => {
        await gate;
        return real(id, updater as never);
      }) as never,
    );
    const armP = armVia(m, 'tokXL12345678', { needInputMode: 'restore', skipSnapshot: true });
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    streamer.triggerLive('[bx:input-received:tokXL12345678:1]\n');
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    streamer.triggerSessionGone();
    release();
    expect(await armP).toBe(true);
    spy.mockRestore();
    await flush();

    const wm = (await harness.agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 2, askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
  });

  it('the ledger holds the intent until an error is queued, so a racing restore never misses it', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);
    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await flush();

    const real = harness.agentStore.update.bind(harness.agentStore);
    const failing = Promise.reject(new Error('store down'));
    failing.catch(() => undefined);
    const spy = vi.spyOn(harness.agentStore, 'update').mockImplementationOnce((() => failing) as never);
    streamer.triggerLive('[bx:input-received:tokXL12345678:1]\n');
    streamer.triggerSessionGone();
    spy.mockImplementation(real as never);
    const armP = failing.catch(() => undefined).then(() =>
      armVia(m, 'tokXL12345678', { needInputMode: 'restore', skipSnapshot: true }));
    expect(await armP).toBe(true);
    await flush();
    const wm = (await harness.agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 2, askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
  });

  it('web input does not confirm an ask that lands while the clear write is still in flight', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);
    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await waitForNeedInput({ epoch: 1, askSeq: 1, answeredSeq: 0 });

    const real = harness.agentStore.update.bind(harness.agentStore);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(harness.agentStore, 'update').mockImplementationOnce(
      (async (id: string, updater: never) => {
        await gate;
        return real(id, updater);
      }) as never,
    );
    const notifyP = m.notifyHumanTerminalInput('dev-1');
    streamer.triggerLive('[bx:need-input:tokXL12345678:2]\n');
    release();
    await notifyP;
    spy.mockRestore();
    await flush();

    const wmAfter = (await harness.agentStore.get('dev-1'))?.needInput;
    expect(wmAfter).toMatchObject({ epoch: 1, askSeq: 2, answeredSeq: 1 });
    expect(wmAfter?.at).toBeDefined();
  });

  it('recovers an offline current-token answer while ignoring old-token replay history', async () => {
    const { m, streamer, watcher } = makeCrossLayer();
    await seedCross();
    const oldToken = 'tokOLD1234567';
    const newToken = 'tokNEW1234567';
    expect(await armVia(m, oldToken, { needInputMode: 'fresh' })).toBe(true);
    streamer.triggerLive(`[bx:need-input:${oldToken}:1]\n`);
    await flush();

    expect(await armVia(m, newToken, {
      needInputMode: 'fresh', skipSnapshot: true, onlyReplaceOwnToken: true,
      replaceFromToken: oldToken, replaceScope: 'agent',
    })).toBe(true);
    streamer.triggerLive(`[bx:need-input:${newToken}:1]\n`);
    await waitForNeedInput({ askSeq: 1, answeredSeq: 0 });

    watcher.stopAgent('t-xl', 'dev-1');
    streamer.setSnapshotData(
      `old [bx:need-input:${oldToken}:1] old [bx:input-received:${oldToken}:1] `
      + `current [bx:need-input:${newToken}:1] offline [bx:input-received:${newToken}:1]`,
    );
    expect(await armVia(m, newToken, { needInputMode: 'restore' })).toBe(true);
    await flush();
    const wm = (await harness.agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
  });

  it('a rotated token is unaffected by an earlier token\'s replay history', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokOLD1234567', { needInputMode: 'fresh' })).toBe(true);
    streamer.triggerLive('[bx:need-input:tokOLD1234567:1]\n');
    await flush();
    expect(await armVia(m, 'tokOLD1234567', {
      needInputMode: 'fresh', skipSnapshot: true, onlyReplaceOwnToken: true,
    })).toBe(true);

    expect(await armVia(m, 'tokNEW1234567', { needInputMode: 'fresh', skipSnapshot: true })).toBe(true);
    streamer.triggerLive('[bx:need-input:tokNEW1234567:1]\n');
    await flush();
    expect((await harness.agentStore.get('dev-1'))?.needInput?.at).toBeDefined();

    streamer.setSnapshotData(
      'answered [bx:input-received:tokNEW1234567:1] old token noise '
      + '[bx:need-input:tokOLD1234567:1] current [bx:need-input:tokNEW1234567:1]',
    );
    expect(await armVia(m, 'tokNEW1234567', { needInputMode: 'restore' })).toBe(true);
    await flush();
    const wm = (await harness.agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
  });

  it('a rotated fresh replay is not relit by the predecessor token left in a later snapshot', async () => {
    const { m, streamer, watcher } = makeCrossLayer();
    await seedCross();
    const oldToken = 'tokOLD1234567';
    const newToken = 'tokNEW1234567';
    expect(await armVia(m, oldToken, { needInputMode: 'fresh' })).toBe(true);
    streamer.triggerLive(`[bx:need-input:${oldToken}:1]\n`);
    await flush();
    expect((await harness.agentStore.get('dev-1'))?.needInput?.at).toBeDefined();

    expect(await armVia(m, newToken, {
      needInputMode: 'fresh', skipSnapshot: true, onlyReplaceOwnToken: true,
      replaceFromToken: oldToken, replaceScope: 'agent',
    })).toBe(true);
    expect((await harness.agentStore.get('dev-1'))?.needInput).toMatchObject({ askSeq: 0, answeredSeq: 0 });

    watcher.stopAgent('t-xl', 'dev-1');
    streamer.setSnapshotData(`stale scrollback [bx:need-input:${oldToken}:1]`);
    expect(await armVia(m, newToken, { needInputMode: 'restore' })).toBe(true);
    await flush();
    const wm = (await harness.agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ askSeq: 0, answeredSeq: 0 });
    expect(wm?.at).toBeUndefined();
  });

  it('web input falls back to the store when only another task has a live watcher', async () => {
    const { m, streamer, watcher } = makeCrossLayer();
    await seedCross({ epoch: 1, askSeq: 1, answeredSeq: 0, at: NOW });
    await watcher.start({
      taskId: 'old-task', projectId: 'proj', agentId: 'dev-1',
      expectedKinds: 'pr-created', token: 'tokOLD1234567',
      needInput: { epoch: 1, askSeq: 0, answeredSeq: 0 },
    });
    streamer.triggerLive('');

    await m.notifyHumanTerminalInput('dev-1');
    const wm = (await harness.agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 1, askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
  });

  it('recovers an offline reply AND the follow-up question the agent asked next', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross({ epoch: 1, askSeq: 1, answeredSeq: 0, at: NOW });
    streamer.setSnapshotData(
      'replied during downtime [bx:input-received:tokXL12345678:1] '
      + 'then asked again [bx:need-input:tokXL12345678:2]',
    );
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'restore' })).toBe(true);
    await flush();
    const wm = (await harness.agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 2, askSeq: 2, answeredSeq: 1 });
    expect(wm?.at).toBeDefined();
  });

  it('read-back after a failed bump also picks up questions owed by the retry queue', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross({ epoch: 1, askSeq: 1, answeredSeq: 1 });
    await queueViaFailedCommit(m, 1, 2, 1);
    const real = harness.agentStore.update.bind(harness.agentStore);
    const spy = vi.spyOn(harness.agentStore, 'update').mockRejectedValueOnce(new Error('store down'));
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'restore', skipSnapshot: true })).toBe(true);
    spy.mockImplementation(real as never);

    streamer.triggerLive('[bx:input-received:tokXL12345678:2]\n');
    await flush();
    const wm = (await harness.agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 1, askSeq: 2, answeredSeq: 2 });
    expect(wm?.at).toBeUndefined();
  });

  it('recovers an offline reply: restore arm consumes the seq-matched answer from the snapshot', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross({ epoch: 1, askSeq: 1, answeredSeq: 0, at: NOW });
    streamer.setSnapshotData(`replied during downtime [bx:input-received:tokXL12345678:1]`);
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'restore' })).toBe(true);
    await flush();
    const wm = (await harness.agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 2, askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
  });

  it('restore re-arm after session-gone merges the queued answer watermark before clearing the queue', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);

    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await waitForNeedInput({ epoch: 1, askSeq: 1, answeredSeq: 0 });

    const real = harness.agentStore.update.bind(harness.agentStore);
    const spy = vi.spyOn(harness.agentStore, 'update').mockRejectedValueOnce(new Error('store down'));
    streamer.triggerLive('[bx:input-received:tokXL12345678:1]\n');
    await flush();
    spy.mockImplementation(real as never);
    streamer.triggerSessionGone();
    await flush();
    expect((await harness.agentStore.get('dev-1'))?.needInput?.at).toBeDefined();

    expect(await armVia(m, 'tokXL12345678', {
      needInputMode: 'restore', skipSnapshot: true,
    })).toBe(true);
    const wm = (await harness.agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 2, askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
  });

  it('a superseded older-generation intent is not transplanted onto the restore watermark', async () => {
    const { m } = makeCrossLayer();
    await seedCross({ epoch: 5, askSeq: 0, answeredSeq: 0 });
    await queueViaFailedCommit(m, 3, 2, 0);

    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'restore', skipSnapshot: true })).toBe(true);
    await flush();
    const wm = (await harness.agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 6, askSeq: 0, answeredSeq: 0 });
    expect(wm?.at).toBeUndefined();
  });

  it('a fully degraded restore keeps the pending question in memory until a later arm persists it', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);
    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await flush();
    expect((await harness.agentStore.get('dev-1'))?.needInput?.at).toBeDefined();

    const realUpdate = harness.agentStore.update.bind(harness.agentStore);
    const realGet = harness.agentStore.get.bind(harness.agentStore);
    const updateSpy = vi.spyOn(harness.agentStore, 'update').mockRejectedValueOnce(new Error('store down'));
    const getSpy = vi.spyOn(harness.agentStore, 'get').mockRejectedValueOnce(new Error('store down'));
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'restore', skipSnapshot: true })).toBe(true);
    updateSpy.mockImplementation(realUpdate as never);
    getSpy.mockImplementation(realGet as never);

    streamer.triggerLive('[bx:input-received:tokXL12345678:1]\n');
    await flush();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'restore', skipSnapshot: true })).toBe(true);
    await flush();
    const wm = (await harness.agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
  });

  it('an external terminal reply still clears the badge when the restore bump failed', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross({ epoch: 1, askSeq: 1, answeredSeq: 0, at: NOW });
    const real = harness.agentStore.update.bind(harness.agentStore);
    const spy = vi.spyOn(harness.agentStore, 'update').mockRejectedValueOnce(new Error('store down'));
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'restore', skipSnapshot: true })).toBe(true);
    spy.mockImplementation(real as never);

    streamer.triggerLive('[bx:input-received:tokXL12345678:1]\n');
    await flush();
    const wm = (await harness.agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 1, askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
  });

  it('a failed restore bump keeps owed retry intents instead of dropping them', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross({ epoch: 1, askSeq: 1, answeredSeq: 0, at: NOW });
    await queueViaFailedCommit(m, 1, 1, 1);
    const real = harness.agentStore.update.bind(harness.agentStore);
    const spy = vi.spyOn(harness.agentStore, 'update').mockRejectedValueOnce(new Error('store down'));
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'restore', skipSnapshot: true })).toBe(true);
    spy.mockImplementation(real as never);
    expect(vi.getTimerCount()).toBe(1);

    await tick();
    await vi.waitFor(async () => {
      const wm = (await harness.agentStore.get('dev-1'))?.needInput;
      expect(wm).toMatchObject({ epoch: 1, askSeq: 1, answeredSeq: 1 });
      expect(wm?.at).toBeUndefined();
    });
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
    streamer.triggerLive('[bx:need-input:tokXL12345678:2]\n');
    await waitForNeedInput({ epoch: 1, askSeq: 2, answeredSeq: 1 });
  });

  it('web input clears a lit store even when the arm degraded on a bump error', async () => {
    const { m } = makeCrossLayer();
    await seedCross({ epoch: 1, askSeq: 1, answeredSeq: 0, at: NOW });
    const real = harness.agentStore.update.bind(harness.agentStore);
    const spy = vi.spyOn(harness.agentStore, 'update').mockRejectedValueOnce(new Error('store down'));
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'restore' })).toBe(true);
    spy.mockImplementation(real as never);

    await m.notifyHumanTerminalInput('dev-1');
    const wm = (await harness.agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 1, askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
  });

  it('a late-settling foreign-token arm cannot demote the successor generation', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokOLD1234567', { needInputMode: 'fresh' })).toBe(true);

    const gate = streamer.holdNextSubscribe();
    const lateP = armVia(m, 'tokOLD1234567', {
      needInputMode: 'fresh', skipSnapshot: true, onlyReplaceOwnToken: true,
    });
    await waitForNeedInput({ epoch: 2 });
    expect(await armVia(m, 'tokNEW1234567', { needInputMode: 'fresh', skipSnapshot: true })).toBe(true);
    expect((await harness.agentStore.get('dev-1'))?.needInput?.epoch).toBe(3);

    gate.release();
    expect(await lateP).toBe(false);

    streamer.triggerLive('[bx:need-input:tokNEW1234567:1]\n');
    await waitForNeedInput({ epoch: 3, askSeq: 1, answeredSeq: 0 });
  });

  it('a stale replay cannot evict a current-token pass whose subscribe is still pending', async () => {
    const { m, streamer, captured } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokOLD1234567', { needInputMode: 'fresh' })).toBe(true);

    const successorGate = streamer.holdNextSubscribe();
    const successorP = armVia(m, 'tokNEW1234567', { needInputMode: 'fresh', skipSnapshot: true });
    await waitForNeedInput({ epoch: 2 });
    const staleP = armVia(m, 'tokOLD1234567', {
      needInputMode: 'fresh', skipSnapshot: true, onlyReplaceOwnToken: true,
    });
    expect(await staleP).toBe(false);
    expect((await harness.agentStore.get('dev-1'))?.needInput?.epoch).toBe(2);
    successorGate.release();
    expect(await successorP).toBe(true);
    await flush();

    streamer.triggerLive('[bx:need-input:tokNEW1234567:1]\n');
    await flush();
    const wm = (await harness.agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 2, askSeq: 1, answeredSeq: 0 });
    expect(wm?.at).toBeDefined();
    streamer.triggerLive('[bx:pr-created:7:tokNEW1234567]\n');
    await flush();
    expect(captured.some(e => e.type === 'pr.created')).toBe(true);
  });

  it('a late restore does not re-enable a degraded fresh successor onto its stale watermark', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);
    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    streamer.triggerLive('[bx:need-input:tokXL12345678:2]\n');
    await waitForNeedInput({ epoch: 1, askSeq: 2, answeredSeq: 0 });

    const gate = streamer.holdNextSubscribe();
    const restoreP = armVia(m, 'tokXL12345678', {
      needInputMode: 'restore', skipSnapshot: true, onlyReplaceOwnToken: true,
    });
    await waitForNeedInput({ epoch: 2 });
    const real = harness.agentStore.update.bind(harness.agentStore);
    const spy = vi.spyOn(harness.agentStore, 'update').mockRejectedValueOnce(new Error('store down'));
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh', skipSnapshot: true })).toBe(true);
    spy.mockImplementation(real as never);
    gate.release();
    expect(await restoreP).toBe(false);
    await flush();

    const before = (await harness.agentStore.get('dev-1'))?.needInput;
    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await flush();
    expect((await harness.agentStore.get('dev-1'))?.needInput).toEqual(before);
  });

  it('a stale replay whose bump lags a new-token arm cannot ghost-fence the successor', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokOLD1234567', { needInputMode: 'fresh' })).toBe(true);

    const real = harness.agentStore.update.bind(harness.agentStore);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(harness.agentStore, 'update').mockImplementationOnce(
      (async (id: string, updater: never) => {
        await gate;
        return real(id, updater as never);
      }) as never,
    );
    const staleP = armVia(m, 'tokOLD1234567', {
      needInputMode: 'fresh', skipSnapshot: true, onlyReplaceOwnToken: true,
    });
    const successorP = armVia(m, 'tokNEW1234567', { needInputMode: 'fresh', skipSnapshot: true });
    release();
    await staleP;
    expect(await successorP).toBe(true);
    spy.mockRestore();
    await flush();

    streamer.triggerLive('[bx:need-input:tokNEW1234567:1]\n');
    await flush();
    const wm = (await harness.agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ askSeq: 1, answeredSeq: 0 });
    expect(wm?.at).toBeDefined();
  });

  it('a late arm cannot resurrect on a dead generation after the successor fired and exited', async () => {
    const { m, streamer, watcher } = makeCrossLayer();
    await seedCross();

    const gate = streamer.holdNextSubscribe();
    const lateP = armVia(m, 'tokOLD1234567', { needInputMode: 'fresh', skipSnapshot: true });
    await waitForNeedInput({ epoch: 1 });

    expect(await armVia(m, 'tokNEW1234567', { needInputMode: 'fresh', skipSnapshot: true })).toBe(true);
    expect((await harness.agentStore.get('dev-1'))?.needInput?.epoch).toBe(2);
    streamer.triggerLive('[bx:pr-created:7:tokNEW1234567]\n');
    await flush();
    expect(watcher.has('t-xl', 'dev-1')).toBe(false);

    gate.release();
    expect(await lateP).toBe(false);
    expect(watcher.has('t-xl', 'dev-1')).toBe(false);

    streamer.triggerLive('[bx:need-input:tokOLD1234567:1]\n');
    await flush();
    expect((await harness.agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 2, askSeq: 0, answeredSeq: 0 });
  });

  it('a late-settling same-token arm cannot replace the successor entry', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);

    const gate = streamer.holdNextSubscribe();
    const lateP = armVia(m, 'tokXL12345678', {
      needInputMode: 'restore', skipSnapshot: true, onlyReplaceOwnToken: true,
    });
    await waitForNeedInput({ epoch: 2 });
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh', skipSnapshot: true })).toBe(true);
    expect((await harness.agentStore.get('dev-1'))?.needInput?.epoch).toBe(3);

    gate.release();
    expect(await lateP).toBe(false);

    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await waitForNeedInput({ epoch: 3, askSeq: 1, answeredSeq: 0 });
  });

  it('arming for a task the agent is not bound to leaves the foreign binding\'s watermark untouched', async () => {
    const { m } = makeCrossLayer();
    await harness.seedTask({ id: 't-xl', status: 'in_progress', signalToken: 'tokXL12345678' });
    await harness.seedAgent({ id: 'dev-1', taskId: 'other-task', paneId: '%0', needInput: { epoch: 9 } });
    await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' });
    expect((await harness.agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 9 });
  });
});
