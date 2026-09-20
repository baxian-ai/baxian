import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi } from 'vitest';
import type { AgentConfig, BaxianConfig, HostConfig } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
import { createRunner, type CommandRunner, type ExecResult } from '../../src/agent/runner.js';
import { TmuxProbePoller, TmuxSessionStatusStore } from '../../src/agent/tmux-probe-poller.js';
import { blank } from './runtime-captures.js';
import { ErrorRecordStore } from '../../src/state/error-record-store.js';
import { makeCommandRunner } from '../helpers/fixtures.js';

vi.mock('../../src/agent/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/runner.js')>();
  return { ...actual, createRunner: vi.fn(actual.createRunner) };
});

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
    host: [],
    project: [{
      id: 'proj',
      repo: 'https://github.com/user/repo.git',
      merge: null,
      agent: agents.map(agent => [agent]),
    }],
  };
}

const present: ExecResult = { stdout: '', stderr: '', exitCode: 0 };
const absent: ExecResult = { stdout: '', stderr: "can't find session: dev-1", exitCode: 1 };
const unreachable: ExecResult = { stdout: '', stderr: 'ssh timeout', exitCode: 255 };
const oneClaudePane: ExecResult = { stdout: '%1 claude\n', stderr: '', exitCode: 0 };
const liveRuntimePane: ExecResult = { stdout: 'claude\n> ', stderr: '', exitCode: 0 };
const readyCapture: ExecResult = { stdout: '> ', stderr: '', exitCode: 0 };
const emptyPaneTitle: ExecResult = { stdout: '', stderr: '', exitCode: 0 };

function text(stdout: string): ExecResult {
  return { stdout, stderr: '', exitCode: 0 };
}

const codexPane: ExecResult = text('%1 node\n');
const codexRuntimePane: ExecResult = text('node\n› ');

const PANE_OK = 'BX_PANE_OK';
const SESSION_REF_LINE = '4242|1700000000|$1';
const CLASSIFY_MARKER = `${PANE_OK}#{pane_current_command}`;

function defaultSessionSnapshot(cmd: string): ExecResult {
  const name = /#\{==:#\{session_name\},([^}]*)\}/.exec(cmd)?.[1] ?? 'dev-1';
  return text(`${SESSION_REF_LINE}|${name}\n`);
}

type Branch = ExecResult | ((cmd: string) => ExecResult | Promise<ExecResult>);

interface ExecOverrides {
  hasSession?: Branch;
  sessionSnapshot?: Branch;
  listPanes?: Branch;
  classify?: Branch;
  capturePane?: Branch;
  paneTitle?: Branch;
  paneWidth?: Branch;
}

function resolveBranch(branch: Branch, cmd: string): ExecResult | Promise<ExecResult> {
  return typeof branch === 'function' ? branch(cmd) : branch;
}

async function markerHeader(branch: Branch, cmd: string): Promise<ExecResult> {
  const result = await resolveBranch(branch, cmd);
  return { ...result, stdout: `${PANE_OK}${result.stdout}` };
}

async function markerBody(branch: Branch, cmd: string): Promise<ExecResult> {
  const result = await resolveBranch(branch, cmd);
  return { ...result, stdout: `${PANE_OK}\n${result.stdout}` };
}

function makeExec(overrides: ExecOverrides = {}): CommandRunner['exec'] {
  const branches = {
    hasSession: overrides.hasSession ?? present,
    sessionSnapshot: overrides.sessionSnapshot ?? defaultSessionSnapshot,
    listPanes: overrides.listPanes ?? oneClaudePane,
    classify: overrides.classify ?? liveRuntimePane,
    capturePane: overrides.capturePane ?? readyCapture,
    paneTitle: overrides.paneTitle ?? emptyPaneTitle,
    paneWidth: overrides.paneWidth ?? text('80'),
  };
  return vi.fn(async (cmd: string) => {
    if (cmd.includes('has-session')) return resolveBranch(branches.hasSession, cmd);
    if (cmd.includes('list-sessions')) return resolveBranch(branches.sessionSnapshot, cmd);
    if (cmd.includes('list-panes')) return resolveBranch(branches.listPanes, cmd);
    if (cmd.includes(CLASSIFY_MARKER)) return markerHeader(branches.classify, cmd);
    if (cmd.includes('pane_title')) return markerHeader(branches.paneTitle, cmd);
    if (cmd.includes('pane_width')) return markerHeader(branches.paneWidth, cmd);
    if (cmd.includes('capture-pane')) return markerBody(branches.capturePane, cmd);
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
    runnerFactory: runnerFactory ?? (() => makeCommandRunner({ exec: resolvedExec })),
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
      runnerFactory: agent => makeCommandRunner({ exec: execForSession(results.get(agent.id)!) }),
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
      exec: makeExec({ capturePane: text('✻ Hatching… (3s · esc to interrupt)') }),
      steps: [{}],
      expectMatch: {
        tmuxSessionStatus: 'present',
        paneState: 'live-runtime',
        runtimeStatusHint: 'working',
      },
    });
  });

  it('marks a codex • Working line as a working observation (herdr shape; truncated tails no longer covered)', async () => {
    const codexAgent: AgentConfig = { ...makeAgent('qa-1'), runtime: 'codex', role: 'qa' };
    await runProbeScenario({
      agents: [codexAgent],
      agentId: 'qa-1',
      exec: makeExec({
        listPanes: codexPane,
        classify: codexRuntimePane,
        capturePane: text('• Working (2m 30s • esc to interrupt)'),
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
      exec: makeExec({ classify: text('vim\nediting') }),
      steps: [{}],
      expectMatch: {
        tmuxSessionStatus: 'present',
        runtimeStatusHint: 'error',
        reason: 'UNSUPPORTED_FOREGROUND_PROCESS',
      },
    });
  });

  it('an issue re-detected right after a published unreachable carries its own error record, never the unreachable one', async () => {
    const errorRecordStore = await makeErrorRecordStore();
    let firstErrorId: string | undefined;
    await runProbeScenario({
      errorRecordStore,
      exec: makeExec({ hasSession: scripted([present, unreachable, unreachable, present]), classify: text('vim\nediting') }),
      failureThreshold: 2,
      steps: [
        {
          then: (s) => {
            expect(s.get('dev-1').reason).toBe('UNSUPPORTED_FOREGROUND_PROCESS');
            firstErrorId = s.get('dev-1').latestError?.id;
            expect(firstErrorId).toBeTruthy();
          },
        },
        { then: (s) => expect(s.get('dev-1').reason).toBe('UNSUPPORTED_FOREGROUND_PROCESS') },
        {
          then: (s) => {
            expect(s.get('dev-1').tmuxSessionStatus).toBe('unreachable');
            expect(s.get('dev-1').latestError?.reason).toBe('TMUX_UNREACHABLE');
          },
        },
        {
          then: (s) => {
            expect(s.get('dev-1').reason).toBe('UNSUPPORTED_FOREGROUND_PROCESS');
            expect(s.get('dev-1').latestError?.reason).toBe('UNSUPPORTED_FOREGROUND_PROCESS');
            expect(s.get('dev-1').latestError?.id).not.toBe(firstErrorId);
          },
        },
      ],
    });
  });

  describe('RUNTIME_EXITED (pane back at a shell prompt)', () => {
    const shellPane: ExecResult = text('zsh\n$ ');
    const GRACE = 20_000;

    it('flags RUNTIME_EXITED with an error record once the shell persisted across consecutive probes for the grace period', async () => {
      const errorRecordStore = await makeErrorRecordStore();
      await runProbeScenario({
        errorRecordStore,
        exec: makeExec({ classify: shellPane }),
        failureThreshold: 2,
        steps: [
          {
            then: (s) => {
              expect(s.get('dev-1').paneState).toBe('shell');
              expect(s.get('dev-1').runtimeStatusHint).toBeUndefined();
            },
          },
          {
            advance: GRACE,
            then: (s) => expect(s.get('dev-1')).toMatchObject({
              paneState: 'shell',
              runtimeStatusHint: 'error',
              reason: 'RUNTIME_EXITED',
            }),
          },
        ],
      });
      expect(await errorRecordStore.latestForAgent('dev-1')).toMatchObject({
        agentId: 'dev-1',
        reason: 'RUNTIME_EXITED',
        recommendation: expect.stringContaining('Restart REPL'),
      });
    });

    it('a 1s probe interval does not turn a normal startup window into RUNTIME_EXITED: the count is met but the grace is not', async () => {
      const errorRecordStore = await makeErrorRecordStore();
      let scenario: 'live' | 'shell' = 'shell';
      await runProbeScenario({
        errorRecordStore,
        exec: makeExec({ classify: () => (scenario === 'shell' ? shellPane : liveRuntimePane) }),
        failureThreshold: 2,
        steps: [
          {},
          { advance: 1_000 },
          { advance: 1_000, then: (s) => expect(s.get('dev-1').reason).toBeUndefined() },
          { advance: 1_000, set: () => { scenario = 'live'; } },
        ],
        expectClear: true,
      });
      expect(await errorRecordStore.latestForAgent('dev-1')).toBeFalsy();
    });

    it('with a 1s probe interval the flag still lands once the shell has persisted for the grace period', async () => {
      await runProbeScenario({
        exec: makeExec({ classify: shellPane }),
        failureThreshold: 2,
        steps: [
          {},
          { advance: 1_000 },
          { advance: 1_000, then: (s) => expect(s.get('dev-1').reason).toBeUndefined() },
          { advance: GRACE, then: (s) => expect(s.get('dev-1').reason).toBe('RUNTIME_EXITED') },
        ],
      });
    });

    it('a single shell sighting between live probes (launch / restart window) does not flag', async () => {
      let scenario: 'live' | 'shell' = 'live';
      await runProbeScenario({
        exec: makeExec({ classify: () => (scenario === 'shell' ? shellPane : liveRuntimePane) }),
        failureThreshold: 2,
        steps: [
          {},
          { advance: GRACE, set: () => { scenario = 'shell'; } },
          { advance: GRACE, set: () => { scenario = 'live'; } },
          { advance: GRACE, set: () => { scenario = 'shell'; } },
        ],
        expectClear: true,
      });
    });

    it('a probe that does not see the pane (unreachable) breaks an unconfirmed shell streak instead of bridging two sightings', async () => {
      await runProbeScenario({
        exec: makeExec({ hasSession: scripted([present, unreachable, present, present]), classify: shellPane }),
        failureThreshold: 2,
        steps: [
          {},
          { advance: GRACE },
          { advance: GRACE, then: (s) => expect(s.get('dev-1').reason).toBeUndefined() },
          { advance: GRACE, then: (s) => expect(s.get('dev-1').reason).toBe('RUNTIME_EXITED') },
        ],
      });
    });

    it('a transient probe failure does not un-confirm a published RUNTIME_EXITED (no flicker, no duplicate record)', async () => {
      const errorRecordStore = await makeErrorRecordStore();
      let firstErrorId: string | undefined;
      await runProbeScenario({
        errorRecordStore,
        exec: makeExec({ hasSession: scripted([present, present, unreachable, present]), classify: shellPane }),
        failureThreshold: 2,
        steps: [
          {},
          {
            advance: GRACE,
            then: (s) => {
              firstErrorId = s.get('dev-1').latestError?.id;
              expect(firstErrorId).toBeTruthy();
            },
          },
          { advance: 10_000, then: (s) => expect(s.get('dev-1').reason).toBe('RUNTIME_EXITED') },
          {
            advance: 10_000,
            then: (s) => {
              expect(s.get('dev-1').reason).toBe('RUNTIME_EXITED');
              expect(s.get('dev-1').latestError?.id).toBe(firstErrorId);
            },
          },
        ],
      });
    });

    it('a live runtime whose first screen is a skip view (transcript) does not inherit RUNTIME_EXITED from the shell observation', async () => {
      const errorRecordStore = await makeErrorRecordStore();
      let scenario: 'live' | 'shell' = 'shell';
      await runProbeScenario({
        errorRecordStore,
        exec: makeExec({
          classify: () => (scenario === 'shell' ? shellPane : liveRuntimePane),
          capturePane: transcriptCapture,
        }),
        failureThreshold: 2,
        steps: [
          {},
          { advance: GRACE, then: (s) => expect(s.get('dev-1').latestError?.reason).toBe('RUNTIME_EXITED') },
          { set: () => { scenario = 'live'; } },
        ],
        expect: (s) => {
          expect(s.get('dev-1').paneState).toBe('live-runtime');
          expect(s.get('dev-1').reason).toBeUndefined();
          expect(s.get('dev-1').runtimeStatusHint).toBeUndefined();
          expect(s.get('dev-1').latestError).toBeUndefined();
        },
      });
    });

    it('an unrelated config rewrite (same agent content, fresh objects) keeps the shell streak', async () => {
      const store = new TmuxSessionStatusStore();
      const agent = makeAgent('dev-1');
      let nowMs = 1_000_000;
      const poller = makePoller({
        store,
        config: makeConfig([agent]),
        exec: makeExec({ classify: shellPane }),
        failureThreshold: 2,
        now: () => nowMs,
      });
      await poller.pollOnce();
      poller.replaceConfig(makeConfig([{ ...agent }]));
      nowMs += GRACE;
      await poller.pollOnce();
      expect(store.get('dev-1').reason).toBe('RUNTIME_EXITED');
    });

    it('a same-ID agent whose config changed (runtime swapped) restarts the shell streak', async () => {
      const store = new TmuxSessionStatusStore();
      const agent = makeAgent('dev-1');
      let nowMs = 1_000_000;
      const poller = makePoller({
        store,
        config: makeConfig([agent]),
        exec: makeExec({ classify: shellPane }),
        failureThreshold: 2,
        now: () => nowMs,
      });
      await poller.pollOnce();
      poller.replaceConfig(makeConfig([{ ...agent, runtime: 'codex' }]));
      expect(store.get('dev-1').tmuxSessionStatus).toBe('unknown');
      nowMs += GRACE;
      await poller.pollOnce();
      expect(store.get('dev-1').reason).toBeUndefined();
      nowMs += GRACE;
      await poller.pollOnce();
      expect(store.get('dev-1').reason).toBe('RUNTIME_EXITED');
    });

    it('probeAgent rebuilds a purged agent\'s observation to present/live-runtime in one call and drops the confirmed exit', async () => {
      const store = new TmuxSessionStatusStore();
      const errorRecordStore = await makeErrorRecordStore();
      let nowMs = 1_000_000;
      let scenario: 'shell' | 'live' = 'shell';
      const poller = makePoller({
        store,
        errorRecordStore,
        exec: makeExec({ classify: () => (scenario === 'shell' ? shellPane : liveRuntimePane) }),
        failureThreshold: 2,
        now: () => nowMs,
      });
      await poller.pollOnce();
      nowMs += GRACE;
      await poller.pollOnce();
      expect(store.get('dev-1').reason).toBe('RUNTIME_EXITED');

      scenario = 'live';
      poller.purgeAgent('dev-1');
      expect(store.get('dev-1').tmuxSessionStatus).toBe('unknown');
      await poller.probeAgent('dev-1');
      expect(store.get('dev-1')).toMatchObject({ tmuxSessionStatus: 'present', paneState: 'live-runtime' });
      expect(store.get('dev-1').reason).toBeUndefined();
      expect(store.get('dev-1').observedAt).toBeTruthy();
    });

    it('confirmReplReady publishes the maintenance-confirmed present first; an immediate probe failing below the threshold leaves it in place instead of unknown, and the failure still counts toward the next poll', async () => {
      const store = new TmuxSessionStatusStore();
      const errorRecordStore = await makeErrorRecordStore();
      let nowMs = 1_000_000;
      let hasSession: ExecResult = present;
      const poller = makePoller({
        store,
        errorRecordStore,
        exec: makeExec({ hasSession: () => hasSession, classify: shellPane }),
        failureThreshold: 2,
        now: () => nowMs,
      });
      await poller.pollOnce();
      nowMs += GRACE;
      await poller.pollOnce();
      expect(store.get('dev-1').reason).toBe('RUNTIME_EXITED');

      hasSession = unreachable;
      await poller.confirmReplReady('dev-1');
      expect(store.get('dev-1')).toMatchObject({ tmuxSessionStatus: 'present', paneState: 'live-runtime' });
      expect(store.get('dev-1').reason).toBeUndefined();
      expect(store.get('dev-1').error).toBeUndefined();
      expect(store.get('dev-1').lastPresentAt).toBe(store.get('dev-1').observedAt);

      await poller.pollOnce();
      expect(store.get('dev-1').tmuxSessionStatus).toBe('unreachable');
    });

    it('confirmReplReady: a successful immediate probe replaces the seeded present with the full observation', async () => {
      const store = new TmuxSessionStatusStore();
      const poller = makePoller({
        store,
        exec: makeExec({ capturePane: text('✻ Hatching… (3s · esc to interrupt)') }),
        failureThreshold: 2,
      });

      await poller.confirmReplReady('dev-1');

      expect(store.get('dev-1')).toMatchObject({ tmuxSessionStatus: 'present', paneState: 'live-runtime', runtimeStatusHint: 'working' });
    });

    it('confirmReplReady for an agent that is not configured writes nothing', async () => {
      const store = new TmuxSessionStatusStore();
      const poller = makePoller({ store });

      await poller.confirmReplReady('ghost');

      expect(store.get('ghost')).toEqual({ tmuxSessionStatus: 'unknown' });
    });

    it('purgeAgent voids an absent probe paused inside reconcile: its stillCurrent reads false, and the probeAgent that follows lands present', async () => {
      const store = new TmuxSessionStatusStore();
      const agent = makeAgent('dev-1');
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const guardAtWrite: boolean[] = [];
      let session: ExecResult = absent;
      const poller = new TmuxProbePoller({
        config: makeConfig([agent]),
        store,
        agentManager: {
          getAgentState: async () => null,
          reconcileFailedAgent: async (_id: string, opts?: { stillCurrent?: () => boolean }) => {
            await gate;
            guardAtWrite.push(opts?.stillCurrent?.() ?? true);
            return true;
          },
        } as unknown as import('../../src/agent/manager.js').AgentManager,
        runnerFactory: () => ({ exec: makeExec({ hasSession: () => session }) } as unknown as CommandRunner),
        failureThreshold: 2,
      });
      const periodic = poller.pollOnce();
      await new Promise(resolve => setImmediate(resolve));
      expect(store.get('dev-1').tmuxSessionStatus).toBe('absent');

      // retry 重建了 REPL:维护路径先 purge 再即时探测
      poller.purgeAgent('dev-1');
      session = present;
      const targeted = poller.probeAgent('dev-1');
      release();
      await Promise.all([periodic, targeted]);

      expect(guardAtWrite).toEqual([false]);
      expect(store.get('dev-1')).toMatchObject({ tmuxSessionStatus: 'present', paneState: 'live-runtime' });
    });

    it('purgeAgent voids a probe still waiting on has-session: it commits nothing and reconciles nothing when it resumes', async () => {
      const store = new TmuxSessionStatusStore();
      const agent = makeAgent('dev-1');
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let gated = true;
      const reconciled: string[] = [];
      const poller = new TmuxProbePoller({
        config: makeConfig([agent]),
        store,
        agentManager: {
          getAgentState: async () => null,
          reconcileFailedAgent: async (id: string) => { reconciled.push(id); return true; },
        } as unknown as import('../../src/agent/manager.js').AgentManager,
        runnerFactory: () => ({
          exec: makeExec({ hasSession: async () => { if (gated) { await gate; return absent; } return present; } }),
        } as unknown as CommandRunner),
        failureThreshold: 2,
      });
      const periodic = poller.pollOnce();
      await new Promise(resolve => setImmediate(resolve));
      poller.purgeAgent('dev-1');
      gated = false;
      release();
      await periodic;

      expect(reconciled).toEqual([]);
      expect(store.get('dev-1').tmuxSessionStatus).toBe('unknown');
      await poller.probeAgent('dev-1');
      expect(store.get('dev-1').tmuxSessionStatus).toBe('present');
    });

    it('probeAgent queues behind an in-flight probe of the same agent, so the fresh observation is the one that lands last', async () => {
      const store = new TmuxSessionStatusStore();
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let classifies = 0;
      const poller = makePoller({
        store,
        exec: makeExec({
          classify: async () => {
            classifies += 1;
            if (classifies === 1) { await gate; return shellPane; }
            return liveRuntimePane;
          },
        }),
        failureThreshold: 2,
      });
      const periodic = poller.pollOnce();
      await new Promise(resolve => setImmediate(resolve));
      const targeted = poller.probeAgent('dev-1');
      await new Promise(resolve => setImmediate(resolve));
      expect(classifies).toBe(1);

      release();
      await Promise.all([periodic, targeted]);
      expect(classifies).toBe(2);
      expect(store.get('dev-1').paneState).toBe('live-runtime');
    });

    it('probeAgent for an agent that is not configured is a no-op', async () => {
      const store = new TmuxSessionStatusStore();
      const exec = makeExec();
      const poller = makePoller({ store, exec });
      await poller.probeAgent('ghost');
      expect(store.get('ghost').tmuxSessionStatus).toBe('unknown');
      expect(exec).not.toHaveBeenCalled();
    });

    it('a same-content reload while a probe is in flight keeps both the observation and the shell streak', async () => {
      const store = new TmuxSessionStatusStore();
      const agent = makeAgent('dev-1');
      let nowMs = 1_000_000;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let gated = true;
      const poller = makePoller({
        store,
        config: makeConfig([agent]),
        exec: makeExec({ classify: shellPane, hasSession: async () => { if (gated) await gate; return present; } }),
        failureThreshold: 2,
        now: () => nowMs,
      });
      const inFlight = poller.pollOnce();
      await new Promise(resolve => setImmediate(resolve));
      poller.replaceConfig(makeConfig([{ ...agent }]));
      gated = false;
      release();
      await inFlight;
      expect(store.get('dev-1').tmuxSessionStatus).toBe('present');

      nowMs += GRACE;
      await poller.pollOnce();
      expect(store.get('dev-1').reason).toBe('RUNTIME_EXITED');
    });

    it.each([
      ['host alias', (agent: AgentConfig, cfg: BaxianConfig): BaxianConfig => ({ ...cfg, host: [{ ...cfg.host![0], alias: 'renamed' }] })],
      ['host password', (agent: AgentConfig, cfg: BaxianConfig): BaxianConfig => ({ ...cfg, host: [{ ...cfg.host![0], password: 'rotated' }] })],
      ['agent model', (agent: AgentConfig, cfg: BaxianConfig): BaxianConfig => ({ ...makeConfig([{ ...agent, model: 'gpt-5-codex' }]), host: cfg.host })],
      ['agent workdir', (agent: AgentConfig, cfg: BaxianConfig): BaxianConfig => ({ ...makeConfig([{ ...agent, workdir: '/tmp/elsewhere' }]), host: cfg.host })],
      ['host ref swapped to another id with the same connection target', (agent: AgentConfig, cfg: BaxianConfig): BaxianConfig => ({ ...makeConfig([{ ...agent, host: 'h2' }]), host: [cfg.host![0], { ...cfg.host![0], id: 'h2', alias: 'twin' }] })],
    ])('%s changing does not restart the shell streak: the probed pane and its reading are unchanged', async (_label, mutate) => {
      const store = new TmuxSessionStatusStore();
      const agent: AgentConfig = { ...makeAgent('dev-1'), mode: 'remote', host: 'h1' };
      const config: BaxianConfig = { ...makeConfig([agent]), host: [{ id: 'h1', hostname: 'a.example', user: 'ops', password: 'pw', alias: 'box' }] };
      let nowMs = 1_000_000;
      const poller = makePoller({ store, config, exec: makeExec({ classify: shellPane }), failureThreshold: 2, now: () => nowMs });
      await poller.pollOnce();
      poller.replaceConfig(mutate(agent, config));
      expect(store.get('dev-1').tmuxSessionStatus).toBe('present');
      nowMs += GRACE;
      await poller.pollOnce();
      expect(store.get('dev-1').reason).toBe('RUNTIME_EXITED');
    });

    it.each([
      ['deleted', (h1: HostConfig): HostConfig[] => [{ ...h1, id: 'h2' }]],
      ['re-pointed at another machine', (h1: HostConfig): HostConfig[] => [{ ...h1, hostname: 'b.example' }, { ...h1, id: 'h2' }]],
    ])('a probe queued behind an in-flight one connects with the instance current when it runs: after a same-target host ref swap whose old ref is %s, it resolves the new ref, not the captured one', async (_label, hostsAfter) => {
      const realCreateRunner = vi.mocked(createRunner).getMockImplementation()!;
      const store = new TmuxSessionStatusStore();
      const agent: AgentConfig = { ...makeAgent('dev-1'), mode: 'remote', host: 'h1' };
      const h1: HostConfig = { id: 'h1', hostname: 'a.example', user: 'ops', password: 'pw' };
      const before: BaxianConfig = { ...makeConfig([agent]), host: [h1] };
      const after: BaxianConfig = { ...makeConfig([{ ...agent, host: 'h2' }]), host: hostsAfter(h1) };
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const hosts: Array<HostConfig | undefined> = [];
      vi.mocked(createRunner).mockImplementation((mode, host) => {
        hosts.push(host);
        if (!host) return realCreateRunner(mode, host);
        const exec = execForSession(present);
        const gated = hosts.length === 1;
        return { exec: gated ? async (cmd: string) => { await gate; return exec(cmd); } : exec } as unknown as CommandRunner;
      });
      try {
        const poller = new TmuxProbePoller({ config: before, store, agentManager: noopAgentManager, failureThreshold: 1 });

        const inFlight = poller.probeAgent('dev-1');
        await vi.waitFor(() => expect(hosts).toHaveLength(1));
        const queued = poller.probeAgent('dev-1');
        poller.replaceConfig(after);
        release();
        await Promise.all([inFlight, queued]);

        expect(hosts.map(host => `${host?.id}@${host?.hostname}`)).toEqual(['h1@a.example', 'h2@a.example']);
        expect(store.get('dev-1').tmuxSessionStatus).toBe('present');
      } finally {
        vi.mocked(createRunner).mockImplementation(realCreateRunner);
      }
    });

    it('a password rotated while a probe is in flight voids that probe: its old-credential failure neither counts nor publishes, and the pane conclusion survives', async () => {
      const errorRecordStore = await makeErrorRecordStore();
      const store = new TmuxSessionStatusStore();
      const agent: AgentConfig = { ...makeAgent('dev-1'), mode: 'remote', host: 'h1' };
      const configWith = (password: string): BaxianConfig => ({ ...makeConfig([agent]), host: [{ id: 'h1', hostname: 'a.example', user: 'ops', password }] });
      let nowMs = 1_000_000;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let gated = false;
      const sessions = scripted([present, present, unreachable, unreachable, present]);
      const poller = makePoller({
        store,
        errorRecordStore,
        config: configWith('old'),
        exec: makeExec({ classify: shellPane, hasSession: async () => { if (gated) await gate; return sessions(''); } }),
        failureThreshold: 2,
        now: () => nowMs,
      });
      await poller.pollOnce();
      nowMs += GRACE;
      await poller.pollOnce();
      const exitedId = store.get('dev-1').latestError?.id;
      expect(store.get('dev-1').reason).toBe('RUNTIME_EXITED');
      nowMs += 10_000;
      await poller.pollOnce();
      expect(store.get('dev-1').reason).toBe('RUNTIME_EXITED');

      gated = true;
      const inFlight = poller.pollOnce();
      await new Promise(resolve => setImmediate(resolve));
      poller.replaceConfig(configWith('new'));
      gated = false;
      release();
      await inFlight;
      expect(store.get('dev-1')).toMatchObject({ tmuxSessionStatus: 'present', reason: 'RUNTIME_EXITED' });
      expect((await errorRecordStore.latestForAgent('dev-1'))?.reason).toBe('RUNTIME_EXITED');

      nowMs += 10_000;
      await poller.pollOnce();
      expect(store.get('dev-1').reason).toBe('RUNTIME_EXITED');
      expect(store.get('dev-1').latestError?.id).toBe(exitedId);
    });

    it('a password rotated while the unreachable record is being written leaves count, pane baseline and store untouched: the new connection counts from zero and RUNTIME_EXITED continues', async () => {
      const errorRecordStore = await makeErrorRecordStore();
      const store = new TmuxSessionStatusStore();
      const agent: AgentConfig = { ...makeAgent('dev-1'), mode: 'remote', host: 'h1' };
      const configWith = (password: string): BaxianConfig => ({ ...makeConfig([agent]), host: [{ id: 'h1', hostname: 'a.example', user: 'ops', password }] });
      let nowMs = 1_000_000;
      const sessions = scripted([present, present, unreachable, unreachable, unreachable, present]);
      const poller = makePoller({
        store,
        errorRecordStore,
        config: configWith('old'),
        exec: makeExec({ classify: shellPane, hasSession: () => sessions('') }),
        failureThreshold: 2,
        now: () => nowMs,
      });
      await poller.pollOnce();
      nowMs += GRACE;
      await poller.pollOnce();
      const exitedId = store.get('dev-1').latestError?.id;
      expect(store.get('dev-1').reason).toBe('RUNTIME_EXITED');
      nowMs += 10_000;
      await poller.pollOnce();
      expect(store.get('dev-1').reason).toBe('RUNTIME_EXITED');

      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const realAppend = errorRecordStore.append.bind(errorRecordStore);
      vi.spyOn(errorRecordStore, 'append').mockImplementationOnce(async (input) => { await gate; return realAppend(input); });
      const inFlight = poller.pollOnce();
      await new Promise(resolve => setImmediate(resolve));
      poller.replaceConfig(configWith('new'));
      release();
      await inFlight;
      expect(store.get('dev-1')).toMatchObject({ tmuxSessionStatus: 'present', reason: 'RUNTIME_EXITED' });
      expect(store.get('dev-1').latestError?.id).toBe(exitedId);

      nowMs += 10_000;
      await poller.pollOnce();
      expect(store.get('dev-1')).toMatchObject({ tmuxSessionStatus: 'present', reason: 'RUNTIME_EXITED' });

      nowMs += 10_000;
      await poller.pollOnce();
      expect(store.get('dev-1').reason).toBe('RUNTIME_EXITED');
      expect(store.get('dev-1').latestError?.id).toBe(exitedId);
    });

    it('a password rotation restarts the consecutive unreachable count: one old-connection failure plus one new-connection failure does not publish', async () => {
      const store = new TmuxSessionStatusStore();
      const agent: AgentConfig = { ...makeAgent('dev-1'), mode: 'remote', host: 'h1' };
      const configWith = (password: string): BaxianConfig => ({ ...makeConfig([agent]), host: [{ id: 'h1', hostname: 'a.example', user: 'ops', password }] });
      const poller = makePoller({ store, config: configWith('old'), exec: execForSession(unreachable), failureThreshold: 2 });
      await poller.pollOnce();
      poller.replaceConfig(configWith('new'));
      await poller.pollOnce();
      expect(store.get('dev-1').tmuxSessionStatus).toBe('unknown');
      await poller.pollOnce();
      expect(store.get('dev-1').tmuxSessionStatus).toBe('unreachable');
    });

    it('a host user change restarts the shell streak: another account means another tmux server', async () => {
      const store = new TmuxSessionStatusStore();
      const agent: AgentConfig = { ...makeAgent('dev-1'), mode: 'remote', host: 'h1' };
      const configAs = (user: string): BaxianConfig => ({ ...makeConfig([agent]), host: [{ id: 'h1', hostname: 'a.example', user }] });
      let nowMs = 1_000_000;
      const poller = makePoller({ store, config: configAs('ops'), exec: makeExec({ classify: shellPane }), failureThreshold: 2, now: () => nowMs });
      await poller.pollOnce();
      poller.replaceConfig(configAs('deploy'));
      expect(store.get('dev-1').tmuxSessionStatus).toBe('unknown');
      nowMs += GRACE;
      await poller.pollOnce();
      expect(store.get('dev-1').reason).toBeUndefined();
      nowMs += GRACE;
      await poller.pollOnce();
      expect(store.get('dev-1').reason).toBe('RUNTIME_EXITED');
    });

    it('a host whose connection target changed under the same host id restarts the shell streak', async () => {
      const store = new TmuxSessionStatusStore();
      const agent: AgentConfig = { ...makeAgent('dev-1'), mode: 'remote', host: 'h1' };
      const configOn = (hostname: string): BaxianConfig => ({ ...makeConfig([agent]), host: [{ id: 'h1', hostname }] });
      let nowMs = 1_000_000;
      const poller = makePoller({
        store,
        config: configOn('a.example'),
        exec: makeExec({ classify: shellPane }),
        failureThreshold: 2,
        now: () => nowMs,
      });
      await poller.pollOnce();
      poller.replaceConfig(configOn('b.example'));
      nowMs += GRACE;
      await poller.pollOnce();
      expect(store.get('dev-1').reason).toBeUndefined();
      nowMs += GRACE;
      await poller.pollOnce();
      expect(store.get('dev-1').reason).toBe('RUNTIME_EXITED');
    });

    it('a generation change during the present-session observation halts the stale probe: no reconcile, no commit, no purge', async () => {
      const store = new TmuxSessionStatusStore();
      const agent = makeAgent('dev-1');
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let gated = true;
      const reconciled: string[] = [];
      const poller = new TmuxProbePoller({
        config: makeConfig([agent]),
        store,
        agentManager: {
          getAgentState: async () => null,
          reconcileFailedAgent: async (id: string) => { reconciled.push(id); return true; },
        } as unknown as import('../../src/agent/manager.js').AgentManager,
        runnerFactory: () => ({
          exec: makeExec({ sessionSnapshot: async () => { if (gated) await gate; return text(''); } }),
        } as unknown as CommandRunner),
        failureThreshold: 2,
      });
      const inFlight = poller.pollOnce();
      await new Promise(resolve => setImmediate(resolve));
      poller.replaceConfig(makeConfig([{ ...agent, runtime: 'codex' }]));
      gated = false;
      release();
      await inFlight;

      expect(reconciled).toEqual([]);
      expect(store.get('dev-1').tmuxSessionStatus).toBe('unknown');
    });

    it('an absent probe whose reconcile is still in flight when the generation changes hands the manager a stillCurrent guard that reads false', async () => {
      const store = new TmuxSessionStatusStore();
      const agent = makeAgent('dev-1');
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const guardAtWrite: boolean[] = [];
      const poller = new TmuxProbePoller({
        config: makeConfig([agent]),
        store,
        agentManager: {
          getAgentState: async () => null,
          reconcileFailedAgent: async (_id: string, opts?: { stillCurrent?: () => boolean }) => {
            await gate;
            guardAtWrite.push(opts?.stillCurrent?.() ?? true);
            return true;
          },
        } as unknown as import('../../src/agent/manager.js').AgentManager,
        runnerFactory: () => ({ exec: makeExec({ hasSession: absent }) } as unknown as CommandRunner),
        failureThreshold: 2,
      });
      const inFlight = poller.pollOnce();
      await new Promise(resolve => setImmediate(resolve));
      expect(store.get('dev-1').tmuxSessionStatus).toBe('absent');
      poller.replaceConfig(makeConfig([{ ...agent, runtime: 'codex' }]));
      release();
      await inFlight;

      expect(guardAtWrite).toEqual([false]);
      expect(store.get('dev-1').tmuxSessionStatus).toBe('unknown');
    });

    it('the stillCurrent guard reads true for a reconcile that finishes under the same generation', async () => {
      const store = new TmuxSessionStatusStore();
      const agent = makeAgent('dev-1');
      const guardAtWrite: boolean[] = [];
      const poller = new TmuxProbePoller({
        config: makeConfig([agent]),
        store,
        agentManager: {
          getAgentState: async () => null,
          reconcileFailedAgent: async (_id: string, opts?: { stillCurrent?: () => boolean }) => {
            poller.replaceConfig(makeConfig([{ ...agent }]));
            guardAtWrite.push(opts?.stillCurrent?.() ?? false);
            return true;
          },
        } as unknown as import('../../src/agent/manager.js').AgentManager,
        runnerFactory: () => ({ exec: makeExec({ hasSession: absent }) } as unknown as CommandRunner),
        failureThreshold: 2,
      });
      await poller.pollOnce();
      expect(guardAtWrite).toEqual([true]);
      expect(store.get('dev-1').tmuxSessionStatus).toBe('absent');
    });

    it("a stale probe released after a generation change does not seed the new generation's shell streak", async () => {
      const store = new TmuxSessionStatusStore();
      const agent = makeAgent('dev-1');
      let nowMs = 1_000_000;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let gated = true;
      const poller = makePoller({
        store,
        config: makeConfig([agent]),
        exec: makeExec({
          classify: shellPane,
          sessionSnapshot: async (cmd: string) => { if (gated) await gate; return defaultSessionSnapshot(cmd); },
        }),
        failureThreshold: 2,
        now: () => nowMs,
      });
      const inFlight = poller.pollOnce();
      await new Promise(resolve => setImmediate(resolve));
      poller.replaceConfig(makeConfig([{ ...agent, runtime: 'codex' }]));
      gated = false;
      release();
      await inFlight;
      expect(store.get('dev-1').tmuxSessionStatus).toBe('unknown');

      nowMs += GRACE;
      await poller.pollOnce();
      expect(store.get('dev-1').reason).toBeUndefined();
      nowMs += GRACE;
      await poller.pollOnce();
      expect(store.get('dev-1').reason).toBe('RUNTIME_EXITED');
    });

    it('a transient pane-probe failure keeps the published RUNTIME_EXITED and its record; the next shell sighting appends nothing', async () => {
      const errorRecordStore = await makeErrorRecordStore();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let listPanesResult: ExecResult = oneClaudePane;
      let firstErrorId: string | undefined;
      const stillExited = (s: TmuxSessionStatusStore): void => {
        expect(s.get('dev-1')).toMatchObject({ tmuxSessionStatus: 'present', paneState: 'shell', runtimeStatusHint: 'error', reason: 'RUNTIME_EXITED' });
        expect(s.get('dev-1').latestError?.id).toBe(firstErrorId);
      };
      await runProbeScenario({
        errorRecordStore,
        exec: makeExec({ classify: shellPane, listPanes: () => listPanesResult }),
        failureThreshold: 2,
        steps: [
          {},
          {
            advance: GRACE,
            then: (s) => {
              expect(s.get('dev-1').reason).toBe('RUNTIME_EXITED');
              firstErrorId = s.get('dev-1').latestError?.id;
              expect(firstErrorId).toBeTruthy();
            },
          },
          { set: () => { listPanesResult = text('%1 claude\n%2 zsh\n'); }, advance: 10_000, then: stillExited },
          { set: () => { listPanesResult = oneClaudePane; }, advance: 10_000, then: stillExited },
        ],
      });
      expect((await errorRecordStore.latestForAgent('dev-1'))?.id).toBe(firstErrorId);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('pane probe failed (1/2); keeping RUNTIME_EXITED'), expect.anything());
      warnSpy.mockRestore();
    });

    it('pane-probe failures reaching failureThreshold replace RUNTIME_EXITED with PANE_PROBE_FAILED; the shell is then re-confirmed with a fresh record', async () => {
      const errorRecordStore = await makeErrorRecordStore();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      let listPanesResult: ExecResult = oneClaudePane;
      let firstErrorId: string | undefined;
      await runProbeScenario({
        errorRecordStore,
        exec: makeExec({ classify: shellPane, listPanes: () => listPanesResult }),
        failureThreshold: 2,
        steps: [
          {},
          { advance: GRACE, then: (s) => { firstErrorId = s.get('dev-1').latestError?.id; expect(s.get('dev-1').reason).toBe('RUNTIME_EXITED'); } },
          { set: () => { listPanesResult = text('%1 claude\n%2 zsh\n'); }, advance: 10_000, then: (s) => expect(s.get('dev-1').reason).toBe('RUNTIME_EXITED') },
          {
            advance: 10_000,
            then: (s) => {
              expect(s.get('dev-1')).toMatchObject({ runtimeStatusHint: 'error', reason: 'PANE_PROBE_FAILED' });
              expect(s.get('dev-1').paneState).toBeUndefined();
              expect(s.get('dev-1').latestError?.reason).toBe('PANE_PROBE_FAILED');
            },
          },
          { set: () => { listPanesResult = oneClaudePane; }, advance: 10_000, then: (s) => expect(s.get('dev-1').reason).toBeUndefined() },
          {
            advance: GRACE,
            then: (s) => {
              expect(s.get('dev-1').reason).toBe('RUNTIME_EXITED');
              expect(s.get('dev-1').latestError?.id).toBeTruthy();
              expect(s.get('dev-1').latestError?.id).not.toBe(firstErrorId);
            },
          },
        ],
      });
      vi.restoreAllMocks();
    });

    it('a live-runtime foreground refutes RUNTIME_EXITED even when the screen capture keeps failing afterwards: PANE_PROBE_FAILED, never the stale exit', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      let scenario: 'shell' | 'live-broken-capture' | 'live' = 'shell';
      await runProbeScenario({
        exec: makeExec({
          classify: () => (scenario === 'shell' ? shellPane : liveRuntimePane),
          capturePane: async () => {
            if (scenario === 'live-broken-capture') throw new Error('capture-pane: ssh channel closed');
            return readyCapture;
          },
        }),
        failureThreshold: 2,
        steps: [
          {},
          { advance: GRACE, then: (s) => expect(s.get('dev-1').reason).toBe('RUNTIME_EXITED') },
          {
            set: () => { scenario = 'live-broken-capture'; },
            advance: 10_000,
            then: (s) => {
              expect(s.get('dev-1').reason).toBe('PANE_PROBE_FAILED');
              expect(s.get('dev-1').paneState).toBeUndefined();
            },
          },
          { advance: 10_000, then: (s) => expect(s.get('dev-1').reason).toBe('PANE_PROBE_FAILED') },
          { advance: 10_000, then: (s) => expect(s.get('dev-1').reason).toBe('PANE_PROBE_FAILED') },
          { set: () => { scenario = 'live'; }, advance: 10_000 },
        ],
        expectClear: true,
      });
      vi.restoreAllMocks();
    });

    it('a pane-probe failure with no confirmed RUNTIME_EXITED still publishes PANE_PROBE_FAILED at once and drops the candidate streak', async () => {
      let listPanesResult: ExecResult = oneClaudePane;
      await runProbeScenario({
        exec: makeExec({ classify: shellPane, listPanes: () => listPanesResult }),
        failureThreshold: 2,
        steps: [
          { then: (s) => expect(s.get('dev-1').paneState).toBe('shell') },
          { set: () => { listPanesResult = text('%1 claude\n%2 zsh\n'); }, advance: 10_000, then: (s) => expect(s.get('dev-1').reason).toBe('PANE_PROBE_FAILED') },
          { set: () => { listPanesResult = oneClaudePane; }, advance: GRACE, then: (s) => expect(s.get('dev-1').reason).toBeUndefined() },
          { advance: GRACE, then: (s) => expect(s.get('dev-1').reason).toBe('RUNTIME_EXITED') },
        ],
      });
    });

    it('RUNTIME_EXITED → published unreachable → shell again re-confirms with a fresh record; reason and latestError never disagree', async () => {
      const errorRecordStore = await makeErrorRecordStore();
      let firstErrorId: string | undefined;
      const consistent = (s: TmuxSessionStatusStore): void => {
        const observed = s.get('dev-1');
        if (observed.reason) expect(observed.latestError?.reason).toBe(observed.reason);
      };
      await runProbeScenario({
        errorRecordStore,
        exec: makeExec({
          hasSession: scripted([present, present, unreachable, unreachable, present, present]),
          classify: shellPane,
        }),
        failureThreshold: 2,
        steps: [
          {},
          {
            advance: GRACE,
            then: (s) => {
              expect(s.get('dev-1').reason).toBe('RUNTIME_EXITED');
              firstErrorId = s.get('dev-1').latestError?.id;
              expect(firstErrorId).toBeTruthy();
              consistent(s);
            },
          },
          { advance: 10_000, then: (s) => { expect(s.get('dev-1').reason).toBe('RUNTIME_EXITED'); consistent(s); } },
          {
            advance: 10_000,
            then: (s) => {
              expect(s.get('dev-1').tmuxSessionStatus).toBe('unreachable');
              expect(s.get('dev-1').reason).toBeUndefined();
              expect(s.get('dev-1').latestError?.reason).toBe('TMUX_UNREACHABLE');
            },
          },
          {
            advance: 10_000,
            then: (s) => {
              expect(s.get('dev-1').tmuxSessionStatus).toBe('present');
              expect(s.get('dev-1').reason).toBeUndefined();
              consistent(s);
            },
          },
          {
            advance: GRACE,
            then: (s) => {
              expect(s.get('dev-1').reason).toBe('RUNTIME_EXITED');
              expect(s.get('dev-1').latestError?.reason).toBe('RUNTIME_EXITED');
              expect(s.get('dev-1').latestError?.id).not.toBe(firstErrorId);
            },
          },
        ],
      });
    });

    it('shell×2 → live/transcript(skip) → shell×2 records a second, distinct RUNTIME_EXITED error', async () => {
      const errorRecordStore = await makeErrorRecordStore();
      let scenario: 'live' | 'shell' = 'shell';
      let firstErrorId: string | undefined;
      await runProbeScenario({
        errorRecordStore,
        exec: makeExec({
          classify: () => (scenario === 'shell' ? shellPane : liveRuntimePane),
          capturePane: transcriptCapture,
        }),
        failureThreshold: 2,
        steps: [
          {},
          {
            advance: GRACE,
            then: (s) => {
              firstErrorId = s.get('dev-1').latestError?.id;
              expect(firstErrorId).toBeTruthy();
            },
          },
          { set: () => { scenario = 'live'; }, then: (s) => expect(s.get('dev-1').latestError).toBeUndefined() },
          { set: () => { scenario = 'shell'; } },
          {
            advance: GRACE,
            then: (s) => {
              expect(s.get('dev-1').reason).toBe('RUNTIME_EXITED');
              expect(s.get('dev-1').latestError?.id).toBeTruthy();
              expect(s.get('dev-1').latestError?.id).not.toBe(firstErrorId);
            },
          },
        ],
      });
    });

    it('clears RUNTIME_EXITED once the runtime is back in the foreground', async () => {
      let scenario: 'live' | 'shell' = 'shell';
      await runProbeScenario({
        exec: makeExec({ classify: () => (scenario === 'shell' ? shellPane : liveRuntimePane) }),
        failureThreshold: 2,
        steps: [
          {},
          { advance: GRACE, then: (s) => expect(s.get('dev-1').reason).toBe('RUNTIME_EXITED') },
          { set: () => { scenario = 'live'; } },
        ],
        expectClear: true,
      });
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

    it('codex sparkle-only repaints (single-dot braille) do not reset the idle timer', async () => {
      const codexAgent: AgentConfig = { ...makeAgent('qa-1'), runtime: 'codex', role: 'qa' };
      await runProbeScenario({
        agents: [codexAgent],
        agentId: 'qa-1',
        binding: { taskId: 'task-001' },
        exec: makeExec({
          listPanes: codexPane,
          classify: codexRuntimePane,
          capturePane: scripted([text('› \n⠁  ⠂'), text('› \n ⠄⠈ ')]),
          paneTitle: text('Codex | repo'),
        }),
        steps: [{}, { advance: FIVE_MIN + 1 }],
        expectMatch: { runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' },
      });
    });

    it('codex transcript output that only changes among single-dot braille still resets the idle timer', async () => {
      const codexAgent: AgentConfig = { ...makeAgent('qa-1'), runtime: 'codex', role: 'qa' };
      await runProbeScenario({
        agents: [codexAgent],
        agentId: 'qa-1',
        binding: { taskId: 'task-001' },
        exec: makeExec({
          listPanes: codexPane,
          classify: codexRuntimePane,
          capturePane: scripted([
            text('Braille progress: ⠁\n› '),
            text('Braille progress: ⠂\n› '),
            text('Braille progress: ⠄\n› '),
          ]),
          paneTitle: text('Retry | repo'),
        }),
        steps: [{}, { advance: 4 * 60 * 1000 }, { advance: 4 * 60 * 1000 }],
        expectClear: true,
      });
    });

    it('codex output under a history › (composer off screen) that changes only among single-dot braille still resets the idle timer', async () => {
      const codexAgent: AgentConfig = { ...makeAgent('qa-1'), runtime: 'codex', role: 'qa' };
      await runProbeScenario({
        agents: [codexAgent],
        agentId: 'qa-1',
        binding: { taskId: 'task-001' },
        exec: makeExec({
          listPanes: codexPane,
          classify: codexRuntimePane,
          capturePane: scripted([
            text('› run the command\n• Ran progress\n  └ Braille progress: ⠁'),
            text('› run the command\n• Ran progress\n  └ Braille progress: ⠂'),
            text('› run the command\n• Ran progress\n  └ Braille progress: ⠄'),
          ]),
          paneTitle: text('Retry | repo'),
        }),
        steps: [{}, { advance: 4 * 60 * 1000 }, { advance: 4 * 60 * 1000 }],
        expectClear: true,
      });
    });

    it('a viewer resize (idle→idle reflow at a NEW pane width) does NOT reset the PENDING_IDLE grace', async () => {
      const idleReflowed: ExecResult = text('done\n❯ ');
      await runProbeScenario({
        binding: { taskId: 'task-001' },
        exec: makeExec({
          capturePane: scripted([idleCapture, idleCapture, idleReflowed]),
          paneWidth: scripted([text('80'), text('80'), text('120')]),
        }),
        steps: [{}, { advance: FIVE_MIN + 1 }, {}],
        expectMatch: { runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' },
      });
    });

    it('real output that returns to an idle prompt at the SAME width DOES reset the grace', async () => {
      const idleAfterOutput: ExecResult = text('ran tests\nAll green\n❯ ');
      await runProbeScenario({
        binding: { taskId: 'task-001' },
        exec: makeExec({
          capturePane: scripted([idleCapture, idleCapture, idleAfterOutput]),
          paneWidth: text('80'),
        }),
        steps: [{}, { advance: FIVE_MIN + 1 }, {}],
        expectClear: true,
      });
    });

    it('resizing while the short idle capture is byte-identical still lets later real output reset the grace (width cache stays fresh)', async () => {
      const idleAfterOutput: ExecResult = text('ran tests\nAll green\n❯ ');
      await runProbeScenario({
        binding: { taskId: 'task-001' },
        exec: makeExec({
          capturePane: scripted([idleCapture, idleCapture, idleCapture, idleAfterOutput]),
          paneWidth: scripted([text('80'), text('80'), text('120'), text('120')]),
        }),
        steps: [{}, { advance: FIVE_MIN + 1 }, {}, {}],
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
      const shellPane: ExecResult = text('zsh\n$ ');
      let scenario: 'live' | 'shell' = 'live';
      await runProbeScenario({
        binding: { taskId: 'task-001' },
        exec: makeExec({
          classify: () => (scenario === 'live' ? liveRuntimePane : shellPane),
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

    it('herdr flip: a plain esc-to-interrupt line is not a claude working shape → static screen ends as PENDING_IDLE', async () => {
      await runProbeScenario({
        binding: { taskId: 'task-001' },
        exec: makeExec({ capturePane: text('Working on it…\n  esc to interrupt') }),
        steps: [{}, { advance: SIX_MIN }],
        expectMatch: { runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' },
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

    it('a frozen spinner above an idle prompt flags STUCK_BUSY (non-empty spinner window, herdr-style: blanks cannot demote it to idle)', async () => {
      const frozenSpinner: ExecResult = text(['· Wrangling… (24s · esc to interrupt)', ...blank(12), '❯ '].join('\n'));
      await runProbeScenario({
        binding: { taskId: 'task-001' },
        exec: makeExec({ capturePane: frozenSpinner }),
        steps: [{}, { advance: SIX_MIN }],
        expectMatch: { runtimeStatusHint: 'error', reason: 'STUCK_BUSY' },
      });
    });

    it('a busy runtime whose screen keeps changing stays working (live spinner ticks, never stuck)', async () => {
      let secs = 10;
      await runProbeScenario({
        binding: { taskId: 'task-001' },
        exec: makeExec({ capturePane: () => text(`· Working… (${secs}s · esc to interrupt)`) }),
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
        exec: makeExec({ listPanes: codexPane, classify: codexRuntimePane, capturePane: staleWorkingIdle }),
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

    it('working→连续三拍相同 idle 后的 resize/reflow 不重置静止计时', async () => {
      const working: ExecResult = text('✻ Working… (12s · esc to interrupt)');
      const idle: ExecResult = text('done\n❯ ');
      const idleReflowed: ExecResult = text('done ❯ ');
      await runProbeScenario({
        binding: { taskId: 'task-001' },
        exec: makeExec({
          capturePane: scripted([working, idle, idle, idle, idleReflowed]),
          paneWidth: scripted([text('80'), text('80'), text('80'), text('80'), text('120')]),
        }),
        steps: [{}, {}, {}, { advance: FIVE_MIN + 1 }, {}],
        expectMatch: { runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' },
      });
    });

    it('prefers PENDING_HUMAN (menu) over PENDING_IDLE when both could apply', async () => {
      const menuCapture: ExecResult = text('Pick one\nEnter to confirm · Esc to cancel');
      await runProbeScenario({
        binding: { taskId: 'task-001' },
        exec: execScripted([menuCapture, menuCapture]),
        steps: [{}, { advance: 10 * 60 * 1000 }],
        expectMatch: { runtimeStatusHint: 'pending', reason: 'PENDING_HUMAN' },
      });
    });
  });

  it('herdr 非 visible 的 pending 规则仍要发布 pending(claude legacy blocker)', async () => {
    await runProbeScenario({
      exec: makeExec({ capturePane: text('waiting for permission\n') }),
      steps: [{}],
      expectMatch: { runtimeStatusHint: 'pending', reason: 'PENDING_HUMAN' },
    });
  });

  it('herdr 非 visible 的 pending 规则仍要发布 pending(codex weak_blocker)', async () => {
    const codexAgent: AgentConfig = { ...makeAgent('qa-1'), runtime: 'codex', role: 'qa' };
    await runProbeScenario({
      agents: [codexAgent],
      agentId: 'qa-1',
      exec: makeExec({
        listPanes: codexPane,
        classify: codexRuntimePane,
        capturePane: text('do you want to continue? [y/n]\n'),
      }),
      steps: [{}],
      expectMatch: { runtimeStatusHint: 'pending', reason: 'PENDING_HUMAN' },
    });
  });

  const transcriptCapture: ExecResult = text('transcript body\nShowing detailed transcript\nctrl+o to toggle\n↑↓ scroll');

  it('skipStateUpdate rule preserves previous observation (e.g. transcript viewer)', async () => {
    let currentCapture = text('✻ Hatching… (3s · esc to interrupt)');
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
    const runnerFactory = vi.fn(() => makeCommandRunner({ exec }));
    const poller = makePoller({ runnerFactory });

    await poller.pollOnce();

    expect(runnerFactory).toHaveBeenCalledTimes(1);
    expect((exec as ReturnType<typeof vi.fn>).mock.calls.some(([cmd]) => cmd.includes('has-session'))).toBe(true);
    expect((exec as ReturnType<typeof vi.fn>).mock.calls.some(([cmd]) => cmd.includes('list-sessions'))).toBe(true);
    expect((exec as ReturnType<typeof vi.fn>).mock.calls.some(([cmd]) => cmd.includes('list-panes'))).toBe(true);
    expect((exec as ReturnType<typeof vi.fn>).mock.calls.some(([cmd]) => cmd.includes(CLASSIFY_MARKER))).toBe(true);
  });

  it('turns runner construction failures into unreachable observations without aborting the poll', async () => {
    const store = new TmuxSessionStatusStore();
    const runnerFactory = vi.fn((agent: AgentConfig) => {
      if (agent.id === 'dev-1') throw new Error('runner boom');
      return makeCommandRunner({ exec: execForSession(present) });
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
    expect((exec as ReturnType<typeof vi.fn>).mock.calls.some(([cmd]) => cmd.includes(CLASSIFY_MARKER))).toBe(false);
  });

  it('passes timeout to the runner (incl. the present-session snapshot probe) and limits concurrent probes', async () => {
    let active = 0;
    let maxActive = 0;
    const calls: Array<{ cmd: string; timeout: number | undefined }> = [];
    const agents = Array.from({ length: 6 }, (_, i) => makeAgent(`agent-${i}`));
    const poller = makePoller({
      config: makeConfig(agents),
      probeTimeoutMs: 123,
      concurrency: 2,
      runnerFactory: () => makeCommandRunner({
        exec: async (cmd, options) => {
          calls.push({ cmd, timeout: options?.timeout });
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise(resolve => setTimeout(resolve, 1));
          active -= 1;
          if (cmd.includes('list-sessions')) return defaultSessionSnapshot(cmd);
          return present;
        },
      }),
    });

    await poller.pollOnce();

    const boundedCalls = calls.map(c => c.timeout).filter(t => t !== undefined);
    expect(boundedCalls.length).toBeGreaterThanOrEqual(6);
    expect(boundedCalls.every(t => t === 123)).toBe(true);
    expect(maxActive).toBe(2);
    const listSessions = calls.find(c => c.cmd.includes('list-sessions'));
    expect(listSessions?.timeout).toBe(123);
    const listPanes = calls.find(c => c.cmd.includes('list-panes'));
    expect(listPanes?.timeout).toBe(123);
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
      runnerFactory: () => makeCommandRunner({
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

  it('a generation change resets the unreachable failure count, so the new instance is not published unreachable on its first failure', async () => {
    const store = new TmuxSessionStatusStore();
    const agent = makeAgent('dev-1');
    const poller = makePoller({
      store,
      config: makeConfig([agent]),
      exec: makeExec({ hasSession: unreachable }),
      failureThreshold: 2,
    });
    await poller.pollOnce();
    expect(store.get('dev-1').tmuxSessionStatus).toBe('unknown');

    poller.replaceConfig(makeConfig([{ ...agent, runtime: 'codex' }]));
    await poller.pollOnce();
    expect(store.get('dev-1').tmuxSessionStatus).toBe('unknown');
    await poller.pollOnce();
    expect(store.get('dev-1').tmuxSessionStatus).toBe('unreachable');
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
        exec: makeExec({ hasSession: results.get(agent.id)! }),
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
      host: [],
      project: [{ id: 'proj', repo: 'https://github.com/user/repo.git', merge: null, agent: [[ag1]] }],
    };
    const exec = vi.fn(async () => present);
    const poller = makePoller({
      config: baseConfig,
      store,
      runnerFactory: () => makeCommandRunner({ exec }),
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
      host: [],
      project: [{ id: 'proj', repo: 'https://github.com/user/repo.git', merge: null, agent: [[makeAgent('dev-1')]] }],
    };
    const poller = makePoller({
      config: baseConfig,
      store,
      runnerFactory: () => makeCommandRunner({ exec: vi.fn(async () => present) }),
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
      host: [],
      project: [{ id: 'proj', repo: 'https://github.com/user/repo.git', merge: null, agent: [[makeAgent('dev-1')]] }],
    };
    const poller = makePoller({
      config: customConfig,
      store,
      runnerFactory: () => makeCommandRunner({ exec: vi.fn(async () => present) }),
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
      host: [],
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
    expect(store.get('dev-1')).toMatchObject({
      observedAt: 't3',
      stateChangedAt: 't1',
    });
  });

  it('fires when tmux status changes', () => {
    const store = new TmuxSessionStatusStore();
    const fired: Array<['set' | 'delete', string]> = [];
    store.onChange((kind, id) => fired.push([kind, id]));
    store.set('dev-1', { tmuxSessionStatus: 'present', observedAt: 't1' });
    store.set('dev-1', { tmuxSessionStatus: 'unreachable', observedAt: 't2', error: 'ssh' });
    expect(fired).toEqual([['set', 'dev-1'], ['set', 'dev-1']]);
    expect(store.get('dev-1').stateChangedAt).toBe('t2');
  });

  it('advances stateChangedAt only when the material stall state changes', () => {
    const store = new TmuxSessionStatusStore();
    store.set('dev-1', {
      tmuxSessionStatus: 'present',
      observedAt: 't1',
      reason: 'PENDING_IDLE',
    });
    store.set('dev-1', {
      tmuxSessionStatus: 'present',
      observedAt: 't2',
      reason: 'PENDING_IDLE',
    });
    expect(store.get('dev-1').stateChangedAt).toBe('t1');

    store.set('dev-1', {
      tmuxSessionStatus: 'present',
      observedAt: 't3',
      reason: 'AUTH_REQUIRED',
    });
    expect(store.get('dev-1').stateChangedAt).toBe('t3');
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
  it('calls reconcileFailedAgent on absent and on present-but-foreign, not on healthy/unreachable', async () => {
    const agents = ['dev-1', 'dev-2', 'dev-3', 'dev-4', 'dev-5'].map(makeAgent);
    const cfg = makeConfig(agents);
    const calls: string[] = [];
    const stubAgentManager = {
      getAgentState: async () => null,
      reconcileFailedAgent: async (id: string) => { calls.push(id); return true; },
    } as unknown as import('../../src/agent/manager.js').AgentManager;

    const foreignSnapshot = text(`${SESSION_REF_LINE}|not-dev-5\n`);
    const execByAgent: Record<string, CommandRunner['exec']> = {
      'dev-1': makeExec(),
      'dev-2': makeExec({ hasSession: absent }),
      'dev-3': makeExec({ hasSession: unreachable }),
      'dev-4': makeExec({ hasSession: present, sessionSnapshot: text('') }),
      'dev-5': makeExec({ hasSession: present, sessionSnapshot: foreignSnapshot }),
    };

    const poller = new TmuxProbePoller({
      config: cfg,
      store: new TmuxSessionStatusStore(),
      agentManager: stubAgentManager,
      concurrency: 1,
      runnerFactory: agent => ({
        exec: execByAgent[agent.id],
        writeFile: async () => {},
      } as unknown as CommandRunner),
    });
    await poller.pollOnce();

    expect(calls.sort()).toEqual(['dev-2', 'dev-4', 'dev-5']);
  });
});
