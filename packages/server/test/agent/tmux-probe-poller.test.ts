import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi } from 'vitest';
import type { AgentConfig, BaxianConfig } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';
import { TmuxProbePoller, TmuxSessionStatusStore } from '../../src/agent/tmux-probe-poller.js';
import { ErrorRecordStore } from '../../src/state/error-record-store.js';

const noopAgentManager = {
  getAgentState: async () => null,
  reconcileFailedAgent: async () => false,
} as unknown as import('../../src/agent/manager.js').AgentManager;

function makeAgent(id: string): AgentConfig {
  return {
    id,
    runtime: 'claude-code',
    role: 'dev',
    mode: 'local',
    workdir: '/tmp/repo',
  };
}

function makeConfig(agents: AgentConfig[]): BaxianConfig {
  return {
    review: { rounds: 10 },
    server: DEFAULT_SERVER_CONFIG,
    project: [{
      id: 'proj',
      repo: 'user/repo',
      merge: null,
      agent: agents.map(agent => [agent]),
    }],
  };
}

const present: ExecResult = { stdout: '', stderr: '', exitCode: 0 };
const absent: ExecResult = { stdout: '', stderr: "can't find session: dev-1", exitCode: 1 };
const unreachable: ExecResult = { stdout: '', stderr: 'ssh timeout', exitCode: 255 };
const oneClaudePane: ExecResult = { stdout: '%1 claude\n', stderr: '', exitCode: 0 };
const liveRuntimePane: ExecResult = { stdout: 'claude\n___bx-classify-sep___\n> ', stderr: '', exitCode: 0 };
const readyCapture: ExecResult = { stdout: '> ', stderr: '', exitCode: 0 };
const emptyPaneTitle: ExecResult = { stdout: '', stderr: '', exitCode: 0 };

function text(stdout: string): ExecResult {
  return { stdout, stderr: '', exitCode: 0 };
}

const codexPane: ExecResult = text('%1 node\n');
const codexRuntimePane: ExecResult = text('node\n___bx-classify-sep___\n› ');

type Branch = ExecResult | ((cmd: string) => ExecResult | Promise<ExecResult>);

interface ExecOverrides {
  hasSession?: Branch;
  listPanes?: Branch;
  classifySep?: Branch;
  capturePane?: Branch;
  paneTitle?: Branch;
}

function resolveBranch(branch: Branch, cmd: string): ExecResult | Promise<ExecResult> {
  return typeof branch === 'function' ? branch(cmd) : branch;
}

function makeExec(overrides: ExecOverrides = {}): CommandRunner['exec'] {
  const branches = {
    hasSession: overrides.hasSession ?? present,
    listPanes: overrides.listPanes ?? oneClaudePane,
    classifySep: overrides.classifySep ?? liveRuntimePane,
    capturePane: overrides.capturePane ?? readyCapture,
    paneTitle: overrides.paneTitle ?? emptyPaneTitle,
  };
  return vi.fn(async (cmd: string) => {
    if (cmd.includes('has-session')) return resolveBranch(branches.hasSession, cmd);
    if (cmd.includes('list-panes')) return resolveBranch(branches.listPanes, cmd);
    if (cmd.includes('___bx-classify-sep___')) return resolveBranch(branches.classifySep, cmd);
    if (cmd.includes('capture-pane')) return resolveBranch(branches.capturePane, cmd);
    if (cmd.includes('pane_title')) return resolveBranch(branches.paneTitle, cmd);
    return present;
  });
}

function execForSession(result: ExecResult): CommandRunner['exec'] {
  return makeExec({ hasSession: result, capturePane: readyCapture });
}

function scripted(results: ExecResult[]): (cmd: string) => ExecResult {
  let i = 0;
  return () => results[Math.min(i++, results.length - 1)];
}

function execScripted(captures: ExecResult[]): CommandRunner['exec'] {
  return makeExec({ capturePane: scripted(captures) });
}

function fakeAgentStore(
  bindings: Record<string, { taskId?: string } | null>,
): import('../../src/state/agent-store.js').AgentStore {
  return {
    get: async (id: string) => bindings[id] ?? null,
  } as unknown as import('../../src/state/agent-store.js').AgentStore;
}

interface MakePollerOptions {
  agents?: AgentConfig[];
  config?: BaxianConfig;
  store?: TmuxSessionStatusStore;
  exec?: CommandRunner['exec'];
  runnerFactory?: (agent: AgentConfig) => CommandRunner;
  errorRecordStore?: ErrorRecordStore;
  agentStore?: import('../../src/state/agent-store.js').AgentStore;
  now?: () => number;
  failureThreshold?: number;
  probeTimeoutMs?: number;
  concurrency?: number;
  intervalMs?: number;
}

function makePoller(opts: MakePollerOptions = {}): TmuxProbePoller {
  const { agents, config, exec, runnerFactory, ...rest } = opts;
  const resolvedExec = exec ?? makeExec();
  return new TmuxProbePoller({
    config: config ?? makeConfig(agents ?? [makeAgent('dev-1')]),
    store: opts.store ?? new TmuxSessionStatusStore(),
    agentManager: noopAgentManager,
    runnerFactory: runnerFactory ?? (() => ({ exec: resolvedExec })),
    ...rest,
  });
}

async function makeErrorRecordStore(): Promise<ErrorRecordStore> {
  const dir = await mkdtemp(join(tmpdir(), 'baxian-errors-'));
  await mkdir(join(dir, 'errors'), { recursive: true });
  return new ErrorRecordStore(join(dir, 'errors'));
}

const FIVE_MIN = 5 * 60 * 1000;
const SIX_MIN = 6 * 60 * 1000;

type ProbeStep = {
  set?: () => void;
  advance?: number;
  then?: (store: TmuxSessionStatusStore) => void;
};

async function runProbeScenario(opts: {
  store?: TmuxSessionStatusStore;
  agentId?: string;
  binding?: { taskId?: string } | null;
  agentStore?: import('../../src/state/agent-store.js').AgentStore;
  exec: CommandRunner['exec'];
  startMs?: number;
  failureThreshold?: number;
  errorRecordStore?: ErrorRecordStore;
  agents?: AgentConfig[];
  config?: BaxianConfig;
  steps: ProbeStep[];
  expectMatch?: Record<string, unknown>;
  expectClear?: boolean;
  expect?: (store: TmuxSessionStatusStore) => void;
}): Promise<TmuxSessionStatusStore> {
  const store = opts.store ?? new TmuxSessionStatusStore();
  const agentId = opts.agentId ?? 'dev-1';
  let nowMs = opts.startMs ?? 1_000_000;
  const agentStore = opts.agentStore
    ?? (opts.binding !== undefined ? fakeAgentStore({ [agentId]: opts.binding }) : undefined);
  const poller = makePoller({
    store,
    ...(agentStore ? { agentStore } : {}),
    ...(opts.agents ? { agents: opts.agents } : {}),
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.failureThreshold !== undefined ? { failureThreshold: opts.failureThreshold } : {}),
    ...(opts.errorRecordStore ? { errorRecordStore: opts.errorRecordStore } : {}),
    exec: opts.exec,
    now: () => nowMs,
  });

  for (const step of opts.steps) {
    step.set?.();
    nowMs += step.advance ?? 0;
    await poller.pollOnce();
    step.then?.(store);
  }
  if (opts.expectMatch) expect(store.get(agentId)).toMatchObject(opts.expectMatch);
  if (opts.expectClear) {
    expect(store.get(agentId).runtimeStatusHint).toBeUndefined();
    expect(store.get(agentId).reason).toBeUndefined();
  }
  opts.expect?.(store);
  return store;
}

describe('TmuxProbePoller', () => {
  it('updates tmux session status for configured agents', async () => {
    const store = new TmuxSessionStatusStore();
    const results = new Map<string, ExecResult>([
      ['dev-1', present],
      ['qa-1', absent],
    ]);
    const poller = makePoller({
      config: makeConfig([makeAgent('dev-1'), makeAgent('qa-1')]),
      store,
      runnerFactory: agent => ({ exec: execForSession(results.get(agent.id)!) }),
    });

    await poller.pollOnce();

    expect(store.get('dev-1').tmuxSessionStatus).toBe('present');
    expect(store.get('dev-1').observedAt).toBeTruthy();
    expect(store.get('qa-1').tmuxSessionStatus).toBe('absent');
  });

  it('marks unreachable after consecutive failed probes and records latest error', async () => {
    const errorRecordStore = await makeErrorRecordStore();
    await runProbeScenario({
      errorRecordStore,
      exec: makeExec({ hasSession: scripted([unreachable, unreachable, present]) }),
      failureThreshold: 2,
      steps: [
        { then: (s) => expect(s.get('dev-1').tmuxSessionStatus).toBe('unknown') },
        {
          then: (s) => {
            expect(s.get('dev-1').tmuxSessionStatus).toBe('unreachable');
            expect(s.get('dev-1').error).toContain('ssh timeout');
            expect(s.get('dev-1').latestError?.reason).toBe('TMUX_UNREACHABLE');
          },
        },
        {
          then: (s) => {
            expect(s.get('dev-1').tmuxSessionStatus).toBe('present');
            expect(s.get('dev-1').error).toBeUndefined();
          },
        },
      ],
    });
    expect(await errorRecordStore.latestForAgent('dev-1')).toMatchObject({
      agentId: 'dev-1',
      reason: 'TMUX_UNREACHABLE',
    });
  });

  it('classifies interactive runtime menus as pending observations with error-record context', async () => {
    const errorRecordStore = await makeErrorRecordStore();
    await runProbeScenario({
      errorRecordStore,
      exec: makeExec({ capturePane: text('Enter to select · ↑/↓ to navigate · Esc to cancel') }),
      steps: [{}],
      expectMatch: {
        tmuxSessionStatus: 'present',
        runtimeStatusHint: 'pending',
        reason: 'PENDING_HUMAN',
      },
    });
    expect(await errorRecordStore.latestForAgent('dev-1')).toMatchObject({
      reason: 'PENDING_HUMAN',
    });
  });

  it('marks busy live runtimes as working observations', async () => {
    await runProbeScenario({
      exec: makeExec({ capturePane: text('Hatching...\nEsc to interrupt') }),
      steps: [{}],
      expectMatch: {
        tmuxSessionStatus: 'present',
        paneState: 'live-runtime',
        runtimeStatusHint: 'working',
      },
    });
  });

  it('marks a codex small-pane Working line as a working observation', async () => {
    const codexAgent: AgentConfig = { ...makeAgent('qa-1'), runtime: 'codex', role: 'qa' };
    await runProbeScenario({
      agents: [codexAgent],
      agentId: 'qa-1',
      exec: makeExec({
        listPanes: codexPane,
        classifySep: codexRuntimePane,
        capturePane: text('• Working (2m 30s • esc to interrup…'),
      }),
      steps: [{}],
      expectMatch: {
        tmuxSessionStatus: 'present',
        paneState: 'live-runtime',
        runtimeStatusHint: 'working',
      },
    });
  });

  it('classifies unsupported foreground processes as unsafe runtime observations', async () => {
    await runProbeScenario({
      exec: makeExec({ classifySep: text('vim\n___bx-classify-sep___\nediting') }),
      steps: [{}],
      expectMatch: {
        tmuxSessionStatus: 'present',
        runtimeStatusHint: 'error',
        reason: 'UNSUPPORTED_FOREGROUND_PROCESS',
      },
    });
  });

  describe('PENDING_IDLE (screen-static-for-5min) detection', () => {
    const idleCapture: ExecResult = text('❯ ');
    const idleCaptureDifferent: ExecResult = text('❯ hello');

    it('first probe establishes baseline and does not flag pending', async () => {
      await runProbeScenario({
        binding: { taskId: 'task-001' },
        exec: execScripted([idleCapture]),
        steps: [{}],
        expectClear: true,
      });
    });

    it('flags PENDING_IDLE after screen is unchanged for > 5 minutes with active taskId', async () => {
      await runProbeScenario({
        binding: { taskId: 'task-001' },
        exec: execScripted([idleCapture, idleCapture]),
        steps: [{}, { advance: FIVE_MIN + 1 }],
        expectMatch: { runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' },
      });
    });

    it('screen change resets the idle timer', async () => {
      await runProbeScenario({
        binding: { taskId: 'task-001' },
        exec: execScripted([idleCapture, idleCaptureDifferent, idleCaptureDifferent]),
        steps: [{}, { advance: 4 * 60 * 1000 }, { advance: 4 * 60 * 1000 }],
        expectClear: true,
      });
    });

    it('does not flag pending when binding has no active taskId', async () => {
      await runProbeScenario({
        binding: null,
        exec: execScripted([idleCapture, idleCapture]),
        steps: [{}, { advance: SIX_MIN }],
        expect: (store) => expect(store.get('dev-1').runtimeStatusHint).toBeUndefined(),
      });
    });

    it('clears baseline when paneState leaves live-runtime, so re-entry gets a fresh 5-min grace period', async () => {
      const shellPane: ExecResult = text('zsh\n___bx-classify-sep___\n$ ');
      let scenario: 'live' | 'shell' = 'live';
      await runProbeScenario({
        binding: { taskId: 'task-001' },
        exec: makeExec({
          classifySep: () => (scenario === 'live' ? liveRuntimePane : shellPane),
          capturePane: idleCapture,
        }),
        steps: [
          {},
          { set: () => { scenario = 'shell'; }, advance: 10 * 60 * 1000 },
          { set: () => { scenario = 'live'; }, advance: 1000 },
        ],
        expectClear: true,
      });
    });

    it('clears baseline across present → unreachable → present recovery, preventing stale-hash misfire', async () => {
      let sessionResult: ExecResult = present;
      await runProbeScenario({
        binding: { taskId: 'task-001' },
        exec: makeExec({ hasSession: () => sessionResult, capturePane: idleCapture }),
        failureThreshold: 1,
        steps: [
          { then: (s) => expect(s.get('dev-1').tmuxSessionStatus).toBe('present') },
          {
            set: () => { sessionResult = unreachable; },
            advance: 10 * 60 * 1000,
            then: (s) => expect(s.get('dev-1').tmuxSessionStatus).toBe('unreachable'),
          },
          { set: () => { sessionResult = present; }, advance: 1000 },
        ],
        expectClear: true,
      });
    });

    it('clears baseline when a present-session probe fails (PANE_PROBE_FAILED), so recovery rebuilds it', async () => {
      let listPanesResult: ExecResult = oneClaudePane;
      await runProbeScenario({
        binding: { taskId: 'task-001' },
        exec: makeExec({ listPanes: () => listPanesResult, capturePane: idleCapture }),
        steps: [
          {},
          {
            set: () => { listPanesResult = text('%1 claude\n%2 zsh\n'); },
            advance: SIX_MIN,
            then: (s) => expect(s.get('dev-1').reason).toBe('PANE_PROBE_FAILED'),
          },
          { set: () => { listPanesResult = oneClaudePane; }, advance: 1000 },
        ],
        expectClear: true,
      });
    });

    it('resets debouncer on unreachable so recovery does not inherit stale working state', async () => {
      let sessionResult: ExecResult = present;
      let captureResult: ExecResult = text('· Wrangling… (5s · esc to interrupt)');
      await runProbeScenario({
        binding: { taskId: 'task-001' },
        exec: makeExec({ hasSession: () => sessionResult, capturePane: () => captureResult }),
        failureThreshold: 1,
        steps: [
          { then: (s) => expect(s.get('dev-1').runtimeStatusHint).toBe('working') },
          {
            set: () => { sessionResult = unreachable; },
            advance: 1000,
            then: (s) => expect(s.get('dev-1').tmuxSessionStatus).toBe('unreachable'),
          },
          { set: () => { sessionResult = present; captureResult = idleCapture; }, advance: 1000 },
        ],
        expect: (store) => expect(store.get('dev-1').runtimeStatusHint).toBeUndefined(),
      });
    });

    it('transient unreachable below failure threshold does not reset the idle timer', async () => {
      let sessionResult: ExecResult = present;
      await runProbeScenario({
        binding: { taskId: 'task-001' },
        exec: makeExec({ hasSession: () => sessionResult, capturePane: idleCapture }),
        failureThreshold: 2,
        steps: [
          { then: (s) => expect(s.get('dev-1').tmuxSessionStatus).toBe('present') },
          {
            set: () => { sessionResult = unreachable; },
            advance: 1000,
            then: (s) => expect(s.get('dev-1').tmuxSessionStatus).toBe('present'),
          },
          { set: () => { sessionResult = present; }, advance: SIX_MIN },
        ],
        expectMatch: { runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' },
      });
    });

    it('flags STUCK_BUSY when a live spinner stays frozen for the grace window', async () => {
      await runProbeScenario({
        binding: { taskId: 'task-001' },
        exec: makeExec({ capturePane: text('· Wrangling… (42s · esc to interrupt)') }),
        steps: [
          { then: (s) => expect(s.get('dev-1').runtimeStatusHint).toBe('working') },
          { advance: SIX_MIN },
        ],
        expectMatch: { runtimeStatusHint: 'error', reason: 'STUCK_BUSY' },
      });
    });

    it('does NOT flag STUCK_BUSY for static esc-to-interrupt without visibleWorking', async () => {
      await runProbeScenario({
        binding: { taskId: 'task-001' },
        exec: makeExec({ capturePane: text('Working on it…\n  esc to interrupt') }),
        steps: [{}, { advance: SIX_MIN }],
        expect: (store) => {
          expect(store.get('dev-1').runtimeStatusHint).toBe('working');
          expect(store.get('dev-1').reason).toBeUndefined();
        },
      });
    });

    it('flags STUCK_BUSY when working is determined only by frozen OSC braille title', async () => {
      await runProbeScenario({
        binding: { taskId: 'task-001' },
        exec: makeExec({ capturePane: text('some output\n'), paneTitle: text('⠁ Reading file') }),
        steps: [
          { then: (s) => expect(s.get('dev-1').runtimeStatusHint).toBe('working') },
          { advance: SIX_MIN },
        ],
        expectMatch: { runtimeStatusHint: 'error', reason: 'STUCK_BUSY' },
      });
    });

    it('a quoted/leftover spinner above an idle prompt is classified as PENDING_IDLE', async () => {
      const quotedSpinnerIdle: ExecResult = text(['· Wrangling… (24s)', ...Array(12).fill(''), '❯ '].join('\n'));
      await runProbeScenario({
        binding: { taskId: 'task-001' },
        exec: makeExec({ capturePane: quotedSpinnerIdle }),
        steps: [{}, { advance: SIX_MIN }],
        expectMatch: { runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' },
      });
    });

    it('a busy runtime whose screen keeps changing stays working (live spinner ticks, never stuck)', async () => {
      let secs = 10;
      await runProbeScenario({
        binding: { taskId: 'task-001' },
        exec: makeExec({ capturePane: () => text(`· Working… (${secs} s · esc to interrupt)`) }),
        steps: [
          {},
          ...Array.from({ length: 6 }, () => ({ set: () => { secs += 90; }, advance: 90 * 1000 })),
        ],
        expect: (store) => {
          expect(store.get('dev-1').runtimeStatusHint).toBe('working');
          expect(store.get('dev-1').reason).toBeUndefined();
        },
      });
    });

    it('stale esc-to-interrupt above a ready prompt is NOT busy → static screen → PENDING_IDLE, not STUCK_BUSY', async () => {
      const staleAnchor: ExecResult = text('esc to interrupt\n\n\n\n\n\n\n\n\n❯ ');
      await runProbeScenario({
        binding: { taskId: 'task-001' },
        exec: makeExec({ capturePane: staleAnchor }),
        steps: [{}, { advance: SIX_MIN }],
        expectMatch: { runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' },
      });
    });

    it('stale codex Working text above an idle prompt is NOT busy → static screen → PENDING_IDLE', async () => {
      const codexAgent: AgentConfig = { ...makeAgent('qa-1'), runtime: 'codex', role: 'qa' };
      const staleWorkingIdle: ExecResult = text('• Working (2m 30s • esc to interrup…\n\n› ');
      await runProbeScenario({
        agents: [codexAgent],
        agentId: 'qa-1',
        binding: { taskId: 'task-001' },
        exec: makeExec({ listPanes: codexPane, classifySep: codexRuntimePane, capturePane: staleWorkingIdle }),
        steps: [{}, { advance: SIX_MIN }],
        expectMatch: { runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' },
      });
    });

    it('resets baseline when taskId changes (null → some, or some → other), starting a fresh 5-min grace', async () => {
      let currentBinding: { taskId: string | null } | null = null;
      const dynamicAgentStore = {
        get: async (_id: string) => currentBinding,
      } as unknown as import('../../src/state/agent-store.js').AgentStore;
      await runProbeScenario({
        agentStore: dynamicAgentStore,
        exec: execScripted([idleCapture]),
        steps: [
          {},
          {
            advance: 10 * 60 * 1000,
            then: (s) => expect(s.get('dev-1').runtimeStatusHint).toBeUndefined(),
          },
          {
            set: () => { currentBinding = { taskId: 'task-001' }; },
            advance: 1000,
            then: (s) => {
              expect(s.get('dev-1').runtimeStatusHint).toBeUndefined();
              expect(s.get('dev-1').reason).toBeUndefined();
            },
          },
          {
            advance: SIX_MIN,
            then: (s) => expect(s.get('dev-1')).toMatchObject({
              runtimeStatusHint: 'pending',
              reason: 'PENDING_IDLE',
            }),
          },
          { set: () => { currentBinding = { taskId: 'task-002' }; }, advance: 1000 },
        ],
        expect: (store) => expect(store.get('dev-1').runtimeStatusHint).toBeUndefined(),
      });
    });

    it('prefers PENDING_HUMAN (menu) over PENDING_IDLE when both could apply', async () => {
      const menuCapture: ExecResult = text('Pick one\nEnter to select · Esc to cancel');
      await runProbeScenario({
        binding: { taskId: 'task-001' },
        exec: execScripted([menuCapture, menuCapture]),
        steps: [{}, { advance: 10 * 60 * 1000 }],
        expectMatch: { runtimeStatusHint: 'pending', reason: 'PENDING_HUMAN' },
      });
    });
  });

  const transcriptCapture: ExecResult = text('Showing detailed transcript\nctrl+o to toggle\n↑↓ scroll\n? for shortcuts');

  it('skipStateUpdate rule preserves previous observation (e.g. transcript viewer)', async () => {
    let currentCapture = text('Hatching...\nEsc to interrupt');
    await runProbeScenario({
      exec: makeExec({ capturePane: () => currentCapture }),
      steps: [
        { then: (s) => expect(s.get('dev-1').runtimeStatusHint).toBe('working') },
        { set: () => { currentCapture = transcriptCapture; } },
      ],
      expect: (store) => expect(store.get('dev-1').runtimeStatusHint).toBe('working'),
    });
  });

  it('skipStateUpdate preserves latestError from previous observation', async () => {
    const errorRecordStore = await makeErrorRecordStore();
    let currentCapture: ExecResult = text('Enter to select · ↑/↓ to navigate · Esc to cancel');
    await runProbeScenario({
      errorRecordStore,
      exec: makeExec({ capturePane: () => currentCapture }),
      steps: [
        {
          then: (s) => {
            expect(s.get('dev-1').latestError).toBeDefined();
            expect(s.get('dev-1').latestError?.reason).toBe('PENDING_HUMAN');
          },
        },
        { set: () => { currentCapture = transcriptCapture; } },
      ],
      expect: (store) => {
        expect(store.get('dev-1').latestError).toBeDefined();
        expect(store.get('dev-1').latestError?.reason).toBe('PENDING_HUMAN');
      },
    });
  });

  it('skipStateUpdate on first observation still commits presence to store', async () => {
    const store = new TmuxSessionStatusStore();
    expect(store.get('dev-1').tmuxSessionStatus).toBe('unknown');
    await runProbeScenario({
      store,
      exec: makeExec({ capturePane: transcriptCapture }),
      steps: [{}],
      expect: (s) => {
        expect(s.get('dev-1').tmuxSessionStatus).toBe('present');
        expect(s.get('dev-1').lastPresentAt).toBeTruthy();
      },
    });
  });

  it('reuses one runner for session presence and present-session observation', async () => {
    const exec = makeExec();
    const runnerFactory = vi.fn(() => ({ exec }));
    const poller = makePoller({ runnerFactory });

    await poller.pollOnce();

    expect(runnerFactory).toHaveBeenCalledTimes(1);
    expect((exec as ReturnType<typeof vi.fn>).mock.calls.some(([cmd]) => cmd.includes('has-session'))).toBe(true);
    expect((exec as ReturnType<typeof vi.fn>).mock.calls.some(([cmd]) => cmd.includes('list-panes'))).toBe(true);
    expect((exec as ReturnType<typeof vi.fn>).mock.calls.some(([cmd]) => cmd.includes('___bx-classify-sep___'))).toBe(true);
  });

  it('turns runner construction failures into unreachable observations without aborting the poll', async () => {
    const store = new TmuxSessionStatusStore();
    const runnerFactory = vi.fn((agent: AgentConfig) => {
      if (agent.id === 'dev-1') throw new Error('runner boom');
      return { exec: execForSession(present) };
    });
    const poller = makePoller({
      config: makeConfig([makeAgent('dev-1'), makeAgent('dev-2')]),
      store,
      runnerFactory,
      failureThreshold: 1,
    });

    await expect(poller.pollOnce()).resolves.toBeUndefined();

    expect(store.get('dev-1')).toMatchObject({
      tmuxSessionStatus: 'unreachable',
      error: 'runner boom',
    });
    expect(store.get('dev-2').tmuxSessionStatus).toBe('present');
  });

  it('records PANE_PROBE_FAILED when a present session has multiple panes', async () => {
    const errorRecordStore = await makeErrorRecordStore();
    const store = new TmuxSessionStatusStore();
    const exec = makeExec({ listPanes: text('%1 claude\n%2 zsh\n'), capturePane: readyCapture });
    const poller = makePoller({ store, errorRecordStore, exec });

    await poller.pollOnce();

    expect(store.get('dev-1')).toMatchObject({
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'error',
      reason: 'PANE_PROBE_FAILED',
    });
    expect(store.get('dev-1').message).toContain('expects exactly one');
    expect(await errorRecordStore.latestForAgent('dev-1')).toMatchObject({
      reason: 'PANE_PROBE_FAILED',
      operation: 'tmux-probe',
    });
    expect((exec as ReturnType<typeof vi.fn>).mock.calls.some(([cmd]) => cmd.includes('___bx-classify-sep___'))).toBe(false);
  });

  it('passes timeout to the runner and limits concurrent probes', async () => {
    let active = 0;
    let maxActive = 0;
    const timeouts: Array<number | undefined> = [];
    const agents = Array.from({ length: 6 }, (_, i) => makeAgent(`agent-${i}`));
    const poller = makePoller({
      config: makeConfig(agents),
      probeTimeoutMs: 123,
      concurrency: 2,
      runnerFactory: () => ({
        exec: async (_cmd, options) => {
          timeouts.push(options?.timeout);
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise(resolve => setTimeout(resolve, 1));
          active -= 1;
          return present;
        },
      }),
    });

    await poller.pollOnce();

    const boundedCalls = timeouts.filter(t => t !== undefined);
    expect(boundedCalls.length).toBeGreaterThanOrEqual(6);
    expect(boundedCalls.every(t => t === 123)).toBe(true);
    expect(maxActive).toBe(2);
  });

  it('start() schedules periodic polls and stop() halts them; double-start is idempotent', async () => {
    vi.useFakeTimers();
    const exec = vi.fn().mockResolvedValue(present);
    const poller = makePoller({ exec, intervalMs: 10_000 });

    poller.start();
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(exec).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(exec).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(exec).toHaveBeenCalledTimes(6);

    poller.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exec).toHaveBeenCalledTimes(6);

    vi.useRealTimers();
  });

  it('pollOnce skips reentrant invocations while a poll is in flight', async () => {
    let inProbe = 0;
    let probeStarted = 0;
    let release: (() => void) | null = null;
    const poller = makePoller({
      runnerFactory: () => ({
        exec: async (cmd: string) => {
          if (cmd.includes('pane_title')) return emptyPaneTitle;
          if (!cmd.includes('has-session')) return oneClaudePane;
          probeStarted += 1;
          inProbe += 1;
          await new Promise<void>(resolve => { release = resolve; });
          inProbe -= 1;
          return present;
        },
      }),
    });

    const first = poller.pollOnce();
    await poller.pollOnce();
    expect(probeStarted).toBe(1);
    expect(inProbe).toBe(1);
    release!();
    await first;
    expect(probeStarted).toBe(1);
  });

  it('logs once on state transition and stays silent while tmux status is steady', async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => { logs.push(msg); });
    const poller = makePoller({
      exec: makeExec({ hasSession: scripted([present, present, absent]) }),
    });

    await poller.pollOnce();
    await poller.pollOnce();
    await poller.pollOnce();

    expect(logs.filter(l => l.includes('[tmux-session] dev-1'))).toEqual([
      '[tmux-session] dev-1 unknown -> present',
      '[tmux-session] dev-1 present -> absent',
    ]);
    logSpy.mockRestore();
  });

  it('replaceConfig prunes store and failure counts for agents removed from config', async () => {
    const store = new TmuxSessionStatusStore();
    const ag1 = makeAgent('dev-1');
    const ag2 = makeAgent('dev-2');
    const results = new Map<string, ExecResult>([
      ['dev-1', unreachable],
      ['dev-2', present],
    ]);
    const poller = makePoller({
      config: makeConfig([ag1, ag2]),
      store,
      runnerFactory: agent => ({
        exec: vi.fn(async () => results.get(agent.id)!),
      }) as unknown as CommandRunner,
      failureThreshold: 1,
    });
    await poller.pollOnce();
    expect(store.get('dev-1').tmuxSessionStatus).toBe('unreachable');
    expect(store.get('dev-2').tmuxSessionStatus).toBe('present');

    poller.replaceConfig(makeConfig([ag2]));
    expect(store.get('dev-1').tmuxSessionStatus).toBe('unknown');
    expect(store.get('dev-2').tmuxSessionStatus).toBe('present');
  });

  it('in-flight probe must not resurrect store after replaceConfig pruned the agent', async () => {
    const store = new TmuxSessionStatusStore();
    const ag1 = makeAgent('dev-1');
    let releaseHasSession!: () => void;
    const hasSessionGate = new Promise<void>((resolve) => { releaseHasSession = resolve; });
    const poller = makePoller({
      config: makeConfig([ag1]),
      store,
      exec: makeExec({ hasSession: async () => { await hasSessionGate; return present; } }),
    });

    const pollPromise = poller.pollOnce();
    await new Promise(resolve => setImmediate(resolve));

    poller.replaceConfig(makeConfig([]));
    expect(store.get('dev-1').tmuxSessionStatus).toBe('unknown');

    releaseHasSession();
    await pollPromise;

    expect(store.get('dev-1').tmuxSessionStatus).toBe('unknown');
    expect(store.get('dev-1').observedAt).toBeUndefined();
    expect(store.get('dev-1').reason).toBeUndefined();
  });

  it('in-flight probe must not pollute new bootstrap after DELETE → CREATE same agent id', async () => {
    const store = new TmuxSessionStatusStore();
    const oldInstance = makeAgent('dev-1');
    const newInstance = makeAgent('dev-1');
    expect(oldInstance).not.toBe(newInstance);

    let releaseHasSession!: () => void;
    const hasSessionGate = new Promise<void>((resolve) => { releaseHasSession = resolve; });
    let probedAgent: AgentConfig | null = null;
    const poller = makePoller({
      config: makeConfig([oldInstance]),
      store,
      runnerFactory: agent => {
        probedAgent = agent;
        return { exec: makeExec({ hasSession: async () => { await hasSessionGate; return present; } }) } as unknown as CommandRunner;
      },
    });

    const pollPromise = poller.pollOnce();
    await new Promise(resolve => setImmediate(resolve));
    expect(probedAgent).toBe(oldInstance);

    poller.replaceConfig(makeConfig([]));
    poller.replaceConfig(makeConfig([newInstance]));

    releaseHasSession();
    await pollPromise;

    expect(store.get('dev-1').tmuxSessionStatus).toBe('unknown');
    expect(store.get('dev-1').observedAt).toBeUndefined();
    expect(store.get('dev-1').reason).toBeUndefined();
  });

  it('replaceConfig reschedules the periodic timer when tmuxProbePollIntervalMs changes', async () => {
    vi.useFakeTimers();
    const store = new TmuxSessionStatusStore();
    const ag1 = makeAgent('dev-1');
    const baseConfig: BaxianConfig = {
      review: { rounds: 10 },
      server: { ...DEFAULT_SERVER_CONFIG, tmuxProbePollIntervalMs: 2000 },
      project: [{ id: 'proj', repo: 'user/repo', merge: null, agent: [[ag1]] }],
    };
    const exec = vi.fn(async () => present);
    const poller = makePoller({
      config: baseConfig,
      store,
      runnerFactory: () => ({ exec }) as unknown as CommandRunner,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    const callsAtBoot = exec.mock.calls.length;
    expect(callsAtBoot).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(2000);
    expect(exec.mock.calls.length).toBeGreaterThan(callsAtBoot);
    const callsAt2s = exec.mock.calls.length;

    poller.replaceConfig({
      ...baseConfig,
      server: { ...baseConfig.server, tmuxProbePollIntervalMs: 8000 },
    });

    await vi.advanceTimersByTimeAsync(7999);
    expect(exec.mock.calls.length).toBe(callsAt2s);
    await vi.advanceTimersByTimeAsync(1);
    expect(exec.mock.calls.length).toBeGreaterThan(callsAt2s);

    poller.stop();
    vi.useRealTimers();
  });

  it('replaceConfig picks up updated tmuxProbeConcurrency and tmuxProbeTimeoutMs', async () => {
    const store = new TmuxSessionStatusStore();
    const baseConfig: BaxianConfig = {
      review: { rounds: 10 },
      server: { ...DEFAULT_SERVER_CONFIG, tmuxProbeConcurrency: 2, tmuxProbeTimeoutMs: 1500 },
      project: [{ id: 'proj', repo: 'user/repo', merge: null, agent: [[makeAgent('dev-1')]] }],
    };
    const poller = makePoller({
      config: baseConfig,
      store,
      runnerFactory: () => ({ exec: vi.fn(async () => present) }) as unknown as CommandRunner,
    }) as unknown as { concurrency: number; probeTimeoutMs: number; replaceConfig: (c: BaxianConfig) => void };

    expect(poller.concurrency).toBe(2);
    expect(poller.probeTimeoutMs).toBe(1500);

    poller.replaceConfig({
      ...baseConfig,
      server: { ...baseConfig.server, tmuxProbeConcurrency: 6, tmuxProbeTimeoutMs: 4000 },
    });
    expect(poller.concurrency).toBe(6);
    expect(poller.probeTimeoutMs).toBe(4000);
  });

  it('replaceConfig clearing optional server fields reverts to defaults (not stale runtime values)', async () => {
    const store = new TmuxSessionStatusStore();
    const customConfig: BaxianConfig = {
      review: { rounds: 10 },
      server: {
        ...DEFAULT_SERVER_CONFIG,
        tmuxProbePollIntervalMs: 5000,
        tmuxProbeTimeoutMs: 4000,
        tmuxProbeConcurrency: 8,
      },
      project: [{ id: 'proj', repo: 'user/repo', merge: null, agent: [[makeAgent('dev-1')]] }],
    };
    const poller = makePoller({
      config: customConfig,
      store,
      runnerFactory: () => ({ exec: vi.fn(async () => present) }) as unknown as CommandRunner,
    }) as unknown as {
      concurrency: number;
      probeTimeoutMs: number;
      pollIntervalMs: number;
      periodicRunner: { getIntervalMs: () => number };
      replaceConfig: (c: BaxianConfig) => void;
    };

    expect(poller.concurrency).toBe(8);
    expect(poller.probeTimeoutMs).toBe(4000);
    expect(poller.pollIntervalMs).toBe(5000);

    poller.replaceConfig({
      review: { rounds: 10 },
      server: DEFAULT_SERVER_CONFIG,
      project: customConfig.project,
    });

    expect(poller.concurrency).toBe(4);
    expect(poller.probeTimeoutMs).toBe(3000);
    expect(poller.pollIntervalMs).toBe(10_000);
    expect(poller.periodicRunner.getIntervalMs()).toBe(10_000);
  });

  it('purgeAgent removes every per-agent map entry', async () => {
    const store = new TmuxSessionStatusStore();
    const poller = makePoller({
      store,
      runnerFactory: () => ({ exec: vi.fn(async () => unreachable) }) as unknown as CommandRunner,
      failureThreshold: 1,
    });
    await poller.pollOnce();
    expect(store.get('dev-1').tmuxSessionStatus).toBe('unreachable');

    poller.purgeAgent('dev-1');
    expect(store.get('dev-1').tmuxSessionStatus).toBe('unknown');
  });

  it('detects blocked state via manifest permission prompt', async () => {
    const permissionScreen = [
      'Run this bash command?',
      'Do you want to proceed?',
      'Tab to amend',
      '❯ Yes',
      '2. No',
    ].join('\n');
    await runProbeScenario({
      exec: makeExec({ capturePane: text(permissionScreen) }),
      steps: [{}],
      expect: (store) => {
        const obs = store.get('dev-1');
        expect(obs.runtimeStatusHint).toBe('pending');
        expect(obs.reason).toBe('PENDING_HUMAN');
      },
    });
  });

  it('detects working state via OSC title braille spinner', async () => {
    await runProbeScenario({
      exec: makeExec({ capturePane: text('some output'), paneTitle: text('⠁ Reading file\n') }),
      steps: [{}],
      expectMatch: {
        tmuxSessionStatus: 'present',
        paneState: 'live-runtime',
        runtimeStatusHint: 'working',
      },
    });
  });
});

describe('TmuxSessionStatusStore onChange', () => {
  it('does not fire when only observedAt advances', () => {
    const store = new TmuxSessionStatusStore();
    const fired: Array<['set' | 'delete', string]> = [];
    store.onChange((kind, id) => fired.push([kind, id]));
    store.set('dev-1', { tmuxSessionStatus: 'present', observedAt: 't1' });
    store.set('dev-1', { tmuxSessionStatus: 'present', observedAt: 't2' });
    store.set('dev-1', { tmuxSessionStatus: 'present', observedAt: 't3' });
    expect(fired).toEqual([['set', 'dev-1']]);
  });

  it('fires when tmux status changes', () => {
    const store = new TmuxSessionStatusStore();
    const fired: Array<['set' | 'delete', string]> = [];
    store.onChange((kind, id) => fired.push([kind, id]));
    store.set('dev-1', { tmuxSessionStatus: 'present', observedAt: 't1' });
    store.set('dev-1', { tmuxSessionStatus: 'unreachable', observedAt: 't2', error: 'ssh' });
    expect(fired).toEqual([['set', 'dev-1'], ['set', 'dev-1']]);
  });

  it('fires on delete only when an entry existed', () => {
    const store = new TmuxSessionStatusStore();
    const fired: Array<['set' | 'delete', string]> = [];
    store.onChange((kind, id) => fired.push([kind, id]));
    store.delete('never-existed');
    expect(fired).toEqual([]);
    store.set('dev-1', { tmuxSessionStatus: 'present' });
    fired.length = 0;
    store.delete('dev-1');
    expect(fired).toEqual([['delete', 'dev-1']]);
  });
});

describe('TmuxProbePoller triggers reconcileFailedAgent on absent', () => {
  it('calls agentManager.reconcileFailedAgent only when probe returns absent', async () => {
    const agents = [makeAgent('dev-1'), makeAgent('dev-2'), makeAgent('dev-3')];
    const cfg = makeConfig(agents);
    const calls: string[] = [];
    const stubAgentManager = {
      getAgentState: async () => null,
      reconcileFailedAgent: async (id: string) => { calls.push(id); return true; },
    } as unknown as import('../../src/agent/manager.js').AgentManager;

    const results = new Map<string, ExecResult>([
      ['dev-1', { stdout: '', stderr: '', exitCode: 0 }],
      ['dev-2', { stdout: '', stderr: "can't find session: dev-2", exitCode: 1 }],
      ['dev-3', { stdout: '', stderr: 'ssh dead', exitCode: 255 }],
    ]);

    const poller = new TmuxProbePoller({
      config: cfg,
      store: new TmuxSessionStatusStore(),
      agentManager: stubAgentManager,
      runnerFactory: agent => ({
        exec: vi.fn().mockResolvedValue(results.get(agent.id)),
        writeFile: async () => {},
      } as unknown as CommandRunner),
    });
    await poller.pollOnce();

    expect(calls).toEqual(['dev-2']);
  });
});
