import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentConfig } from '../../src/shared/index.js';
import { PaneStreamerManager } from '../../src/agent/pane-streamer-manager.js';
import type {
  MinimalPty,
  PtyFactory,
  SubscriberCallbacks,
} from '../../src/agent/pane-streamer.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';

type ExecMock = ReturnType<typeof vi.fn<(cmd: string) => Promise<ExecResult>>>;

function mockRunner(): CommandRunner & { exec: ExecMock } {
  return {
    exec: vi.fn<(cmd: string) => Promise<ExecResult>>().mockResolvedValue({
      stdout: '', stderr: '', exitCode: 0,
    }),
    writeFile: vi.fn<(p: string, c: Buffer | string) => Promise<void>>().mockResolvedValue(undefined),
    execWithStdin: vi.fn<(cmd: string, stdin: Buffer) => Promise<ExecResult>>().mockResolvedValue({
      stdout: '', stderr: '', exitCode: 0,
    }),
  };
}

function createFakePty(): MinimalPty & {
  emitData: (data: string) => void;
  emitExit: () => void;
  killed: boolean;
  writes: string[];
  writeImpl?: (data: string) => void;
} {
  let dataListener: ((data: string) => void) | null = null;
  let exitListener: ((e: { exitCode: number }) => void) | null = null;
  return {
    onData(cb) { dataListener = cb; return { dispose: () => { dataListener = null; } }; },
    onExit(cb) { exitListener = cb; return { dispose: () => { exitListener = null; } }; },
    resize() { /* noop */ },
    write(data: string) {
      const impl = (this as { writeImpl?: (d: string) => void }).writeImpl;
      if (impl) impl(data);
      (this as { writes: string[] }).writes.push(data);
    },
    kill() { (this as { killed: boolean }).killed = true; },
    emitData(data: string) { dataListener?.(data); },
    emitExit() { exitListener?.({ exitCode: 0 }); },
    killed: false,
    writes: [] as string[],
  };
}

const TEST_AGENT: AgentConfig = {
  id: 'dev-1',
  runtime: 'codex',
  role: 'dev',
  mode: 'local',
};

function makeManager(opts?: {
  inputBatchMs?: number;
}): {
  manager: PaneStreamerManager;
  runner: ReturnType<typeof mockRunner>;
  fakePty: ReturnType<typeof createFakePty>;
} {
  const fakePty = createFakePty();
  const ptyFactory: PtyFactory = () => fakePty;
  const runner = mockRunner();
  const manager = new PaneStreamerManager({
    runnerFactory: () => runner,
    streamerDefaults: {
      ptyFactory,
      idleGraceMs: 50,
    },
    inputBatchMs: opts?.inputBatchMs ?? 10,
  });
  return { manager, runner, fakePty };
}

describe('PaneStreamerManager', () => {
  let cbs: SubscriberCallbacks;
  beforeEach(() => {
    cbs = {
      onLive: () => undefined,
      onSessionGone: () => undefined,
    };
  });

  describe('ensure / has / destroy', () => {
    it('ensure returns the same PaneStreamer instance for the same agent', () => {
      const { manager } = makeManager();
      const s1 = manager.ensure(TEST_AGENT);
      const s2 = manager.ensure(TEST_AGENT);
      expect(s1).toBe(s2);
    });

    it('has returns true after ensure, false after destroy', async () => {
      const { manager } = makeManager();
      manager.ensure(TEST_AGENT);
      expect(manager.has(TEST_AGENT.id)).toBe(true);
      await manager.destroy(TEST_AGENT.id);
      expect(manager.has(TEST_AGENT.id)).toBe(false);
    });

    it('destroy is idempotent (no error on missing agent)', async () => {
      const { manager } = makeManager();
      await expect(manager.destroy('nonexistent')).resolves.toBeUndefined();
      await expect(manager.destroy('nonexistent')).resolves.toBeUndefined();
    });

    it('destroyAll tears down every live streamer + its PTY (shutdown path)', async () => {
      const { manager, fakePty } = makeManager();
      const agentB: AgentConfig = { ...TEST_AGENT, id: 'qa-1' };
      // Bring one streamer's PTY up so we can assert destroyAll kills it.
      await manager.ensure(TEST_AGENT).subscribeAtomic(cbs);
      manager.ensure(agentB);
      expect(manager.has(TEST_AGENT.id)).toBe(true);
      expect(manager.has('qa-1')).toBe(true);

      await manager.destroyAll();

      expect(manager.has(TEST_AGENT.id)).toBe(false);
      expect(manager.has('qa-1')).toBe(false);
      expect(fakePty.killed).toBe(true);
    });

    it('destroyAll is a no-op with zero live streamers', async () => {
      const { manager } = makeManager();
      await expect(manager.destroyAll()).resolves.toBeUndefined();
    });

    it('destroyAll does NOT fire sessionGone — a planned shutdown must not raise signal-session-gone', async () => {
      const { manager } = makeManager();
      const onSessionGone = vi.fn();
      await manager.ensure(TEST_AGENT).subscribeAtomic({ onLive: () => undefined, onSessionGone });
      await manager.destroyAll();
      expect(onSessionGone).not.toHaveBeenCalled();
    });

    it('single-agent destroy DOES fire sessionGone (real teardown notifies subscribers)', async () => {
      const { manager } = makeManager();
      const onSessionGone = vi.fn();
      await manager.ensure(TEST_AGENT).subscribeAtomic({ onLive: () => undefined, onSessionGone });
      await manager.destroy(TEST_AGENT.id);
      expect(onSessionGone).toHaveBeenCalledTimes(1);
    });

    it('after destroy, ensure recreates a fresh streamer', async () => {
      const { manager } = makeManager();
      const s1 = manager.ensure(TEST_AGENT);
      await manager.destroy(TEST_AGENT.id);
      const s2 = manager.ensure(TEST_AGENT);
      expect(s2).not.toBe(s1);
      expect(s1.isDestroyed()).toBe(true);
      expect(s2.isDestroyed()).toBe(false);
    });

    it('ensure replaces a streamer that auto-destroyed after tmux session disappeared', async () => {
      const { manager, fakePty, runner } = makeManager();
      runner.exec.mockImplementation(async (cmd: string) =>
        cmd.includes('has-session')
          ? { stdout: '', stderr: "can't find session: dev-1", exitCode: 1 }
          : { stdout: '', stderr: '', exitCode: 0 },
      );
      const s1 = manager.ensure(TEST_AGENT);
      await s1.subscribeAtomic(cbs);
      fakePty.emitExit();
      await new Promise<void>(r => setImmediate(r));
      expect(s1.isDestroyed()).toBe(true);
      const s2 = manager.ensure(TEST_AGENT);
      expect(s2).not.toBe(s1);
    });

    it('keeps the same streamer when hidden attach exits but tmux session still exists', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let manager: PaneStreamerManager | null = null;
      try {
        const ptys = [createFakePty(), createFakePty()];
        let ptyCalls = 0;
        const runner = mockRunner();
        manager = new PaneStreamerManager({
          runnerFactory: () => runner,
          streamerDefaults: {
            ptyFactory: () => ptys[ptyCalls++],
            idleGraceMs: 50,
            reattachDelayMs: 0,
          },
        });
        const s1 = manager.ensure(TEST_AGENT);
        await s1.subscribeAtomic(cbs);

        ptys[0].emitExit();
        await new Promise<void>(r => setImmediate(r));

        expect(s1.isDestroyed()).toBe(false);
        expect(ptyCalls).toBe(1);
        await vi.advanceTimersByTimeAsync(1000);
        expect(ptyCalls).toBe(2);
        expect(manager.ensure(TEST_AGENT)).toBe(s1);
      } finally {
        await manager?.destroy(TEST_AGENT.id);
        vi.useRealTimers();
      }
    });
  });

  describe('enqueueInput (server-global per-agent serialization + 10ms batching)', () => {
    it('batches multiple calls within the window into ONE pty.write', async () => {
      const { manager, fakePty } = makeManager({ inputBatchMs: 10 });
      const streamer = manager.ensure(TEST_AGENT);
      await streamer.subscribeAtomic(cbs);

      const p1 = manager.enqueueInput(TEST_AGENT.id, 'a');
      const p2 = manager.enqueueInput(TEST_AGENT.id, 'b');
      const p3 = manager.enqueueInput(TEST_AGENT.id, 'c');
      await Promise.all([p1, p2, p3]);

      expect(fakePty.writes).toEqual(['abc']);
    });

    it('returns the same flush promise for all callers in the same batch', async () => {
      const { manager } = makeManager();
      const s = manager.ensure(TEST_AGENT);
      await s.subscribeAtomic(cbs);

      const p1 = manager.enqueueInput(TEST_AGENT.id, 'x');
      const p2 = manager.enqueueInput(TEST_AGENT.id, 'y');
      expect(p1).toBe(p2);
      await p1;
    });

    it('separate batches (across windows) make separate pty.write calls', async () => {
      vi.useFakeTimers();
      try {
        const { manager, fakePty } = makeManager({ inputBatchMs: 10 });
        const s = manager.ensure(TEST_AGENT);
        await s.subscribeAtomic(cbs);

        const p1 = manager.enqueueInput(TEST_AGENT.id, 'first');
        await vi.advanceTimersByTimeAsync(15);
        await p1;
        expect(fakePty.writes).toEqual(['first']);

        const p2 = manager.enqueueInput(TEST_AGENT.id, 'second');
        await vi.advanceTimersByTimeAsync(15);
        await p2;
        expect(fakePty.writes).toEqual(['first', 'second']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('per-agent chain serializes batches even when one rejects (chain not poisoned)', async () => {
      const { manager, fakePty } = makeManager({ inputBatchMs: 10 });
      const s = manager.ensure(TEST_AGENT);
      await s.subscribeAtomic(cbs);

      let calls = 0;
      (fakePty as unknown as { writeImpl?: (d: string) => void }).writeImpl = () => {
        calls += 1;
        if (calls === 1) throw new Error('pty.write failed');
      };

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const p1 = manager.enqueueInput(TEST_AGENT.id, 'first');
        p1.catch(() => undefined);
        await new Promise(r => setTimeout(r, 20));
        await expect(p1).rejects.toThrow(/pty\.write failed/);

        const p2 = manager.enqueueInput(TEST_AGENT.id, 'second');
        await new Promise(r => setTimeout(r, 20));
        await expect(p2).resolves.toBeUndefined();

        expect(calls).toBe(2);
        expect(fakePty.writes).toEqual(['second']);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('empty data is no-op (no setTimeout, no pty.write)', async () => {
      const { manager, fakePty } = makeManager();
      const s = manager.ensure(TEST_AGENT);
      await s.subscribeAtomic(cbs);

      await manager.enqueueInput(TEST_AGENT.id, '');
      expect(fakePty.writes).toEqual([]);
    });

    it('destroy mid-batch settles pending flushPromise (rejects with pane_streamer_destroyed)', async () => {
      const { manager, fakePty } = makeManager({ inputBatchMs: 50 });
      const s = manager.ensure(TEST_AGENT);
      await s.subscribeAtomic(cbs);

      const p = manager.enqueueInput(TEST_AGENT.id, 'will be cancelled');
      p.catch(() => undefined);
      await manager.destroy(TEST_AGENT.id);

      await expect(p).rejects.toThrow(/pane_streamer_destroyed/);
      expect(fakePty.writes).toEqual([]);
    });
  });
});
