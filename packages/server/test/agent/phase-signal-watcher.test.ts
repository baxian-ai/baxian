import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PhaseSignalWatcher,
  type NeedInputCommitIntent,
  type NeedInputCommitResult,
} from '../../src/agent/phase-signal-watcher.js';
import { buildPhaseSignal, PASSIVE_VERDICT_WATCH } from '../../src/agent/phase-signal.js';
import type { AgentConfig, BaxianEvent } from '../../src/shared/index.js';
import type { EventBus } from '../../src/event/bus.js';
import type { PaneStreamerManager } from '../../src/agent/pane-streamer-manager.js';
import type { SubscriberCallbacks } from '../../src/agent/pane-streamer.js';
import { VisibleTextExtractor } from '../../src/agent/vt-visible-text.js';

const DEV_AGENT: AgentConfig = {
  id: 'dev-1',
  runtime: 'claude-code',
  role: 'dev',
  mode: 'local',
};

interface FakeStreamer {
  subscribeAtomic: ReturnType<typeof vi.fn>;
  triggerLive: (data: string) => void;
  triggerSessionGone: () => void;
  setSnapshot: (data: string) => void;
  failNextSubscribe: () => void;
  holdNextSubscribe: () => { release: () => void };
  unsubscribed: boolean;
}

function createFakeStreamer(): FakeStreamer {
  const subs: Array<{
    live?: SubscriberCallbacks['onLive'];
    visible?: SubscriberCallbacks['onVisible'];
    sessionGone?: SubscriberCallbacks['onSessionGone'];
  }> = [];
  const decoder = new VisibleTextExtractor();
  let snapshotData = '';
  let failNext = false;
  let holdNext: Promise<void> | null = null;
  const state: FakeStreamer = {
    unsubscribed: false,
    triggerLive: (data: string) => {
      const visible = decoder.write(data);
      for (const sub of subs) { sub.live?.(data, 0); sub.visible?.(visible, 0); }
    },
    triggerSessionGone: () => { for (const sub of subs) sub.sessionGone?.(); },
    setSnapshot: (data: string) => { snapshotData = data; },
    failNextSubscribe: () => { failNext = true; },
    holdNextSubscribe: () => {
      let release!: () => void;
      holdNext = new Promise<void>(resolve => { release = resolve; });
      return { release };
    },
    subscribeAtomic: vi.fn(async (cbs: SubscriberCallbacks) => {
      if (failNext) {
        failNext = false;
        throw new Error('subscribe transport down');
      }
      if (holdNext) {
        const gate = holdNext;
        holdNext = null;
        await gate;
      }
      const record: typeof subs[number] = { live: cbs.onLive, visible: cbs.onVisible, sessionGone: cbs.onSessionGone };
      subs.push(record);
      return {
        snapshot: { data: snapshotData },
        unsubscribe: () => {
          state.unsubscribed = true;
          record.live = undefined;
          record.visible = undefined;
          record.sessionGone = undefined;
        },
      };
    }),
  };
  return state;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

type StartArgs = Parameters<PhaseSignalWatcher['start']>[0];

function startWatch(
  watcher: PhaseSignalWatcher,
  overrides: Partial<StartArgs> & Pick<StartArgs, 'expectedKinds' | 'token'>,
): Promise<boolean> {
  return watcher.start({
    taskId: 't1', projectId: 'p1', agentId: DEV_AGENT.id, ...overrides,
  });
}

function makeWatcher() {
  const streamer = createFakeStreamer();
  const paneStreamerManager = { ensure: vi.fn(() => streamer) } as unknown as PaneStreamerManager;
  const emit = vi.fn(async () => undefined);
  const eventBus = { emit } as unknown as EventBus;
  const commits: NeedInputCommitIntent[] = [];
  let commitResult: NeedInputCommitResult | Error = 'ok';
  const watcher = new PhaseSignalWatcher({
    paneStreamerManager,
    eventBus,
    resolveAgent: (id) => (id === DEV_AGENT.id ? DEV_AGENT : undefined),
    commitNeedInputWatermark: async (intent) => {
      commits.push(intent);
      if (commitResult instanceof Error) throw commitResult;
      return commitResult;
    },
  });
  const captured: BaxianEvent[] = [];
  emit.mockImplementation(async (event: BaxianEvent) => {
    captured.push(event);
  });
  return {
    watcher, streamer, emit, captured, commits,
    setCommitResult: (r: NeedInputCommitResult | Error) => { commitResult = r; },
  };
}

const QA_AGENT: AgentConfig = {
  id: 'qa-1',
  runtime: 'claude-code',
  role: 'qa',
  mode: 'local',
};

function makeDualWatcher() {
  const streamers: Record<string, FakeStreamer> = {
    [DEV_AGENT.id]: createFakeStreamer(),
    [QA_AGENT.id]: createFakeStreamer(),
  };
  const paneStreamerManager = {
    ensure: vi.fn((agent: AgentConfig) => streamers[agent.id]),
  } as unknown as PaneStreamerManager;
  const captured: BaxianEvent[] = [];
  const eventBus = {
    emit: async (event: BaxianEvent) => { captured.push(event); },
  } as unknown as EventBus;
  const watcher = new PhaseSignalWatcher({
    paneStreamerManager,
    eventBus,
    resolveAgent: (id) => (id === DEV_AGENT.id ? DEV_AGENT : id === QA_AGENT.id ? QA_AGENT : undefined),
  });
  return { watcher, streamers, captured };
}

describe('PhaseSignalWatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits the configured event type when a single-kind signal matches', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    const token = 'tok123abc456';
    await startWatch(watcher, { expectedKinds: 'spec-done', token });
    streamer.triggerLive(`${buildPhaseSignal('spec-done', token, 42)}\n`);
    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe('spec.ready');
    expect(captured[0].data).toMatchObject({
      kind: 'spec-done',
      prNumber: 42,
      token,
      source: 'pane-signal',
    });
  });

  it('start() returns true when a watch entry is installed', async () => {
    const { watcher } = makeWatcher();
    const armed = await startWatch(watcher, { expectedKinds: 'spec-done', token: 'tok123abc456' });
    expect(armed).toBe(true);
    expect(watcher.has('t1')).toBe(true);
  });

  it('start() returns false when the agent cannot be resolved (no entry installed)', async () => {
    const { watcher } = makeWatcher();
    const armed = await startWatch(watcher, {
      agentId: 'unknown-agent', expectedKinds: 'spec-done', token: 'tok123abc456',
    });
    expect(armed).toBe(false);
    expect(watcher.has('t1')).toBe(false);
  });

  it('start() returns false when subscribeAtomic rejects (transient pane fault)', async () => {
    const { watcher, streamer } = makeWatcher();
    streamer.subscribeAtomic.mockRejectedValueOnce(new Error('streamer destroyed'));
    const armed = await startWatch(watcher, { expectedKinds: 'pr-fixed', token: 'tok123abc456' });
    expect(armed).toBe(false);
    expect(watcher.has('t1')).toBe(false);
  });

  it('a passive verdict watch stays armed and fires nothing when the pane prints a verdict', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    const token = 'verdict12345';
    await startWatch(watcher, { expectedKinds: PASSIVE_VERDICT_WATCH, token });
    streamer.triggerLive(`[bx:pr-approved:${token}]\n`);
    expect(captured).toHaveLength(0);
    expect(watcher.has('t1')).toBe(true);
  });

  it('ignores a signal whose kind is outside expectedKinds', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    const token = 'tokenABCDEF12';
    await startWatch(watcher, { expectedKinds: 'spec-done', token });
    streamer.triggerLive(`${buildPhaseSignal('pr-fixed', token)}\n`);
    expect(captured).toHaveLength(0);
  });

  it('ignores a signal with matching kind but mismatched token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: 'correctTok01' });
    streamer.triggerLive(`${buildPhaseSignal('spec-done', 'wrongTok123x', 42)}\n`);
    expect(captured).toHaveLength(0);
    expect(warn.mock.calls.some(c => String(c[0]).includes('foreign token'))).toBe(true);
    warn.mockRestore();
  });

  it('matches a signal split across two chunks', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    const token = 'splittok2345';
    await startWatch(watcher, { expectedKinds: 'pr-merge-ready', token });
    const literal = buildPhaseSignal('pr-merge-ready', token);
    const half = Math.floor(literal.length / 2);
    streamer.triggerLive(literal.slice(0, half));
    expect(captured).toHaveLength(0);
    streamer.triggerLive(literal.slice(half));
    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe('pr.updated');
  });

  it('matches signal wrapped in ANSI color codes', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    const token = 'ansiTok123ab';
    await startWatch(watcher, { expectedKinds: 'pr-fixed', token });
    streamer.triggerLive(`\x1b[32m${buildPhaseSignal('pr-fixed', token)}\x1b[0m\n`);
    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe('pr.fix.submitted');
  });

  it('matches a soft-wrapped signal (TUI breaks mid-token with whitespace)', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    const token = 'softWrap1234';
    await startWatch(watcher, { expectedKinds: 'pr-merge-ready', token });
    streamer.triggerLive('[bx:pr-merge-ready:so\n  ftWrap\n   1234]\n');
    expect(captured).toHaveLength(1);
  });

  it('does NOT fire on the rendered prompt template (placeholder, real token on separate line)', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    const token = 'realtok1234ab';
    await startWatch(watcher, { expectedKinds: 'pr-merge-ready', token });
    const promptShape = [
      'Post-approve PR feedback check:',
      `- Emit on its own line, substituting <token>:`,
      '    [bx:pr-merge-ready:<token>]',
      `  token: ${token}`,
    ].join('\n') + '\n';
    streamer.triggerLive(promptShape);
    expect(captured).toHaveLength(0);
  });

  it('does not double-emit when the same signal appears twice', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    const token = 'oncetok123ab';
    await startWatch(watcher, { expectedKinds: 'spec-done', token });
    streamer.triggerLive(`${buildPhaseSignal('spec-done', token, 42)}\n`);
    streamer.triggerLive(`${buildPhaseSignal('spec-done', token, 42)}\n`);
    expect(captured).toHaveLength(1);
  });

  it('matches signal already present in pane snapshot at subscribe', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    const token = 'snapshotTok1';
    streamer.setSnapshot(`prior output\n${buildPhaseSignal('pr-merge-ready', token)}\n`);
    await startWatch(watcher, { expectedKinds: 'pr-merge-ready', token });
    expect(captured).toHaveLength(1);
  });

  it('exposes a matching snapshot event until its handler settles', async () => {
    const { watcher, streamer, emit } = makeWatcher();
    const token = 'snapshotSettle1';
    streamer.setSnapshot(buildPhaseSignal('pr-fixed', token));
    let release!: () => void;
    emit.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));

    await startWatch(watcher, { expectedKinds: 'pr-fixed', token });

    expect(watcher.isSettling('t1')).toBe(true);
    release();
    await watcher.awaitSettled('t1');
    expect(watcher.isSettling('t1')).toBe(false);
  });

  it('releases a snapshot settlement when event delivery fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { watcher, streamer, emit } = makeWatcher();
    const token = 'snapshotFailed1';
    streamer.setSnapshot(buildPhaseSignal('pr-fixed', token));
    emit.mockRejectedValueOnce(new Error('bus down'));

    await startWatch(watcher, { expectedKinds: 'pr-fixed', token });
    await watcher.awaitSettled('t1');

    expect(watcher.isSettling('t1')).toBe(false);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('eventBus.emit failed'),
      expect.any(Error),
    );
    error.mockRestore();
  });

  it('skipSnapshot=true: ignores signal sitting in pane snapshot at subscribe', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    const token = 'snapshotTok2';
    streamer.setSnapshot(`prior output\n${buildPhaseSignal('pr-merge-ready', token)}\n`);
    await startWatch(watcher, {
      expectedKinds: 'pr-merge-ready',
      token,
      skipSnapshot: true,
    });
    expect(captured).toHaveLength(0);
  });

  it('start with the same taskId disarms the previous entry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: 'old1tok234ab' });
    await startWatch(watcher, { expectedKinds: 'spec-done', token: 'new1tok234ab' });
    streamer.triggerLive(`${buildPhaseSignal('spec-done', 'old1tok234ab', 42)}\n`);
    expect(captured).toHaveLength(0);
    streamer.triggerLive(`${buildPhaseSignal('spec-done', 'new1tok234ab', 42)}\n`);
    expect(captured).toHaveLength(1);
    warn.mockRestore();
  });

  it('stop(taskId) removes the entry and prevents further fires', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    const token = 'stoptok1234a';
    await startWatch(watcher, { expectedKinds: 'spec-done', token });
    watcher.stop('t1');
    streamer.triggerLive(`${buildPhaseSignal('spec-done', token, 42)}\n`);
    expect(captured).toHaveLength(0);
  });

  it('agent-scoped arms coexist per (taskId, agentId) and fire independently', async () => {
    const { watcher, streamers, captured } = makeDualWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token: 'devtok123456' });
    await startWatch(watcher, {
      agentId: QA_AGENT.id, expectedKinds: 'pr-fixed',
      token: 'qatok1234567', replaceScope: 'agent',
    });
    expect(watcher.has('t1', DEV_AGENT.id)).toBe(true);
    expect(watcher.has('t1', QA_AGENT.id)).toBe(true);
    streamers[QA_AGENT.id]!.triggerLive(`${buildPhaseSignal('pr-fixed', 'qatok1234567')}\n`);
    expect(captured).toHaveLength(1);
    expect(watcher.has('t1', DEV_AGENT.id)).toBe(true);
    streamers[DEV_AGENT.id]!.triggerLive(`${buildPhaseSignal('pr-created', 'devtok123456', 42)}\n`);
    await flushMicrotasks();
    expect(captured).toHaveLength(2);
    expect(captured.map(e => e.agentId).sort()).toEqual([DEV_AGENT.id, QA_AGENT.id]);
  });

  it('a default-scope arm still replaces every entry of the task', async () => {
    const { watcher, streamers, captured } = makeDualWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token: 'devtok123456' });
    await startWatch(watcher, {
      agentId: QA_AGENT.id, expectedKinds: 'pr-fixed', token: 'qatok1234567',
    });
    expect(watcher.has('t1', DEV_AGENT.id)).toBe(false);
    streamers[DEV_AGENT.id]!.triggerLive(`${buildPhaseSignal('pr-created', 'devtok123456', 42)}\n`);
    expect(captured).toHaveLength(0);
    streamers[QA_AGENT.id]!.triggerLive(`${buildPhaseSignal('pr-fixed', 'qatok1234567')}\n`);
    expect(captured).toHaveLength(1);
  });

  it('stopAgent removes only the addressed entry while stop clears the task', async () => {
    const { watcher, streamers, captured } = makeDualWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token: 'devtok123456' });
    await startWatch(watcher, {
      agentId: QA_AGENT.id, expectedKinds: 'pr-fixed', token: 'qatok1234567', replaceScope: 'agent',
    });
    watcher.stopAgent('t1', DEV_AGENT.id);
    expect(watcher.has('t1', DEV_AGENT.id)).toBe(false);
    expect(watcher.has('t1', QA_AGENT.id)).toBe(true);
    watcher.stop('t1');
    expect(watcher.has('t1')).toBe(false);
    streamers[QA_AGENT.id]!.triggerLive(`${buildPhaseSignal('pr-fixed', 'qatok1234567')}\n`);
    expect(captured).toHaveLength(0);
  });

  it('an agent-scoped fenced arm ignores a sibling entry holding a rotated token', async () => {
    const { watcher, streamers, captured } = makeDualWatcher();
    await startWatch(watcher, {
      agentId: QA_AGENT.id, expectedKinds: 'pr-fixed', token: 'qarotated456', replaceScope: 'agent',
    });
    const armed = await startWatch(watcher, {
      expectedKinds: 'pr-created', token: 'devtok123456',
      replaceScope: 'agent', onlyReplaceOwnToken: true,
    });
    expect(armed).toBe(true);
    streamers[DEV_AGENT.id]!.triggerLive(`${buildPhaseSignal('pr-created', 'devtok123456', 7)}\n`);
    expect(captured).toHaveLength(1);
    expect(watcher.has('t1', QA_AGENT.id)).toBe(true);
  });

  it('stopIfToken tears down only the entries holding that token', async () => {
    const { watcher, streamers, captured } = makeDualWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token: 'devtok123456' });
    await startWatch(watcher, {
      agentId: QA_AGENT.id, expectedKinds: 'pr-fixed', token: 'qatok1234567', replaceScope: 'agent',
    });
    watcher.stopIfToken('t1', 'devtok123456');
    expect(watcher.has('t1', DEV_AGENT.id)).toBe(false);
    expect(watcher.has('t1', QA_AGENT.id)).toBe(true);
    streamers[QA_AGENT.id]!.triggerLive(`${buildPhaseSignal('pr-fixed', 'qatok1234567')}\n`);
    expect(captured).toHaveLength(1);
  });

  it('stopAgentIfToken retires only the matching agent predecessor', async () => {
    const { watcher, streamers, captured } = makeDualWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token: 'sharedtok1234' });
    await startWatch(watcher, {
      agentId: QA_AGENT.id, expectedKinds: 'pr-fixed', token: 'sharedtok1234', replaceScope: 'agent',
    });

    watcher.stopAgentIfToken('t1', DEV_AGENT.id, 'sharedtok1234');

    expect(watcher.has('t1', DEV_AGENT.id)).toBe(false);
    expect(watcher.has('t1', QA_AGENT.id)).toBe(true);
    streamers[QA_AGENT.id]!.triggerLive(`${buildPhaseSignal('pr-fixed', 'sharedtok1234')}\n`);
    expect(captured).toHaveLength(1);
  });

  it('hands an old-token entry to the new token only after subscribing and preserves its sibling', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { watcher, streamers, captured } = makeDualWatcher();
    const oldToken = 'devoldtok1234';
    const newToken = 'devnewtok1234';
    await startWatch(watcher, { expectedKinds: 'pr-created', token: oldToken, replaceScope: 'agent' });
    await startWatch(watcher, {
      agentId: QA_AGENT.id, expectedKinds: 'pr-fixed', token: 'qatok1234567', replaceScope: 'agent',
    });
    const claim = watcher.claimArm({
      taskId: 't1', agentId: DEV_AGENT.id, token: newToken, replaceFromToken: oldToken,
      onlyReplaceOwnToken: true, replaceScope: 'agent',
    });
    expect(claim).not.toBeNull();
    const gate = streamers[DEV_AGENT.id]!.holdNextSubscribe();
    const handoff = startWatch(watcher, {
      expectedKinds: 'pr-created', token: newToken, replaceFromToken: oldToken,
      onlyReplaceOwnToken: true, replaceScope: 'agent', armClaimId: claim!, skipSnapshot: true,
    });
    await flushMicrotasks();
    expect(watcher.has('t1', DEV_AGENT.id)).toBe(true);
    expect(watcher.has('t1', QA_AGENT.id)).toBe(true);
    gate.release();
    expect(await handoff).toBe(true);
    watcher.releaseArm(claim);

    streamers[DEV_AGENT.id]!.triggerLive(`${buildPhaseSignal('pr-created', oldToken, 1)}\n`);
    expect(captured).toHaveLength(0);
    streamers[QA_AGENT.id]!.triggerLive(`${buildPhaseSignal('pr-fixed', 'qatok1234567')}\n`);
    streamers[DEV_AGENT.id]!.triggerLive(`${buildPhaseSignal('pr-created', newToken, 2)}\n`);
    await flushMicrotasks();
    expect(captured.map(event => event.agentId).sort()).toEqual([DEV_AGENT.id, QA_AGENT.id]);
    warn.mockRestore();
  });

  it('rejects a different pending hand-off token before either arm can install', async () => {
    const { watcher } = makeWatcher();
    const first = watcher.claimArm({
      taskId: 't1', agentId: DEV_AGENT.id, token: 'newtoken11111', replaceFromToken: 'oldtoken11111',
      onlyReplaceOwnToken: true, replaceScope: 'agent',
    });
    expect(first).not.toBeNull();
    expect(watcher.claimArm({
      taskId: 't1', agentId: DEV_AGENT.id, token: 'newtoken22222', replaceFromToken: 'oldtoken11111',
      onlyReplaceOwnToken: true, replaceScope: 'agent',
    })).toBeNull();
    const sameToken = watcher.claimArm({
      taskId: 't1', agentId: DEV_AGENT.id, token: 'newtoken11111', replaceFromToken: 'oldtoken11111',
      onlyReplaceOwnToken: true, replaceScope: 'agent',
    });
    expect(sameToken).not.toBeNull();
    watcher.releaseArm(first);
    watcher.releaseArm(sameToken);
  });

  it('stopIfToken removes the entry only when the token matches', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    const token = 'fencetok1234';
    await startWatch(watcher, { expectedKinds: 'spec-done', token });

    watcher.stopIfToken('t1', 'other-token1');
    expect(watcher.has('t1')).toBe(true);

    watcher.stopIfToken('t1', token);
    expect(watcher.has('t1')).toBe(false);
    streamer.triggerLive(`${buildPhaseSignal('spec-done', token, 42)}\n`);
    expect(captured).toHaveLength(0);
  });

  it('stopIfToken never kills a successor watch re-armed with a rotated token', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: 'staletok1234' });
    await startWatch(watcher, { expectedKinds: 'spec-done', token: 'freshtok1234' });

    watcher.stopIfToken('t1', 'staletok1234');

    expect(watcher.has('t1')).toBe(true);
    streamer.triggerLive(`${buildPhaseSignal('spec-done', 'freshtok1234', 42)}\n`);
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].type).toBe('spec.ready');
  });

  it('a fenced arm never displaces a successor watch already re-armed with a rotated token', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-merge-ready', token: 'freshtok9999' });

    const staleArm = await startWatch(watcher, {
      expectedKinds: 'spec-done', token: 'staletok1111', skipSnapshot: true, onlyReplaceOwnToken: true,
    });

    expect(staleArm).toBe(false);
    expect(watcher.has('t1')).toBe(true);
    expect([...watcher.expectedKindsFor('t1')]).toEqual(['pr-merge-ready']);

    watcher.stopIfToken('t1', 'staletok1111');
    expect(watcher.has('t1')).toBe(true);
    expect([...watcher.expectedKindsFor('t1')]).toEqual(['pr-merge-ready']);

    streamer.triggerLive(`${buildPhaseSignal('pr-merge-ready', 'freshtok9999')}\n`);
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].type).toBe('pr.updated');
  });

  it('a failed same-token re-arm keeps the previous watcher consuming', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-merge-ready', token: 'sametok12345' });

    streamer.subscribeAtomic.mockRejectedValueOnce(new Error('pane streamer hiccup'));
    const rearm = await startWatch(watcher, {
      expectedKinds: 'pr-merge-ready', token: 'sametok12345', skipSnapshot: true, onlyReplaceOwnToken: true,
    });

    expect(rearm).toBe(false);
    expect(watcher.has('t1')).toBe(true);
    streamer.triggerLive(`${buildPhaseSignal('pr-merge-ready', 'sametok12345')}\n`);
    expect(captured.some(e => e.type === 'pr.updated')).toBe(true);
  });

  it('a fenced arm aborts when a successor arms while its subscription is in flight', async () => {
    const { watcher, streamer } = makeWatcher();
    let releaseStale: (() => void) | undefined;
    const original = streamer.subscribeAtomic.getMockImplementation()!;
    streamer.subscribeAtomic.mockImplementationOnce(async (cbs: SubscriberCallbacks) => {
      await new Promise<void>((resolve) => { releaseStale = resolve; });
      return original(cbs);
    });

    const stalePromise = startWatch(watcher, {
      expectedKinds: 'spec-done', token: 'staletok1111', skipSnapshot: true, onlyReplaceOwnToken: true,
    });
    await flushMicrotasks();
    await startWatch(watcher, { expectedKinds: 'pr-merge-ready', token: 'freshtok9999' });
    releaseStale!();

    expect(await stalePromise).toBe(false);
    expect(watcher.has('t1')).toBe(true);
    expect([...watcher.expectedKindsFor('t1')]).toEqual(['pr-merge-ready']);
  });

  it('emits human.intervention when the underlying streamer reports session-gone before fire', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: 'tokSGone1234' });
    streamer.triggerSessionGone();
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].type).toBe('human.intervention');
    expect((captured[0].data as { phase: string }).phase).toMatch(/^signal-session-gone:/);
  });

  it('emits human.intervention when resolveAgent returns undefined', async () => {
    const captured: BaxianEvent[] = [];
    const paneStreamerManager = { ensure: vi.fn() } as unknown as PaneStreamerManager;
    const eventBus = {
      emit: vi.fn(async (event: BaxianEvent) => { captured.push(event); }),
    } as unknown as EventBus;
    const watcher = new PhaseSignalWatcher({
      paneStreamerManager,
      eventBus,
      resolveAgent: () => undefined,
    });
    await startWatch(watcher, {
      agentId: 'unknown-agent',
      expectedKinds: 'spec-done',
      token: 'noagent12345',
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe('human.intervention');
    expect((captured[0].data as { phase: string }).phase).toMatch(/^signal-setup-no-agent:/);
  });

  it('emits human.intervention when emit() itself throws (signal already consumed)', async () => {
    const streamer = createFakeStreamer();
    const paneStreamerManager = { ensure: vi.fn(() => streamer) } as unknown as PaneStreamerManager;
    const captured: BaxianEvent[] = [];
    const emit = vi.fn(async (event: BaxianEvent) => {
      if (event.type !== 'human.intervention') throw new Error('downstream-broken');
      captured.push(event);
    });
    const eventBus = { emit } as unknown as EventBus;
    const watcher = new PhaseSignalWatcher({
      paneStreamerManager,
      eventBus,
      resolveAgent: (id) => (id === DEV_AGENT.id ? DEV_AGENT : undefined),
    });
    const token = 'emitFail1234';
    await startWatch(watcher, { expectedKinds: 'spec-done', token });
    streamer.triggerLive(`${buildPhaseSignal('spec-done', token, 42)}\n`);
    await flushMicrotasks();
    expect(captured.length).toBe(1);
    expect((captured[0].data as { phase: string }).phase).toMatch(/^signal-emit-failed:/);
  });

  it('expectedKindsFor(taskId): reports the watched set; empty Set after stop', async () => {
    const { watcher } = makeWatcher();
    await startWatch(watcher, { expectedKinds: ['spec-done', 'pr-fixed'], token: 'introspct123' });
    const armed = watcher.expectedKindsFor('t1');
    expect(armed.has('spec-done')).toBe(true);
    expect(armed.has('pr-fixed')).toBe(true);
    watcher.stop('t1');
    expect(watcher.expectedKindsFor('t1').size).toBe(0);
  });
});

describe('stale signal token visibility', () => {
  const armed = 'dd7a81ef91e3';
  const stale = '4347881f370e';

  function staleWarnings(warn: ReturnType<typeof vi.spyOn>): string[] {
    return warn.mock.calls
      .map(call => String(call[0]))
      .filter(line => line.includes('foreign token'));
  }

  function spyWarn() {
    return vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  }

  it('logs a live marker of the expected kind carrying a foreign token, without eventing', async () => {
    const warn = spyWarn();
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-fixed', token: armed });
    streamer.triggerLive(buildPhaseSignal('pr-fixed', stale));
    await flushMicrotasks();
    const lines = staleWarnings(warn);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('pr-fixed');
    expect(lines[0]).toContain(`observed=${stale}`);
    expect(lines[0]).toContain(`expected=${armed}`);
    expect(lines[0]).toContain('task=t1');
    expect(captured).toHaveLength(0);
    warn.mockRestore();
  });

  it('logs each distinct stale token once despite tail rescans and redraws', async () => {
    const warn = spyWarn();
    const { watcher, streamer } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-fixed', token: armed });
    streamer.triggerLive(buildPhaseSignal('pr-fixed', stale));
    streamer.triggerLive(' redraw keeps the old marker in the tail window ');
    streamer.triggerLive(buildPhaseSignal('pr-fixed', stale));
    await flushMicrotasks();
    expect(staleWarnings(warn)).toHaveLength(1);

    streamer.triggerLive(buildPhaseSignal('pr-fixed', 'ff00ff00ff00'));
    await flushMicrotasks();
    expect(staleWarnings(warn)).toHaveLength(2);
    warn.mockRestore();
  });

  it('stays silent on the arm-time snapshot: scrollback holds markers of every past round', async () => {
    const warn = spyWarn();
    const { watcher, streamer } = makeWatcher();
    streamer.setSnapshot(buildPhaseSignal('pr-fixed', stale));
    await startWatch(watcher, { expectedKinds: 'pr-fixed', token: armed });
    await flushMicrotasks();
    expect(staleWarnings(warn)).toHaveLength(0);
    streamer.triggerLive(' later output on the same pane ');
    await flushMicrotasks();
    expect(staleWarnings(warn)).toHaveLength(0);
    warn.mockRestore();
  });

  it('surfaces a live mis-send even when that token was already sitting in the arm snapshot', async () => {
    const warn = spyWarn();
    const { watcher, streamer } = makeWatcher();
    streamer.setSnapshot(buildPhaseSignal('pr-fixed', stale));
    await startWatch(watcher, { expectedKinds: 'pr-fixed', token: armed });
    await flushMicrotasks();
    expect(staleWarnings(warn)).toHaveLength(0);
    streamer.triggerLive(buildPhaseSignal('pr-fixed', stale));
    await flushMicrotasks();
    const lines = staleWarnings(warn);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`observed=${stale}`);
    warn.mockRestore();
  });

  it('stays silent for an unwatched kind and when the armed token does arrive', async () => {
    const warn = spyWarn();
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-fixed', token: armed });
    streamer.triggerLive(buildPhaseSignal('pr-merge-ready', stale));
    await flushMicrotasks();
    expect(staleWarnings(warn)).toHaveLength(0);

    streamer.triggerLive(buildPhaseSignal('pr-fixed', armed));
    await flushMicrotasks();
    expect(staleWarnings(warn)).toHaveLength(0);
    expect(captured.some(e => e.type === 'pr.fix.submitted')).toBe(true);
    warn.mockRestore();
  });

  it('logs the stale token even when it shares a chunk with an unrelated marker', async () => {
    const warn = spyWarn();
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-fixed', token: armed });
    streamer.triggerLive(`noise ${buildPhaseSignal('pr-fixed', stale)} [bx:unknown:abcdef123456]`);
    await flushMicrotasks();
    expect(staleWarnings(warn)).toHaveLength(1);
    expect(captured.some(e => e.type === 'pr.fix.submitted')).toBe(false);
    warn.mockRestore();
  });

  it('reports a foreign marker even when the PTY splits it across two live chunks', async () => {
    const warn = spyWarn();
    const { watcher, streamer } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-fixed', token: armed });
    const marker = buildPhaseSignal('pr-fixed', stale);
    const cut = Math.floor(marker.length / 2);
    streamer.triggerLive(marker.slice(0, cut));
    streamer.triggerLive(marker.slice(cut));
    await flushMicrotasks();
    const lines = staleWarnings(warn);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`observed=${stale}`);
    warn.mockRestore();
  });

  it('does not invent a foreign token from an OSC title split across chunks', async () => {
    const warn = spyWarn();
    const { watcher, streamer } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-fixed', token: armed });
    streamer.triggerLive('\x1b]0;');
    streamer.triggerLive(`${buildPhaseSignal('pr-fixed', stale)}\x07`);
    await flushMicrotasks();
    expect(staleWarnings(warn)).toHaveLength(0);
    warn.mockRestore();
  });

  it('reassembles a marker interrupted mid-stream by a complete OSC control string', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-fixed', token: armed });
    streamer.triggerLive('[bx:pr-\x1b]0;title');
    streamer.triggerLive(`\x07fixed:${armed}]`);
    await flushMicrotasks();
    expect(captured.some(e => e.type === 'pr.fix.submitted')).toBe(true);
  });

  it('logs a foreign token that precedes the armed marker in the same chunk', async () => {
    const warn = spyWarn();
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-fixed', token: armed });
    streamer.triggerLive(`${buildPhaseSignal('pr-fixed', stale)} ${buildPhaseSignal('pr-fixed', armed)}`);
    await flushMicrotasks();
    expect(staleWarnings(warn)).toHaveLength(1);
    expect(staleWarnings(warn)[0]).toContain(`observed=${stale}`);
    expect(captured.some(e => e.type === 'pr.fix.submitted')).toBe(true);
    warn.mockRestore();
  });

  it('does not log a foreign token that trails the armed marker in the same chunk', async () => {
    const warn = spyWarn();
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-fixed', token: armed });
    streamer.triggerLive(`${buildPhaseSignal('pr-fixed', armed)} ${buildPhaseSignal('pr-fixed', stale)}`);
    await flushMicrotasks();
    expect(captured.some(e => e.type === 'pr.fix.submitted')).toBe(true);
    expect(staleWarnings(warn)).toHaveLength(0);
    warn.mockRestore();
  });

  it('does not re-parse a complete OSC longer than the retained window as later output', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-fixed', token: armed });
    streamer.triggerLive(`\x1b]52;c;${'Q'.repeat(1400)}${buildPhaseSignal('pr-fixed', armed)}\x07`);
    streamer.triggerLive('ordinary later output');
    await flushMicrotasks();
    expect(captured).toHaveLength(0);
  });

  it('caps per-entry foreign-token warnings when the pane spews distinct tokens', async () => {
    const warn = spyWarn();
    const { watcher, streamer } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-fixed', token: armed });
    const churn = Array.from({ length: 40 }, (_, i) =>
      buildPhaseSignal('pr-fixed', `churntok${String(i).padStart(4, '0')}`)).join(' ');
    streamer.triggerLive(churn);
    await flushMicrotasks();
    expect(staleWarnings(warn)).toHaveLength(32);
    const capped = warn.mock.calls
      .map(call => String(call[0]))
      .filter(line => line.includes('capped foreign-token warnings'));
    expect(capped).toHaveLength(1);
    warn.mockRestore();
  });
});

describe('need-input ask/answer watermark', () => {
  const token = 'needtok12345';
  const wm = (epoch: number, askSeq: number, answeredSeq: number) => ({ epoch, askSeq, answeredSeq });
  const intent = (epoch: number, askSeq: number, answeredSeq: number) => ({
    agentId: DEV_AGENT.id, taskId: 't1', epoch, askSeq, answeredSeq,
  });

  it('lights once per seq ask and swallows replays (redraw immunity)', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(5, 0, 0) });
    streamer.triggerLive(`question?\n[bx:need-input:${token}:1]\n`);
    expect(commits).toEqual([intent(5, 1, 0)]);
    streamer.triggerLive(`redraw replay [bx:need-input:${token}:1]\n`);
    expect(commits).toEqual([intent(5, 1, 0)]);
  });

  it('bare ask lights when idle and is swallowed while lit', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(3, 0, 0) });
    streamer.triggerLive(`[bx:need-input:${token}]\n`);
    expect(commits).toEqual([intent(3, 1, 0)]);
    streamer.triggerLive(`[bx:need-input:${token}]\n`);
    expect(commits).toEqual([intent(3, 1, 0)]);
  });

  it('answer clears the open question; a stale answer for an older ask is swallowed', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(1, 0, 0) });
    streamer.triggerLive(`[bx:need-input:${token}:2]\n`);
    expect(commits).toEqual([intent(1, 2, 0)]);
    streamer.triggerLive(`[bx:input-received:${token}:1]\n`);
    expect(commits).toEqual([intent(1, 2, 0)]);
    streamer.triggerLive(`[bx:input-received:${token}:2]\n`);
    expect(commits).toEqual([intent(1, 2, 0), intent(1, 2, 2)]);
  });

  it('bare answer clears while lit and is swallowed when idle', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(1, 0, 0) });
    streamer.triggerLive(`[bx:input-received:${token}]\n`);
    expect(commits).toEqual([]);
    streamer.triggerLive(`[bx:need-input:${token}:1]\n`);
    streamer.triggerLive(`[bx:input-received:${token}]\n`);
    expect(commits).toEqual([intent(1, 1, 0), intent(1, 1, 1)]);
  });

  it('an answered edge drops the tail window so a windowed bare ask cannot re-fire', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(1, 0, 0) });
    streamer.triggerLive(`[bx:need-input:${token}]`);
    streamer.triggerLive(`[bx:input-received:${token}]\n`);
    expect(commits).toEqual([intent(1, 1, 0), intent(1, 1, 1)]);
    streamer.triggerLive('filler that would rescan a surviving tail window\n');
    expect(commits).toEqual([intent(1, 1, 0), intent(1, 1, 1)]);
    streamer.triggerLive(`[bx:need-input:${token}]\n`);
    expect(commits).toEqual([intent(1, 1, 0), intent(1, 1, 1), intent(1, 2, 1)]);
  });

  it('gap-A round trips: ask/answer pairs with interleaved replays never corrupt the watermark', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(2, 0, 0) });
    streamer.triggerLive(`[bx:need-input:${token}:1]\n`);
    streamer.triggerLive(`[bx:input-received:${token}:1]\n`);
    streamer.triggerLive(`[bx:need-input:${token}:1] replayed by a redraw\n`);
    streamer.triggerLive(`[bx:need-input:${token}:2]\n`);
    streamer.triggerLive(`[bx:input-received:${token}:1] stale replay\n`);
    streamer.triggerLive(`[bx:input-received:${token}:2]\n`);
    expect(commits).toEqual([
      intent(2, 1, 0), intent(2, 1, 1), intent(2, 2, 1), intent(2, 2, 2),
    ]);
  });

  it('ignores snapshot content for both ask and answer literals', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    streamer.setSnapshot(`[bx:need-input:${token}:1] [bx:input-received:${token}:1]`);
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(4, 2, 1) });
    expect(commits).toEqual([]);
    streamer.triggerLive(`[bx:input-received:${token}:2]\n`);
    expect(commits).toEqual([intent(4, 2, 2)]);
  });

  it('rearm ignores a leftover entry of another task so the store fallback still runs', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    await startWatch(watcher, {
      taskId: 'old-task', expectedKinds: 'pr-created', token, needInput: wm(1, 0, 0),
    });
    streamer.triggerLive(`[bx:need-input:${token}:1]\n`);
    expect(commits).toHaveLength(1);
    expect(await watcher.rearmNeedInput(DEV_AGENT.id)).toEqual(new Set(['old-task']));
  });

  it('a rotated token reads its own snapshot answer and ignores predecessor-token noise', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    const oldToken = 'oldtoken12345';
    const newToken = 'newtoken12345';
    streamer.setSnapshot(
      `old [bx:need-input:${oldToken}:1] old [bx:input-received:${oldToken}:1] `
      + `current [bx:need-input:${newToken}:1] current [bx:input-received:${newToken}:1]`,
    );
    await startWatch(watcher, {
      expectedKinds: 'pr-created', token: newToken, needInput: wm(3, 1, 0), needInputInherit: true,
    });
    expect(commits).toEqual([{
      agentId: DEV_AGENT.id, taskId: 't1', epoch: 3, askSeq: 1, answeredSeq: 1,
    }]);
  });

  it('without a replay the snapshot ordinals are this generation\'s own record', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    streamer.setSnapshot(`[bx:need-input:${token}:1] asked while nothing watched`);
    await startWatch(watcher, {
      expectedKinds: 'pr-created', token, needInput: wm(2, 0, 0), needInputInherit: true,
    });
    expect(commits).toEqual([intent(2, 1, 0)]);
  });

  it('an unanswered question stays open however the redraw arranged the rows', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    streamer.setSnapshot(
      `[bx:need-input:${token}:2] and above it on screen [bx:need-input:${token}:1]`,
    );
    await startWatch(watcher, {
      expectedKinds: 'pr-created', token, needInput: wm(2, 2, 1), needInputInherit: true,
    });
    expect(commits).toEqual([]);
  });

  it('reconciles asked-and-answered ordinals regardless of their screen order', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    streamer.setSnapshot(
      `[bx:input-received:${token}:2] then higher up [bx:need-input:${token}:3]`,
    );
    await startWatch(watcher, {
      expectedKinds: 'pr-created', token, needInput: wm(2, 2, 1), needInputInherit: true,
    });
    expect(commits).toEqual([intent(2, 3, 2)]);
  });

  it('a literal torn across the snapshot/live boundary still matches', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    streamer.setSnapshot(`question 1 open [bx:need-input:${token}:1] then [bx:input-`);
    await startWatch(watcher, {
      expectedKinds: 'pr-created', token, needInput: wm(2, 1, 0), needInputInherit: true,
    });
    expect(commits).toEqual([]);
    streamer.triggerLive(`received:${token}:1]\n`);
    expect(commits).toEqual([intent(2, 1, 1)]);
  });

  it('a seq-matched snapshot answer clears a persisted lit watermark (offline reply recovery)', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    streamer.setSnapshot(`agent replied while the server was down [bx:input-received:${token}:1]`);
    await startWatch(watcher, {
      expectedKinds: 'pr-created', token, needInput: wm(2, 1, 0), needInputInherit: true,
    });
    expect(commits).toEqual([intent(2, 1, 1)]);
  });

  it('reconciles an offline answer followed by a new question in the same snapshot', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    streamer.setSnapshot(
      `[bx:input-received:${token}:1] follow-up question [bx:need-input:${token}:2]`,
    );
    await startWatch(watcher, {
      expectedKinds: 'pr-created', token, needInput: wm(2, 1, 0), needInputInherit: true,
    });
    expect(commits).toEqual([intent(2, 2, 1)]);
  });

  it('an answer redrawn above its own question still clears the badge', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    streamer.setSnapshot(
      `[bx:input-received:${token}:1] ...rows below... [bx:need-input:${token}:1]`,
    );
    await startWatch(watcher, {
      expectedKinds: 'pr-created', token, needInput: wm(2, 1, 0), needInputInherit: true,
    });
    expect(commits).toEqual([intent(2, 1, 1)]);
  });

  it('a fresh arm stays blind to snapshot history (its prompt supersedes it)', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    streamer.setSnapshot(`[bx:need-input:${token}:3] from the aborted runtime`);
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(2, 0, 0) });
    expect(commits).toEqual([]);
  });

  it('a failed fresh arm rescues the predecessor without re-committing its stale question', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(1, 0, 0) });
    streamer.triggerLive(`[bx:need-input:${token}:3]\n`);
    expect(commits).toEqual([intent(1, 3, 0)]);
    streamer.failNextSubscribe();
    expect(await startWatch(watcher, {
      expectedKinds: 'pr-created', token, needInput: wm(2, 0, 0), skipSnapshot: true,
    })).toBe(false);
    expect(commits).toEqual([intent(1, 3, 0)]);
    streamer.triggerLive(`[bx:need-input:${token}:1]\n`);
    expect(commits).toEqual([intent(1, 3, 0), intent(2, 1, 0)]);
  });

  it('a failed cross-token hand-off leaves the predecessor on its old epoch', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    const oldToken = 'oldtoken12345';
    const newToken = 'newtoken12345';
    await startWatch(watcher, { expectedKinds: 'pr-created', token: oldToken, needInput: wm(1, 0, 0) });
    streamer.triggerLive(`[bx:need-input:${oldToken}:1]\n`);
    const claim = watcher.claimArm({
      taskId: 't1', agentId: DEV_AGENT.id, token: newToken, replaceFromToken: oldToken,
      onlyReplaceOwnToken: true, replaceScope: 'agent',
    });
    streamer.failNextSubscribe();

    expect(await startWatch(watcher, {
      expectedKinds: 'pr-created', token: newToken, needInput: wm(2, 0, 0),
      replaceFromToken: oldToken, onlyReplaceOwnToken: true, replaceScope: 'agent',
      armClaimId: claim!, skipSnapshot: true,
    })).toBe(false);
    watcher.releaseArm(claim);
    streamer.triggerLive(`[bx:need-input:${oldToken}:2]\n`);

    expect(commits).toEqual([intent(1, 1, 0), intent(1, 2, 0)]);
  });

  it('bare and stale-seq snapshot answers stay blind', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    streamer.setSnapshot(`[bx:input-received:${token}] [bx:input-received:${token}:1]`);
    await startWatch(watcher, {
      expectedKinds: 'pr-created', token, needInput: wm(2, 2, 1), needInputInherit: true,
    });
    expect(commits).toEqual([]);
  });

  it('ignores literals with a foreign token', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(1, 0, 0) });
    streamer.triggerLive('[bx:need-input:othertok9999:1]\n[bx:input-received:othertok9999:1]\n');
    expect(commits).toEqual([]);
  });

  it('matches literals torn across chunks', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(1, 0, 0) });
    streamer.triggerLive('[bx:need-');
    streamer.triggerLive(`input:${token}:1]\n`);
    expect(commits).toEqual([intent(1, 1, 0)]);
  });

  it('restore state swallows pre-restart replays and accepts the live answer', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(7, 2, 1) });
    streamer.triggerLive(`[bx:need-input:${token}:1] redraw of the answered ask\n`);
    streamer.triggerLive(`[bx:input-received:${token}:1] redraw of the old answer\n`);
    expect(commits).toEqual([]);
    streamer.triggerLive(`[bx:input-received:${token}:2]\n`);
    expect(commits).toEqual([intent(7, 2, 2)]);
  });

  it('an answer swallowed while idle cannot replay against a later ask (split chunks)', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(1, 0, 0) });
    streamer.triggerLive(`[bx:input-received:${token}:1]\n`);
    expect(commits).toEqual([]);
    streamer.triggerLive(`[bx:need-input:${token}:1]\n`);
    expect(commits).toEqual([intent(1, 1, 0)]);
    streamer.triggerLive('more output rescans the tail window\n');
    expect(commits).toEqual([intent(1, 1, 0)]);
  });

  it('document order rules one chunk: an answer BEFORE an ask does not clear it', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(1, 0, 0) });
    streamer.triggerLive(`[bx:input-received:${token}:1] then [bx:need-input:${token}:1]\n`);
    expect(commits).toEqual([intent(1, 1, 0)]);
  });

  it('a consumed answer keeps a torn next-ask prefix alive across chunks', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(1, 1, 0) });
    streamer.triggerLive(`[bx:input-received:${token}:1]\n[bx:need-`);
    expect(commits).toEqual([intent(1, 1, 1)]);
    streamer.triggerLive(`input:${token}:2]\n`);
    expect(commits).toEqual([intent(1, 1, 1), intent(1, 2, 1)]);
  });

  it('the phase signal closes the open question', async () => {
    const { watcher, streamer, captured, commits } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(1, 0, 0) });
    streamer.triggerLive(`[bx:need-input:${token}:1]\n`);
    streamer.triggerLive('y'.repeat(2000));
    streamer.triggerLive(`[bx:pr-created:7:${token}]\n`);
    expect(captured).toHaveLength(1);
    expect(commits).toEqual([intent(1, 1, 0), intent(1, 1, 1)]);
  });

  it('a phase signal with nothing open commits no clear', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(1, 0, 0) });
    streamer.triggerLive(`[bx:pr-created:7:${token}]\n`);
    expect(commits).toEqual([]);
  });

  it('session-gone closes the open question', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(1, 0, 0) });
    streamer.triggerLive(`[bx:need-input:${token}:1]\n`);
    streamer.triggerSessionGone();
    expect(commits).toEqual([intent(1, 1, 0), intent(1, 1, 1)]);
  });

  it('rearmNeedInput answers the open question and settles its commit', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(1, 0, 0) });
    streamer.triggerLive(`[bx:need-input:${token}:1]\n`);
    await watcher.rearmNeedInput(DEV_AGENT.id);
    expect(commits).toEqual([intent(1, 1, 0), intent(1, 1, 1)]);
    await watcher.rearmNeedInput(DEV_AGENT.id);
    expect(commits).toEqual([intent(1, 1, 0), intent(1, 1, 1)]);
  });

  it('a restore replacement merges the evicted entry watermark and persists any lead at once', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(1, 0, 0) });
    streamer.triggerLive(`[bx:need-input:${token}:3]\n`);
    expect(commits).toEqual([intent(1, 3, 0)]);
    streamer.triggerLive(`[bx:input-received:${token}:3]\n`);
    expect(commits).toEqual([intent(1, 3, 0), intent(1, 3, 3)]);
    await startWatch(watcher, {
      expectedKinds: 'pr-created', token, needInput: wm(2, 3, 0), needInputInherit: true,
    });
    expect(commits).toEqual([
      intent(1, 3, 0), intent(1, 3, 3), intent(2, 3, 3), intent(2, 3, 3),
    ]);
    streamer.triggerLive(`[bx:need-input:${token}:3] replay must stay swallowed\n`);
    expect(commits).toEqual([
      intent(1, 3, 0), intent(1, 3, 3), intent(2, 3, 3), intent(2, 3, 3),
    ]);
  });

  it('a fresh replacement does not inherit ordinals: the replayed prompt lights from 1 again', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(1, 0, 0) });
    streamer.triggerLive(`[bx:need-input:${token}:3]\n`);
    expect(commits).toEqual([intent(1, 3, 0)]);
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(2, 0, 0) });
    streamer.triggerLive(`[bx:need-input:${token}:1]\n`);
    expect(commits).toEqual([intent(1, 3, 0), intent(2, 1, 0)]);
  });

  it('a failed arm hands its generation to the entry it started against (and persists its lead)', async () => {
    const { watcher, streamer, commits, setCommitResult } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(1, 0, 0) });
    setCommitResult('error');
    streamer.triggerLive(`[bx:need-input:${token}:1]\n`);
    expect(commits).toEqual([intent(1, 1, 0)]);
    setCommitResult('ok');
    streamer.failNextSubscribe();
    expect(await startWatch(watcher, {
      expectedKinds: 'pr-created', token, needInput: wm(2, 0, 0),
      needInputInherit: true, skipSnapshot: true,
    })).toBe(false);
    expect(commits).toEqual([intent(1, 1, 0), intent(2, 1, 0)]);
    streamer.triggerLive(`[bx:input-received:${token}:1]\n`);
    expect(commits).toEqual([intent(1, 1, 0), intent(2, 1, 0), intent(2, 1, 1)]);
  });

  it('a successor that bumped but failed to subscribe still fences the late older arm', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    const gate = streamer.holdNextSubscribe();
    const lateP = startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(1, 0, 0) });
    streamer.failNextSubscribe();
    expect(await startWatch(watcher, {
      expectedKinds: 'pr-created', token, needInput: wm(2, 0, 0), skipSnapshot: true,
    })).toBe(false);
    gate.release();
    expect(await lateP).toBe(false);
    expect(watcher.has('t1', DEV_AGENT.id)).toBe(false);
    streamer.triggerLive(`[bx:need-input:${token}:1]\n`);
    expect(commits).toEqual([]);
  });

  it('a degraded successor install fences the late older arm by arrival order', async () => {
    const { watcher, streamer } = makeWatcher();
    const gate = streamer.holdNextSubscribe();
    const lateP = startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(1, 0, 0) });
    expect(await startWatch(watcher, {
      expectedKinds: 'pr-created', token: 'tokDEGRADED12', skipSnapshot: true,
    })).toBe(true);
    gate.release();
    expect(await lateP).toBe(false);
    expect(watcher.has('t1', DEV_AGENT.id)).toBe(true);
  });

  it('a doomed stale arm is rejected before it can tear down a live sibling watcher', async () => {
    const { watcher, streamers, captured } = makeDualWatcher();
    await watcher.start({
      taskId: 't1', projectId: 'p1', agentId: DEV_AGENT.id,
      expectedKinds: 'pr-created', token: 'tokDEV1234567',
      needInput: { epoch: 3, askSeq: 0, answeredSeq: 0 },
    });
    streamers[DEV_AGENT.id].triggerLive('[bx:pr-created:7:tokDEV1234567]\n');
    expect(watcher.has('t1', DEV_AGENT.id)).toBe(false);
    await watcher.start({
      taskId: 't1', projectId: 'p1', agentId: QA_AGENT.id,
      expectedKinds: 'pr-fixed', token: 'tokQA12345678',
      needInput: { epoch: 1, askSeq: 0, answeredSeq: 0 },
    });
    expect(await watcher.start({
      taskId: 't1', projectId: 'p1', agentId: DEV_AGENT.id,
      expectedKinds: 'pr-created', token: 'tokSTALE12345', skipSnapshot: true,
      needInput: { epoch: 2, askSeq: 0, answeredSeq: 0 },
    })).toBe(false);
    expect(watcher.has('t1', QA_AGENT.id)).toBe(true);
    streamers[QA_AGENT.id].triggerLive('[bx:pr-fixed:tokQA12345678]\n');
    expect(captured.some(e => e.type === 'pr.fix.submitted')).toBe(true);
  });

  it('a degraded fresh arm restarts ordinals so the new prompt cannot be swallowed', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(1, 0, 0) });
    streamer.triggerLive(`[bx:need-input:${token}:3]\n`);
    expect(commits).toEqual([intent(1, 3, 0)]);
    expect(await startWatch(watcher, {
      expectedKinds: 'pr-created', token, skipSnapshot: true,
    })).toBe(true);
    streamer.triggerLive(`[bx:need-input:${token}:1]\n`);
    expect(commits).toEqual([intent(1, 3, 0)]);
    expect(await startWatch(watcher, {
      expectedKinds: 'pr-created', token, needInput: wm(2, 0, 0), needInputInherit: true, skipSnapshot: true,
    })).toBe(true);
    expect(commits).toEqual([intent(1, 3, 0), intent(2, 1, 0), intent(2, 1, 0)]);
  });

  it('a torn OSC across chunks does not shift new literals into the old region', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(1, 0, 0) });
    streamer.triggerLive(`\x1b]0;${'x'.repeat(80)}`);
    streamer.triggerLive(`\x07[bx:need-input:${token}:1]\n`);
    expect(commits).toEqual([intent(1, 1, 0)]);
  });

  it('a failed older arm never demotes the generation of the entry it rescues', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(3, 0, 0) });
    streamer.failNextSubscribe();
    expect(await startWatch(watcher, {
      expectedKinds: 'pr-created', token, needInput: wm(2, 0, 0), skipSnapshot: true,
    })).toBe(false);
    streamer.triggerLive(`[bx:need-input:${token}:1]\n`);
    expect(commits).toEqual([intent(3, 1, 0)]);
  });

  it('a late same-token start with an older generation is rejected, keeping the successor', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(3, 0, 0) });
    expect(await startWatch(watcher, {
      expectedKinds: 'pr-created', token, needInput: wm(2, 0, 0), skipSnapshot: true,
    })).toBe(false);
    streamer.triggerLive(`[bx:need-input:${token}:1]\n`);
    expect(commits).toEqual([intent(3, 1, 0)]);
  });

  it('a late arm does not re-enable a degraded successor that replaced its predecessor', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(1, 3, 2) });
    const gate = streamer.holdNextSubscribe();
    const lateP = startWatch(watcher, {
      expectedKinds: 'pr-created', token, needInput: wm(2, 3, 2), needInputInherit: true, skipSnapshot: true,
    });
    expect(await startWatch(watcher, {
      expectedKinds: 'pr-created', token, skipSnapshot: true,
    })).toBe(true);
    gate.release();
    expect(await lateP).toBe(false);
    commits.length = 0;
    streamer.triggerLive(`[bx:need-input:${token}:1]\n`);
    expect(commits).toEqual([]);
  });

  it('a claimed but not yet installed foreign token already owns the fence', async () => {
    const { watcher } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(1, 0, 0) });
    const claim = watcher.claimArm({ taskId: 't1', agentId: DEV_AGENT.id, token: 'tokNEW1234567' });
    expect(claim).not.toBeNull();
    expect(watcher.claimArm({
      taskId: 't1', agentId: DEV_AGENT.id, token, onlyReplaceOwnToken: true,
    })).toBeNull();
    expect(watcher.wouldRejectOwnTokenArm({
      taskId: 't1', agentId: DEV_AGENT.id, token, onlyReplaceOwnToken: true,
    })).toBe(true);
    watcher.releaseArm(claim);
    expect(watcher.wouldRejectOwnTokenArm({
      taskId: 't1', agentId: DEV_AGENT.id, token, onlyReplaceOwnToken: true,
    })).toBe(false);
  });

  it('an arm never fences itself out on its own claim', async () => {
    const { watcher, streamer, commits } = makeWatcher();
    const claim = watcher.claimArm({
      taskId: 't1', agentId: DEV_AGENT.id, token, onlyReplaceOwnToken: true,
    });
    expect(claim).not.toBeNull();
    expect(await startWatch(watcher, {
      expectedKinds: 'pr-created', token, needInput: wm(1, 0, 0),
      onlyReplaceOwnToken: true, armClaimId: claim ?? undefined,
    })).toBe(true);
    streamer.triggerLive(`[bx:need-input:${token}:1]\n`);
    expect(commits).toEqual([intent(1, 1, 0)]);
  });

  it('wouldRejectOwnTokenArm mirrors the own-token fence without touching entries', async () => {
    const { watcher } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(1, 0, 0) });
    expect(watcher.wouldRejectOwnTokenArm({
      taskId: 't1', agentId: DEV_AGENT.id, token: 'othertok9999', onlyReplaceOwnToken: true,
    })).toBe(true);
    expect(watcher.wouldRejectOwnTokenArm({
      taskId: 't1', agentId: DEV_AGENT.id, token, onlyReplaceOwnToken: true,
    })).toBe(false);
    expect(watcher.wouldRejectOwnTokenArm({
      taskId: 't1', agentId: DEV_AGENT.id, token: 'othertok9999',
    })).toBe(false);
    expect(watcher.has('t1', DEV_AGENT.id)).toBe(true);
  });

  it('a failed commit does not roll back memory seqs', async () => {
    const { watcher, streamer, commits, setCommitResult } = makeWatcher();
    setCommitResult(new Error('store down'));
    await startWatch(watcher, { expectedKinds: 'pr-created', token, needInput: wm(1, 0, 0) });
    streamer.triggerLive(`[bx:need-input:${token}:1]\n`);
    await flushMicrotasks();
    setCommitResult('ok');
    streamer.triggerLive(`[bx:need-input:${token}:1] replay still swallowed\n`);
    expect(commits).toEqual([intent(1, 1, 0)]);
    streamer.triggerLive(`[bx:input-received:${token}:1]\n`);
    expect(commits).toEqual([intent(1, 1, 0), intent(1, 1, 1)]);
  });
});

describe('PhaseSignalWatcher.awaitOnce (bootstrap greeting)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves "matched" when the pane echoes the greeting with the right token', async () => {
    const { watcher, streamer } = makeWatcher();
    const token = 'greet12345678';
    const p = watcher.awaitOnce({ agentId: DEV_AGENT.id, kind: 'greeting', token, timeoutMs: 1000 });
    await flushMicrotasks();
    streamer.triggerLive(`hi\n${buildPhaseSignal('greeting', token)}\n`);
    expect(await p).toBe('matched');
    expect(streamer.unsubscribed).toBe(true);
  });

  it('matches a greeting split across two pane chunks', async () => {
    const { watcher, streamer } = makeWatcher();
    const token = 'splittok12345';
    const full = buildPhaseSignal('greeting', token);
    const cut = Math.floor(full.length / 2);
    const p = watcher.awaitOnce({ agentId: DEV_AGENT.id, kind: 'greeting', token, timeoutMs: 1000 });
    await flushMicrotasks();
    streamer.triggerLive(full.slice(0, cut));
    streamer.triggerLive(full.slice(cut));
    expect(await p).toBe('matched');
  });

  it('matches a greeting in a large snapshot even when >1KB of text trails it', async () => {
    const { watcher, streamer } = makeWatcher();
    const token = 'snaptok123456';
    streamer.setSnapshot(`${buildPhaseSignal('greeting', token)}\n${'x'.repeat(4000)}`);
    const p = watcher.awaitOnce({ agentId: DEV_AGENT.id, kind: 'greeting', token, timeoutMs: 1000 });
    expect(await p).toBe('matched');
  });

  it('ignores a greeting echo carrying a different token (waits, then times out)', async () => {
    const { watcher, streamer } = makeWatcher();
    const p = watcher.awaitOnce({ agentId: DEV_AGENT.id, kind: 'greeting', token: 'righttoken12', timeoutMs: 40 });
    await flushMicrotasks();
    streamer.triggerLive(buildPhaseSignal('greeting', 'wrongtoken99'));
    expect(await p).toBe('timeout');
  });

  it('resolves "timeout" when no greeting arrives within timeoutMs', async () => {
    const { watcher } = makeWatcher();
    const outcome = await watcher.awaitOnce({
      agentId: DEV_AGENT.id, kind: 'greeting', token: 'tok1234abcd', timeoutMs: 30,
    });
    expect(outcome).toBe('timeout');
  });

  it('resolves "session-gone" when the pane session ends before the greeting', async () => {
    const { watcher, streamer } = makeWatcher();
    const p = watcher.awaitOnce({ agentId: DEV_AGENT.id, kind: 'greeting', token: 'tok1234abcd', timeoutMs: 1000 });
    await flushMicrotasks();
    streamer.triggerSessionGone();
    expect(await p).toBe('session-gone');
  });

  it('resolves "no-agent" when the agent cannot be resolved', async () => {
    const { watcher } = makeWatcher();
    const outcome = await watcher.awaitOnce({
      agentId: 'ghost', kind: 'greeting', token: 'tok1234abcd', timeoutMs: 1000,
    });
    expect(outcome).toBe('no-agent');
  });
});

describe('PhaseSignalWatcher terminal-control semantics', () => {
  const ESC = '\x1b';
  const BEL = '\x07';
  const TOKEN = 'tok123abc456';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['an OSC cancelled by a CSI', (m: string) => `${ESC}]0;title${ESC}[31m${m}${BEL}`],
    ['an OSC cancelled by CAN', (m: string) => `${ESC}]0;title\x18${m}${BEL}`],
    ['an OSC cancelled by SUB', (m: string) => `${ESC}]0;title\x1a${m}${BEL}`],
    ['a marker torn by an 8-bit CSI', (m: string) => m.replace('spec-', `spec-\x9b31m`)],
    ['a marker torn by a 7-bit SGR', (m: string) => m.replace('spec-', `spec-${ESC}[31m`)],
  ])('fires on a marker the terminal displays after %s', async (_name, wrap) => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: TOKEN });
    streamer.triggerLive(`${wrap(buildPhaseSignal('spec-done', TOKEN, 42))}\n`);
    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe('spec.ready');
  });

  it.each([
    ['an OSC closed by an 8-bit ST', (m: string) => `${ESC}]0;${m}\x9c`],
    ['an 8-bit OSC introducer', (m: string) => `\x9d0;${m}\x9c`],
    ['an APC string', (m: string) => `${ESC}_${m}${ESC}\\`],
    ['a PM string', (m: string) => `${ESC}^${m}${ESC}\\`],
    ['a DCS string', (m: string) => `${ESC}P${m}${ESC}\\`],
  ])('stays armed when the marker is hidden inside %s', async (_name, wrap) => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: TOKEN });
    streamer.triggerLive(`${wrap(buildPhaseSignal('spec-done', TOKEN, 42))}\n`);
    expect(captured).toHaveLength(0);
    expect(watcher.has('t1', DEV_AGENT.id)).toBe(true);
  });

  it('does not fire on a marker inside a control string torn across chunks', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: TOKEN });
    streamer.triggerLive(`${ESC}]0;`);
    streamer.triggerLive(buildPhaseSignal('spec-done', TOKEN, 42));
    streamer.triggerLive(BEL);
    expect(captured).toHaveLength(0);
    expect(watcher.has('t1', DEV_AGENT.id)).toBe(true);
  });

  it('does not fire when the control string opened before the watcher armed', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    streamer.triggerLive(`${ESC}]0;title-start`);
    await startWatch(watcher, { expectedKinds: 'spec-done', token: TOKEN });
    streamer.triggerLive(`${buildPhaseSignal('spec-done', TOKEN, 42)}${BEL}`);
    expect(captured).toHaveLength(0);
    expect(watcher.has('t1', DEV_AGENT.id)).toBe(true);

    streamer.triggerLive(`${buildPhaseSignal('spec-done', TOKEN, 42)}\n`);
    expect(captured).toHaveLength(1);
  });

  it('ignores a need-input literal hidden in an APC string', async () => {
    const { watcher, streamer } = makeWatcher();
    await startWatch(watcher, {
      expectedKinds: 'spec-done',
      token: TOKEN,
      needInput: { epoch: 1, askSeq: 0, answeredSeq: 0 },
    });
    streamer.triggerLive(`${ESC}_[bx:need-input:${TOKEN}:1]${ESC}\\`);
    expect(watcher.has('t1', DEV_AGENT.id)).toBe(true);

    streamer.triggerLive(`[bx:need-input:${TOKEN}:1]\n`);
    expect(watcher.has('t1', DEV_AGENT.id)).toBe(true);
  });

  it('stays armed when a backspace rewrote the marker off the screen', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: TOKEN });
    streamer.triggerLive(`[bx:spec-\x08done:${TOKEN}]\n`);
    expect(captured).toHaveLength(0);
    expect(watcher.has('t1', DEV_AGENT.id)).toBe(true);

    streamer.triggerLive(`${buildPhaseSignal('spec-done', TOKEN, 42)}\n`);
    expect(captured).toHaveLength(1);
  });

  it.each([
    ['G1 = DEC graphics with SO/SI', (t: string) => `[bx:spec-\x1b)0\x0edone\x0f:${t}]`],
    ['G0 = DEC graphics', (t: string) => `\x1b(0[bx:spec-done:42:${t}]`],
    ['G2 = DEC graphics locked in with LS2', (t: string) => `\x1b*0\x1bn[bx:spec-done:42:${t}]`],
    ['G3 = DEC graphics locked in with LS3', (t: string) => `\x1b+0\x1bo[bx:spec-done:42:${t}]`],
  ])('stays armed when %s rewrote the marker', async (_name, wrap) => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: TOKEN });
    streamer.triggerLive(`${wrap(TOKEN)}\n`);
    expect(captured).toHaveLength(0);
    expect(watcher.has('t1', DEV_AGENT.id)).toBe(true);

    streamer.triggerLive(`\x0f\x1b(B${buildPhaseSignal('spec-done', TOKEN, 42)}\n`);
    expect(captured).toHaveLength(1);
  });

  it.each([
    ['DECRC restores a graphics set saved earlier',
      (t: string) => `\x1b(0\x1b7\x1b(B[bx:spec-\x1b8done:${t}]`],
    ['RIS wipes the first half off the screen', (t: string) => `[bx:spec-\x1bcdone:${t}]`],
    ['DECALN wipes the first half off the screen', (t: string) => `[bx:spec-\x1b#8done:${t}]`],
  ])('stays armed when %s', async (_name, wrap) => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: TOKEN });
    streamer.triggerLive(`${wrap(TOKEN)}\n`);
    expect(captured).toHaveLength(0);
    expect(watcher.has('t1', DEV_AGENT.id)).toBe(true);
  });

  it.each([
    ['a CR inside an 8-bit SGR', (t: string) => `[bx:spec-\x9b\r31mdone:${t}]`],
    ['a CR inside an 8-bit CSI that leaves through csiIgnore', (t: string) => `[bx:spec-\x9b1?\rmdone:${t}]`],
    ['a CR inside a 7-bit CSI', (t: string) => `[bx:spec-\x1b[\r31mdone:${t}]`],
    ['RI moving the tail above the prefix', (t: string) => `\n[bx:spec-\x1bMdone:${t}]`],
    ['conceal hiding the tail', (t: string) => `[bx:spec-\x1b[8mdone:${t}]`],
    ['conceal surviving an extended-colour payload', (t: string) => `\x1b[8m\x1b[38;5;28m[bx:spec-done:42:${t}]`],
  ])('stays armed when the pane only looks complete because of %s', async (_name, wrap) => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: TOKEN });
    streamer.triggerLive(`${wrap(TOKEN)}\n`);
    expect(captured).toHaveLength(0);
    expect(watcher.has('t1', DEV_AGENT.id)).toBe(true);
  });

  it('still completes once the tail is revealed again', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: TOKEN });
    streamer.triggerLive(`\x1b[8m\x1b[28m${buildPhaseSignal('spec-done', TOKEN, 42)}\n`);
    expect(captured).toHaveLength(1);
  });

  it.each([
    ['RIS', '\x1bc'],
    ['DECSTR', '\x1b[!p'],
  ])('completes again once %s puts the terminal back on US-ASCII', async (_name, reset) => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: TOKEN });
    streamer.triggerLive(`\x1b(0${reset}${buildPhaseSignal('spec-done', TOKEN, 42)}\n`);
    expect(captured).toHaveLength(1);
  });

  it('stays armed when an unrecognised designation leaves the graphics set in place', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: TOKEN });
    streamer.triggerLive(`[bx:spec-\x1b(0\x1b(Xdone:${TOKEN}]\n`);
    expect(captured).toHaveLength(0);
    expect(watcher.has('t1', DEV_AGENT.id)).toBe(true);
  });

  it('completes when RIS clears the saved charset a later DECRC would have restored', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: TOKEN });
    streamer.triggerLive(`\x1b(0\x1b7\x1bc\x1b8${buildPhaseSignal('spec-done', TOKEN, 42)}\n`);
    expect(captured).toHaveLength(1);
  });

  it('stays armed when a GR designation arms a later shift', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: TOKEN });
    streamer.triggerLive(`\x1b-0\x0e${buildPhaseSignal('spec-done', TOKEN, 42)}\n`);
    expect(captured).toHaveLength(0);
    expect(watcher.has('t1', DEV_AGENT.id)).toBe(true);
  });

  it('completes when a leading-zero mode number re-saves the ASCII charset', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: TOKEN });
    streamer.triggerLive(
      `\x1b(0\x1b[?1048h\x1b(B\x1b[?01048h\x1b[?1048l${buildPhaseSignal('spec-done', TOKEN, 42)}\n`,
    );
    expect(captured).toHaveLength(1);
  });

  it.each([
    ['a sub-parameter leaves the primary intact', '\x1b[?1049:0h', '\x1b[?1049:0l'],
    ['capacity counts parameters, not characters',
      '\x1b[?1048;1;2;3;4;5;6;7;8;9;10;11;12;13;14h', '\x1b[?1048;1;2;3;4;5;6;7;8;9;10;11;12;13;14l'],
  ])('stays armed when %s', async (_name, enter, leave) => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: TOKEN });
    streamer.triggerLive(`\x1b(0${enter}\x1b(B${leave}${buildPhaseSignal('spec-done', TOKEN, 42)}\n`);
    expect(captured).toHaveLength(0);
    expect(watcher.has('t1', DEV_AGENT.id)).toBe(true);
  });

  it('stays armed when CSI ?2h leaves the saved charset for a later DECRC', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: TOKEN });
    streamer.triggerLive(`\x1b(0\x1b7\x1b[?2h[bx:spec-\x1b8done:${TOKEN}]\n`);
    expect(captured).toHaveLength(0);
    expect(watcher.has('t1', DEV_AGENT.id)).toBe(true);
  });

  it.each([
    ['a > prefix is not a DEC private mode', '>'],
    ['a < prefix is not a DEC private mode', '<'],
    ['an = prefix is not a DEC private mode', '='],
  ])('completes despite %s', async (_name, prefix) => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: TOKEN });
    streamer.triggerLive(
      `\x1b(0\x1b[${prefix}1049h\x1b(B\x1b[${prefix}1049l${buildPhaseSignal('spec-done', TOKEN, 42)}\n`,
    );
    expect(captured).toHaveLength(1);
  });

  it('completes when a save taken across a ?47 buffer switch is not read back', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: TOKEN });
    streamer.triggerLive(
      `\x1b(0\x1b[?47h\x1b7\x1b(B\x1b[?47l\x1b8${buildPhaseSignal('spec-done', TOKEN, 42)}\n`,
    );
    expect(captured).toHaveLength(1);
  });

  it('stays armed when leaving the alternate screen restores the graphics set', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: TOKEN });
    streamer.triggerLive(`\x1b(0\x1b[?1049h\x1b(B\x1b[?1049l${buildPhaseSignal('spec-done', TOKEN, 42)}\n`);
    expect(captured).toHaveLength(0);
    expect(watcher.has('t1', DEV_AGENT.id)).toBe(true);
  });

  it('completes when a shift after DECRC reloads the ASCII slot', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: TOKEN });
    streamer.triggerLive(`\x1b(0\x1b7\x1b(B\x1b8\x0f${buildPhaseSignal('spec-done', TOKEN, 42)}\n`);
    expect(captured).toHaveLength(1);
  });

  it('stays armed when a multi-intermediate CSI is mistaken for DECSTR', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: TOKEN });
    streamer.triggerLive(`[bx:spec-\x1b(0\x1b[!!pdone:${TOKEN}]\n`);
    expect(captured).toHaveLength(0);
    expect(watcher.has('t1', DEV_AGENT.id)).toBe(true);
  });

  it('stays armed when an unrecognised ESC % final leaves the graphics set in place', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: TOKEN });
    streamer.triggerLive(`[bx:spec-\x1b(0\x1b%Xdone:${TOKEN}]\n`);
    expect(captured).toHaveLength(0);
    expect(watcher.has('t1', DEV_AGENT.id)).toBe(true);

    streamer.triggerLive(`\x1b%G${buildPhaseSignal('spec-done', TOKEN, 42)}\n`);
    expect(captured).toHaveLength(1);
  });

  it('completes when ESC %G selects the default without disturbing G1', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: TOKEN });
    streamer.triggerLive(`\x1b(0\x1b%G${buildPhaseSignal('spec-done', TOKEN, 42)}\n`);
    expect(captured).toHaveLength(1);
  });

  it('completes on a marker a partially-remapping charset leaves intact', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: TOKEN });
    streamer.triggerLive(`\x1b(A${buildPhaseSignal('spec-done', TOKEN, 42)}\n`);
    expect(captured).toHaveLength(1);
  });

  it('still fires across controls the terminal renders as nothing (BEL/NUL/CAN/DEL)', async () => {
    for (const control of ['\x07', '\x00', '\x18', '\x7f']) {
      const { watcher, streamer, captured } = makeWatcher();
      await startWatch(watcher, { expectedKinds: 'pr-fixed', token: TOKEN });
      streamer.triggerLive(`[bx:pr-${control}fixed:${TOKEN}]\n`);
      expect(captured, `control ${JSON.stringify(control)}`).toHaveLength(1);
    }
  });

});
