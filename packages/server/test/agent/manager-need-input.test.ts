import { describe, it, expect, vi } from 'vitest';
import type { AgentBindingFacts, BaxianEvent } from '../../src/shared/index.js';
import { AgentManager, type ContinueSessionOpts } from '../../src/agent/manager.js';
import { VisibleTextExtractor } from '../../src/agent/vt-visible-text.js';
import { useManagerSuiteHarness } from '../helpers/manager-harness.js';

const NOW = '2026-05-14T05:00:00.000Z';

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

  it('bump(fresh) strips seqs, bump(restore) carries them; both advance the epoch', async () => {
    await seedWatermarkAgent({ epoch: 4, askSeq: 2, answeredSeq: 1, at: NOW });
    const restored = await harness.manager['bumpNeedInputEpochForArm']('dev-1', 't-wm', 'restore');
    expect(restored).toEqual({ wm: { epoch: 5, askSeq: 2, answeredSeq: 1 }, bumped: true });
    expect((await harness.agentStore.get('dev-1'))?.needInput).toMatchObject({ epoch: 5, askSeq: 2, answeredSeq: 1 });
    expect((await harness.agentStore.get('dev-1'))?.needInput?.at).toBeDefined();

    const fresh = await harness.manager['bumpNeedInputEpochForArm']('dev-1', 't-wm', 'fresh');
    expect(fresh).toEqual({ wm: { epoch: 6, askSeq: 0, answeredSeq: 0 }, bumped: true });
    expect((await harness.agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 6, askSeq: 0, answeredSeq: 0 });
  });

  it('bump refuses to touch a foreign-task binding and reports no generation', async () => {
    await harness.seedAgent({ id: 'dev-1', taskId: 'other-task', needInput: { epoch: 9 } });
    const wm = await harness.manager['bumpNeedInputEpochForArm']('dev-1', 't-wm', 'fresh');
    expect(wm).toEqual({ wm: null, bumped: false });
    expect((await harness.agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 9 });
  });

  it('queues a failed commit and converges it on the retry pass', async () => {
    await seedWatermarkAgent({ epoch: 1 });
    const real = harness.agentStore.update.bind(harness.agentStore);
    const failing = vi.spyOn(harness.agentStore, 'update').mockRejectedValueOnce(new Error('store down'));
    expect(await commit({ askSeq: 1, answeredSeq: 0 })).toBe('error');
    failing.mockImplementation(real as never);
    await harness.manager['needInputRetryPass']();
    expect((await harness.agentStore.get('dev-1'))?.needInput).toMatchObject({ epoch: 1, askSeq: 1, answeredSeq: 0 });
    expect(harness.manager['needInputRetry'].size).toBe(0);
  });

  it('keeps a queued item that was raised mid-retry (snapshot-conditional dequeue)', async () => {
    await seedWatermarkAgent({ epoch: 1 });
    vi.spyOn(harness.agentStore, 'update').mockRejectedValueOnce(new Error('down'));
    expect(await commit({ askSeq: 1, answeredSeq: 1 })).toBe('error');
    const key = harness.manager['needInputRetryKey']('dev-1', 't-wm', 1);
    expect(harness.manager['needInputRetry'].get(key)).toEqual({ askSeq: 1, answeredSeq: 1 });
    harness.manager['enqueueNeedInputRetry'](key, 2, 1);
    harness.manager['settleNeedInputRetry'](key, 1, 1, 'ok');
    expect(harness.manager['needInputRetry'].get(key)).toEqual({ askSeq: 2, answeredSeq: 1 });
    harness.manager['settleNeedInputRetry'](key, 2, 1, 'ok');
    expect(harness.manager['needInputRetry'].has(key)).toBe(false);
  });

  it('drops stale-generation queue items as fenced on retry', async () => {
    await seedWatermarkAgent({ epoch: 2 });
    harness.manager['enqueueNeedInputRetry'](harness.manager['needInputRetryKey']('dev-1', 't-wm', 1), 1, 0);
    await harness.manager['needInputRetryPass']();
    expect(harness.manager['needInputRetry'].size).toBe(0);
    expect((await harness.agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 2 });
  });

  it('confirmNeedInputAnswered settles the open question from the store', async () => {
    await seedWatermarkAgent({ epoch: 1, askSeq: 2, answeredSeq: 1, at: NOW });
    await harness.manager.notifyHumanTerminalInput('dev-1');
    expect((await harness.agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 1, askSeq: 2, answeredSeq: 2 });
  });

  it('confirmNeedInputAnswered sees a queue-only pending ask and tombstones it', async () => {
    await seedWatermarkAgent({ epoch: 1 });
    vi.spyOn(harness.agentStore, 'update').mockRejectedValueOnce(new Error('down'));
    expect(await commit({ askSeq: 1, answeredSeq: 0 })).toBe('error');
    await harness.manager.notifyHumanTerminalInput('dev-1');
    expect((await harness.agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 1, askSeq: 1, answeredSeq: 1 });
    await harness.manager['needInputRetryPass']();
    expect((await harness.agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 1, askSeq: 1, answeredSeq: 1 });
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

  function makeCrossLayer(): { m: AgentManager; streamer: CrossStreamer; captured: BaxianEvent[] } {
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
    const m = harness.createManager({
      paneStreamerManager: { ensure: () => streamer } as never,
      eventBus: {
        emit: async (event: BaxianEvent) => { captured.push(event); },
        subscribe: () => () => undefined,
      } as never,
    });
    return { m, streamer, captured };
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

  async function seedCross(needInput?: AgentBindingFacts['needInput']): Promise<void> {
    await harness.seedTask({ id: 't-xl', status: 'in_progress', signalToken: 'tokXL12345678' });
    await harness.seedAgent({ id: 'dev-1', taskId: 't-xl', paneId: '%0', ...(needInput ? { needInput } : {}) });
  }

  it.each(['return', 'throw'] as const)(
    'releases a replay hand-off claim when continueSession exits before arm (%s)',
    async (outcome) => {
      const { m } = makeCrossLayer();
      const oldToken = 'tokXL12345678';
      await seedCross();
      expect(await armVia(m, oldToken, { needInputMode: 'fresh' })).toBe(true);
      const continueSpy = vi.spyOn(m, 'continueSession');
      if (outcome === 'return') continueSpy.mockResolvedValue(false);
      else continueSpy.mockRejectedValue(new Error('ensure failed before arm'));

      expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 't-xl')).toBe(true);

      const newToken = (await harness.taskStore.get('t-xl'))!.signalToken!;
      expect(newToken).not.toBe(oldToken);
      expect(m['phaseSignalWatcher']!.has('t-xl', 'dev-1')).toBe(false);
      expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBe('restart-redispatch-failed');
      const successorClaim = m['phaseSignalWatcher']!.claimArm({
        taskId: 't-xl', agentId: 'dev-1', token: 'successor12345', replaceFromToken: newToken,
        onlyReplaceOwnToken: true, replaceScope: 'agent',
      });
      expect(successorClaim).not.toBeNull();
      m['phaseSignalWatcher']!.releaseArm(successorClaim);
    },
  );

  it('rejects a conflicting pending hand-off before rotating persistent task state', async () => {
    const { m } = makeCrossLayer();
    const oldToken = 'tokXL12345678';
    await seedCross();
    expect(await armVia(m, oldToken, { needInputMode: 'fresh' })).toBe(true);
    const blocker = m['phaseSignalWatcher']!.claimArm({
      taskId: 't-xl', agentId: 'dev-1', token: 'blocker123456', replaceFromToken: oldToken,
      onlyReplaceOwnToken: true, replaceScope: 'agent',
    });
    expect(blocker).not.toBeNull();
    const setSpy = vi.spyOn(harness.taskStore, 'set');
    const continueSpy = vi.spyOn(m, 'continueSession');

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 't-xl')).toBe(false);

    expect((await harness.taskStore.get('t-xl'))?.signalToken).toBe(oldToken);
    expect(setSpy).not.toHaveBeenCalled();
    expect(continueSpy).not.toHaveBeenCalled();
    expect(m['phaseSignalWatcher']!.has('t-xl', 'dev-1')).toBe(true);
    m['phaseSignalWatcher']!.releaseArm(blocker);
  });

  it.each(['installed', 'subscribe-failed'] as const)(
    'releases the replay claim after watcher start settles (%s)',
    async (outcome) => {
      const { m, streamer } = makeCrossLayer();
      const oldToken = 'tokXL12345678';
      await seedCross();
      expect(await armVia(m, oldToken, { needInputMode: 'fresh' })).toBe(true);
      if (outcome === 'subscribe-failed') streamer.failNextSubscribe();
      vi.spyOn(m, 'continueSession').mockImplementation(async (...args) => {
        const arm = (args[3] as ContinueSessionOpts).armBeforeInject;
        return arm ? arm({}) : true;
      });

      expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 't-xl')).toBe(true);

      const newToken = (await harness.taskStore.get('t-xl'))!.signalToken!;
      expect(m['phaseSignalWatcher']!.has('t-xl', 'dev-1')).toBe(outcome === 'installed');
      const successorClaim = m['phaseSignalWatcher']!.claimArm({
        taskId: 't-xl', agentId: 'dev-1', token: 'successor67890', replaceFromToken: newToken,
        onlyReplaceOwnToken: true, replaceScope: 'agent',
      });
      expect(successorClaim).not.toBeNull();
      m['phaseSignalWatcher']!.releaseArm(successorClaim);
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
    await m['needInputRetryPass']();
    expect(m['needInputRetry'].size).toBe(0);
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
    await vi.waitFor(() => expect(m['needInputWritesInFlight'].size).toBe(1));
    streamer.triggerSessionGone();
    release();
    expect(await armP).toBe(true);
    spy.mockRestore();
    failAnswer();
    await flush();
    await m['needInputRetryPass']();

    const wm = (await harness.agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 2, askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
    expect(m['needInputRetry'].size).toBe(0);
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
    await vi.waitFor(() => expect(m['needInputWritesInFlight'].size).toBe(1));
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
    const { m, streamer } = makeCrossLayer();
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

    m['phaseSignalWatcher']!.stopAgent('t-xl', 'dev-1');
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
    const { m, streamer } = makeCrossLayer();
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

    m['phaseSignalWatcher']!.stopAgent('t-xl', 'dev-1');
    streamer.setSnapshotData(`stale scrollback [bx:need-input:${oldToken}:1]`);
    expect(await armVia(m, newToken, { needInputMode: 'restore' })).toBe(true);
    await flush();
    const wm = (await harness.agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ askSeq: 0, answeredSeq: 0 });
    expect(wm?.at).toBeUndefined();
  });

  it('web input falls back to the store when only another task has a live watcher', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross({ epoch: 1, askSeq: 1, answeredSeq: 0, at: NOW });
    await m['phaseSignalWatcher']!.start({
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
    m['enqueueNeedInputRetry'](m['needInputRetryKey']('dev-1', 't-xl', 1), 2, 1);
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
    m['enqueueNeedInputRetry'](m['needInputRetryKey']('dev-1', 't-xl', 3), 2, 0);

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
    m['enqueueNeedInputRetry'](m['needInputRetryKey']('dev-1', 't-xl', 1), 1, 1);
    const real = harness.agentStore.update.bind(harness.agentStore);
    const spy = vi.spyOn(harness.agentStore, 'update').mockRejectedValueOnce(new Error('store down'));
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'restore', skipSnapshot: true })).toBe(true);
    spy.mockImplementation(real as never);
    expect(m['needInputRetry'].size).toBe(1);

    await m['needInputRetryPass']();
    const wm = (await harness.agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 1, askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
    expect(m['needInputRetry'].size).toBe(0);
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
    const { m, streamer } = makeCrossLayer();
    await seedCross();

    const gate = streamer.holdNextSubscribe();
    const lateP = armVia(m, 'tokOLD1234567', { needInputMode: 'fresh', skipSnapshot: true });
    await waitForNeedInput({ epoch: 1 });

    expect(await armVia(m, 'tokNEW1234567', { needInputMode: 'fresh', skipSnapshot: true })).toBe(true);
    expect((await harness.agentStore.get('dev-1'))?.needInput?.epoch).toBe(2);
    streamer.triggerLive('[bx:pr-created:7:tokNEW1234567]\n');
    await flush();
    expect(m['phaseSignalWatcher']!.has('t-xl', 'dev-1')).toBe(false);

    gate.release();
    expect(await lateP).toBe(false);
    expect(m['phaseSignalWatcher']!.has('t-xl', 'dev-1')).toBe(false);

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

  it('armPostDispatchSignalOrHold strips a superseded watermark for a continuation', async () => {
    const { m } = makeCrossLayer();
    await seedCross({ epoch: 2, askSeq: 1, answeredSeq: 0, at: NOW });
    await (m as never as {
      armPostDispatchSignalOrHold: (
        taskId: string, agentId: string, kinds: readonly string[], token: string,
      ) => Promise<void>;
    }).armPostDispatchSignalOrHold('t-xl', 'dev-1', ['pr-fixed'], 'tokXL12345678');
    expect((await harness.agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 3, askSeq: 0, answeredSeq: 0 });
  });
});
