import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig, HostConfig } from '../../src/shared/index.js';
import {
  PaneStreamer,
  ensureSpawnHelperExecutable,
  normalizeFollowIntervalMs,
  parseAttachFlagCapability,
  type MinimalPty,
  type ProbeHandle,
  type PtyFactory,
  type StreamerGeometryHooks,
  type SubscriberCallbacks,
} from '../../src/agent/pane-streamer.js';
import { TmuxManager } from '../../src/agent/tmux.js';
import type { CommandRunner, ExecOptions, ExecResult } from '../../src/agent/runner.js';

type ExecMock = ReturnType<typeof vi.fn<(cmd: string, options?: ExecOptions) => Promise<ExecResult>>>;

function mockRunner(): CommandRunner & { exec: ExecMock } {
  return {
    exec: vi.fn<(cmd: string, options?: ExecOptions) => Promise<ExecResult>>().mockImplementation(async (cmd: string) => {
      if (cmd.includes('list-sessions')) {
        const name = /#\{==:#\{session_name\},([^}]+)\}/.exec(cmd)?.[1] ?? 'dev-1';
        return { stdout: `4242|1700000000|$1|${name}\n`, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
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

type StreamerOptions = Omit<NonNullable<ConstructorParameters<typeof PaneStreamer>[3]>, 'ptyFactory'>;

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
  const streamer = new PaneStreamer(agent ?? TEST_AGENT, tmux, () => undefined, {
    ptyFactory: ptyFactory ?? (() => fakePty),
    idleGraceMs: idleGraceMs ?? 50,
    ...rest,
  });
  return { streamer, fakePty, runner };
}

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

async function expectDims(streamer: PaneStreamer, cols: number, rows: number): Promise<void> {
  const { snapshot } = await streamer.getSnapshotAtomic();
  expect(snapshot.cols).toBe(cols);
  expect(snapshot.rows).toBe(rows);
}

function mockSessionGone(runner: ReturnType<typeof mockRunner>): void {
  let probes = 0;
  runner.exec.mockImplementation(async (cmd: string) => {
    if (cmd.includes('list-sessions')) {
      probes += 1;
      return probes <= 2
        ? { stdout: '4242|1700000000|$1|dev-1\n', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });
}

const SESSION_REF_LINE = '4242|1700000000|$1';

function mockSessionSnapshot(runner: ReturnType<typeof mockRunner>, claim = 'dev-1'): void {
  runner.exec.mockImplementation(async (cmd: string) =>
    cmd.includes('list-sessions')
      ? { stdout: `${SESSION_REF_LINE}|${claim}\n`, stderr: '', exitCode: 0 }
      : { stdout: '', stderr: '', exitCode: 0 },
  );
}

interface CountingFactory {
  factory: PtyFactory;
  calls: () => number;
  expectAfter: (ms: number, expected: number) => Promise<void>;
}

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

function stubGeometryHooks(overrides: Partial<StreamerGeometryHooks> = {}): StreamerGeometryHooks {
  return {
    fullHolds: () => 0,
    acquireFullHold: () => () => undefined,
    readGeometry: async () => { throw new Error('no geometry in stub'); },
    raceProbe: (<T>(_start: () => ProbeHandle<T>) => Promise.resolve('tmux 3.0a\n' as T)) as StreamerGeometryHooks['raceProbe'],
    noteManualSeen: () => undefined,
    recordFullTarget: () => undefined,
    commitOwnerResize: async () => undefined,
    ...overrides,
  };
}

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
      expect(fakePty.killCalled).toBe(0);
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

    it('reattaches when the new PTY exits during its post-attach handshake', async () => {
      const ptys = makePtys(3);
      const { factory, calls, expectAfter } = countingFactory(ptys);
      let probes = 0;
      let resolvePostAttach!: (result: ExecResult) => void;
      let postAttachStarted!: () => void;
      const postAttachStartedP = new Promise<void>((resolve) => { postAttachStarted = resolve; });
      const runner = mockRunner();
      runner.exec.mockImplementation(async (cmd: string) => {
        if (!cmd.includes('list-sessions')) return { stdout: '', stderr: '', exitCode: 0 };
        probes++;
        if (probes === 5) {
          postAttachStarted();
          return new Promise<ExecResult>((resolve) => { resolvePostAttach = resolve; });
        }
        return { stdout: '4242|1700000000|$1|dev-1\n', stderr: '', exitCode: 0 };
      });
      await withTimerHarness(async () => {
        ptys[0].emitExit(0);
        await tick();
        await vi.advanceTimersByTimeAsync(1000);
        await postAttachStartedP;

        ptys[1].emitExit(0);
        await tick();
        resolvePostAttach({ stdout: '4242|1700000000|$1|dev-1\n', stderr: '', exitCode: 0 });
        await tick();

        expect(calls()).toBe(2);
        await expectAfter(1999, 2);
        await expectAfter(1, 3);
      }, { ptyFactory: factory, runner, reattachDelayMs: 1000, random: () => 0 });
    });

    it('reattaches when the new PTY exits during quarantine drain', async () => {
      const ptys = makePtys(3);
      const { factory, calls, expectAfter } = countingFactory(ptys);
      let probes = 0;
      let resolvePostAttach!: (result: ExecResult) => void;
      let postAttachStarted!: () => void;
      const postAttachStartedP = new Promise<void>((resolve) => { postAttachStarted = resolve; });
      const runner = mockRunner();
      runner.exec.mockImplementation(async (cmd: string) => {
        if (!cmd.includes('list-sessions')) return { stdout: '', stderr: '', exitCode: 0 };
        probes++;
        if (probes === 5) {
          postAttachStarted();
          return new Promise<ExecResult>((resolve) => { resolvePostAttach = resolve; });
        }
        return { stdout: '4242|1700000000|$1|dev-1\n', stderr: '', exitCode: 0 };
      });
      await withTimerHarness(async ({ streamer }) => {
        ptys[0].emitExit(0);
        await tick();
        await vi.advanceTimersByTimeAsync(1000);
        await postAttachStartedP;

        const terminal = (streamer as unknown as {
          headless: { write(data: string, callback?: () => void): void };
        }).headless;
        const write = terminal.write.bind(terminal);
        let releaseWrite!: () => void;
        let writeStarted!: () => void;
        const writeStartedP = new Promise<void>((resolve) => { writeStarted = resolve; });
        terminal.write = (data, callback) => {
          write(data, () => {
            releaseWrite = () => callback?.();
            writeStarted();
          });
        };

        ptys[1].emitData('buffered');
        resolvePostAttach({ stdout: '4242|1700000000|$1|dev-1\n', stderr: '', exitCode: 0 });
        await vi.advanceTimersByTimeAsync(1);
        await writeStartedP;
        ptys[1].emitExit(0);
        await tick();
        releaseWrite();
        await tick();

        expect(calls()).toBe(2);
        await expectAfter(1999, 2);
        await expectAfter(1, 3);
      }, { ptyFactory: factory, runner, reattachDelayMs: 1000, random: () => 0 });
    });

    it('bounds the ownership probe with a timeout and does NOT spawn a PTY while the probe stays uncertain (fail-closed backoff)', async () => {
      const ptys = makePtys(3);
      const { factory, calls, expectAfter } = countingFactory(ptys);
      const runner = mockRunner();
      let probes = 0;
      runner.exec.mockImplementation(async (cmd: string, options?: ExecOptions) => {
        if (cmd.includes('list-sessions')) {
          expect(options?.timeout).toBe(1234);
          probes += 1;
          if (probes <= 2) return { stdout: '4242|1700000000|$1|dev-1\n', stderr: '', exitCode: 0 };
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
        await expectAfter(1000, 1);
        await expectAfter(2000, 1);
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

        await expectAfter(1999, 2);
        await expectAfter(1, 3);
        vi.useRealTimers();
        recoveredPty.emitData('after');
        await flush(streamer);
        expect(liveCalls.map(c => c.data)).toEqual(['after']);
      }, { ptyFactory: factory, reattachDelayMs: 1000, random: () => 0 });
    });

    it('treats a REISSUED generation (server restart, same name AND same claim) as gone — not the original session', async () => {
      const ptys = makePtys(2);
      const { factory, calls } = countingFactory(ptys);
      let probes = 0;
      const runner = mockRunner();
      runner.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('list-sessions')) {
          probes += 1;
          const pid = probes <= 2 ? '4242' : '9999';
          return { stdout: `${pid}|1700000000|$1|dev-1\n`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      let gone = 0;
      const { streamer } = makeStreamer({ ptyFactory: factory, runner });
      await streamer.subscribeAtomic({ onLive: () => undefined, onSessionGone: () => { gone++; } });
      expect(calls()).toBe(1);

      ptys[0].emitExit(0);
      await tick();
      expect(gone).toBe(1);
      expect(calls()).toBe(1);
      expect(streamer.isDestroyed()).toBe(true);
    });

    it('treats a fresh servers same-name FOREIGN session as gone on reconnect (does not reattach into it)', async () => {
      const ptys = makePtys(2);
      const { factory, calls } = countingFactory(ptys);
      let probes = 0;
      const runner = mockRunner();
      runner.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('list-sessions')) {
          probes += 1;
          const claim = probes <= 2 ? 'dev-1' : 'someone-else';
          return { stdout: `4242|1700000000|$1|${claim}\n`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      let gone = 0;
      const { streamer } = makeStreamer({ ptyFactory: factory, runner });
      await streamer.subscribeAtomic({ onLive: () => undefined, onSessionGone: () => { gone++; } });
      expect(calls()).toBe(1);

      ptys[0].emitExit(0);
      await tick();
      expect(gone).toBe(1);
      expect(calls()).toBe(1);
      expect(streamer.isDestroyed()).toBe(true);
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

    it('does not reattach and marks gone when the reconnect ownership probe resolves foreign/absent', async () => {
      const ptys = makePtys(2);
      const { factory, calls } = countingFactory(ptys);
      let resolveProbe!: (value: ExecResult) => void;
      let probeStarted!: () => void;
      const probeStartedPromise = new Promise<void>((resolve) => { probeStarted = resolve; });
      let probes = 0;
      const runner = mockRunner();
      runner.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('list-sessions')) {
          probes += 1;
          if (probes <= 2) return { stdout: '4242|1700000000|$1|dev-1\n', stderr: '', exitCode: 0 };
          probeStarted();
          return new Promise<ExecResult>((resolve) => { resolveProbe = resolve; });
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      const { streamer } = makeStreamer({ ptyFactory: factory, runner, reattachDelayMs: 1000 });
      await streamer.subscribeAtomic(cbs);
      expect(calls()).toBe(1);

      ptys[0].emitExit(0);
      await probeStartedPromise;
      expect(calls()).toBe(1);

      resolveProbe({ stdout: '', stderr: '', exitCode: 0 });
      await tick();

      expect(streamer.isDestroyed()).toBe(true);
      expect(calls()).toBe(1);
      expect(_sessionGoneCalls).toBe(1);
    });

    it('post-attach handshake tears down before Web I/O when the connected session is a reissued generation', async () => {
      const ptys = makePtys(2);
      const { factory, calls } = countingFactory(ptys);
      let probes = 0;
      const runner = mockRunner();
      runner.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('list-sessions')) {
          probes += 1;
          const pid = probes === 1 ? '4242' : '9999';
          return { stdout: `${pid}|1700000000|$1|dev-1\n`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      const { streamer } = makeStreamer({ ptyFactory: factory, runner });

      await expect(streamer.subscribeAtomic(cbs)).rejects.toThrow(/destroyed/i);
      expect(streamer.isDestroyed()).toBe(true);
      expect(calls()).toBe(1);
    });

    it('post-attach handshake fails closed on an uncertain probe: tears down the PTY, never streams unverified', async () => {
      const ptys = makePtys(2);
      const { factory } = countingFactory(ptys);
      let probes = 0;
      const runner = mockRunner();
      runner.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('list-sessions')) {
          probes += 1;
          if (probes === 1) return { stdout: '4242|1700000000|$1|dev-1\n', stderr: '', exitCode: 0 };
          throw new Error('probe timeout');
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      const live: string[] = [];
      const { streamer } = makeStreamer({ ptyFactory: factory, runner, reattachDelayMs: 100_000 });
      await streamer.subscribeAtomic({ onLive: (d) => live.push(d), onSessionGone: () => undefined });

      expect(ptys[0].killCalled).toBeGreaterThanOrEqual(1);
      expect(live).toEqual([]);
      streamer.destroy();
    });

    it('quarantines PTY output during the handshake and discards it when the session proves foreign (never streams unverified bytes)', async () => {
      const ptys = makePtys(1);
      const { factory } = countingFactory(ptys);
      let probes = 0;
      let resolvePostAttach!: (v: ExecResult) => void;
      let postAttachStarted!: () => void;
      const postAttachStartedP = new Promise<void>((r) => { postAttachStarted = r; });
      const runner = mockRunner();
      runner.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('list-sessions')) {
          probes += 1;
          if (probes === 1) return { stdout: '4242|1700000000|$1|dev-1\n', stderr: '', exitCode: 0 };
          postAttachStarted();
          return new Promise<ExecResult>((resolve) => { resolvePostAttach = resolve; });
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      const live: string[] = [];
      const { streamer } = makeStreamer({ ptyFactory: factory, runner });
      const subP = streamer.subscribeAtomic({ onLive: (d) => live.push(d), onSessionGone: () => undefined }).catch(() => undefined);

      await postAttachStartedP;
      ptys[0].emitData('unverified-foreign-bytes');
      await tick();
      expect(live).toEqual([]);

      resolvePostAttach({ stdout: '9999|1700000000|$1|dev-1\n', stderr: '', exitCode: 0 });
      await subP;
      await tick();
      expect(live).toEqual([]);
      expect(streamer.isDestroyed()).toBe(true);
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

    it('keeps backing off when a reattach emits output then exits without staying stable', async () => {
      const ptys = makePtys(3);
      const { factory, expectAfter } = countingFactory(ptys);
      await withTimerHarness(async () => {
        ptys[0].emitExit(0);
        await tick();

        await expectAfter(1000, 2);

        ptys[1].emitData('Connection closed by 1.2.3.4 port 6003\r\n');
        ptys[1].emitExit(0);
        await tick();

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

        await vi.advanceTimersByTimeAsync(1000);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        await expectAfter(2000, 3);

        await vi.advanceTimersByTimeAsync(4999);
        expect(recoveredLines()).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(recoveredLines()).toEqual(['[pane-streamer] dev-1 attach recovered']);

        ptys[2].emitExit(0);
        await tick();
        await expectAfter(999, 3);
        await expectAfter(1, 4);
      }, { ptyFactory: factory, reattachDelayMs: 1000, reattachStableAfterMs: 5000, random: () => 0 });
    });
  });

  describe('idle grace + lazy GC', () => {
    it('restores idle cleanup when subscription startup fails', async () => {
      await withFakeTimers(async () => {
        const { streamer } = makeStreamer({
          idleGraceMs: 100,
          ptyFactory: () => { throw new Error('attach spawn failed'); },
        });

        await expect(streamer.subscribeAtomic(cbs)).rejects.toThrow('attach spawn failed');
        await vi.advanceTimersByTimeAsync(99);
        expect(streamer.isDestroyed()).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(streamer.isDestroyed()).toBe(true);
      });
    });

    it('destroys a one-shot snapshot streamer after the idle grace', async () => {
      await withFakeTimers(async () => {
        const { streamer, fakePty } = makeStreamer({ idleGraceMs: 100 });

        await streamer.getSnapshotAtomic();
        await vi.advanceTimersByTimeAsync(99);
        expect(streamer.isDestroyed()).toBe(false);
        await vi.advanceTimersByTimeAsync(1);

        expect(streamer.isDestroyed()).toBe(true);
        expect(fakePty.killCalled).toBe(1);
      });
    });

    it('keeps a snapshot streamer alive while a subscriber is active', async () => {
      await withFakeTimers(async () => {
        const { streamer } = makeStreamer({ idleGraceMs: 100 });
        const subscription = await streamer.subscribeAtomic(cbs);

        await streamer.getSnapshotAtomic();
        await vi.advanceTimersByTimeAsync(200);

        expect(streamer.isDestroyed()).toBe(false);
        subscription.unsubscribe();
        streamer.destroy();
      });
    });

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
it('without geometry hooks: local pty+headless resize only, zero tmux writes', async () => {
      const { streamer, runner, fakePty } = await subscribed();
      mockSessionSnapshot(runner);
      const beforeExecs = runner.exec.mock.calls.length;
      await streamer.resize(160, 40);
      expect(fakePty.resizeCalls).toEqual([{ cols: 160, rows: 40 }]);
      await expectDims(streamer, 160, 40);
      expect(runner.exec.mock.calls.length).toBe(beforeExecs);
      streamer.destroy();
    });

    it('with geometry hooks: records full target before committing the owner write', async () => {
      const calls: string[] = [];
      const hooks = stubGeometryHooks({
        recordFullTarget: (size) => { calls.push(`target:${size.cols}x${size.rows}`); },
        commitOwnerResize: async () => { calls.push('commit'); },
      });
      const { streamer, fakePty } = await subscribed({ geometry: hooks });
      await streamer.resize(120, 30);
      expect(calls).toEqual(['target:120x30', 'commit']);
      expect(fakePty.resizeCalls.at(-1)).toEqual({ cols: 120, rows: 30 });
      await expectDims(streamer, 120, 30);
      streamer.destroy();
    });

    it('owner commit rejection propagates but the local stream keeps the new size (target survives in owner state)', async () => {
      const hooks = stubGeometryHooks({
        commitOwnerResize: async () => { throw new Error('deadline'); },
      });
      const { streamer, fakePty } = await subscribed({ geometry: hooks });
      await expect(streamer.resize(90, 22)).rejects.toThrow('deadline');
      expect(fakePty.resizeCalls.at(-1)).toEqual({ cols: 90, rows: 22 });
      await expectDims(streamer, 90, 22);
      streamer.destroy();
    });

    it('resize schedules a preview snapshot refresh with the new geometry', async () => {
      const hooks = stubGeometryHooks();
      const made = makeStreamer({ geometry: hooks });
      const refreshes: Array<{ cols: number; rows: number }> = [];
      await made.streamer.subscribeAtomic({
        ...cbs,
        onSnapshotRefresh: (snap) => { refreshes.push({ cols: snap.cols, rows: snap.rows }); },
      });
      await made.streamer.resize(100, 25);
      await flush(made.streamer);
      expect(refreshes.at(-1)).toEqual({ cols: 100, rows: 25 });
      made.streamer.destroy();
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
      () => { resolveCalls++; return host; },
      { ptyFactory: (cmd) => { captured.push(cmd); return fakePty; }, idleGraceMs: 50 },
    );
    await streamer.subscribeAtomic(NOOP_CBS);

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

  it('does not touch real node-pty when the package dir cannot be resolved', () => {
    const mustNotRun = () => {
      throw new Error('must not run when packageDir is unresolved');
    };
    expect(() =>
      ensureSpawnHelperExecutable('', { chmod: mustNotRun, load: mustNotRun, canExecute: () => false }),
    ).not.toThrow();
  });
});

describe('attach capability handshake', () => {
  function recordingFactory(probeOutputs: Array<string | null>): {
    factory: PtyFactory;
    attachCmds: string[];
    probeCount: () => number;
  } {
    let probes = 0;
    const attachCmds: string[] = [];
    const factory: PtyFactory = (cmd) => {
      const script = cmd.args.join(' ');
      if (script.includes('tmux -V')) {
        const out = probeOutputs[Math.min(probes, probeOutputs.length - 1)];
        probes++;
        const pty = createFakePty();
        queueMicrotask(() => {
          if (out !== null) pty.emitData(out);
          pty.emitExit(0);
        });
        return pty;
      }
      attachCmds.push(script);
      return createFakePty();
    };
    return { factory, attachCmds, probeCount: () => probes };
  }

  it('parseAttachFlagCapability: >=3.2 true, <3.2 false, garbage null', () => {
    expect(parseAttachFlagCapability('tmux 3.2a\n')).toBe(true);
    expect(parseAttachFlagCapability('tmux 3.6a\n')).toBe(true);
    expect(parseAttachFlagCapability('tmux next-3.7\n')).toBe(true);
    expect(parseAttachFlagCapability('tmux 3.1c\n')).toBe(false);
    expect(parseAttachFlagCapability('tmux 2.9\n')).toBe(false);
    expect(parseAttachFlagCapability('zsh: command not found\n')).toBeNull();
  });

  it('known >=3.2: attach carries -f ignore-size and the capability is cached per instance', async () => {
    const { factory, attachCmds, probeCount } = recordingFactory(['tmux 3.6a\n']);
    const { streamer } = makeStreamer({
      ptyFactory: factory,
      geometry: stubGeometryHooks({ raceProbe: (start) => start().result }),
    });
    await streamer.subscribeAtomic(cbs);
    expect(attachCmds[0]).toContain('attach-session -f ignore-size -t');
    expect(probeCount()).toBe(1);
    streamer.destroy();
  });

  it('known <3.2: no flag, cached (no re-probe on reattach)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const ptys = [createFakePty(), createFakePty()];
      let attaches = 0;
      const attachCmds: string[] = [];
      let probes = 0;
      const factory: PtyFactory = (cmd) => {
        const script = cmd.args.join(' ');
        if (script.includes('tmux -V')) {
          probes++;
          const pty = createFakePty();
          queueMicrotask(() => { pty.emitData('tmux 3.1c\n'); pty.emitExit(0); });
          return pty;
        }
        attachCmds.push(script);
        return ptys[attaches++];
      };
      const { streamer } = makeStreamer({
        ptyFactory: factory,
        geometry: stubGeometryHooks({ raceProbe: (start) => start().result }),
        reattachDelayMs: 0,
      });
      await streamer.subscribeAtomic(cbs);
      expect(attachCmds[0]).not.toContain('ignore-size');
      ptys[0].emitExit();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1100);
      expect(attaches).toBe(2);
      expect(attachCmds[1]).not.toContain('ignore-size');
      expect(probes).toBe(1);
      streamer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('unparseable probe output: flagless this spawn, NOT cached (re-probed on reattach)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ptys = [createFakePty(), createFakePty()];
      let attaches = 0;
      const attachCmds: string[] = [];
      let probes = 0;
      const factory: PtyFactory = (cmd) => {
        const script = cmd.args.join(' ');
        if (script.includes('tmux -V')) {
          const out = probes === 0 ? 'command not found\n' : 'tmux 3.6a\n';
          probes++;
          const pty = createFakePty();
          queueMicrotask(() => { pty.emitData(out); pty.emitExit(0); });
          return pty;
        }
        attachCmds.push(script);
        return ptys[attaches++];
      };
      const { streamer } = makeStreamer({
        ptyFactory: factory,
        geometry: stubGeometryHooks({ raceProbe: (start) => start().result }),
        reattachDelayMs: 0,
      });
      await streamer.subscribeAtomic(cbs);
      expect(attachCmds[0]).not.toContain('ignore-size');
      ptys[0].emitExit();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1100);
      expect(probes).toBe(2);
      expect(attachCmds[1]).toContain('ignore-size');
      streamer.destroy();
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('probe rejection (deadline/admission): flagless spawn, subscribe still completes', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const attachCmds: string[] = [];
      const factory: PtyFactory = (cmd) => {
        const script = cmd.args.join(' ');
        if (!script.includes('tmux -V')) attachCmds.push(script);
        return createFakePty();
      };
      const hooks = stubGeometryHooks({
        raceProbe: () => Promise.reject(new Error('geometry settle deadline (6000ms) exceeded')),
      });
      const { streamer } = makeStreamer({ ptyFactory: factory, geometry: hooks });
      const result = await streamer.subscribeAtomic(cbs);
      expect(result.snapshot.cols).toBe(200);
      expect(attachCmds[0]).not.toContain('ignore-size');
      streamer.destroy();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('spawn geometry baseline', () => {
  const GEOM = (w: number, h: number, mode = 'latest'): import('../../src/agent/tmux.js').WindowGeometry => ({
    width: w,
    height: h,
    statusLines: 1,
    sizeMode: mode,
    ownerGen: null,
    ref: { serverPid: '1', serverStart: '2', sessionId: '$3' },
    fencedCapable: true,
  });

  it('flagged + holds==0: headless AND pty spawn at desiredTty (W + status lines)', async () => {
    const { factory, attachSizes } = sizeRecordingFactory();
    const hooks = stubGeometryHooks({
      raceProbe: probeAnswer('tmux 3.6a\n'),
      readGeometry: async () => GEOM(100, 30),
    });
    const made = makeStreamer({ ptyFactory: factory, geometry: hooks });
    const result = await made.streamer.subscribeAtomic(cbs);
    expect(result.snapshot.cols).toBe(100);
    expect(result.snapshot.rows).toBe(31);
    expect(attachSizes[0]).toEqual({ cols: 100, rows: 31 });
    made.streamer.destroy();
  });

  it('reattach baseline change re-baselines an ACTIVE preview via snapshot refresh (no stale geometry residue)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let width = 100;
      const attachPtys = [createFakePty(), createFakePty()];
      let attaches = 0;
      const factory: PtyFactory = (cmd) => {
        if (cmd.args.join(' ').includes('tmux -V')) {
          const pty = createFakePty();
          queueMicrotask(() => { pty.emitData('tmux 3.6a\n'); pty.emitExit(0); });
          return pty;
        }
        return attachPtys[attaches++];
      };
      const hooks = stubGeometryHooks({
        raceProbe: (start) => start().result,
        readGeometry: async () => GEOM(width, 30),
      });
      const made = makeStreamer({ ptyFactory: factory, geometry: hooks, reattachDelayMs: 0 });
      const refreshes: Array<{ cols: number; rows: number }> = [];
      await made.streamer.subscribeAtomic({
        ...cbs,
        onSnapshotRefresh: (snap) => refreshes.push({ cols: snap.cols, rows: snap.rows }),
      });
      expect(made.streamer.size).toEqual({ cols: 100, rows: 31 });

      width = 120;
      attachPtys[0].emitExit();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1500);
      expect(attaches).toBe(2);
      expect(made.streamer.size).toEqual({ cols: 120, rows: 31 });
      made.streamer._waitForChainDrain();
      await vi.advanceTimersByTimeAsync(1);
      expect(refreshes.at(-1)).toEqual({ cols: 120, rows: 31 });
      made.streamer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drains old data before a reattach baseline resize', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      let width = 80;
      const attachPtys = [createFakePty(), createFakePty()];
      let attaches = 0;
      const factory: PtyFactory = () => attachPtys[attaches++];
      const hooks = stubGeometryHooks({
        raceProbe: probeAnswer('tmux 3.6a\n'),
        readGeometry: async () => GEOM(width, 23),
      });
      const made = makeStreamer({
        ptyFactory: factory,
        geometry: hooks,
        initialCols: 80,
        initialRows: 24,
        reattachDelayMs: 1000,
      });
      const seen: Array<{ visible: string; cols: number }> = [];
      await made.streamer.subscribeAtomic({
        onVisible: (visible) => seen.push({ visible, cols: made.streamer.size.cols }),
        onSessionGone: () => undefined,
      });

      const terminal = (made.streamer as unknown as {
        headless: { write(data: string, callback?: () => void): void };
      }).headless;
      const write = terminal.write.bind(terminal);
      let releaseWrite: (() => void) | undefined;
      terminal.write = (data, callback) => {
        write(data, () => { releaseWrite = callback; });
      };

      attachPtys[0].emitData('\x1b[74G[bx:pr-\x1b[2;1Hfixed:tok123abc]');
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(releaseWrite).toBeTypeOf('function');

      width = 20;
      attachPtys[0].emitExit();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1000);

      expect(attaches).toBe(1);
      expect(made.streamer.size.cols).toBe(80);

      releaseWrite?.();
      await vi.advanceTimersByTimeAsync(1);
      await made.streamer._waitForChainDrain();

      expect(attaches).toBe(2);
      expect(made.streamer.size.cols).toBe(20);
      expect(seen).toEqual([{ visible: '[bx:pr-fixed:tok123abc]', cols: 80 }]);
      made.streamer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drains quarantined reattach output before follow can change geometry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      let width = 20;
      const attachPtys = [createFakePty(), createFakePty()];
      let attaches = 0;
      const factory: PtyFactory = () => attachPtys[attaches++];
      let probes = 0;
      let resolvePostAttach: ((result: ExecResult) => void) | undefined;
      let postAttachStarted!: () => void;
      const postAttachStartedP = new Promise<void>((resolve) => { postAttachStarted = resolve; });
      const runner = mockRunner();
      runner.exec.mockImplementation(async (cmd: string) => {
        if (!cmd.includes('list-sessions')) return { stdout: '', stderr: '', exitCode: 0 };
        probes++;
        if (probes === 5) {
          postAttachStarted();
          return new Promise<ExecResult>((resolve) => { resolvePostAttach = resolve; });
        }
        return { stdout: '4242|1700000000|$1|dev-1\n', stderr: '', exitCode: 0 };
      });
      const hooks = stubGeometryHooks({
        raceProbe: probeAnswer('tmux 3.6a\n'),
        readGeometry: async () => GEOM(width, 23),
      });
      const made = makeStreamer({
        ptyFactory: factory,
        runner,
        geometry: hooks,
        initialCols: 20,
        initialRows: 24,
        reattachDelayMs: 1000,
        windowFollowIntervalMs: 200,
      });
      const seen: string[] = [];
      await made.streamer.subscribeAtomic({
        onVisible: (visible) => seen.push(visible),
        onSessionGone: () => undefined,
      });

      attachPtys[0].emitExit();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1000);
      await postAttachStartedP;

      attachPtys[1].emitData('\x1b[74G[bx:pr-\x1b[2;1Hfixed:tok123abc]');
      width = 80;
      await vi.advanceTimersByTimeAsync(250);
      expect(made.streamer.size.cols).toBe(20);

      resolvePostAttach?.({ stdout: '4242|1700000000|$1|dev-1\n', stderr: '', exitCode: 0 });
      await vi.advanceTimersByTimeAsync(1);
      await made.streamer._waitForChainDrain();
      expect(seen.join('')).toContain('[bx:pr-\x00fixed:tok123abc]');

      await vi.advanceTimersByTimeAsync(250);
      expect(made.streamer.size.cols).toBe(80);
      made.streamer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('geometry read failure: spawn keeps current headless size (todays behavior)', async () => {
    const { factory, attachSizes } = sizeRecordingFactory();
    const hooks = stubGeometryHooks({
      raceProbe: probeAnswer('tmux 3.6a\n'),
      readGeometry: async () => { throw new Error('deadline'); },
    });
    const made = makeStreamer({ ptyFactory: factory, geometry: hooks });
    const result = await made.streamer.subscribeAtomic(cbs);
    expect(result.snapshot.cols).toBe(200);
    expect(result.snapshot.rows).toBe(50);
    expect(attachSizes[0]).toEqual({ cols: 200, rows: 50 });
    made.streamer.destroy();
  });

  it('holds>0: baseline skipped entirely (web owns geometry), zero geometry reads', async () => {
    let reads = 0;
    const { factory, attachSizes } = sizeRecordingFactory();
    const hooks = stubGeometryHooks({
      raceProbe: probeAnswer('tmux 3.6a\n'),
      fullHolds: () => 1,
      readGeometry: async () => { reads++; return GEOM(100, 30); },
    });
    const made = makeStreamer({ ptyFactory: factory, geometry: hooks });
    await made.streamer.subscribeAtomic(cbs);
    expect(reads).toBe(0);
    expect(attachSizes[0]).toEqual({ cols: 200, rows: 50 });
    made.streamer.destroy();
  });

  it('holds flipping 0→1 during the read: baseline abandoned (zero change)', async () => {
    let holds = 0;
    const { factory, attachSizes } = sizeRecordingFactory();
    const hooks = stubGeometryHooks({
      raceProbe: probeAnswer('tmux 3.6a\n'),
      fullHolds: () => holds,
      readGeometry: async () => {
        holds = 1;
        return GEOM(100, 30);
      },
    });
    const made = makeStreamer({ ptyFactory: factory, geometry: hooks });
    const result = await made.streamer.subscribeAtomic(cbs);
    expect(result.snapshot.cols).toBe(200);
    expect(attachSizes[0]).toEqual({ cols: 200, rows: 50 });
    made.streamer.destroy();
  });

  function sizeRecordingFactory(): { factory: PtyFactory; attachSizes: Array<{ cols: number; rows: number }> } {
    const attachSizes: Array<{ cols: number; rows: number }> = [];
    const factory: PtyFactory = (cmd, cols, rows) => {
      const script = cmd.args.join(' ');
      if (script.includes('tmux -V')) {
        const pty = createFakePty();
        queueMicrotask(() => { pty.emitData('tmux 3.6a\n'); pty.emitExit(0); });
        return pty;
      }
      attachSizes.push({ cols, rows });
      return createFakePty();
    };
    return { factory, attachSizes };
  }

  function probeAnswer(version: string): StreamerGeometryHooks['raceProbe'] {
    return (<T>(_start: () => ProbeHandle<T>) => Promise.resolve(version as T)) as StreamerGeometryHooks['raceProbe'];
  }
});

describe('viewport follow tick', () => {
  const GEOM = (w: number, h: number, mode = 'latest'): import('../../src/agent/tmux.js').WindowGeometry => ({
    width: w,
    height: h,
    statusLines: 1,
    sizeMode: mode,
    ownerGen: null,
    ref: { serverPid: '1', serverStart: '2', sessionId: '$3' },
    fencedCapable: true,
  });

  function flaggedFactory(attachPty: FakePty): PtyFactory {
    return (cmd) => {
      if (cmd.args.join(' ').includes('tmux -V')) {
        const pty = createFakePty();
        queueMicrotask(() => { pty.emitData('tmux 3.6a\n'); pty.emitExit(0); });
        return pty;
      }
      return attachPty;
    };
  }

  async function followHarness(opts: {
    geom: () => Promise<import('../../src/agent/tmux.js').WindowGeometry>;
    holds?: () => number;
    noteManualSeen?: () => void;
  }): Promise<{ streamer: PaneStreamer; attachPty: FakePty; reads: () => number }> {
    let reads = 0;
    const attachPty = createFakePty();
    const hooks = stubGeometryHooks({
      raceProbe: (start) => start().result,
      fullHolds: opts.holds ?? (() => 0),
      readGeometry: async () => { reads++; return opts.geom(); },
      noteManualSeen: opts.noteManualSeen ?? (() => undefined),
    });
    const made = makeStreamer({
      ptyFactory: flaggedFactory(attachPty),
      geometry: hooks,
      windowFollowIntervalMs: 200,
    });
    await made.streamer.subscribeAtomic(cbs);
    return { streamer: made.streamer, attachPty, reads: () => reads };
  }

  it('external W change: pty+headless follow desiredTty and previews get a refresh', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      let width = 100;
      const h = await followHarness({ geom: async () => GEOM(width, 30) });
      expect(h.streamer.size).toEqual({ cols: 100, rows: 31 });

      width = 140;
      await vi.advanceTimersByTimeAsync(250);
      expect(h.streamer.size).toEqual({ cols: 140, rows: 31 });
      expect(h.attachPty.resizeCalls.at(-1)).toEqual({ cols: 140, rows: 31 });
      h.streamer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('geometry unchanged: tick is a pure read, zero resizes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const h = await followHarness({ geom: async () => GEOM(100, 30) });
      const before = h.attachPty.resizeCalls.length;
      await vi.advanceTimersByTimeAsync(650);
      expect(h.reads()).toBeGreaterThanOrEqual(2);
      expect(h.attachPty.resizeCalls.length).toBe(before);
      h.streamer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('manual sizeMode: reports to the owner reconciler and never writes itself', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      let manualSeen = 0;
      const h = await followHarness({
        geom: async () => GEOM(100, 30, 'manual'),
        noteManualSeen: () => { manualSeen++; },
      });
      const before = h.attachPty.resizeCalls.length;
      await vi.advanceTimersByTimeAsync(250);
      expect(manualSeen).toBe(1);
      expect(h.attachPty.resizeCalls.length).toBe(before);
      h.streamer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds>0 suspends follow reads entirely', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const h = await followHarness({ geom: async () => GEOM(100, 30), holds: () => 1 });
      const baseline = h.reads();
      await vi.advanceTimersByTimeAsync(650);
      expect(h.reads()).toBe(baseline);
      h.streamer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('read failures warn once, stay silent, and recovery is logged', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      let fail = true;
      const h = await followHarness({
        geom: async () => {
          if (fail) throw new Error('ssh flake');
          return GEOM(100, 30);
        },
      });
      await vi.advanceTimersByTimeAsync(650);
      const followWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('follow geometry read failing'));
      expect(followWarns.length).toBe(1);

      fail = false;
      await vi.advanceTimersByTimeAsync(250);
      const recoveries = logSpy.mock.calls.filter((c) => String(c[0]).includes('follow geometry read recovered'));
      expect(recoveries.length).toBe(1);
      h.streamer.destroy();
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('singleflight: a hung read spans intervals without stacking concurrent reads', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      let tickReads = 0;
      let baselineDone = false;
      let release: (() => void) | null = null;
      const h = await followHarness({
        geom: () => {
          if (!baselineDone) {
            baselineDone = true;
            return Promise.resolve(GEOM(100, 30));
          }
          tickReads++;
          return new Promise((resolve) => {
            release = () => resolve(GEOM(100, 30));
          });
        },
      });
      await vi.advanceTimersByTimeAsync(850);
      expect(tickReads).toBe(1);
      release!();
      await vi.advanceTimersByTimeAsync(250);
      expect(tickReads).toBe(2);
      h.streamer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('flagless pty (unknown capability) never arms the follow timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let reads = 0;
      const hooks = stubGeometryHooks({
        raceProbe: () => Promise.reject(new Error('probe deadline')),
        readGeometry: async () => { reads++; return GEOM(100, 30); },
      });
      const made = makeStreamer({ geometry: hooks, windowFollowIntervalMs: 200 });
      await made.streamer.subscribeAtomic(cbs);
      await vi.advanceTimersByTimeAsync(650);
      expect(reads).toBe(0);
      made.streamer.destroy();
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('normalizeFollowIntervalMs: invalid values fall back to the default, floor clamps apply, no disable value exists', () => {
    expect(normalizeFollowIntervalMs(undefined)).toBe(1500);
    expect(normalizeFollowIntervalMs(0)).toBe(1500);
    expect(normalizeFollowIntervalMs(-5)).toBe(1500);
    expect(normalizeFollowIntervalMs(Number.NaN)).toBe(1500);
    expect(normalizeFollowIntervalMs(50)).toBe(200);
    expect(normalizeFollowIntervalMs(2000)).toBe(2000);
  });
});

describe('PaneStreamer visible-text stream', () => {
  const ESC = '\x1b';
  const BEL = '\x07';
  const MARKER = '[bx:pr-fixed:tok123abc]';

  function visibleSub(): { cbs: SubscriberCallbacks; seen: Array<{ visible: string; seq: number }> } {
    const seen: Array<{ visible: string; seq: number }> = [];
    return {
      seen,
      cbs: { onVisible: (visible, seq) => seen.push({ visible, seq }), onSessionGone: () => undefined },
    };
  }

  it('broadcasts the decoded chunk alongside the raw one, on the same seq', async () => {
    const { streamer, fakePty } = makeStreamer();
    const raw: Array<{ data: string; seq: number }> = [];
    const { cbs: visCbs, seen } = visibleSub();
    await streamer.subscribeAtomic({
      onLive: (data, seq) => raw.push({ data, seq }),
      onVisible: visCbs.onVisible,
      onSessionGone: () => undefined,
    });

    fakePty.emitData(`${ESC}[31mhello${ESC}[0m`);
    await flush(streamer);

    expect(raw).toEqual([{ data: `${ESC}[31mhello${ESC}[0m`, seq: 0 }]);
    expect(seen).toEqual([{ visible: 'hello', seq: 0 }]);
    streamer.destroy();
  });

  it('keeps a control string opened BEFORE the subscription open for the new subscriber', async () => {
    const { streamer, fakePty } = makeStreamer();
    await streamer.subscribeAtomic(NOOP_CBS);

    fakePty.emitData(`${ESC}]0;title-start`);
    await flush(streamer);

    const { cbs: lateCbs, seen } = visibleSub();
    await streamer.subscribeAtomic(lateCbs);

    fakePty.emitData(`${MARKER}${BEL}`);
    await flush(streamer);
    expect(seen.map(s => s.visible).join('')).toBe('');

    fakePty.emitData('now visible');
    await flush(streamer);
    expect(seen.map(s => s.visible).join('')).toBe('now visible');
    streamer.destroy();
  });

  it('decodes once and hands every subscriber the same text', async () => {
    const { streamer, fakePty } = makeStreamer();
    const a = visibleSub();
    const b = visibleSub();
    await streamer.subscribeAtomic(a.cbs);
    await streamer.subscribeAtomic(b.cbs);

    fakePty.emitData(`${ESC}]0;x${BEL}shared`);
    await flush(streamer);

    expect(a.seen).toEqual([{ visible: 'shared', seq: 0 }]);
    expect(b.seen).toEqual(a.seen);
    streamer.destroy();
  });

  it('carries decode state across chunk splits, so a torn control string never leaks', async () => {
    const { streamer, fakePty } = makeStreamer();
    const { cbs: visCbs, seen } = visibleSub();
    await streamer.subscribeAtomic(visCbs);

    for (const chunk of [`${ESC}]0;`, MARKER, BEL, 'tail']) {
      fakePty.emitData(chunk);
      await flush(streamer);
    }
    expect(seen.map(s => s.visible).join('')).toBe('tail');
    streamer.destroy();
  });

  it('keeps the decoder on pane geometry and fences adjacency across resize', async () => {
    const { streamer, fakePty } = makeStreamer({ initialCols: 20, initialRows: 10 });
    const { cbs: visCbs, seen } = visibleSub();
    await streamer.subscribeAtomic(visCbs);

    fakePty.emitData(`${ESC}[19G[bx:pr-${ESC}[2;6Hfixed:tok123abc]`);
    await flush(streamer);
    expect(seen.map(s => s.visible).join('')).toBe(MARKER);

    seen.length = 0;
    fakePty.emitData(`${ESC}[10;1H[bx:pr-${ESC}[Bfixed:tok123abc]`);
    await flush(streamer);
    expect(seen.map(s => s.visible).join('')).toContain(MARKER);

    seen.length = 0;
    fakePty.emitData('[bx:pr-');
    await flush(streamer);
    await streamer.resize(30, 10);
    fakePty.emitData('fixed:tok123abc]');
    await flush(streamer);
    expect(seen.map(s => s.visible).join('')).toContain('[bx:pr-\x00fixed:tok123abc]');
    streamer.destroy();
  });

  it('serializes resize behind data already handed to the terminal parser', async () => {
    const { streamer, fakePty } = makeStreamer({ initialCols: 80, initialRows: 24 });
    const seen: Array<{ visible: string; cols: number }> = [];
    await streamer.subscribeAtomic({
      onVisible: (visible) => { seen.push({ visible, cols: streamer.size.cols }); },
      onSessionGone: () => undefined,
    });

    fakePty.emitData(`${ESC}[74G[bx:pr-${ESC}[2;1Hfixed:tok123abc]`);
    await Promise.resolve();
    const resize = streamer.resize(20, 24);
    expect(streamer.size.cols).toBe(80);
    await resize;
    await flush(streamer);

    expect(seen).toEqual([{ visible: MARKER, cols: 80 }]);
    expect(streamer.size).toEqual({ cols: 20, rows: 24 });
    streamer.destroy();
  });

  it('a visible-only subscriber keeps the streamer alive (idle accounting counts it)', async () => {
    const { streamer, fakePty } = makeStreamer({ idleGraceMs: 10 });
    const { cbs: visCbs, seen } = visibleSub();
    await streamer.subscribeAtomic(visCbs);

    await new Promise(resolve => setTimeout(resolve, 40));
    expect(streamer.isDestroyed()).toBe(false);

    fakePty.emitData('still here');
    await flush(streamer);
    expect(seen.map(s => s.visible).join('')).toBe('still here');
    streamer.destroy();
  });
});
