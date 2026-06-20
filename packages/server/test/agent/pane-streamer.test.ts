import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentConfig, HostConfig } from '../../src/shared/index.js';
import {
  PaneStreamer,
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

const TEST_AGENT: AgentConfig = {
  id: 'dev-1',
  runtime: 'codex',
  role: 'dev',
  mode: 'local',
};

function makeStreamer(opts?: {
  agent?: AgentConfig;
  fakePty?: FakePty;
  idleGraceMs?: number;
  reattachDelayMs?: number;
  sessionProbeTimeoutMs?: number;
  scrollbackLines?: number;
}): {
  streamer: PaneStreamer;
  fakePty: FakePty;
  runner: ReturnType<typeof mockRunner>;
} {
  const fakePty = opts?.fakePty ?? createFakePty();
  const ptyFactory: PtyFactory = () => fakePty;
  const runner = mockRunner();
  const tmux = new TmuxManager(runner);
  const streamer = new PaneStreamer(opts?.agent ?? TEST_AGENT, tmux, runner, () => undefined, {
    ptyFactory,
    idleGraceMs: opts?.idleGraceMs ?? 50,
    reattachDelayMs: opts?.reattachDelayMs,
    sessionProbeTimeoutMs: opts?.sessionProbeTimeoutMs,
    scrollbackLines: opts?.scrollbackLines,
  });
  return { streamer, fakePty, runner };
}

async function flush(streamer: PaneStreamer): Promise<void> {
  await streamer._waitForChainDrain();
  await new Promise<void>(r => setImmediate(r));
  await streamer._waitForChainDrain();
}

describe('PaneStreamer', () => {
  let liveCalls: Array<{ data: string; seq: number }>;
  let _sessionGoneCalls: number;
  let cbs: SubscriberCallbacks;

  beforeEach(() => {
    liveCalls = [];
    _sessionGoneCalls = 0;
    cbs = {
      onLive: (data: string, seq: number) => liveCalls.push({ data, seq }),
      onSessionGone: () => { _sessionGoneCalls++; },
    };
  });

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
      const { streamer, fakePty } = makeStreamer();
      await streamer.subscribeAtomic(cbs);
      expect(fakePty.killCalled).toBe(0);  // pty alive
      streamer.destroy();
    });

    it('snapshot reflects all data written before subscribe (chain ordering)', async () => {
      const { streamer, fakePty } = makeStreamer();
      const sub1 = await streamer.subscribeAtomic(cbs);
      expect(sub1.snapshotSeq).toBe(-1);

      fakePty.emitData('hello world');
      await flush(streamer);

      const sub2 = await streamer.subscribeAtomic({
        onLive: () => undefined,
        onSessionGone: () => undefined,
      });
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
      const { streamer, fakePty } = makeStreamer();
      await streamer.subscribeAtomic(cbs);
      fakePty.emitData('hello');
      await flush(streamer);

      const probeLive: Array<{ data: string; seq: number }> = [];
      const probeOnLive = (d: string, s: number) => { probeLive.push({ data: d, seq: s }); };
      const onSessionGone = () => undefined;

      const result = await streamer.getSnapshotAtomic();
      expect(result.snapshot.data).toContain('hello');
      expect(result.snapshotSeq).toBe(0);

      fakePty.emitData('world');
      await flush(streamer);
      expect(probeLive).toEqual([]);
      expect(liveCalls.map(c => c.data)).toEqual(['hello', 'world']);

      void probeOnLive; void onSessionGone;
      streamer.destroy();
    });
  });

  describe('onPtyData chain ordering', () => {
    it('subscribe queued during in-flight onPtyData sees that chunk in snapshot, not in live', async () => {
      const { streamer, fakePty } = makeStreamer();

      await streamer.subscribeAtomic(cbs);

      fakePty.emitData('X');
      const subPromise = streamer.subscribeAtomic({
        onLive: () => undefined,
        onSessionGone: () => undefined,
      });
      const sub = await subPromise;
      await flush(streamer);

      expect(sub.snapshot.data).toContain('X');
      expect(sub.snapshotSeq).toBe(0);
      streamer.destroy();
    });

    it('seq increments monotonically per onPtyData chunk', async () => {
      const { streamer, fakePty } = makeStreamer();
      await streamer.subscribeAtomic(cbs);

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
      let streamer: PaneStreamer | null = null;
      let usingFakeTimers = false;
      try {
        const ptys = [createFakePty(), createFakePty()];
        let factoryCalls = 0;
        const runner = mockRunner();
        const tmux = new TmuxManager(runner);
        streamer = new PaneStreamer(TEST_AGENT, tmux, runner, () => undefined, {
          ptyFactory: () => ptys[factoryCalls++],
          idleGraceMs: 50,
          reattachDelayMs: 1000,
          random: () => 0,
        });
        let gone = 0;
        const liveAfterReattach: string[] = [];
        await streamer.subscribeAtomic({
          onLive: (data) => liveAfterReattach.push(data),
          onSessionGone: () => { gone++; },
        });

        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        usingFakeTimers = true;
        ptys[0].emitExit(0);
        await new Promise<void>(r => setImmediate(r));

        expect(gone).toBe(0);
        expect(streamer.isDestroyed()).toBe(false);
        expect(factoryCalls).toBe(1);
        await vi.advanceTimersByTimeAsync(999);
        expect(factoryCalls).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(factoryCalls).toBe(2);
        vi.useRealTimers();
        usingFakeTimers = false;
        ptys[1].emitData('after');
        await flush(streamer);
        expect(liveAfterReattach).toEqual(['after']);
      } finally {
        streamer?.destroy();
        if (usingFakeTimers) vi.useRealTimers();
      }
    });

    it('bounds the attach-exit tmux session probe with a timeout', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let streamer: PaneStreamer | null = null;
      let usingFakeTimers = false;
      try {
        const ptys = [createFakePty(), createFakePty()];
        let factoryCalls = 0;
        const runner = mockRunner();
        runner.exec.mockImplementation(async (cmd: string, options?: ExecOptions) => {
          if (cmd.includes('has-session')) {
            expect(options?.timeout).toBe(1234);
            throw new Error('probe timeout');
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        });
        const tmux = new TmuxManager(runner);
        streamer = new PaneStreamer(TEST_AGENT, tmux, runner, () => undefined, {
          ptyFactory: () => ptys[factoryCalls++],
          idleGraceMs: 50,
          reattachDelayMs: 1000,
          sessionProbeTimeoutMs: 1234,
        });
        await streamer.subscribeAtomic(cbs);

        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        usingFakeTimers = true;
        ptys[0].emitExit(0);
        await new Promise<void>(r => setImmediate(r));

        expect(factoryCalls).toBe(1);
        expect(warnSpy).toHaveBeenCalledWith(
          '[pane-streamer] dev-1 attach failing; backing off retries: probe timeout',
        );
        await vi.advanceTimersByTimeAsync(1000);
        expect(factoryCalls).toBe(2);
      } finally {
        streamer?.destroy();
        warnSpy.mockRestore();
        if (usingFakeTimers) vi.useRealTimers();
      }
    });

    it('backs off between failed hidden attach retries even when caller requested immediate reattach', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      let streamer: PaneStreamer | null = null;
      let usingFakeTimers = false;
      try {
        const initialPty = createFakePty();
        const recoveredPty = createFakePty();
        let factoryCalls = 0;
        const runner = mockRunner();
        const tmux = new TmuxManager(runner);
        streamer = new PaneStreamer(TEST_AGENT, tmux, runner, () => undefined, {
          ptyFactory: () => {
            factoryCalls++;
            if (factoryCalls === 1) return initialPty;
            if (factoryCalls === 2) throw new Error('ssh unavailable');
            return recoveredPty;
          },
          idleGraceMs: 50,
          reattachDelayMs: 1000,
          random: () => 0,
        });
        await streamer.subscribeAtomic(cbs);

        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        usingFakeTimers = true;
        initialPty.emitExit(0);
        await new Promise<void>(r => setImmediate(r));
        await vi.advanceTimersByTimeAsync(999);
        expect(factoryCalls).toBe(1);

        await vi.advanceTimersByTimeAsync(1);
        expect(factoryCalls).toBe(2);
        expect(warnSpy).toHaveBeenCalledTimes(1);

        // backoff doubled: the second retry waits 2000ms, not another 1000ms
        await vi.advanceTimersByTimeAsync(1999);
        expect(factoryCalls).toBe(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(factoryCalls).toBe(3);
        vi.useRealTimers();
        usingFakeTimers = false;
        recoveredPty.emitData('after');
        await flush(streamer);
        expect(liveCalls.map(c => c.data)).toEqual(['after']);
      } finally {
        streamer?.destroy();
        warnSpy.mockRestore();
        logSpy.mockRestore();
        if (usingFakeTimers) vi.useRealTimers();
      }
    });

    it('fires onSessionGone for all subscribers when tmux session is gone', async () => {
      const { streamer, fakePty, runner } = makeStreamer();
      runner.exec.mockImplementation(async (cmd: string) =>
        cmd.includes('has-session')
          ? { stdout: '', stderr: "can't find session: dev-1", exitCode: 1 }
          : { stdout: '', stderr: '', exitCode: 0 },
      );
      let goneA = 0, goneB = 0;
      await streamer.subscribeAtomic({ onLive: () => undefined, onSessionGone: () => { goneA++; } });
      await streamer.subscribeAtomic({ onLive: () => undefined, onSessionGone: () => { goneB++; } });

      fakePty.emitExit(0);
      await new Promise<void>(r => setImmediate(r));
      expect(goneA).toBe(1);
      expect(goneB).toBe(1);
      expect(streamer.isDestroyed()).toBe(true);
    });

    it('subsequent subscribe attempts throw after tmux session is gone', async () => {
      const { streamer, fakePty, runner } = makeStreamer();
      runner.exec.mockImplementation(async (cmd: string) =>
        cmd.includes('has-session')
          ? { stdout: '', stderr: "can't find session: dev-1", exitCode: 1 }
          : { stdout: '', stderr: '', exitCode: 0 },
      );
      await streamer.subscribeAtomic(cbs);
      fakePty.emitExit(0);
      await new Promise<void>(r => setImmediate(r));
      expect(streamer.isDestroyed()).toBe(true);
      await expect(streamer.subscribeAtomic(cbs)).rejects.toThrow(/destroyed/);
    });

    it('kills a replacement PTY if tmux disappears during the session-gone probe window', async () => {
      const ptys = [createFakePty(), createFakePty()];
      let factoryCalls = 0;
      let resolveProbe!: (value: ExecResult) => void;
      let probeStarted!: () => void;
      const probeStartedPromise = new Promise<void>((resolve) => {
        probeStarted = resolve;
      });
      const runner = mockRunner();
      runner.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('has-session')) {
          probeStarted();
          return new Promise<ExecResult>((resolve) => {
            resolveProbe = resolve;
          });
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      const tmux = new TmuxManager(runner);
      const streamer = new PaneStreamer(TEST_AGENT, tmux, runner, () => undefined, {
        ptyFactory: () => ptys[factoryCalls++],
        idleGraceMs: 50,
        reattachDelayMs: 1000,
      });
      await streamer.subscribeAtomic(cbs);

      ptys[0].emitExit(0);
      await probeStartedPromise;
      await streamer.sendInput('x');
      expect(factoryCalls).toBe(2);
      expect(ptys[1].writes).toEqual(['x']);
      expect(ptys[1].killCalled).toBe(0);

      resolveProbe({ stdout: '', stderr: "can't find session: dev-1", exitCode: 1 });
      await new Promise<void>(r => setImmediate(r));

      expect(streamer.isDestroyed()).toBe(true);
      expect(ptys[1].killCalled).toBe(1);
      expect(_sessionGoneCalls).toBe(1);
    });
  });

  describe('reconnect backoff + log collapse', () => {
    it('grows the reattach delay exponentially while attaches keep failing', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let streamer: PaneStreamer | null = null;
      let usingFakeTimers = false;
      try {
        const initialPty = createFakePty();
        let factoryCalls = 0;
        const runner = mockRunner();
        const tmux = new TmuxManager(runner);
        streamer = new PaneStreamer(TEST_AGENT, tmux, runner, () => undefined, {
          ptyFactory: () => {
            factoryCalls++;
            if (factoryCalls === 1) return initialPty;
            throw new Error('ssh down');
          },
          idleGraceMs: 50,
          reattachDelayMs: 1000,
          reattachMaxDelayMs: 15_000,
          random: () => 0,
        });
        await streamer.subscribeAtomic(cbs);

        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        usingFakeTimers = true;
        initialPty.emitExit(0);
        await new Promise<void>(r => setImmediate(r));
        expect(factoryCalls).toBe(1);

        await vi.advanceTimersByTimeAsync(999);
        expect(factoryCalls).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(factoryCalls).toBe(2);

        await vi.advanceTimersByTimeAsync(1999);
        expect(factoryCalls).toBe(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(factoryCalls).toBe(3);

        await vi.advanceTimersByTimeAsync(3999);
        expect(factoryCalls).toBe(3);
        await vi.advanceTimersByTimeAsync(1);
        expect(factoryCalls).toBe(4);

        expect(warnSpy).toHaveBeenCalledTimes(1);
      } finally {
        streamer?.destroy();
        warnSpy.mockRestore();
        if (usingFakeTimers) vi.useRealTimers();
      }
    });

    // Regression: a failing reattach often emits bytes (SSH banner, "Connection closed"
    // stderr, login text) before the connection dies. Those bytes must NOT count as recovery
    // or the backoff resets to base every cycle and the storm returns.
    it('keeps backing off when a reattach emits output then exits without staying stable', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      let streamer: PaneStreamer | null = null;
      let usingFakeTimers = false;
      try {
        const ptys = [createFakePty(), createFakePty(), createFakePty()];
        let factoryCalls = 0;
        const runner = mockRunner();
        const tmux = new TmuxManager(runner);
        streamer = new PaneStreamer(TEST_AGENT, tmux, runner, () => undefined, {
          ptyFactory: () => ptys[factoryCalls++],
          idleGraceMs: 50,
          reattachDelayMs: 1000,
          reattachMaxDelayMs: 15_000,
          reattachStableAfterMs: 5000,
          random: () => 0,
        });
        await streamer.subscribeAtomic(cbs);

        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        usingFakeTimers = true;
        ptys[0].emitExit(0);
        await new Promise<void>(r => setImmediate(r));

        await vi.advanceTimersByTimeAsync(1000);
        expect(factoryCalls).toBe(2);

        // ptys[1] spews failure noise as PTY data, then dies inside the stability window
        ptys[1].emitData('Connection closed by 1.2.3.4 port 6003\r\n');
        ptys[1].emitExit(0);
        await new Promise<void>(r => setImmediate(r));

        // backoff must have grown to 2000ms — interim data must not reset it to 1000
        await vi.advanceTimersByTimeAsync(1999);
        expect(factoryCalls).toBe(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(factoryCalls).toBe(3);
      } finally {
        streamer?.destroy();
        warnSpy.mockRestore();
        logSpy.mockRestore();
        if (usingFakeTimers) vi.useRealTimers();
      }
    });

    it('resets backoff and logs recovery only after a reattach survives the stability window', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      let streamer: PaneStreamer | null = null;
      let usingFakeTimers = false;
      const recoveredLines = () =>
        logSpy.mock.calls.map(c => String(c[0])).filter(l => l.includes('attach recovered'));
      try {
        const ptys = [createFakePty(), createFakePty(), createFakePty(), createFakePty()];
        let factoryCalls = 0;
        const runner = mockRunner();
        const tmux = new TmuxManager(runner);
        streamer = new PaneStreamer(TEST_AGENT, tmux, runner, () => undefined, {
          ptyFactory: () => {
            const i = factoryCalls++;
            if (i === 1) throw new Error('ssh down');
            return ptys[i];
          },
          idleGraceMs: 50,
          reattachDelayMs: 1000,
          reattachStableAfterMs: 5000,
          random: () => 0,
        });
        await streamer.subscribeAtomic(cbs);

        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        usingFakeTimers = true;
        ptys[0].emitExit(0);
        await new Promise<void>(r => setImmediate(r));

        await vi.advanceTimersByTimeAsync(1000);   // attempt1 → factory throws → outage warn
        expect(warnSpy).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2000);   // attempt2 → ptys[2] attaches, stays alive
        expect(factoryCalls).toBe(3);

        await vi.advanceTimersByTimeAsync(4999);
        expect(recoveredLines()).toEqual([]);      // not recovered until the window elapses
        await vi.advanceTimersByTimeAsync(1);
        expect(recoveredLines()).toEqual(['[pane-streamer] dev-1 attach recovered']);

        // backoff was reset: a later drop reschedules from base (1000), not the grown delay
        ptys[2].emitExit(0);
        await new Promise<void>(r => setImmediate(r));
        await vi.advanceTimersByTimeAsync(999);
        expect(factoryCalls).toBe(3);
        await vi.advanceTimersByTimeAsync(1);
        expect(factoryCalls).toBe(4);
      } finally {
        streamer?.destroy();
        warnSpy.mockRestore();
        logSpy.mockRestore();
        if (usingFakeTimers) vi.useRealTimers();
      }
    });
  });

  describe('idle grace + lazy GC', () => {
    it('keeps PTY alive when subscribers come and go within graceMs', async () => {
      vi.useFakeTimers();
      try {
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
      } finally {
        vi.useRealTimers();
      }
    });

    it('destroys PTY after graceMs with no subscribers', async () => {
      vi.useFakeTimers();
      try {
        const { streamer, fakePty } = makeStreamer({ idleGraceMs: 100 });
        const sub = await streamer.subscribeAtomic(cbs);
        sub.unsubscribe();
        await vi.advanceTimersByTimeAsync(150);
        expect(streamer.isDestroyed()).toBe(true);
        expect(fakePty.killCalled).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('scrollback line bound (the serialized snapshot IS the buffer; no separate byte copy)', () => {
    it('caps the snapshot at the configured scrollbackLines instead of retaining every emitted line', async () => {
      const { streamer, fakePty } = makeStreamer({ scrollbackLines: 5 });
      await streamer.subscribeAtomic(cbs);
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
      const { streamer, fakePty, runner } = makeStreamer();
      await streamer.subscribeAtomic(cbs);
      const mouseSeq = '\x1b[<64;42;7M';
      await streamer.sendInput(mouseSeq);
      expect(fakePty.writes).toEqual([mouseSeq]);
      const calls = runner.exec.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(calls.some((c: string) => c.includes('paste-buffer'))).toBe(false);
      expect(calls.some((c: string) => c.includes('load-buffer'))).toBe(false);
      streamer.destroy();
    });

    it('empty input is a no-op (no pty.write)', async () => {
      const { streamer, fakePty } = makeStreamer();
      await streamer.subscribeAtomic(cbs);
      await streamer.sendInput('');
      expect(fakePty.writes).toEqual([]);
      streamer.destroy();
    });

    it('sendInput after destroy rejects (does not silently swallow)', async () => {
      const { streamer } = makeStreamer();
      await streamer.subscribeAtomic(cbs);
      streamer.destroy();
      await expect(streamer.sendInput('x')).rejects.toThrow(/destroyed/);
    });
  });

  describe('resize', () => {
    it('updates headless cols/rows + calls TmuxManager.resizeWindow', async () => {
      const { streamer, runner } = makeStreamer();
      await streamer.subscribeAtomic(cbs);
      await streamer.resize(160, 40);
      const calls = runner.exec.mock.calls.map((c: unknown[]) => c[0] as string);
      const resizeCmd = calls.find(c => c.includes('tmux resize-window'));
      expect(resizeCmd).toBeDefined();
      expect(resizeCmd).toContain('-x 160');
      expect(resizeCmd).toContain('-y 40');
      expect(resizeCmd).toContain("-t '=dev-1'");
      const snap = await streamer.getSnapshotAtomic();
      expect(snap.snapshot.cols).toBe(160);
      expect(snap.snapshot.rows).toBe(40);
      streamer.destroy();
    });

    it('restores window-size=latest after explicit web resize so the latest attached client controls size', async () => {
      const { streamer, runner } = makeStreamer();
      await streamer.subscribeAtomic(cbs);
      await streamer.resize(160, 40);
      const calls = runner.exec.mock.calls.map((c: unknown[]) => c[0] as string);
      const latestCall = calls.find(c =>
        c.includes('tmux set-option')
        && c.includes('window-size')
        && c.includes('latest')
      );
      expect(latestCall).toBeDefined();
      streamer.destroy();
    });

    it('also resizes the attach PTY so tmux client viewport tracks web terminal (mouse hit-testing depends on it)', async () => {
      const { streamer, fakePty } = makeStreamer();
      await streamer.subscribeAtomic(cbs);
      const beforeResizes = fakePty.resizeCalls.length;
      await streamer.resize(160, 40);
      expect(fakePty.resizeCalls.slice(beforeResizes)).toEqual([{ cols: 160, rows: 40 }]);
      streamer.destroy();
    });

    it('still resizes tmux when requested dimensions match headless so web can reclaim latest sizing', async () => {
      const { streamer, runner, fakePty } = makeStreamer();
      await streamer.subscribeAtomic(cbs);
      const beforeExecs = runner.exec.mock.calls.length;
      await streamer.resize(200, 50);
      expect(runner.exec.mock.calls.length).toBeGreaterThan(beforeExecs);
      const calls = runner.exec.mock.calls.map((c: unknown[]) => c[0] as string);
      const resizeCmd = calls.find(c => c.includes('tmux resize-window') && c.includes('-x 200') && c.includes('-y 50'));
      expect(resizeCmd).toBeDefined();
      expect(fakePty.resizeCalls).toEqual([{ cols: 200, rows: 50 }]);
      const snap = await streamer.getSnapshotAtomic();
      expect(snap.snapshot.cols).toBe(200);
      expect(snap.snapshot.rows).toBe(50);
      streamer.destroy();
    });

    it('still resizes PTY/headless when window-size=latest repair fails after tmux resize succeeds', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { streamer, runner, fakePty } = makeStreamer();
        await streamer.subscribeAtomic(cbs);
        runner.exec.mockImplementation(async (cmd: string) =>
          cmd.includes('set-option') && cmd.includes('window-size') && cmd.includes('latest')
            ? { stdout: '', stderr: 'bad option', exitCode: 1 }
            : { stdout: '', stderr: '', exitCode: 0 },
        );
        await streamer.resize(160, 40);
        expect(fakePty.resizeCalls).toEqual([{ cols: 160, rows: 40 }]);
        const snap = await streamer.getSnapshotAtomic();
        expect(snap.snapshot.cols).toBe(160);
        expect(snap.snapshot.rows).toBe(40);
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
      const { streamer, runner, fakePty } = makeStreamer();
      await streamer.subscribeAtomic(cbs);
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
      const { streamer, fakePty } = makeStreamer();
      await streamer.subscribeAtomic(cbs);
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
    const cbs = { onLive: () => undefined, onSessionGone: () => undefined };
    await streamer.subscribeAtomic(cbs);

    // The host was resolved at attach time (not captured in the constructor) and drives the command.
    expect(resolveCalls).toBeGreaterThanOrEqual(1);
    expect(captured[0].args).toContain('-p');
    expect(captured[0].args).toContain('2222');
    expect(captured[0].args).toContain('u@h');

    streamer.destroy();
  });
});
