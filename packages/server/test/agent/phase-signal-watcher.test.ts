import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PhaseSignalWatcher } from '../../src/agent/phase-signal-watcher.js';
import { buildPhaseSignal, buildPhaseSignalTemplate, type PhaseSignalKind } from '../../src/agent/phase-signal.js';
import type { AgentConfig, BaxianEvent, EventType } from '../../src/shared/index.js';
import type { EventBus } from '../../src/event/bus.js';
import type { PaneStreamerManager } from '../../src/agent/pane-streamer-manager.js';
import type { SubscriberCallbacks } from '../../src/agent/pane-streamer.js';

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
  unsubscribed: boolean;
}

function createFakeStreamer(): FakeStreamer {
  let live: SubscriberCallbacks['onLive'] | undefined;
  let sessionGone: SubscriberCallbacks['onSessionGone'] | undefined;
  let snapshotData = '';
  const state: FakeStreamer = {
    unsubscribed: false,
    triggerLive: (data: string) => live?.(data),
    triggerSessionGone: () => sessionGone?.(),
    setSnapshot: (data: string) => { snapshotData = data; },
    subscribeAtomic: vi.fn(async (cbs: SubscriberCallbacks) => {
      live = cbs.onLive;
      sessionGone = cbs.onSessionGone;
      return {
        snapshot: { data: snapshotData },
        unsubscribe: () => {
          state.unsubscribed = true;
          live = undefined;
          sessionGone = undefined;
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
  const watcher = new PhaseSignalWatcher({
    paneStreamerManager,
    eventBus,
    resolveAgent: (id) => (id === DEV_AGENT.id ? DEV_AGENT : undefined),
  });
  const captured: BaxianEvent[] = [];
  emit.mockImplementation(async (event: BaxianEvent) => {
    captured.push(event);
  });
  return { watcher, streamer, emit, captured };
}

describe('PhaseSignalWatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits the configured event type when a single-kind signal matches', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    const token = 'tok123abc456';
    await startWatch(watcher, { expectedKinds: 'spec-done', token });
    streamer.triggerLive(`${buildPhaseSignal('spec-done', token)}\n`);
    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe('server.spec.ready');
    expect(captured[0].data).toMatchObject({
      kind: 'spec-done',
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
    const armed = await startWatch(watcher, { expectedKinds: 'pr-approved', token: 'tok123abc456' });
    expect(armed).toBe(false);
    expect(watcher.has('t1')).toBe(false);
  });

  it('multi-kind verdict watch: pr-approved match fires review.submitted', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    const token = 'verdict12345';
    await startWatch(watcher, { expectedKinds: ['pr-approved', 'pr-changes-requested'], token });
    streamer.triggerLive(`${buildPhaseSignal('pr-approved', token)}\n`);
    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe('review.submitted');
    expect(captured[0].data).toMatchObject({
      kind: 'pr-approved',
      token,
      source: 'pane-signal',
      action: 'APPROVE',
    });
  });

  it('multi-kind verdict watch: pr-changes-requested also fires review.submitted', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    const token = 'verdict67890';
    await startWatch(watcher, {
      expectedKinds: new Set<'pr-approved' | 'pr-changes-requested'>([
        'pr-approved',
        'pr-changes-requested',
      ]),
      token,
    });
    streamer.triggerLive(`${buildPhaseSignal('pr-changes-requested', token)}\n`);
    expect(captured).toHaveLength(1);
    expect(captured[0].data).toMatchObject({
      kind: 'pr-changes-requested',
      action: 'REQUEST_CHANGES',
    });
  });

  it('ignores a signal whose kind is outside expectedKinds', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    const token = 'tokenABCDEF12';
    await startWatch(watcher, { expectedKinds: 'spec-done', token });
    streamer.triggerLive(`${buildPhaseSignal('spec-reviewed', token)}\n`);
    expect(captured).toHaveLength(0);
  });

  it('ignores a signal with matching kind but mismatched token', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: 'correctTok01' });
    streamer.triggerLive(`${buildPhaseSignal('spec-done', 'wrongTok123x')}\n`);
    expect(captured).toHaveLength(0);
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
    await startWatch(watcher, { expectedKinds: 'spec-fixed', token });
    streamer.triggerLive(`\x1b[32m${buildPhaseSignal('spec-fixed', token)}\x1b[0m\n`);
    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe('server.spec.fix.submitted');
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
      `    ${buildPhaseSignalTemplate('pr-merge-ready')}`,
      `  token: ${token}`,
    ].join('\n') + '\n';
    streamer.triggerLive(promptShape);
    expect(captured).toHaveLength(0);
  });

  it('does not double-emit when the same signal appears twice', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    const token = 'oncetok123ab';
    await startWatch(watcher, { expectedKinds: 'spec-done', token });
    streamer.triggerLive(`${buildPhaseSignal('spec-done', token)}\n`);
    streamer.triggerLive(`${buildPhaseSignal('spec-done', token)}\n`);
    expect(captured).toHaveLength(1);
  });

  it('matches signal already present in pane snapshot at subscribe', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    const token = 'snapshotTok1';
    streamer.setSnapshot(`prior output\n${buildPhaseSignal('pr-merge-ready', token)}\n`);
    await startWatch(watcher, { expectedKinds: 'pr-merge-ready', token });
    expect(captured).toHaveLength(1);
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
    const { watcher, streamer, captured } = makeWatcher();
    await startWatch(watcher, { expectedKinds: 'spec-done', token: 'old1tok234ab' });
    await startWatch(watcher, { expectedKinds: 'spec-done', token: 'new1tok234ab' });
    streamer.triggerLive(`${buildPhaseSignal('spec-done', 'old1tok234ab')}\n`);
    expect(captured).toHaveLength(0);
    streamer.triggerLive(`${buildPhaseSignal('spec-done', 'new1tok234ab')}\n`);
    expect(captured).toHaveLength(1);
  });

  it('stop(taskId) removes the entry and prevents further fires', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    const token = 'stoptok1234a';
    await startWatch(watcher, { expectedKinds: 'spec-done', token });
    watcher.stop('t1');
    streamer.triggerLive(`${buildPhaseSignal('spec-done', token)}\n`);
    expect(captured).toHaveLength(0);
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
    streamer.triggerLive(`${buildPhaseSignal('spec-done', token)}\n`);
    await flushMicrotasks();
    expect(captured.length).toBe(1);
    expect((captured[0].data as { phase: string }).phase).toMatch(/^signal-emit-failed:/);
  });

  it('expectedKindsFor(taskId): reports the watched set; empty Set after stop', async () => {
    const { watcher } = makeWatcher();
    await startWatch(watcher, { expectedKinds: ['pr-approved', 'pr-changes-requested'], token: 'introspct123' });
    const armed = watcher.expectedKindsFor('t1');
    expect(armed.has('pr-approved')).toBe(true);
    expect(armed.has('pr-changes-requested')).toBe(true);
    expect(armed.has('spec-done')).toBe(false);
    watcher.stop('t1');
    expect(watcher.expectedKindsFor('t1').size).toBe(0);
  });
});

describe('kind → event type routing', () => {
  const ROUTING: ReadonlyArray<[PhaseSignalKind, EventType]> = [
    ['spec-fixed', 'server.spec.fix.submitted'],
    ['spec-done', 'server.spec.ready'],
    ['spec-reviewed', 'server.spec.review.submitted'],
    ['code-done', 'server.code.ready'],
    ['code-reviewed', 'server.code.review.submitted'],
    ['code-fixed', 'server.code.fix.submitted'],
    ['code-ready', 'server.code.published'],
    ['pr-created', 'pr.created'],
    ['pr-fixed', 'pr.fix.submitted'],
    ['pr-merge-ready', 'pr.updated'],
  ];

  it.each(ROUTING)('a watched %s signal emits %s', async (kind, eventType) => {
    const { watcher, streamer, captured } = makeWatcher();
    const token = 'routetok1234';
    await startWatch(watcher, { expectedKinds: kind, token });
    const wire = kind === 'pr-created' ? buildPhaseSignal('pr-created', token, 7) : buildPhaseSignal(kind, token);
    streamer.triggerLive(`${wire}\n`);
    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe(eventType);
  });

  it('pr-approved / pr-changes-requested both route to review.submitted', async () => {
    for (const kind of ['pr-approved', 'pr-changes-requested'] as const) {
      const { watcher, streamer, captured } = makeWatcher();
      const token = 'verdicttok12';
      await startWatch(watcher, { expectedKinds: kind, token });
      streamer.triggerLive(`${buildPhaseSignal(kind, token)}\n`);
      expect(captured[0].type).toBe('review.submitted');
    }
  });
});

describe('server-chain signal watching', () => {
  it('emits the server event type for a server-chain kind', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    const token = 'srvtok123456';
    await startWatch(watcher, { expectedKinds: 'code-reviewed', token });
    streamer.triggerLive(`${buildPhaseSignal('code-reviewed', token)}\n`);
    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe('server.code.review.submitted');
  });

  it('code-ready event data carries prNumber when present', async () => {
    const { watcher, streamer, captured } = makeWatcher();
    const token = 'srvtok123456';
    await startWatch(watcher, { expectedKinds: 'code-ready', token });
    streamer.triggerLive(`[bx:code-ready:42:${token}]\n`);
    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe('server.code.published');
    expect(captured[0].data.prNumber).toBe(42);
  });

  it('fires onReadFile once per distinct request, not on tail rescans', async () => {
    const { watcher, streamer } = makeWatcher();
    const seen: string[] = [];
    await startWatch(watcher, {
      expectedKinds: 'code-reviewed',
      token: 'srvtok123456',
      onReadFile: req => seen.push(`${req.file}:${req.startLine}-${req.endLine}`),
    });
    streamer.triggerLive('[bx:read-file:src/a.ts:1-50]');
    streamer.triggerLive(' trailing chunk keeps old bytes in buffer ');
    streamer.triggerLive('[bx:read-file:src/b.ts:5-9]');
    expect(seen).toEqual(['src/a.ts:1-50', 'src/b.ts:5-9']);
  });
});

describe('snapshot read-file suppression', () => {
  it('marks scrollback requests seen without firing; live requests still fire', async () => {
    const { watcher, streamer } = makeWatcher();
    const seen: string[] = [];
    streamer.setSnapshot('[bx:read-file:old/a.ts:1-10]');
    await startWatch(watcher, {
      expectedKinds: 'code-reviewed',
      token: 'srvtok123456',
      onReadFile: req => seen.push(req.raw),
    });
    expect(seen).toEqual([]);
    streamer.triggerLive('[bx:read-file:new/b.ts:5-9]');
    expect(seen).toEqual(['[bx:read-file:new/b.ts:5-9]']);
    streamer.triggerLive('[bx:read-file:old/a.ts:1-10]');
    expect(seen).toEqual(['[bx:read-file:new/b.ts:5-9]']);
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
