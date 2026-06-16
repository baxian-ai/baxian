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

function execForSession(result: ExecResult): CommandRunner['exec'] {
  return vi.fn(async (cmd: string) => {
    if (cmd.includes('has-session')) return result;
    if (cmd.includes('list-panes')) return oneClaudePane;
    if (cmd.includes('___bx-classify-sep___')) return liveRuntimePane;
    if (cmd.includes('capture-pane')) return readyCapture;
    return present;
  });
}

describe('TmuxProbePoller', () => {
  it('updates tmux session status for configured agents', async () => {
    const store = new TmuxSessionStatusStore();
    const config = makeConfig([makeAgent('dev-1'), makeAgent('qa-1')]);
    const results = new Map<string, ExecResult>([
      ['dev-1', present],
      ['qa-1', absent],
    ]);
    const poller = new TmuxProbePoller({
      config,
      store,
      agentManager: noopAgentManager,
      runnerFactory: agent => ({
        exec: execForSession(results.get(agent.id)!),
      }),
    });

    await poller.pollOnce();

    expect(store.get('dev-1').tmuxSessionStatus).toBe('present');
    expect(store.get('dev-1').observedAt).toBeTruthy();
    expect(store.get('qa-1').tmuxSessionStatus).toBe('absent');
  });

  it('marks unreachable after consecutive failed probes and records latest error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'baxian-errors-'));
    await mkdir(join(dir, 'errors'), { recursive: true });
    const errorRecordStore = new ErrorRecordStore(join(dir, 'errors'));
    const store = new TmuxSessionStatusStore();
    const sessionResults = [unreachable, unreachable, present];
    const exec = vi.fn(async (cmd: string) => {
      if (cmd.includes('has-session')) return sessionResults.shift()!;
      if (cmd.includes('list-panes')) return oneClaudePane;
      if (cmd.includes('___bx-classify-sep___')) return liveRuntimePane;
      if (cmd.includes('capture-pane')) return readyCapture;
      return present;
    });
    const runner: CommandRunner = { exec };
    const poller = new TmuxProbePoller({
      config: makeConfig([makeAgent('dev-1')]),
      store,
      agentManager: noopAgentManager,
      errorRecordStore,
      runnerFactory: () => runner,
      failureThreshold: 2,
    });

    await poller.pollOnce();
    expect(store.get('dev-1').tmuxSessionStatus).toBe('unknown');

    await poller.pollOnce();
    expect(store.get('dev-1').tmuxSessionStatus).toBe('unreachable');
    expect(store.get('dev-1').error).toContain('ssh timeout');
    expect(store.get('dev-1').latestError?.reason).toBe('TMUX_UNREACHABLE');

    await poller.pollOnce();
    expect(store.get('dev-1').tmuxSessionStatus).toBe('present');
    expect(store.get('dev-1').error).toBeUndefined();
    expect(await errorRecordStore.latestForAgent('dev-1')).toMatchObject({
      agentId: 'dev-1',
      reason: 'TMUX_UNREACHABLE',
    });
  });

  it('classifies interactive runtime menus as pending observations with error-record context', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'baxian-errors-'));
    await mkdir(join(dir, 'errors'), { recursive: true });
    const errorRecordStore = new ErrorRecordStore(join(dir, 'errors'));
    const store = new TmuxSessionStatusStore();
    const exec = vi.fn(async (cmd: string) => {
      if (cmd.includes('has-session')) return present;
      if (cmd.includes('list-panes')) return oneClaudePane;
      if (cmd.includes('___bx-classify-sep___')) return liveRuntimePane;
      if (cmd.includes('capture-pane')) {
        return { stdout: 'Enter to select · ↑/↓ to navigate · Esc to cancel', stderr: '', exitCode: 0 };
      }
      return present;
    });
    const poller = new TmuxProbePoller({
      config: makeConfig([makeAgent('dev-1')]),
      store,
      agentManager: noopAgentManager,
      errorRecordStore,
      runnerFactory: () => ({ exec }),
    });

    await poller.pollOnce();

    expect(store.get('dev-1')).toMatchObject({
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'pending',
      reason: 'PENDING_HUMAN',
    });
    expect(await errorRecordStore.latestForAgent('dev-1')).toMatchObject({
      reason: 'PENDING_HUMAN',
    });
  });

  it('marks busy live runtimes as working observations', async () => {
    const store = new TmuxSessionStatusStore();
    const exec = vi.fn(async (cmd: string) => {
      if (cmd.includes('has-session')) return present;
      if (cmd.includes('list-panes')) return oneClaudePane;
      if (cmd.includes('___bx-classify-sep___')) return liveRuntimePane;
      if (cmd.includes('capture-pane')) {
        return { stdout: 'Hatching...\nEsc to interrupt', stderr: '', exitCode: 0 };
      }
      return present;
    });
    const poller = new TmuxProbePoller({
      config: makeConfig([makeAgent('dev-1')]),
      store,
      agentManager: noopAgentManager,
      runnerFactory: () => ({ exec }),
    });

    await poller.pollOnce();

    expect(store.get('dev-1')).toMatchObject({
      tmuxSessionStatus: 'present',
      paneState: 'live-runtime',
      runtimeStatusHint: 'working',
    });
  });

  it('marks a codex small-pane Working line as a working observation', async () => {
    const store = new TmuxSessionStatusStore();
    const codexAgent: AgentConfig = {
      ...makeAgent('qa-1'),
      runtime: 'codex',
      role: 'qa',
    };
    const exec = vi.fn(async (cmd: string) => {
      if (cmd.includes('has-session')) return present;
      if (cmd.includes('list-panes')) return { stdout: '%1 node\n', stderr: '', exitCode: 0 };
      if (cmd.includes('___bx-classify-sep___')) {
        return { stdout: 'node\n___bx-classify-sep___\n› ', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane')) {
        return { stdout: '• Working (2m 30s • esc to interrup…', stderr: '', exitCode: 0 };
      }
      return present;
    });
    const poller = new TmuxProbePoller({
      config: makeConfig([codexAgent]),
      store,
      agentManager: noopAgentManager,
      runnerFactory: () => ({ exec }),
    });

    await poller.pollOnce();

    expect(store.get('qa-1')).toMatchObject({
      tmuxSessionStatus: 'present',
      paneState: 'live-runtime',
      runtimeStatusHint: 'working',
    });
  });

  it('classifies unsupported foreground processes as unsafe runtime observations', async () => {
    const store = new TmuxSessionStatusStore();
    const exec = vi.fn(async (cmd: string) => {
      if (cmd.includes('has-session')) return present;
      if (cmd.includes('list-panes')) return oneClaudePane;
      if (cmd.includes('___bx-classify-sep___')) {
        return { stdout: 'vim\n___bx-classify-sep___\nediting', stderr: '', exitCode: 0 };
      }
      return present;
    });
    const poller = new TmuxProbePoller({
      config: makeConfig([makeAgent('dev-1')]),
      store,
      agentManager: noopAgentManager,
      runnerFactory: () => ({ exec }),
    });

    await poller.pollOnce();

    expect(store.get('dev-1')).toMatchObject({
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'error',
      reason: 'UNSUPPORTED_FOREGROUND_PROCESS',
    });
  });

  describe('PENDING_IDLE (screen-static-for-5min) detection', () => {
    const idleCapture: ExecResult = { stdout: '❯ ', stderr: '', exitCode: 0 };
    const idleCaptureDifferent: ExecResult = { stdout: '❯ hello', stderr: '', exitCode: 0 };

    function fakeAgentStore(
      bindings: Record<string, { taskId?: string } | null>,
    ) {
      return {
        get: async (id: string) => bindings[id] ?? null,
      } as unknown as import('../../src/state/agent-store.js').AgentStore;
    }

    function execScripted(captures: ExecResult[]) {
      let i = 0;
      return vi.fn(async (cmd: string) => {
        if (cmd.includes('has-session')) return present;
        if (cmd.includes('list-panes')) return oneClaudePane;
        if (cmd.includes('___bx-classify-sep___')) return liveRuntimePane;
        if (cmd.includes('capture-pane')) return captures[Math.min(i++, captures.length - 1)];
        return present;
      });
    }

    it('first probe establishes baseline and does not flag pending', async () => {
      const store = new TmuxSessionStatusStore();
      const poller = new TmuxProbePoller({
        config: makeConfig([makeAgent('dev-1')]),
        store,
        agentManager: noopAgentManager,
        agentStore: fakeAgentStore({ 'dev-1': { taskId: 'task-001' } }),
        runnerFactory: () => ({ exec: execScripted([idleCapture]) }),
        now: () => 1_000_000,
      });

      await poller.pollOnce();

      expect(store.get('dev-1').runtimeStatusHint).toBeUndefined();
      expect(store.get('dev-1').reason).toBeUndefined();
    });

    it('flags PENDING_IDLE after screen is unchanged for > 5 minutes with active taskId', async () => {
      const store = new TmuxSessionStatusStore();
      let nowMs = 1_000_000;
      const poller = new TmuxProbePoller({
        config: makeConfig([makeAgent('dev-1')]),
        store,
        agentManager: noopAgentManager,
        agentStore: fakeAgentStore({ 'dev-1': { taskId: 'task-001' } }),
        runnerFactory: () => ({ exec: execScripted([idleCapture, idleCapture]) }),
        now: () => nowMs,
      });

      await poller.pollOnce();
      nowMs += 5 * 60 * 1000 + 1;
      await poller.pollOnce();

      expect(store.get('dev-1')).toMatchObject({
        runtimeStatusHint: 'pending',
        reason: 'PENDING_IDLE',
      });
    });

    it('screen change resets the idle timer', async () => {
      const store = new TmuxSessionStatusStore();
      let nowMs = 1_000_000;
      const exec = execScripted([idleCapture, idleCaptureDifferent, idleCaptureDifferent]);
      const poller = new TmuxProbePoller({
        config: makeConfig([makeAgent('dev-1')]),
        store,
        agentManager: noopAgentManager,
        agentStore: fakeAgentStore({ 'dev-1': { taskId: 'task-001' } }),
        runnerFactory: () => ({ exec }),
        now: () => nowMs,
      });

      await poller.pollOnce();
      nowMs += 4 * 60 * 1000;
      await poller.pollOnce();
      nowMs += 4 * 60 * 1000;
      await poller.pollOnce();

      expect(store.get('dev-1').runtimeStatusHint).toBeUndefined();
      expect(store.get('dev-1').reason).toBeUndefined();
    });

    it('does not flag pending when binding has no active taskId', async () => {
      const store = new TmuxSessionStatusStore();
      let nowMs = 1_000_000;
      const poller = new TmuxProbePoller({
        config: makeConfig([makeAgent('dev-1')]),
        store,
        agentManager: noopAgentManager,
        agentStore: fakeAgentStore({ 'dev-1': null }),
        runnerFactory: () => ({ exec: execScripted([idleCapture, idleCapture]) }),
        now: () => nowMs,
      });

      await poller.pollOnce();
      nowMs += 6 * 60 * 1000;
      await poller.pollOnce();

      expect(store.get('dev-1').runtimeStatusHint).toBeUndefined();
    });

    it('clears baseline when paneState leaves live-runtime, so re-entry gets a fresh 5-min grace period', async () => {
      const store = new TmuxSessionStatusStore();
      let nowMs = 1_000_000;
      const shellPane: ExecResult = { stdout: 'zsh\n___bx-classify-sep___\n$ ', stderr: '', exitCode: 0 };
      let scenario: 'live' | 'shell' = 'live';
      const exec = vi.fn(async (cmd: string) => {
        if (cmd.includes('has-session')) return present;
        if (cmd.includes('list-panes')) return oneClaudePane;
        if (cmd.includes('___bx-classify-sep___')) return scenario === 'live' ? liveRuntimePane : shellPane;
        if (cmd.includes('capture-pane')) return idleCapture;
        return present;
      });
      const poller = new TmuxProbePoller({
        config: makeConfig([makeAgent('dev-1')]),
        store,
        agentManager: noopAgentManager,
        agentStore: fakeAgentStore({ 'dev-1': { taskId: 'task-001' } }),
        runnerFactory: () => ({ exec }),
        now: () => nowMs,
      });

      await poller.pollOnce();
      scenario = 'shell';
      nowMs += 10 * 60 * 1000;
      await poller.pollOnce();
      scenario = 'live';
      nowMs += 1000;
      await poller.pollOnce();

      expect(store.get('dev-1').runtimeStatusHint).toBeUndefined();
      expect(store.get('dev-1').reason).toBeUndefined();
    });

    it('clears baseline across present → unreachable → present recovery, preventing stale-hash misfire', async () => {
      const store = new TmuxSessionStatusStore();
      let nowMs = 1_000_000;
      let sessionResult: ExecResult = present;
      const exec = vi.fn(async (cmd: string) => {
        if (cmd.includes('has-session')) return sessionResult;
        if (cmd.includes('list-panes')) return oneClaudePane;
        if (cmd.includes('___bx-classify-sep___')) return liveRuntimePane;
        if (cmd.includes('capture-pane')) return idleCapture;
        return present;
      });
      const poller = new TmuxProbePoller({
        config: makeConfig([makeAgent('dev-1')]),
        store,
        agentManager: noopAgentManager,
        agentStore: fakeAgentStore({ 'dev-1': { taskId: 'task-001' } }),
        runnerFactory: () => ({ exec }),
        now: () => nowMs,
        failureThreshold: 1,
      });

      await poller.pollOnce();
      expect(store.get('dev-1').tmuxSessionStatus).toBe('present');

      sessionResult = unreachable;
      nowMs += 10 * 60 * 1000;
      await poller.pollOnce();
      expect(store.get('dev-1').tmuxSessionStatus).toBe('unreachable');

      sessionResult = present;
      nowMs += 1000;
      await poller.pollOnce();

      expect(store.get('dev-1').runtimeStatusHint).toBeUndefined();
      expect(store.get('dev-1').reason).toBeUndefined();
    });

    it('clears baseline when a present-session probe fails (PANE_PROBE_FAILED), so recovery rebuilds it', async () => {
      const store = new TmuxSessionStatusStore();
      let nowMs = 1_000_000;
      let listPanesResult: ExecResult = oneClaudePane;
      const exec = vi.fn(async (cmd: string) => {
        if (cmd.includes('has-session')) return present;
        if (cmd.includes('list-panes')) return listPanesResult;
        if (cmd.includes('___bx-classify-sep___')) return liveRuntimePane;
        if (cmd.includes('capture-pane')) return idleCapture;
        return present;
      });
      const poller = new TmuxProbePoller({
        config: makeConfig([makeAgent('dev-1')]),
        store,
        agentManager: noopAgentManager,
        agentStore: fakeAgentStore({ 'dev-1': { taskId: 'task-001' } }),
        runnerFactory: () => ({ exec }),
        now: () => nowMs,
      });

      await poller.pollOnce();

      listPanesResult = { stdout: '%1 claude\n%2 zsh\n', stderr: '', exitCode: 0 };
      nowMs += 6 * 60 * 1000;
      await poller.pollOnce();
      expect(store.get('dev-1').reason).toBe('PANE_PROBE_FAILED');

      listPanesResult = oneClaudePane;
      nowMs += 1000;
      await poller.pollOnce();

      expect(store.get('dev-1').runtimeStatusHint).toBeUndefined();
      expect(store.get('dev-1').reason).toBeUndefined();
    });

    it('transient unreachable below failure threshold does not reset the idle timer', async () => {
      const store = new TmuxSessionStatusStore();
      let nowMs = 1_000_000;
      let sessionResult: ExecResult = present;
      const exec = vi.fn(async (cmd: string) => {
        if (cmd.includes('has-session')) return sessionResult;
        if (cmd.includes('list-panes')) return oneClaudePane;
        if (cmd.includes('___bx-classify-sep___')) return liveRuntimePane;
        if (cmd.includes('capture-pane')) return idleCapture;
        return present;
      });
      const poller = new TmuxProbePoller({
        config: makeConfig([makeAgent('dev-1')]),
        store,
        agentManager: noopAgentManager,
        agentStore: fakeAgentStore({ 'dev-1': { taskId: 'task-001' } }),
        runnerFactory: () => ({ exec }),
        now: () => nowMs,
        failureThreshold: 2,
      });

      await poller.pollOnce();
      expect(store.get('dev-1').tmuxSessionStatus).toBe('present');

      sessionResult = unreachable;
      nowMs += 1000;
      await poller.pollOnce();
      expect(store.get('dev-1').tmuxSessionStatus).toBe('present');

      sessionResult = present;
      nowMs += 6 * 60 * 1000;
      await poller.pollOnce();

      expect(store.get('dev-1')).toMatchObject({
        runtimeStatusHint: 'pending',
        reason: 'PENDING_IDLE',
      });
    });

    it('flags STUCK_BUSY when a live spinner stays frozen for the grace window', async () => {
      const store = new TmuxSessionStatusStore();
      let nowMs = 1_000_000;
      // A spinner whose elapsed-seconds NEVER advance across polls = a frozen runtime.
      const frozenSpinner: ExecResult = { stdout: '· Wrangling… (42s · esc to interrupt)', stderr: '', exitCode: 0 };
      const exec = vi.fn(async (cmd: string) => {
        if (cmd.includes('has-session')) return present;
        if (cmd.includes('list-panes')) return oneClaudePane;
        if (cmd.includes('___bx-classify-sep___')) return liveRuntimePane;
        if (cmd.includes('capture-pane')) return frozenSpinner;
        return present;
      });
      const poller = new TmuxProbePoller({
        config: makeConfig([makeAgent('dev-1')]),
        store,
        agentManager: noopAgentManager,
        agentStore: fakeAgentStore({ 'dev-1': { taskId: 'task-001' } }),
        runnerFactory: () => ({ exec }),
        now: () => nowMs,
      });

      await poller.pollOnce();
      // First poll: busy but baseline just established → still 'working'.
      expect(store.get('dev-1').runtimeStatusHint).toBe('working');
      nowMs += 6 * 60 * 1000;
      await poller.pollOnce();

      expect(store.get('dev-1')).toMatchObject({
        runtimeStatusHint: 'error',
        reason: 'STUCK_BUSY',
      });
    });

    it('does NOT flag STUCK_BUSY for a static busy screen WITHOUT a live spinner', async () => {
      const store = new TmuxSessionStatusStore();
      let nowMs = 1_000_000;
      // Codex busy screen: static "Working on it… / esc to interrupt", no ticking spinner. Healthy long task.
      const codexBusyStatic: ExecResult = { stdout: 'Working on it…\n  esc to interrupt', stderr: '', exitCode: 0 };
      const exec = vi.fn(async (cmd: string) => {
        if (cmd.includes('has-session')) return present;
        if (cmd.includes('list-panes')) return oneClaudePane;
        if (cmd.includes('___bx-classify-sep___')) return liveRuntimePane;
        if (cmd.includes('capture-pane')) return codexBusyStatic;
        return present;
      });
      const poller = new TmuxProbePoller({
        config: makeConfig([makeAgent('dev-1')]),
        store,
        agentManager: noopAgentManager,
        agentStore: fakeAgentStore({ 'dev-1': { taskId: 'task-001' } }),
        runnerFactory: () => ({ exec }),
        now: () => nowMs,
      });

      await poller.pollOnce();
      nowMs += 6 * 60 * 1000;
      await poller.pollOnce();

      // esc-to-interrupt in tail → 'working'; no live spinner → never STUCK_BUSY even when static.
      expect(store.get('dev-1').runtimeStatusHint).toBe('working');
      expect(store.get('dev-1').reason).toBeUndefined();
    });

    it('a quoted/leftover spinner above an idle prompt is classified as PENDING_IDLE', async () => {
      const store = new TmuxSessionStatusStore();
      let nowMs = 1_000_000;
      // A spinner-shaped line lingers near the top; the active region at the bottom is an idle ready prompt.
      const quotedSpinnerIdle: ExecResult = {
        stdout: ['· Wrangling… (24s)', ...Array(12).fill(''), '❯ '].join('\n'),
        stderr: '',
        exitCode: 0,
      };
      const exec = vi.fn(async (cmd: string) => {
        if (cmd.includes('has-session')) return present;
        if (cmd.includes('list-panes')) return oneClaudePane;
        if (cmd.includes('___bx-classify-sep___')) return liveRuntimePane;
        if (cmd.includes('capture-pane')) return quotedSpinnerIdle;
        return present;
      });
      const poller = new TmuxProbePoller({
        config: makeConfig([makeAgent('dev-1')]),
        store,
        agentManager: noopAgentManager,
        agentStore: fakeAgentStore({ 'dev-1': { taskId: 'task-001' } }),
        runnerFactory: () => ({ exec }),
        now: () => nowMs,
      });

      await poller.pollOnce();
      nowMs += 6 * 60 * 1000;
      await poller.pollOnce();

      // Spinner is only in scrollback (not the active region) and the bottom is an idle prompt → the
      // long-static screen must surface as PENDING_IDLE, not 'working'.
      expect(store.get('dev-1')).toMatchObject({
        runtimeStatusHint: 'pending',
        reason: 'PENDING_IDLE',
      });
    });

    it('a busy runtime whose screen keeps changing stays working (live spinner ticks, never stuck)', async () => {
      const store = new TmuxSessionStatusStore();
      let nowMs = 1_000_000;
      let secs = 10;
      const exec = vi.fn(async (cmd: string) => {
        if (cmd.includes('has-session')) return present;
        if (cmd.includes('list-panes')) return oneClaudePane;
        if (cmd.includes('___bx-classify-sep___')) return liveRuntimePane;
        if (cmd.includes('capture-pane')) {
          return { stdout: `· Working… (${secs} s · esc to interrupt)`, stderr: '', exitCode: 0 };
        }
        return present;
      });
      const poller = new TmuxProbePoller({
        config: makeConfig([makeAgent('dev-1')]),
        store,
        agentManager: noopAgentManager,
        agentStore: fakeAgentStore({ 'dev-1': { taskId: 'task-001' } }),
        runnerFactory: () => ({ exec }),
        now: () => nowMs,
      });

      await poller.pollOnce();
      for (let i = 0; i < 6; i++) {
        nowMs += 90 * 1000;
        secs += 90; // spinner elapsed-seconds advance → screen changes every poll
        await poller.pollOnce();
      }

      expect(store.get('dev-1').runtimeStatusHint).toBe('working');
      expect(store.get('dev-1').reason).toBeUndefined();
    });

    it('stale esc-to-interrupt above a ready prompt is NOT busy → static screen → PENDING_IDLE, not STUCK_BUSY', async () => {
      const store = new TmuxSessionStatusStore();
      let nowMs = 1_000_000;
      // 'esc to interrupt' lingers high in the viewport; the bottom 8 lines are an idle ready prompt.
      const staleAnchor: ExecResult = {
        stdout: 'esc to interrupt\n\n\n\n\n\n\n\n\n❯ ',
        stderr: '',
        exitCode: 0,
      };
      const exec = vi.fn(async (cmd: string) => {
        if (cmd.includes('has-session')) return present;
        if (cmd.includes('list-panes')) return oneClaudePane;
        if (cmd.includes('___bx-classify-sep___')) return liveRuntimePane;
        if (cmd.includes('capture-pane')) return staleAnchor;
        return present;
      });
      const poller = new TmuxProbePoller({
        config: makeConfig([makeAgent('dev-1')]),
        store,
        agentManager: noopAgentManager,
        agentStore: fakeAgentStore({ 'dev-1': { taskId: 'task-001' } }),
        runnerFactory: () => ({ exec }),
        now: () => nowMs,
      });

      await poller.pollOnce();
      nowMs += 6 * 60 * 1000;
      await poller.pollOnce();

      expect(store.get('dev-1')).toMatchObject({
        runtimeStatusHint: 'pending',
        reason: 'PENDING_IDLE',
      });
    });

    it('stale codex Working text above an idle prompt is NOT busy → static screen → PENDING_IDLE', async () => {
      const store = new TmuxSessionStatusStore();
      let nowMs = 1_000_000;
      const codexAgent: AgentConfig = {
        ...makeAgent('qa-1'),
        runtime: 'codex',
        role: 'qa',
      };
      const staleWorkingIdle: ExecResult = {
        stdout: '• Working (2m 30s • esc to interrup…\n\n› ',
        stderr: '',
        exitCode: 0,
      };
      const exec = vi.fn(async (cmd: string) => {
        if (cmd.includes('has-session')) return present;
        if (cmd.includes('list-panes')) return { stdout: '%1 node\n', stderr: '', exitCode: 0 };
        if (cmd.includes('___bx-classify-sep___')) return { stdout: 'node\n___bx-classify-sep___\n› ', stderr: '', exitCode: 0 };
        if (cmd.includes('capture-pane')) return staleWorkingIdle;
        return present;
      });
      const poller = new TmuxProbePoller({
        config: makeConfig([codexAgent]),
        store,
        agentManager: noopAgentManager,
        agentStore: fakeAgentStore({ 'qa-1': { taskId: 'task-001' } }),
        runnerFactory: () => ({ exec }),
        now: () => nowMs,
      });

      await poller.pollOnce();
      nowMs += 6 * 60 * 1000;
      await poller.pollOnce();

      expect(store.get('qa-1')).toMatchObject({
        runtimeStatusHint: 'pending',
        reason: 'PENDING_IDLE',
      });
    });

    it('resets baseline when taskId changes (null → some, or some → other), starting a fresh 5-min grace', async () => {
      const store = new TmuxSessionStatusStore();
      let nowMs = 1_000_000;
      let currentBinding: { taskId: string | null } | null = null;
      const dynamicAgentStore = {
        get: async (_id: string) => currentBinding,
      } as unknown as import('../../src/state/agent-store.js').AgentStore;
      const poller = new TmuxProbePoller({
        config: makeConfig([makeAgent('dev-1')]),
        store,
        agentManager: noopAgentManager,
        agentStore: dynamicAgentStore,
        runnerFactory: () => ({ exec: execScripted([idleCapture]) }),
        now: () => nowMs,
      });

      await poller.pollOnce();
      nowMs += 10 * 60 * 1000;
      await poller.pollOnce();
      expect(store.get('dev-1').runtimeStatusHint).toBeUndefined();

      currentBinding = { taskId: 'task-001' };
      nowMs += 1000;
      await poller.pollOnce();
      expect(store.get('dev-1').runtimeStatusHint).toBeUndefined();
      expect(store.get('dev-1').reason).toBeUndefined();

      nowMs += 6 * 60 * 1000;
      await poller.pollOnce();
      expect(store.get('dev-1')).toMatchObject({
        runtimeStatusHint: 'pending',
        reason: 'PENDING_IDLE',
      });

      currentBinding = { taskId: 'task-002' };
      nowMs += 1000;
      await poller.pollOnce();
      expect(store.get('dev-1').runtimeStatusHint).toBeUndefined();
    });

    it('prefers PENDING_HUMAN (menu) over PENDING_IDLE when both could apply', async () => {
      const store = new TmuxSessionStatusStore();
      let nowMs = 1_000_000;
      const menuCapture: ExecResult = { stdout: 'Pick one\nEnter to select · Esc to cancel', stderr: '', exitCode: 0 };
      const poller = new TmuxProbePoller({
        config: makeConfig([makeAgent('dev-1')]),
        store,
        agentManager: noopAgentManager,
        agentStore: fakeAgentStore({ 'dev-1': { taskId: 'task-001' } }),
        runnerFactory: () => ({ exec: execScripted([menuCapture, menuCapture]) }),
        now: () => nowMs,
      });

      await poller.pollOnce();
      nowMs += 10 * 60 * 1000;
      await poller.pollOnce();

      expect(store.get('dev-1')).toMatchObject({
        runtimeStatusHint: 'pending',
        reason: 'PENDING_HUMAN',
      });
    });
  });

  it('reuses one runner for session presence and present-session observation', async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (cmd.includes('has-session')) return present;
      if (cmd.includes('list-panes')) return oneClaudePane;
      if (cmd.includes('___bx-classify-sep___')) return liveRuntimePane;
      if (cmd.includes('capture-pane')) return readyCapture;
      return present;
    });
    const runnerFactory = vi.fn(() => ({ exec }));
    const poller = new TmuxProbePoller({
      config: makeConfig([makeAgent('dev-1')]),
      store: new TmuxSessionStatusStore(),
      agentManager: noopAgentManager,
      runnerFactory,
    });

    await poller.pollOnce();

    expect(runnerFactory).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls.some(([cmd]) => cmd.includes('has-session'))).toBe(true);
    expect(exec.mock.calls.some(([cmd]) => cmd.includes('list-panes'))).toBe(true);
    expect(exec.mock.calls.some(([cmd]) => cmd.includes('___bx-classify-sep___'))).toBe(true);
  });

  it('turns runner construction failures into unreachable observations without aborting the poll', async () => {
    const store = new TmuxSessionStatusStore();
    const runnerFactory = vi.fn((agent: AgentConfig) => {
      if (agent.id === 'dev-1') throw new Error('runner boom');
      return { exec: execForSession(present) };
    });
    const poller = new TmuxProbePoller({
      config: makeConfig([makeAgent('dev-1'), makeAgent('dev-2')]),
      store,
      agentManager: noopAgentManager,
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
    const dir = await mkdtemp(join(tmpdir(), 'baxian-errors-'));
    await mkdir(join(dir, 'errors'), { recursive: true });
    const errorRecordStore = new ErrorRecordStore(join(dir, 'errors'));
    const store = new TmuxSessionStatusStore();
    const exec = vi.fn(async (cmd: string) => {
      if (cmd.includes('has-session')) return present;
      if (cmd.includes('list-panes')) {
        return { stdout: '%1 claude\n%2 zsh\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('___bx-classify-sep___')) return liveRuntimePane;
      return readyCapture;
    });
    const poller = new TmuxProbePoller({
      config: makeConfig([makeAgent('dev-1')]),
      store,
      agentManager: noopAgentManager,
      errorRecordStore,
      runnerFactory: () => ({ exec }),
    });

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
    expect(exec.mock.calls.some(([cmd]) => cmd.includes('___bx-classify-sep___'))).toBe(false);
  });

  it('passes timeout to the runner and limits concurrent probes', async () => {
    let active = 0;
    let maxActive = 0;
    const timeouts: Array<number | undefined> = [];
    const agents = Array.from({ length: 6 }, (_, i) => makeAgent(`agent-${i}`));
    const poller = new TmuxProbePoller({
      config: makeConfig(agents),
      store: new TmuxSessionStatusStore(),
      agentManager: noopAgentManager,
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
    const poller = new TmuxProbePoller({
      config: makeConfig([makeAgent('dev-1')]),
      store: new TmuxSessionStatusStore(),
      agentManager: noopAgentManager,
      runnerFactory: () => ({ exec }),
      intervalMs: 10_000,
    });

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
    const poller = new TmuxProbePoller({
      config: makeConfig([makeAgent('dev-1')]),
      store: new TmuxSessionStatusStore(),
      agentManager: noopAgentManager,
      runnerFactory: () => ({
        exec: async (cmd: string) => {
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
    const sessionResults = [present, present, absent];
    const exec = vi.fn()
      .mockImplementation(async (cmd: string) => {
        if (cmd.includes('has-session')) {
          const next = sessionResults.shift()!;
          return next;
        }
        if (cmd.includes('list-panes')) return oneClaudePane;
        if (cmd.includes('___bx-classify-sep___')) return liveRuntimePane;
        if (cmd.includes('capture-pane')) return readyCapture;
        return present;
      });
    const poller = new TmuxProbePoller({
      config: makeConfig([makeAgent('dev-1')]),
      store: new TmuxSessionStatusStore(),
      agentManager: noopAgentManager,
      runnerFactory: () => ({ exec }),
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
    const config = makeConfig([ag1, ag2]);
    const results = new Map<string, ExecResult>([
      ['dev-1', unreachable],
      ['dev-2', present],
    ]);
    const poller = new TmuxProbePoller({
      config,
      store,
      agentManager: noopAgentManager,
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
    const poller = new TmuxProbePoller({
      config: makeConfig([ag1]),
      store,
      agentManager: noopAgentManager,
      runnerFactory: () => ({
        exec: vi.fn(async (cmd: string) => {
          if (cmd.includes('has-session')) {
            await hasSessionGate;
            return present;
          }
          if (cmd.includes('list-panes')) return oneClaudePane;
          if (cmd.includes('___bx-classify-sep___')) return liveRuntimePane;
          if (cmd.includes('capture-pane')) return readyCapture;
          return present;
        }),
      }) as unknown as CommandRunner,
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
    // Sanity: prepareConfig produces fresh AgentConfig per pass; this test relies on that invariant.
    expect(oldInstance).not.toBe(newInstance);

    let releaseHasSession!: () => void;
    const hasSessionGate = new Promise<void>((resolve) => { releaseHasSession = resolve; });
    let probedAgent: AgentConfig | null = null;
    const poller = new TmuxProbePoller({
      config: makeConfig([oldInstance]),
      store,
      agentManager: noopAgentManager,
      runnerFactory: agent => {
        probedAgent = agent;
        return {
          exec: vi.fn(async (cmd: string) => {
            if (cmd.includes('has-session')) {
              await hasSessionGate;
              return present;
            }
            if (cmd.includes('list-panes')) return oneClaudePane;
            if (cmd.includes('___bx-classify-sep___')) return liveRuntimePane;
            if (cmd.includes('capture-pane')) return readyCapture;
            return present;
          }),
        } as unknown as CommandRunner;
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
    const poller = new TmuxProbePoller({
      config: baseConfig,
      store,
      agentManager: noopAgentManager,
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
    const poller = new TmuxProbePoller({
      config: baseConfig,
      store,
      agentManager: noopAgentManager,
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
    const poller = new TmuxProbePoller({
      config: customConfig,
      store,
      agentManager: noopAgentManager,
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
    const ag1 = makeAgent('dev-1');
    const poller = new TmuxProbePoller({
      config: makeConfig([ag1]),
      store,
      agentManager: noopAgentManager,
      runnerFactory: () => ({
        exec: vi.fn(async () => unreachable),
      }) as unknown as CommandRunner,
      failureThreshold: 1,
    });
    await poller.pollOnce();
    expect(store.get('dev-1').tmuxSessionStatus).toBe('unreachable');

    poller.purgeAgent('dev-1');
    expect(store.get('dev-1').tmuxSessionStatus).toBe('unknown');
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
