import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentBindingFacts, AgentConfig, BaxianConfig, BaxianEvent, TaskState } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
import type { AgentManagerDeps } from '../../src/agent/manager.js';
import { AgentManager, DispatchTerminalError, EnsureSessionError, canDispatchWithBinding } from '../../src/agent/manager.js';
import { prepareConfig } from '../../src/config/loader.js';
import { ApiError } from '../../src/errors.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';
import { TmuxManager } from '../../src/agent/tmux.js';
import { WorktreeManager } from '../../src/agent/worktree.js';
import { AgentStore } from '../../src/state/agent-store.js';
import { TaskStore } from '../../src/state/task-store.js';
import { LockManager } from '../../src/state/lock.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { SkillRegistry } from '../../src/skill/registry.js';
import { initStateDir } from '../../src/state/init.js';

const NOW = '2026-05-14T05:00:00.000Z';

const CONFIG: BaxianConfig = {
  review: { rounds: 2 },
  server: DEFAULT_SERVER_CONFIG,
  project: [{
    id: 'proj',
    repo: 'user/repo',
    merge: null,
    agent: [[
      { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp/repo' },
      { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local', workdir: '/tmp/repo' },
    ]],
  }],
};

let tempDir: string;
let agentStore: AgentStore;
let taskStore: TaskStore;
let lockManager: LockManager;
let eventBus: EventBus;
let manager: AgentManager;
const events: BaxianEvent[] = [];

function readyRunner(): CommandRunner {
  return {
    exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('display-message') && cmd.includes('pane_current_command')) {
        return { stdout: 'claude\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane')) {
        return { stdout: '⏵⏵ bypass permissions on /tmp/repo\n\n>', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
    writeFile: vi.fn(async (): Promise<void> => undefined),
  };
}

// Runner for cancelTask's real /clear path: answers pane_current_command (runtime) + plain capture-pane
// (idle), and models capturePaneSnapshot so it changes once the pane's /clear Enter lands — the evidence
// clearPaneContext's waitSubmitAck requires (a swallowed Enter would leave the snapshot unchanged).
// Records every send-keys into `sentKeys`. `failClear(pane)` makes that pane's /clear injection fail.
function clearAwareRunner(
  sentKeys: string[],
  paneInfo: (pane: string) => { proc: string; idle: string },
  opts: { failClear?: (pane: string) => boolean; swallowClearEnters?: number; rejectClear?: (pane: string) => boolean } = {},
): CommandRunner {
  const clearTyped = new Set<string>();
  const rejected = new Set<string>();
  const swallowed = new Map<string, number>();
  const paneOf = (cmd: string): string => cmd.match(/%\d+/)?.[0] ?? '';
  return {
    exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('send-keys')) {
        sentKeys.push(cmd);
        const pane = paneOf(cmd);
        if (cmd.includes('send-keys -l') && cmd.includes('/clear')) {
          if (opts.failClear?.(pane)) return { stdout: '', stderr: 'tmux send failed', exitCode: 1 };
          clearTyped.add(pane);
        } else if (cmd.includes("'Enter'") && clearTyped.has(pane)) {
          const n = swallowed.get(pane) ?? 0;
          // Simulate a swallowed Enter: the composer keeps /clear until a resend lands.
          if (n < (opts.swallowClearEnters ?? 0)) swallowed.set(pane, n + 1);
          else { clearTyped.delete(pane); if (opts.rejectClear?.(pane)) rejected.add(pane); }
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      const pane = paneOf(cmd);
      const info = paneInfo(pane);
      if (cmd.includes('display-message') && cmd.includes('pane_current_command')) {
        return { stdout: `${info.proc}\n`, stderr: '', exitCode: 0 };
      }
      // info.idle ends at the prompt marker; a typed-but-unsubmitted /clear renders on that prompt line; a
      // submitted-but-rejected /clear shows the runtime's "disabled while a task is in progress" toast above it.
      const frame = rejected.has(pane)
        ? `■ '/clear' is disabled while a task is in progress.\n${info.idle}`
        : clearTyped.has(pane) ? `${info.idle} /clear` : info.idle;
      // capturePaneSnapshot: `capture-pane -e -p && printf SEP && display-message history_size`.
      if (cmd.includes('capture-pane') && cmd.includes('history_size')) {
        return { stdout: `${frame}\n___bx-snap-sep___\n0\n`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane')) {
        return { stdout: frame, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
    writeFile: vi.fn(async (): Promise<void> => undefined),
  } as unknown as CommandRunner;
}

const CLAUDE_PANE = { proc: 'claude', idle: '⏵⏵ bypass permissions on /tmp/repo\n\n>' };
const CODEX_PANE = { proc: 'codex', idle: 'permissions: YOLO mode\n\n>' };

// Runner for the post-merge happy path: idle at rest, then BUSY for a few captures right after EACH
// submitted Enter (the cleanup prompt's Enter and the /clear's Enter), then idle again — so the
// background flow sees, for both submissions, a real idle → submit → busy → idle cycle and releases
// the agent. `onExec` lets a test observe state per command; `busyCaptures` tunes the busy window.
function compactRunner(
  execs: string[],
  onExec?: (cmd: string) => void | Promise<void>,
  busyCaptures = 3,
): CommandRunner {
  const BUSY = '⏵⏵ bypass permissions on /tmp/repo\n\n· Compacting… (3s)\n  esc to interrupt\n';
  const IDLE = '⏵⏵ bypass permissions on /tmp/repo\n\n>';
  let busyLeft = 0;
  return {
    exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
      execs.push(cmd);
      if (onExec) await onExec(cmd);
      // Every submitted Enter (cleanup prompt + /clear) kicks off a busy window.
      if (cmd.includes('send-keys') && cmd.includes("'Enter'")) busyLeft = busyCaptures;
      if (cmd.includes('display-message') && cmd.includes('pane_current_command')) {
        return { stdout: 'claude\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane')) {
        let frame = IDLE;
        if (busyLeft > 0) { busyLeft--; frame = BUSY; }
        // capturePaneSnapshot bundles capture-pane + separator + history_size into one exec.
        if (cmd.includes('history_size')) return { stdout: `${frame}\n___bx-snap-sep___\n0`, stderr: '', exitCode: 0 };
        return { stdout: frame, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
    writeFile: vi.fn(async (): Promise<void> => undefined),
  } as unknown as CommandRunner;
}

function smallPaneClaudeCompactRunner(execs: string[]): CommandRunner {
  const BUSY = '✽ Grooving… (5m 21s · thinking)\n';
  const IDLE = '✻ Worked for 31s\n\n❯ \n';
  let busyLeft = 0;
  return {
    exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
      execs.push(cmd);
      if (cmd.includes('send-keys') && cmd.includes("'Enter'")) busyLeft = 2;
      if (cmd.includes('display-message') && cmd.includes('pane_current_command')) {
        return { stdout: 'claude\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane')) {
        let frame = IDLE;
        if (busyLeft > 0) { busyLeft--; frame = BUSY; }
        // capturePaneSnapshot bundles capture-pane + separator + history_size into one exec.
        if (cmd.includes('history_size')) return { stdout: `${frame}\n___bx-snap-sep___\n0`, stderr: '', exitCode: 0 };
        return { stdout: frame, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
    writeFile: vi.fn(async (): Promise<void> => undefined),
  } as unknown as CommandRunner;
}

function task(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'task-1',
    projectId: 'proj',
    title: 'T',
    description: 'D',
    preferredAgentId: 'dev-1',
    agentId: 'dev-1',
    branch: 'bx/task-1',
    reviewRound: 0,
    status: 'in_progress',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// Build an AgentManager over the module-level stores, overriding only what a test cares about.
// Mirrors the production wiring in beforeEach but lets each test swap runner/skillRegistry/etc.
function makeManager(overrides: Partial<AgentManagerDeps> = {}): AgentManager {
  return new AgentManager({
    config: CONFIG,
    agentStore,
    taskStore,
    lockManager,
    eventBus,
    runnerFactory: () => readyRunner(),
    ...overrides,
  });
}

// CommandRunner that records every exec'd command into `execs` and otherwise stays inert
// (empty stdout / exit 0). `onExec` lets a test react per command.
function recordingRunner(
  execs: string[],
  onExec?: (cmd: string) => void | Promise<void>,
): CommandRunner {
  return {
    exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
      execs.push(cmd);
      if (onExec) await onExec(cmd);
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
    writeFile: vi.fn(async (): Promise<void> => undefined),
  } as unknown as CommandRunner;
}

function setCompactTiming(mgr: AgentManager, waitMs = 100, pollMs = 10): void {
  Object.assign(mgr, { compactIdleWaitMs: waitMs, compactIdlePollMs: pollMs, clearContextWaitMs: waitMs });
}

// Spy the private interruptPaneAndWaitReady (a 10s real wait) to a fixed outcome; returns the spy so
// callers can assert call counts.
function mockInterruptPane(mgr: AgentManager, ok: boolean): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(mgr as unknown as { interruptPaneAndWaitReady: () => Promise<boolean> }, 'interruptPaneAndWaitReady')
    .mockResolvedValue(ok) as ReturnType<typeof vi.spyOn>;
}

// clearPaneContext runs a real /clear + busy→idle wait; stub it (confirmed=true) for cancel tests that
// mock the interrupt and only assert release/binding, so a runtime-mismatched runner can't hang the test.
function stubClearPane(mgr: AgentManager, confirmed = true): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(mgr as unknown as { clearPaneContext: () => Promise<boolean> }, 'clearPaneContext')
    .mockResolvedValue(confirmed) as ReturnType<typeof vi.spyOn>;
}

function freshRegistry(): SkillRegistry {
  return new SkillRegistry(join(tempDir, 'skills'));
}

// Manager wired for the injectAndAwaitAck tests: a fresh registry plus tunable ack/settle timeouts.
function makeInjectManager(runner: CommandRunner, ackMs: number, settleMs: number): AgentManager {
  return makeManager({
    skillRegistry: freshRegistry(),
    runnerFactory: () => runner,
    dispatchAckTimeoutMs: ackMs,
    dispatchSettleTimeoutMs: settleMs,
  });
}

type AckResult = { acked: boolean; composerDelivered?: boolean };

// injectAndAwaitAck is private; call it through one typed cast instead of repeating the cast per test.
function callInjectAndAwaitAck(
  mgr: AgentManager,
  tmux: TmuxManager,
  paneId: string,
  prompt: string,
  agentId: string,
  runtime: 'claude-code' | 'codex',
): Promise<AckResult> {
  return (mgr as unknown as {
    injectAndAwaitAck: (
      tmux: TmuxManager, paneId: string, prompt: string, agentId: string, runtime: 'claude-code' | 'codex',
    ) => Promise<AckResult>;
  }).injectAndAwaitAck(tmux, paneId, prompt, agentId, runtime);
}

// Write an agent binding with the common defaults (projectId 'proj', updatedAt NOW).
function seedAgent(overrides: Partial<AgentBindingFacts> & { id: string }): Promise<void> {
  return agentStore.set({ projectId: 'proj', updatedAt: NOW, ...overrides });
}

// Persist a task fixture and hand it back so callers can read its id/fields.
async function seedTask(overrides: Partial<TaskState> = {}): Promise<TaskState> {
  const t = task(overrides);
  await taskStore.set(t);
  return t;
}

// CommandRunner that records execs, answers pane_current_command with `claude`, and returns
// `capture()` for every capture-pane (capture may run side effects, e.g. mutate the binding).
function capturePaneRunner(
  execs: string[],
  capture: () => string | Promise<string>,
): CommandRunner {
  return {
    exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
      execs.push(cmd);
      if (cmd.includes('display-message') && cmd.includes('pane_current_command')) {
        return { stdout: 'claude\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane')) {
        return { stdout: await capture(), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
    writeFile: vi.fn(async (): Promise<void> => undefined),
  } as unknown as CommandRunner;
}

// onExec callback that decodes the base64 prompt body from each tmux load-buffer command.
function captureInjection(into: string[]): (cmd: string) => void {
  return (cmd: string) => {
    const m = cmd.match(/printf '%s' '([^']+)'/);
    if (m && cmd.includes('load-buffer')) into.push(Buffer.from(m[1], 'base64').toString('utf8'));
  };
}

async function seedPhaseSkillsAtDir(skillsDir: string): Promise<void> {
  for (const name of ['baxian-task-check', 'baxian-pr-feedback', 'baxian-pr-review', 'baxian-pr-recheck']) {
    await mkdir(join(skillsDir, name), { recursive: true });
    await writeFile(
      join(skillsDir, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} stub\n---\nstub`,
    );
  }
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-manager-'));
  await initStateDir(tempDir);
  agentStore = new AgentStore(join(tempDir, 'state', 'agents'));
  taskStore = new TaskStore(join(tempDir, 'state', 'tasks'));
  lockManager = new LockManager(join(tempDir, 'locks'));
  eventBus = new EventBus(new EventLog(join(tempDir, 'events')));
  events.length = 0;
  eventBus.on('*', (event) => { events.push(event); });

  const skillsDir = join(tempDir, 'skills');
  await seedPhaseSkillsAtDir(skillsDir);
  const skillRegistry = new SkillRegistry(skillsDir);
  await skillRegistry.scan();

  manager = makeManager({ skillRegistry });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

describe('AgentManager task binding flow', () => {
  it('createTask binds a free preferred dev and holds its lock', async () => {
    await seedAgent({ id: 'dev-1' });

    const created = await manager.createTask('proj', {
      title: 'build it',
      description: 'details',
      preferredAgentId: 'dev-1',
    });

    expect(created.status).toBe('in_progress');
    expect(created.agentId).toBe('dev-1');
    expect(created.qaAgentId).toBe('qa-1');
    expect((await agentStore.get('dev-1'))?.taskId).toBe(created.id);
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    expect(events.some(e => e.type === 'task.assigned' && e.agentId === 'dev-1')).toBe(true);
  });

  it('createTask records the QA partner before any review dispatch', async () => {
    await seedAgent({ id: 'dev-1' });

    const created = await manager.createTask('proj', {
      title: 'bind the group',
      description: 'details',
      preferredAgentId: 'dev-1',
    });

    expect(created).toMatchObject({
      agentId: 'dev-1',
      qaAgentId: 'qa-1',
      status: 'in_progress',
      reviewRound: 0,
    });
    expect((await taskStore.get(created.id))?.qaAgentId).toBe('qa-1');
  });

  it('createTask queues when preferred dev has a creation token or task binding', async () => {
    await seedAgent({ id: 'dev-1', creationToken: 'tok' });
    const pendingDuringCreate = await manager.createTask('proj', {
      title: 'blocked',
      description: 'details',
      preferredAgentId: 'dev-1',
    });
    expect(pendingDuringCreate.status).toBe('pending');

    await seedAgent({ id: 'dev-1', taskId: 'other-task' });
    const pendingWhileBound = await manager.createTask('proj', {
      title: 'blocked again',
      description: 'details',
      preferredAgentId: 'dev-1',
    });
    expect(pendingWhileBound.status).toBe('pending');
  });

  it('serializes concurrent createTask calls so only one task binds the preferred dev', async () => {
    await seedAgent({ id: 'dev-1' });

    const [first, second] = await Promise.all([
      manager.createTask('proj', {
        title: 'first',
        description: 'details',
        preferredAgentId: 'dev-1',
      }),
      manager.createTask('proj', {
        title: 'second',
        description: 'details',
        preferredAgentId: 'dev-1',
      }),
    ]);

    const bound = [first, second].filter(t => t.status === 'in_progress');
    const queued = [first, second].filter(t => t.status === 'pending');
    expect(bound).toHaveLength(1);
    expect(queued).toHaveLength(1);
    expect((await agentStore.get('dev-1'))?.taskId).toBe(bound[0].id);
  });

  it('safeEmit failures do not block createTask state transitions', async () => {
    await seedAgent({ id: 'dev-1' });
    vi.spyOn(eventBus, 'emit').mockRejectedValueOnce(new Error('event log down'));

    const created = await manager.createTask('proj', {
      title: 'build it',
      description: 'details',
      preferredAgentId: 'dev-1',
    });

    expect(created.status).toBe('in_progress');
    expect((await agentStore.get('dev-1'))?.taskId).toBe(created.id);
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('createTask stores custom branch in TaskState', async () => {
    await seedAgent({ id: 'dev-1' });
    const created = await manager.createTask('proj', {
      title: 'custom branch',
      description: 'details',
      preferredAgentId: 'dev-1',
      branch: 'feat/my-feature',
    });
    expect(created.branch).toBe('feat/my-feature');
  });

  it('createTask rejects custom branch starting with reserved bx/ prefix', async () => {
    await seedAgent({ id: 'dev-1' });
    await expect(manager.createTask('proj', {
      title: 'reserved prefix',
      description: 'details',
      preferredAgentId: 'dev-1',
      branch: 'bx/task-other',
    })).rejects.toThrow(/reserved prefix/);
  });

  it.each([
    '-flag-like',
    'feat/../escape',
    'feat@{0}',
    'feat/.hidden',
    'feat/foo.lock',
    'feat/',
    'feat//x',
    'feat/x.',
  ])('createTask rejects git-invalid branch name: %s', async (branch) => {
    await seedAgent({ id: 'dev-1' });
    await expect(manager.createTask('proj', {
      title: 'bad branch',
      description: 'details',
      preferredAgentId: 'dev-1',
      branch,
    })).rejects.toThrow(/Invalid branch name/);
  });

  it('createTask rejects duplicate custom branch within the same project', async () => {
    await seedAgent({ id: 'dev-1' });
    await manager.createTask('proj', {
      title: 'first',
      description: 'details',
      preferredAgentId: 'dev-1',
      branch: 'feat/unique',
    });

    await seedAgent({ id: 'dev-1' });
    await expect(manager.createTask('proj', {
      title: 'second',
      description: 'details',
      preferredAgentId: 'dev-1',
      branch: 'feat/unique',
    })).rejects.toThrow(/already bound to task/);
  });

  it('cancelTask delegates releaseAgentForTask for dev and qa after cancelling the task', async () => {
    const t = await seedTask({ qaAgentId: 'qa-1' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    mockInterruptPane(manager, true);
    stubClearPane(manager);
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);

    const cancelled = await manager.cancelTask(t.id);

    expect(cancelled.status).toBe('cancelled');
    expect(releaseSpy).toHaveBeenCalledWith('dev-1', t.id, 'idle', { allowAwaitingHuman: true, fromCancelCleanup: true });
    expect(releaseSpy).toHaveBeenCalledWith('qa-1', t.id, 'idle', { allowAwaitingHuman: true, fromCancelCleanup: true });
  });

  it('cancelTask releases a bound dev through the real release path without task-lock deadlock', async () => {
    const localManager = makeManager({ runnerFactory: () => clearAwareRunner([], () => CLAUDE_PANE) });
    setCompactTiming(localManager);
    const t = await seedTask();
    await seedAgent({
      id: 'dev-1',
      taskId: t.id,
      paneId: '%0',
    });
    await lockManager.acquire('dev-1');

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('cancelTask timed out')), 1_500);
    });
    const cancelled = await Promise.race([localManager.cancelTask(t.id), timeout]);

    expect(cancelled.status).toBe('cancelled');
    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(state?.paneId).toBe('%0');
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('rollbackFailedDispatch clears only the matching binding and releases the lock', async () => {
    const t = await seedTask();
    await seedAgent({
      id: 'dev-1',
      taskId: t.id,
      worktreePath: '/tmp/wt',
      paneId: '%0',
    });
    await lockManager.acquire('dev-1');

    await manager['rollbackFailedDispatch'](t.id, 'dev-1');

    expect((await taskStore.get(t.id))?.status).toBe('pending');
    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(state?.worktreePath).toBeUndefined();
    expect(state?.paneId).toBe('%0');
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('createAndStartTask skips rollbackFailedDispatch when startSession throws EnsureSessionError(handled=true)', async () => {
    // rollback would clear lock → next dispatch hits the still-stuck dialog pane.
    const dialogErr = new EnsureSessionError(
      { createdSession: true, agentId: 'dev-1', dialogPending: true, handled: true },
      'develop dispatch runtime dialog handled',
    );
    vi.spyOn(manager, 'startSession').mockRejectedValue(dialogErr);
    const rollbackSpy = vi.spyOn(manager as never as { rollbackFailedDispatch: (taskId: string, agentId: string) => Promise<void> }, 'rollbackFailedDispatch');

    const created = await manager.createAndStartTask('proj', {
      title: 'T', description: 'D', preferredAgentId: 'dev-1',
    });

    expect(rollbackSpy).not.toHaveBeenCalled();
    // task 留在 in_progress（handleDialogPendingFromRuntime 在真实场景下会推 failed，
    // 但这里只 mock startSession，没真正调 handle—— 关键 assertion 是 rollback 没被调）
    expect(created.status).toBe('in_progress');
  });

  it('createAndStartTask({ background: true }) returns without waiting for the session bootstrap', async () => {
    // Gate startSession open forever: if create awaited the bootstrap, this test would hang.
    const startSpy = vi.spyOn(manager, 'startSession').mockReturnValue(new Promise<boolean>(() => {}));

    const created = await manager.createAndStartTask(
      'proj',
      { title: 'T', description: 'D', preferredAgentId: 'dev-1' },
      { background: true },
    );

    expect(created.status).toBe('in_progress');
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('createAndStartTask({ background: true }) rolls a failed bootstrap back off the create path', async () => {
    vi.spyOn(manager, 'startSession').mockRejectedValue(new Error('boot failed'));
    let rolledBack!: () => void;
    const rollbackDone = new Promise<void>((resolve) => { rolledBack = resolve; });
    const rollbackSpy = vi
      .spyOn(manager as never as { rollbackFailedDispatch: (taskId: string, agentId: string) => Promise<void> }, 'rollbackFailedDispatch')
      .mockImplementation(async () => { rolledBack(); });

    const created = await manager.createAndStartTask(
      'proj',
      { title: 'T', description: 'D', preferredAgentId: 'dev-1' },
      { background: true },
    );

    // The create call resolves immediately with the in_progress task — the failure never rejects it…
    expect(created.status).toBe('in_progress');
    // …yet the failed bootstrap is still handled in the background, not swallowed.
    await rollbackDone;
    expect(rollbackSpy).toHaveBeenCalledTimes(1);
  });

  function mockStartSessionThatCancels(): void {
    // startSession reports success, but the user cancelled the task while it ran — startSession's
    // success path re-binds the agent, so the background path must clean it up (else permanently busy).
    vi.spyOn(manager, 'startSession').mockImplementation(async (cancelledTaskId: string) => {
      const t = await taskStore.get(cancelledTaskId);
      if (t) await taskStore.set({ ...t, status: 'cancelled', updatedAt: NOW });
      return true;
    });
  }

  it('createAndStartTask({ background: true }): cancel mid-bootstrap interrupts the pane, then idle-releases', async () => {
    mockStartSessionThatCancels();
    const interruptSpy = mockInterruptPane(manager, true);
    stubClearPane(manager);
    let released!: () => void;
    const releaseDone = new Promise<void>((resolve) => { released = resolve; });
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask').mockImplementation(async () => { released(); return true; });
    const armSpy = vi.spyOn(
      manager as never as { armPostDispatchSignalOrHold: (...args: unknown[]) => Promise<void> },
      'armPostDispatchSignalOrHold',
    );

    const created = await manager.createAndStartTask(
      'proj',
      { title: 'T', description: 'D', preferredAgentId: 'dev-1' },
      { background: true },
    );

    await releaseDone;
    // ESC + /clear the (possibly prompt-running) pane BEFORE handing it back, so the next dispatch isn't polluted.
    expect(interruptSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledWith('dev-1', created.id, 'idle', { allowAwaitingHuman: true, fromCancelCleanup: true });
    expect(armSpy).not.toHaveBeenCalled();
  });

  it('createAndStartTask({ background: true }): cancel mid-bootstrap holds the agent when the pane can not be interrupted', async () => {
    mockStartSessionThatCancels();
    mockInterruptPane(manager, false);
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    let held!: () => void;
    const holdDone = new Promise<void>((resolve) => { held = resolve; });
    const holdSpy = vi.spyOn(manager, 'markAwaitingHuman').mockImplementation(async () => { held(); });

    const created = await manager.createAndStartTask(
      'proj',
      { title: 'T', description: 'D', preferredAgentId: 'dev-1' },
      { background: true },
    );

    await holdDone;
    expect(holdSpy).toHaveBeenCalledWith('dev-1', 'cancel-interrupt-failed', expect.any(String), { expectedTaskId: created.id });
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  it('createAndStartTask({ background: true }): cancel mid-bootstrap holds the agent when /clear is not confirmed', async () => {
    mockStartSessionThatCancels();
    mockInterruptPane(manager, true);
    stubClearPane(manager, false);
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    let held!: () => void;
    const holdDone = new Promise<void>((resolve) => { held = resolve; });
    const holdSpy = vi.spyOn(manager, 'markAwaitingHuman').mockImplementation(async () => { held(); });

    const created = await manager.createAndStartTask(
      'proj',
      { title: 'T', description: 'D', preferredAgentId: 'dev-1' },
      { background: true },
    );

    await holdDone;
    expect(holdSpy).toHaveBeenCalledWith('dev-1', 'cancel-clear-failed', expect.any(String), { expectedTaskId: created.id });
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  it('createAndStartTask({ background: true }): a watcher arm failure holds the agent instead of being swallowed', async () => {
    vi.spyOn(manager, 'startSession').mockResolvedValue(true);
    vi.spyOn(manager as never as { armPostDispatchSignalOrHold: (...args: unknown[]) => Promise<void> }, 'armPostDispatchSignalOrHold')
      .mockRejectedValue(new Error('watcher store down'));
    let held!: () => void;
    const holdDone = new Promise<void>((resolve) => { held = resolve; });
    const holdSpy = vi
      .spyOn(manager as never as { holdAgentForUnarmedSignal: (...args: unknown[]) => Promise<void> }, 'holdAgentForUnarmedSignal')
      .mockImplementation(async () => { held(); });

    const created = await manager.createAndStartTask(
      'proj',
      { title: 'T', description: 'D', preferredAgentId: 'dev-1' },
      { background: true },
    );

    expect(created.status).toBe('in_progress');
    await holdDone;
    expect(holdSpy).toHaveBeenCalledWith(created.id, 'dev-1', ['spec-done', 'pr-created']);
  });

  it('createAndStartTask: a cancel-cleanup hold from a cancel-before-delivery is NOT auto-released by the !started path', async () => {
    // User cancelled mid-bootstrap; cancelTask marked the agent cancel-interrupt-failed (pane may still be
    // running). The !started path must NOT auto-release that cancel-cleanup hold (it would hand the cancelled
    // session to the next dispatch) — it stays held for operator Resume (after verifying) or Delete.
    vi.spyOn(manager, 'startSession').mockImplementation(async (cancelledTaskId: string) => {
      const t = await taskStore.get(cancelledTaskId);
      if (t) await taskStore.set({ ...t, status: 'cancelled', updatedAt: NOW });
      await agentStore.update('dev-1', (s) => (s
        ? { ...s, status: 'awaiting_human' as const, awaitingPhase: 'cancel-interrupt-failed', awaitingSince: NOW }
        : s));
      return false;
    });

    const created = await manager.createAndStartTask('proj', { title: 'T', description: 'D', preferredAgentId: 'dev-1' });

    const dev = await agentStore.get('dev-1');
    expect(dev?.taskId).toBe(created.id);
    expect(dev?.awaitingPhase).toBe('cancel-interrupt-failed');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('develop dispatch holds the dev when the spec/pr-created watcher fails to arm', async () => {
    // Non-verdict path: develop's pane only exists after startSession, so the watcher arms after
    // dispatch. A transient subscribeAtomic failure must hold the dev (explicit, recoverable) — not
    // leave the task silently waiting for a spec-done/pr-created signal with no consumer.
    await seedAgent({ id: 'dev-1' });
    const watcher = { start: vi.fn(async () => false), stop: vi.fn(), has: vi.fn(() => false) };
    const skillRegistry = new SkillRegistry(join(tempDir, 'skills'));
    await skillRegistry.scan();
    const m = makeManager({ skillRegistry, phaseSignalWatcher: watcher as never });
    vi.spyOn(m, 'startSession').mockResolvedValue(true);
    const holdSpy = vi.spyOn(m, 'markAwaitingHuman');

    await m.createAndStartTask('proj', { title: 'T', description: 'D', preferredAgentId: 'dev-1' });

    expect(watcher.start).toHaveBeenCalled();
    expect(holdSpy).toHaveBeenCalledWith(
      'dev-1',
      expect.stringContaining('signal-arm-failed'),
      expect.any(String),
      expect.objectContaining({ expectedTaskId: expect.any(String) }),
    );
  });

  it('setupPhaseSignal through the REAL watcher reports false for a config-removed agent; the hold marks it awaiting_human', async () => {
    // The watcher's resolveAgent is the same getAgentConfig a guard exit just saw fail,
    // so a missing-config re-arm can never install a consumer — callers must observe
    // false and hold instead of trusting the arm.
    const t = await seedTask({ id: 'task-ghost', agentId: 'ghost', signalToken: 'tok-1' });
    await seedAgent({ id: 'ghost', taskId: t.id });
    const skillRegistry = new SkillRegistry(join(tempDir, 'skills'));
    await skillRegistry.scan();
    const m = makeManager({
      skillRegistry,
      paneStreamerManager: {
        ensure: () => { throw new Error('unreachable: resolveAgent fails before ensure'); },
      } as never,
    });

    const armed = await m.setupPhaseSignal(t.id, 'ghost', 'code-done', { skipSnapshot: true });

    expect(armed).toBe(false);
    expect(events.some(
      e => e.type === 'human.intervention'
        && (e.data as { phase?: string }).phase === 'signal-setup-no-agent:code-done',
    )).toBe(true);

    await m.holdAgentForUnarmedSignal(t.id, 'ghost', 'code-done');
    const held = await agentStore.get('ghost');
    expect(held?.status).toBe('awaiting_human');
    expect(held?.awaitingPhase).toBe('signal-arm-failed:code-done');
  });

  it('setupPhaseSignal through the REAL watcher arms and reports true for a configured agent', async () => {
    const t = await seedTask({ id: 'task-armed', signalToken: 'tok-2' });
    const skillRegistry = new SkillRegistry(join(tempDir, 'skills'));
    await skillRegistry.scan();
    const m = makeManager({
      skillRegistry,
      paneStreamerManager: {
        ensure: () => ({
          subscribeAtomic: async () => ({ unsubscribe: () => undefined, snapshot: { data: '' } }),
        }),
      } as never,
    });

    const armed = await m.setupPhaseSignal(t.id, 'dev-1', 'code-done', { skipSnapshot: true });

    expect(armed).toBe(true);
  });

  it('failTaskForDispatchError fails the task and releases its agent binding', async () => {
    const t = await seedTask();
    await seedAgent({
      id: 'dev-1',
      taskId: t.id,
      paneId: '%0',
    });
    await lockManager.acquire('dev-1');

    await manager.failTaskForDispatchError(
      t.id,
      'develop',
      'dev-1',
      new DispatchTerminalError('prompt_too_large', 'prompt too large'),
    );

    expect((await taskStore.get(t.id))?.status).toBe('failed');
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('validateTaskDispatch raises ApiError(500) when preflight hits RequiredSkillsMissingError', async () => {
    // Build a manager whose SkillRegistry was never populated. The preflight
    // must surface a missing required skill as 500 (server config) — NOT 400
    // (client request), because retrying the same task input cannot fix it;
    // operators need to repair the registry.
    const unseededSkillsDir = join(tempDir, 'skills-empty');
    await mkdir(unseededSkillsDir, { recursive: true });
    const emptyRegistry = new SkillRegistry(unseededSkillsDir);
    await emptyRegistry.scan();
    const badManager = makeManager({ skillRegistry: emptyRegistry });
    await seedAgent({ id: 'dev-1' });

    let caught: unknown;
    try {
      await badManager.validateTaskDispatch('proj', {
        title: 'x',
        description: 'y',
        preferredAgentId: 'dev-1',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(500);
    expect((caught as Error).message).toMatch(/required skill/i);
  });

  it('failTaskForDispatchError accepts required_skills_missing reason', async () => {
    const t = await seedTask({ id: 'task-skills' });
    await seedAgent({
      id: 'dev-1',
      taskId: t.id,
      paneId: '%0',
    });
    await lockManager.acquire('dev-1');

    await manager.failTaskForDispatchError(
      t.id,
      'develop',
      'dev-1',
      new DispatchTerminalError('required_skills_missing', 'missing baxian-task-check'),
    );

    expect((await taskStore.get(t.id))?.status).toBe('failed');
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('startSession ack_unknown preserves binding/lock/worktree (so downstream markAwaitingHuman can take over)', async () => {
    const t = await seedTask({ id: 'task-startsession-ack-unknown', branch: 'bx/task-startsession-ack-unknown' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await lockManager.acquire('dev-1');
    const beforeUpdatedAt = NOW;

    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%0', workdir: '/tmp/repo',
    });
    // 让 worktree.createDetached 这类辅助命令通过：通过 runnerFactory 给 mockRunner mock 即可。
    // 这里改走更直接的注入：spy injectAndAwaitAck 抛 ack_unknown。
    vi.spyOn(manager as unknown as { injectAndAwaitAck: () => Promise<void> }, 'injectAndAwaitAck')
      .mockRejectedValue(new DispatchTerminalError('ack_unknown', 'simulated ack_unknown from infra failure'));
    // resolveAutoBaseRef 走 runner，不重要；让其失败也行，但我们走 'develop' phase 时需要 worktree.create
    // 用 readyRunner-like 的现成 fixture 不够，改成给 manager 注入一个最小 runner：
    const minimalRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('git worktree add')) return { stdout: '', stderr: '', exitCode: 0 };
        if (cmd.includes('git rev-parse')) return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async () => undefined),
    };
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => minimalRunner;

    await expect(manager.startSession(t.id, 'dev-1', 'develop')).rejects.toBeInstanceOf(DispatchTerminalError);

    // 关键断言：catch 跳过了清理，绑定/lock/worktreePath 都还在
    const stateAfter = await agentStore.get('dev-1');
    expect(stateAfter?.taskId).toBe(t.id);
    expect(stateAfter?.worktreePath).toBeTruthy();
    expect(stateAfter?.updatedAt).not.toBe(beforeUpdatedAt); // agentStore 第一次 set 过 startedAt
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('startSession cleanup leaves the binding when cancel took it over (cancel-clearing) during the mutex wait', async () => {
    const t = await seedTask({ id: 'task-ss-cancel-clearing', branch: 'bx/task-ss-cancel-clearing' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await lockManager.acquire('dev-1');

    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%0', workdir: '/tmp/repo',
    });
    // Dispatch wins the pane mutex after cancel released Phase 1; injectAndAwaitAck's task-terminal guard
    // aborts, but cancel has already marked the agent cancel-clearing (keeps taskId) — the cleanup must not
    // wipe that hold (else Phase 2 skips /clear and reuses an un-cleared pane).
    vi.spyOn(manager as unknown as { injectAndAwaitAck: () => Promise<unknown> }, 'injectAndAwaitAck')
      .mockImplementation(async () => {
        await (manager as unknown as { markPaneCancelClearing: (a: string, tid: string) => Promise<void> })
          .markPaneCancelClearing('dev-1', t.id);
        throw new Error('dispatch aborted: task went terminal while waiting for pane mutex');
      });
    const minimalRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('git worktree add')) return { stdout: '', stderr: '', exitCode: 0 };
        if (cmd.includes('git rev-parse')) return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async () => undefined),
    };
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => minimalRunner;

    await expect(manager.startSession(t.id, 'dev-1', 'develop')).rejects.toThrow(/went terminal/);

    const stateAfter = await agentStore.get('dev-1');
    expect(stateAfter?.taskId).toBe(t.id);                 // binding preserved for cancel's Phase 2
    expect(stateAfter?.awaitingPhase).toBe('cancel-clearing');
    expect(await lockManager.isLocked('dev-1')).toBe(true); // lock not released
  });

  it('startSession set-running write preserves a cancel-clearing hold present at write time (does NOT wipe it)', async () => {
    // Dangerous ordering: cancel installs the hold BEFORE startSession's set-running write (vs test above, where
    // it lands during injectAndAwaitAck). The fresh-rebuild write must not overwrite the hold — else cancel's
    // Phase 2 skips /clear and the next dispatch reuses an un-cleared pane.
    const t = await seedTask({ id: 'task-ss-cancel-clearing-prewrite', branch: 'bx/task-ss-cancel-clearing-prewrite' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await lockManager.acquire('dev-1');

    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%0', workdir: '/tmp/repo',
    });
    const injectSpy = vi.spyOn(manager as unknown as { injectAndAwaitAck: () => Promise<unknown> }, 'injectAndAwaitAck')
      .mockRejectedValue(new Error('injectAndAwaitAck must not run when a cancel hold owns the binding'));
    const minimalRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('git worktree add')) return { stdout: '', stderr: '', exitCode: 0 };
        if (cmd.includes('git rev-parse')) return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async () => undefined),
    };
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => minimalRunner;

    const result = await manager.startSession(t.id, 'dev-1', 'develop');

    expect(result).toBe(false);                              // dispatch aborted, not run onto a held pane
    expect(injectSpy).not.toHaveBeenCalled();                // never injected the prompt
    const stateAfter = await agentStore.get('dev-1');
    expect(stateAfter?.taskId).toBe(t.id);                   // binding preserved for cancel's Phase 2
    expect(stateAfter?.awaitingPhase).toBe('cancel-clearing');
    expect(stateAfter?.bootstrappingTaskId).toBeUndefined(); // never marked mid-bootstrap
    expect(await lockManager.isLocked('dev-1')).toBe(true);  // lock not released
  });

  it('rollbackFailedDispatch leaves the binding/lock when the agent is held by cancel cleanup', async () => {
    const t = await seedTask({ id: 'task-rollback-cancel', status: 'cancelled' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await lockManager.acquire('dev-1');

    await (manager as unknown as { rollbackFailedDispatch: (tid: string, aid: string) => Promise<void> })
      .rollbackFailedDispatch(t.id, 'dev-1');

    const st = await agentStore.get('dev-1');
    expect(st?.taskId).toBe(t.id);                  // binding left for cancel's Phase 1
    expect(st?.awaitingPhase).toBe('cancel-clearing');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('failTaskForDispatchError on ack_unknown releases partner agents (terminal cleanup)', async () => {
    // Task pushed to failed → partner binding must clear too, else it stays stale.
    const t = await seedTask({ id: 'task-ack-partner', status: 'review', qaAgentId: 'qa-1' });
    // QA hit ack_unknown
    await seedAgent({
      id: 'qa-1', taskId: t.id, paneId: '%1',
    });
    // dev 仍绑该 task（QA review 期间 dev waiting）
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await lockManager.acquire('qa-1');
    await lockManager.acquire('dev-1');

    await manager.failTaskForDispatchError(
      t.id, 'review', 'qa-1',
      new DispatchTerminalError('ack_unknown', 'simulated'),
    );

    // QA Held
    expect((await agentStore.get('qa-1'))?.status).toBe('awaiting_human');
    expect((await agentStore.get('qa-1'))?.taskId).toBe(t.id);
    // dev partner 被 releasePartnersAndDrain 清掉
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('failTaskForDispatchError preserves binding on ack_unknown (prompt may already be running)', async () => {
    const t = await seedTask({ id: 'task-ack-unknown' });
    await seedAgent({
      id: 'dev-1',
      taskId: t.id,
      paneId: '%0',
    });
    await lockManager.acquire('dev-1');
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask');

    await manager.failTaskForDispatchError(
      t.id,
      'develop',
      'dev-1',
      new DispatchTerminalError('ack_unknown', 'capture-pane failed mid-wait'),
    );

    expect((await taskStore.get(t.id))?.status).toBe('failed');
    // 关键差异：绑定 + 锁保留 + status='awaiting_human'，避免下一任务派到仍可能运行旧 prompt 的 pane
    const stateAfter = await agentStore.get('dev-1');
    expect(stateAfter?.taskId).toBe(t.id);
    expect(stateAfter?.status).toBe('awaiting_human');
    expect(stateAfter?.awaitingPhase).toBe('dispatch-failed:ack_unknown');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    expect(releaseSpy).not.toHaveBeenCalled();

    const interventions = events.filter(
      e => e.type === 'human.intervention' &&
        typeof (e.data as { phase?: string }).phase === 'string' &&
        (e.data as { phase: string }).phase.startsWith('dispatch-failed:ack_unknown'),
    );
    expect(interventions).toHaveLength(1);

    releaseSpy.mockRestore();
  });
});

describe('AgentManager transitionTaskStatus', () => {
  it('persists a valid non-terminal transition and returns the previous status', async () => {
    await seedTask({ id: 'task-transition', status: 'in_progress', updatedAt: NOW });

    const result = await manager.transitionTaskStatus(
      'task-transition',
      'review',
      { fromStatus: ['in_progress', 'fixing'] },
    );

    expect(result).toMatchObject({
      previousStatus: 'in_progress',
      task: { id: 'task-transition', status: 'review' },
    });
    expect((await taskStore.get('task-transition'))?.status).toBe('review');
    expect((await taskStore.get('task-transition'))?.updatedAt).not.toBe(NOW);
  });

  it('returns null and leaves the task unchanged when fromStatus does not match', async () => {
    await seedTask({ id: 'task-guard', status: 'in_progress', updatedAt: NOW });

    const result = await manager.transitionTaskStatus(
      'task-guard',
      'merged',
      { fromStatus: ['review', 'approved'] },
    );

    expect(result).toBeNull();
    expect(await taskStore.get('task-guard')).toMatchObject({
      status: 'in_progress',
      updatedAt: NOW,
    });
  });

  it('refuses terminal tasks even when the guard includes the terminal status', async () => {
    // max_rounds is intentionally absent: it is non-terminal (paused awaiting a human
    // decision), so transitions out of it (continue → fixing, complete → merged) must work.
    for (const terminal of ['merged', 'failed', 'cancelled'] as const) {
      await seedTask({ id: `task-${terminal}`, status: terminal });
      await expect(
        manager.transitionTaskStatus(`task-${terminal}`, 'review', { fromStatus: [terminal] }),
      ).resolves.toBeNull();
      expect((await taskStore.get(`task-${terminal}`))?.status).toBe(terminal);
    }
  });

  it('returns null for an unknown task', async () => {
    await expect(
      manager.transitionTaskStatus('missing-task', 'review', { fromStatus: ['in_progress'] }),
    ).resolves.toBeNull();
  });

  it('persists the supplied task patch with the transition', async () => {
    await seedTask({ id: 'task-patch', status: 'in_progress', reviewRound: 0 });

    const result = await manager.transitionTaskStatus(
      'task-patch',
      'review',
      { fromStatus: ['in_progress'] },
      {
        reviewRound: 1,
        prNumber: 87,
        prUrl: 'https://github.com/baxian-ai/baxian/pull/87',
        qaAgentId: 'qa-1',
        latestHeadSha: 'abc123',
      },
    );

    expect(result?.task).toMatchObject({
      status: 'review',
      reviewRound: 1,
      prNumber: 87,
      prUrl: 'https://github.com/baxian-ai/baxian/pull/87',
      qaAgentId: 'qa-1',
      latestHeadSha: 'abc123',
    });
    expect(await taskStore.get('task-patch')).toMatchObject({
      status: 'review',
      reviewRound: 1,
      prNumber: 87,
      qaAgentId: 'qa-1',
      latestHeadSha: 'abc123',
    });
  });
});

describe('AgentManager dispatchReviewToQa', () => {
  function reviewable(overrides: Partial<TaskState> = {}): TaskState {
    return task({
      id: 'task-review',
      status: 'fixing',
      qaAgentId: 'qa-1',
      reviewRound: 1,
      prNumber: 87,
      prUrl: 'https://github.com/baxian-ai/baxian/pull/87',
      ...overrides,
    });
  }

  // Persist a reviewable task and seed the QA partner; seed the dev too unless `dev` is null
  // (some gates run with no bound dev). `dev` overrides merge onto the default dev binding.
  async function seedReviewable(
    overrides: Partial<TaskState> = {},
    dev: Partial<AgentBindingFacts> | null = {},
  ): Promise<void> {
    await taskStore.set(reviewable(overrides));
    if (dev !== null) await seedAgent({ id: 'dev-1', taskId: 'task-review', ...dev });
    await seedAgent({ id: 'qa-1' });
  }

  it('dispatches a fixing task as recheck after parking dev and acquiring QA', async () => {
    await seedReviewable();
    const markWaitingSpy = vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    const result = await manager.dispatchReviewToQa('task-review');

    expect(markWaitingSpy).toHaveBeenCalledWith('dev-1', 'task-review');
    expect(startSpy).toHaveBeenCalledWith('task-review', 'qa-1', 'recheck', expect.objectContaining({ bypassTaskStatusGate: true }));
    expect(result).toMatchObject({ status: 'review', reviewRound: 2, qaAgentId: 'qa-1' });
    expect((await agentStore.get('qa-1'))?.taskId).toBe('task-review');
  });

  it('throws + rolls back without dispatching when the verdict watcher fails to arm', async () => {
    await seedReviewable();
    vi.spyOn(manager, 'fetchPrHeadSha').mockResolvedValue('a'.repeat(40));
    vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);
    vi.spyOn(manager, 'rotateAndSetupPhaseSignal').mockResolvedValue({ token: 'tok', armed: false });
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await expect(manager.dispatchReviewToQa('task-review')).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining('arm review verdict watcher'),
    });
    expect(startSpy).not.toHaveBeenCalled();
    expect(releaseSpy).toHaveBeenCalledWith('qa-1', 'task-review', 'idle');
    // PHASE 1's reviewRound bump (1→2) is rolled back.
    expect((await taskStore.get('task-review'))?.reviewRound).toBe(1);
  });

  it('dispatches an in-progress task as first review', async () => {
    await seedReviewable({ status: 'in_progress', reviewRound: 0 });
    const acquireSpy = vi.spyOn(manager, 'acquireAgentForTask');
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);
    vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);

    await manager.dispatchReviewToQa('task-review');

    expect(acquireSpy).toHaveBeenCalledWith('qa-1', 'task-review', 'review');
    expect(startSpy).toHaveBeenCalledWith('task-review', 'qa-1', 'review', expect.objectContaining({ bypassTaskStatusGate: true }));
  });

  it('dispatchReviewToQa: markAgentWaiting reject (IO error) still releases QA (no bind/lock leak)', async () => {
    // Without the catch, markAgentWaiting reject jumps the try/finally → QA acquired but never started → stuck.
    await seedReviewable({ status: 'approved' }, { paneId: '%0' });
    vi.spyOn(manager, 'markAgentWaiting').mockRejectedValue(new Error('store IO failure'));
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await expect(manager.dispatchReviewToQa('task-review')).rejects.toMatchObject({ status: 500 });

    // QA release 必须被调（清掉刚 acquire 的 binding+lock）
    expect(releaseSpy).toHaveBeenCalledWith('qa-1', 'task-review', 'idle');
  });

  it('parks an approved dev into waiting before recheck (no C-c, no separate release path)', async () => {
    await seedReviewable({ status: 'approved' }, { paneId: '%0' });
    const markWaitingSpy = vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);
    vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await manager.dispatchReviewToQa('task-review');

    expect(markWaitingSpy).toHaveBeenCalledWith('dev-1', 'task-review');
  });

  it('can dispatch terminal tasks without changing their terminal status', async () => {
    await seedReviewable({ status: 'merged' }, null);
    const markWaitingSpy = vi.spyOn(manager, 'markAgentWaiting');
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    const result = await manager.dispatchReviewToQa('task-review');

    expect(markWaitingSpy).not.toHaveBeenCalled();
    expect(startSpy).toHaveBeenCalledWith('task-review', 'qa-1', 'recheck', expect.objectContaining({ bypassTaskStatusGate: true }));
    expect(result).toMatchObject({ status: 'merged', reviewRound: 2 });
  });

  it('does not mutate the task when the dev gate fails', async () => {
    // dev must be bound for the park to be attempted (park is now skipped for an unbound dev).
    await seedReviewable();
    vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(false);
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await expect(manager.dispatchReviewToQa('task-review')).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining('Cannot park dev'),
    });
    expect(startSpy).not.toHaveBeenCalled();
    expect(releaseSpy).toHaveBeenCalledWith('qa-1', 'task-review', 'idle');
    expect(await taskStore.get('task-review')).toMatchObject({
      status: 'fixing',
      reviewRound: 1,
      qaAgentId: 'qa-1',
    });
  });

  it('rejects tasks without a PR before starting QA', async () => {
    await taskStore.set(reviewable({ prNumber: undefined, prUrl: undefined }));
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await expect(manager.dispatchReviewToQa('task-review')).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('no PR'),
    });
    expect(startSpy).not.toHaveBeenCalled();
  });

  // J1: spec-phase max_rounds must not be dispatched the code-review protocol (its verdict is
  // inert for spec phase → would bind QA into a state nothing can advance/release). Guard the
  // server entry, since the UI button is hidden but the endpoint is open.
  it('rejects spec-phase max_rounds with 409 (Call review uses the code protocol, inert for spec)', async () => {
    await taskStore.set(reviewable({ status: 'max_rounds', phase: 'spec' }));
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await expect(manager.dispatchReviewToQa('task-review')).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/spec-phase max_rounds|Retry or Cancel/),
    });
    expect(startSpy).not.toHaveBeenCalled();
    // untouched — still spec max_rounds, not flipped to review.
    expect((await taskStore.get('task-review'))?.status).toBe('max_rounds');
  });

  // Code-phase max_rounds Call review remains supported (regression guard for the scoped guard).
  it('allows code-phase max_rounds Call review (only spec is rejected)', async () => {
    await seedReviewable({ status: 'max_rounds' }, { status: 'waiting', worktreePath: '/tmp/wt', paneId: '%0' });
    vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);
    vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    const result = await manager.dispatchReviewToQa('task-review');
    expect(result.status).toBe('review');
  });

  it('falls back to the configured QA partner when task.qaAgentId is missing', async () => {
    await seedReviewable({ qaAgentId: undefined }, null);
    vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    const result = await manager.dispatchReviewToQa('task-review');

    expect(result.qaAgentId).toBe('qa-1');
    expect(startSpy).toHaveBeenCalledWith('task-review', 'qa-1', 'recheck', expect.any(Object));
  });

  it('releases QA and leaves task fields unchanged when startSession returns false', async () => {
    await seedReviewable();
    vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'startSession').mockResolvedValue(false);

    await expect(manager.dispatchReviewToQa('task-review')).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining('Failed to start'),
    });
    expect(releaseSpy).toHaveBeenCalledWith('qa-1', 'task-review', 'idle');
    expect(await taskStore.get('task-review')).toMatchObject({
      status: 'fixing',
      reviewRound: 1,
      qaAgentId: 'qa-1',
    });
  });

  it('startSession throws EnsureSessionError(handled=true) → skips releaseAgentForTask (preserves Held dialog state)', async () => {
    // Re-releasing on the catch path would clear the still-stuck dialog pane lock.
    await seedReviewable();
    vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);
    const dialogErr = new EnsureSessionError(
      { createdSession: true, agentId: 'qa-1', dialogPending: true, handled: true },
      'manual review runtime dialog already handled',
    );
    vi.spyOn(manager, 'startSession').mockRejectedValue(dialogErr);
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);

    await expect(manager.dispatchReviewToQa('task-review')).rejects.toBe(dialogErr);
    // QA release 不应被调（handled-skip 分支）；唯一允许的 release 是 prevQa 的（在错误抛出前）
    // 这里 prevQa.taskId !== taskId，所以也没调 — release spy 完全未被调
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  it('serializes concurrent manual dispatches for the same task', async () => {
    await seedReviewable({}, null);
    vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    vi.spyOn(manager, 'startSession').mockImplementation(async () => {
      await firstGate;
      return true;
    });

    const first = manager.dispatchReviewToQa('task-review');
    await waitUntil(() => manager['manualReviewInFlight'].has('task-review'));

    await expect(manager.dispatchReviewToQa('task-review')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('already in progress'),
    });

    releaseFirst();
    await expect(first).resolves.toMatchObject({ reviewRound: 2 });
    expect((await taskStore.get('task-review'))?.reviewRound).toBe(2);
  });

  it('sets up PR verdict-choice watcher when entering PR review (replaces any leaked watcher in one go)', async () => {
    // rotateAndSetupPhaseSignal.start() internally disarms any existing entry under
    // this taskId AND sets up the verdict watcher in one atomic step — so we expect a
    // single watcher.start({pr-approved, pr-changes-requested}) call, not a separate
    // stop+start.
    const watcher = {
      start: vi.fn(async () => true),
      stop: vi.fn(),
      has: vi.fn(() => false),
    };
    const m2 = makeManager({ skillRegistry: freshRegistry(), phaseSignalWatcher: watcher as never });
    await seedReviewable();
    vi.spyOn(m2, 'markAgentWaiting').mockResolvedValue(true);
    vi.spyOn(m2, 'startSession').mockResolvedValue(true);
    vi.spyOn(m2, 'fetchPrHeadSha').mockResolvedValue('a'.repeat(40));

    await m2.dispatchReviewToQa('task-review');
    expect(watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-review',
      expectedKinds: ['pr-approved', 'pr-changes-requested'],
    }));
    // No explicit stop call — the verdict watcher MUST still be live when QA
    // emits the verdict, so a teardown would silently strand it.
    expect(watcher.stop).not.toHaveBeenCalledWith('task-review');
  });
});

describe('AgentManager.transitionToCodePhase', () => {
  it('flips task review→in_progress, phase=code, rotates signalToken, calls continueSession code', async () => {
    await seedTask({
      id: 'task-spec-1',
      branch: 'bx/task-spec-1',
      status: 'review',
      phase: 'spec',
      specReviewRound: 1,
      signalToken: 'old-token',
      qaAgentId: 'qa-1',
    });
    await seedAgent({
      id: 'dev-1', taskId: 'task-spec-1',
      paneId: '%0',
    });
    await seedAgent({ id: 'qa-1', taskId: 'task-spec-1' });
    const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);
    vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);

    const result = await manager.transitionToCodePhase('task-spec-1');
    expect(result?.status).toBe('in_progress');
    expect(result?.phase).toBe('code');
    // signalToken is rotated (not cleared) so dev's pr-created signal can fire.
    expect(result?.signalToken).toMatch(/^[0-9a-f]{12}$/);
    expect(result?.signalToken).not.toBe('old-token');
    expect(continueSpy).toHaveBeenCalledWith('task-spec-1', 'dev-1', 'code');
  });

  it('stops spec signal watcher so a late spec-* signal on dev pane is not consumed', async () => {
    const watcher = {
      start: vi.fn(async () => true),
      stop: vi.fn(),
      has: vi.fn(() => false),
    };
    const m2 = makeManager({ skillRegistry: freshRegistry(), phaseSignalWatcher: watcher as never });
    await seedTask({
      id: 'task-spec-1',
      branch: 'bx/task-spec-1',
      status: 'review',
      phase: 'spec',
      specReviewRound: 1,
      signalToken: 'old-token',
      qaAgentId: 'qa-1',
    });
    await seedAgent({ id: 'dev-1', taskId: 'task-spec-1' });
    vi.spyOn(m2, 'continueSession').mockResolvedValue(true);
    vi.spyOn(m2, 'releaseAgentForTask').mockResolvedValue(true);
    vi.spyOn(m2, 'acquireAgentForTask').mockResolvedValue(true);

    await m2.transitionToCodePhase('task-spec-1');
    expect(watcher.stop).toHaveBeenCalledWith('task-spec-1');
  });

  it('pr-created watcher arm failure does NOT hold the dev (best-effort; poller detects the PR) — still dispatches code prompt', async () => {
    // The arm runs BEFORE acquire+continueSession, so holding here would block reentry. pr-created
    // is poller-detected, so a missed pane watcher is non-fatal: stay best-effort, never hold.
    const watcher = { start: vi.fn(async () => false), stop: vi.fn(), has: vi.fn(() => false) };
    const m = makeManager({ skillRegistry: freshRegistry(), phaseSignalWatcher: watcher as never });
    await seedTask({
      id: 'task-spec-1', branch: 'bx/task-spec-1',
      status: 'review', phase: 'spec', specReviewRound: 1, signalToken: 'old-token', qaAgentId: 'qa-1',
    });
    await seedAgent({ id: 'dev-1', taskId: 'task-spec-1' });
    const continueSpy = vi.spyOn(m, 'continueSession').mockResolvedValue(true);
    vi.spyOn(m, 'releaseAgentForTask').mockResolvedValue(true);
    vi.spyOn(m, 'acquireAgentForTask').mockResolvedValue(true);
    const holdSpy = vi.spyOn(m, 'markAwaitingHuman');

    const result = await m.transitionToCodePhase('task-spec-1');

    expect(continueSpy).toHaveBeenCalledWith('task-spec-1', 'dev-1', 'code');
    expect(holdSpy).not.toHaveBeenCalled();
    expect(result?.phase).toBe('code');
  });

  it('atomically writes status + phase + signalToken in single transitionTaskStatus call', async () => {
    await seedTask({
      id: 'task-spec-1',
      branch: 'bx/task-spec-1',
      status: 'review',
      phase: 'spec',
      specReviewRound: 1,
      signalToken: 'old-token',
      qaAgentId: 'qa-1',
    });
    await seedAgent({ id: 'dev-1', taskId: 'task-spec-1' });
    vi.spyOn(manager, 'continueSession').mockResolvedValue(true);
    vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    const transitionSpy = vi.spyOn(manager, 'transitionTaskStatus');
    const updateTaskSpy = vi.spyOn(manager, 'updateTask');

    await manager.transitionToCodePhase('task-spec-1');

    const codeTransitionCalls = transitionSpy.mock.calls.filter(
      c => c[0] === 'task-spec-1' && c[1] === 'in_progress',
    );
    expect(codeTransitionCalls).toHaveLength(1);
    expect(codeTransitionCalls[0]![3]).toMatchObject({
      phase: 'code',
      // signalToken is rotated (12 hex chars) so dev gets a fresh pr-created token.
      signalToken: expect.stringMatching(/^[0-9a-f]{12}$/),
    });
    expect(updateTaskSpy).not.toHaveBeenCalled();
  });
});

describe('transitionToCodePhase qa release fail-loud', () => {
  it('emits intervention when releaseAgentForTask(qa) returns false', async () => {
    await seedTask({
      id: 'task-spec-1',
      branch: 'bx/task-spec-1',
      status: 'review',
      phase: 'spec',
      specReviewRound: 1,
      qaAgentId: 'qa-1',
    });
    await seedAgent({ id: 'dev-1', taskId: 'task-spec-1' });
    await seedAgent({ id: 'qa-1', taskId: 'task-spec-1' });
    vi.spyOn(manager, 'continueSession').mockResolvedValue(true);
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'releaseAgentForTask').mockImplementation(async (agentId: string) => {
      return agentId !== 'qa-1';
    });

    await manager.transitionToCodePhase('task-spec-1');
    expect(events.some(e =>
      e.type === 'human.intervention'
      && (e.data.phase as string) === 'code-phase-qa-release-failed',
    )).toBe(true);
  });
});

describe('AgentManager.startSession status gate', () => {
  it('rejects terminal task even when bypassTaskStatusGate=true', async () => {
    // bypass 只用于跳过 expectedStatuses gate (dispatch 在 task 仍处 pre-status 时主动驱动)，
    // 不能让 cancelled/failed/merged/max_rounds 的任务再启动 — 否则 QA 会在 task 已 cancel 后
    // 仍然 emit signal / 写 commit。
    await seedTask({ status: 'cancelled' });
    await seedAgent({ id: 'qa-1' });

    const result = await manager.startSession('task-1', 'qa-1', 'server-spec-review', {
      bypassTaskStatusGate: true,
    });
    expect(result).toBe(false);
    // task 状态不应被改回 in_progress / review 之类。
    expect((await taskStore.get('task-1'))?.status).toBe('cancelled');
  });
});

describe('injectedSkills dedup across phase dispatches', () => {
  function workdirRunner(): CommandRunner {
    return {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('git worktree add')) return { stdout: '', stderr: '', exitCode: 0 };
        if (cmd.includes('git rev-parse')) return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async () => undefined),
    };
  }

  type InjectAck = (tmux: TmuxManager, paneId: string, prompt: string, agentId: string, runtime: 'claude-code' | 'codex') => Promise<{ acked: boolean; composerDelivered: boolean }>;
  function spyInject(mgr: AgentManager, impl: InjectAck): void {
    vi.spyOn(mgr as unknown as { injectAndAwaitAck: InjectAck }, 'injectAndAwaitAck').mockImplementation(impl);
  }

  function capturePrompts(mgr: AgentManager, opts: { acked?: boolean; composerDelivered?: boolean } = {}): string[] {
    const prompts: string[] = [];
    const acked = opts.acked ?? true;
    const composerDelivered = opts.composerDelivered ?? true;
    spyInject(mgr, async (_tmux, _paneId, prompt) => {
      prompts.push(prompt);
      return { acked, composerDelivered };
    });
    return prompts;
  }

  // ensureSession resolves to a reused pane unless overridden (createdSession/freshRuntime/paneId).
  function mockEnsureSession(over: { createdSession?: boolean; freshRuntime?: boolean; paneId?: string } = {}): void {
    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%0', workdir: '/tmp/repo', ...over,
    });
  }

  function useWorkdirRunner(): void {
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => workdirRunner();
  }

  const persistInjectedSkills = (
    agentId: string, taskId: string, paneId: string, role: 'dev' | 'qa', phase: string, reuse: string[] | null,
  ): Promise<void> => (manager as unknown as {
    persistInjectedSkills: (a: string, t: string, p: string, r: 'dev' | 'qa', ph: string, reuse: string[] | null) => Promise<void>;
  }).persistInjectedSkills(agentId, taskId, paneId, role, phase, reuse);

  type ProvisionFn = (runner: CommandRunner, agent: AgentConfig, workdir: string) => Promise<void>;
  const provision = (mgr: AgentManager): ProvisionFn =>
    (mgr as unknown as { provisionRepoSkills: ProvisionFn }).provisionRepoSkills.bind(mgr);

  function agentConfig(over: Partial<AgentConfig> & { id: string }): AgentConfig {
    return { projectId: 'proj', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp/repo', ...over } as unknown as AgentConfig;
  }

  it('startSession on a fresh agent inlines full phase skills and records the set', async () => {
    const t = await seedTask({ id: 'task-dedup-1', branch: 'bx/task-dedup-1' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await lockManager.acquire('dev-1');

    mockEnsureSession();
    const prompts = capturePrompts(manager);
    useWorkdirRunner();

    const ok = await manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);

    expect(prompts.length).toBe(1);
    expect(prompts[0].startsWith('/baxian-task-check\n')).toBe(true);
    expect(prompts[0]).toContain('<!-- baxian:managed -->');

    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills?.taskId).toBe(t.id);
    expect(state?.injectedSkills?.paneId).toBe('%0');
    expect(state?.injectedSkills?.skills.sort()).toEqual(['baxian-task-check']);
  });

  it('startSession develop prompt drops the spec route when the dev has no QA partner', async () => {
    const t = await seedTask({ id: 'task-noqa-1', branch: 'bx/task-noqa-1', signalToken: 'devtok1234ab' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await lockManager.acquire('dev-1');

    mockEnsureSession();
    vi.spyOn(manager, 'findQaPartner').mockReturnValue(undefined);
    const prompts = capturePrompts(manager);
    useWorkdirRunner();

    const ok = await manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);
    expect(prompts[0]).toContain('[bx:pr-created:');
    expect(prompts[0]).not.toContain('Specification-Driven Development (SDD)');
    expect(prompts[0]).not.toContain('[bx:spec-done:');
  });

  it('startSession develop prompt keeps the spec route when the config pair has a QA', async () => {
    const t = await seedTask({ id: 'task-hasqa-1', branch: 'bx/task-hasqa-1', signalToken: 'devtok5678cd' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await lockManager.acquire('dev-1');

    mockEnsureSession();
    const prompts = capturePrompts(manager);
    useWorkdirRunner();

    const ok = await manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);
    expect(prompts[0]).toContain('Specification-Driven Development (SDD)');
    expect(prompts[0]).toContain('[bx:spec-done:');
  });

  it('startSession marks bootstrappingTaskId during dispatch and clears it once the prompt is ack\'d', async () => {
    const t = await seedTask({ id: 'task-deliver-1', branch: 'bx/task-deliver-1' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await lockManager.acquire('dev-1');
    expect((await agentStore.get('dev-1'))?.bootstrappingTaskId).toBeUndefined();

    mockEnsureSession();
    let markerDuringInject: string | undefined;
    spyInject(manager, async () => {
      // After the running-binding write, before ack: the in-flight marker must name this task.
      markerDuringInject = (await agentStore.get('dev-1'))?.bootstrappingTaskId;
      return { acked: true, composerDelivered: true };
    });
    // The marker must be cleared BEFORE the slower post-ack steps (session.started emit), so a crash in
    // that window can't leave recover() re-dispatching an already-running prompt.
    let markerAtSessionStarted: string | undefined = 'unset';
    const realEmit = eventBus.emit.bind(eventBus);
    vi.spyOn(eventBus, 'emit').mockImplementation(async (ev) => {
      if (ev.type === 'session.started') markerAtSessionStarted = (await agentStore.get('dev-1'))?.bootstrappingTaskId;
      return realEmit(ev);
    });
    useWorkdirRunner();

    const ok = await manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);
    expect(markerDuringInject).toBe(t.id);
    expect(markerAtSessionStarted).toBeUndefined();
    expect((await agentStore.get('dev-1'))?.bootstrappingTaskId).toBeUndefined();
  });

  it('startSession holds (not destructively cleans up) when clearing the bootstrap marker fails after delivery', async () => {
    // The prompt is already delivered; a storage blip clearing the marker must NOT fall into the
    // dispatch-failure path (worktree remove + rollback) — it holds for human and keeps the worktree.
    const t = await seedTask({ id: 'task-deliver-2', branch: 'bx/task-deliver-2' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await lockManager.acquire('dev-1');

    mockEnsureSession();
    useWorkdirRunner();

    // Make only the marker-clear write fail — it's the first agentStore write after ack; let the rest pass.
    let afterAck = false;
    let threwOnce = false;
    spyInject(manager, async () => { afterAck = true; return { acked: true, composerDelivered: true }; });
    const realUpdate = agentStore.update.bind(agentStore);
    vi.spyOn(agentStore, 'update').mockImplementation(async (id, updater) => {
      if (afterAck && !threwOnce) { threwOnce = true; throw new Error('marker-clear write blip'); }
      return realUpdate(id, updater);
    });
    const holdSpy = vi.spyOn(manager, 'markAwaitingHuman').mockResolvedValue();
    const removeSpy = vi.spyOn(WorktreeManager.prototype, 'remove').mockResolvedValue(undefined);

    const ok = await manager.startSession(t.id, 'dev-1', 'develop');

    expect(ok).toBe(true); // delivery succeeded — not reported as a dispatch failure
    expect(removeSpy).not.toHaveBeenCalled(); // worktree NOT torn down
    expect(holdSpy).toHaveBeenCalledWith(
      'dev-1', 'bootstrap-marker-clear-failed', expect.any(String), { expectedTaskId: t.id },
    );
  });

  it('continueSession with matching (taskId, paneId) omits the <skills> tag entirely when phase skills are all already injected', async () => {
    const t = await seedTask({ id: 'task-dedup-2', branch: 'bx/task-dedup-2', status: 'approved' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      worktreePath: '/tmp/repo/.baxian-worktrees/wt',
      injectedSkills: { taskId: t.id, paneId: '%0', skills: ['baxian-pr-feedback'] },
    });
    await lockManager.acquire('dev-1');
    await manager['postApproveStore'].set(t.id, { token: 'tok', approvedHeadSha: 'sha' });

    mockEnsureSession();
    const prompts = capturePrompts(manager);
    useWorkdirRunner();

    const ok = await manager.continueSession(t.id, 'dev-1', 'post-approve', { signalToken: 'tok' });
    expect(ok).toBe(true);

    expect(prompts.length).toBe(1);
    expect(prompts[0]).not.toContain('<skills>');
    expect(prompts[0]).not.toContain('</skills>');
    // primary already resident → no leading command, prompt opens on the task header.
    expect(prompts[0].startsWith('Phase:')).toBe(true);
    expect(prompts[0]).not.toMatch(/^[/$]baxian-/);
    expect(prompts[0]).toContain('Post-approve PR feedback check');

    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills?.skills.sort()).toEqual(['baxian-pr-feedback']);
  });

  it('continueSession with a different paneId resets dedup — full skills re-injected', async () => {
    const t = await seedTask({ id: 'task-dedup-3', branch: 'bx/task-dedup-3', status: 'approved' });
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%9', updatedAt: NOW,
      worktreePath: '/tmp/repo/.baxian-worktrees/wt',
      injectedSkills: { taskId: t.id, paneId: '%0', skills: ['baxian-pr-feedback'] },
    });
    await lockManager.acquire('dev-1');
    await manager['postApproveStore'].set(t.id, { token: 'tok', approvedHeadSha: 'sha' });

    mockEnsureSession({ paneId: '%9' });
    const prompts = capturePrompts(manager);
    useWorkdirRunner();

    const ok = await manager.continueSession(t.id, 'dev-1', 'post-approve', { signalToken: 'tok' });
    expect(ok).toBe(true);

    expect(prompts[0].startsWith('/baxian-pr-feedback\n')).toBe(true);

    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills?.paneId).toBe('%9');
    expect(state?.injectedSkills?.skills.sort()).toEqual(['baxian-pr-feedback']);
  });

  it('startSession on a freshly-created tmux session re-injects full skills even when paneId string matches', async () => {
    // tmux server / session 重启后 buildFreshSession 跑过，paneId 字符串可能与旧记录恰好相同
    // （fresh server 第一个 pane 通常就是 %0）。此时 REPL 是全新的，绝不能让 dedup 沿用旧 skill 集。
    const t = await seedTask({ id: 'task-fresh-pane', branch: 'bx/task-fresh-pane' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      injectedSkills: { taskId: t.id, paneId: '%0', skills: ['baxian-task-check'] },
    });
    await lockManager.acquire('dev-1');

    mockEnsureSession({ createdSession: true, freshRuntime: true });
    const prompts = capturePrompts(manager);
    useWorkdirRunner();

    const ok = await manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);

    expect(prompts.length).toBe(1);
    expect(prompts[0].startsWith('/baxian-task-check\n')).toBe(true);
    expect(prompts[0]).not.toContain('<skills></skills>');

    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills?.taskId).toBe(t.id);
    expect(state?.injectedSkills?.paneId).toBe('%0');
    expect(state?.injectedSkills?.skills.sort()).toEqual(['baxian-task-check']);
  });

  it('continueSession on a freshly-created tmux session re-injects full skills even when paneId string matches', async () => {
    const t = await seedTask({ id: 'task-fresh-pane-cont', branch: 'bx/task-fresh-pane-cont', status: 'approved' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      worktreePath: '/tmp/repo/.baxian-worktrees/wt',
      injectedSkills: { taskId: t.id, paneId: '%0', skills: ['baxian-pr-feedback'] },
    });
    await lockManager.acquire('dev-1');
    await manager['postApproveStore'].set(t.id, { token: 'tok', approvedHeadSha: 'sha' });

    mockEnsureSession({ createdSession: true, freshRuntime: true });
    const prompts = capturePrompts(manager);
    useWorkdirRunner();

    const ok = await manager.continueSession(t.id, 'dev-1', 'post-approve', { signalToken: 'tok' });
    expect(ok).toBe(true);

    expect(prompts.length).toBe(1);
    expect(prompts[0].startsWith('/baxian-pr-feedback\n')).toBe(true);
    expect(prompts[0]).not.toContain('<skills></skills>');

    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills?.skills.sort()).toEqual(['baxian-pr-feedback']);
  });

  it('continueSession post-approve: freshRuntime suppresses incremental nudge — full preamble always sent', async () => {
    const t = await seedTask({ id: 'task-fresh-redispatch', branch: 'bx/task-fresh-redispatch', status: 'approved' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      worktreePath: '/tmp/repo/.baxian-worktrees/wt',
    });
    await lockManager.acquire('dev-1');
    await manager['postApproveStore'].set(t.id, {
      token: 'tok', approvedHeadSha: 'sha', redispatchCount: 5,
    });

    // freshRuntime=true: tmux/REPL 刚新建，旧 post-approve 上下文已丢失。
    mockEnsureSession({ createdSession: true, freshRuntime: true });
    const prompts = capturePrompts(manager);
    useWorkdirRunner();

    const ok = await manager.continueSession(t.id, 'dev-1', 'post-approve', {
      signalToken: 'tok',
      postApproveRedispatchCount: 5,
    });
    expect(ok).toBe(true);

    expect(prompts.length).toBe(1);
    // 完整 preamble，不是短 nudge。
    expect(prompts[0]).toContain('Post-approve PR feedback check:');
    expect(prompts[0]).toContain('T_self');
    expect(prompts[0]).toContain('Idempotency');
    expect(prompts[0]).toContain('Do not merge the PR yourself from this phase');
    expect(prompts[0]).not.toContain('Post-approve recheck (redispatch');
  });

  it('continueSession post-approve: reused runtime + redispatchCount>0 uses incremental nudge', async () => {
    const t = await seedTask({ id: 'task-reuse-redispatch', branch: 'bx/task-reuse-redispatch', status: 'approved' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      worktreePath: '/tmp/repo/.baxian-worktrees/wt',
      injectedSkills: { taskId: t.id, paneId: '%0', skills: ['baxian-pr-feedback'] },
    });
    await lockManager.acquire('dev-1');
    await manager['postApproveStore'].set(t.id, {
      token: 'tok', approvedHeadSha: 'sha', redispatchCount: 2,
    });

    mockEnsureSession();
    const prompts = capturePrompts(manager);
    useWorkdirRunner();

    const ok = await manager.continueSession(t.id, 'dev-1', 'post-approve', {
      signalToken: 'tok',
      postApproveRedispatchCount: 2,
    });
    expect(ok).toBe(true);

    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain('Post-approve recheck (redispatch #2)');
    expect(prompts[0]).not.toContain('Post-approve PR feedback check:');
  });

  it('persistInjectedSkills skips agentStore write when phase brings no new skill', async () => {
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: 't-no-write', paneId: '%0', updatedAt: NOW,
      injectedSkills: { taskId: 't-no-write', paneId: '%0', skills: ['baxian-task-check'] },
    });
    const setSpy = vi.spyOn(agentStore, 'set');
    await persistInjectedSkills('dev-1', 't-no-write', '%0', 'dev', 'develop', ['baxian-task-check']);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('persistInjectedSkills writes baseline when reuseInjectedSkills is null (fresh REPL)', async () => {
    await seedAgent({ id: 'dev-1', taskId: 't-fresh-base', paneId: '%0' });
    await persistInjectedSkills('dev-1', 't-fresh-base', '%0', 'dev', 'develop', null);
    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills?.taskId).toBe('t-fresh-base');
    expect(state?.injectedSkills?.skills.sort()).toEqual(['baxian-task-check']);
  });

  it('persistInjectedSkills writes when phase introduces a skill not yet in baseList', async () => {
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: 't-add', paneId: '%0', updatedAt: NOW,
      injectedSkills: { taskId: 't-add', paneId: '%0', skills: ['baxian-pr-feedback'] },
    });
    await persistInjectedSkills('dev-1', 't-add', '%0', 'dev', 'develop', ['baxian-pr-feedback']);
    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills?.skills.sort()).toEqual(['baxian-pr-feedback', 'baxian-task-check']);
  });

  it('startSession resets dedup when adoptOrRestartSession relaunches REPL inside an existing pane (createdSession=false, freshRuntime=true)', async () => {
    // adoptOrRestartSession 的 shell 重启 / trust-dialog 分支会在同一 paneId 上重新启动 REPL，
    // 仍返回 createdSession=false——只看 createdSession 会误判上下文未变，进而沿用旧 skill 集
    // 让下一轮派发空 <skills/>。这里专测：paneId 字符串相同 + 旧 injectedSkills 完备 + freshRuntime=true
    // → 必须全量重注入 + 落盘新 baseline。
    const t = await seedTask({ id: 'task-pane-relaunch', branch: 'bx/task-pane-relaunch' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      injectedSkills: { taskId: t.id, paneId: '%0', skills: ['baxian-task-check'] },
    });
    await lockManager.acquire('dev-1');

    mockEnsureSession({ freshRuntime: true });
    const prompts = capturePrompts(manager);
    useWorkdirRunner();

    const ok = await manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);

    expect(prompts.length).toBe(1);
    expect(prompts[0].startsWith('/baxian-task-check\n')).toBe(true);
    expect(prompts[0]).not.toContain('<skills></skills>');

    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills?.taskId).toBe(t.id);
    expect(state?.injectedSkills?.paneId).toBe('%0');
    expect(state?.injectedSkills?.skills.sort()).toEqual(['baxian-task-check']);
  });

  it('continueSession resets dedup when adoptOrRestartSession relaunches REPL inside an existing pane', async () => {
    const t = await seedTask({ id: 'task-pane-relaunch-cont', branch: 'bx/task-pane-relaunch-cont', status: 'approved' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      worktreePath: '/tmp/repo/.baxian-worktrees/wt',
      injectedSkills: { taskId: t.id, paneId: '%0', skills: ['baxian-pr-feedback'] },
    });
    await lockManager.acquire('dev-1');
    await manager['postApproveStore'].set(t.id, { token: 'tok', approvedHeadSha: 'sha' });

    mockEnsureSession({ freshRuntime: true });
    const prompts = capturePrompts(manager);
    useWorkdirRunner();

    const ok = await manager.continueSession(t.id, 'dev-1', 'post-approve', { signalToken: 'tok' });
    expect(ok).toBe(true);

    expect(prompts[0].startsWith('/baxian-pr-feedback\n')).toBe(true);
    expect(prompts[0]).not.toContain('<skills></skills>');

    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills?.skills.sort()).toEqual(['baxian-pr-feedback']);
  });

  it('startSession records injectedSkills even when injectAndAwaitAck returns acked=false — paste delivered the skills', async () => {
    const t = await seedTask({ id: 'task-ack-false', branch: 'bx/task-ack-false' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await lockManager.acquire('dev-1');

    mockEnsureSession();
    capturePrompts(manager, { acked: false });
    useWorkdirRunner();

    const ok = await manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);

    // 即便首个 Enter 被吞（ack 超时），skill 文本已 paste 进 pane → 落 dedup baseline，
    // 避免下一轮派发整组重注入（SKILLS 重复注入根因）。
    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills?.taskId).toBe(t.id);
    expect(state?.injectedSkills?.paneId).toBe('%0');
    expect(state?.injectedSkills?.skills.sort()).toEqual(['baxian-task-check']);
  });

  it('continueSession expands injectedSkills even when injectAndAwaitAck returns acked=false', async () => {
    const t = await seedTask({ id: 'task-ack-false-cont', branch: 'bx/task-ack-false-cont', status: 'approved' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      worktreePath: '/tmp/repo/.baxian-worktrees/wt',
      injectedSkills: { taskId: t.id, paneId: '%0', skills: ['baxian-task-check'] },
    });
    await lockManager.acquire('dev-1');
    await manager['postApproveStore'].set(t.id, { token: 'tok', approvedHeadSha: 'sha' });

    mockEnsureSession();
    capturePrompts(manager, { acked: false });
    useWorkdirRunner();

    const ok = await manager.continueSession(t.id, 'dev-1', 'post-approve', { signalToken: 'tok' });
    expect(ok).toBe(true);

    // post-approve phase skill = baxian-pr-feedback；paste 后即合并落盘，与 ack 无关。
    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills?.skills.sort()).toEqual(['baxian-pr-feedback', 'baxian-task-check']);
  });

  it('does NOT record injectedSkills when paste landed on a busy baseline', async () => {
    const t = await seedTask({ id: 'task-busy-baseline', branch: 'bx/task-busy-baseline' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await lockManager.acquire('dev-1');

    mockEnsureSession();
    // Busy-baseline race: ack timed out AND the prompt was pasted into a running input stream, not an
    // idle composer → skills never entered context → baseline must stay empty (else recovery loses skills).
    capturePrompts(manager, { acked: false, composerDelivered: false });
    useWorkdirRunner();

    const ok = await manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);

    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills).toBeUndefined();
  });

  it('startSession on a different taskId resets a stale injectedSkills record', async () => {
    const t = await seedTask({ id: 'task-dedup-4', branch: 'bx/task-dedup-4' });
    // Agent currently bound to t but carries a STALE injectedSkills record from a prior task.
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      injectedSkills: { taskId: 'task-OLD', paneId: '%0', skills: ['baxian-task-check'] },
    });
    await lockManager.acquire('dev-1');

    mockEnsureSession();
    const prompts = capturePrompts(manager);
    useWorkdirRunner();

    const ok = await manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);

    expect(prompts[0].startsWith('/baxian-task-check\n')).toBe(true);

    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills?.taskId).toBe(t.id);
    expect(state?.injectedSkills?.skills.sort()).toEqual(['baxian-task-check']);
  });

  it('provisionRepoSkills materializes skills under .claude/skills for claude-code and .agents/skills for codex', async () => {
    // provisionRepoSkills runs inside ensureSession (fresh launch, adopt, and restart
    // all funnel through it). Its writeFile transport records every materialized path.
    function capturingRunner(): { exec: ReturnType<typeof vi.fn>; writeFile: ReturnType<typeof vi.fn> } {
      return {
        exec: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
        writeFile: vi.fn(async (): Promise<void> => undefined),
      };
    }
    const devAgent = agentConfig({ id: 'dev-1' });
    const devRunner = capturingRunner();
    await provision(manager)(devRunner as unknown as CommandRunner, devAgent, '/tmp/repo');
    // Atomic per-file replace: every skill file is staged as a sibling `.baxian-tmp` (writeFile never
    // targets the live final path) then `mv -f`'d into place, so a concurrent lazy SKILL.md read is
    // never blanked or half-written.
    const devStaged = devRunner.writeFile.mock.calls.map(c => c[0] as string);
    expect(devStaged).toContain('/tmp/repo/.claude/skills/baxian-task-check/SKILL.md.baxian-tmp');
    expect(devStaged.every(p => p.endsWith('.baxian-tmp'))).toBe(true);
    expect(devStaged.every(p => !p.includes('/.agents/skills/'))).toBe(true);
    const devMv = devRunner.exec.mock.calls.map(c => c[0] as string).filter(c => c.includes('mv -f'));
    expect(devMv.some(c => c.includes('.claude/skills/baxian-task-check/SKILL.md.baxian-tmp'))).toBe(true);
    expect(devMv.length).toBe(devStaged.length); // one atomic rename per staged file
    // Excludes ONLY the baxian-* dirs baxian writes, NOT the whole skills dir — a user
    // repo's own untracked native skills there must stay visible.
    const excludeCmd = devRunner.exec.mock.calls.map(c => c[0] as string).find(c => c.includes('info/exclude'));
    expect(excludeCmd).toBeDefined();
    expect(excludeCmd).toContain('.claude/skills/baxian-*');
    expect(excludeCmd).not.toContain("'.claude/skills/'");
    expect(excludeCmd).toContain('sh -c'); // POSIX sh, not the user's (maybe fish) login shell
    expect(excludeCmd).toContain('show-prefix'); // workdir-relative prefix when workdir is a repo subdir
    // Symlink-safe, non-blanking cleanup: prune only baxian-* dirs NOT in the registry (allowlist,
    // not delete-all), fail fast (readlink) on a symlinked parent, all under `sh -c` (POSIX, not fish).
    const guardCmd = devRunner.exec.mock.calls.map(c => c[0] as string).find(c => c.includes('[ -L'));
    expect(guardCmd).toBeDefined();
    expect(guardCmd).toContain('sh -c');
    expect(guardCmd).toContain('find .claude/skills -maxdepth 1 -name');
    expect(guardCmd).toContain('baxian-*');
    expect(guardCmd).toContain('! -name'); // allowlist prune keeps current skills in place
    expect(guardCmd).toContain('readlink'); // parent symlink → actionable fail-fast, not silent rm
    expect(guardCmd).toContain('-type l -exec rm -f'); // strip leaf AND nested symlinks (write can't escape workdir)
    expect(guardCmd).toContain('-type f ! -name'); // drop stale helper files...
    expect(guardCmd).toContain('SKILL.md'); // ...but keep SKILL.md so a concurrent live read is never blanked

    const qaAgent = agentConfig({ id: 'qa-1', runtime: 'codex', role: 'qa' });
    const qaRunner = capturingRunner();
    await provision(manager)(qaRunner as unknown as CommandRunner, qaAgent, '/tmp/repo');
    const qaStaged = qaRunner.writeFile.mock.calls.map(c => c[0] as string);
    expect(qaStaged).toContain('/tmp/repo/.agents/skills/baxian-pr-review/SKILL.md.baxian-tmp');
    expect(qaStaged.every(p => !p.includes('/.claude/skills/'))).toBe(true);
  });

  it('provisionRepoSkills treats info/exclude failure as best-effort (does not block the session)', async () => {
    const runner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> =>
        cmd.includes('info/exclude')
          ? { stdout: '', stderr: 'fatal: not a git repository', exitCode: 1 }
          : { stdout: '', stderr: '', exitCode: 0 }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const agent = agentConfig({ id: 'dev-1' });
    // Skills are already materialized, so a non-git workdir / git hiccup must not throw.
    await expect(provision(manager)(runner as unknown as CommandRunner, agent, '/tmp/repo')).resolves.toBeUndefined();
    expect(runner.writeFile.mock.calls.some(c => (c[0] as string).includes('/.claude/skills/baxian-task-check/SKILL.md'))).toBe(true);
  });

  it('provisionRepoSkills re-materializes on every call — no skip cache (hot-reload of workdir/runtime + tamper safe)', async () => {
    const runner = {
      exec: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const agent = agentConfig({ id: 'dev-nocache', workdir: '/repo-a' });
    await provision(manager)(runner as unknown as CommandRunner, agent, '/repo-a');
    expect(runner.writeFile.mock.calls.length).toBeGreaterThan(0);
    runner.writeFile.mockClear();
    // SAME agent id + same skills version, but config hot-reload repointed workdir → must
    // re-materialize into the NEW dir (a skip cache keyed on agentId+version would not).
    await provision(manager)(runner as unknown as CommandRunner, agent, '/repo-b');
    const written = runner.writeFile.mock.calls.map(c => c[0] as string);
    expect(written.some(p => p.includes('/repo-b/.claude/skills/baxian-task-check/SKILL.md'))).toBe(true);
  });

  it('provisionRepoSkills serializes concurrent same-dir provisioning (no overlapping cleanup)', async () => {
    let active = 0;
    let maxActive = 0;
    const runner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('[ -L')) { // the ensureSkillDirSafe cleanup section
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise(r => setTimeout(r, 5));
          active -= 1;
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const agent = agentConfig({ id: 'dev-race', workdir: '/repo' });
    await Promise.all([
      provision(manager)(runner as unknown as CommandRunner, agent, '/repo'),
      provision(manager)(runner as unknown as CommandRunner, agent, '/repo'),
    ]);
    expect(maxActive).toBe(1); // the per-dir lock kept the two cleanup sections from overlapping
  });

  it('provisionRepoSkills fails fast on a symlinked parent skills dir (no silent rm of user config)', async () => {
    // The cleanup section exits non-zero when a parent component is a symlink (codex supports
    // symlinked skill folders — baxian must not follow it out of workdir nor silently delete it).
    const runner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> =>
        cmd.includes('[ -L')
          ? { stdout: '', stderr: 'baxian: .claude/skills is a symlink -> /shared/skills; replace it with a real directory', exitCode: 3 }
          : { stdout: '', stderr: '', exitCode: 0 }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const agent = agentConfig({ id: 'dev-sym' });
    await expect(provision(manager)(runner as unknown as CommandRunner, agent, '/tmp/repo')).rejects.toThrow(/symlink-safe/);
    // Fail-fast precedes materialize: nothing is written THROUGH the symlinked parent.
    expect(runner.writeFile.mock.calls.length).toBe(0);
  });

  it('skillDirLockKey canonicalizes host + workdir so equivalent agents serialize', async () => {
    // A registry host id and the equivalent inline host must collapse to one key, and a trailing
    // slash on the workdir must not fork the lock — else two agents on the same physical dir race.
    const skillRegistry = new SkillRegistry(join(tempDir, 'skills'));
    await skillRegistry.scan();
    const cfg: BaxianConfig = { ...CONFIG, host: [{ id: 'box', hostname: 'h', user: 'u', port: 22 }] };
    const m = makeManager({ config: cfg, skillRegistry });
    const key = (a: object, w: string) =>
      (m as unknown as { skillDirLockKey: (a: AgentConfig, w: string) => string }).skillDirLockKey(a as AgentConfig, w);
    const byId = { runtime: 'claude-code', mode: 'remote', host: 'box' };
    const byInline = { runtime: 'claude-code', mode: 'remote', host: { hostname: 'h', user: 'u', port: 22 } };
    expect(key(byId, '/repo')).toBe(key(byInline, '/repo')); // id vs inline → same host group
    expect(key(byId, '/repo/')).toBe(key(byId, '/repo')); // trailing slash normalized away
    expect(key(byId, '/other')).not.toBe(key(byId, '/repo')); // genuinely different dir → distinct
    expect(key({ ...byId, runtime: 'codex' }, '/repo')).not.toBe(key(byId, '/repo')); // runtime subdir differs
  });
});

describe('AgentManager runtime menu marker', () => {
  it('emits human.intervention once while a menu remains visible', async () => {
    let captures = 0;
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('capture-pane')) {
          captures += 1;
          return {
            stdout: captures <= 2
              ? 'Enter to confirm · Esc to cancel'
              : '⏵⏵ bypass permissions on /tmp/repo\n\n>',
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    manager = makeManager({ skillRegistry: freshRegistry(), runnerFactory: () => runner });
    manager['runtimeMenuPollIntervalMs'] = 5;
    await seedTask();
    await seedAgent({
      id: 'dev-1',
      taskId: 'task-1',
      paneId: '%0',
    });

    manager.startRuntimeMenuWatch('dev-1');
    await waitUntil(() => events.some(e => e.type === 'human.intervention'));
    await new Promise(resolve => setTimeout(resolve, 30));

    const interventions = events.filter(e => e.type === 'human.intervention');
    expect(interventions).toHaveLength(1);
    expect(interventions[0].data.phase).toBe('agent_runtime_menu_pending');
    expect((await agentStore.get('dev-1'))?.taskId).toBe('task-1');
  });
});

describe('cancelTask interrupts (ESC) then /clears dev and qa panes', () => {
  it('sends ESC then /clear on both dev and qa, then clears both bindings', async () => {
    const sentKeys: string[] = [];
    const localManager = makeManager({
      skillRegistry: freshRegistry(),
      runnerFactory: () => clearAwareRunner(sentKeys, pane => (pane === '%1' ? CODEX_PANE : CLAUDE_PANE)),
    });
    setCompactTiming(localManager);

    const t = await seedTask({ qaAgentId: 'qa-1' });
    await seedAgent({
      id: 'dev-1',
      taskId: t.id,
      paneId: '%0',
    });
    await seedAgent({
      id: 'qa-1',
      taskId: t.id,
      paneId: '%1',
    });
    await lockManager.acquire('dev-1');
    await lockManager.acquire('qa-1');

    const cancelled = await localManager.cancelTask(t.id);

    expect(cancelled.status).toBe('cancelled');
    const escKeys = sentKeys.filter(k => k.includes("'Escape'"));
    const clearKeys = sentKeys.filter(k => k.includes('send-keys -l') && k.includes('/clear'));
    expect(escKeys.length).toBeGreaterThanOrEqual(2);
    expect(clearKeys.length).toBeGreaterThanOrEqual(2);
    // dev pane sequence: ESC (interrupt the turn) → C-c (clear any leftover composer) → /clear (wipe context).
    const escAt = sentKeys.findIndex(k => k.includes('%0') && k.includes("'Escape'"));
    const ccAt = sentKeys.findIndex(k => k.includes('%0') && k.includes('C-c'));
    const clearAt = sentKeys.findIndex(k => k.includes('%0') && k.includes('send-keys -l') && k.includes('/clear'));
    expect(escAt).toBeGreaterThanOrEqual(0);
    expect(ccAt).toBeGreaterThan(escAt);
    expect(clearAt).toBeGreaterThan(ccAt);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
    expect(await lockManager.isLocked('qa-1')).toBe(false);
  });

  it('clears the composer (C-c) before /clear so an ack-timeout-left prompt is not submitted with /clear', async () => {
    const sentKeys: string[] = [];
    const localManager = makeManager({
      skillRegistry: freshRegistry(),
      runnerFactory: () => clearAwareRunner(sentKeys, () => CLAUDE_PANE),
    });
    setCompactTiming(localManager);

    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await lockManager.acquire('dev-1');

    const cancelled = await localManager.cancelTask(t.id);
    expect(cancelled.status).toBe('cancelled');

    const ccAt = sentKeys.findIndex(k => k.includes('C-c'));
    const clearAt = sentKeys.findIndex(k => k.includes('send-keys -l') && k.includes('/clear'));
    const enterAfterClear = sentKeys.findIndex((k, i) => i > clearAt && k.includes("'Enter'"));
    // composer cleared (C-c) strictly before /clear is typed; the submitting Enter comes after /clear —
    // so /clear lands on an empty line and the cancelled prompt is never co-submitted.
    expect(ccAt).toBeGreaterThanOrEqual(0);
    expect(clearAt).toBeGreaterThan(ccAt);
    expect(enterAfterClear).toBeGreaterThan(clearAt);
    // confirmed clear → agent released.
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('skips interrupt/clear and release when agent has been rebound to a new task (race protection)', async () => {
    const sentKeys: string[] = [];
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('send-keys')) {
          sentKeys.push(cmd);
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('display-message') && cmd.includes('pane_current_command')) {
          return { stdout: 'claude\n', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          return { stdout: '⏵⏵ bypass permissions on /tmp/repo\n\n>', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const localManager = makeManager({ skillRegistry: freshRegistry(), runnerFactory: () => runner });

    const oldTask = task({ id: 'task-old' });
    const newTask = task({ id: 'task-new' });
    await taskStore.set(oldTask);
    await taskStore.set(newTask);
    await seedAgent({
      id: 'dev-1',
      taskId: oldTask.id,
      paneId: '%0',
    });
    await lockManager.acquire('dev-1');

    // 用 spy 模拟"race": withTaskLock 一释放，另一路就把 dev-1 重绑到 task-new。
    const realAgentGet = agentStore.get.bind(agentStore);
    let switched = false;
    vi.spyOn(agentStore, 'get').mockImplementation(async (id: string) => {
      if (id === 'dev-1' && !switched) {
        switched = true;
        const cur = await realAgentGet(id);
        if (cur) {
          await agentStore.set({ ...cur, taskId: newTask.id, updatedAt: new Date().toISOString() });
        }
        return realAgentGet(id);
      }
      return realAgentGet(id);
    });

    const cancelled = await localManager.cancelTask(oldTask.id);

    expect(cancelled.status).toBe('cancelled');
    // race 触发后 cancelTask 必须 skip 中断/清理——否则 ESC + /clear 会打到 task-new 会话上。
    expect(sentKeys.filter(k => k.includes("'Escape'"))).toHaveLength(0);
    expect(sentKeys.filter(k => k.includes('/clear'))).toHaveLength(0);
    // 不能解绑 dev-1：它现在归属 task-new。
    expect((await agentStore.get('dev-1'))?.taskId).toBe(newTask.id);
  });

  it('preserves binding and emits intervention when interrupt fails (no /clear)', async () => {
    const sentKeys: string[] = [];
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('send-keys')) sentKeys.push(cmd);
        if (cmd.includes('display-message') && cmd.includes('pane_current_command')) {
          return { stdout: 'claude\n', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          // 永远不显示 ready anchor → waitReplReady 10s 内必超时 → interruptPaneAndWaitReady 返 false
          return { stdout: 'Tool use: Bash\nstill streaming...\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const localManager = makeManager({ skillRegistry: freshRegistry(), runnerFactory: () => runner });

    // interruptPaneAndWaitReady hardcodes a 10s wait; spy it to false instead of really waiting it out.
    mockInterruptPane(localManager, false);

    const t = await seedTask();
    await seedAgent({
      id: 'dev-1',
      taskId: t.id,
      paneId: '%0',
    });
    await lockManager.acquire('dev-1');

    const cancelled = await localManager.cancelTask(t.id);

    expect(cancelled.status).toBe('cancelled');
    // 中断失败时不得 /clear：会话仍可能在运行，清理会打断/污染待人工处理的 pane。
    expect(sentKeys.filter(k => k.includes('/clear'))).toHaveLength(0);
    // 中断失败：绑定保留、lock 保留、status='awaiting_human'——下次 cancel/operator Resume 才能彻底清理
    const stateAfter = await agentStore.get('dev-1');
    expect(stateAfter?.taskId).toBe(t.id);
    expect(stateAfter?.status).toBe('awaiting_human');
    expect(stateAfter?.awaitingPhase).toBe('cancel-interrupt-failed');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    const failedEvents = events.filter(
      e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'cancel-interrupt-failed',
    );
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]).toMatchObject({
      type: 'human.intervention',
      projectId: 'proj',
      agentId: 'dev-1',
      taskId: t.id,
    });
  });

  // interrupt 成功但 /clear 注入失败：必须保留绑定并标记 cancel-clear-failed，绝不能 release——否则
  // 会把未确认清空的 pane 交给下一次 dispatch，复现 task-139 要修的脏上下文。
  it('holds the agent (no release) when /clear injection fails', async () => {
    const sentKeys: string[] = [];
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('send-keys')) {
          sentKeys.push(cmd);
          // /clear 注入失败 → clearPaneContext 抛错并返回未确认
          if (cmd.includes('send-keys -l') && cmd.includes('/clear')) {
            return { stdout: '', stderr: 'tmux send failed', exitCode: 1 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('display-message') && cmd.includes('pane_current_command')) {
          return { stdout: 'claude\n', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          return { stdout: '⏵⏵ bypass permissions on /tmp/repo\n\n>', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const localManager = makeManager({ skillRegistry: freshRegistry(), runnerFactory: () => runner });
    setCompactTiming(localManager);
    mockInterruptPane(localManager, true);

    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await lockManager.acquire('dev-1');

    const cancelled = await localManager.cancelTask(t.id);

    expect(cancelled.status).toBe('cancelled');
    expect(sentKeys.some(k => k.includes('send-keys -l') && k.includes('/clear'))).toBe(true);
    const stateAfter = await agentStore.get('dev-1');
    expect(stateAfter?.taskId).toBe(t.id);
    expect(stateAfter?.status).toBe('awaiting_human');
    expect(stateAfter?.awaitingPhase).toBe('cancel-clear-failed');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    expect(events.some(
      e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'cancel-clear-failed',
    )).toBe(true);
  });

  // compact/upload guard 被占用时无法安全注入 /clear：跳过注入但同样必须 hold，不能 release。
  it('holds the agent (no release) when the compact guard blocks /clear', async () => {
    const sentKeys: string[] = [];
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('send-keys')) sentKeys.push(cmd);
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const localManager = makeManager({ skillRegistry: freshRegistry(), runnerFactory: () => runner });
    mockInterruptPane(localManager, true);
    // 预占 compact guard，模拟并发 compact/upload。
    (localManager as unknown as { compactInFlight: Set<string> }).compactInFlight.add('dev-1');

    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await lockManager.acquire('dev-1');

    const cancelled = await localManager.cancelTask(t.id);

    expect(cancelled.status).toBe('cancelled');
    // guard 占用 → 不注入 /clear
    expect(sentKeys.some(k => k.includes('/clear'))).toBe(false);
    const stateAfter = await agentStore.get('dev-1');
    expect(stateAfter?.taskId).toBe(t.id);
    expect(stateAfter?.status).toBe('awaiting_human');
    expect(stateAfter?.awaitingPhase).toBe('cancel-clear-failed');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  // Cancel interrupts EVERY bound pane before clearing any: even when dev's /clear fails, qa must have been
  // interrupted (ESC) before dev's /clear and still get cleared + released.
  it('interrupts both panes before clearing either, so a failed dev /clear does not strand qa', async () => {
    const sentKeys: string[] = [];
    const localManager = makeManager({
      skillRegistry: freshRegistry(),
      // dev (%0) /clear injection fails → dev held; qa (%1) succeeds.
      runnerFactory: () => clearAwareRunner(
        sentKeys,
        pane => (pane === '%1' ? CODEX_PANE : CLAUDE_PANE),
        { failClear: pane => pane === '%0' },
      ),
    });
    setCompactTiming(localManager);

    const t = await seedTask({ qaAgentId: 'qa-1' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await lockManager.acquire('dev-1');
    await lockManager.acquire('qa-1');

    await localManager.cancelTask(t.id);

    // qa was interrupted (phase 1) BEFORE dev's /clear was even attempted (phase 2).
    const qaEsc = sentKeys.findIndex(k => k.includes('%1') && k.includes("'Escape'"));
    const devClear = sentKeys.findIndex(k => k.includes('%0') && k.includes('send-keys -l') && k.includes('/clear'));
    expect(qaEsc).toBeGreaterThanOrEqual(0);
    expect(devClear).toBeGreaterThanOrEqual(0);
    expect(qaEsc).toBeLessThan(devClear);
    // dev held on its failed clear; qa still cleared + released — not stranded by dev.
    const dev = await agentStore.get('dev-1');
    expect(dev?.status).toBe('awaiting_human');
    expect(dev?.awaitingPhase).toBe('cancel-clear-failed');
    expect(dev?.taskId).toBe(t.id);
    const qa = await agentStore.get('qa-1');
    expect(qa?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('qa-1')).toBe(false);
  });

  // If a late release+reassign rebinds the agent during clearPaneContext, the cancel-clear-failed mark
  // (expectedTaskId-guarded) must no-op instead of stamping the unrelated new binding as awaiting_human.
  it('does not stale-mark a rebound agent as cancel-clear-failed (release+reassign race)', async () => {
    const localManager = makeManager({ skillRegistry: freshRegistry(), runnerFactory: () => readyRunner() });
    mockInterruptPane(localManager, true);

    const t = await seedTask();
    await taskStore.set(task({ id: 'task-new' }));
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await lockManager.acquire('dev-1');

    // Simulate the race: clearPaneContext can't confirm, and meanwhile the agent got released+rebound.
    vi.spyOn(localManager as unknown as { clearPaneContext: () => Promise<boolean> }, 'clearPaneContext')
      .mockImplementation(async () => {
        // A real release+reassign yields a fresh binding (no Held fields) — model that clean rebind.
        await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'task-new', paneId: '%0', updatedAt: new Date().toISOString() });
        return false;
      });

    await localManager.cancelTask(t.id);

    // expectedTaskId guard → the late mark no-ops; the new binding is not stamped awaiting_human.
    const dev = await agentStore.get('dev-1');
    expect(dev?.taskId).toBe('task-new');
    expect(dev?.status).not.toBe('awaiting_human');
    expect(dev?.awaitingPhase).toBeUndefined();
  });

  // A cancel-clearing pane is un-cleared: NO release frees it except cancel's own (fromCancelCleanup) — not
  // a bare escape, and crucially not even an allowAwaitingHuman caller (review/max-rounds handlers etc.).
  it('refuses release of a cancel-clearing pane unless it is cancel\'s own (fromCancelCleanup)', async () => {
    const t = await seedTask({ status: 'cancelled' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await lockManager.acquire('dev-1');

    // bare escape-style release is refused → binding + lock intact.
    expect(await manager.releaseAgentForTask('dev-1', t.id, 'idle')).toBe(false);
    // allowAwaitingHuman alone (handler/escape path) must ALSO be refused — it must not bypass the hold.
    expect(await manager.releaseAgentForTask('dev-1', t.id, 'idle', { allowAwaitingHuman: true })).toBe(false);
    expect((await agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('dev-1')).toBe(true);

    // cancel's own release (fromCancelCleanup) clears the hold.
    expect(await manager.releaseAgentForTask('dev-1', t.id, 'idle', { allowAwaitingHuman: true, fromCancelCleanup: true })).toBe(true);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  // A real terminal-task escape racing in during cancel's interrupt is refused (the cancel-clearing hold is
  // persisted under the lock before the status flip), while cancel still cleans + releases both agents.
  it('blocks a concurrent terminal-task escape release while cancel is mid-cleanup', async () => {
    const localManager = makeManager({ skillRegistry: freshRegistry(), runnerFactory: () => readyRunner() });
    stubClearPane(localManager);
    const t = await seedTask({ qaAgentId: 'qa-1' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await lockManager.acquire('dev-1');
    await lockManager.acquire('qa-1');

    let escapeReleaseResult: boolean | undefined;
    // During cancel's phase-1 interrupt, fire the review.submitted-style escape release on qa once.
    vi.spyOn(localManager as unknown as { interruptPaneAndWaitReady: () => Promise<boolean> }, 'interruptPaneAndWaitReady')
      .mockImplementation(async () => {
        if (escapeReleaseResult === undefined) {
          escapeReleaseResult = await localManager.releaseAgentForTask('qa-1', t.id, 'idle');
        }
        return true;
      });

    const cancelled = await localManager.cancelTask(t.id);

    expect(cancelled.status).toBe('cancelled');
    expect(escapeReleaseResult).toBe(false); // escape refused while cancel owned the cleanup
    // cancel itself still released both (allowAwaitingHuman clears the cancel-clearing hold).
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await agentStore.get('qa-1'))?.taskId).toBeUndefined();
  });

  // The cancel-clearing hold is per-agent and only marked for agents actually bound to the cancelling task,
  // so a stale dev (already rebound to task-new) is never marked and task-new's own release isn't blocked.
  it('cancel of one task does not block a rebound agent release by its new task', async () => {
    const localManager = makeManager({ skillRegistry: freshRegistry(), runnerFactory: () => readyRunner() });
    await taskStore.set(task({ id: 'task-old', agentId: 'dev-1', qaAgentId: 'qa-1' }));
    await taskStore.set(task({ id: 'task-new', agentId: 'dev-1' }));
    // dev-1 already rebound to task-new; qa-1 still on the to-be-cancelled old task.
    await seedAgent({ id: 'dev-1', taskId: 'task-new', paneId: '%0' });
    await seedAgent({ id: 'qa-1', taskId: 'task-old', paneId: '%1' });
    await lockManager.acquire('dev-1');
    await lockManager.acquire('qa-1');

    // dev-1 is rebound → cancel skips its interrupt; qa-1 interrupt succeeds.
    vi.spyOn(localManager as unknown as { interruptPaneAndWaitReady: () => Promise<boolean> }, 'interruptPaneAndWaitReady')
      .mockResolvedValue(true);
    let devReleaseByNewTask: boolean | undefined;
    // While the old task's qa is mid /clear, task-new releases dev-1; the old cancel's guard must not block it.
    vi.spyOn(localManager as unknown as { clearPaneContext: () => Promise<boolean> }, 'clearPaneContext')
      .mockImplementation(async () => {
        if (devReleaseByNewTask === undefined) {
          devReleaseByNewTask = await localManager.releaseAgentForTask('dev-1', 'task-new', 'idle');
        }
        return true;
      });

    await localManager.cancelTask('task-old');

    expect(devReleaseByNewTask).toBe(true); // task-new's release NOT blocked by task-old's cancel guard
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined(); // released by task-new
    expect((await agentStore.get('qa-1'))?.taskId).toBeUndefined(); // cleaned + released by cancel
  });

  // A stale cancel (its task field still points at an agent now bound elsewhere) must not stamp/clear the
  // cancel-clearing hold of the agent's real owner, or the owner's dirty pane loses its protection.
  it('a stale cancel does not disturb the cancel-clearing hold of the agent\'s real owner', async () => {
    // dev-1 is actually bound to task-a (cleanup in-flight, marked cancel-clearing); task-b is stale.
    await taskStore.set(task({ id: 'task-a', agentId: 'dev-1' }));
    await taskStore.set(task({ id: 'task-b', agentId: 'dev-1' }));
    await seedAgent({ id: 'dev-1', taskId: 'task-a', paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });

    // cancelling the stale task-b must not touch dev-1 (it isn't actually bound to task-b).
    await manager.cancelTask('task-b');

    const dev = await agentStore.get('dev-1');
    expect(dev?.taskId).toBe('task-a');
    expect(dev?.awaitingPhase).toBe('cancel-clearing');
    // task-a's terminal-task escape release of the still-dirty pane is therefore still refused.
    expect(await manager.releaseAgentForTask('dev-1', 'task-a', 'idle')).toBe(false);
    expect((await agentStore.get('dev-1'))?.taskId).toBe('task-a');
  });

  // A cancel-clear-failed hold's pane is un-cleared: neither the terminal-task escape (releaseAgentForTask)
  // nor Resume may free + reuse it; only DELETE (destroys the pane) is safe.
  it('does not release a cancel-clear-failed hold via the escape or Resume', async () => {
    const t = await seedTask({ status: 'cancelled' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clear-failed' });
    await lockManager.acquire('dev-1');

    // terminal-task escape style release is refused (shouldReleaseHeldBinding=false for cancel-clear-failed).
    expect(await manager.releaseAgentForTask('dev-1', t.id, 'idle')).toBe(false);
    expect((await agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('dev-1')).toBe(true);

    // Resume refuses too — no auto-reuse of an un-cleared pane.
    const res = await manager.resumeAgent('dev-1');
    expect(res.resumed).toBe(false);
    const after = await agentStore.get('dev-1');
    expect(after?.taskId).toBe(t.id);
    expect(after?.awaitingPhase).toBe('cancel-clear-failed');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  // A swallowed /clear Enter would leave /clear idle in the composer; clearPaneContext must resend until
  // the submission is confirmed (the composer redraws) rather than release the pane still un-cleared.
  it('resends the /clear Enter when the first is swallowed, then confirms and releases', async () => {
    const sentKeys: string[] = [];
    const localManager = makeManager({
      skillRegistry: freshRegistry(),
      runnerFactory: () => clearAwareRunner(sentKeys, () => CLAUDE_PANE, { swallowClearEnters: 1 }),
    });
    setCompactTiming(localManager);
    (localManager as unknown as { clearContextWaitMs: number }).clearContextWaitMs = 2_000;

    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await lockManager.acquire('dev-1');

    const cancelled = await localManager.cancelTask(t.id);

    expect(cancelled.status).toBe('cancelled');
    // The /clear Enter was resent after the first was swallowed (≥2 Enters after the typed /clear).
    const clearAt = sentKeys.findIndex(k => k.includes('send-keys -l') && k.includes('/clear'));
    const entersAfterClear = sentKeys.filter((k, i) => i > clearAt && k.includes("'Enter'"));
    expect(entersAfterClear.length).toBeGreaterThanOrEqual(2);
    // confirmed → agent released.
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  // A /clear rejected as "disabled while a task is in progress" returns to a bare prompt that now reads ready;
  // clearPaneContext must detect the rejection toast and hold (un-cleared), not release the pane.
  it('cancel holds the pane (cancel-clear-failed) when /clear is rejected as disabled-while-task-in-progress', async () => {
    const sentKeys: string[] = [];
    const localManager = makeManager({
      skillRegistry: freshRegistry(),
      runnerFactory: () => clearAwareRunner(sentKeys, () => CLAUDE_PANE, { rejectClear: () => true }),
    });
    setCompactTiming(localManager);
    (localManager as unknown as { clearContextWaitMs: number }).clearContextWaitMs = 2_000;

    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await lockManager.acquire('dev-1');

    const cancelled = await localManager.cancelTask(t.id);

    expect(cancelled.status).toBe('cancelled');
    // rejection detected → /clear unconfirmed → pane held, NOT released for reuse.
    const dev = await agentStore.get('dev-1');
    expect(dev?.taskId).toBe(t.id);
    expect(dev?.awaitingPhase).toBe('cancel-clear-failed');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  // Cancel persists a cancel-clearing hold before the ESC→/clear window. If the process restarts mid-window,
  // recover() must keep the un-cleared pane held (not release it for reuse with the cancelled context).
  it('recover() holds a cancel-clearing agent bound to a cancelled task (restart mid-cleanup)', async () => {
    await taskStore.set(task({ id: 'task-x', status: 'cancelled', agentId: 'dev-1' }));
    await seedAgent({ id: 'dev-1', taskId: 'task-x', paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await lockManager.acquire('dev-1');
    // ensureSession (recover) returns the live pane.
    vi.spyOn(manager as unknown as { ensureSession: () => Promise<{ paneId: string }> }, 'ensureSession')
      .mockResolvedValue({ paneId: '%0' });

    await manager.recover();

    const dev = await agentStore.get('dev-1');
    expect(dev?.taskId).toBe('task-x'); // binding preserved (not released for reuse)
    expect(dev?.status).toBe('awaiting_human');
    expect(dev?.awaitingPhase).toBe('cancel-clearing');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  // cancel-interrupt-failed (pane may still be running the cancelled task) must not be AUTO-released by an
  // escape/handler (allowAwaitingHuman) or by recover(); only the operator's Resume (after verifying) may.
  it('does not auto-release a cancel-interrupt-failed pane (escape/handler), but Resume can', async () => {
    const t = await seedTask({ status: 'cancelled' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed' });
    await lockManager.acquire('dev-1');

    // allowAwaitingHuman (review/max-rounds handler / terminal-task escape) must NOT free it.
    expect(await manager.releaseAgentForTask('dev-1', t.id, 'idle', { allowAwaitingHuman: true })).toBe(false);
    expect((await agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('dev-1')).toBe(true);

    // operator Resume (human-confirmed) releases it.
    const res = await manager.resumeAgent('dev-1');
    expect(res.resumed).toBe(true);
    expect(res.releasedBinding).toBe(true);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('recover() holds a cancel-interrupt-failed agent (restart) instead of auto-releasing it', async () => {
    await taskStore.set(task({ id: 'task-y', status: 'cancelled', agentId: 'dev-1' }));
    await seedAgent({ id: 'dev-1', taskId: 'task-y', paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed' });
    await lockManager.acquire('dev-1');
    vi.spyOn(manager as unknown as { ensureSession: () => Promise<{ paneId: string }> }, 'ensureSession')
      .mockResolvedValue({ paneId: '%0' });

    await manager.recover();

    const dev = await agentStore.get('dev-1');
    expect(dev?.taskId).toBe('task-y'); // not auto-released despite the terminal task
    expect(dev?.awaitingPhase).toBe('cancel-interrupt-failed');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });
});

describe('interruptPaneAndWaitReady composer recovery', () => {
  // The method is private and does real multi-second waits; drive its control flow by spying the
  // TmuxManager methods (the instance is built inside the method, so prototype spies apply).
  function callInterrupt(
    mgr: AgentManager,
    state: AgentBindingFacts,
    cfg: AgentConfig & { projectId: string },
  ): Promise<boolean> {
    return (mgr as unknown as {
      interruptPaneAndWaitReady: (s: AgentBindingFacts, c: AgentConfig & { projectId: string }) => Promise<boolean>;
    }).interruptPaneAndWaitReady(state, cfg);
  }
  function cfgOf(mgr: AgentManager, id: string): AgentConfig & { projectId: string } {
    return (mgr as unknown as {
      getAgentConfig: (id: string) => AgentConfig & { projectId: string };
    }).getAgentConfig(id);
  }
  // Record sent keys + answer the proc-title probe with the runtime (codex → `node`) by default. Used by the
  // hold cases that never reach C-c (they set their own waitReplReady / capturePaneById).
  function spyKeys(proc = 'node'): string[] {
    const keys: string[] = [];
    vi.spyOn(TmuxManager.prototype, 'sendKeysToPane').mockImplementation(async (_p, k) => { keys.push(k); });
    vi.spyOn(TmuxManager.prototype, 'displayMessage').mockResolvedValue(proc);
    return keys;
  }
  // Simulate cancel cleanup. ESC's waitReplReady rejects (still dirty); capturePaneById returns the dirty
  // screen until a C-c is sent, then `afterCtrlC` (drives the liveness sampling). The post-C-c verify is
  // waitReplReady again — it resolves ONLY if the clear reached a ready prompt (opts.cleanAfterCtrlC, default
  // true); foreign-node / undismissed-blocker cases pass cleanAfterCtrlC:false so the verify holds.
  function spyClearFlow(dirty: string, afterCtrlC: string, opts: { proc?: string; cleanAfterCtrlC?: boolean } = {}): string[] {
    const proc = opts.proc ?? 'node';
    const cleanAfterCtrlC = opts.cleanAfterCtrlC ?? true;
    const keys: string[] = [];
    let cleared = false;
    vi.spyOn(TmuxManager.prototype, 'sendKeysToPane').mockImplementation(async (_p, k) => {
      keys.push(k);
      if (k === 'C-c') cleared = true;
    });
    vi.spyOn(TmuxManager.prototype, 'displayMessage').mockResolvedValue(proc);
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockImplementation(async () => {
      if (cleared && cleanAfterCtrlC) return; // C-c reached a clean/ready prompt
      throw new Error('repl not ready');
    });
    vi.spyOn(TmuxManager.prototype, 'capturePaneById').mockImplementation(async () => (cleared ? afterCtrlC : dirty));
    return keys;
  }

  // A cancelled Codex prompt left un-submitted in the composer (no busy markers). Cleared by C-c.
  const STUCK_COMPOSER =
    '› Title: 优化 Agent Pet 样式\n  1. Agent Pet 再放大一点点\n  2. ...\n  gpt-5.5 xhigh · ~/.baxian/repos/example-owner/example-repo\n';
  // A dirty composer whose pasted text ITSELF contains "Working (…)" / "esc to interrupt" (Issue A).
  const BUSY_LOOKING_COMPOSER =
    '› 排查 codex 卡死，日志：\n  • Working (12s)\n  esc to interrupt\n  gpt-5.5 xhigh · ~/.baxian/repos/example-owner/example-repo\n';
  // A LONG pasted prompt whose `›` first line has scrolled off the visible pane — no composer glyph visible.
  const LONG_COMPOSER_NO_GLYPH =
    'pasted diagnostics line\n'.repeat(14) + '  gpt-5.5 xhigh · ~/.baxian/repos/example-owner/example-repo\n';
  // After C-c: a cleared Codex composer shown as a bare `›` (banner/footer/placeholder scrolled off).
  const CLEARED_BARE_PROMPT = '› \n  gpt-5.5 xhigh · ~/.baxian/repos/example-owner/example-repo\n';
  // A human running `node` in a crashed Codex pane: node's `>` prompt (U+003E), never becomes a Codex `›`.
  const NODE_HUMAN_SESSION = 'running diagnostics…\n> \n';
  // A Claude dirty composer (❯ with text) → after C-c a clean empty `❯` (a ready view for Claude).
  const CLAUDE_DIRTY = '❯ 修复 web terminal 乱码\n';
  const CLAUDE_CLEARED = '❯ \n';
  // A genuinely running turn whose elapsed seconds advance across grabs (repaints → live).
  const RUNNING_TURN_A = '• Working (12s)\n  esc to interrupt\n';
  const RUNNING_TURN_B = '• Working (13s)\n  esc to interrupt\n';
  // A real running Claude turn whose spinner sits high in a tall pane and advances across grabs.
  const CLAUDE_RUN_A = '✶ Grooving… (12s)\n' + 'tool output\n'.repeat(12) + '❯ \n';
  const CLAUDE_RUN_B = '✶ Grooving… (13s)\n' + 'tool output\n'.repeat(12) + '❯ \n';
  // A static (non-live) runtime menu — C-c that doesn't dismiss it leaves no clean composer → hold.
  const RUNTIME_MENU = 'Select a model\n  Enter to confirm · Esc to cancel\n';
  // A live turn with NO busy marker visible (long tool output pushed Working/spinner off-screen), advancing.
  const GROWING_OUTPUT_A = 'building project…\n  compiled module 1\n';
  const GROWING_OUTPUT_B = 'building project…\n  compiled module 2\n';
  // A permission/confirm blocker sitting above a bare `›` — C-c that doesn't dismiss it is NOT a clean composer.
  const BLOCKER_OVER_PROMPT = 'Allow command `rm -rf`?\n  Press Enter to confirm or Esc to cancel\n› \n';

  it('C-c clears an un-submitted composer and verifies it reached a clean composer (qa-1: codex)', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(STUCK_COMPOSER, CLEARED_BARE_PROMPT);

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(true);
    expect(keys).toEqual(['Escape', 'C-c']); // C-c left a bare `›` empty composer → verified clean
  });

  it('C-c clears a dirty composer whose text contains "Working"/"esc to interrupt" (Issue A)', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(BUSY_LOOKING_COMPOSER, CLEARED_BARE_PROMPT);

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(true);
    expect(keys).toEqual(['Escape', 'C-c']); // busy-looking but static → cleared → verified clean
  });

  it('C-c clears a LONG composer whose `›` scrolled off — verified by the OUTCOME, not a visible glyph', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(LONG_COMPOSER_NO_GLYPH, CLEARED_BARE_PROMPT);

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(true);
    expect(keys).toEqual(['Escape', 'C-c']); // no visible `›` before C-c, but the cleared composer verifies
  });

  it('C-c clears a Claude dirty composer and verifies the empty ❯ prompt (dev-1: claude-code)', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(CLAUDE_DIRTY, CLAUDE_CLEARED, { proc: 'claude' });

    await seedAgent({ id: 'dev-1', paneId: '%3' });
    const ok = await callInterrupt(manager, (await agentStore.get('dev-1'))!, cfgOf(manager, 'dev-1'));

    expect(ok).toBe(true);
    expect(keys).toEqual(['Escape', 'C-c']);
  });

  it('holds (no C-c) when a turn is genuinely still running after ESC (screen changes between grabs)', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1 });
    const keys = spyKeys();
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockRejectedValue(new Error('repl not ready'));
    vi.spyOn(TmuxManager.prototype, 'capturePaneById')
      .mockResolvedValueOnce(RUNNING_TURN_A)
      .mockResolvedValueOnce(RUNNING_TURN_B);

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape']); // live turn caught before C-c → never C-c'd
  });

  it('holds (no C-c) on a real running Claude turn whose high spinner advances between grabs (dev-1)', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1 });
    const keys = spyKeys('claude');
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockRejectedValue(new Error('repl not ready'));
    vi.spyOn(TmuxManager.prototype, 'capturePaneById')
      .mockResolvedValueOnce(CLAUDE_RUN_A)
      .mockResolvedValueOnce(CLAUDE_RUN_B);

    await seedAgent({ id: 'dev-1', paneId: '%3' });
    const ok = await callInterrupt(manager, (await agentStore.get('dev-1'))!, cfgOf(manager, 'dev-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape']); // repaints → live → hold
  });

  it('holds (no C-c) when the pane is no longer running the runtime (crashed to shell)', async () => {
    const keys = spyKeys('zsh'); // proc title is not the runtime
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockRejectedValue(new Error('repl not ready'));
    const captureSpy = vi.spyOn(TmuxManager.prototype, 'capturePaneById');

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape']); // no C-c into a shell
    expect(captureSpy).not.toHaveBeenCalled(); // proc-title gate fails before any liveness probe
  });

  it('re-checks proc title right before C-c: holds (no C-c) if the runtime crashed to a shell during the liveness window', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys: string[] = [];
    vi.spyOn(TmuxManager.prototype, 'sendKeysToPane').mockImplementation(async (_p, k) => { keys.push(k); });
    // runtime at the first gate, then a shell by the time we're about to send C-c
    vi.spyOn(TmuxManager.prototype, 'displayMessage')
      .mockResolvedValueOnce('node')
      .mockResolvedValue('zsh');
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockRejectedValue(new Error('repl not ready'));
    // static (non-live) screen so paneHasLiveTurn returns false and we reach the pre-C-c re-check
    const captureSpy = vi.spyOn(TmuxManager.prototype, 'capturePaneById')
      .mockResolvedValue('idle diagnostics output\n  gpt-5.5 xhigh · ~/repo\n');

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape']);     // NO C-c — the re-check caught the shell after liveness sampling
    expect(captureSpy).toHaveBeenCalled(); // first gate passed; liveness ran before the second gate held
  });

  it('holds (no C-c) when the screen is static but the OSC braille title ADVANCES across samples (live turn)', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1 });
    const keys: string[] = [];
    vi.spyOn(TmuxManager.prototype, 'sendKeysToPane').mockImplementation(async (_p, k) => { keys.push(k); });
    vi.spyOn(TmuxManager.prototype, 'displayMessage').mockResolvedValue('node'); // proc-title gate: still the runtime
    vi.spyOn(TmuxManager.prototype, 'readPaneTitle')
      .mockResolvedValueOnce('⠋ Working') // first sample
      .mockResolvedValue('⠙ Working');    // advanced spinner → live
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockRejectedValue(new Error('repl not ready'));
    vi.spyOn(TmuxManager.prototype, 'capturePaneById').mockResolvedValue('quiet build output\n  no spinner here\n');

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape']); // advancing title → live → hold (no C-c into a running turn)
  });

  it('does NOT treat a STALE static working-shaped OSC title as live — C-c proceeds (else cancel-interrupt-failed)', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(STUCK_COMPOSER, CLEARED_BARE_PROMPT); // dirty composer cleared by C-c
    vi.spyOn(TmuxManager.prototype, 'readPaneTitle').mockResolvedValue('⠹ Working'); // leftover, NEVER changes

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(true);
    expect(keys).toEqual(['Escape', 'C-c']); // static stale title is not evidence of life → clear proceeds
  });

  it('an ADVANCING OSC title is live even when the screen momentarily shows a ready-looking prompt', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1 });
    const keys: string[] = [];
    vi.spyOn(TmuxManager.prototype, 'sendKeysToPane').mockImplementation(async (_p, k) => { keys.push(k); });
    vi.spyOn(TmuxManager.prototype, 'displayMessage').mockResolvedValue('node');
    vi.spyOn(TmuxManager.prototype, 'readPaneTitle')
      .mockResolvedValueOnce('⠋ Working')
      .mockResolvedValue('⠙ Working'); // spinner advances → live, despite the ready-looking screen
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockRejectedValue(new Error('repl not ready'));
    vi.spyOn(TmuxManager.prototype, 'capturePaneById').mockResolvedValue('› \n'); // momentarily ready-looking

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape']); // advancing title checked BEFORE visible-idle → live → hold (no C-c)
  });

  it('holds AFTER one C-c when a human `node` session never becomes a Codex composer (`>` ≠ `›`)', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(NODE_HUMAN_SESSION, NODE_HUMAN_SESSION, { cleanAfterCtrlC: false }); // `>` never becomes a ready Codex prompt

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape', 'C-c']); // verify finds no clean Codex composer → hold (no auto-release)
  });

  it('holds AFTER C-c when a runtime menu does not dismiss to a clean composer', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(RUNTIME_MENU, RUNTIME_MENU, { cleanAfterCtrlC: false }); // menu not dismissed → not ready

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape', 'C-c']);
  });

  it('holds (no C-c) on a live turn with NO busy marker — sampled for change, not gated on busy markers', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1 });
    const keys = spyKeys();
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockRejectedValue(new Error('repl not ready'));
    vi.spyOn(TmuxManager.prototype, 'capturePaneById')
      .mockResolvedValueOnce(GROWING_OUTPUT_A)
      .mockResolvedValueOnce(GROWING_OUTPUT_B); // output grows → live, even with no Working/spinner/esc marker

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape']); // changed across grabs → live → hold (no C-c)
  });

  it('holds AFTER C-c when a bare `›` still sits under a permission/confirm blocker', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(BLOCKER_OVER_PROMPT, BLOCKER_OVER_PROMPT, { cleanAfterCtrlC: false }); // blocker not dismissed → not ready

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape', 'C-c']); // bare `›` + blocker ≠ clean composer → hold
  });

  it('holds DELETE-only (cancel-clear-failed) without sending keys when the pane mutex stays busy past the wait window', async () => {
    Object.assign(manager, { cancelInterruptGuardWaitMs: 30, compactIdlePollMs: 5 });
    const keys = spyKeys();
    (manager as unknown as { compactInFlight: Set<string> }).compactInFlight.add('qa-1'); // never released
    // mirror the cancel flow: the agent is already cancel-clearing when Phase 1 runs
    await seedAgent({ id: 'qa-1', taskId: 'tBusy', paneId: '%7', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });

    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual([]); // never races a dispatch's keystrokes on the same pane
    // pane unverified → classified un-cleared/DELETE-only, NOT Resume-able cancel-interrupt-failed
    expect((await agentStore.get('qa-1'))?.awaitingPhase).toBe('cancel-clear-failed');
  });

  it('waits for a busy pane mutex and proceeds once the in-flight dispatch releases it (no instant hold)', async () => {
    Object.assign(manager, { cancelInterruptGuardWaitMs: 2_000, compactIdlePollMs: 5 });
    const keys = spyKeys();
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockResolvedValue(undefined); // idle reached on ESC
    const inFlight = (manager as unknown as { compactInFlight: Set<string> }).compactInFlight;
    inFlight.add('qa-1');
    setTimeout(() => inFlight.delete('qa-1'), 25); // dispatch releases the mutex shortly after

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(true);
    expect(keys).toEqual(['Escape']); // acquired the mutex after release, then interrupted (not cancel-interrupt-failed)
  });

  it('returns ready on ESC alone, without capturing or escalating, when the pane is already idle', async () => {
    const keys = spyKeys();
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockResolvedValue(undefined);
    const captureSpy = vi.spyOn(TmuxManager.prototype, 'capturePaneById');

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const state = (await agentStore.get('qa-1'))!;
    const ok = await callInterrupt(manager, state, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(true);
    expect(keys).toEqual(['Escape']);
    expect(captureSpy).not.toHaveBeenCalled();
  });

  // Closes the interrupt→/clear mutex gap: a dispatch that wins the pane mutex after cancel released Phase 1
  // must not inject a cancelled task's prompt (cancel keeps taskId, so the paneId/taskId check alone misses it).
  it('injectAndAwaitAck aborts a dispatch whose bound task went terminal while waiting for the pane mutex', async () => {
    const t = await seedTask({ status: 'cancelled' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    const tmux = new TmuxManager(readyRunner());
    await expect(
      callInjectAndAwaitAck(manager, tmux, '%0', 'prompt', 'dev-1', 'claude-code'),
    ).rejects.toThrow(/went terminal/);
  });

  it('injectAndAwaitAck aborts when cancel marked the agent cancel-clearing before the task flips terminal', async () => {
    const t = await seedTask({ status: 'in_progress' }); // task NOT terminal yet — cancel writes the hold first
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    const tmux = new TmuxManager(readyRunner());
    await expect(
      callInjectAndAwaitAck(manager, tmux, '%0', 'prompt', 'dev-1', 'claude-code'),
    ).rejects.toThrow(/taken over by cancel/);
  });

  it('injectAndAwaitAck re-checks after the task read: aborts before paste if cancel lands during taskStore.get', async () => {
    const t = await seedTask({ status: 'in_progress' }); // not terminal — the hold lands DURING the bound-task read
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' }); // no hold at the first check
    const injectSpy = vi.spyOn(TmuxManager.prototype, 'injectPrompt').mockResolvedValue(undefined as unknown as void);
    const realGet = taskStore.get.bind(taskStore);
    vi.spyOn(taskStore, 'get').mockImplementation(async (id: string) => {
      await agentStore.update('dev-1', (s) => (s ? { ...s, status: 'awaiting_human', awaitingPhase: 'cancel-clearing' } : AGENT_STORE_NOOP));
      return realGet(id);
    });
    const tmux = new TmuxManager(readyRunner());
    await expect(
      callInjectAndAwaitAck(manager, tmux, '%0', 'prompt', 'dev-1', 'claude-code'),
    ).rejects.toThrow(/taken over by cancel before paste/);
    expect(injectSpy).not.toHaveBeenCalled();
  });

  it('injectTextToAgent re-checks after the task read: aborts before paste if cancel lands during taskStore.get', async () => {
    const t = await seedTask({ status: 'in_progress' }); // not terminal — hold lands DURING the bound-task read
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0' }); // no hold at the first check
    const injectSpy = vi.spyOn(TmuxManager.prototype, 'injectPrompt').mockResolvedValue(undefined as unknown as void);
    const realGet = taskStore.get.bind(taskStore);
    vi.spyOn(taskStore, 'get').mockImplementation(async (id: string) => {
      await agentStore.update('qa-1', (s) => (s ? { ...s, status: 'awaiting_human', awaitingPhase: 'cancel-clearing' } : AGENT_STORE_NOOP));
      return realGet(id);
    });
    await expect(
      manager.injectTextToAgent('qa-1', 'file body', { expectedTaskId: t.id }),
    ).rejects.toThrow(/taken over by cancel before paste/);
    expect(injectSpy).not.toHaveBeenCalled();
  });

  it('injectTextToAgent (read-file responder) refuses to inject into a pane held by cancel cleanup', async () => {
    await seedTask({ id: 'task-rf-hold', status: 'in_progress' }); // task not yet terminal — cancel wrote the hold first
    await seedAgent({ id: 'qa-1', taskId: 'task-rf-hold', paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await expect(
      manager.injectTextToAgent('qa-1', 'file body', { expectedTaskId: 'task-rf-hold' }),
    ).rejects.toThrow(/taken over by cancel/);
  });

  it('injectTextToAgent refuses to inject when the bound task is already terminal', async () => {
    const t = await seedTask({ id: 'task-rf-terminal', status: 'cancelled' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0' });
    await expect(
      manager.injectTextToAgent('qa-1', 'file body', { expectedTaskId: t.id }),
    ).rejects.toThrow(/terminal/);
  });

  it('attachImageToRunningAgent refuses to paste into a pane held by cancel cleanup', async () => {
    await seedTask({ id: 'task-img-hold', status: 'in_progress' });
    await seedAgent({ id: 'qa-1', taskId: 'task-img-hold', paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await expect(
      manager.attachImageToRunningAgent('qa-1', Buffer.from('img'), 'png'),
    ).rejects.toThrow(/being cancelled/);
  });

  it('attachImageToRunningAgent refuses when the bound task is already terminal', async () => {
    const t = await seedTask({ id: 'task-img-terminal', status: 'cancelled' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0' });
    await expect(
      manager.attachImageToRunningAgent('qa-1', Buffer.from('img'), 'png'),
    ).rejects.toThrow(/terminal/);
  });

  it('attachImageToRunningAgent re-checks cancel state AFTER the slow host write — refuses the paste if cancel landed', async () => {
    await seedTask({ id: 'task-img-toctou', status: 'in_progress' });
    await seedAgent({ id: 'dev-1', taskId: 'task-img-toctou', paneId: '%0' });
    const injectSpy = vi.spyOn(TmuxManager.prototype, 'injectPrompt').mockResolvedValue(undefined as unknown as void);
    // Cancel lands DURING writeImageToHost: the (non-ssh) host write installs the cancel-clearing hold.
    const localManager = makeManager({
      skillRegistry: freshRegistry(),
      runnerFactory: () => ({
        exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
        writeFile: vi.fn(async () => {
          await agentStore.update('dev-1', (s) => (s ? { ...s, status: 'awaiting_human', awaitingPhase: 'cancel-clearing' } : AGENT_STORE_NOOP));
        }),
      } as unknown as CommandRunner),
    });

    await expect(
      localManager.attachImageToRunningAgent('dev-1', Buffer.from('img'), 'png'),
    ).rejects.toThrow(/being cancelled/);
    expect(injectSpy).not.toHaveBeenCalled(); // never pasted into the pane cancel is tearing down
  });

  it('attachImageToRunningAgent re-checks the cancel hold AFTER its task read (closes the assertUploadStillValid gap)', async () => {
    await seedTask({ id: 'task-img-taskgap', status: 'in_progress' });
    await seedAgent({ id: 'dev-1', taskId: 'task-img-taskgap', paneId: '%0' });
    const injectSpy = vi.spyOn(TmuxManager.prototype, 'injectPrompt').mockResolvedValue(undefined as unknown as void);
    const realGet = taskStore.get.bind(taskStore);
    vi.spyOn(taskStore, 'get').mockImplementation(async (id: string) => {
      await agentStore.update('dev-1', (s) => (s ? { ...s, status: 'awaiting_human', awaitingPhase: 'cancel-clearing' } : AGENT_STORE_NOOP));
      return realGet(id);
    });
    const localManager = makeManager({
      skillRegistry: freshRegistry(),
      runnerFactory: () => ({
        exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
        writeFile: vi.fn(async () => undefined),
      } as unknown as CommandRunner),
    });
    await expect(
      localManager.attachImageToRunningAgent('dev-1', Buffer.from('img'), 'png'),
    ).rejects.toThrow(/being cancelled/);
    expect(injectSpy).not.toHaveBeenCalled();
  });

  it('cancel-interrupt guard wait is derived from the configured dispatch ack timeout (not the default)', () => {
    const m = makeManager({ skillRegistry: freshRegistry(), dispatchAckTimeoutMs: 60_000 }) as unknown as {
      cancelInterruptGuardWaitMs: number; dispatchAckTimeoutMs: number;
    };
    expect(m.dispatchAckTimeoutMs).toBe(60_000);
    expect(m.cancelInterruptGuardWaitMs).toBeGreaterThanOrEqual(60_000);
  });

  it('markAwaitingHuman does not let a generic hold overwrite a cancel-cleanup hold (but cancel transitions do)', async () => {
    await seedAgent({ id: 'dev-1', taskId: 'tX', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });

    await manager.markAwaitingHuman('dev-1', 'code-dispatch-failed', 'generic dispatch failure');
    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBe('cancel-clearing'); // preserved

    await manager.markAwaitingHuman('dev-1', 'cancel-clear-failed', 'cancel /clear unconfirmed');
    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBe('cancel-clear-failed'); // in-set transition allowed
  });

  it('markAwaitingHuman does NOT downgrade cancel-clear-failed (DELETE-only) to cancel-interrupt-failed', async () => {
    await seedAgent({ id: 'dev-1', taskId: 'tX', status: 'awaiting_human', awaitingPhase: 'cancel-clear-failed' });
    await manager.markAwaitingHuman('dev-1', 'cancel-interrupt-failed', 'late interrupt failure');
    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBe('cancel-clear-failed'); // monotonic: no downgrade
  });

  it('markAwaitingHuman still allows the escalation cancel-clearing → cancel-interrupt-failed', async () => {
    await seedAgent({ id: 'dev-1', taskId: 'tX', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await manager.markAwaitingHuman('dev-1', 'cancel-interrupt-failed', 'interrupt failed');
    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBe('cancel-interrupt-failed');
  });

  it('markPaneCancelClearing does NOT downgrade an existing cancel-clear-failed back to cancel-clearing', async () => {
    await seedAgent({ id: 'dev-1', taskId: 'tX', status: 'awaiting_human', awaitingPhase: 'cancel-clear-failed' });
    await (manager as unknown as { markPaneCancelClearing: (a: string, t: string) => Promise<void> })
      .markPaneCancelClearing('dev-1', 'tX');
    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBe('cancel-clear-failed'); // re-entrant cleanup can't soften it
  });

  it('markPaneCancelClearing still sets cancel-clearing from a non-hold binding (initial cancel)', async () => {
    await seedAgent({ id: 'dev-1', taskId: 'tX', paneId: '%0' });
    await (manager as unknown as { markPaneCancelClearing: (a: string, t: string) => Promise<void> })
      .markPaneCancelClearing('dev-1', 'tX');
    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBe('cancel-clearing');
  });

  it('cancel-interrupt guard wait covers the dispatch ack window (so cancel-during-ack is not dropped to hold)', () => {
    const m = manager as unknown as { cancelInterruptGuardWaitMs: number; dispatchAckTimeoutMs: number };
    expect(m.cancelInterruptGuardWaitMs).toBeGreaterThanOrEqual(m.dispatchAckTimeoutMs);
  });
});

describe('AgentManager.prHasDevReplySince', () => {
  const SINCE = '2026-06-01T00:00:00.500Z';

  function mgrWithExec(execImpl: (cmd: string) => ExecResult): AgentManager {
    return makeManager({
      platformRunner: {
        exec: vi.fn(async (cmd: string) => execImpl(cmd)),
        writeFile: vi.fn(async () => undefined),
      } as unknown as CommandRunner,
    });
  }

  beforeEach(async () => {
    await seedTask({ id: 'task-r', prNumber: 90, reviewDispatchedAt: SINCE });
  });

  it('counts an inline thread reply created after sinceIso', async () => {
    const m = mgrWithExec(cmd => cmd.includes('/pulls/')
      ? { stdout: '2026-06-01T00:01:00Z\n', stderr: '', exitCode: 0 }
      : { stdout: '', stderr: '', exitCode: 0 });
    expect(await m.prHasDevReplySince('task-r', SINCE)).toBe(true);
  });

  it('also counts a top-level issue/PR comment, not just inline replies', async () => {
    const m = mgrWithExec(cmd => cmd.includes('/issues/')
      ? { stdout: '2026-06-01T00:02:00Z\n', stderr: '', exitCode: 0 }
      : { stdout: '', stderr: '', exitCode: 0 });
    expect(await m.prHasDevReplySince('task-r', SINCE)).toBe(true);
  });

  it('aggregates rows across paginated reply results', async () => {
    // --paginate emits per-page; reading one timestamp per row means a match on any
    // page (any line) counts, instead of a per-page `length` that loses later pages.
    const m = mgrWithExec(cmd => cmd.includes('/pulls/')
      ? { stdout: '\n2026-06-01T00:03:00Z\n', stderr: '', exitCode: 0 }
      : { stdout: '', stderr: '', exitCode: 0 });
    expect(await m.prHasDevReplySince('task-r', SINCE)).toBe(true);
  });

  it('compares by parsed time so a same-second earlier reply does NOT count', async () => {
    // created_at has no ms (00.000Z); sinceIso has ms (00.500Z). A string compare
    // would wrongly mark "...00Z" > "...00.500Z"; Date.parse gives 0 < 500 → excluded.
    const m = mgrWithExec(cmd => cmd.includes('/pulls/')
      ? { stdout: '2026-06-01T00:00:00Z\n', stderr: '', exitCode: 0 }
      : { stdout: '', stderr: '', exitCode: 0 });
    expect(await m.prHasDevReplySince('task-r', SINCE)).toBe(false);
  });

  it('throws on gh failure so the caller fails closed', async () => {
    const m = mgrWithExec(() => ({ stdout: '', stderr: 'rate limited', exitCode: 1 }));
    await expect(m.prHasDevReplySince('task-r', SINCE)).rejects.toThrow(/gh api/);
  });

  it('counts a PR review body created by gh pr review --comment', async () => {
    // `gh pr review --comment` creates a PR review (submitted_at), not an inline or
    // issue comment. Only the /reviews endpoint returns a stamp here.
    const m = mgrWithExec(cmd => cmd.includes('/reviews')
      ? { stdout: '2026-06-01T00:04:00Z\n', stderr: '', exitCode: 0 }
      : { stdout: '', stderr: '', exitCode: 0 });
    expect(await m.prHasDevReplySince('task-r', SINCE)).toBe(true);
  });
});

describe('AgentManager dispatchPostMergeCleanup', () => {
  it('releases the agent when it has no paneId in the store (no compact possible)', async () => {
    const execs: string[] = [];
    manager = makeManager({ runnerFactory: () => recordingRunner(execs) });
    await seedAgent({ id: 'dev-1', taskId: 'task-x' });

    await manager.dispatchPostMergeCleanup('dev-1', { prNumber: 1, taskId: 'task-x', branch: 'bx/task-x' });

    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('runs the full cycle: idle → cleanup prompt (busy→idle) → /clear (busy→idle) → release', async () => {
    const execs: string[] = [];
    const promptInjections: string[] = [];
    manager = makeManager({ runnerFactory: () => compactRunner(execs, captureInjection(promptInjections)) });
    setCompactTiming(manager);
    await seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', repoPath: '/repo/main' });

    await manager.dispatchPostMergeCleanup('dev-1', { prNumber: 99, taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => !(await agentStore.get('dev-1'))?.taskId);

    const joined = execs.join('\n');
    expect(joined).toMatch(/tmux load-buffer/);
    expect(joined).toMatch(/tmux paste-buffer/);
    expect(joined).toMatch(/tmux send-keys -l -t '%5' '\/clear'/);
    expect(promptInjections.join('\n')).toContain('has merged');
    // cleanup prompt injected BEFORE /clear in the command stream
    expect(execs.findIndex(c => c.includes('load-buffer')))
      .toBeLessThan(execs.findIndex(c => c.includes("send-keys -l -t '%5' '/clear'")));
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('releases after post-merge clear when a small claude pane hides the footer ready anchor', async () => {
    const execs: string[] = [];
    manager = makeManager({ runnerFactory: () => smallPaneClaudeCompactRunner(execs) });
    setCompactTiming(manager);
    await seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', repoPath: '/repo/main' });

    await manager.dispatchPostMergeCleanup('dev-1', { prNumber: 99, taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => !(await agentStore.get('dev-1'))?.taskId);

    expect(execs.join('\n')).toMatch(/tmux send-keys -l -t '%5' '\/clear'/);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('runs server-side fetch+prune + branch -D in repoPath, and surfaces the "deleted" outcome in the prompt', async () => {
    const execs: string[] = [];
    const promptInjections: string[] = [];
    manager = makeManager({ runnerFactory: () => compactRunner(execs, captureInjection(promptInjections)) });
    setCompactTiming(manager);
    await seedAgent({ id: 'dev-1', paneId: '%5', repoPath: '/repo/main-clone', taskId: 'merged-task' });

    await manager.dispatchPostMergeCleanup('dev-1', { prNumber: 17, taskId: 'merged-task', branch: 'bx/task-merge' });
    await waitUntilAsync(async () => !(await agentStore.get('dev-1'))?.taskId);

    const fetchCmd = execs.find(c => c.includes('git fetch --prune origin'));
    expect(fetchCmd).toContain("cd '/repo/main-clone'");
    expect(fetchCmd).toContain('git worktree prune');
    const delCmd = execs.find(c => c.includes('git branch -D'));
    expect(delCmd).toContain("git branch -D 'bx/task-merge'");
    expect(promptInjections.join('\n')).toContain('baxian deleted the merged local feature branch `bx/task-merge`');
    expect(execs.join('\n')).toMatch(/tmux send-keys -l -t '%5' '\/clear'/);
  });

  it('removes the worktree before deleting the branch (branch -D would fail while the worktree holds the ref)', async () => {
    const execs: string[] = [];
    manager = makeManager({ runnerFactory: () => compactRunner(execs) });
    setCompactTiming(manager);
    await seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', repoPath: '/repo/main', worktreePath: '/wt/merged-task' });

    await manager.dispatchPostMergeCleanup('dev-1', { prNumber: 9, taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => !(await agentStore.get('dev-1'))?.taskId);

    const removeIdx = execs.findIndex(c => c.includes('git worktree remove'));
    const branchIdx = execs.findIndex(c => c.includes('git branch -D'));
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(branchIdx).toBeGreaterThan(removeIdx);
    expect(execs.find(c => c.includes('git worktree remove'))).toContain("git worktree remove '/wt/merged-task' --force");
    expect((await agentStore.get('dev-1'))?.worktreePath).toBeUndefined();
  });

  it('holds taskId on the binding during cleanup and releases after', async () => {
    const execs: string[] = [];
    let taskIdDuringBranchDelete: string | undefined;
    manager = makeManager({
      runnerFactory: () => compactRunner(execs, async (cmd) => {
        if (cmd.includes('git branch -D')) taskIdDuringBranchDelete = (await agentStore.get('dev-1'))?.taskId;
      }),
    });
    setCompactTiming(manager);
    await seedAgent({ id: 'dev-1', paneId: '%5', repoPath: '/repo/main' });

    await manager.dispatchPostMergeCleanup('dev-1', { prNumber: 5, taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => !(await agentStore.get('dev-1'))?.taskId);

    expect(taskIdDuringBranchDelete).toBe('merged-task');
    expect(execs.join('\n')).toMatch(/tmux send-keys -l -t '%5' '\/clear'/);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('sends /compact instead of /clear when branch delete fails, preserving the cleanup warning', async () => {
    const BUSY = '⏵⏵ bypass permissions on /tmp/repo\n\n· Compacting… (3s)\n  esc to interrupt\n';
    const IDLE = '⏵⏵ bypass permissions on /tmp/repo\n\n>';
    let busyLeft = 0;
    const execs: string[] = [];
    const promptInjections: string[] = [];
    const record = captureInjection(promptInjections);
    manager = makeManager({
      runnerFactory: () => ({
        exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
          execs.push(cmd);
          record(cmd);
          if (cmd.includes('git branch -D')) {
            return { stdout: '', stderr: "error: Cannot delete branch 'bx/merged-task' checked out at '/tmp/wt'", exitCode: 1 };
          }
          if (cmd.includes('send-keys') && cmd.includes("'Enter'")) busyLeft = 3;
          if (cmd.includes('display-message') && cmd.includes('pane_current_command')) {
            return { stdout: 'claude\n', stderr: '', exitCode: 0 };
          }
          if (cmd.includes('capture-pane')) {
            let frame = IDLE;
            if (busyLeft > 0) { busyLeft--; frame = BUSY; }
            if (cmd.includes('history_size')) return { stdout: `${frame}\n___bx-snap-sep___\n0`, stderr: '', exitCode: 0 };
            return { stdout: frame, stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        }),
        writeFile: vi.fn(async (): Promise<void> => undefined),
      }) as unknown as CommandRunner,
    });
    setCompactTiming(manager);
    await seedAgent({ id: 'dev-1', paneId: '%5', repoPath: '/repo/main', taskId: 'merged-task' });

    await manager.dispatchPostMergeCleanup('dev-1', { prNumber: 99, taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => !(await agentStore.get('dev-1'))?.taskId);

    const joined = execs.join('\n');
    expect(joined).toMatch(/tmux send-keys -l -t '%5' '\/compact'/);
    expect(joined).not.toMatch(/tmux send-keys -l -t '%5' '\/clear'/);
    expect(promptInjections.join('\n')).toContain('WARNING');
    expect(promptInjections.join('\n')).toContain('clean it up manually');
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('treats a fast /clear (busy seen only briefly) as success, not a failed start', async () => {
    const execs: string[] = [];
    manager = makeManager({ runnerFactory: () => compactRunner(execs, undefined, 1) });
    setCompactTiming(manager);
    await seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', repoPath: '/repo/main' });

    await manager.dispatchPostMergeCleanup('dev-1', { prNumber: 9, taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => !(await agentStore.get('dev-1'))?.taskId);

    const binding = await agentStore.get('dev-1');
    expect(execs.join('\n')).toMatch(/tmux send-keys -l -t '%5' '\/clear'/);
    expect(binding?.taskId).toBeUndefined();
    expect(binding?.status).not.toBe('awaiting_human');
  });

  it('bails without touching the agent when its binding has moved to a different task', async () => {
    const execs: string[] = [];
    manager = makeManager({ runnerFactory: () => compactRunner(execs) });
    setCompactTiming(manager, 50, 5);
    await seedAgent({ id: 'dev-1', paneId: '%5', repoPath: '/repo/main', taskId: 'next-task' });

    await manager.dispatchPostMergeCleanup('dev-1', { prNumber: 17, taskId: 'merged-task', branch: 'bx/task-merge' });
    await new Promise(r => setTimeout(r, 60));

    const joined = execs.join('\n');
    expect(joined).not.toContain('git fetch --prune origin');
    expect(joined).not.toContain("send-keys -l -t '%5' '/clear'");
    const binding = await agentStore.get('dev-1');
    expect(binding?.taskId).toBe('next-task');
  });

  it('dispatchPendingTask refuses an agent still bound to a just-merged task (post-merge cleanup in flight → Start disabled)', async () => {
    await seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task' });
    await seedTask({ id: 'next-task', status: 'pending', agentId: 'dev-1', preferredAgentId: 'dev-1' });

    const result = await manager.dispatchPendingTask('next-task', 'dev-1');

    expect(result.errorCode).toBe(409);
    expect((await taskStore.get('next-task'))?.status).toBe('pending');
  });

  it('retries once and releases agent on persistent failure', async () => {
    const execs: string[] = [];
    const alwaysBusy = '⏵⏵ bypass permissions on /tmp/repo\n\n· Compacting… (3s)\n  esc to interrupt\n';
    manager = makeManager({ runnerFactory: () => capturePaneRunner(execs, () => alwaysBusy) });
    setCompactTiming(manager, 50, 5);
    await seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', repoPath: '/repo/main' });

    await manager.dispatchPostMergeCleanup('dev-1', { prNumber: 3, taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => !(await agentStore.get('dev-1'))?.taskId, 5000);

    const binding = await agentStore.get('dev-1');
    expect(binding?.taskId).toBeUndefined();
    expect(binding?.status).not.toBe('awaiting_human');
  });

  it('does not write taskId when paneId changes between initial read and update (race with retry/restart)', async () => {
    const execs: string[] = [];
    manager = makeManager({ runnerFactory: () => compactRunner(execs) });
    setCompactTiming(manager);
    await seedAgent({ id: 'dev-1', paneId: '%5' });

    const origUpdate = agentStore.update.bind(agentStore);
    vi.spyOn(agentStore, 'update').mockImplementationOnce(async (id, cb) => {
      const cur = await agentStore.get(id);
      if (cur) await agentStore.set({ ...cur, paneId: '%99' });
      return origUpdate(id, cb);
    });

    await manager.dispatchPostMergeCleanup('dev-1', { prNumber: 1, taskId: 'merged-task', branch: 'bx/merged-task' });
    await new Promise(r => setTimeout(r, 60));

    const binding = await agentStore.get('dev-1');
    expect(binding?.taskId).toBeUndefined();
    expect(binding?.paneId).toBe('%99');
    expect(execs.join('\n')).not.toContain('git fetch');
    expect(execs.join('\n')).not.toContain('/clear');
  });

  it('does not send C-c on retry when binding is released/rebound between attempts', async () => {
    const execs: string[] = [];
    const BUSY = '⏵⏵ bypass permissions on /tmp/repo\n\n· Compacting… (3s)\n  esc to interrupt\n';
    let captureCount = 0;
    manager = makeManager({
      runnerFactory: () => capturePaneRunner(execs, async () => {
        captureCount++;
        if (captureCount === 3) {
          const cur = await agentStore.get('dev-1');
          if (cur) await agentStore.set({ ...cur, taskId: 'new-review-task', updatedAt: new Date().toISOString() });
        }
        return BUSY;
      }),
    });
    setCompactTiming(manager, 50, 5);
    await seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', repoPath: '/repo/main' });

    await manager.dispatchPostMergeCleanup('dev-1', { prNumber: 1, taskId: 'merged-task', branch: 'bx/merged-task' });
    await new Promise(r => setTimeout(r, 500));

    expect(execs.filter(c => c.includes('send-keys') && c.includes('C-c'))).toHaveLength(0);
    const binding = await agentStore.get('dev-1');
    expect(binding?.taskId).toBe('new-review-task');
  });
});

describe('AgentManager awaiting_human lifecycle', () => {
  it('markAwaitingHuman sets status + emits intervention, preserving binding and lock', async () => {
    const t = await seedTask();
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await lockManager.acquire('dev-1');

    await manager.markAwaitingHuman('dev-1', 'test-phase', 'test reason');

    const state = await agentStore.get('dev-1');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('test-phase');
    expect(state?.awaitingReason).toBe('test reason');
    expect(state?.awaitingSince).toBeTruthy();
    expect(state?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('dev-1')).toBe(true);

    const emitted = events.filter(
      e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'test-phase',
    );
    expect(emitted).toHaveLength(1);
  });

  // cancel-interrupt-failed is a recoverable phase: Resume clears the held status, then releases the
  // binding when the task is terminal or keeps it (operator cancels later) while the task is active.
  it.each([
    { name: 'terminal task clears binding + releases lock', taskStatus: 'cancelled' as const, expectRelease: true },
    { name: 'active task clears status only, keeps binding', taskStatus: 'in_progress' as const, expectRelease: false },
  ])('resumeAgent on awaiting_human (cancel-interrupt-failed): $name', async ({ taskStatus, expectRelease }) => {
    const t = await seedTask({ status: taskStatus });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed' });
    await lockManager.acquire('dev-1');

    const result = await manager.resumeAgent('dev-1');

    expect(result).toEqual({ resumed: true, releasedBinding: expectRelease });
    const state = await agentStore.get('dev-1');
    expect(state?.status).toBeUndefined();
    if (expectRelease) {
      expect(state?.taskId).toBeUndefined();
      expect(state?.awaitingPhase).toBeUndefined();
    } else {
      expect(state?.taskId).toBe(t.id);
    }
    expect(await lockManager.isLocked('dev-1')).toBe(!expectRelease);
  });

  // These phases mark an unrecoverable-by-Resume state on an active task (crash before fail-task / a
  // watcher that can't be rebuilt); Resume must refuse and force operator cancel/DELETE.
  it.each([
    'agent_dialog_resolved_runtime',
    'signal-arm-failed:spec-done,pr-created',
  ])('resumeAgent REFUSES on awaitingPhase=%s + active task', async (phase) => {
    const t = await seedTask({ status: 'in_progress' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: phase });
    await lockManager.acquire('dev-1');

    const result = await manager.resumeAgent('dev-1');

    expect(result).toEqual({ resumed: false, releasedBinding: false });
    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect((await agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('resumeAgent ALLOWS release on awaitingPhase=agent_dialog_resolved_runtime (slowPoll detected REPL ready)', async () => {
    const t = await seedTask({ status: 'failed' }); // terminal (handleDialogPendingFromRuntime already pushed to failed)
    await taskStore.set(t);
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'agent_dialog_resolved_runtime',
    });
    await lockManager.acquire('dev-1');

    const result = await manager.resumeAgent('dev-1');

    expect(result).toEqual({ resumed: true, releasedBinding: true });
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('resumeAgent refuses when awaitingPhase=agent_dialog_pending (pane still blocked on dialog)', async () => {
    // Pane still stuck on dialog; Resume would let new prompts hit it. Recovery requires operator dismiss → slowPoll.
    const t = task({ status: 'failed' }); // terminal
    await taskStore.set(t);
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'agent_dialog_pending',
    });
    await lockManager.acquire('dev-1');

    const result = await manager.resumeAgent('dev-1');

    expect(result).toEqual({ resumed: false, releasedBinding: false });
    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBe('agent_dialog_pending');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('resumeAgent on agent that is not awaiting_human: noop', async () => {
    await seedAgent({ id: 'dev-1' });

    const result = await manager.resumeAgent('dev-1');

    expect(result).toEqual({ resumed: false, releasedBinding: false });
  });

  it('resumeAgent refuses when creationToken still set (bootstrap dialog unresolved)', async () => {
    await seedAgent({
      id: 'dev-1', creationToken: 'tok-still-pending',
      paneId: '%0',
      status: 'awaiting_human',
      awaitingPhase: 'agent_dialog_pending',
    });

    const result = await manager.resumeAgent('dev-1');

    expect(result).toEqual({ resumed: false, releasedBinding: false });
    // 状态保持 awaiting_human，DELETE 路径仍可用
    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect((await agentStore.get('dev-1'))?.creationToken).toBe('tok-still-pending');
  });

  // dev-wait-gate-failed = QA prompt may still be running; Resume refuses while the task is active and
  // releases once it is terminal (operator recovery).
  it.each([
    { name: 'active task (fixing) refuses', taskId: 'task-qa-stale', taskStatus: 'fixing' as const, expectRelease: false },
    { name: 'terminal task (cancelled) releases', taskId: 'task-qa-cancelled', taskStatus: 'cancelled' as const, expectRelease: true },
  ])('resumeAgent on dev-wait-gate-failed-after-qa-started: $name', async ({ taskId, taskStatus, expectRelease }) => {
    const t = await seedTask({ id: taskId, status: taskStatus });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1', status: 'awaiting_human', awaitingPhase: 'dev-wait-gate-failed-after-qa-started' });
    await lockManager.acquire('qa-1');

    const result = await manager.resumeAgent('qa-1');

    expect(result).toEqual({ resumed: expectRelease, releasedBinding: expectRelease });
    expect((await agentStore.get('qa-1'))?.taskId).toBe(expectRelease ? undefined : t.id);
    if (!expectRelease) expect((await agentStore.get('qa-1'))?.status).toBe('awaiting_human');
    expect(await lockManager.isLocked('qa-1')).toBe(!expectRelease);
  });

  it('releaseAgentForTask with allowAwaitingHuman=true bypasses gate (explicit recovery path)', async () => {
    const t = await seedTask();
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown',
    });
    await lockManager.acquire('dev-1');

    const ok = await manager.releaseAgentForTask('dev-1', t.id, 'idle', { allowAwaitingHuman: true });

    expect(ok).toBe(true);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('validateTaskDispatch ALLOWS create against awaiting_human agent (queues to pending; dispatch-time gates availability)', async () => {
    await seedAgent({
      id: 'dev-1', status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
    });

    await expect(
      manager.validateTaskDispatch('proj', {
        title: 'x', description: 'y', preferredAgentId: 'dev-1',
      }),
    ).resolves.toBeUndefined();
  });

  it('resumeAgent no longer triggers drainQueue (pending tasks wait for explicit dispatchPendingTask)', async () => {
    const t = await seedTask({ id: 'task-resume-drain', status: 'cancelled' });
    await seedAgent({
      id: 'dev-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
    });
    await lockManager.acquire('dev-1');

    const result = await manager.resumeAgent('dev-1');

    expect(result.resumed).toBe(true);
    expect(result.releasedBinding).toBe(true);
    expect('drainQueue' in (manager as unknown as Record<string, unknown>)).toBe(false);
  });

  // The release gate refuses to free a Held agent while its prompt may still be running, unless the
  // task is terminal (cleanup must not leak the binding) or the caller explicitly opts in.
  it.each([
    { name: 'task terminal → bypass even without opt', agentId: 'dev-1', paneId: '%0', taskStatus: 'merged' as const, phase: 'dispatch-failed:ack_unknown', opt: undefined, expectedOk: true },
    { name: 'dev-wait-gate-failed + active task refuses', agentId: 'qa-1', paneId: '%1', taskStatus: 'fixing' as const, phase: 'dev-wait-gate-failed-after-qa-started', opt: undefined, expectedOk: false },
    { name: 'dev-wait-gate-failed WITH allowAwaitingHuman releases', agentId: 'qa-1', paneId: '%1', taskStatus: 'approved' as const, phase: 'dev-wait-gate-failed-after-qa-started', opt: { allowAwaitingHuman: true }, expectedOk: true },
    { name: 'dispatch-failed:ack_unknown without opt refuses', agentId: 'qa-1', paneId: '%1', taskStatus: 'review' as const, phase: 'dispatch-failed:ack_unknown', opt: undefined, expectedOk: false },
    { name: 'dispatch-failed:ack_unknown WITH allowAwaitingHuman releases', agentId: 'qa-1', paneId: '%1', taskStatus: 'approved' as const, phase: 'dispatch-failed:ack_unknown', opt: { allowAwaitingHuman: true }, expectedOk: true },
  ])('releaseAgentForTask gate: $name', async ({ agentId, paneId, taskStatus, phase, opt, expectedOk }) => {
    const t = await seedTask({ status: taskStatus });
    await seedAgent({ id: agentId, taskId: t.id, paneId, status: 'awaiting_human', awaitingPhase: phase });
    await lockManager.acquire(agentId);

    const ok = await manager.releaseAgentForTask(agentId, t.id, 'idle', opt);

    expect(ok).toBe(expectedOk);
    expect((await agentStore.get(agentId))?.taskId).toBe(expectedOk ? undefined : t.id);
    expect(await lockManager.isLocked(agentId)).toBe(!expectedOk);
  });

  // dispatch-failed:ack_unknown = prompt may still be running; Resume refuses while the bound task is
  // active, releases when it is terminal or missing (boundTask null → first release rule fires).
  it.each([
    { name: 'bound task still active refuses', boundTaskId: undefined, taskStatus: 'review' as const, expectRelease: false },
    { name: 'bound task TERMINAL releases', boundTaskId: undefined, taskStatus: 'failed' as const, expectRelease: true },
    { name: 'bound task MISSING releases', boundTaskId: 'ghost-task', taskStatus: undefined, expectRelease: true },
  ])('resumeAgent on dispatch-failed:ack_unknown: $name', async ({ boundTaskId, taskStatus, expectRelease }) => {
    let taskId = boundTaskId ?? 'ghost-task';
    if (taskStatus) {
      const t = await seedTask({ status: taskStatus });
      taskId = t.id;
    }
    await seedAgent({ id: 'qa-1', taskId, paneId: '%1', status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown' });
    await lockManager.acquire('qa-1');

    const result = await manager.resumeAgent('qa-1');

    expect(result).toEqual({ resumed: expectRelease, releasedBinding: expectRelease });
    const after = await agentStore.get('qa-1');
    if (expectRelease) {
      expect(after?.taskId).toBeUndefined();
      // status='ok' normalizes to undefined (schema only persists awaiting_human).
      if (taskStatus === 'failed') expect(after?.status).toBeUndefined();
    } else {
      expect(after?.status).toBe('awaiting_human');
      expect(after?.taskId).toBe(taskId);
    }
    expect(await lockManager.isLocked('qa-1')).toBe(!expectRelease);
  });

  it('dispatchReviewToQa on ack_unknown still transitions task to review (so outcome can be processed)', async () => {
    // QA prompt already sent → skip transition would make outcome handler drop the result on fromStatus mismatch.
    const t = await seedTask({ id: 'task-manual-ack', status: 'approved', prNumber: 99, branch: 'bx/x', qaAgentId: 'qa-1', reviewRound: 1 });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await seedAgent({
      id: 'qa-1', taskId: t.id, paneId: '%1',
    });
    await lockManager.acquire('dev-1');
    await lockManager.acquire('qa-1');
    vi.spyOn(manager, 'startSession').mockRejectedValue(
      new DispatchTerminalError('ack_unknown', 'simulated infra'),
    );

    let caught: unknown;
    try {
      await manager.dispatchReviewToQa(t.id);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DispatchTerminalError);
    // task 已推到 review + reviewRound bumped
    const updated = await taskStore.get(t.id);
    expect(updated?.status).toBe('review');
    expect(updated?.reviewRound).toBe(2);
    expect(updated?.qaAgentId).toBe('qa-1');
    // QA 仍 Held
    expect((await agentStore.get('qa-1'))?.status).toBe('awaiting_human');
  });

  it('dispatchReviewToQa: emits manual-review-dev-parked-qa-failed (not "interrupted") when QA fails after dev parked', async () => {
    // Phase + note must match actual behavior (parked, no C-c) so operators don't misread.
    const t = await seedTask({ id: 'task-park-qa-fail', status: 'in_progress', prNumber: 50, branch: 'bx/x' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await seedAgent({ id: 'qa-1' });
    vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);
    vi.spyOn(manager, 'startSession').mockResolvedValue(false);

    await expect(manager.dispatchReviewToQa(t.id)).rejects.toMatchObject({ status: 500 });

    const intervention = events.find(
      e => e.type === 'human.intervention'
        && (e.data as { phase?: string }).phase === 'manual-review-dev-parked-qa-failed',
    );
    expect(intervention).toBeTruthy();
    const note = (intervention!.data as { note?: string }).note ?? '';
    expect(note).toMatch(/parked/);
    expect(note).not.toMatch(/C-c/i);
    expect(note).not.toMatch(/interrupt/i);
  });

  it('dispatchReviewToQa dialog: fails task from taskStatusAtClaim (approved) via dialogFailFromStatuses opt', async () => {
    // Manual review can enter from approved/fixing; caller must widen fail-from list beyond default ['review'].
    const t = await seedTask({ id: 'task-manual-dialog', status: 'approved', prNumber: 99, branch: 'bx/x', qaAgentId: 'qa-1', reviewRound: 1 });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await seedAgent({
      id: 'qa-1', taskId: t.id, paneId: '%1',
    });
    await lockManager.acquire('dev-1');
    await lockManager.acquire('qa-1');
    vi.spyOn(manager, 'startSession').mockImplementation(async (_taskId, agentId, _phase, opts) => {
      // 模拟 startSession 内部走 handleDialogPendingFromRuntime
      const err = new EnsureSessionError(
        { createdSession: true, agentId, dialogPending: true },
        'runtime dialog during manual review',
      );
      await manager.handleDialogPendingFromRuntime(agentId, err, {
        expectedFromStatuses: opts?.dialogFailFromStatuses,
      });
      throw err;
    });

    await expect(manager.dispatchReviewToQa(t.id)).rejects.toBeInstanceOf(EnsureSessionError);

    // task 'approved' 应被 fail (dialogFailFromStatuses=['approved'] 透传匹配)
    const updated = await taskStore.get(t.id);
    expect(updated?.status).toBe('failed');
    // QA Held + UI Retry 通路打开
    expect((await agentStore.get('qa-1'))?.status).toBe('awaiting_human');
  });

  it('dispatchReviewToQa ack_unknown preserves verdict-installed status; new design persists anchor+bump BEFORE startSession', async () => {
    // Original race: prompt was sent before transition/bump, so a fast verdict
    // could race with the cleanup transition. New design: PHASE 1 transition +
    // bump happen BEFORE the verdict watcher is even armed, so there's nothing
    // to "skip" in the ack_unknown branch — it's just a no-op. If a late
    // verdict (mocked here by startSession writing 'fixing' before throwing)
    // changes status post-PHASE-1, that change must survive: ack_unknown means
    // the prompt was sent and the verdict is real, so we don't roll back.
    const t = await seedTask({ id: 'task-claim-approved', status: 'approved', prNumber: 99, branch: 'bx/x', qaAgentId: 'qa-1', reviewRound: 1 });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await lockManager.acquire('dev-1');
    await lockManager.acquire('qa-1');
    vi.spyOn(manager, 'startSession').mockImplementation(async () => {
      const fresh = await taskStore.get(t.id);
      if (fresh) await taskStore.set({ ...fresh, status: 'fixing', updatedAt: NOW });
      throw new DispatchTerminalError('ack_unknown', 'simulated late ack');
    });

    await expect(manager.dispatchReviewToQa(t.id)).rejects.toBeInstanceOf(DispatchTerminalError);

    const updated = await taskStore.get(t.id);
    // status: PHASE 1 set 'review', mock overwrote to 'fixing', ack_unknown
    // leaves it alone — verdict-installed status survives.
    expect(updated?.status).toBe('fixing');
    // reviewRound is bumped in PHASE 1 (regardless of startSession outcome,
    // ack_unknown does NOT roll back PHASE 1 — the prompt was sent and the
    // dispatch attempt is recorded).
    expect(updated?.reviewRound).toBe(2);
  });

  it('dispatchReviewToQa: PHASE 1 persists status="review" + reviewHeadAnchorSha + reviewRound bump BEFORE startSession sees the task', async () => {
    // worker-legacy requested race-fix coverage: a fast pane verdict can fire
    // the moment startSession injects the prompt, and the review.submitted
    // handler must see the new anchor + status + qaAgentId. We assert by
    // checking what taskStore.get returns INSIDE the startSession mock — that
    // snapshot is what the handler would read if it ran right then.
    const t = await seedTask({ id: 'task-phase-order', status: 'in_progress', prNumber: 42, branch: 'bx/x', qaAgentId: 'qa-1', reviewRound: 0 });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    vi.spyOn(manager, 'fetchPrHeadSha').mockResolvedValue('a'.repeat(40));
    vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);

    let snapshotInsideStartSession: TaskState | undefined;
    vi.spyOn(manager, 'startSession').mockImplementation(async () => {
      snapshotInsideStartSession = await taskStore.get(t.id);
      return true;
    });

    await manager.dispatchReviewToQa(t.id);

    expect(snapshotInsideStartSession).toBeDefined();
    expect(snapshotInsideStartSession?.status).toBe('review');
    expect(snapshotInsideStartSession?.reviewRound).toBe(1);
    expect(snapshotInsideStartSession?.reviewHeadAnchorSha).toBe('a'.repeat(40));
    expect(snapshotInsideStartSession?.qaAgentId).toBe('qa-1');
  });

  it('dispatchReviewToQa rotates signalToken atomically with the anchor before arming the watcher', async () => {
    // Same fix as the pr.updated push path: the manual review dispatch must rotate the
    // per-pass token together with reviewDispatchedAt, not leave it lagging until PHASE 2.
    // Mock rotateAndSetupPhaseSignal (PHASE 2) to a no-op so the token seen at startSession
    // could only have been rotated by PHASE 1.
    const t = await seedTask({
      id: 'task-phase1-tokrot', status: 'review', prNumber: 42, branch: 'bx/x',
      qaAgentId: 'qa-1', reviewRound: 1, signalToken: 'old-pass-token-1',
    });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    vi.spyOn(manager, 'fetchPrHeadSha').mockResolvedValue('a'.repeat(40));
    vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);
    vi.spyOn(manager, 'rotateAndSetupPhaseSignal').mockResolvedValue({ token: 'unused-token', armed: true });
    const transitionSpy = vi.spyOn(manager, 'transitionTaskStatus');

    let tokenAtStart: string | undefined;
    vi.spyOn(manager, 'startSession').mockImplementation(async () => {
      tokenAtStart = (await taskStore.get(t.id))?.signalToken;
      return true;
    });

    await manager.dispatchReviewToQa(t.id);

    expect(tokenAtStart).toBeTruthy();
    expect(tokenAtStart).not.toBe('old-pass-token-1'); // rotated in PHASE 1, before the (mocked) PHASE 2
    // The token + dispatch time must ride the SAME transition that exposes the new
    // anchor/status — no window where the anchor is new but the token is still old.
    const anchorTransition = transitionSpy.mock.calls.find(
      c => c[1] === 'review' && (c[3] as { reviewHeadAnchorSha?: unknown })?.reviewHeadAnchorSha !== undefined,
    );
    expect(anchorTransition).toBeDefined();
    const patch = anchorTransition![3] as { signalToken?: string; reviewDispatchedAt?: string };
    expect(patch.signalToken).toBeTruthy();
    expect(patch.signalToken).not.toBe('old-pass-token-1');
    expect(patch.reviewDispatchedAt).toBeTruthy();
  });

  it('dispatchReviewToQa rollback re-sets up pr-merge-ready watcher when originalStatus=approved + PostApproveCompletion exists', async () => {
    // Scenario: approved task with active post-approve watcher. Operator
    // manually dispatches QA review. PHASE 2 stops pr-merge-ready watcher
    // and sets up {pr-approved, pr-changes-requested}. startSession fails →
    // rollback restores approved status. Without re-arming pr-merge-ready,
    // dev's later emit goes unconsumed and auto-merge stalls.
    const watcher = {
      start: vi.fn(async () => true),
      stop: vi.fn(),
      has: vi.fn(() => false),
    };
    const m3 = makeManager({ skillRegistry: freshRegistry(), phaseSignalWatcher: watcher as never });
    const t = await seedTask({
      id: 'task-rb-rearm', status: 'approved', prNumber: 88, branch: 'bx/x',
      qaAgentId: 'qa-1', reviewRound: 1,
    });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await m3.setPostApproveCompletion(t.id, { token: 'completion-tok-XYZ', approvedHeadSha: 'b'.repeat(40) });
    watcher.start.mockClear(); // ignore the arm from setPostApproveCompletion
    vi.spyOn(m3, 'fetchPrHeadSha').mockResolvedValue('a'.repeat(40));
    vi.spyOn(m3, 'markAgentWaiting').mockResolvedValue(true);
    vi.spyOn(m3, 'startSession').mockResolvedValue(false); // dispatch fails → triggers rollback

    await expect(m3.dispatchReviewToQa(t.id)).rejects.toBeInstanceOf(ApiError);

    const restored = await taskStore.get(t.id);
    expect(restored?.status).toBe('approved'); // PHASE 1 rolled back

    const armCalls = watcher.start.mock.calls.map(c => c[0]);
    const verdictArm = armCalls.find(c => Array.isArray(c.expectedKinds));
    const mergeReadyReArm = armCalls.find(c => c.expectedKinds === 'pr-merge-ready');
    expect(verdictArm).toMatchObject({ taskId: t.id, expectedKinds: ['pr-approved', 'pr-changes-requested'] });
    expect(mergeReadyReArm).toMatchObject({
      taskId: t.id, expectedKinds: 'pr-merge-ready', token: 'completion-tok-XYZ',
    });
  });

  it('dispatchReviewToQa rollback restores snapshot fields', async () => {
    // For a 'review' task with an existing qaAgentId and an in-flight signal
    // token, a failed manual dispatch must restore both — otherwise a
    // subsequent push-driven recheck reads a stale qaAgentId (release returns
    // false → qa-release-failed-cannot-recheck) and dev's pending emit with
    // the old token strands silently.
    const t = await seedTask({
      id: 'task-rb-snap', status: 'review', prNumber: 99, branch: 'bx/x',
      qaAgentId: 'qa-orig', signalToken: 'tok-old-12345', reviewHeadAnchorSha: 'c'.repeat(40),
      reviewRound: 2,
    });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await seedAgent({ id: 'qa-1' });
    await seedAgent({ id: 'qa-orig' });
    vi.spyOn(manager, 'fetchPrHeadSha').mockResolvedValue('a'.repeat(40));
    vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);
    vi.spyOn(manager, 'startSession').mockResolvedValue(false);

    await expect(manager.dispatchReviewToQa(t.id)).rejects.toBeInstanceOf(ApiError);

    const restored = await taskStore.get(t.id);
    expect(restored?.qaAgentId).toBe('qa-orig');           // not undefined, not 'qa-1'
    expect(restored?.signalToken).toBe('tok-old-12345');   // PHASE 2 rotated, rollback restored
    expect(restored?.reviewHeadAnchorSha).toBe('c'.repeat(40));
    expect(restored?.status).toBe('review');
    expect(restored?.reviewRound).toBe(2);                 // PHASE 1 bumped to 3, rolled back
  });

  it('dispatchReviewToQa PHASE 1 always overwrites reviewHeadAnchorSha — fetchPrHeadSha failure clears stale anchor', async () => {
    // Without explicit overwrite, fetch failure preserves a stale anchor from
    // a prior round → pane-signal approvals fall back to it → false stale-head
    // rejection or use of an old commit as "reviewed head".
    const t = await seedTask({
      id: 'task-stale-anchor', status: 'fixing', prNumber: 99, branch: 'bx/x',
      qaAgentId: 'qa-1', reviewHeadAnchorSha: 'd'.repeat(40), reviewRound: 1,
    });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await seedAgent({ id: 'qa-1' });
    vi.spyOn(manager, 'fetchPrHeadSha').mockRejectedValue(new Error('gh offline'));
    vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);
    vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await manager.dispatchReviewToQa(t.id);

    const updated = await taskStore.get(t.id);
    expect(updated?.reviewHeadAnchorSha).toBeUndefined();  // stale anchor cleared, NOT preserved
  });

  it('handleDialogPendingFromRuntime also releases partner agents on task fail (UI Retry path truly opens)', async () => {
    // Without clearing partner binding, retryTask's validateTaskDispatch sees dev still bound to the terminal task → 409 blocks UI Retry.
    const t = await seedTask({ id: 'task-partner-cleanup', status: 'in_progress', qaAgentId: 'qa-1' });
    // QA 触发 runtime dialog
    await seedAgent({
      id: 'qa-1', taskId: t.id, paneId: '%1',
    });
    // dev 同时绑该 task
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await lockManager.acquire('qa-1');
    await lockManager.acquire('dev-1');

    const err = new EnsureSessionError(
      { createdSession: false, agentId: 'qa-1', dialogPending: true },
      'runtime dialog',
    );
    await manager.handleDialogPendingFromRuntime('qa-1', err);

    // task 进 failed
    expect((await taskStore.get(t.id))?.status).toBe('failed');
    // dev binding/lock 被 releasePartnersAndDrain 清掉——retryTask 路径不会再被堵
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
    // QA 自己 Held
    expect((await agentStore.get('qa-1'))?.status).toBe('awaiting_human');
  });

  it('handleDialogPendingFromRuntime fails active task (prompt not injected; UI Retry path opens)', async () => {
    const t = await seedTask({ status: 'in_progress' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await lockManager.acquire('dev-1');

    const err = new EnsureSessionError(
      { createdSession: false, agentId: 'dev-1', dialogPending: true },
      'runtime dialog',
    );
    const handled = await manager.handleDialogPendingFromRuntime('dev-1', err);

    expect(handled).toBe(true);
    // runtime path: task 进 failed，UI Retry 通路打开
    expect((await taskStore.get(t.id))?.status).toBe('failed');
    // agent 标 Held
    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBe('agent_dialog_pending');
    // handled=true tells the caller to skip releaseAgentForTask, else release would unlock the stuck dialog pane.
    expect(err.partial.handled).toBe(true);
  });

  it('handleDialogPendingFromRuntime task fail SKIPS when outcome moved task past dispatch phase expected status', async () => {
    // fromStatus guard: concurrent outcome already advanced task past expected → skip the fail.
    const t = await seedTask({ id: 'task-outcome-arrived', status: 'approved' }); // 并发 outcome 已推 approved
    await taskStore.set(t);
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await lockManager.acquire('dev-1');

    const err = new EnsureSessionError(
      { createdSession: false, agentId: 'dev-1', dialogPending: true },
      'late dialog after outcome',
    );
    const handled = await manager.handleDialogPendingFromRuntime('dev-1', err, { expectedFromStatuses: ['in_progress'] });

    expect(handled).toBe(true);
    // task 保持 approved——不被 stale 'failed' 覆盖
    expect((await taskStore.get(t.id))?.status).toBe('approved');
    // agent 仍 Held（dialog 状态独立于 task）
    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
  });

  it('handleDialogPendingFromRuntime task fail WORKS when task still in dispatch expected fromStatus', async () => {
    // 对照测试：expectedFromStatuses=['in_progress'] (develop dispatch) + task 仍 'in_progress' → fail。
    const t = await seedTask({ id: 'task-still-in-progress', status: 'in_progress' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await lockManager.acquire('dev-1');

    const err = new EnsureSessionError(
      { createdSession: false, agentId: 'dev-1', dialogPending: true },
      'dialog during in_progress dispatch',
    );
    const handled = await manager.handleDialogPendingFromRuntime('dev-1', err, { expectedFromStatuses: ['in_progress'] });

    expect(handled).toBe(true);
    expect((await taskStore.get(t.id))?.status).toBe('failed');
    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
  });

  it('handleDialogPendingFromRuntime task fail is serialized via transitionTaskStatus (does not overwrite concurrent terminal)', async () => {
    // Unserialized get+set raced with concurrent terminal mutations; transitionTaskStatus locks + fromStatus-guards.
    const t = await seedTask({ id: 'task-already-cancelled', status: 'cancelled' }); // terminal but not failed
    await taskStore.set(t);
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await lockManager.acquire('dev-1');

    const err = new EnsureSessionError(
      { createdSession: false, agentId: 'dev-1', dialogPending: true },
      'runtime dialog after cancel',
    );
    const handled = await manager.handleDialogPendingFromRuntime('dev-1', err);

    expect(handled).toBe(true);
    // task 保持 cancelled，未被 stale 'failed' 覆盖
    expect((await taskStore.get(t.id))?.status).toBe('cancelled');
    // agent 仍 Held（dialog 卡住还没解决，无论 task 状态都标 Held 等 operator）
    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
  });

  it('handleDialogPendingFromRuntime: retry path (state empty + createdSession=true) probes tmux paneId and marks awaiting_human', async () => {
    // Without probing paneId, markDialogPending refuses (empty state) → 202 lets next dispatch hit the dialog pane.
    await seedAgent({ id: 'dev-1' });
    const probingRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('list-panes')) {
          return { stdout: '%99 claude\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async () => undefined),
    };
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => probingRunner;

    const err = new EnsureSessionError(
      { createdSession: true, agentId: 'dev-1', dialogPending: true },
      'retry path runtime dialog',
    );
    const handled = await manager.handleDialogPendingFromRuntime('dev-1', err);

    expect(handled).toBe(true);
    const state = await agentStore.get('dev-1');
    expect(state?.paneId).toBe('%99');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('agent_dialog_pending');
  });

  it('handleDialogPendingFromRuntime: retry path with tmux probe failure returns false (caller rollbacks)', async () => {
    // tmux 探 paneId 失败 → 无法证明 generation → 返回 false 让 caller 走 killSession 回滚。
    await seedAgent({ id: 'dev-1' });
    const failingProbeRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('list-panes')) {
          return { stdout: '', stderr: 'session not found', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async () => undefined),
    };
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => failingProbeRunner;

    const err = new EnsureSessionError(
      { createdSession: true, agentId: 'dev-1', dialogPending: true },
      'retry path runtime dialog',
    );
    const handled = await manager.handleDialogPendingFromRuntime('dev-1', err);

    expect(handled).toBe(false);
    const state = await agentStore.get('dev-1');
    expect(state?.status).toBeUndefined();
    expect(state?.paneId).toBeUndefined();
  });

  it('handleDialogPendingFromRuntime retry path: paneId guard rejects writes when fresh agent already has paneId (DELETE+recreate covered)', async () => {
    // updatedAt guard mis-fired on background updates; paneId presence is the actual generation evidence.
    await seedAgent({ id: 'dev-1', paneId: '%new' });
    const probingRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('list-panes')) {
          return { stdout: '%old claude\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async () => undefined),
    };
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => probingRunner;

    const err = new EnsureSessionError(
      { createdSession: true, agentId: 'dev-1', dialogPending: true },
      'stale retry runtime dialog',
    );
    // state.paneId='%new' (snapshot 时就有) → 进入 retry-probe 分支前的 state.paneId 校验失败 → 不走 probe，
    // 直接走 markDialogPending(expectedPaneId='%new')。fresh.paneId='%new' 匹配 → 写 awaiting_human。
    // 这里 spec 的是：旧 paneId %old (探到的) 不会污染新 agent 的 paneId %new。
    const handled = await manager.handleDialogPendingFromRuntime('dev-1', err);

    expect(handled).toBe(true);
    const state = await agentStore.get('dev-1');
    expect(state?.paneId).toBe('%new');
    expect(state?.status).toBe('awaiting_human');
  });

  it('handleDialogPendingFromRuntime: state empty + createdSession=false returns false (no generation evidence available)', async () => {
    // adoptOrRestartSession 路径抛 dialogPending 时 createdSession=false → 不从 tmux 取 paneId
    // （session 是别人创建的，不能确定我看到的 pane 是我刚操作的那个）→ 返回 false。
    await seedAgent({ id: 'dev-1' });

    const err = new EnsureSessionError(
      { createdSession: false, agentId: 'dev-1', dialogPending: true },
      'adopt path runtime dialog',
    );
    const handled = await manager.handleDialogPendingFromRuntime('dev-1', err);

    expect(handled).toBe(false);
    const state = await agentStore.get('dev-1');
    expect(state?.status).toBeUndefined();
  });

  // Late mark races with release+reassign; the atomic update guards on expectedTaskId so a stale mark
  // can't pollute a rebound task.
  it.each([
    { name: 'noop when binding has shifted to a different task', boundTaskId: 'task-new', expectedTaskId: 'task-old', expectWrite: false },
    { name: 'writes when binding still matches', boundTaskId: 'task-current', expectedTaskId: 'task-current', expectWrite: true },
  ])('markAwaitingHuman with expectedTaskId guard: $name', async ({ boundTaskId, expectedTaskId, expectWrite }) => {
    await seedAgent({ id: 'qa-1', taskId: boundTaskId, paneId: '%0' });

    await manager.markAwaitingHuman('qa-1', 'dispatch-failed:ack_unknown', 'ack_unknown', { expectedTaskId });

    const state = await agentStore.get('qa-1');
    if (expectWrite) {
      expect(state?.status).toBe('awaiting_human');
      expect(state?.awaitingPhase).toBe('dispatch-failed:ack_unknown');
    } else {
      expect(state?.status).toBeUndefined();
      expect(state?.awaitingPhase).toBeUndefined();
      expect(state?.taskId).toBe('task-new');
    }
  });

  // expectedCreationToken guards against a DELETE+recreate race: a stale runtime callback must not
  // mark a newer generation. null = caller expected "still no token"; a string = exact-token match.
  it.each([
    { name: 'expectedCreationToken=null noop when token has been set', seededToken: 'tok-recreated', expectedToken: null, reason: 'stale runtime callback', expectWrite: false, checkNoEmit: false },
    { name: 'noop on token mismatch', seededToken: 'tok-new', expectedToken: 'tok-old', reason: 'stale token holder', expectWrite: false, checkNoEmit: true },
    { name: 'writes on token match', seededToken: 'tok-match', expectedToken: 'tok-match', reason: 'good', expectWrite: true, checkNoEmit: false },
  ])('markAwaitingHuman with expectedCreationToken: $name (DELETE+recreate race)', async ({ seededToken, expectedToken, reason, expectWrite, checkNoEmit }) => {
    await seedAgent({ id: 'dev-1', creationToken: seededToken });

    await manager.markAwaitingHuman('dev-1', 'agent_dialog_pending', reason, { expectedCreationToken: expectedToken });

    const state = await agentStore.get('dev-1');
    if (expectWrite) {
      expect(state?.status).toBe('awaiting_human');
    } else {
      expect(state?.status).toBeUndefined();
      expect(state?.awaitingPhase).toBeUndefined();
    }
    if (checkNoEmit) {
      const emitted = events.filter(
        e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'agent_dialog_pending',
      );
      expect(emitted).toHaveLength(0);
    }
  });

  it('releaseAgentForTask refuses to release when status=awaiting_human (no allowAwaitingHuman opt)', async () => {
    const t = await seedTask();
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
    });
    await lockManager.acquire('dev-1');

    const ok = await manager.releaseAgentForTask('dev-1', t.id, 'idle');

    expect(ok).toBe(false);
    // awaiting_human 标记不被撕掉
    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect((await agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('canDispatchWithBinding rejects awaiting_human agent even if taskId cleared', async () => {
    expect(canDispatchWithBinding({
      id: 'dev-1', projectId: 'proj', updatedAt: NOW, status: 'awaiting_human',
    })).toBe(false);
    expect(canDispatchWithBinding({
      id: 'dev-1', projectId: 'proj', updatedAt: NOW, status: 'ok',
    })).toBe(true);
    expect(canDispatchWithBinding({
      id: 'dev-1', projectId: 'proj', updatedAt: NOW,
    })).toBe(true);
  });

  it('canDispatchWithBinding rejects same-task reentry when awaiting_human (cannot bypass via reentry phase)', async () => {
    // 此场景：agent 已 awaiting_human 但仍绑同一 task；reentry phase 试图 acquire。
    // acquireAgentForTask 走 sameTaskReentry 分支需要校验 status，否则绕过 gate。
    await seedTask({ id: 'task-reentry-block' });
    await seedAgent({
      id: 'dev-1', taskId: 'task-reentry-block', paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
    });
    await lockManager.acquire('dev-1');

    const ok = await manager.acquireAgentForTask('dev-1', 'task-reentry-block', 'fix');
    expect(ok).toBe(false);
  });
});

const ACK_SEP = '___bx-snap-sep___';

// The dispatch-ack-timeout interventions recorded on the bus during an ack attempt.
function ackInterventions(): BaxianEvent[] {
  return events.filter(
    e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'dispatch-ack-timeout',
  );
}

// A CommandRunner for the snapshot-driven ack tests: display-message returns the visible frame plus
// the SEP-prefixed scrollback line; a submitted Enter flips `enterSent` so `frame` can react to it.
// `sawEnter()` lets a test assert the Enter was actually delivered.
type SnapRunner = CommandRunner & { sawEnter: () => boolean };
function snapRunner(
  frame: (enterSent: boolean) => string,
  scrollback: (enterSent: boolean) => number = () => 0,
): SnapRunner {
  let enterSent = false;
  return {
    exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('display-message')) {
        return { stdout: `${frame(enterSent)}${ACK_SEP}\n${scrollback(enterSent)}\n`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('send-keys') && cmd.includes('Enter')) {
        enterSent = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
    writeFile: vi.fn(async (): Promise<void> => undefined),
    sawEnter: () => enterSent,
  } as unknown as SnapRunner;
}

// Seed the task+dev+lock that every ack test shares, then invoke injectAndAwaitAck over `runner`,
// capturing either the resolved result or the thrown error.
async function runAck(
  runner: CommandRunner,
  opts: { ackMs: number; settleMs: number; prompt?: string; lock?: boolean } = { ackMs: 150, settleMs: 150 },
): Promise<{ result?: AckResult; caught?: unknown; taskId: string }> {
  const localManager = makeInjectManager(runner, opts.ackMs, opts.settleMs);
  const t = await seedTask();
  await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
  if (opts.lock !== false) await lockManager.acquire('dev-1');
  const tmux = new TmuxManager(runner);
  try {
    const result = await callInjectAndAwaitAck(localManager, tmux, '%0', opts.prompt ?? 'hello prompt', 'dev-1', 'claude-code');
    return { result, taskId: t.id };
  } catch (caught) {
    return { caught, taskId: t.id };
  }
}

describe('injectAndAwaitAck ack timeout', () => {
  it('emits human.intervention dispatch-ack-timeout, does not throw, does not send C-c', async () => {
    const sentCommands: string[] = [];
    const stuckRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        sentCommands.push(cmd);
        if (cmd.includes('capture-pane')) {
          return { stdout: `stuck-screen\n${ACK_SEP}\n42\n`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const localManager = makeManager({
      skillRegistry: freshRegistry(),
      runnerFactory: () => stuckRunner,
      dispatchAckTimeoutMs: 50,
    });

    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await lockManager.acquire('dev-1');

    const tmux = new TmuxManager(stuckRunner);

    await expect(
      callInjectAndAwaitAck(localManager, tmux, '%0', 'hello prompt', 'dev-1', 'claude-code'),
    ).resolves.toEqual({ acked: false, composerDelivered: true });

    const interventions = ackInterventions();
    expect(interventions).toHaveLength(1);
    expect(interventions[0]).toMatchObject({
      type: 'human.intervention',
      projectId: 'proj',
      agentId: 'dev-1',
      taskId: t.id,
    });
    expect((interventions[0].data as { paneId?: string }).paneId).toBe('%0');

    const cCancelKeys = sentCommands.filter(c => c.includes('send-keys') && c.includes('C-c'));
    expect(cCancelKeys).toHaveLength(0);

    expect((await taskStore.get(t.id))?.status).toBe('in_progress');
    expect((await agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('dev-1')).toBe(true);

    const ackTimeoutEvent = interventions[0];
    expect((ackTimeoutEvent.data as { note?: string }).note).toMatch(/REPL did not acknowledge/);
  });

  it('injectAndAwaitAck re-sends Enter when the first is swallowed, then acks', async () => {
    let enterCount = 0;
    const flakyRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('send-keys') && cmd.includes('Enter')) {
          enterCount++;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          // First Enter is swallowed; only the resent Enter flips the pane busy.
          const visible = enterCount >= 2 ? 'working\n  esc to interrupt\n' : 'idle composer\n';
          return { stdout: `${visible}${ACK_SEP}\n0\n`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const localManager = makeInjectManager(flakyRunner, 3000, 10);
    (localManager as unknown as { dispatchAckResendIntervalMs: number }).dispatchAckResendIntervalMs = 50;
    const tmux = new TmuxManager(flakyRunner);

    const result = await callInjectAndAwaitAck(localManager, tmux, '%0', 'hello prompt', 'dev-1', 'claude-code');

    expect(result).toEqual({ acked: true, composerDelivered: true });
    expect(enterCount).toBeGreaterThanOrEqual(2);
  });

  it('infrastructure failure during the post-Enter ack wait throws DispatchTerminalError, not human.intervention', async () => {
    let enterSent = false;
    const SETTLED = `idle\n${ACK_SEP}\n10\n`;
    const failingRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('send-keys') && cmd.includes('Enter')) {
          enterSent = true;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          // pre-Enter captures settle to a stable idle frame; the FIRST capture after Enter (inside
          // waitSubmitAck) explodes → infra failure mid-ack-wait → ack_unknown DispatchTerminalError.
          if (!enterSent) return { stdout: SETTLED, stderr: '', exitCode: 0 };
          return { stdout: '', stderr: 'no such pane: %0', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const { caught } = await runAck(failingRunner, { ackMs: 50, settleMs: 200, lock: false });
    expect(caught).toBeInstanceOf(DispatchTerminalError);
    expect(ackInterventions()).toHaveLength(0);
  });
});

describe('injectAndAwaitAck settles the pane before Enter', () => {
  it('settles the pane before Enter, then acks on submission evidence (idle→busy) after Enter', async () => {
    const order: string[] = [];
    // Pre-Enter: image-attach redraw settles to a stable idle composer. Post-Enter: runtime goes busy.
    const preEnter = [
      'box: read /img.png\n',
      'box: [Image #1]\n',
      'box: [Image #1]\n',
    ];
    let enterSent = false;
    let snap = 0;
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('display-message')) {
          order.push(enterSent ? 'snap-post' : 'snap-pre');
          const visible = enterSent
            ? 'box: [Image #1]\nThinking\n  esc to interrupt\n'
            : preEnter[Math.min(snap++, preEnter.length - 1)];
          return { stdout: `${visible}${ACK_SEP}\n0\n`, stderr: '', exitCode: 0 };
        }
        if (cmd.includes('send-keys') && cmd.includes('Enter')) {
          enterSent = true;
          order.push('enter');
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const { result } = await runAck(runner, { ackMs: 2000, settleMs: 2000 });

    expect(result).toEqual({ acked: true, composerDelivered: true });
    const enterIdx = order.indexOf('enter');
    expect(enterIdx).toBeGreaterThan(-1);
    const settleSnapsBeforeEnter = order.slice(0, enterIdx).filter(x => x === 'snap-pre').length;
    expect(settleSnapsBeforeEnter).toBeGreaterThanOrEqual(2);
    expect(order.indexOf('snap-post')).toBeGreaterThan(enterIdx);
  });
});

describe('injectAndAwaitAck never-settle + swallowed Enter is non-ackable', () => {
  it('does NOT false-ack from redraw deltas when the runtime never goes busy', async () => {
    let n = 0;
    let enterSent = false;
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('display-message')) {
          return { stdout: `frame ${n++}\n${ACK_SEP}\n0\n`, stderr: '', exitCode: 0 };
        }
        if (cmd.includes('send-keys') && cmd.includes('Enter')) {
          enterSent = true;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          return { stdout: `composer still open ${n++}\n[Image #1] attaching\n`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const { result, taskId } = await runAck(runner, { ackMs: 60, settleMs: 60 });

    expect(result).toEqual({ acked: false, composerDelivered: true });
    expect(enterSent).toBe(true);
    expect(ackInterventions()).toHaveLength(1);
    expect((await taskStore.get(taskId))?.status).toBe('in_progress');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });
});

describe('injectAndAwaitAck post-approve edge cases', () => {
  it('acks a quick task on its brief idle-to-busy flash after Enter', async () => {
    // pre-Enter: settled idle. post-Enter: runtime flashes busy (the one fakeable-proof signal).
    const runner = snapRunner(enterSent => (enterSent ? 'working\n  esc to interrupt\n' : 'composer\n'), () => 5);
    const { result } = await runAck(runner, { ackMs: 1000, settleMs: 1000 });
    expect(result).toEqual({ acked: true, composerDelivered: true });
    expect(runner.sawEnter()).toBe(true);
  });

  it('does NOT ack on scrollback growth from an uncommitted attach redraw when runtime never gets busy', async () => {
    // post-Enter the attach redraw keeps pushing scrollback, but the pane never goes busy.
    let h = 5;
    const runner = snapRunner(() => 'composer still open\n', enterSent => (enterSent ? ++h : h));
    const { result } = await runAck(runner, { ackMs: 150, settleMs: 80 });
    expect(result).toEqual({ acked: false, composerDelivered: true });
    expect(runner.sawEnter()).toBe(true);
    expect(ackInterventions()).toHaveLength(1);
  });

  it('a failed sendEnter is raw cleanup, not ack_unknown', async () => {
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('display-message')) {
          return { stdout: `idle\n${ACK_SEP}\n5\n`, stderr: '', exitCode: 0 };
        }
        if (cmd.includes('send-keys') && cmd.includes('Enter')) {
          return { stdout: '', stderr: 'no such pane: %0', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const { caught } = await runAck(runner, { ackMs: 100, settleMs: 100 });
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof DispatchTerminalError && caught.reason === 'ack_unknown').toBe(false);
  });

  it('does NOT ack on busy text that was already in the pasted prompt when Enter is swallowed', async () => {
    // baseline already shows "esc to interrupt" (user pasted it); Enter is swallowed → nothing changes.
    const screen = `do X\n  esc to interrupt\n`;
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('display-message')) {
          return { stdout: `${screen}${ACK_SEP}\n3\n`, stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          return { stdout: screen, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const { result } = await runAck(runner, { ackMs: 150, settleMs: 150, prompt: 'do X\n  esc to interrupt' });
    expect(result).toEqual({ acked: false, composerDelivered: false });
    expect(ackInterventions()).toHaveLength(1);
  });

  it('a pre-Enter settle/capture failure is not ack_unknown and never sends Enter', async () => {
    const sent: string[] = [];
    let snaps = 0;
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        sent.push(cmd);
        if (cmd.includes('display-message')) {
          snaps++;
          if (snaps === 1) return { stdout: `composer\n${ACK_SEP}\n1\n`, stderr: '', exitCode: 0 };
          return { stdout: '', stderr: 'no such pane: %0', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const { caught } = await runAck(runner, { ackMs: 150, settleMs: 150 });
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof DispatchTerminalError && caught.reason === 'ack_unknown').toBe(false);
    const enterCmds = sent.filter(c => c.includes('send-keys') && c.includes('Enter'));
    expect(enterCmds).toHaveLength(0);
  });
});

describe('injectAndAwaitAck makes the pane reuse-safe on pre-Enter failure', () => {
  const ccCmds = (sent: string[]): string[] =>
    sent.filter(c => c.includes('send-keys') && c.includes('C-c'));
  const hasSessionCmds = (sent: string[]): string[] =>
    sent.filter(c => c.includes('has-session'));

  // A recording runner whose per-command behaviour is supplied by `respond`; falls through to a
  // benign empty result so a spec only has to describe the arms it cares about.
  function recordRunner(sent: string[], respond: (cmd: string) => ExecResult | undefined): CommandRunner {
    return {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        sent.push(cmd);
        return respond(cmd) ?? { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    } as unknown as CommandRunner;
  }

  it('clears the composer with C-c after a pre-Enter capture failure → raw, never Enter, no kill probe', async () => {
    const sent: string[] = [];
    let snaps = 0;
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('display-message')) {
        snaps++;
        if (snaps === 1) return { stdout: `composer\n${ACK_SEP}\n1\n`, stderr: '', exitCode: 0 };
        return { stdout: '', stderr: 'no such pane: %0', exitCode: 1 };
      }
      return undefined;
    });
    const { caught } = await runAck(runner);
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof DispatchTerminalError && caught.reason === 'ack_unknown').toBe(false);
    expect(ccCmds(sent)).toHaveLength(1);
    expect(hasSessionCmds(sent)).toHaveLength(0); // C-c landed → no need to probe the session
    expect(sent.filter(c => c.includes('send-keys') && c.includes('Enter'))).toHaveLength(0);
  });

  // Pre-Enter the pane settles idle, then sendEnter fails; how C-c cleanup is classified depends on
  // whether the session is confirmably alive/dead. Every case clears with exactly one C-c.
  it.each([
    {
      name: 'clears the composer with C-c after a failed sendEnter → raw',
      // only the Enter send-keys fails; the follow-up C-c lands cleanly → raw without probing.
      onHasSession: undefined as ExecResult | undefined,
      failKeys: 'enter' as 'enter' | 'all',
      sendKeys: { stdout: '', stderr: 'no such pane: %0', exitCode: 1 },
      expectAckUnknown: false,
      hasSessionCount: undefined as number | undefined, // not asserted in the original
    },
    {
      name: 'a transient C-c failure on a still-live session escalates to ack_unknown',
      // The transient tmux/SSH fault that broke sendEnter also breaks the follow-up C-c — but it is
      // a generic transient error, NOT "no such pane": the pane is still live with the leftover.
      onHasSession: { stdout: '', stderr: '', exitCode: 0 }, // alive
      failKeys: 'all' as 'enter' | 'all',
      sendKeys: { stdout: '', stderr: 'ssh: connect: connection timed out', exitCode: 1 },
      expectAckUnknown: true,
      hasSessionCount: 1, // probed → still alive → cannot release for reuse
    },
    {
      name: 'a C-c failure on a CONFIRMED-DEAD session is reuse-safe → raw (next dispatch rebuilds fresh)',
      onHasSession: { stdout: '', stderr: "can't find session: dev-1", exitCode: 1 }, // gone
      failKeys: 'all' as 'enter' | 'all',
      sendKeys: { stdout: '', stderr: 'no such pane: %0', exitCode: 1 },
      expectAckUnknown: false,
      hasSessionCount: 1, // probed → confirmed dead → safe no-op
    },
    {
      name: 'an UNCONFIRMABLE session (C-c fails AND has-session probe fails) escalates to ack_unknown',
      onHasSession: { stdout: '', stderr: 'ssh: connect: connection timed out', exitCode: 2 }, // unexpected → throws
      failKeys: 'all' as 'enter' | 'all',
      sendKeys: { stdout: '', stderr: 'ssh: connect: connection timed out', exitCode: 1 },
      expectAckUnknown: true,
      hasSessionCount: 1,
    },
  ])('$name', async ({ onHasSession, failKeys, sendKeys, expectAckUnknown, hasSessionCount }) => {
    const sent: string[] = [];
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('has-session')) return onHasSession;
      if (cmd.includes('send-keys') && (failKeys === 'all' || cmd.includes('Enter'))) return sendKeys;
      if (cmd.includes('display-message')) return { stdout: `idle\n${ACK_SEP}\n5\n`, stderr: '', exitCode: 0 };
      return undefined;
    });
    const { caught } = await runAck(runner);
    if (expectAckUnknown) {
      expect(caught).toBeInstanceOf(DispatchTerminalError);
      expect((caught as DispatchTerminalError).reason).toBe('ack_unknown');
    } else {
      expect(caught).toBeInstanceOf(Error);
      expect(caught instanceof DispatchTerminalError && caught.reason === 'ack_unknown').toBe(false);
    }
    expect(ccCmds(sent)).toHaveLength(1);
    if (hasSessionCount !== undefined) expect(hasSessionCmds(sent)).toHaveLength(hasSessionCount);
  });

  it('does NOT touch the composer on a post-Enter ack_unknown — the prompt may be running', async () => {
    const sent: string[] = [];
    let enterSent = false;
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('send-keys') && cmd.includes('Enter')) {
        enterSent = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane') || cmd.includes('display-message')) {
        if (!enterSent) return { stdout: `idle\n${ACK_SEP}\n10\n`, stderr: '', exitCode: 0 };
        return { stdout: '', stderr: 'no such pane: %0', exitCode: 1 };
      }
      return undefined;
    });
    const { caught } = await runAck(runner);
    expect(caught).toBeInstanceOf(DispatchTerminalError);
    expect((caught as DispatchTerminalError).reason).toBe('ack_unknown');
    expect(ccCmds(sent)).toHaveLength(0);
    expect(hasSessionCmds(sent)).toHaveLength(0);
  });

  it('does NOT touch the composer on a clean ack', async () => {
    const sent: string[] = [];
    let enterSent = false;
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('display-message')) {
        const visible = enterSent ? 'working\n  esc to interrupt\n' : 'composer\n';
        return { stdout: `${visible}${ACK_SEP}\n5\n`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('send-keys') && cmd.includes('Enter')) {
        enterSent = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return undefined;
    });
    const { result } = await runAck(runner);
    expect(result).toEqual({ acked: true, composerDelivered: true });
    expect(ccCmds(sent)).toHaveLength(0);
    expect(hasSessionCmds(sent)).toHaveLength(0);
  });
});

describe('injectAndAwaitAck busy-baseline is non-ackable', () => {
  // A prompt whose own text looks busy ("esc to interrupt" / spinner) gives no observable idle→busy
  // transition, so dispatch can't confirm submission by screen-scrape and conservatively times out.
  // This is rare (real image dispatch carries plain file paths → idle baseline) and a loud intervention
  // beats a silent false ack. Every busy-baseline outcome is acked:false + intervention.
  it.each([
    {
      name: 'composer "clears" after submit but baseline was busy → still non-ackable',
      settleMs: 150,
      frames: () => (enterSent: boolean) => (enterSent ? 'running the task now\n' : 'review:\n  esc to interrupt\n'),
    },
    {
      name: 'swallowed Enter plus ongoing attach redraw is non-ackable',
      settleMs: 80,
      frames: () => { let n = 0; return () => `review:\n  esc to interrupt\n[Image #1] frame ${n++}\n`; },
    },
    {
      name: 'settled busy baseline plus late attach redraw and swallowed Enter is non-ackable',
      settleMs: 150,
      frames: () => { let post = 0; return (enterSent: boolean) => (enterSent ? `review:\n  esc to interrupt\n[Image #1] frame ${post++}\n` : 'review:\n  esc to interrupt\n'); },
    },
  ])('$name', async ({ frames, settleMs }) => {
    const runner = snapRunner(frames());
    const { result } = await runAck(runner, { ackMs: 150, settleMs, prompt: 'review:\n  esc to interrupt' });
    expect(result).toEqual({ acked: false, composerDelivered: false });
    expect(ackInterventions().length).toBeGreaterThanOrEqual(1);
  });
});

describe('AgentManager max_rounds manual actions', () => {
  function maxRoundsTask(overrides: Partial<TaskState> = {}): TaskState {
    return task({
      id: 'task-mr',
      status: 'max_rounds',
      reviewRound: 2,
      prNumber: 42,
      prUrl: 'https://github.com/user/repo/pull/42',
      branch: 'bx/task-mr',
      ...overrides,
    });
  }

  describe('markTaskComplete', () => {
    it('claims merge-ready before merging, then emits pr.merged to drive the cleanup chain', async () => {
      await taskStore.set(maxRoundsTask());
      const mergeSpy = vi.spyOn(manager, 'mergePr').mockImplementation(async () => {
        // the claim must happen BEFORE the external merge, so the status is already merge-ready here
        expect((await taskStore.get('task-mr'))?.status).toBe('merge-ready');
      });

      const result = await manager.markTaskComplete('task-mr');

      expect(mergeSpy).toHaveBeenCalledWith('task-mr');
      const merged = events.find(e => e.type === 'pr.merged' && e.taskId === 'task-mr');
      expect(merged).toBeTruthy();
      expect(merged!.data).toMatchObject({ prNumber: 42 });
      expect(result.id).toBe('task-mr');
    });

    // A non-max_rounds task and a spec-phase max_rounds (escapes via Retry/Cancel only) must both be
    // refused with 409 and never merge — a direct API call / older client can't slip through.
    it.each([
      { name: 'non-max_rounds task', overrides: { status: 'review' as const } },
      { name: 'spec-phase task', overrides: { phase: 'spec' as const } },
    ])('rejects a $name with 409 (no merge)', async ({ overrides }) => {
      await taskStore.set(maxRoundsTask(overrides));
      const mergeSpy = vi.spyOn(manager, 'mergePr').mockResolvedValue();
      await expect(manager.markTaskComplete('task-mr')).rejects.toMatchObject({ status: 409 });
      expect(mergeSpy).not.toHaveBeenCalled();
    });

    it('rejects a task without a PR with 400', async () => {
      await taskStore.set(maxRoundsTask({ prNumber: undefined, prUrl: undefined }));
      await expect(manager.markTaskComplete('task-mr')).rejects.toMatchObject({ status: 400 });
    });

    // G3: a held (awaiting_human) dev would survive post-merge cleanup (it skips awaiting_human),
    // orphaning a merged task on a bound+locked dev — refuse before merging.
    it('rejects with 409 (no merge) when the dev is awaiting_human (held)', async () => {
      await taskStore.set(maxRoundsTask());
      await seedAgent({
        id: 'dev-1', status: 'awaiting_human',
        awaitingPhase: 'signal-arm-failed:pr-fixed', taskId: 'task-mr',
        worktreePath: '/tmp/repo/.baxian-worktrees/task-mr_abc', paneId: '%1',
      });
      const mergeSpy = vi.spyOn(manager, 'mergePr').mockResolvedValue();
      await expect(manager.markTaskComplete('task-mr')).rejects.toMatchObject({ status: 409 });
      expect(mergeSpy).not.toHaveBeenCalled();
      expect((await taskStore.get('task-mr'))?.status).toBe('max_rounds');
    });

    // H1: same for a held QA still bound to the task (a refused max_rounds release retains qaAgentId).
    // Otherwise merge would land + pr.merged cleanup skips the held QA → merged + bound QA orphan.
    it('rejects with 409 (no merge) when the QA is awaiting_human and bound to the task', async () => {
      await taskStore.set(maxRoundsTask({ qaAgentId: 'qa-1' }));
      await seedAgent({
        id: 'dev-1', status: 'waiting',
        taskId: 'task-mr', worktreePath: '/tmp/repo/.baxian-worktrees/task-mr_abc', paneId: '%1',
      });
      await seedAgent({
        id: 'qa-1', status: 'awaiting_human',
        awaitingPhase: 'ack_unknown', taskId: 'task-mr', paneId: '%2',
      });
      const mergeSpy = vi.spyOn(manager, 'mergePr').mockResolvedValue();
      await expect(manager.markTaskComplete('task-mr')).rejects.toMatchObject({ status: 409 });
      expect(mergeSpy).not.toHaveBeenCalled();
      expect((await taskStore.get('task-mr'))?.status).toBe('max_rounds');
    });

    // A stale qaAgentId whose agent has moved on (bound elsewhere) must NOT block completion.
    it('does not block completion when a held QA is bound to a DIFFERENT task (stale ref)', async () => {
      await taskStore.set(maxRoundsTask({ qaAgentId: 'qa-1' }));
      await seedAgent({
        id: 'qa-1', status: 'awaiting_human',
        taskId: 'some-other-task', paneId: '%2',
      });
      const mergeSpy = vi.spyOn(manager, 'mergePr').mockResolvedValue();
      await manager.markTaskComplete('task-mr');
      expect(mergeSpy).toHaveBeenCalledWith('task-mr');
    });

    it('surfaces a merge failure as 409, rolls back to max_rounds, and does not emit pr.merged', async () => {
      await taskStore.set(maxRoundsTask());
      vi.spyOn(manager, 'mergePr').mockRejectedValue(new Error('gh pr merge failed: not approved'));
      await expect(manager.markTaskComplete('task-mr')).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('not approved'),
      });
      expect(events.some(e => e.type === 'pr.merged')).toBe(false);
      expect((await taskStore.get('task-mr'))?.status).toBe('max_rounds');
    });

    // F1 race: the in-flight claim + merge-ready status serialize Complete against a
    // concurrent Continue / Cancel / Call review — none may act on the same max_rounds snapshot.
    async function completeInFlight(): Promise<{ release: () => void; done: Promise<TaskState> }> {
      await taskStore.set(maxRoundsTask());
      await seedAgent({
        id: 'dev-1', status: 'waiting',
        taskId: 'task-mr', worktreePath: '/tmp/repo/.baxian-worktrees/task-mr_abc',
        paneId: '%1',
      });
      let release: () => void = () => {};
      vi.spyOn(manager, 'mergePr').mockImplementation(
        () => new Promise<void>(resolve => { release = resolve; }),
      );
      const done = manager.markTaskComplete('task-mr');
      await waitUntilAsync(async () => (await taskStore.get('task-mr'))?.status === 'merge-ready');
      return { release, done };
    }

    it('claims so a racing continueDevRound is rejected (no merge-while-fixing)', async () => {
      const { release, done } = await completeInFlight();
      await expect(manager.continueDevRound('task-mr')).rejects.toMatchObject({ status: 409 });
      release();
      await done;
    });

    it('claims so a racing cancelTask is rejected (no merge-then-skip-cleanup)', async () => {
      const { release, done } = await completeInFlight();
      await expect(manager.cancelTask('task-mr')).rejects.toMatchObject({ status: 409 });
      expect((await taskStore.get('task-mr'))?.status).toBe('merge-ready');
      release();
      await done;
    });

    it('claims so a racing dispatchReviewToQa (Call review) is rejected (no merge-while-reviewing)', async () => {
      const { release, done } = await completeInFlight();
      await expect(manager.dispatchReviewToQa('task-mr')).rejects.toMatchObject({ status: 409 });
      expect((await taskStore.get('task-mr'))?.status).toBe('merge-ready');
      release();
      await done;
    });
  });

  describe('continueDevRound', () => {
    async function bindReservedDev(): Promise<void> {
      await seedAgent({
        id: 'dev-1', status: 'waiting',
        taskId: 'task-mr', worktreePath: '/tmp/repo/.baxian-worktrees/task-mr_abc',
        paneId: '%1',
      });
    }

    // Seed a max_rounds task + reserved dev, then mock the acquire + pr-fixed watcher arm so the
    // continueDevRound dispatch reaches continueSession; `armed` toggles the watcher outcome.
    async function setupContinueDev(armed: boolean): Promise<void> {
      await taskStore.set(maxRoundsTask());
      await bindReservedDev();
      vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
      vi.spyOn(manager as unknown as { rotateAndSetupPhaseSignal: () => Promise<{ armed: boolean }> },
        'rotateAndSetupPhaseSignal').mockResolvedValue({ armed });
    }

    it('transitions max_rounds → fixing, bumps the round, and dispatches the fix', async () => {
      await setupContinueDev(true);
      const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);

      const result = await manager.continueDevRound('task-mr');

      expect(result.status).toBe('fixing');
      expect(result.reviewRound).toBe(3);
      expect(continueSpy).toHaveBeenCalledWith('task-mr', 'dev-1', 'fix');
    });

    it.each([
      { name: 'non-max_rounds task', overrides: { status: 'fixing' as const } },
      { name: 'spec-phase task', overrides: { phase: 'spec' as const } },
    ])('rejects a $name with 409', async ({ overrides }) => {
      await taskStore.set(maxRoundsTask(overrides));
      await bindReservedDev();
      await expect(manager.continueDevRound('task-mr')).rejects.toMatchObject({ status: 409 });
    });

    it('rejects with 409 when the reserved worktree is gone, pointing at complete/cancel (not Retry)', async () => {
      await taskStore.set(maxRoundsTask());
      await seedAgent({ id: 'dev-1', taskId: 'task-mr' }); // no worktreePath
      await expect(manager.continueDevRound('task-mr')).rejects.toMatchObject({
        status: 409,
        message: expect.stringMatching(/mark-complete|cancel/),
      });
      expect((await taskStore.get('task-mr'))?.status).toBe('max_rounds');
    });

    it('rolls back to max_rounds and Holds the dev when the pr-fixed watcher fails to arm', async () => {
      await setupContinueDev(false);
      const holdSpy = vi.spyOn(manager, 'markAwaitingHuman').mockResolvedValue();
      const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);

      await expect(manager.continueDevRound('task-mr')).rejects.toMatchObject({ status: 500 });
      expect(continueSpy).not.toHaveBeenCalled();
      expect(holdSpy).toHaveBeenCalled();
      const t = await taskStore.get('task-mr');
      expect(t?.status).toBe('max_rounds');
      expect(t?.reviewRound).toBe(2);
    });

    // F2: a failed dispatch must roll the task back to max_rounds AND re-park the dev to waiting.
    it('rolls back to max_rounds and re-parks the dev when continueSession returns false', async () => {
      await setupContinueDev(true);
      vi.spyOn(manager, 'continueSession').mockResolvedValue(false);
      const waitSpy = vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);

      await expect(manager.continueDevRound('task-mr')).rejects.toMatchObject({ status: 500 });
      const t = await taskStore.get('task-mr');
      expect(t?.status).toBe('max_rounds');
      expect(t?.reviewRound).toBe(2);
      expect(waitSpy).toHaveBeenCalledWith('dev-1', 'task-mr');
    });
  });

  it('markAgentWaiting succeeds for a dev bound to a max_rounds task (active set unification)', async () => {
    await taskStore.set(maxRoundsTask());
    await seedAgent({
      id: 'dev-1', status: 'running',
      taskId: 'task-mr', paneId: '%1',
    });
    await expect(manager.markAgentWaiting('dev-1', 'task-mr')).resolves.toBe(true);
  });

  it('failTasksForAgent fails a max_rounds task when its reserved dev dies', async () => {
    await taskStore.set(maxRoundsTask());
    await seedAgent({
      id: 'dev-1', status: 'waiting', taskId: 'task-mr',
    });
    const { failedTaskIds } = await manager.failTasksForAgent('dev-1', 'tmux-absent');
    expect(failedTaskIds).toContain('task-mr');
    expect((await taskStore.get('task-mr'))?.status).toBe('failed');
  });

  // F4: with qaAgentId cleared at the pause, a later failure of the released QA must not
  // false-fail the paused task (it only matches by name on agentId/qaAgentId).
  it('failTasksForAgent does NOT fail a max_rounds task whose qaAgentId was cleared on release', async () => {
    await taskStore.set(maxRoundsTask({ qaAgentId: undefined }));
    const { failedTaskIds } = await manager.failTasksForAgent('qa-1', 'tmux-absent');
    expect(failedTaskIds).not.toContain('task-mr');
    expect((await taskStore.get('task-mr'))?.status).toBe('max_rounds');
  });

  describe('retryTask phase gate', () => {
    it('rejects code-phase max_rounds with 409 (use continue/complete instead)', async () => {
      await taskStore.set(maxRoundsTask());
      await expect(manager.retryTask('task-mr')).rejects.toMatchObject({ status: 409 });
    });

    it('allows spec-phase max_rounds to retry AND finalizes the old task (no lingering active duplicate)', async () => {
      await taskStore.set(maxRoundsTask({ phase: 'spec' }));
      vi.spyOn(manager, 'validateTaskDispatch').mockResolvedValue();
      const createSpy = vi
        .spyOn(manager, 'createAndStartTask')
        .mockResolvedValue(task({ id: 'task-mr-retry', status: 'in_progress' }));

      const fresh = await manager.retryTask('task-mr');

      expect(createSpy).toHaveBeenCalled();
      expect(fresh.id).toBe('task-mr-retry');
      // F3: the old non-terminal task must be finalized so it leaves the active list.
      expect((await taskStore.get('task-mr'))?.status).toBe('cancelled');
    });
  });

  it('cancelTask cancels a max_rounds task (non-terminal) and releases the reserved dev', async () => {
    await taskStore.set(maxRoundsTask());
    await seedAgent({
      id: 'dev-1', status: 'waiting',
      taskId: 'task-mr', paneId: '%1',
    });
    mockInterruptPane(manager, true);
    stubClearPane(manager);
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);

    const cancelled = await manager.cancelTask('task-mr');

    expect(cancelled.status).toBe('cancelled');
    expect(releaseSpy).toHaveBeenCalledWith('dev-1', 'task-mr', 'idle', { allowAwaitingHuman: true, fromCancelCleanup: true });
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 300): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('waitUntil: predicate never became true');
}

async function waitUntilAsync(predicate: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('waitUntilAsync: predicate never became true');
}

describe('AgentManager — non-GitHub platform derivation', () => {
  const GL = 'https://gitlab.example.com/group/proj.git';

  function makeMgr(config: BaxianConfig): AgentManager {
    return makeManager({ config, skillRegistry: freshRegistry() });
  }

  function cfg(opts: {
    mode?: 'github' | 'server';
    afterDone?: 'pr' | 'branch' | null;
    ghReviewMode?: 'github' | 'server';
    glReviewMode?: 'github' | 'server';
    glHasQa?: boolean;
  }): BaxianConfig {
    const dev = { id: 'gldev', runtime: 'claude-code' as const, role: 'dev' as const, mode: 'local' as const, workdir: '/tmp/repo' };
    const qa = { id: 'glqa', runtime: 'codex' as const, role: 'qa' as const, mode: 'local' as const, workdir: '/tmp/repo' };
    return {
      review: {
        rounds: 2,
        ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
        ...(opts.afterDone !== undefined ? { afterDone: opts.afterDone } : {}),
      },
      server: DEFAULT_SERVER_CONFIG,
      project: [
        {
          id: 'gh', repo: 'user/repo', merge: null,
          ...(opts.ghReviewMode !== undefined ? { review: { mode: opts.ghReviewMode } } : {}),
          agent: [],
        },
        {
          id: 'gl', repo: GL, merge: null,
          review: { mode: opts.glReviewMode ?? 'server' },
          agent: [opts.glHasQa === false ? [dev] : [dev, qa]],
        },
      ],
    };
  }

  it('effectiveReviewMode: project override wins for github repos; non-github stays server', () => {
    const mGh = makeMgr(cfg({ mode: 'github' }));
    expect(mGh.effectiveReviewMode('gh')).toBe('github');
    expect(mGh.effectiveReviewMode('gl')).toBe('server');

    const mSrv = makeMgr(cfg({ mode: 'server' }));
    expect(mSrv.effectiveReviewMode('gh')).toBe('server');
    expect(mSrv.effectiveReviewMode('gl')).toBe('server');

    const mDef = makeMgr(cfg({}));
    expect(mDef.effectiveReviewMode('gh')).toBe('github');
    expect(mDef.effectiveReviewMode('gl')).toBe('server');

    const mMixed = makeMgr(cfg({ mode: 'server', ghReviewMode: 'github', glReviewMode: 'server' }));
    expect(mMixed.effectiveReviewMode('gh')).toBe('github');
    expect(mMixed.effectiveReviewMode('gl')).toBe('server');

    const mProjectServer = makeMgr(cfg({ mode: 'github', ghReviewMode: 'server' }));
    expect(mProjectServer.effectiveReviewMode('gh')).toBe('server');
  });

  it('effectiveReviewMode: github projects without overrides follow global mode changes', () => {
    const m = makeMgr(cfg({ mode: 'server' }));
    expect(m.effectiveReviewMode('gh')).toBe('server');

    m.replaceConfig(cfg({ mode: 'github' }));
    expect(m.effectiveReviewMode('gh')).toBe('github');
  });

  it('createTask snapshots the project review mode override', async () => {
    const githubOverride = makeMgr(cfg({ mode: 'server', ghReviewMode: 'github' }));
    const githubTask = await githubOverride.createTask('gh', {
      title: 'T',
      description: 'D',
      preferredAgentId: '',
    });
    expect(githubTask.reviewMode).toBe('github');

    const serverOverride = makeMgr(cfg({ mode: 'github', ghReviewMode: 'server' }));
    const serverTask = await serverOverride.createTask('gh', {
      title: 'T',
      description: 'D',
      preferredAgentId: '',
    });
    expect(serverTask.reviewMode).toBe('server');
  });

  it('resolveAfterDone: non-github coerces pr/unset → branch; explicit null honored; github unchanged', () => {
    const t = (projectId: string, afterDone?: 'pr' | 'branch' | null) =>
      task({ projectId, ...(afterDone !== undefined ? { afterDone } : {}) });

    let m = makeMgr(cfg({ mode: 'github' }));                  // afterDone unset
    expect(m.resolveAfterDone(t('gl'))).toBe('branch');         // deliver-by-default
    expect(m.resolveAfterDone(t('gh'))).toBe(null);             // github default unchanged

    m = makeMgr(cfg({ mode: 'github', afterDone: 'pr' }));
    expect(m.resolveAfterDone(t('gl'))).toBe('branch');         // no PR platform → branch
    expect(m.resolveAfterDone(t('gh'))).toBe('pr');

    m = makeMgr(cfg({ mode: 'github', afterDone: null }));
    expect(m.resolveAfterDone(t('gl'))).toBe(null);             // explicit review-only honored

    m = makeMgr(cfg({ mode: 'github', afterDone: 'branch' }));
    expect(m.resolveAfterDone(t('gl'))).toBe('branch');
  });

  it('resolveAfterDone: an explicit task.afterDone snapshot wins over coercion', () => {
    const m = makeMgr(cfg({ mode: 'github', afterDone: 'pr' }));
    expect(m.resolveAfterDone(task({ projectId: 'gl', afterDone: null }))).toBe(null);
  });

  it('createTask allows a server-mode (non-github) dev without QA partner', async () => {
    await agentStore.set({ id: 'gldev', projectId: 'gl', updatedAt: NOW });
    const m = makeMgr(cfg({ glHasQa: false }));
    const created = await m.createTask('gl', { title: 'T', description: 'D', preferredAgentId: 'gldev' });
    expect(created.reviewMode).toBe('server');
    expect(created.qaAgentId).toBeUndefined();
  });

  it('createTask allows a non-github dev that DOES have a QA partner (snapshots server mode)', async () => {
    await agentStore.set({ id: 'gldev', projectId: 'gl', updatedAt: NOW });
    const m = makeMgr(cfg({ glHasQa: true }));
    const created = await m.createTask('gl', { title: 'T', description: 'D', preferredAgentId: 'gldev' });
    expect(created.reviewMode).toBe('server');
    expect(created.qaAgentId).toBe('glqa');
  });

  it('resolveAfterDone through prepareConfig: non-github with omitted afterDone delivers (branch)', () => {
    // Production path: prepareConfig must NOT collapse an omitted afterDone to null, or the
    // non-github deliver-by-default would silently degrade to review-only.
    const prepared = prepareConfig({
      review: { rounds: 2, mode: 'server' },
      project: [{ id: 'gl', repo: GL, merge: null, agent: [[
        { id: 'gldev', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp/repo' },
        { id: 'glqa', runtime: 'codex', role: 'qa', mode: 'local', workdir: '/tmp/repo' },
      ]] }],
    });
    const m = makeMgr(prepared);
    expect(m.resolveAfterDone(task({ projectId: 'gl' }))).toBe('branch');
  });
});
