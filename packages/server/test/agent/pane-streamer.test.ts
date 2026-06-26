import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig, HostConfig } from '../../src/shared/index.js';
import {
  PaneStreamer,
  ensureSpawnHelperExecutable,
  type MinimalPty,
  type PtyFactory,
  type SubscriberCallbacks,
} from '../../src/agent/pane-streamer.js';
import { TmuxManager } from '../../src/agent/tmux.js';
import type { CommandRunner, ExecOptions, ExecResult } from '../../src/agent/runner.js';

type ExecMock = ReturnType<typeof vi.fn<(cmd: string, options?: ExecOptions) => Promise<ExecResult>>>;

function mockRunner(): CommandRunner & { exec: ExecMock } {
  return {
    exec: vi.fn<(cmd: string, options?: ExecOptions) => Promise<ExecResult>>().mockResolvedValue({
      stdout: '', stderr: '', exitCode: 0,
    }),
    writeFile: vi.fn<(p: string, c: Buffer | string) => Promise<void>>().mockResolvedValue(undefined),
    execWithStdin: vi.fn<(cmd: string, stdin: Buffer) => Promise<ExecResult>>().mockResolvedValue({
      stdout: '', stderr: '', exitCode: 0,
    }),
  };
}

interface FakePty extends MinimalPty {
  emitData: (data: string) => void;
  emitExit: (exitCode?: number) => void;
  killCalled: number;
  resizeCalls: Array<{ cols: number; rows: number }>;
  writes: string[];
}

function createFakePty(): FakePty {
  let dataListener: ((data: string) => void) | null = null;
  let exitListener: ((e: { exitCode: number; signal?: number | undefined }) => void) | null = null;
  const fake = {
    onData(cb: (data: string) => void) {
      dataListener = cb;
      return { dispose: () => { dataListener = null; } };
    },
    onExit(cb: (e: { exitCode: number; signal?: number | undefined }) => void) {
      exitListener = cb;
      return { dispose: () => { exitListener = null; } };
    },
    resize(cols: number, rows: number) {
      this.resizeCalls.push({ cols, rows });
    },
    write(data: string) {
      this.writes.push(data);
    },
    kill() {
      this.killCalled++;
    },
    emitData(data: string) {
      dataListener?.(data);
    },
    emitExit(exitCode = 0) {
      exitListener?.({ exitCode });
    },
    resizeCalls: [] as Array<{ cols: number; rows: number }>,
    writes: [] as string[],
    killCalled: 0,
  };
  return fake as FakePty;
}

const makePtys = (n: number): FakePty[] => Array.from({ length: n }, createFakePty);

const TEST_AGENT: AgentConfig = {
  id: 'dev-1',
  runtime: 'codex',
  role: 'dev',
  mode: 'local',
};

type StreamerOptions = Omit<NonNullable<ConstructorParameters<typeof PaneStreamer>[4]>, 'ptyFactory'>;

interface MakeStreamerOpts extends StreamerOptions {
  agent?: AgentConfig;
  fakePty?: FakePty;
  ptyFactory?: PtyFactory;
  runner?: ReturnType<typeof mockRunner>;
}

interface MadeStreamer {
  streamer: PaneStreamer;
  fakePty: FakePty;
  runner: ReturnType<typeof mockRunner>;
}

function makeStreamer(opts: MakeStreamerOpts = {}): MadeStreamer {
  const { agent, fakePty: explicitPty, ptyFactory, runner: explicitRunner, idleGraceMs, ...rest } = opts;
  const fakePty = explicitPty ?? createFakePty();
  const runner = explicitRunner ?? mockRunner();
  const tmux = new TmuxManager(runner);
  const streamer = new PaneStreamer(agent ?? TEST_AGENT, tmux, runner, () => undefined, {
    ptyFactory: ptyFactory ?? (() => fakePty),
    idleGraceMs: idleGraceMs ?? 50,
    ...rest,
  });
  return { streamer, fakePty, runner };
}

// makeStreamer + the near-universal first subscribe (registers the shared `cbs`).
async function subscribed(opts: MakeStreamerOpts = {}): Promise<MadeStreamer> {
  const made = makeStreamer(opts);
  await made.streamer.subscribeAtomic(cbs);
  return made;
}

async function flush(streamer: PaneStreamer): Promise<void> {
  await streamer._waitForChainDrain();
  await tick();
  await streamer._waitForChainDrain();
}

function tick(): Promise<void> {
  return new Promise<void>(r => setImmediate(r));
}

const execCmds = (runner: ReturnType<typeof mockRunner>): string[] =>
  runner.exec.mock.calls.map((c: unknown[]) => c[0] as string);

const findCmd = (runner: ReturnType<typeof mockRunner>, pred: (cmd: string) => boolean): string | undefined =>
  execCmds(runner).find(pred);

async function expectDims(streamer: PaneStreamer, cols: number, rows: number): Promise<void> {
  const { snapshot } = await streamer.getSnapshotAtomic();
  expect(snapshot.cols).toBe(cols);
  expect(snapshot.rows).toBe(rows);
}

// `tmux has-session` reports the session is gone; everything else succeeds.
function mockSessionGone(runner: ReturnType<typeof mockRunner>): void {
  runner.exec.mockImplementation(async (cmd: string) =>
    cmd.includes('has-session')
      ? { stdout: '', stderr: "can't find session: dev-1", exitCode: 1 }
      : { stdout: '', stderr: '', exitCode: 0 },
  );
}

interface CountingFactory {
  factory: PtyFactory;
  calls: () => number;
  // advance fake timers by `ms`, then assert the factory has been invoked `expected` times.
  expectAfter: (ms: number, expected: number) => Promise<void>;
}

// A counting PTY factory: returns ptys[0], ptys[1], … in order. `failAt` indices throw
// (simulating a failed reattach); any call past the provided ptys also throws.
function countingFactory(ptys: FakePty[], failAt: number[] = []): CountingFactory {
  let calls = 0;
  const factory: PtyFactory = () => {
    const i = calls++;
    if (failAt.includes(i) || ptys[i] === undefined) throw new Error('ssh down');
    return ptys[i];
  };
  const expectAfter = async (ms: number, expected: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
    expect(calls).toBe(expected);
  };
  return { factory, calls: () => calls, expectAfter };
}

// Most timer-driven reconnect tests share the same scaffold: spy on console, build a
// streamer with a counting factory, subscribe, switch to fake timers, then advance.
async function withTimerHarness(
  run: (ctx: {
    streamer: PaneStreamer;
    warnSpy: ReturnType<typeof vi.spyOn>;
    logSpy: ReturnType<typeof vi.spyOn>;
  }) => Promise<void>,
  opts: MakeStreamerOpts = {},
): Promise<void> {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  let streamer: PaneStreamer | null = null;
  let usingFakeTimers = false;
  try {
    const made = makeStreamer(opts);
    streamer = made.streamer;
    await streamer.subscribeAtomic(cbs);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    usingFakeTimers = true;
    await run({ streamer, warnSpy, logSpy });
  } finally {
    streamer?.destroy();
    warnSpy.mockRestore();
    logSpy.mockRestore();
    if (usingFakeTimers) vi.useRealTimers();
  }
}

async function withFakeTimers(run: () => Promise<void>): Promise<void> {
  vi.useFakeTimers();
  try {
    await run();
  } finally {
    vi.useRealTimers();
  }
}

let liveCalls: Array<{ data: string; seq: number }>;
let _sessionGoneCalls: number;
let cbs: SubscriberCallbacks;

const NOOP_CBS: SubscriberCallbacks = { onLive: () => undefined, onSessionGone: () => undefined };

beforeEach(() => {
  liveCalls = [];
  _sessionGoneCalls = 0;
  cbs = {
    onLive: (data: string, seq: number) => liveCalls.push({ data, seq }),
    onSessionGone: () => { _sessionGoneCalls++; },
  };
});

describe('PaneStreamer', () => {
  describe('subscribeAtomic', () => {
    it('returns initial empty snapshot + snapshotSeq=-1 when no prior data', async () => {
      const { streamer } = makeStreamer();
      const result = await streamer.subscribeAtomic(cbs);
      expect(result.snapshot.cols).toBe(200);
      expect(result.snapshot.rows).toBe(50);
      expect(result.snapshot.data).toBe('');
      expect(result.snapshotSeq).toBe(-1);
      streamer.destroy();
    });

    it('lazy-starts PTY on first subscribe', async () => {
      const { streamer, fakePty } = await subscribed();
      expect(fakePty.killCalled).toBe(0);  // pty alive
      streamer.destroy();
    });

    it('snapshot reflects all data written before subscribe (chain ordering)', async () => {
      const { streamer, fakePty } = makeStreamer();
      const sub1 = await streamer.subscribeAtomic(cbs);
      expect(sub1.snapshotSeq).toBe(-1);

      fakePty.emitData('hello world');
      await flush(streamer);

      const sub2 = await streamer.subscribeAtomic(NOOP_CBS);
      expect(sub2.snapshot.data.length).toBeGreaterThan(0);
      expect(sub2.snapshot.data).toContain('hello world');
      expect(sub2.snapshotSeq).toBe(0);

      streamer.destroy();
    });

    it('live callbacks added in subscribeAtomic see subsequent data with seq > snapshotSeq (no overlap)', async () => {
      const { streamer, fakePty } = makeStreamer();

      const subA = await streamer.subscribeAtomic(cbs);
      expect(subA.snapshotSeq).toBe(-1);

      fakePty.emitData('A');
      await flush(streamer);
      expect(liveCalls).toEqual([{ data: 'A', seq: 0 }]);

      const subBLive: Array<{ data: string; seq: number }> = [];
      const subB = await streamer.subscribeAtomic({
        onLive: (data, seq) => subBLive.push({ data, seq }),
        onSessionGone: () => undefined,
      });
      expect(subB.snapshot.data).toContain('A');
      expect(subB.snapshotSeq).toBe(0);

      fakePty.emitData('B');
      await flush(streamer);
      expect(liveCalls).toEqual([{ data: 'A', seq: 0 }, { data: 'B', seq: 1 }]);
      expect(subBLive).toEqual([{ data: 'B', seq: 1 }]);

      streamer.destroy();
    });

    it('unsubscribe removes the cb from live (later data does not fire it)', async () => {
      const { streamer, fakePty } = makeStreamer();
      const sub = await streamer.subscribeAtomic(cbs);

      fakePty.emitData('first');
      await flush(streamer);
      expect(liveCalls.map(c => c.data)).toEqual(['first']);

      sub.unsubscribe();

      fakePty.emitData('second');
      await flush(streamer);
      expect(liveCalls.map(c => c.data)).toEqual(['first']);

      streamer.destroy();
    });
  });

  describe('getSnapshotAtomic', () => {
    it('returns snapshot with current snapshotSeq, does NOT register live cb', async () => {
      const { streamer, fakePty } = await subscribed();
      fakePty.emitData('hello');
      await flush(streamer);

      const result = await streamer.getSnapshotAtomic();
      expect(result.snapshot.data).toContain('hello');
      expect(result.snapshotSeq).toBe(0);

      fakePty.emitData('world');
      await flush(streamer);
      // getSnapshotAtomic never registered a live cb, so only the original `cbs` saw the data.
      expect(liveCalls.map(c => c.data)).toEqual(['hello', 'world']);

      streamer.destroy();
    });
  });

  describe('onPtyData chain ordering', () => {
    it('subscribe queued during in-flight onPtyData sees that chunk in snapshot, not in live', async () => {
      const { streamer, fakePty } = await subscribed();

      fakePty.emitData('X');
      const sub = await streamer.subscribeAtomic(NOOP_CBS);
      await flush(streamer);

      expect(sub.snapshot.data).toContain('X');
      expect(sub.snapshotSeq).toBe(0);
      streamer.destroy();
    });

    it('seq increments monotonically per onPtyData chunk', async () => {
      const { streamer, fakePty } = await subscribed();

      fakePty.emitData('a');
      fakePty.emitData('b');
      fakePty.emitData('c');
      await flush(streamer);
      expect(liveCalls.map(c => c.seq)).toEqual([0, 1, 2]);
      expect(liveCalls.map(c => c.data)).toEqual(['a', 'b', 'c']);

      streamer.destroy();
    });
  });

  describe('onSessionGone (PTY exit)', () => {
    it('reattaches hidden tmux client instead of ending the session when tmux session still exists', async () => {
      const ptys = makePtys(2);
      const { factory, calls, expectAfter } = countingFactory(ptys);
      await withTimerHarness(async ({ streamer }) => {
        ptys[0].emitExit(0);
        await tick();

        expect(_sessionGoneCalls).toBe(0);
        expect(streamer.isDestroyed()).toBe(false);
        expect(calls()).toBe(1);
        await expectAfter(999, 1);
        await expectAfter(1, 2);
        vi.useRealTimers();
        ptys[1].emitData('after');
        await flush(streamer);
        expect(liveCalls.map(c => c.data)).toEqual(['after']);
      }, { ptyFactory: factory, reattachDelayMs: 1000, random: () => 0 });
    });

    it('bounds the attach-exit tmux session probe with a timeout', async () => {
      const ptys = makePtys(2);
      const { factory, calls, expectAfter } = countingFactory(ptys);
      const runner = mockRunner();
      runner.exec.mockImplementation(async (cmd: string, options?: ExecOptions) => {
        if (cmd.includes('has-session')) {
          expect(options?.timeout).toBe(1234);
          throw new Error('probe timeout');
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      await withTimerHarness(async ({ warnSpy }) => {
        ptys[0].emitExit(0);
        await tick();

        expect(calls()).toBe(1);
        expect(warnSpy).toHaveBeenCalledWith(
          '[pane-streamer] dev-1 attach failing; backing off retries: probe timeout',
        );
        await expectAfter(1000, 2);
      }, { ptyFactory: factory, runner, reattachDelayMs: 1000, sessionProbeTimeoutMs: 1234 });
    });

    it('backs off between failed hidden attach retries even when caller requested immediate reattach', async () => {
      const initialPty = createFakePty();
      const recoveredPty = createFakePty();
      const { factory, expectAfter } = countingFactory([initialPty, recoveredPty, recoveredPty], [1]);
      await withTimerHarness(async ({ streamer, warnSpy }) => {
        initialPty.emitExit(0);
        await tick();
        await expectAfter(999, 1);
        await expectAfter(1, 2);
        expect(warnSpy).toHaveBeenCalledTimes(1);

        // backoff doubled: the second retry waits 2000ms, not another 1000ms
        await expectAfter(1999, 2);
        await expectAfter(1, 3);
        vi.useRealTimers();
        recoveredPty.emitData('after');
        await flush(streamer);
        expect(liveCalls.map(c => c.data)).toEqual(['after']);
      }, { ptyFactory: factory, reattachDelayMs: 1000, random: () => 0 });
    });

    it('fires onSessionGone for all subscribers when tmux session is gone', async () => {
      const { streamer, fakePty, runner } = makeStreamer();
      mockSessionGone(runner);
      let goneA = 0, goneB = 0;
      await streamer.subscribeAtomic({ onLive: () => undefined, onSessionGone: () => { goneA++; } });
      await streamer.subscribeAtomic({ onLive: () => undefined, onSessionGone: () => { goneB++; } });

      fakePty.emitExit(0);
      await tick();
      expect(goneA).toBe(1);
      expect(goneB).toBe(1);
      expect(streamer.isDestroyed()).toBe(true);
    });

    it('subsequent subscribe attempts throw after tmux session is gone', async () => {
      const { streamer, fakePty, runner } = makeStreamer();
      mockSessionGone(runner);
      await streamer.subscribeAtomic(cbs);
      fakePty.emitExit(0);
      await tick();
      expect(streamer.isDestroyed()).toBe(true);
      await expect(streamer.subscribeAtomic(cbs)).rejects.toThrow(/destroyed/);
    });

    it('kills a replacement PTY if tmux disappears during the session-gone probe window', async () => {
      const ptys = makePtys(2);
      const { factory, calls } = countingFactory(ptys);
      let resolveProbe!: (value: ExecResult) => void;
      let probeStarted!: () => void;
      const probeStartedPromise = new Promise<void>((resolve) => { probeStarted = resolve; });
      const runner = mockRunner();
      runner.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('has-session')) {
          probeStarted();
          return new Promise<ExecResult>((resolve) => { resolveProbe = resolve; });
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      const { streamer } = makeStreamer({ ptyFactory: factory, runner, reattachDelayMs: 1000 });
      await streamer.subscribeAtomic(cbs);

      ptys[0].emitExit(0);
      await probeStartedPromise;
      await streamer.sendInput('x');
      expect(calls()).toBe(2);
      expect(ptys[1].writes).toEqual(['x']);
      expect(ptys[1].killCalled).toBe(0);

      resolveProbe({ stdout: '', stderr: "can't find session: dev-1", exitCode: 1 });
      await tick();

      expect(streamer.isDestroyed()).toBe(true);
      expect(ptys[1].killCalled).toBe(1);
      expect(_sessionGoneCalls).toBe(1);
    });
  });

  describe('reconnect backoff + log collapse', () => {
    it('grows the reattach delay exponentially while attaches keep failing', async () => {
      const initialPty = createFakePty();
      const { factory, calls, expectAfter } = countingFactory([initialPty]);
      await withTimerHarness(async ({ warnSpy }) => {
        initialPty.emitExit(0);
        await tick();
        expect(calls()).toBe(1);

        await expectAfter(999, 1);
        await expectAfter(1, 2);
        await expectAfter(1999, 2);
        await expectAfter(1, 3);
        await expectAfter(3999, 3);
        await expectAfter(1, 4);

        expect(warnSpy).toHaveBeenCalledTimes(1);
      }, { ptyFactory: factory, reattachDelayMs: 1000, reattachMaxDelayMs: 15_000, random: () => 0 });
    });

    // Regression: a failing reattach often emits bytes (SSH banner, "Connection closed"
    // stderr, login text) before the connection dies. Those bytes must NOT count as recovery
    // or the backoff resets to base every cycle and the storm returns.
    it('keeps backing off when a reattach emits output then exits without staying stable', async () => {
      const ptys = makePtys(3);
      const { factory, expectAfter } = countingFactory(ptys);
      await withTimerHarness(async () => {
        ptys[0].emitExit(0);
        await tick();

        await expectAfter(1000, 2);

        // ptys[1] spews failure noise as PTY data, then dies inside the stability window
        ptys[1].emitData('Connection closed by 1.2.3.4 port 6003\r\n');
        ptys[1].emitExit(0);
        await tick();

        // backoff must have grown to 2000ms — interim data must not reset it to 1000
        await expectAfter(1999, 2);
        await expectAfter(1, 3);
      }, {
        ptyFactory: factory,
        reattachDelayMs: 1000,
        reattachMaxDelayMs: 15_000,
        reattachStableAfterMs: 5000,
        random: () => 0,
      });
    });

    it('resets backoff and logs recovery only after a reattach survives the stability window', async () => {
      const ptys = makePtys(4);
      const { factory, expectAfter } = countingFactory(ptys, [1]);
      await withTimerHarness(async ({ warnSpy, logSpy }) => {
        const recoveredLines = () =>
          logSpy.mock.calls.map(c => String(c[0])).filter(l => l.includes('attach recovered'));
        ptys[0].emitExit(0);
        await tick();

        await vi.advanceTimersByTimeAsync(1000);   // attempt1 → factory throws → outage warn
        expect(warnSpy).toHaveBeenCalledTimes(1);
        await expectAfter(2000, 3);                // attempt2 → ptys[2] attaches, stays alive

        await vi.advanceTimersByTimeAsync(4999);
        expect(recoveredLines()).toEqual([]);      // not recovered until the window elapses
        await vi.advanceTimersByTimeAsync(1);
        expect(recoveredLines()).toEqual(['[pane-streamer] dev-1 attach recovered']);

        // backoff was reset: a later drop reschedules from base (1000), not the grown delay
        ptys[2].emitExit(0);
        await tick();
        await expectAfter(999, 3);
        await expectAfter(1, 4);
      }, { ptyFactory: factory, reattachDelayMs: 1000, reattachStableAfterMs: 5000, random: () => 0 });
    });
  });

  describe('idle grace + lazy GC', () => {
    it('keeps PTY alive when subscribers come and go within graceMs', async () => {
      await withFakeTimers(async () => {
        const { streamer, fakePty } = makeStreamer({ idleGraceMs: 100 });
        const sub = await streamer.subscribeAtomic(cbs);
        sub.unsubscribe();
        await vi.advanceTimersByTimeAsync(50);
        expect(streamer.isDestroyed()).toBe(false);
        expect(fakePty.killCalled).toBe(0);
        await streamer.subscribeAtomic(cbs);
        await vi.advanceTimersByTimeAsync(200);
        expect(streamer.isDestroyed()).toBe(false);
        streamer.destroy();
      });
    });

    it('destroys PTY after graceMs with no subscribers', async () => {
      await withFakeTimers(async () => {
        const { streamer, fakePty } = makeStreamer({ idleGraceMs: 100 });
        const sub = await streamer.subscribeAtomic(cbs);
        sub.unsubscribe();
        await vi.advanceTimersByTimeAsync(150);
        expect(streamer.isDestroyed()).toBe(true);
        expect(fakePty.killCalled).toBe(1);
      });
    });
  });

  describe('scrollback line bound (the serialized snapshot IS the buffer; no separate byte copy)', () => {
    it('caps the snapshot at the configured scrollbackLines instead of retaining every emitted line', async () => {
      const { streamer, fakePty } = await subscribed({ scrollbackLines: 5 });
      for (let i = 0; i < 200; i++) fakePty.emitData(`line-${i}\r\n`);
      await flush(streamer);
      const { snapshot } = await streamer.getSnapshotAtomic();
      // viewport (rows) + 5 scrollback lines — far below the 200 lines emitted; an unbounded
      // (default 1000-line) buffer would retain all 200.
      expect(snapshot.data.split('\n').length).toBeLessThan(80);
      expect(snapshot.data).not.toContain('line-0');
      streamer.destroy();
    });
  });

  describe('sendInput (PTY stdin path — lets tmux client process keybinds)', () => {
    it('forwards bytes to pty.write (NOT tmux paste-buffer) so wheel/mouse-events trigger tmux keybinds', async () => {
      const { streamer, fakePty, runner } = await subscribed();
      const mouseSeq = '\x1b[<64;42;7M';
      await streamer.sendInput(mouseSeq);
      expect(fakePty.writes).toEqual([mouseSeq]);
      const calls = execCmds(runner);
      expect(calls.some((c: string) => c.includes('paste-buffer'))).toBe(false);
      expect(calls.some((c: string) => c.includes('load-buffer'))).toBe(false);
      streamer.destroy();
    });

    it('empty input is a no-op (no pty.write)', async () => {
      const { streamer, fakePty } = await subscribed();
      await streamer.sendInput('');
      expect(fakePty.writes).toEqual([]);
      streamer.destroy();
    });

    it('sendInput after destroy rejects (does not silently swallow)', async () => {
      const { streamer } = await subscribed();
      streamer.destroy();
      await expect(streamer.sendInput('x')).rejects.toThrow(/destroyed/);
    });
  });

  describe('resize', () => {
    it('updates headless cols/rows + calls TmuxManager.resizeWindow', async () => {
      const { streamer, runner } = await subscribed();
      await streamer.resize(160, 40);
      const resizeCmd = findCmd(runner, c => c.includes('tmux resize-window'));
      expect(resizeCmd).toBeDefined();
      expect(resizeCmd).toContain('-x 160');
      expect(resizeCmd).toContain('-y 40');
      expect(resizeCmd).toContain("-t '=dev-1'");
      await expectDims(streamer, 160, 40);
      streamer.destroy();
    });

    it('restores window-size=latest after explicit web resize so the latest attached client controls size', async () => {
      const { streamer, runner } = await subscribed();
      await streamer.resize(160, 40);
      const latestCall = findCmd(runner, c =>
        c.includes('tmux set-option') && c.includes('window-size') && c.includes('latest'),
      );
      expect(latestCall).toBeDefined();
      streamer.destroy();
    });

    it('also resizes the attach PTY so tmux client viewport tracks web terminal (mouse hit-testing depends on it)', async () => {
      const { streamer, fakePty } = await subscribed();
      const beforeResizes = fakePty.resizeCalls.length;
      await streamer.resize(160, 40);
      expect(fakePty.resizeCalls.slice(beforeResizes)).toEqual([{ cols: 160, rows: 40 }]);
      streamer.destroy();
    });

    it('still resizes tmux when requested dimensions match headless so web can reclaim latest sizing', async () => {
      const { streamer, runner, fakePty } = await subscribed();
      const beforeExecs = runner.exec.mock.calls.length;
      await streamer.resize(200, 50);
      expect(runner.exec.mock.calls.length).toBeGreaterThan(beforeExecs);
      const resizeCmd = findCmd(runner, c =>
        c.includes('tmux resize-window') && c.includes('-x 200') && c.includes('-y 50'),
      );
      expect(resizeCmd).toBeDefined();
      expect(fakePty.resizeCalls).toEqual([{ cols: 200, rows: 50 }]);
      await expectDims(streamer, 200, 50);
      streamer.destroy();
    });

    it('still resizes PTY/headless when window-size=latest repair fails after tmux resize succeeds', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { streamer, runner, fakePty } = await subscribed();
        runner.exec.mockImplementation(async (cmd: string) =>
          cmd.includes('set-option') && cmd.includes('window-size') && cmd.includes('latest')
            ? { stdout: '', stderr: 'bad option', exitCode: 1 }
            : { stdout: '', stderr: '', exitCode: 0 },
        );
        await streamer.resize(160, 40);
        expect(fakePty.resizeCalls).toEqual([{ cols: 160, rows: 40 }]);
        await expectDims(streamer, 160, 40);
        expect(warnSpy).toHaveBeenCalledWith(
          '[pane-streamer] set window-size=latest failed after resize(dev-1):',
          expect.any(Error),
        );
        streamer.destroy();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('tmux resize failure leaves headless dims AND PTY size unchanged (atomic rollback)', async () => {
      const { streamer, runner, fakePty } = await subscribed();
      const beforeCols = (await streamer.getSnapshotAtomic()).snapshot.cols;
      const beforeRows = (await streamer.getSnapshotAtomic()).snapshot.rows;
      const beforePtyResizes = fakePty.resizeCalls.length;
      runner.exec.mockImplementationOnce(async (cmd: string) =>
        cmd.includes('resize-window')
          ? { stdout: '', stderr: 'session not found', exitCode: 1 }
          : { stdout: '', stderr: '', exitCode: 0 },
      );
      await expect(streamer.resize(999, 999)).rejects.toThrow();
      const after = await streamer.getSnapshotAtomic();
      expect(after.snapshot.cols).toBe(beforeCols);
      expect(after.snapshot.rows).toBe(beforeRows);
      expect(fakePty.resizeCalls.length).toBe(beforePtyResizes);
      streamer.destroy();
    });
  });

  describe('destroy', () => {
    it('idempotent: second destroy is a no-op', async () => {
      const { streamer, fakePty } = await subscribed();
      streamer.destroy();
      streamer.destroy();
      expect(fakePty.killCalled).toBe(1);
    });

    it('subscribeAtomic after destroy rejects', async () => {
      const { streamer } = makeStreamer();
      streamer.destroy();
      await expect(streamer.subscribeAtomic(cbs)).rejects.toThrow(/destroyed/);
    });

    it('fires sessionGoneCbs synchronously before pty.kill', async () => {
      const { streamer, fakePty } = makeStreamer();
      let sessionGoneFired = 0;
      let killedAtFire = -1;
      await streamer.subscribeAtomic({
        onLive: () => undefined,
        onSessionGone: () => {
          sessionGoneFired++;
          killedAtFire = fakePty.killCalled;
        },
      });
      streamer.destroy();
      expect(sessionGoneFired).toBe(1);
      // sessionGoneCb runs BEFORE pty.kill — onExit's empty-set firing is harmless.
      expect(killedAtFire).toBe(0);
      expect(fakePty.killCalled).toBe(1);
    });
  });
});

describe('PaneStreamer host re-resolution', () => {
  it('resolves the host per attach from the resolver, so credential/endpoint changes apply on reconnect', async () => {
    const host: HostConfig = { hostname: 'h', port: 2222, user: 'u' };
    let resolveCalls = 0;
    const captured: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const fakePty = createFakePty();
    const streamer = new PaneStreamer(
      { id: 'r-dev', runtime: 'codex', role: 'dev', mode: 'remote' } as AgentConfig,
      new TmuxManager(mockRunner()),
      mockRunner(),
      () => { resolveCalls++; return host; },
      { ptyFactory: (cmd) => { captured.push(cmd); return fakePty; }, idleGraceMs: 50 },
    );
    await streamer.subscribeAtomic(NOOP_CBS);

    // The host was resolved at attach time (not captured in the constructor) and drives the command.
    expect(resolveCalls).toBeGreaterThanOrEqual(1);
    expect(captured[0].args).toContain('-p');
    expect(captured[0].args).toContain('2222');
    expect(captured[0].args).toContain('u@h');

    streamer.destroy();
  });
});

describe('ensureSpawnHelperExecutable', () => {
  let dir: string;
  const activeDir = () => join(dir, 'prebuilds', `${process.platform}-${process.arch}`);
  const helper = () => join(activeDir(), 'spawn-helper');
  const buildHelper = () => join(dir, 'build', 'Release', 'spawn-helper');
  // Fake node-pty loader: pty.node "loads" only under the given subpath, mirroring require() success.
  const loadsUnder = (sub: string) => (modulePath: string) => {
    if (!modulePath.includes(join(...sub.split('/')))) throw new Error(`cannot load ${modulePath}`);
  };
  const prebuildLoads = loadsUnder(`prebuilds/${process.platform}-${process.arch}`);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pane-helper-'));
    mkdirSync(activeDir(), { recursive: true });
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // These two exercise the real chmodSync fs path, which is POSIX-only (Windows fs has no exec bit).
  it.skipIf(process.platform === 'win32')('adds +x to a spawn-helper shipped as 0644 (node-pty#850)', () => {
    writeFileSync(helper(), 'binary', { mode: 0o644 });
    chmodSync(helper(), 0o644);
    ensureSpawnHelperExecutable(dir, { load: prebuildLoads });
    expect(statSync(helper()).mode & 0o111).toBe(0o111);
  });

  it.skipIf(process.platform === 'win32')('leaves an already-executable helper untouched', () => {
    writeFileSync(helper(), 'binary', { mode: 0o755 });
    chmodSync(helper(), 0o755);
    ensureSpawnHelperExecutable(dir, { load: prebuildLoads });
    expect(statSync(helper()).mode & 0o777).toBe(0o755);
  });

  it('targets only the helper beside the pty.node that loads, not an inactive candidate', () => {
    mkdirSync(join(dir, 'build', 'Release'), { recursive: true });
    writeFileSync(buildHelper(), 'binary', { mode: 0o644 });
    chmodSync(buildHelper(), 0o644);
    writeFileSync(helper(), 'binary', { mode: 0o644 });
    chmodSync(helper(), 0o644);
    const chmodded: string[] = [];
    ensureSpawnHelperExecutable(dir, {
      chmod: (p) => chmodded.push(p),
      load: loadsUnder('build/Release'),
      canExecute: () => false,
    });
    expect(chmodded).toEqual([buildHelper()]);
  });

  // build/Release/pty.node present but unloadable (ABI mismatch after a Node upgrade): node-pty falls
  // back to the prebuild, so we must fix the prebuilt helper, not the inert build/Release one.
  it('falls back to the prebuild when build/Release pty.node fails to load', () => {
    mkdirSync(join(dir, 'build', 'Release'), { recursive: true });
    writeFileSync(buildHelper(), 'binary', { mode: 0o644 });
    chmodSync(buildHelper(), 0o644);
    writeFileSync(helper(), 'binary', { mode: 0o644 });
    chmodSync(helper(), 0o644);
    const chmodded: string[] = [];
    ensureSpawnHelperExecutable(dir, {
      chmod: (p) => chmodded.push(p),
      load: prebuildLoads,
      canExecute: () => false,
    });
    expect(chmodded).toEqual([helper()]);
  });

  it('throws an actionable error when the active helper cannot be made executable', () => {
    writeFileSync(helper(), 'binary', { mode: 0o644 });
    chmodSync(helper(), 0o644);
    const eperm = () => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    };
    expect(() =>
      ensureSpawnHelperExecutable(dir, { chmod: eperm, load: prebuildLoads, canExecute: () => false }),
    ).toThrow(/chmod \+x/);
  });

  // root:group-owned 0550 + service user in that group: not world-exec and not chmod-able by us, but
  // runnable. Must not chmod-EPERM-throw on an install that already works.
  it('skips chmod (no throw) when the current process can already execute the helper', () => {
    writeFileSync(helper(), 'binary', { mode: 0o550 });
    chmodSync(helper(), 0o550);
    const chmodCalls: string[] = [];
    const wouldFail = (p: string) => {
      chmodCalls.push(p);
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    };
    expect(() =>
      ensureSpawnHelperExecutable(dir, { chmod: wouldFail, load: prebuildLoads, canExecute: () => true }),
    ).not.toThrow();
    expect(chmodCalls).toEqual([]);
  });

  it('does not throw when no pty.node loads (source build elsewhere)', () => {
    const loadsNothing = () => {
      throw new Error('no loadable native module');
    };
    expect(() => ensureSpawnHelperExecutable(dir, { load: loadsNothing })).not.toThrow();
  });

  it('does not throw when the helper is missing though pty.node loads', () => {
    expect(() => ensureSpawnHelperExecutable(dir, { load: prebuildLoads })).not.toThrow();
  });

  // Passing '' exercises the unresolved branch without triggering the resolveNodePtyDir() default
  // (which would load/stat/chmod the real installed node-pty).
  it('does not touch real node-pty when the package dir cannot be resolved', () => {
    const mustNotRun = () => {
      throw new Error('must not run when packageDir is unresolved');
    };
    expect(() =>
      ensureSpawnHelperExecutable('', { chmod: mustNotRun, load: mustNotRun, canExecute: () => false }),
    ).not.toThrow();
  });
});
