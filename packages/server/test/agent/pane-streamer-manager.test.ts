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
    // list-sessions answers a self-claimed snapshot so the PaneStreamer attach ownership gate passes.
    exec: vi.fn<(cmd: string) => Promise<ExecResult>>().mockImplementation(async (cmd: string) => {
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
    resize() { },
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

// Attach-capability probes (`tmux -V`) must answer and exit or every spawn waits
// out the settle deadline; a pre-3.2 answer keeps flag/follow paths off.
function probeAware(factory: PtyFactory, version = 'tmux 3.0a\n'): PtyFactory {
  return (cmd, cols, rows) => {
    if (cmd.args.some((a) => typeof a === 'string' && a.includes('tmux -V'))) {
      const probe = createFakePty();
      queueMicrotask(() => {
        probe.emitData(version);
        probe.emitExit();
      });
      return probe;
    }
    return factory(cmd, cols, rows);
  };
}

function makeManager(opts?: {
  inputBatchMs?: number;
}): {
  manager: PaneStreamerManager;
  runner: ReturnType<typeof mockRunner>;
  fakePty: ReturnType<typeof createFakePty>;
} {
  const fakePty = createFakePty();
  const ptyFactory: PtyFactory = probeAware(() => fakePty);
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
      // Owned at the initial attach + post-attach handshake (probes 1-2), gone on the reconnect probe (3).
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
            ptyFactory: probeAware(() => ptys[ptyCalls++]),
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

const OWNER_CBS: SubscriberCallbacks = { onLive: () => undefined, onSessionGone: () => undefined };

describe('owner reconciliation (manager-level, fenced writes)', () => {
  interface GeomState {
    w: number; h: number; status: string; mode: string; gen: string;
    pid: string; start: string; sid: string; claim: string; version: string; cap: string;
    absent?: boolean;
    transient?: boolean;
    failWrites?: boolean;
  }

  function ownerHarness(overrides: Partial<GeomState> = {}): {
    manager: PaneStreamerManager;
    state: GeomState;
    writes: () => string[];
    fencedWrites: () => string[];
    reads: () => number;
  } {
    const state: GeomState = {
      w: 100, h: 30, status: 'on', mode: 'latest', gen: '',
      pid: '11', start: '22', sid: '$3', claim: 'dev-1', version: '3.6a', cap: '1',
      ...overrides,
    };
    const allWrites: string[] = [];
    let reads = 0;
    const runner = mockRunner();
    runner.exec.mockImplementation(async (cmd: string) => {
      if (cmd.includes('list-sessions')) {
        if (state.absent) return { stdout: '', stderr: '', exitCode: 0 };
        return { stdout: `${state.pid}|${state.start}|${state.sid}|${state.claim}\n`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('display-message')) {
        reads++;
        if (state.transient) {
          return { stdout: '', stderr: 'ssh: connect to host x: Connection timed out', exitCode: 255 };
        }
        if (state.absent) {
          return { stdout: '', stderr: "can't find session: dev-1", exitCode: 1 };
        }
        return {
          stdout: `${state.w} ${state.h} ${state.status} ${state.mode} ${state.gen}|${state.pid}|${state.start}|${state.sid}|${state.claim}|${state.version}|${state.cap}\n`,
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('if-shell')) {
        allWrites.push(cmd);
        if (state.failWrites) {
          return { stdout: '', stderr: 'simulated write failure', exitCode: 1 };
        }
        const triple = /#\{==:#\{pid\},(\d+)\}.*?#\{==:#\{session_id\},(\$\d+)\}.*?#\{==:#\{@baxian-agent-id\},([A-Za-z0-9_-]+)\}/s.exec(cmd);
        const genClause = /e\|<=:#\{@bx_owner_gen\},(\d+)/.exec(cmd);
        const identityOk = !!triple
          && triple[1] === state.pid
          && triple[2] === state.sid
          && triple[3] === state.claim;
        const genOk = genClause === null || state.gen === '' || Number(state.gen) <= Number(genClause[1]);
        if (identityOk && genOk) {
          if (genClause) state.gen = genClause[1];
          const mode = /window-size (manual|latest)/.exec(cmd)?.[1];
          if (mode) state.mode = mode;
          const rz = /resize-window[^;]*-x (\d+) -y (\d+)/.exec(cmd);
          if (rz) { state.w = Number(rz[1]); state.h = Number(rz[2]); }
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('window-size') || cmd.includes('resize-window')) {
        allWrites.push(cmd);
        const mode = /window-size.*(manual|latest)/.exec(cmd)?.[1];
        if (mode) state.mode = mode;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const fakePty = createFakePty();
    const manager = new PaneStreamerManager({
      runnerFactory: () => runner,
      streamerDefaults: { ptyFactory: probeAware(() => fakePty), idleGraceMs: 5000 },
    });
    return {
      manager,
      state,
      writes: () => [...allWrites],
      fencedWrites: () => allWrites.filter((c) => c.includes('if-shell')),
      reads: () => reads,
    };
  }

  const settle = async (rounds = 6): Promise<void> => {
    for (let i = 0; i < rounds; i++) {
      await new Promise<void>((r) => setImmediate(r));
    }
  };

  it('full hold 0→1 pins manual + contentArea(basis, N); confirmation read clears dirty', async () => {
    const h = ownerHarness();
    const streamer = h.manager.ensure(TEST_AGENT);
    await streamer.subscribeAtomic(OWNER_CBS);
    const release = streamer.acquireFullHold();
    await settle();
    const manualWrite = h.fencedWrites().find((c) => c.includes('window-size manual'));
    expect(manualWrite).toBeDefined();
    // basis = streamer headless 200x50, status on → content area 200x49
    expect(manualWrite).toContain('-x 200 -y 49');
    expect(h.state.mode).toBe('manual');

    await h.manager._reconcileNowForTest(TEST_AGENT.id);
    await settle();
    expect(h.manager._ownerForTest(TEST_AGENT.id)?.dirty).toBe(false);
    release();
    await h.manager.destroyAll();
  });

  it('external latest flip during full hold (CLI interference) is fenced back to manual with zero web resizes', async () => {
    const h = ownerHarness();
    const streamer = h.manager.ensure(TEST_AGENT);
    await streamer.subscribeAtomic(OWNER_CBS);
    const release = streamer.acquireFullHold();
    await settle();
    await h.manager._reconcileNowForTest(TEST_AGENT.id);
    await settle();
    expect(h.manager._ownerForTest(TEST_AGENT.id)?.dirty).toBe(false);

    const writesBefore = h.fencedWrites().length;
    h.state.mode = 'latest';
    await h.manager._reconcileNowForTest(TEST_AGENT.id);
    await settle();
    expect(h.fencedWrites().length).toBeGreaterThan(writesBefore);
    expect(h.state.mode).toBe('manual');
    release();
    await h.manager.destroyAll();
  });

  it('release 1→0 writes latest through the fence and the closure is idempotent', async () => {
    const h = ownerHarness();
    const streamer = h.manager.ensure(TEST_AGENT);
    await streamer.subscribeAtomic(OWNER_CBS);
    const release = streamer.acquireFullHold();
    await settle();
    release();
    await settle();
    const latestWrite = h.fencedWrites().find((c) => c.includes('window-size latest'));
    expect(latestWrite).toBeDefined();
    expect(latestWrite).not.toContain('resize-window');
    expect(h.state.mode).toBe('latest');

    release();
    expect(h.manager._ownerForTest(TEST_AGENT.id)?.fullHolds).toBe(0);
    await h.manager.destroyAll();
  });

  it('resize target survives a failed write; the reconciler later converges on the exact size without a new web resize', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = ownerHarness();
      const streamer = h.manager.ensure(TEST_AGENT);
      await streamer.subscribeAtomic(OWNER_CBS);
      const release = streamer.acquireFullHold();
      await settle();
      await h.manager._reconcileNowForTest(TEST_AGENT.id);
      await settle();

      h.state.failWrites = true;
      await expect(streamer.resize(140, 44)).rejects.toThrow();
      expect(streamer.size).toEqual({ cols: 140, rows: 44 });
      expect(h.state.w).not.toBe(140);

      h.state.failWrites = false;
      await h.manager._reconcileNowForTest(TEST_AGENT.id);
      await settle();
      expect(h.state.mode).toBe('manual');
      expect(h.state.w).toBe(140);
      expect(h.state.h).toBe(43);
      release();
      await h.manager.destroyAll();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('latest-wins: burst resizes collapse and the final write carries the last target', async () => {
    const h = ownerHarness();
    const streamer = h.manager.ensure(TEST_AGENT);
    await streamer.subscribeAtomic(OWNER_CBS);
    const release = streamer.acquireFullHold();
    await settle();

    const p1 = streamer.resize(100, 30);
    const p2 = streamer.resize(120, 40);
    const p3 = streamer.resize(140, 44);
    await Promise.all([p1, p2, p3]);
    await settle();
    const rz = h.fencedWrites().filter((c) => c.includes('resize-window'));
    expect(rz.at(-1)).toContain('-x 140 -y 43');
    expect(h.state.w).toBe(140);
    expect(h.state.h).toBe(43);
    release();
    await h.manager.destroyAll();
  });

  it('stale write against a rebuilt session is a server-side no-op; the reconciler re-reads and re-owns the new identity', async () => {
    const h = ownerHarness();
    const streamer = h.manager.ensure(TEST_AGENT);
    await streamer.subscribeAtomic(OWNER_CBS);
    const release = streamer.acquireFullHold();
    await settle();
    expect(h.state.mode).toBe('manual');

    // Session rebuilt: same name, new identity, fresh defaults.
    h.state.sid = '$9';
    h.state.gen = '';
    h.state.mode = 'latest';
    h.state.w = 80;
    h.state.h = 24;

    await h.manager._reconcileNowForTest(TEST_AGENT.id);
    await settle();
    const lastWrite = h.fencedWrites().at(-1);
    expect(lastWrite).toContain('#{==:#{session_id},$9}');
    expect(h.state.mode).toBe('manual');
    release();
    await h.manager.destroyAll();
  });

  it('legacy server (literal probe echo + pre-3.2 version): claim+triple guarded write WITHOUT the gen compare', async () => {
    const h = ownerHarness({ cap: '#{e|<=:1,2}', version: '3.1c' });
    const streamer = h.manager.ensure(TEST_AGENT);
    await streamer.subscribeAtomic(OWNER_CBS);
    const release = streamer.acquireFullHold();
    await settle();
    const legacyWrite = h.writes().find((c) => c.includes('window-size manual'));
    expect(legacyWrite).toBeDefined();
    expect(legacyWrite).toContain('if-shell');
    expect(legacyWrite).toContain('#{==:#{@baxian-agent-id},dev-1}');
    expect(legacyWrite).not.toContain('e|<=');
    expect(h.state.mode).toBe('manual');
    release();
    await h.manager.destroyAll();
  });

  it('capability unknown (empty/garbage probe on a modern version): ZERO owner writes, dirty retained for retry', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = ownerHarness({ cap: '', version: '3.6a' });
      const streamer = h.manager.ensure(TEST_AGENT);
      await streamer.subscribeAtomic(OWNER_CBS);
      const release = streamer.acquireFullHold();
      await settle();
      expect(h.writes().length).toBe(0);
      expect(h.state.mode).toBe('latest');
      expect(h.manager._ownerForTest(TEST_AGENT.id)?.dirty).toBe(true);
      release();
      await h.manager.destroyAll();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('foreign same-name session (claim mismatch): reconciler withholds ALL owner writes', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = ownerHarness({ claim: 'other-agent' });
      h.manager.startupScan([TEST_AGENT]);
      await settle();
      expect(h.writes().length).toBe(0);
      const warned = warnSpy.mock.calls.some((c) => String(c[0]).includes('claimed by'));
      expect(warned).toBe(true);
      await h.manager.destroyAll();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('startupScan transient-first-success: the retry credential survives SSH flakes until a round completes', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = ownerHarness({ mode: 'manual', transient: true });
      h.manager.startupScan([TEST_AGENT]);
      await settle();
      expect(h.manager._ownerForTest(TEST_AGENT.id)?.scanPending).toBe(true);
      expect(h.manager._ownerForTest(TEST_AGENT.id)?.timerActive).toBe(true);
      expect(h.writes().length).toBe(0);

      h.state.transient = false;
      await h.manager._reconcileNowForTest(TEST_AGENT.id);
      await settle();
      expect(h.state.mode).toBe('latest');
      expect(h.manager._ownerForTest(TEST_AGENT.id)?.scanPending).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('dead session with no holds clears dirty (nothing to reconcile) and stops the timer', async () => {
    const h = ownerHarness();
    const streamer = h.manager.ensure(TEST_AGENT);
    await streamer.subscribeAtomic(OWNER_CBS);
    const release = streamer.acquireFullHold();
    await settle();
    h.state.absent = true;
    release();
    await settle();
    const owner = h.manager._ownerForTest(TEST_AGENT.id);
    expect(owner?.dirty).toBe(false);
    expect(owner?.timerActive).toBe(false);
    await h.manager.destroyAll();
  });

  it('startupScan heals a manual orphan left by a previous process life', async () => {
    const h = ownerHarness({ mode: 'manual' });
    h.manager.startupScan([TEST_AGENT]);
    await settle();
    expect(h.state.mode).toBe('latest');
    const write = h.fencedWrites().find((c) => c.includes('window-size latest'));
    expect(write).toBeDefined();
    await h.manager.destroyAll();
  });

  it('agent removal bumps the epoch: stale hold-release closures are inert and a recreated agent starts clean', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = ownerHarness();
      const streamer = h.manager.ensure(TEST_AGENT);
      await streamer.subscribeAtomic(OWNER_CBS);
      const release = streamer.acquireFullHold();
      await settle();
      expect(h.manager._ownerForTest(TEST_AGENT.id)?.fullHolds).toBe(1);
      const epochBefore = h.manager._ownerForTest(TEST_AGENT.id)?.epoch ?? 0;

      // Removing the agent while its owner state is still full-held/dirty is the
      // exact case the removal warning exists for — assert it, exactly once.
      await h.manager.destroy(TEST_AGENT.id);
      const dirtyWarns = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes('removed while owner state dirty'));
      expect(dirtyWarns.length).toBe(1);

      release();
      h.manager.ensure(TEST_AGENT);
      const owner = h.manager._ownerForTest(TEST_AGENT.id);
      expect(owner?.fullHolds).toBe(0);
      expect(owner?.epoch).toBe(epochBefore + 1);
      await h.manager.destroyAll();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('geometry liveness admission (global + per-agent caps)', () => {
  it('per-agent cap: a fifth concurrent never-settling read is refused without starting an exec', async () => {
    const runner = mockRunner();
    let started = 0;
    runner.exec.mockImplementation((cmd: string) => {
      if (cmd.includes('list-sessions')) {
        return Promise.resolve({ stdout: '11|22|$3|dev-1\n', stderr: '', exitCode: 0 });
      }
      if (cmd.includes('display-message')) {
        started++;
        return new Promise(() => undefined);
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });
    const fakePty = createFakePty();
    const manager = new PaneStreamerManager({
      runnerFactory: () => runner,
      streamerDefaults: { ptyFactory: probeAware(() => fakePty), idleGraceMs: 5000 },
    });
    const streamer = manager.ensure(TEST_AGENT);
    await streamer.subscribeAtomic(OWNER_CBS);

    const hung: Array<Promise<void>> = [];
    for (let i = 0; i < 4; i++) {
      const p = streamer.resize(100 + i, 30);
      p.catch(() => undefined);
      hung.push(p);
    }
    await new Promise<void>((r) => setImmediate(r));
    expect(started).toBe(4);
    expect(manager._geometryPendingForTest().byAgent.get(TEST_AGENT.id)).toBe(4);

    await expect(streamer.resize(200, 50)).rejects.toThrow(/capacity/);
    expect(started).toBe(4);
    await manager.destroyAll();
  });

  it('global cap: pending liveness across agents never exceeds the process-wide limit', async () => {
    const runner = mockRunner();
    runner.exec.mockImplementation((cmd: string) => {
      if (cmd.includes('list-sessions')) {
        const name = /#\{==:#\{session_name\},([^}]+)\}/.exec(cmd)?.[1] ?? 'dev-1';
        return Promise.resolve({ stdout: `11|22|$3|${name}\n`, stderr: '', exitCode: 0 });
      }
      if (cmd.includes('display-message')) return new Promise(() => undefined);
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });
    const manager = new PaneStreamerManager({
      runnerFactory: () => runner,
      streamerDefaults: { ptyFactory: probeAware(createFakePty), idleGraceMs: 5000 },
      maxPendingGeometryLiveness: 6,
      maxPendingGeometryPerAgent: 4,
    });
    const agents = ['a-1', 'a-2', 'a-3'].map((id) => ({ ...TEST_AGENT, id }));
    const streamers = agents.map((a) => manager.ensure(a));
    for (const s of streamers) await s.subscribeAtomic(OWNER_CBS);

    for (const s of streamers) {
      for (let i = 0; i < 3; i++) {
        s.resize(100 + i, 30).catch(() => undefined);
      }
    }
    await new Promise<void>((r) => setImmediate(r));
    expect(manager._geometryPendingForTest().global).toBeLessThanOrEqual(6);
    await manager.destroyAll();
  });
});

describe('probe admission ordering (lazy start, no untracked live bodies)', () => {
  function neverSettleRunner(): ReturnType<typeof mockRunner> {
    const runner = mockRunner();
    runner.exec.mockImplementation((cmd: string) => {
      if (cmd.includes('list-sessions')) {
        const name = /#\{==:#\{session_name\},([^}]+)\}/.exec(cmd)?.[1] ?? 'dev-1';
        return Promise.resolve({ stdout: `11|22|$3|${name}\n`, stderr: '', exitCode: 0 });
      }
      if (cmd.includes('display-message')) return new Promise(() => undefined);
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });
    return runner;
  }

  it('capacity full: the probe body is NEVER created (zero PTY spawns), attach degrades to flagless and still subscribes', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const runner = neverSettleRunner();
      let counting = false;
      let probeSpawns = 0;
      const attachPtys: Array<ReturnType<typeof createFakePty>> = [];
      const factory: PtyFactory = (cmd) => {
        if (cmd.args.some((a) => typeof a === 'string' && a.includes('tmux -V'))) {
          if (counting) probeSpawns++;
          const probe = createFakePty();
          queueMicrotask(() => { probe.emitData('tmux 3.0a\n'); probe.emitExit(); });
          return probe;
        }
        const pty = createFakePty();
        attachPtys.push(pty);
        return pty;
      };
      const manager = new PaneStreamerManager({
        runnerFactory: () => runner,
        streamerDefaults: { ptyFactory: factory, idleGraceMs: 5000, reattachDelayMs: 0 },
        maxPendingGeometryLiveness: 1,
        maxPendingGeometryPerAgent: 1,
      });

      // Occupy the single global slot with a never-settling geometry exec.
      const blockerAgent: AgentConfig = { ...TEST_AGENT, id: 'blocker' };
      const blocker = manager.ensure(blockerAgent);
      await blocker.subscribeAtomic(OWNER_CBS);
      const hung = blocker.resize(101, 31);
      hung.catch(() => undefined);
      await new Promise<void>((r) => setImmediate(r));
      expect(manager._geometryPendingForTest().global).toBe(1);
      counting = true;

      // Two attach lifecycles for another agent: probes must not be admitted, and
      // since admission is checked BEFORE creation, no probe PTY may ever exist.
      const streamer = manager.ensure(TEST_AGENT);
      await streamer.subscribeAtomic(OWNER_CBS);
      attachPtys.at(-1)?.emitExit();
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setTimeout(r, 1100));

      expect(probeSpawns).toBe(0);
      expect(attachPtys.length).toBeGreaterThanOrEqual(2);
      expect(manager._geometryPendingForTest().global).toBe(1);
      expect(manager._geometryPendingForTest().byAgent.get(TEST_AGENT.id) ?? 0).toBe(0);
      await manager.destroyAll();
    } finally {
      warnSpy.mockRestore();
    }
  }, 15000);

  it('created probes are registered before racing; a kill failure at deadline is warned with the agent as target and the slot stays occupied', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const runner = mockRunner();
      const manager = new PaneStreamerManager({
        runnerFactory: () => runner,
        streamerDefaults: { ptyFactory: createFakePty, idleGraceMs: 5000 },
        geometryTimeoutMs: 100,
      });
      const owner = manager.ensure(TEST_AGENT);
      void owner;
      // Reach into the streamer hooks via a raw probe: never settles, kill throws.
      const hooks = (manager as unknown as {
        geometryHooksFor: (o: unknown) => { raceProbe: <T>(s: () => { result: Promise<T>; settled: Promise<unknown>; onDeadline: () => void }) => Promise<T> };
        owners: Map<string, unknown>;
      });
      const ownerState = hooks.owners.get(TEST_AGENT.id);
      const probeApi = hooks.geometryHooksFor(ownerState);

      const raced = probeApi.raceProbe(() => ({
        result: new Promise<string>(() => undefined),
        settled: new Promise<void>(() => undefined),
        onDeadline: () => { throw new Error('EPERM: kill denied'); },
      }));
      const expectation = expect(raced).rejects.toThrow(/deadline/);
      await vi.advanceTimersByTimeAsync(3200);
      await expectation;

      const killWarns = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes('capability probe kill failed') && String(c[0]).includes(TEST_AGENT.id));
      expect(killWarns.length).toBe(1);
      // The un-killable probe never exits: its slot stays occupied (honest backpressure).
      expect(manager._geometryPendingForTest().byAgent.get(TEST_AGENT.id)).toBe(1);
      await manager.destroyAll();
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('single-agent removal while dirty still warns (spy-asserted); planned destroyAll shutdown stays silent', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const runner = neverSettleRunner();
      const manager = new PaneStreamerManager({
        runnerFactory: () => runner,
        streamerDefaults: { ptyFactory: probeAware(createFakePty), idleGraceMs: 5000 },
      });
      const streamer = manager.ensure(TEST_AGENT);
      await streamer.subscribeAtomic(OWNER_CBS);
      streamer.acquireFullHold();
      await new Promise<void>((r) => setImmediate(r));

      await manager.destroy(TEST_AGENT.id);
      const dirtyWarns = () => warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes('removed while owner state dirty'));
      expect(dirtyWarns().length).toBe(1);

      const again = manager.ensure(TEST_AGENT);
      await again.subscribeAtomic(OWNER_CBS);
      again.acquireFullHold();
      await new Promise<void>((r) => setImmediate(r));
      await manager.destroyAll();
      expect(dirtyWarns().length).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
