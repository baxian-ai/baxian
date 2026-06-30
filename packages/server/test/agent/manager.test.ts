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
      const frame = rejected.has(pane)
        ? `■ '/clear' is disabled while a task is in progress.\n${info.idle}`
        : clearTyped.has(pane) ? `${info.idle} /clear` : info.idle;
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
      if (cmd.includes('send-keys') && cmd.includes("'Enter'")) busyLeft = busyCaptures;
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

function mockInterruptPane(mgr: AgentManager, ok: boolean): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(mgr as unknown as { interruptPaneAndWaitReady: () => Promise<boolean> }, 'interruptPaneAndWaitReady')
    .mockResolvedValue(ok) as ReturnType<typeof vi.spyOn>;
}

function stubClearPane(mgr: AgentManager, confirmed = true): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(mgr as unknown as { clearPaneContext: () => Promise<boolean> }, 'clearPaneContext')
    .mockResolvedValue(confirmed) as ReturnType<typeof vi.spyOn>;
}

function freshRegistry(): SkillRegistry {
  return new SkillRegistry(join(tempDir, 'skills'));
}

function makeInjectManager(runner: CommandRunner, ackMs: number, settleMs: number): AgentManager {
  return makeManager({
    skillRegistry: freshRegistry(),
    runnerFactory: () => runner,
    dispatchAckTimeoutMs: ackMs,
    dispatchSettleTimeoutMs: settleMs,
  });
}

type AckResult = { acked: boolean; composerDelivered?: boolean };

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

function seedAgent(overrides: Partial<AgentBindingFacts> & { id: string }): Promise<void> {
  return agentStore.set({ projectId: 'proj', updatedAt: NOW, ...overrides });
}

async function seedTask(overrides: Partial<TaskState> = {}): Promise<TaskState> {
  const t = task(overrides);
  await taskStore.set(t);
  return t;
}

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

function captureInjection(into: string[]): (cmd: string) => void {
  return (cmd: string) => {
    const m = cmd.match(/printf '%s' '([^']+)'/);
    if (m && cmd.includes('load-buffer')) into.push(Buffer.from(m[1], 'base64').toString('utf8'));
  };
}

async function seedPhaseSkillsAtDir(skillsDir: string): Promise<void> {
  for (const name of ['baxian-task-check', 'baxian-pr-feedback', 'baxian-pr-review', 'baxian-pr-recheck', 'baxian-signals']) {
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
    expect(created.status).toBe('in_progress');
  });

  it('createAndStartTask({ background: true }) returns without waiting for the session bootstrap', async () => {
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

    expect(created.status).toBe('in_progress');
    await rollbackDone;
    expect(rollbackSpy).toHaveBeenCalledTimes(1);
  });

  function mockStartSessionThatCancels(): void {
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

  it('validateTaskDispatch fails fast when baxian-signals is missing (preview carries a signal token)', async () => {
    const partialDir = join(tempDir, 'skills-no-signals');
    await mkdir(join(partialDir, 'baxian-task-check'), { recursive: true });
    await writeFile(
      join(partialDir, 'baxian-task-check', 'SKILL.md'),
      `---\nname: baxian-task-check\ndescription: stub\n---\nstub`,
    );
    const registry = new SkillRegistry(partialDir);
    await registry.scan();
    const mgr2 = makeManager({ skillRegistry: registry });
    await seedAgent({ id: 'dev-1' });

    let caught: unknown;
    try {
      await mgr2.validateTaskDispatch('proj', { title: 'x', description: 'y', preferredAgentId: 'dev-1' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(500);
    expect((caught as Error).message).toMatch(/baxian-signals/);
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
    vi.spyOn(manager as unknown as { injectAndAwaitAck: () => Promise<void> }, 'injectAndAwaitAck')
      .mockRejectedValue(new DispatchTerminalError('ack_unknown', 'simulated ack_unknown from infra failure'));
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

    const stateAfter = await agentStore.get('dev-1');
    expect(stateAfter?.taskId).toBe(t.id);
    expect(stateAfter?.worktreePath).toBeTruthy();
    expect(stateAfter?.updatedAt).not.toBe(beforeUpdatedAt);
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('startSession cleanup leaves the binding when cancel took it over (cancel-clearing) during the mutex wait', async () => {
    const t = await seedTask({ id: 'task-ss-cancel-clearing', branch: 'bx/task-ss-cancel-clearing' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await lockManager.acquire('dev-1');

    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%0', workdir: '/tmp/repo',
    });
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
    expect(stateAfter?.taskId).toBe(t.id);
    expect(stateAfter?.awaitingPhase).toBe('cancel-clearing');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('startSession set-running write preserves a cancel-clearing hold present at write time (does NOT wipe it)', async () => {
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

    expect(result).toBe(false);
    expect(injectSpy).not.toHaveBeenCalled();
    const stateAfter = await agentStore.get('dev-1');
    expect(stateAfter?.taskId).toBe(t.id);
    expect(stateAfter?.awaitingPhase).toBe('cancel-clearing');
    expect(stateAfter?.bootstrappingTaskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('rollbackFailedDispatch leaves the binding/lock when the agent is held by cancel cleanup', async () => {
    const t = await seedTask({ id: 'task-rollback-cancel', status: 'cancelled' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await lockManager.acquire('dev-1');

    await (manager as unknown as { rollbackFailedDispatch: (tid: string, aid: string) => Promise<void> })
      .rollbackFailedDispatch(t.id, 'dev-1');

    const st = await agentStore.get('dev-1');
    expect(st?.taskId).toBe(t.id);
    expect(st?.awaitingPhase).toBe('cancel-clearing');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('failTaskForDispatchError on ack_unknown releases partner agents (terminal cleanup)', async () => {
    const t = await seedTask({ id: 'task-ack-partner', status: 'review', qaAgentId: 'qa-1' });
    await seedAgent({
      id: 'qa-1', taskId: t.id, paneId: '%1',
    });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await lockManager.acquire('qa-1');
    await lockManager.acquire('dev-1');

    await manager.failTaskForDispatchError(
      t.id, 'review', 'qa-1',
      new DispatchTerminalError('ack_unknown', 'simulated'),
    );

    expect((await agentStore.get('qa-1'))?.status).toBe('awaiting_human');
    expect((await agentStore.get('qa-1'))?.taskId).toBe(t.id);
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
    await seedReviewable({ status: 'approved' }, { paneId: '%0' });
    vi.spyOn(manager, 'markAgentWaiting').mockRejectedValue(new Error('store IO failure'));
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await expect(manager.dispatchReviewToQa('task-review')).rejects.toMatchObject({ status: 500 });

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

  it('rejects spec-phase max_rounds with 409 (Call review uses the code protocol, inert for spec)', async () => {
    await taskStore.set(reviewable({ status: 'max_rounds', phase: 'spec' }));
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await expect(manager.dispatchReviewToQa('task-review')).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/spec-phase max_rounds|Retry or Cancel/),
    });
    expect(startSpy).not.toHaveBeenCalled();
    expect((await taskStore.get('task-review'))?.status).toBe('max_rounds');
  });

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
    await seedReviewable();
    vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);
    const dialogErr = new EnsureSessionError(
      { createdSession: true, agentId: 'qa-1', dialogPending: true, handled: true },
      'manual review runtime dialog already handled',
    );
    vi.spyOn(manager, 'startSession').mockRejectedValue(dialogErr);
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);

    await expect(manager.dispatchReviewToQa('task-review')).rejects.toBe(dialogErr);
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
    await seedTask({ status: 'cancelled' });
    await seedAgent({ id: 'qa-1' });

    const result = await manager.startSession('task-1', 'qa-1', 'server-spec-review', {
      bypassTaskStatusGate: true,
    });
    expect(result).toBe(false);
    expect((await taskStore.get('task-1'))?.status).toBe('cancelled');
  });
});

describe('AgentManager dispatch & skill provisioning', () => {
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

  function mockEnsureSession(over: { createdSession?: boolean; freshRuntime?: boolean; paneId?: string } = {}): void {
    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%0', workdir: '/tmp/repo', ...over,
    });
  }

  function useWorkdirRunner(): void {
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => workdirRunner();
  }

  type ProvisionFn = (runner: CommandRunner, agent: AgentConfig, workdir: string) => Promise<void>;
  const provision = (mgr: AgentManager): ProvisionFn =>
    (mgr as unknown as { provisionRepoSkills: ProvisionFn }).provisionRepoSkills.bind(mgr);

  function agentConfig(over: Partial<AgentConfig> & { id: string }): AgentConfig {
    return { projectId: 'proj', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp/repo', ...over } as unknown as AgentConfig;
  }

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
    expect(prompts[0]).toContain('signal: pr-created');
    expect(prompts[0]).not.toContain('spec-signal:');
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
    expect(prompts[0]).toContain('spec-signal: spec-done');
    expect(prompts[0]).toContain('signal: pr-created');
  });

  it('startSession marks bootstrappingTaskId during dispatch and clears it once the prompt is ack\'d', async () => {
    const t = await seedTask({ id: 'task-deliver-1', branch: 'bx/task-deliver-1' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await lockManager.acquire('dev-1');
    expect((await agentStore.get('dev-1'))?.bootstrappingTaskId).toBeUndefined();

    mockEnsureSession();
    let markerDuringInject: string | undefined;
    spyInject(manager, async () => {
      markerDuringInject = (await agentStore.get('dev-1'))?.bootstrappingTaskId;
      return { acked: true, composerDelivered: true };
    });
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
    const t = await seedTask({ id: 'task-deliver-2', branch: 'bx/task-deliver-2' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await lockManager.acquire('dev-1');

    mockEnsureSession();
    useWorkdirRunner();

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

    expect(ok).toBe(true);
    expect(removeSpy).not.toHaveBeenCalled();
    expect(holdSpy).toHaveBeenCalledWith(
      'dev-1', 'bootstrap-marker-clear-failed', expect.any(String), { expectedTaskId: t.id },
    );
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

    mockEnsureSession({ createdSession: true, freshRuntime: true });
    const prompts = capturePrompts(manager);
    useWorkdirRunner();

    const ok = await manager.continueSession(t.id, 'dev-1', 'post-approve', {
      signalToken: 'tok',
      postApproveRedispatchCount: 5,
    });
    expect(ok).toBe(true);

    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain('phase: post-approve');
    expect(prompts[0]).toContain('signal: pr-merge-ready');
    expect(prompts[0]).not.toContain('redispatch:');
  });

  it('continueSession post-approve: reused runtime + redispatchCount>0 uses incremental nudge', async () => {
    const t = await seedTask({ id: 'task-reuse-redispatch', branch: 'bx/task-reuse-redispatch', status: 'approved' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      worktreePath: '/tmp/repo/.baxian-worktrees/wt',
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
    expect(prompts[0]).toContain('redispatch: 2');
    expect(prompts[0]).toContain('signal: pr-merge-ready');
  });

  it('startSession runs armBeforeInject before pasting the prompt', async () => {
    const t = await seedTask({ id: 'task-arm-before', branch: 'bx/task-arm-before' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await lockManager.acquire('dev-1');

    mockEnsureSession();
    const prompts = capturePrompts(manager);
    useWorkdirRunner();

    let promptsAtArm = -1;
    const ok = await manager.startSession(t.id, 'dev-1', 'develop', {
      armBeforeInject: async () => { promptsAtArm = prompts.length; return true; },
    });

    expect(ok).toBe(true);
    expect(promptsAtArm).toBe(0);
    expect(prompts.length).toBe(1);
  });

  it('startSession aborts without pasting when armBeforeInject returns false', async () => {
    const t = await seedTask({ id: 'task-arm-abort', branch: 'bx/task-arm-abort' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await lockManager.acquire('dev-1');

    mockEnsureSession();
    const prompts = capturePrompts(manager);
    useWorkdirRunner();

    const ok = await manager.startSession(t.id, 'dev-1', 'develop', {
      armBeforeInject: async () => false,
    });

    expect(ok).toBe(false);
    expect(prompts.length).toBe(0);
  });

  it('continueSession aborts without pasting when armBeforeInject returns false', async () => {
    const t = await seedTask({ id: 'task-arm-abort-cont', branch: 'bx/task-arm-abort-cont', status: 'approved' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      worktreePath: '/tmp/repo/.baxian-worktrees/wt',
    });
    await lockManager.acquire('dev-1');
    await manager['postApproveStore'].set(t.id, { token: 'tok', approvedHeadSha: 'sha' });

    mockEnsureSession();
    const prompts = capturePrompts(manager);
    useWorkdirRunner();

    const ok = await manager.continueSession(t.id, 'dev-1', 'post-approve', {
      signalToken: 'tok', armBeforeInject: async () => false,
    });

    expect(ok).toBe(false);
    expect(prompts.length).toBe(0);
  });

  it('provisionRepoSkills materializes skills under .claude/skills for claude-code and .agents/skills for codex', async () => {
    function capturingRunner(): { exec: ReturnType<typeof vi.fn>; writeFile: ReturnType<typeof vi.fn> } {
      return {
        exec: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
        writeFile: vi.fn(async (): Promise<void> => undefined),
      };
    }
    const devAgent = agentConfig({ id: 'dev-1' });
    const devRunner = capturingRunner();
    await provision(manager)(devRunner as unknown as CommandRunner, devAgent, '/tmp/repo');
    const devStaged = devRunner.writeFile.mock.calls.map(c => c[0] as string);
    expect(devStaged).toContain('/tmp/repo/.claude/skills/baxian-task-check/SKILL.md.baxian-tmp');
    expect(devStaged.every(p => p.endsWith('.baxian-tmp'))).toBe(true);
    expect(devStaged.every(p => !p.includes('/.agents/skills/'))).toBe(true);
    const devMv = devRunner.exec.mock.calls.map(c => c[0] as string).filter(c => c.includes('mv -f'));
    expect(devMv.some(c => c.includes('.claude/skills/baxian-task-check/SKILL.md.baxian-tmp'))).toBe(true);
    expect(devMv.length).toBe(devStaged.length);
    const excludeCmd = devRunner.exec.mock.calls.map(c => c[0] as string).find(c => c.includes('info/exclude'));
    expect(excludeCmd).toBeDefined();
    expect(excludeCmd).toContain('.claude/skills/baxian-*');
    expect(excludeCmd).not.toContain("'.claude/skills/'");
    expect(excludeCmd).toContain('sh -c');
    expect(excludeCmd).toContain('show-prefix');
    const guardCmd = devRunner.exec.mock.calls.map(c => c[0] as string).find(c => c.includes('[ -L'));
    expect(guardCmd).toBeDefined();
    expect(guardCmd).toContain('sh -c');
    expect(guardCmd).toContain('find .claude/skills -maxdepth 1 -name');
    expect(guardCmd).toContain('baxian-*');
    expect(guardCmd).toContain('! -name');
    expect(guardCmd).toContain('readlink');
    expect(guardCmd).toContain('-type l -exec rm -f');
    expect(guardCmd).toContain('-type f ! -name');
    expect(guardCmd).toContain('SKILL.md');

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
    await provision(manager)(runner as unknown as CommandRunner, agent, '/repo-b');
    const written = runner.writeFile.mock.calls.map(c => c[0] as string);
    expect(written.some(p => p.includes('/repo-b/.claude/skills/baxian-task-check/SKILL.md'))).toBe(true);
  });

  it('provisionRepoSkills serializes concurrent same-dir provisioning (no overlapping cleanup)', async () => {
    let active = 0;
    let maxActive = 0;
    const runner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('[ -L')) {
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
    expect(maxActive).toBe(1);
  });

  it('provisionRepoSkills fails fast on a symlinked parent skills dir (no silent rm of user config)', async () => {
    const runner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> =>
        cmd.includes('[ -L')
          ? { stdout: '', stderr: 'baxian: .claude/skills is a symlink -> /shared/skills; replace it with a real directory', exitCode: 3 }
          : { stdout: '', stderr: '', exitCode: 0 }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const agent = agentConfig({ id: 'dev-sym' });
    await expect(provision(manager)(runner as unknown as CommandRunner, agent, '/tmp/repo')).rejects.toThrow(/symlink-safe/);
    expect(runner.writeFile.mock.calls.length).toBe(0);
  });

  it('skillDirLockKey canonicalizes host + workdir so equivalent agents serialize', async () => {
    const skillRegistry = new SkillRegistry(join(tempDir, 'skills'));
    await skillRegistry.scan();
    const cfg: BaxianConfig = { ...CONFIG, host: [{ id: 'box', hostname: 'h', user: 'u', port: 22 }] };
    const m = makeManager({ config: cfg, skillRegistry });
    const key = (a: object, w: string) =>
      (m as unknown as { skillDirLockKey: (a: AgentConfig, w: string) => string }).skillDirLockKey(a as AgentConfig, w);
    const byId = { runtime: 'claude-code', mode: 'remote', host: 'box' };
    const byInline = { runtime: 'claude-code', mode: 'remote', host: { hostname: 'h', user: 'u', port: 22 } };
    expect(key(byId, '/repo')).toBe(key(byInline, '/repo'));
    expect(key(byId, '/repo/')).toBe(key(byId, '/repo'));
    expect(key(byId, '/other')).not.toBe(key(byId, '/repo'));
    expect(key({ ...byId, runtime: 'codex' }, '/repo')).not.toBe(key(byId, '/repo'));
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
    expect(ccAt).toBeGreaterThanOrEqual(0);
    expect(clearAt).toBeGreaterThan(ccAt);
    expect(enterAfterClear).toBeGreaterThan(clearAt);
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
    expect(sentKeys.filter(k => k.includes("'Escape'"))).toHaveLength(0);
    expect(sentKeys.filter(k => k.includes('/clear'))).toHaveLength(0);
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
          return { stdout: 'Tool use: Bash\nstill streaming...\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const localManager = makeManager({ skillRegistry: freshRegistry(), runnerFactory: () => runner });

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
    expect(sentKeys.filter(k => k.includes('/clear'))).toHaveLength(0);
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

  it('holds the agent (no release) when /clear injection fails', async () => {
    const sentKeys: string[] = [];
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('send-keys')) {
          sentKeys.push(cmd);
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
    (localManager as unknown as { compactInFlight: Set<string> }).compactInFlight.add('dev-1');

    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await lockManager.acquire('dev-1');

    const cancelled = await localManager.cancelTask(t.id);

    expect(cancelled.status).toBe('cancelled');
    expect(sentKeys.some(k => k.includes('/clear'))).toBe(false);
    const stateAfter = await agentStore.get('dev-1');
    expect(stateAfter?.taskId).toBe(t.id);
    expect(stateAfter?.status).toBe('awaiting_human');
    expect(stateAfter?.awaitingPhase).toBe('cancel-clear-failed');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('interrupts both panes before clearing either, so a failed dev /clear does not strand qa', async () => {
    const sentKeys: string[] = [];
    const localManager = makeManager({
      skillRegistry: freshRegistry(),
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

    const qaEsc = sentKeys.findIndex(k => k.includes('%1') && k.includes("'Escape'"));
    const devClear = sentKeys.findIndex(k => k.includes('%0') && k.includes('send-keys -l') && k.includes('/clear'));
    expect(qaEsc).toBeGreaterThanOrEqual(0);
    expect(devClear).toBeGreaterThanOrEqual(0);
    expect(qaEsc).toBeLessThan(devClear);
    const dev = await agentStore.get('dev-1');
    expect(dev?.status).toBe('awaiting_human');
    expect(dev?.awaitingPhase).toBe('cancel-clear-failed');
    expect(dev?.taskId).toBe(t.id);
    const qa = await agentStore.get('qa-1');
    expect(qa?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('qa-1')).toBe(false);
  });

  it('does not stale-mark a rebound agent as cancel-clear-failed (release+reassign race)', async () => {
    const localManager = makeManager({ skillRegistry: freshRegistry(), runnerFactory: () => readyRunner() });
    mockInterruptPane(localManager, true);

    const t = await seedTask();
    await taskStore.set(task({ id: 'task-new' }));
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await lockManager.acquire('dev-1');

    vi.spyOn(localManager as unknown as { clearPaneContext: () => Promise<boolean> }, 'clearPaneContext')
      .mockImplementation(async () => {
        await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'task-new', paneId: '%0', updatedAt: new Date().toISOString() });
        return false;
      });

    await localManager.cancelTask(t.id);

    const dev = await agentStore.get('dev-1');
    expect(dev?.taskId).toBe('task-new');
    expect(dev?.status).not.toBe('awaiting_human');
    expect(dev?.awaitingPhase).toBeUndefined();
  });

  it('refuses release of a cancel-clearing pane unless it is cancel\'s own (fromCancelCleanup)', async () => {
    const t = await seedTask({ status: 'cancelled' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await lockManager.acquire('dev-1');

    expect(await manager.releaseAgentForTask('dev-1', t.id, 'idle')).toBe(false);
    expect(await manager.releaseAgentForTask('dev-1', t.id, 'idle', { allowAwaitingHuman: true })).toBe(false);
    expect((await agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('dev-1')).toBe(true);

    expect(await manager.releaseAgentForTask('dev-1', t.id, 'idle', { allowAwaitingHuman: true, fromCancelCleanup: true })).toBe(true);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('blocks a concurrent terminal-task escape release while cancel is mid-cleanup', async () => {
    const localManager = makeManager({ skillRegistry: freshRegistry(), runnerFactory: () => readyRunner() });
    stubClearPane(localManager);
    const t = await seedTask({ qaAgentId: 'qa-1' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await lockManager.acquire('dev-1');
    await lockManager.acquire('qa-1');

    let escapeReleaseResult: boolean | undefined;
    vi.spyOn(localManager as unknown as { interruptPaneAndWaitReady: () => Promise<boolean> }, 'interruptPaneAndWaitReady')
      .mockImplementation(async () => {
        if (escapeReleaseResult === undefined) {
          escapeReleaseResult = await localManager.releaseAgentForTask('qa-1', t.id, 'idle');
        }
        return true;
      });

    const cancelled = await localManager.cancelTask(t.id);

    expect(cancelled.status).toBe('cancelled');
    expect(escapeReleaseResult).toBe(false);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await agentStore.get('qa-1'))?.taskId).toBeUndefined();
  });

  it('cancel of one task does not block a rebound agent release by its new task', async () => {
    const localManager = makeManager({ skillRegistry: freshRegistry(), runnerFactory: () => readyRunner() });
    await taskStore.set(task({ id: 'task-old', agentId: 'dev-1', qaAgentId: 'qa-1' }));
    await taskStore.set(task({ id: 'task-new', agentId: 'dev-1' }));
    await seedAgent({ id: 'dev-1', taskId: 'task-new', paneId: '%0' });
    await seedAgent({ id: 'qa-1', taskId: 'task-old', paneId: '%1' });
    await lockManager.acquire('dev-1');
    await lockManager.acquire('qa-1');

    vi.spyOn(localManager as unknown as { interruptPaneAndWaitReady: () => Promise<boolean> }, 'interruptPaneAndWaitReady')
      .mockResolvedValue(true);
    let devReleaseByNewTask: boolean | undefined;
    vi.spyOn(localManager as unknown as { clearPaneContext: () => Promise<boolean> }, 'clearPaneContext')
      .mockImplementation(async () => {
        if (devReleaseByNewTask === undefined) {
          devReleaseByNewTask = await localManager.releaseAgentForTask('dev-1', 'task-new', 'idle');
        }
        return true;
      });

    await localManager.cancelTask('task-old');

    expect(devReleaseByNewTask).toBe(true);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await agentStore.get('qa-1'))?.taskId).toBeUndefined();
  });

  it('a stale cancel does not disturb the cancel-clearing hold of the agent\'s real owner', async () => {
    await taskStore.set(task({ id: 'task-a', agentId: 'dev-1' }));
    await taskStore.set(task({ id: 'task-b', agentId: 'dev-1' }));
    await seedAgent({ id: 'dev-1', taskId: 'task-a', paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });

    await manager.cancelTask('task-b');

    const dev = await agentStore.get('dev-1');
    expect(dev?.taskId).toBe('task-a');
    expect(dev?.awaitingPhase).toBe('cancel-clearing');
    expect(await manager.releaseAgentForTask('dev-1', 'task-a', 'idle')).toBe(false);
    expect((await agentStore.get('dev-1'))?.taskId).toBe('task-a');
  });

  it('does not release a cancel-clear-failed hold via the escape or Resume', async () => {
    const t = await seedTask({ status: 'cancelled' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clear-failed' });
    await lockManager.acquire('dev-1');

    expect(await manager.releaseAgentForTask('dev-1', t.id, 'idle')).toBe(false);
    expect((await agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('dev-1')).toBe(true);

    const res = await manager.resumeAgent('dev-1');
    expect(res.resumed).toBe(false);
    const after = await agentStore.get('dev-1');
    expect(after?.taskId).toBe(t.id);
    expect(after?.awaitingPhase).toBe('cancel-clear-failed');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

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
    const clearAt = sentKeys.findIndex(k => k.includes('send-keys -l') && k.includes('/clear'));
    const entersAfterClear = sentKeys.filter((k, i) => i > clearAt && k.includes("'Enter'"));
    expect(entersAfterClear.length).toBeGreaterThanOrEqual(2);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

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
    const dev = await agentStore.get('dev-1');
    expect(dev?.taskId).toBe(t.id);
    expect(dev?.awaitingPhase).toBe('cancel-clear-failed');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('recover() holds a cancel-clearing agent bound to a cancelled task (restart mid-cleanup)', async () => {
    await taskStore.set(task({ id: 'task-x', status: 'cancelled', agentId: 'dev-1' }));
    await seedAgent({ id: 'dev-1', taskId: 'task-x', paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await lockManager.acquire('dev-1');
    vi.spyOn(manager as unknown as { ensureSession: () => Promise<{ paneId: string }> }, 'ensureSession')
      .mockResolvedValue({ paneId: '%0' });

    await manager.recover();

    const dev = await agentStore.get('dev-1');
    expect(dev?.taskId).toBe('task-x');
    expect(dev?.status).toBe('awaiting_human');
    expect(dev?.awaitingPhase).toBe('cancel-clearing');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('does not auto-release a cancel-interrupt-failed pane (escape/handler), but Resume can', async () => {
    const t = await seedTask({ status: 'cancelled' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed' });
    await lockManager.acquire('dev-1');

    expect(await manager.releaseAgentForTask('dev-1', t.id, 'idle', { allowAwaitingHuman: true })).toBe(false);
    expect((await agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('dev-1')).toBe(true);

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
    expect(dev?.taskId).toBe('task-y');
    expect(dev?.awaitingPhase).toBe('cancel-interrupt-failed');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });
});

describe('interruptPaneAndWaitReady composer recovery', () => {
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
  function spyKeys(proc = 'node'): string[] {
    const keys: string[] = [];
    vi.spyOn(TmuxManager.prototype, 'sendKeysToPane').mockImplementation(async (_p, k) => { keys.push(k); });
    vi.spyOn(TmuxManager.prototype, 'displayMessage').mockResolvedValue(proc);
    return keys;
  }
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
      if (cleared && cleanAfterCtrlC) return;
      throw new Error('repl not ready');
    });
    vi.spyOn(TmuxManager.prototype, 'capturePaneById').mockImplementation(async () => (cleared ? afterCtrlC : dirty));
    return keys;
  }

  const STUCK_COMPOSER =
    '› Title: 优化 Agent Pet 样式\n  1. Agent Pet 再放大一点点\n  2. ...\n  gpt-5.5 xhigh · ~/.baxian/repos/example-owner/example-repo\n';
  const BUSY_LOOKING_COMPOSER =
    '› 排查 codex 卡死，日志：\n  • Working (12s)\n  esc to interrupt\n  gpt-5.5 xhigh · ~/.baxian/repos/example-owner/example-repo\n';
  const LONG_COMPOSER_NO_GLYPH =
    'pasted diagnostics line\n'.repeat(14) + '  gpt-5.5 xhigh · ~/.baxian/repos/example-owner/example-repo\n';
  const CLEARED_BARE_PROMPT = '› \n  gpt-5.5 xhigh · ~/.baxian/repos/example-owner/example-repo\n';
  const NODE_HUMAN_SESSION = 'running diagnostics…\n> \n';
  const CLAUDE_DIRTY = '❯ 修复 web terminal 乱码\n';
  const CLAUDE_CLEARED = '❯ \n';
  const RUNNING_TURN_A = '• Working (12s)\n  esc to interrupt\n';
  const RUNNING_TURN_B = '• Working (13s)\n  esc to interrupt\n';
  const CLAUDE_RUN_A = '✶ Grooving… (12s)\n' + 'tool output\n'.repeat(12) + '❯ \n';
  const CLAUDE_RUN_B = '✶ Grooving… (13s)\n' + 'tool output\n'.repeat(12) + '❯ \n';
  const RUNTIME_MENU = 'Select a model\n  Enter to confirm · Esc to cancel\n';
  const GROWING_OUTPUT_A = 'building project…\n  compiled module 1\n';
  const GROWING_OUTPUT_B = 'building project…\n  compiled module 2\n';
  const BLOCKER_OVER_PROMPT = 'Allow command `rm -rf`?\n  Press Enter to confirm or Esc to cancel\n› \n';

  it('C-c clears an un-submitted composer and verifies it reached a clean composer (qa-1: codex)', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(STUCK_COMPOSER, CLEARED_BARE_PROMPT);

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(true);
    expect(keys).toEqual(['Escape', 'C-c']);
  });

  it('C-c clears a dirty composer whose text contains "Working"/"esc to interrupt" (Issue A)', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(BUSY_LOOKING_COMPOSER, CLEARED_BARE_PROMPT);

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(true);
    expect(keys).toEqual(['Escape', 'C-c']);
  });

  it('C-c clears a LONG composer whose `›` scrolled off — verified by the OUTCOME, not a visible glyph', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(LONG_COMPOSER_NO_GLYPH, CLEARED_BARE_PROMPT);

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(true);
    expect(keys).toEqual(['Escape', 'C-c']);
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
    expect(keys).toEqual(['Escape']);
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
    expect(keys).toEqual(['Escape']);
  });

  it('holds (no C-c) when the pane is no longer running the runtime (crashed to shell)', async () => {
    const keys = spyKeys('zsh');
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockRejectedValue(new Error('repl not ready'));
    const captureSpy = vi.spyOn(TmuxManager.prototype, 'capturePaneById');

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape']);
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('re-checks proc title right before C-c: holds (no C-c) if the runtime crashed to a shell during the liveness window', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys: string[] = [];
    vi.spyOn(TmuxManager.prototype, 'sendKeysToPane').mockImplementation(async (_p, k) => { keys.push(k); });
    vi.spyOn(TmuxManager.prototype, 'displayMessage')
      .mockResolvedValueOnce('node')
      .mockResolvedValue('zsh');
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockRejectedValue(new Error('repl not ready'));
    const captureSpy = vi.spyOn(TmuxManager.prototype, 'capturePaneById')
      .mockResolvedValue('idle diagnostics output\n  gpt-5.5 xhigh · ~/repo\n');

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape']);
    expect(captureSpy).toHaveBeenCalled();
  });

  it('holds (no C-c) when the screen is static but the OSC braille title ADVANCES across samples (live turn)', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1 });
    const keys: string[] = [];
    vi.spyOn(TmuxManager.prototype, 'sendKeysToPane').mockImplementation(async (_p, k) => { keys.push(k); });
    vi.spyOn(TmuxManager.prototype, 'displayMessage').mockResolvedValue('node');
    vi.spyOn(TmuxManager.prototype, 'readPaneTitle')
      .mockResolvedValueOnce('⠋ Working')
      .mockResolvedValue('⠙ Working');
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockRejectedValue(new Error('repl not ready'));
    vi.spyOn(TmuxManager.prototype, 'capturePaneById').mockResolvedValue('quiet build output\n  no spinner here\n');

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape']);
  });

  it('does NOT treat a STALE static working-shaped OSC title as live — C-c proceeds (else cancel-interrupt-failed)', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(STUCK_COMPOSER, CLEARED_BARE_PROMPT);
    vi.spyOn(TmuxManager.prototype, 'readPaneTitle').mockResolvedValue('⠹ Working');

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(true);
    expect(keys).toEqual(['Escape', 'C-c']);
  });

  it('an ADVANCING OSC title is live even when the screen momentarily shows a ready-looking prompt', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1 });
    const keys: string[] = [];
    vi.spyOn(TmuxManager.prototype, 'sendKeysToPane').mockImplementation(async (_p, k) => { keys.push(k); });
    vi.spyOn(TmuxManager.prototype, 'displayMessage').mockResolvedValue('node');
    vi.spyOn(TmuxManager.prototype, 'readPaneTitle')
      .mockResolvedValueOnce('⠋ Working')
      .mockResolvedValue('⠙ Working');
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockRejectedValue(new Error('repl not ready'));
    vi.spyOn(TmuxManager.prototype, 'capturePaneById').mockResolvedValue('› \n');

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape']);
  });

  it('holds AFTER one C-c when a human `node` session never becomes a Codex composer (`>` ≠ `›`)', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(NODE_HUMAN_SESSION, NODE_HUMAN_SESSION, { cleanAfterCtrlC: false });

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape', 'C-c']);
  });

  it('holds AFTER C-c when a runtime menu does not dismiss to a clean composer', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(RUNTIME_MENU, RUNTIME_MENU, { cleanAfterCtrlC: false });

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
      .mockResolvedValueOnce(GROWING_OUTPUT_B);

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape']);
  });

  it('holds AFTER C-c when a bare `›` still sits under a permission/confirm blocker', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(BLOCKER_OVER_PROMPT, BLOCKER_OVER_PROMPT, { cleanAfterCtrlC: false });

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape', 'C-c']);
  });

  it('holds DELETE-only (cancel-clear-failed) without sending keys when the pane mutex stays busy past the wait window', async () => {
    Object.assign(manager, { cancelInterruptGuardWaitMs: 30, compactIdlePollMs: 5 });
    const keys = spyKeys();
    (manager as unknown as { compactInFlight: Set<string> }).compactInFlight.add('qa-1');
    await seedAgent({ id: 'qa-1', taskId: 'tBusy', paneId: '%7', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });

    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual([]);
    expect((await agentStore.get('qa-1'))?.awaitingPhase).toBe('cancel-clear-failed');
  });

  it('waits for a busy pane mutex and proceeds once the in-flight dispatch releases it (no instant hold)', async () => {
    Object.assign(manager, { cancelInterruptGuardWaitMs: 2_000, compactIdlePollMs: 5 });
    const keys = spyKeys();
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockResolvedValue(undefined);
    const inFlight = (manager as unknown as { compactInFlight: Set<string> }).compactInFlight;
    inFlight.add('qa-1');
    setTimeout(() => inFlight.delete('qa-1'), 25);

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(true);
    expect(keys).toEqual(['Escape']);
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

  it('injectAndAwaitAck aborts a dispatch whose bound task went terminal while waiting for the pane mutex', async () => {
    const t = await seedTask({ status: 'cancelled' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    const tmux = new TmuxManager(readyRunner());
    await expect(
      callInjectAndAwaitAck(manager, tmux, '%0', 'prompt', 'dev-1', 'claude-code'),
    ).rejects.toThrow(/went terminal/);
  });

  it('injectAndAwaitAck aborts when cancel marked the agent cancel-clearing before the task flips terminal', async () => {
    const t = await seedTask({ status: 'in_progress' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    const tmux = new TmuxManager(readyRunner());
    await expect(
      callInjectAndAwaitAck(manager, tmux, '%0', 'prompt', 'dev-1', 'claude-code'),
    ).rejects.toThrow(/taken over by cancel/);
  });

  it('injectAndAwaitAck re-checks after the task read: aborts before paste if cancel lands during taskStore.get', async () => {
    const t = await seedTask({ status: 'in_progress' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
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
    const t = await seedTask({ status: 'in_progress' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0' });
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
    await seedTask({ id: 'task-rf-hold', status: 'in_progress' });
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
    expect(injectSpy).not.toHaveBeenCalled();
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
    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBe('cancel-clearing');

    await manager.markAwaitingHuman('dev-1', 'cancel-clear-failed', 'cancel /clear unconfirmed');
    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBe('cancel-clear-failed');
  });

  it('markAwaitingHuman does NOT downgrade cancel-clear-failed (DELETE-only) to cancel-interrupt-failed', async () => {
    await seedAgent({ id: 'dev-1', taskId: 'tX', status: 'awaiting_human', awaitingPhase: 'cancel-clear-failed' });
    await manager.markAwaitingHuman('dev-1', 'cancel-interrupt-failed', 'late interrupt failure');
    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBe('cancel-clear-failed');
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
    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBe('cancel-clear-failed');
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
    const m = mgrWithExec(cmd => cmd.includes('/pulls/')
      ? { stdout: '\n2026-06-01T00:03:00Z\n', stderr: '', exitCode: 0 }
      : { stdout: '', stderr: '', exitCode: 0 });
    expect(await m.prHasDevReplySince('task-r', SINCE)).toBe(true);
  });

  it('compares by parsed time so a same-second earlier reply does NOT count', async () => {
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

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'task-x', branch: 'bx/task-x' });

    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('runs the full cycle: idle → /clear → release, with NO agent dialogue', async () => {
    const execs: string[] = [];
    const promptInjections: string[] = [];
    manager = makeManager({ runnerFactory: () => compactRunner(execs, captureInjection(promptInjections)) });
    setCompactTiming(manager);
    await seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', repoPath: '/repo/main' });

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => !(await agentStore.get('dev-1'))?.taskId);

    const joined = execs.join('\n');
    expect(promptInjections).toEqual([]);
    expect(joined).not.toMatch(/tmux (load|paste)-buffer/);
    expect(joined).toMatch(/tmux send-keys -l -t '%5' '\/clear'/);
    expect(joined).not.toMatch(/\/compact/);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('releases after post-merge clear when a small claude pane hides the footer ready anchor', async () => {
    const execs: string[] = [];
    manager = makeManager({ runnerFactory: () => smallPaneClaudeCompactRunner(execs) });
    setCompactTiming(manager);
    await seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', repoPath: '/repo/main' });

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => !(await agentStore.get('dev-1'))?.taskId);

    expect(execs.join('\n')).toMatch(/tmux send-keys -l -t '%5' '\/clear'/);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('runs server-side fetch+prune + branch -D in repoPath, then /clear', async () => {
    const execs: string[] = [];
    manager = makeManager({ runnerFactory: () => compactRunner(execs) });
    setCompactTiming(manager);
    await seedAgent({ id: 'dev-1', paneId: '%5', repoPath: '/repo/main-clone', taskId: 'merged-task' });

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/task-merge' });
    await waitUntilAsync(async () => !(await agentStore.get('dev-1'))?.taskId);

    const fetchCmd = execs.find(c => c.includes('git fetch --prune origin'));
    expect(fetchCmd).toContain("cd '/repo/main-clone'");
    expect(fetchCmd).toContain('git worktree prune');
    const delCmd = execs.find(c => c.includes('git branch -D'));
    expect(delCmd).toContain("git branch -D 'bx/task-merge'");
    expect(execs.join('\n')).toMatch(/tmux send-keys -l -t '%5' '\/clear'/);
  });

  it('removes the worktree before deleting the branch (branch -D would fail while the worktree holds the ref)', async () => {
    const execs: string[] = [];
    manager = makeManager({ runnerFactory: () => compactRunner(execs) });
    setCompactTiming(manager);
    await seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', repoPath: '/repo/main', worktreePath: '/wt/merged-task' });

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
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

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => !(await agentStore.get('dev-1'))?.taskId);

    expect(taskIdDuringBranchDelete).toBe('merged-task');
    expect(execs.join('\n')).toMatch(/tmux send-keys -l -t '%5' '\/clear'/);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('a failed branch delete is logged server-side but does not change the wrap-up — still /clear, never /compact', async () => {
    const BUSY = '⏵⏵ bypass permissions on /tmp/repo\n\n· Compacting… (3s)\n  esc to interrupt\n';
    const IDLE = '⏵⏵ bypass permissions on /tmp/repo\n\n>';
    let busyLeft = 0;
    const execs: string[] = [];
    manager = makeManager({
      runnerFactory: () => ({
        exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
          execs.push(cmd);
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

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => !(await agentStore.get('dev-1'))?.taskId);

    const joined = execs.join('\n');
    expect(joined).toMatch(/tmux send-keys -l -t '%5' '\/clear'/);
    expect(joined).not.toMatch(/\/compact/);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('warns (does not silently skip) when the binding has no repoPath to delete the branch from', async () => {
    const execs: string[] = [];
    manager = makeManager({ runnerFactory: () => compactRunner(execs) });
    setCompactTiming(manager);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task' });

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => !(await agentStore.get('dev-1'))?.taskId);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/no repoPath on binding; skipping local branch delete/));
    const joined = execs.join('\n');
    expect(joined).not.toContain('git branch -D');
    expect(joined).toMatch(/tmux send-keys -l -t '%5' '\/clear'/);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    warnSpy.mockRestore();
  });

  it('treats a fast /clear (busy seen only briefly) as success, not a failed start', async () => {
    const execs: string[] = [];
    manager = makeManager({ runnerFactory: () => compactRunner(execs, undefined, 1) });
    setCompactTiming(manager);
    await seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', repoPath: '/repo/main' });

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
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

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/task-merge' });
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

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
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

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
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

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
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

  it.each([
    'agent_dialog_resolved_runtime',
    'signal-arm-failed:spec-done,pr-created',
  ])('resumeAgent REFUSES on awaitingPhase=%s + active task', async (phase) => {
    const t = await seedTask({ status: 'in_progress' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: phase });
    await lockManager.acquire('dev-1');

    const result = await manager.resumeAgent('dev-1');

    expect(result).toMatchObject({ resumed: false, releasedBinding: false });
    expect(result.reason).toBeTruthy();
    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect((await agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('resumeAgent ALLOWS release on awaitingPhase=agent_dialog_resolved_runtime (slowPoll detected REPL ready)', async () => {
    const t = await seedTask({ status: 'failed' });
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
    const t = task({ status: 'failed' });
    await taskStore.set(t);
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'agent_dialog_pending',
    });
    await lockManager.acquire('dev-1');

    const result = await manager.resumeAgent('dev-1');

    expect(result).toMatchObject({ resumed: false, releasedBinding: false });
    expect(result.reason).toBeTruthy();
    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBe('agent_dialog_pending');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('resumeAgent on agent that is not awaiting_human: noop', async () => {
    await seedAgent({ id: 'dev-1' });

    const result = await manager.resumeAgent('dev-1');

    expect(result).toMatchObject({ resumed: false, releasedBinding: false });
  });

  it('resumeAgent refuses when creationToken still set (bootstrap dialog unresolved)', async () => {
    await seedAgent({
      id: 'dev-1', creationToken: 'tok-still-pending',
      paneId: '%0',
      status: 'awaiting_human',
      awaitingPhase: 'agent_dialog_pending',
    });

    const result = await manager.resumeAgent('dev-1');

    expect(result).toMatchObject({ resumed: false, releasedBinding: false });
    expect(result.reason).toBeTruthy();
    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect((await agentStore.get('dev-1'))?.creationToken).toBe('tok-still-pending');
  });

  it.each([
    { name: 'active task (fixing) refuses', taskId: 'task-qa-stale', taskStatus: 'fixing' as const, expectRelease: false },
    { name: 'terminal task (cancelled) releases', taskId: 'task-qa-cancelled', taskStatus: 'cancelled' as const, expectRelease: true },
  ])('resumeAgent on dev-wait-gate-failed-after-qa-started: $name', async ({ taskId, taskStatus, expectRelease }) => {
    const t = await seedTask({ id: taskId, status: taskStatus });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1', status: 'awaiting_human', awaitingPhase: 'dev-wait-gate-failed-after-qa-started' });
    await lockManager.acquire('qa-1');

    const result = await manager.resumeAgent('qa-1');

    expect(result).toMatchObject({ resumed: expectRelease, releasedBinding: expectRelease });
    if (!expectRelease) expect(result.reason).toBeTruthy();
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

    expect(result).toMatchObject({ resumed: expectRelease, releasedBinding: expectRelease });
    if (!expectRelease) expect(result.reason).toBeTruthy();
    const after = await agentStore.get('qa-1');
    if (expectRelease) {
      expect(after?.taskId).toBeUndefined();
      if (taskStatus === 'failed') expect(after?.status).toBeUndefined();
    } else {
      expect(after?.status).toBe('awaiting_human');
      expect(after?.taskId).toBe(taskId);
    }
    expect(await lockManager.isLocked('qa-1')).toBe(!expectRelease);
  });

  it('dispatchReviewToQa on ack_unknown still transitions task to review (so outcome can be processed)', async () => {
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
    const updated = await taskStore.get(t.id);
    expect(updated?.status).toBe('review');
    expect(updated?.reviewRound).toBe(2);
    expect(updated?.qaAgentId).toBe('qa-1');
    expect((await agentStore.get('qa-1'))?.status).toBe('awaiting_human');
  });

  it('dispatchReviewToQa: emits manual-review-dev-parked-qa-failed (not "interrupted") when QA fails after dev parked', async () => {
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

    const updated = await taskStore.get(t.id);
    expect(updated?.status).toBe('failed');
    expect((await agentStore.get('qa-1'))?.status).toBe('awaiting_human');
  });

  it('dispatchReviewToQa ack_unknown preserves verdict-installed status; new design persists anchor+bump BEFORE startSession', async () => {
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
    expect(updated?.status).toBe('fixing');
    expect(updated?.reviewRound).toBe(2);
  });

  it('dispatchReviewToQa: PHASE 1 persists status="review" + reviewHeadAnchorSha + reviewRound bump BEFORE startSession sees the task', async () => {
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
    expect(tokenAtStart).not.toBe('old-pass-token-1');
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
    watcher.start.mockClear();
    vi.spyOn(m3, 'fetchPrHeadSha').mockResolvedValue('a'.repeat(40));
    vi.spyOn(m3, 'markAgentWaiting').mockResolvedValue(true);
    vi.spyOn(m3, 'startSession').mockResolvedValue(false);

    await expect(m3.dispatchReviewToQa(t.id)).rejects.toBeInstanceOf(ApiError);

    const restored = await taskStore.get(t.id);
    expect(restored?.status).toBe('approved');

    const armCalls = watcher.start.mock.calls.map(c => c[0]);
    const verdictArm = armCalls.find(c => Array.isArray(c.expectedKinds));
    const mergeReadyReArm = armCalls.find(c => c.expectedKinds === 'pr-merge-ready');
    expect(verdictArm).toMatchObject({ taskId: t.id, expectedKinds: ['pr-approved', 'pr-changes-requested'] });
    expect(mergeReadyReArm).toMatchObject({
      taskId: t.id, expectedKinds: 'pr-merge-ready', token: 'completion-tok-XYZ',
    });
  });

  it('dispatchReviewToQa rollback restores snapshot fields', async () => {
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
    expect(restored?.qaAgentId).toBe('qa-orig');
    expect(restored?.signalToken).toBe('tok-old-12345');
    expect(restored?.reviewHeadAnchorSha).toBe('c'.repeat(40));
    expect(restored?.status).toBe('review');
    expect(restored?.reviewRound).toBe(2);
  });

  it('dispatchReviewToQa PHASE 1 always overwrites reviewHeadAnchorSha — fetchPrHeadSha failure clears stale anchor', async () => {
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
    expect(updated?.reviewHeadAnchorSha).toBeUndefined();
  });

  it('handleDialogPendingFromRuntime also releases partner agents on task fail (UI Retry path truly opens)', async () => {
    const t = await seedTask({ id: 'task-partner-cleanup', status: 'in_progress', qaAgentId: 'qa-1' });
    await seedAgent({
      id: 'qa-1', taskId: t.id, paneId: '%1',
    });
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

    expect((await taskStore.get(t.id))?.status).toBe('failed');
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
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
    expect((await taskStore.get(t.id))?.status).toBe('failed');
    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBe('agent_dialog_pending');
    expect(err.partial.handled).toBe(true);
  });

  it('handleDialogPendingFromRuntime task fail SKIPS when outcome moved task past dispatch phase expected status', async () => {
    const t = await seedTask({ id: 'task-outcome-arrived', status: 'approved' });
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
    expect((await taskStore.get(t.id))?.status).toBe('approved');
    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
  });

  it('handleDialogPendingFromRuntime task fail WORKS when task still in dispatch expected fromStatus', async () => {
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
    const t = await seedTask({ id: 'task-already-cancelled', status: 'cancelled' });
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
    expect((await taskStore.get(t.id))?.status).toBe('cancelled');
    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
  });

  it('handleDialogPendingFromRuntime: retry path (state empty + createdSession=true) probes tmux paneId and marks awaiting_human', async () => {
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
    const handled = await manager.handleDialogPendingFromRuntime('dev-1', err);

    expect(handled).toBe(true);
    const state = await agentStore.get('dev-1');
    expect(state?.paneId).toBe('%new');
    expect(state?.status).toBe('awaiting_human');
  });

  it('handleDialogPendingFromRuntime: state empty + createdSession=false returns false (no generation evidence available)', async () => {
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

function ackInterventions(): BaxianEvent[] {
  return events.filter(
    e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'dispatch-ack-timeout',
  );
}

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
    const runner = snapRunner(enterSent => (enterSent ? 'working\n  esc to interrupt\n' : 'composer\n'), () => 5);
    const { result } = await runAck(runner, { ackMs: 1000, settleMs: 1000 });
    expect(result).toEqual({ acked: true, composerDelivered: true });
    expect(runner.sawEnter()).toBe(true);
  });

  it('does NOT ack on scrollback growth from an uncommitted attach redraw when runtime never gets busy', async () => {
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
    expect(hasSessionCmds(sent)).toHaveLength(0);
    expect(sent.filter(c => c.includes('send-keys') && c.includes('Enter'))).toHaveLength(0);
  });

  it.each([
    {
      name: 'clears the composer with C-c after a failed sendEnter → raw',
      onHasSession: undefined as ExecResult | undefined,
      failKeys: 'enter' as 'enter' | 'all',
      sendKeys: { stdout: '', stderr: 'no such pane: %0', exitCode: 1 },
      expectAckUnknown: false,
      hasSessionCount: undefined as number | undefined,
    },
    {
      name: 'a transient C-c failure on a still-live session escalates to ack_unknown',
      onHasSession: { stdout: '', stderr: '', exitCode: 0 },
      failKeys: 'all' as 'enter' | 'all',
      sendKeys: { stdout: '', stderr: 'ssh: connect: connection timed out', exitCode: 1 },
      expectAckUnknown: true,
      hasSessionCount: 1,
    },
    {
      name: 'a C-c failure on a CONFIRMED-DEAD session is reuse-safe → raw (next dispatch rebuilds fresh)',
      onHasSession: { stdout: '', stderr: "can't find session: dev-1", exitCode: 1 },
      failKeys: 'all' as 'enter' | 'all',
      sendKeys: { stdout: '', stderr: 'no such pane: %0', exitCode: 1 },
      expectAckUnknown: false,
      hasSessionCount: 1,
    },
    {
      name: 'an UNCONFIRMABLE session (C-c fails AND has-session probe fails) escalates to ack_unknown',
      onHasSession: { stdout: '', stderr: 'ssh: connect: connection timed out', exitCode: 2 },
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
        expect((await taskStore.get('task-mr'))?.status).toBe('merge-ready');
      });

      const result = await manager.markTaskComplete('task-mr');

      expect(mergeSpy).toHaveBeenCalledWith('task-mr');
      const merged = events.find(e => e.type === 'pr.merged' && e.taskId === 'task-mr');
      expect(merged).toBeTruthy();
      expect(merged!.data).toMatchObject({ prNumber: 42 });
      expect(result.id).toBe('task-mr');
    });

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
      await seedAgent({ id: 'dev-1', taskId: 'task-mr' });
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

    let m = makeMgr(cfg({ mode: 'github' }));
    expect(m.resolveAfterDone(t('gl'))).toBe('branch');
    expect(m.resolveAfterDone(t('gh'))).toBe(null);

    m = makeMgr(cfg({ mode: 'github', afterDone: 'pr' }));
    expect(m.resolveAfterDone(t('gl'))).toBe('branch');
    expect(m.resolveAfterDone(t('gh'))).toBe('pr');

    m = makeMgr(cfg({ mode: 'github', afterDone: null }));
    expect(m.resolveAfterDone(t('gl'))).toBe(null);

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
