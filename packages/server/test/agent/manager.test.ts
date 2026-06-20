import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BaxianConfig, BaxianEvent, TaskState } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
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
        if (busyLeft > 0) {
          busyLeft--;
          return { stdout: BUSY, stderr: '', exitCode: 0 };
        }
        return { stdout: IDLE, stderr: '', exitCode: 0 };
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
        if (busyLeft > 0) {
          busyLeft--;
          return { stdout: BUSY, stderr: '', exitCode: 0 };
        }
        return { stdout: IDLE, stderr: '', exitCode: 0 };
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

async function seedPhaseSkillsAtDir(skillsDir: string): Promise<void> {
  for (const name of ['baxian-rules', 'task-check', 'pr-feedback', 'pr-review', 'pr-recheck', 'spells']) {
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

  manager = new AgentManager({
    config: CONFIG,
    agentStore,
    taskStore,
    lockManager,
    eventBus,
    skillRegistry,
    runnerFactory: () => readyRunner(),
  });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('AgentManager task binding flow', () => {
  it('createTask binds a free preferred dev and holds its lock', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: NOW });

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
    await agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: NOW });

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
    await agentStore.set({ id: 'dev-1', projectId: 'proj', creationToken: 'tok', updatedAt: NOW });
    const pendingDuringCreate = await manager.createTask('proj', {
      title: 'blocked',
      description: 'details',
      preferredAgentId: 'dev-1',
    });
    expect(pendingDuringCreate.status).toBe('pending');

    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'other-task', updatedAt: NOW });
    const pendingWhileBound = await manager.createTask('proj', {
      title: 'blocked again',
      description: 'details',
      preferredAgentId: 'dev-1',
    });
    expect(pendingWhileBound.status).toBe('pending');
  });

  it('serializes concurrent createTask calls so only one task binds the preferred dev', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: NOW });

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
    await agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: NOW });
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
    await agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: NOW });
    const created = await manager.createTask('proj', {
      title: 'custom branch',
      description: 'details',
      preferredAgentId: 'dev-1',
      branch: 'feat/my-feature',
    });
    expect(created.branch).toBe('feat/my-feature');
  });

  it('createTask rejects branch names starting with a dash', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: NOW });
    await expect(manager.createTask('proj', {
      title: 'bad branch',
      description: 'details',
      preferredAgentId: 'dev-1',
      branch: '-flag-like',
    })).rejects.toThrow(/Invalid branch name/);
  });

  it('createTask rejects branch names containing ".."', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: NOW });
    await expect(manager.createTask('proj', {
      title: 'bad branch',
      description: 'details',
      preferredAgentId: 'dev-1',
      branch: 'feat/../escape',
    })).rejects.toThrow(/Invalid branch name/);
  });

  it('createTask rejects custom branch starting with reserved bx/ prefix', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: NOW });
    await expect(manager.createTask('proj', {
      title: 'reserved prefix',
      description: 'details',
      preferredAgentId: 'dev-1',
      branch: 'bx/task-other',
    })).rejects.toThrow(/reserved prefix/);
  });

  it('createTask rejects branch names containing "@{"', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: NOW });
    await expect(manager.createTask('proj', {
      title: 'bad branch',
      description: 'details',
      preferredAgentId: 'dev-1',
      branch: 'feat@{0}',
    })).rejects.toThrow(/Invalid branch name/);
  });

  it.each([
    'feat/.hidden',
    'feat/foo.lock',
    'feat/',
    'feat//x',
    'feat/x.',
  ])('createTask rejects git-invalid branch name: %s', async (branch) => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: NOW });
    await expect(manager.createTask('proj', {
      title: 'bad branch',
      description: 'details',
      preferredAgentId: 'dev-1',
      branch,
    })).rejects.toThrow(/Invalid branch name/);
  });

  it('createTask rejects duplicate custom branch within the same project', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: NOW });
    await manager.createTask('proj', {
      title: 'first',
      description: 'details',
      preferredAgentId: 'dev-1',
      branch: 'feat/unique',
    });

    await agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: NOW });
    await expect(manager.createTask('proj', {
      title: 'second',
      description: 'details',
      preferredAgentId: 'dev-1',
      branch: 'feat/unique',
    })).rejects.toThrow(/already bound to task/);
  });

  it('cancelTask delegates releaseAgentForTask for dev and qa after cancelling the task', async () => {
    const t = task({ qaAgentId: 'qa-1' });
    await taskStore.set(t);
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW });
    await agentStore.set({ id: 'qa-1', projectId: 'proj', taskId: t.id, paneId: '%1', updatedAt: NOW });
    vi.spyOn(manager as unknown as { interruptPaneAndWaitReady: () => Promise<boolean> }, 'interruptPaneAndWaitReady')
      .mockResolvedValue(true);
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);

    const cancelled = await manager.cancelTask(t.id);

    expect(cancelled.status).toBe('cancelled');
    expect(releaseSpy).toHaveBeenCalledWith('dev-1', t.id, 'idle', { allowAwaitingHuman: true });
    expect(releaseSpy).toHaveBeenCalledWith('qa-1', t.id, 'idle', { allowAwaitingHuman: true });
  });

  it('cancelTask releases a bound dev through the real release path without task-lock deadlock', async () => {
    const t = task();
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: t.id,
      paneId: '%0',
      updatedAt: NOW,
    });
    await lockManager.acquire('dev-1');

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('cancelTask timed out')), 1_500);
    });
    const cancelled = await Promise.race([manager.cancelTask(t.id), timeout]);

    expect(cancelled.status).toBe('cancelled');
    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(state?.paneId).toBe('%0');
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('rollbackFailedDispatch clears only the matching binding and releases the lock', async () => {
    const t = task();
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: t.id,
      worktreePath: '/tmp/wt',
      paneId: '%0',
      updatedAt: NOW,
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
    const interruptSpy = vi
      .spyOn(manager as never as { interruptPaneAndWaitReady: () => Promise<boolean> }, 'interruptPaneAndWaitReady')
      .mockResolvedValue(true);
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
    // C-c the (possibly prompt-running) pane BEFORE handing it back, so the next dispatch isn't polluted.
    expect(interruptSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledWith('dev-1', created.id, 'idle', { allowAwaitingHuman: true });
    expect(armSpy).not.toHaveBeenCalled();
  });

  it('createAndStartTask({ background: true }): cancel mid-bootstrap holds the agent when the pane can not be interrupted', async () => {
    mockStartSessionThatCancels();
    vi.spyOn(manager as never as { interruptPaneAndWaitReady: () => Promise<boolean> }, 'interruptPaneAndWaitReady')
      .mockResolvedValue(false);
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

  it('createAndStartTask: a cancel before delivery releases the agent from the now-terminal task', async () => {
    // startSession returns false because the user cancelled mid-bootstrap; cancelTask couldn't C-c a pane
    // that didn't exist yet, so it left the agent held. rollbackFailedDispatch only acts on in_progress
    // tasks, so the !started path must release the agent from the cancelled task (else manual Resume).
    vi.spyOn(manager, 'startSession').mockImplementation(async (cancelledTaskId: string) => {
      const t = await taskStore.get(cancelledTaskId);
      if (t) await taskStore.set({ ...t, status: 'cancelled', updatedAt: NOW });
      await agentStore.update('dev-1', (s) => (s
        ? { ...s, status: 'awaiting_human' as const, awaitingPhase: 'cancel-interrupt-failed', awaitingSince: NOW }
        : s));
      return false;
    });
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask');

    const created = await manager.createAndStartTask('proj', { title: 'T', description: 'D', preferredAgentId: 'dev-1' });

    expect(releaseSpy).toHaveBeenCalledWith('dev-1', created.id, 'idle', { allowAwaitingHuman: true });
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('develop dispatch holds the dev when the spec/pr-created watcher fails to arm', async () => {
    // Non-verdict path: develop's pane only exists after startSession, so the watcher arms after
    // dispatch. A transient subscribeAtomic failure must hold the dev (explicit, recoverable) — not
    // leave the task silently waiting for a spec-done/pr-created signal with no consumer.
    await agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: NOW });
    const watcher = { start: vi.fn(async () => false), stop: vi.fn(), has: vi.fn(() => false) };
    const skillRegistry = new SkillRegistry(join(tempDir, 'skills'));
    await skillRegistry.scan();
    const m = new AgentManager({
      config: CONFIG, agentStore, taskStore, lockManager, eventBus,
      skillRegistry, runnerFactory: () => readyRunner(),
      phaseSignalWatcher: watcher as never,
    });
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
    const t = task({ id: 'task-ghost', agentId: 'ghost', signalToken: 'tok-1' });
    await taskStore.set(t);
    await agentStore.set({ id: 'ghost', projectId: 'proj', taskId: t.id, updatedAt: NOW });
    const skillRegistry = new SkillRegistry(join(tempDir, 'skills'));
    await skillRegistry.scan();
    const m = new AgentManager({
      config: CONFIG, agentStore, taskStore, lockManager, eventBus,
      skillRegistry, runnerFactory: () => readyRunner(),
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
    const t = task({ id: 'task-armed', signalToken: 'tok-2' });
    await taskStore.set(t);
    const skillRegistry = new SkillRegistry(join(tempDir, 'skills'));
    await skillRegistry.scan();
    const m = new AgentManager({
      config: CONFIG, agentStore, taskStore, lockManager, eventBus,
      skillRegistry, runnerFactory: () => readyRunner(),
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
    const t = task();
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: t.id,
      paneId: '%0',
      updatedAt: NOW,
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
    const badManager = new AgentManager({
      config: CONFIG,
      agentStore,
      taskStore,
      lockManager,
      eventBus,
      skillRegistry: emptyRegistry,
      runnerFactory: () => readyRunner(),
    });
    await agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: NOW });

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
    const t = task({ id: 'task-skills' });
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: t.id,
      paneId: '%0',
      updatedAt: NOW,
    });
    await lockManager.acquire('dev-1');

    await manager.failTaskForDispatchError(
      t.id,
      'develop',
      'dev-1',
      new DispatchTerminalError('required_skills_missing', 'missing baxian-rules'),
    );

    expect((await taskStore.get(t.id))?.status).toBe('failed');
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('startSession ack_unknown preserves binding/lock/worktree (so downstream markAwaitingHuman can take over)', async () => {
    const t = task({ id: 'task-startsession-ack-unknown', branch: 'bx/task-startsession-ack-unknown' });
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW,
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

    vi.restoreAllMocks();
  });

  it('failTaskForDispatchError on ack_unknown releases partner agents (terminal cleanup)', async () => {
    // Task pushed to failed → partner binding must clear too, else it stays stale.
    const t = task({ id: 'task-ack-partner', status: 'review', qaAgentId: 'qa-1' });
    await taskStore.set(t);
    // QA hit ack_unknown
    await agentStore.set({
      id: 'qa-1', projectId: 'proj',
      taskId: t.id, paneId: '%1',
      updatedAt: NOW,
    });
    // dev 仍绑该 task（QA review 期间 dev waiting）
    await agentStore.set({
      id: 'dev-1', projectId: 'proj',
      taskId: t.id, paneId: '%0',
      updatedAt: NOW,
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
    const t = task({ id: 'task-ack-unknown' });
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: t.id,
      paneId: '%0',
      updatedAt: NOW,
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
    await taskStore.set(task({ id: 'task-transition', status: 'in_progress', updatedAt: NOW }));

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
    await taskStore.set(task({ id: 'task-guard', status: 'in_progress', updatedAt: NOW }));

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
      await taskStore.set(task({ id: `task-${terminal}`, status: terminal }));
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
    await taskStore.set(task({ id: 'task-patch', status: 'in_progress', reviewRound: 0 }));

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

  it('dispatches a fixing task as recheck after parking dev and acquiring QA', async () => {
    await taskStore.set(reviewable());
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'task-review', updatedAt: NOW });
    await agentStore.set({ id: 'qa-1', projectId: 'proj', updatedAt: NOW });
    const markWaitingSpy = vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    const result = await manager.dispatchReviewToQa('task-review');

    expect(markWaitingSpy).toHaveBeenCalledWith('dev-1', 'task-review');
    expect(startSpy).toHaveBeenCalledWith('task-review', 'qa-1', 'recheck', expect.objectContaining({ bypassTaskStatusGate: true }));
    expect(result).toMatchObject({ status: 'review', reviewRound: 2, qaAgentId: 'qa-1' });
    expect((await agentStore.get('qa-1'))?.taskId).toBe('task-review');
  });

  it('throws + rolls back without dispatching when the verdict watcher fails to arm', async () => {
    await taskStore.set(reviewable());
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'task-review', updatedAt: NOW });
    await agentStore.set({ id: 'qa-1', projectId: 'proj', updatedAt: NOW });
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
    await taskStore.set(reviewable({ status: 'in_progress', reviewRound: 0 }));
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'task-review', updatedAt: NOW });
    await agentStore.set({ id: 'qa-1', projectId: 'proj', updatedAt: NOW });
    const acquireSpy = vi.spyOn(manager, 'acquireAgentForTask');
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);
    vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);

    await manager.dispatchReviewToQa('task-review');

    expect(acquireSpy).toHaveBeenCalledWith('qa-1', 'task-review', 'review');
    expect(startSpy).toHaveBeenCalledWith('task-review', 'qa-1', 'review', expect.objectContaining({ bypassTaskStatusGate: true }));
  });

  it('dispatchReviewToQa: markAgentWaiting reject (IO error) still releases QA (no bind/lock leak)', async () => {
    // Without the catch, markAgentWaiting reject jumps the try/finally → QA acquired but never started → stuck.
    await taskStore.set(reviewable({ status: 'approved' }));
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'task-review', paneId: '%0', updatedAt: NOW });
    await agentStore.set({ id: 'qa-1', projectId: 'proj', updatedAt: NOW });
    vi.spyOn(manager, 'markAgentWaiting').mockRejectedValue(new Error('store IO failure'));
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await expect(manager.dispatchReviewToQa('task-review')).rejects.toMatchObject({ status: 500 });

    // QA release 必须被调（清掉刚 acquire 的 binding+lock）
    expect(releaseSpy).toHaveBeenCalledWith('qa-1', 'task-review', 'idle');
  });

  it('parks an approved dev into waiting before recheck (no C-c, no separate release path)', async () => {
    await taskStore.set(reviewable({ status: 'approved' }));
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'task-review', paneId: '%0', updatedAt: NOW });
    await agentStore.set({ id: 'qa-1', projectId: 'proj', updatedAt: NOW });
    const markWaitingSpy = vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);
    vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await manager.dispatchReviewToQa('task-review');

    expect(markWaitingSpy).toHaveBeenCalledWith('dev-1', 'task-review');
  });

  it('can dispatch terminal tasks without changing their terminal status', async () => {
    await taskStore.set(reviewable({ status: 'merged' }));
    await agentStore.set({ id: 'qa-1', projectId: 'proj', updatedAt: NOW });
    const markWaitingSpy = vi.spyOn(manager, 'markAgentWaiting');
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    const result = await manager.dispatchReviewToQa('task-review');

    expect(markWaitingSpy).not.toHaveBeenCalled();
    expect(startSpy).toHaveBeenCalledWith('task-review', 'qa-1', 'recheck', expect.objectContaining({ bypassTaskStatusGate: true }));
    expect(result).toMatchObject({ status: 'merged', reviewRound: 2 });
  });

  it('does not mutate the task when the dev gate fails', async () => {
    await taskStore.set(reviewable());
    // dev must be bound for the park to be attempted (park is now skipped for an unbound dev).
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'task-review', updatedAt: NOW });
    await agentStore.set({ id: 'qa-1', projectId: 'proj', updatedAt: NOW });
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
    await taskStore.set(reviewable({ status: 'max_rounds' }));
    await agentStore.set({ id: 'dev-1', projectId: 'proj', status: 'waiting', taskId: 'task-review', worktreePath: '/tmp/wt', paneId: '%0', updatedAt: NOW });
    await agentStore.set({ id: 'qa-1', projectId: 'proj', updatedAt: NOW });
    vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);
    vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    const result = await manager.dispatchReviewToQa('task-review');
    expect(result.status).toBe('review');
  });

  it('falls back to the configured QA partner when task.qaAgentId is missing', async () => {
    await taskStore.set(reviewable({ qaAgentId: undefined }));
    await agentStore.set({ id: 'qa-1', projectId: 'proj', updatedAt: NOW });
    vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    const result = await manager.dispatchReviewToQa('task-review');

    expect(result.qaAgentId).toBe('qa-1');
    expect(startSpy).toHaveBeenCalledWith('task-review', 'qa-1', 'recheck', expect.any(Object));
  });

  it('releases QA and leaves task fields unchanged when startSession returns false', async () => {
    await taskStore.set(reviewable());
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'task-review', updatedAt: NOW });
    await agentStore.set({ id: 'qa-1', projectId: 'proj', updatedAt: NOW });
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
    await taskStore.set(reviewable());
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'task-review', updatedAt: NOW });
    await agentStore.set({ id: 'qa-1', projectId: 'proj', updatedAt: NOW });
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
    await taskStore.set(reviewable());
    await agentStore.set({ id: 'qa-1', projectId: 'proj', updatedAt: NOW });
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
    const m2 = new AgentManager({
      config: CONFIG,
      agentStore,
      taskStore,
      lockManager,
      eventBus,
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => readyRunner(),
      phaseSignalWatcher: watcher as never,
    });
    await taskStore.set(reviewable());
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'task-review', updatedAt: NOW });
    await agentStore.set({ id: 'qa-1', projectId: 'proj', updatedAt: NOW });
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
    await taskStore.set(task({
      id: 'task-spec-1',
      branch: 'bx/task-spec-1',
      status: 'review',
      phase: 'spec',
      specReviewRound: 1,
      signalToken: 'old-token',
      qaAgentId: 'qa-1',
    }));
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: 'task-spec-1',
      paneId: '%0', updatedAt: NOW,
    });
    await agentStore.set({ id: 'qa-1', projectId: 'proj', taskId: 'task-spec-1', updatedAt: NOW });
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
    const m2 = new AgentManager({
      config: CONFIG,
      agentStore,
      taskStore,
      lockManager,
      eventBus,
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => readyRunner(),
      phaseSignalWatcher: watcher as never,
    });
    await taskStore.set(task({
      id: 'task-spec-1',
      branch: 'bx/task-spec-1',
      status: 'review',
      phase: 'spec',
      specReviewRound: 1,
      signalToken: 'old-token',
      qaAgentId: 'qa-1',
    }));
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'task-spec-1', updatedAt: NOW });
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
    const m = new AgentManager({
      config: CONFIG,
      agentStore,
      taskStore,
      lockManager,
      eventBus,
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => readyRunner(),
      phaseSignalWatcher: watcher as never,
    });
    await taskStore.set(task({
      id: 'task-spec-1', branch: 'bx/task-spec-1',
      status: 'review', phase: 'spec', specReviewRound: 1, signalToken: 'old-token', qaAgentId: 'qa-1',
    }));
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'task-spec-1', updatedAt: NOW });
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
    await taskStore.set(task({
      id: 'task-spec-1',
      branch: 'bx/task-spec-1',
      status: 'review',
      phase: 'spec',
      specReviewRound: 1,
      signalToken: 'old-token',
      qaAgentId: 'qa-1',
    }));
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'task-spec-1', updatedAt: NOW });
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
    await taskStore.set(task({
      id: 'task-spec-1',
      branch: 'bx/task-spec-1',
      status: 'review',
      phase: 'spec',
      specReviewRound: 1,
      qaAgentId: 'qa-1',
    }));
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'task-spec-1', updatedAt: NOW });
    await agentStore.set({ id: 'qa-1', projectId: 'proj', taskId: 'task-spec-1', updatedAt: NOW });
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
    await taskStore.set(task({ status: 'cancelled' }));
    await agentStore.set({ id: 'qa-1', projectId: 'proj', updatedAt: NOW });

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

  function capturePrompts(mgr: AgentManager, opts: { acked?: boolean; composerDelivered?: boolean } = {}): string[] {
    const prompts: string[] = [];
    const acked = opts.acked ?? true;
    const composerDelivered = opts.composerDelivered ?? true;
    vi.spyOn(
      mgr as unknown as {
        injectAndAwaitAck: (tmux: TmuxManager, paneId: string, prompt: string, agentId: string, runtime: 'claude-code' | 'codex') => Promise<{ acked: boolean; composerDelivered: boolean }>;
      },
      'injectAndAwaitAck',
    ).mockImplementation(async (_tmux, _paneId, prompt) => {
      prompts.push(prompt);
      return { acked, composerDelivered };
    });
    return prompts;
  }

  it('startSession on a fresh agent inlines full phase skills and records the set', async () => {
    const t = task({ id: 'task-dedup-1', branch: 'bx/task-dedup-1' });
    await taskStore.set(t);
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW });
    await lockManager.acquire('dev-1');

    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%0', workdir: '/tmp/repo',
    });
    const prompts = capturePrompts(manager);
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => workdirRunner();

    const ok = await manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);

    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain('<name>baxian-rules</name>');
    expect(prompts[0]).toContain('<name>task-check</name>');
    expect(prompts[0]).toContain('<name>spells</name>');

    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills?.taskId).toBe(t.id);
    expect(state?.injectedSkills?.paneId).toBe('%0');
    expect(state?.injectedSkills?.skills.sort()).toEqual(['baxian-rules', 'spells', 'task-check']);

    vi.restoreAllMocks();
  });

  it('startSession develop prompt drops the spec route when the dev has no QA partner', async () => {
    const t = task({ id: 'task-noqa-1', branch: 'bx/task-noqa-1', signalToken: 'devtok1234ab' });
    await taskStore.set(t);
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW });
    await lockManager.acquire('dev-1');

    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%0', workdir: '/tmp/repo',
    });
    vi.spyOn(manager, 'findQaPartner').mockReturnValue(undefined);
    const prompts = capturePrompts(manager);
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => workdirRunner();

    const ok = await manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);
    expect(prompts[0]).toContain('[bx:pr-created:');
    expect(prompts[0]).not.toContain('Specification-Driven Development (SDD)');
    expect(prompts[0]).not.toContain('[bx:spec-done:');

    vi.restoreAllMocks();
  });

  it('startSession develop prompt keeps the spec route when the config pair has a QA', async () => {
    const t = task({ id: 'task-hasqa-1', branch: 'bx/task-hasqa-1', signalToken: 'devtok5678cd' });
    await taskStore.set(t);
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW });
    await lockManager.acquire('dev-1');

    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%0', workdir: '/tmp/repo',
    });
    const prompts = capturePrompts(manager);
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => workdirRunner();

    const ok = await manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);
    expect(prompts[0]).toContain('Specification-Driven Development (SDD)');
    expect(prompts[0]).toContain('[bx:spec-done:');

    vi.restoreAllMocks();
  });

  it('startSession marks bootstrappingTaskId during dispatch and clears it once the prompt is ack\'d', async () => {
    const t = task({ id: 'task-deliver-1', branch: 'bx/task-deliver-1' });
    await taskStore.set(t);
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW });
    await lockManager.acquire('dev-1');
    expect((await agentStore.get('dev-1'))?.bootstrappingTaskId).toBeUndefined();

    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%0', workdir: '/tmp/repo',
    });
    let markerDuringInject: string | undefined;
    vi.spyOn(
      manager as never as {
        injectAndAwaitAck: (tmux: TmuxManager, paneId: string, prompt: string, agentId: string, runtime: 'claude-code' | 'codex') => Promise<{ acked: boolean; composerDelivered: boolean }>;
      },
      'injectAndAwaitAck',
    ).mockImplementation(async () => {
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
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => workdirRunner();

    const ok = await manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);
    expect(markerDuringInject).toBe(t.id);
    expect(markerAtSessionStarted).toBeUndefined();
    expect((await agentStore.get('dev-1'))?.bootstrappingTaskId).toBeUndefined();

    vi.restoreAllMocks();
  });

  it('startSession holds (not destructively cleans up) when clearing the bootstrap marker fails after delivery', async () => {
    // The prompt is already delivered; a storage blip clearing the marker must NOT fall into the
    // dispatch-failure path (worktree remove + rollback) — it holds for human and keeps the worktree.
    const t = task({ id: 'task-deliver-2', branch: 'bx/task-deliver-2' });
    await taskStore.set(t);
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW });
    await lockManager.acquire('dev-1');

    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%0', workdir: '/tmp/repo',
    });
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => workdirRunner();

    // Make only the marker-clear write fail — it's the first agentStore write after ack; let the rest pass.
    let afterAck = false;
    let threwOnce = false;
    vi.spyOn(
      manager as never as {
        injectAndAwaitAck: (tmux: TmuxManager, paneId: string, prompt: string, agentId: string, runtime: 'claude-code' | 'codex') => Promise<{ acked: boolean; composerDelivered: boolean }>;
      },
      'injectAndAwaitAck',
    ).mockImplementation(async () => { afterAck = true; return { acked: true, composerDelivered: true }; });
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

    vi.restoreAllMocks();
  });

  it('continueSession with matching (taskId, paneId) omits the <skills> tag entirely when phase skills are all already injected', async () => {
    const t = task({ id: 'task-dedup-2', branch: 'bx/task-dedup-2', status: 'approved' });
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW,
      worktreePath: '/tmp/repo/.baxian-worktrees/wt',
      injectedSkills: { taskId: t.id, paneId: '%0', skills: ['baxian-rules', 'pr-feedback', 'spells'] },
    });
    await lockManager.acquire('dev-1');
    await manager['postApproveStore'].set(t.id, { token: 'tok', approvedHeadSha: 'sha' });

    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%0', workdir: '/tmp/repo',
    });
    const prompts = capturePrompts(manager);
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => workdirRunner();

    const ok = await manager.continueSession(t.id, 'dev-1', 'post-approve', { signalToken: 'tok' });
    expect(ok).toBe(true);

    expect(prompts.length).toBe(1);
    expect(prompts[0]).not.toContain('<skills>');
    expect(prompts[0]).not.toContain('</skills>');
    expect(prompts[0]).not.toContain('<name>baxian-rules</name>');
    expect(prompts[0]).not.toContain('<name>pr-feedback</name>');
    expect(prompts[0]).not.toContain('<name>spells</name>');
    expect(prompts[0]).toContain('Post-approve PR feedback check');

    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills?.skills.sort()).toEqual(['baxian-rules', 'pr-feedback', 'spells']);

    vi.restoreAllMocks();
  });

  it('continueSession with a different paneId resets dedup — full skills re-injected', async () => {
    const t = task({ id: 'task-dedup-3', branch: 'bx/task-dedup-3', status: 'approved' });
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%9', updatedAt: NOW,
      worktreePath: '/tmp/repo/.baxian-worktrees/wt',
      injectedSkills: { taskId: t.id, paneId: '%0', skills: ['baxian-rules', 'pr-feedback', 'spells'] },
    });
    await lockManager.acquire('dev-1');
    await manager['postApproveStore'].set(t.id, { token: 'tok', approvedHeadSha: 'sha' });

    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%9', workdir: '/tmp/repo',
    });
    const prompts = capturePrompts(manager);
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => workdirRunner();

    const ok = await manager.continueSession(t.id, 'dev-1', 'post-approve', { signalToken: 'tok' });
    expect(ok).toBe(true);

    expect(prompts[0]).toContain('<name>baxian-rules</name>');
    expect(prompts[0]).toContain('<name>pr-feedback</name>');
    expect(prompts[0]).toContain('<name>spells</name>');

    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills?.paneId).toBe('%9');
    expect(state?.injectedSkills?.skills.sort()).toEqual(['baxian-rules', 'pr-feedback', 'spells']);

    vi.restoreAllMocks();
  });

  it('startSession on a freshly-created tmux session re-injects full skills even when paneId string matches', async () => {
    // tmux server / session 重启后 buildFreshSession 跑过，paneId 字符串可能与旧记录恰好相同
    // （fresh server 第一个 pane 通常就是 %0）。此时 REPL 是全新的，绝不能让 dedup 沿用旧 skill 集。
    const t = task({ id: 'task-fresh-pane', branch: 'bx/task-fresh-pane' });
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW,
      injectedSkills: { taskId: t.id, paneId: '%0', skills: ['baxian-rules', 'task-check', 'spells'] },
    });
    await lockManager.acquire('dev-1');

    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: true, freshRuntime: true, paneId: '%0', workdir: '/tmp/repo',
    });
    const prompts = capturePrompts(manager);
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => workdirRunner();

    const ok = await manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);

    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain('<name>baxian-rules</name>');
    expect(prompts[0]).toContain('<name>task-check</name>');
    expect(prompts[0]).toContain('<name>spells</name>');
    expect(prompts[0]).not.toContain('<skills></skills>');

    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills?.taskId).toBe(t.id);
    expect(state?.injectedSkills?.paneId).toBe('%0');
    expect(state?.injectedSkills?.skills.sort()).toEqual(['baxian-rules', 'spells', 'task-check']);

    vi.restoreAllMocks();
  });

  it('continueSession on a freshly-created tmux session re-injects full skills even when paneId string matches', async () => {
    const t = task({ id: 'task-fresh-pane-cont', branch: 'bx/task-fresh-pane-cont', status: 'approved' });
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW,
      worktreePath: '/tmp/repo/.baxian-worktrees/wt',
      injectedSkills: { taskId: t.id, paneId: '%0', skills: ['baxian-rules', 'pr-feedback', 'spells'] },
    });
    await lockManager.acquire('dev-1');
    await manager['postApproveStore'].set(t.id, { token: 'tok', approvedHeadSha: 'sha' });

    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: true, freshRuntime: true, paneId: '%0', workdir: '/tmp/repo',
    });
    const prompts = capturePrompts(manager);
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => workdirRunner();

    const ok = await manager.continueSession(t.id, 'dev-1', 'post-approve', { signalToken: 'tok' });
    expect(ok).toBe(true);

    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain('<name>baxian-rules</name>');
    expect(prompts[0]).toContain('<name>pr-feedback</name>');
    expect(prompts[0]).toContain('<name>spells</name>');
    expect(prompts[0]).not.toContain('<skills></skills>');

    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills?.skills.sort()).toEqual(['baxian-rules', 'pr-feedback', 'spells']);

    vi.restoreAllMocks();
  });

  it('continueSession post-approve: freshRuntime suppresses incremental nudge — full preamble always sent', async () => {
    const t = task({ id: 'task-fresh-redispatch', branch: 'bx/task-fresh-redispatch', status: 'approved' });
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW,
      worktreePath: '/tmp/repo/.baxian-worktrees/wt',
    });
    await lockManager.acquire('dev-1');
    await manager['postApproveStore'].set(t.id, {
      token: 'tok', approvedHeadSha: 'sha', redispatchCount: 5,
    });

    // freshRuntime=true: tmux/REPL 刚新建，旧 post-approve 上下文已丢失。
    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: true, freshRuntime: true, paneId: '%0', workdir: '/tmp/repo',
    });
    const prompts = capturePrompts(manager);
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => workdirRunner();

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

    vi.restoreAllMocks();
  });

  it('continueSession post-approve: reused runtime + redispatchCount>0 uses incremental nudge', async () => {
    const t = task({ id: 'task-reuse-redispatch', branch: 'bx/task-reuse-redispatch', status: 'approved' });
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW,
      worktreePath: '/tmp/repo/.baxian-worktrees/wt',
      injectedSkills: { taskId: t.id, paneId: '%0', skills: ['baxian-rules', 'pr-feedback', 'spells'] },
    });
    await lockManager.acquire('dev-1');
    await manager['postApproveStore'].set(t.id, {
      token: 'tok', approvedHeadSha: 'sha', redispatchCount: 2,
    });

    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%0', workdir: '/tmp/repo',
    });
    const prompts = capturePrompts(manager);
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => workdirRunner();

    const ok = await manager.continueSession(t.id, 'dev-1', 'post-approve', {
      signalToken: 'tok',
      postApproveRedispatchCount: 2,
    });
    expect(ok).toBe(true);

    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain('Post-approve recheck (redispatch #2)');
    expect(prompts[0]).not.toContain('Post-approve PR feedback check:');

    vi.restoreAllMocks();
  });

  it('persistInjectedSkills skips agentStore write when phase brings no new skill', async () => {
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: 't-no-write', paneId: '%0', updatedAt: NOW,
      injectedSkills: { taskId: 't-no-write', paneId: '%0', skills: ['baxian-rules', 'task-check', 'spells'] },
    });
    const setSpy = vi.spyOn(agentStore, 'set');
    await (manager as unknown as {
      persistInjectedSkills: (agentId: string, taskId: string, paneId: string, role: 'dev' | 'qa', phase: string, reuseInjectedSkills: string[] | null) => Promise<void>;
    }).persistInjectedSkills('dev-1', 't-no-write', '%0', 'dev', 'develop', ['baxian-rules', 'task-check', 'spells']);
    expect(setSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('persistInjectedSkills writes baseline when reuseInjectedSkills is null (fresh REPL)', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 't-fresh-base', paneId: '%0', updatedAt: NOW });
    await (manager as unknown as {
      persistInjectedSkills: (agentId: string, taskId: string, paneId: string, role: 'dev' | 'qa', phase: string, reuseInjectedSkills: string[] | null) => Promise<void>;
    }).persistInjectedSkills('dev-1', 't-fresh-base', '%0', 'dev', 'develop', null);
    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills?.taskId).toBe('t-fresh-base');
    expect(state?.injectedSkills?.skills.sort()).toEqual(['baxian-rules', 'spells', 'task-check']);
  });

  it('persistInjectedSkills writes when phase introduces a skill not yet in baseList', async () => {
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: 't-add', paneId: '%0', updatedAt: NOW,
      injectedSkills: { taskId: 't-add', paneId: '%0', skills: ['baxian-rules', 'spells'] },
    });
    await (manager as unknown as {
      persistInjectedSkills: (agentId: string, taskId: string, paneId: string, role: 'dev' | 'qa', phase: string, reuseInjectedSkills: string[] | null) => Promise<void>;
    }).persistInjectedSkills('dev-1', 't-add', '%0', 'dev', 'develop', ['baxian-rules', 'spells']);
    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills?.skills.sort()).toEqual(['baxian-rules', 'spells', 'task-check']);
  });

  it('startSession resets dedup when adoptOrRestartSession relaunches REPL inside an existing pane (createdSession=false, freshRuntime=true)', async () => {
    // adoptOrRestartSession 的 shell 重启 / trust-dialog 分支会在同一 paneId 上重新启动 REPL，
    // 仍返回 createdSession=false——只看 createdSession 会误判上下文未变，进而沿用旧 skill 集
    // 让下一轮派发空 <skills/>。这里专测：paneId 字符串相同 + 旧 injectedSkills 完备 + freshRuntime=true
    // → 必须全量重注入 + 落盘新 baseline。
    const t = task({ id: 'task-pane-relaunch', branch: 'bx/task-pane-relaunch' });
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW,
      injectedSkills: { taskId: t.id, paneId: '%0', skills: ['baxian-rules', 'task-check', 'spells'] },
    });
    await lockManager.acquire('dev-1');

    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: true, paneId: '%0', workdir: '/tmp/repo',
    });
    const prompts = capturePrompts(manager);
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => workdirRunner();

    const ok = await manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);

    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain('<name>baxian-rules</name>');
    expect(prompts[0]).toContain('<name>task-check</name>');
    expect(prompts[0]).toContain('<name>spells</name>');
    expect(prompts[0]).not.toContain('<skills></skills>');

    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills?.taskId).toBe(t.id);
    expect(state?.injectedSkills?.paneId).toBe('%0');
    expect(state?.injectedSkills?.skills.sort()).toEqual(['baxian-rules', 'spells', 'task-check']);

    vi.restoreAllMocks();
  });

  it('continueSession resets dedup when adoptOrRestartSession relaunches REPL inside an existing pane', async () => {
    const t = task({ id: 'task-pane-relaunch-cont', branch: 'bx/task-pane-relaunch-cont', status: 'approved' });
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW,
      worktreePath: '/tmp/repo/.baxian-worktrees/wt',
      injectedSkills: { taskId: t.id, paneId: '%0', skills: ['baxian-rules', 'pr-feedback', 'spells'] },
    });
    await lockManager.acquire('dev-1');
    await manager['postApproveStore'].set(t.id, { token: 'tok', approvedHeadSha: 'sha' });

    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: true, paneId: '%0', workdir: '/tmp/repo',
    });
    const prompts = capturePrompts(manager);
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => workdirRunner();

    const ok = await manager.continueSession(t.id, 'dev-1', 'post-approve', { signalToken: 'tok' });
    expect(ok).toBe(true);

    expect(prompts[0]).toContain('<name>baxian-rules</name>');
    expect(prompts[0]).toContain('<name>pr-feedback</name>');
    expect(prompts[0]).toContain('<name>spells</name>');
    expect(prompts[0]).not.toContain('<skills></skills>');

    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills?.skills.sort()).toEqual(['baxian-rules', 'pr-feedback', 'spells']);

    vi.restoreAllMocks();
  });

  it('startSession records injectedSkills even when injectAndAwaitAck returns acked=false — paste delivered the skills', async () => {
    const t = task({ id: 'task-ack-false', branch: 'bx/task-ack-false' });
    await taskStore.set(t);
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW });
    await lockManager.acquire('dev-1');

    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%0', workdir: '/tmp/repo',
    });
    capturePrompts(manager, { acked: false });
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => workdirRunner();

    const ok = await manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);

    // 即便首个 Enter 被吞（ack 超时），skill 文本已 paste 进 pane → 落 dedup baseline，
    // 避免下一轮派发整组重注入（SKILLS 重复注入根因）。
    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills?.taskId).toBe(t.id);
    expect(state?.injectedSkills?.paneId).toBe('%0');
    expect(state?.injectedSkills?.skills.sort()).toEqual(['baxian-rules', 'spells', 'task-check']);

    vi.restoreAllMocks();
  });

  it('continueSession expands injectedSkills even when injectAndAwaitAck returns acked=false', async () => {
    const t = task({ id: 'task-ack-false-cont', branch: 'bx/task-ack-false-cont', status: 'approved' });
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW,
      worktreePath: '/tmp/repo/.baxian-worktrees/wt',
      injectedSkills: { taskId: t.id, paneId: '%0', skills: ['baxian-rules'] },
    });
    await lockManager.acquire('dev-1');
    await manager['postApproveStore'].set(t.id, { token: 'tok', approvedHeadSha: 'sha' });

    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%0', workdir: '/tmp/repo',
    });
    capturePrompts(manager, { acked: false });
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => workdirRunner();

    const ok = await manager.continueSession(t.id, 'dev-1', 'post-approve', { signalToken: 'tok' });
    expect(ok).toBe(true);

    // post-approve phase skills = baxian-rules / pr-feedback / spells；paste 后即合并落盘，与 ack 无关。
    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills?.skills.sort()).toEqual(['baxian-rules', 'pr-feedback', 'spells']);

    vi.restoreAllMocks();
  });

  it('does NOT record injectedSkills when paste landed on a busy baseline', async () => {
    const t = task({ id: 'task-busy-baseline', branch: 'bx/task-busy-baseline' });
    await taskStore.set(t);
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW });
    await lockManager.acquire('dev-1');

    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%0', workdir: '/tmp/repo',
    });
    // Busy-baseline race: ack timed out AND the prompt was pasted into a running input stream, not an
    // idle composer → skills never entered context → baseline must stay empty (else recovery loses skills).
    capturePrompts(manager, { acked: false, composerDelivered: false });
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => workdirRunner();

    const ok = await manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);

    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills).toBeUndefined();

    vi.restoreAllMocks();
  });

  it('startSession on a different taskId resets a stale injectedSkills record', async () => {
    const t = task({ id: 'task-dedup-4', branch: 'bx/task-dedup-4' });
    await taskStore.set(t);
    // Agent currently bound to t but carries a STALE injectedSkills record from a prior task.
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW,
      injectedSkills: { taskId: 'task-OLD', paneId: '%0', skills: ['baxian-rules', 'task-check', 'spells'] },
    });
    await lockManager.acquire('dev-1');

    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: false, paneId: '%0', workdir: '/tmp/repo',
    });
    const prompts = capturePrompts(manager);
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => workdirRunner();

    const ok = await manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);

    expect(prompts[0]).toContain('<name>baxian-rules</name>');
    expect(prompts[0]).toContain('<name>task-check</name>');
    expect(prompts[0]).toContain('<name>spells</name>');

    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills?.taskId).toBe(t.id);
    expect(state?.injectedSkills?.skills.sort()).toEqual(['baxian-rules', 'spells', 'task-check']);

    vi.restoreAllMocks();
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
    manager = new AgentManager({
      config: CONFIG,
      agentStore,
      taskStore,
      lockManager,
      eventBus: manager['eventBus'],
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => runner,
    });
    manager['runtimeMenuPollIntervalMs'] = 5;
    await taskStore.set(task());
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: 'task-1',
      paneId: '%0',
      updatedAt: NOW,
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

describe('cancelTask still sends C-c to dev and qa panes', () => {
  it('captures C-c on both dev and qa, then clears both bindings', async () => {
    const sentKeys: string[] = [];
    const capturingRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('send-keys')) {
          sentKeys.push(cmd);
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('display-message') && cmd.includes('pane_current_command')) {
          if (cmd.includes('%1')) return { stdout: 'codex\n', stderr: '', exitCode: 0 };
          return { stdout: 'claude\n', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          if (cmd.includes('%1')) {
            return { stdout: 'permissions: YOLO mode\n\n>', stderr: '', exitCode: 0 };
          }
          return { stdout: '⏵⏵ bypass permissions on /tmp/repo\n\n>', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const localManager = new AgentManager({
      config: CONFIG,
      agentStore,
      taskStore,
      lockManager,
      eventBus,
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => capturingRunner,
    });

    const t = task({ qaAgentId: 'qa-1' });
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: t.id,
      paneId: '%0',
      updatedAt: NOW,
    });
    await agentStore.set({
      id: 'qa-1',
      projectId: 'proj',
      taskId: t.id,
      paneId: '%1',
      updatedAt: NOW,
    });
    await lockManager.acquire('dev-1');
    await lockManager.acquire('qa-1');

    const cancelled = await localManager.cancelTask(t.id);

    expect(cancelled.status).toBe('cancelled');
    expect(sentKeys.filter(k => k.includes('C-c')).length).toBeGreaterThanOrEqual(2);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
    expect(await lockManager.isLocked('qa-1')).toBe(false);
  });

  it('skips C-c and release when agent has been rebound to a new task (race protection)', async () => {
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
    const localManager = new AgentManager({
      config: CONFIG,
      agentStore,
      taskStore,
      lockManager,
      eventBus,
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => runner,
    });

    const oldTask = task({ id: 'task-old' });
    const newTask = task({ id: 'task-new' });
    await taskStore.set(oldTask);
    await taskStore.set(newTask);
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: oldTask.id,
      paneId: '%0',
      updatedAt: NOW,
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
    // race 触发后 cancelTask 必须 skip C-c——否则会打到 task-new 会话上。
    expect(sentKeys.filter(k => k.includes('C-c'))).toHaveLength(0);
    // 不能解绑 dev-1：它现在归属 task-new。
    expect((await agentStore.get('dev-1'))?.taskId).toBe(newTask.id);

    vi.restoreAllMocks();
  });

  it('preserves binding and emits intervention when interrupt fails', async () => {
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
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
    const localManager = new AgentManager({
      config: CONFIG,
      agentStore,
      taskStore,
      lockManager,
      eventBus,
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => runner,
      // 让 waitReplReady 快速超时：通过缩短 bootstrap timeout 不行（它走另一条路），
      // interruptPaneAndWaitReady 内部 hardcoded 10s——这测试会真等 10s 偏慢。
      // 改方案：直接 spy interruptPaneAndWaitReady 返 false。
    });

    // 直接 spy private 方法返 false——更稳定且快。
    vi.spyOn(localManager as unknown as { interruptPaneAndWaitReady: () => Promise<boolean> }, 'interruptPaneAndWaitReady')
      .mockResolvedValue(false);

    const t = task();
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: t.id,
      paneId: '%0',
      updatedAt: NOW,
    });
    await lockManager.acquire('dev-1');

    const cancelled = await localManager.cancelTask(t.id);

    expect(cancelled.status).toBe('cancelled');
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

    vi.restoreAllMocks();
  });
});

describe('AgentManager.prHasDevReplySince', () => {
  const SINCE = '2026-06-01T00:00:00.500Z';

  function mgrWithExec(execImpl: (cmd: string) => ExecResult): AgentManager {
    return new AgentManager({
      config: CONFIG,
      agentStore,
      taskStore,
      lockManager,
      eventBus,
      runnerFactory: () => readyRunner(),
      platformRunner: {
        exec: vi.fn(async (cmd: string) => execImpl(cmd)),
        writeFile: vi.fn(async () => undefined),
      } as unknown as CommandRunner,
    });
  }

  beforeEach(async () => {
    await taskStore.set(task({ id: 'task-r', prNumber: 90, reviewDispatchedAt: SINCE }));
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
    manager = new AgentManager({
      config: CONFIG, agentStore, taskStore, lockManager, eventBus,
      runnerFactory: () => ({
        exec: vi.fn(async (cmd: string) => { execs.push(cmd); return { stdout: '', stderr: '', exitCode: 0 }; }),
        writeFile: vi.fn(async () => undefined),
      }) as unknown as CommandRunner,
    });
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'task-x', updatedAt: NOW });

    await manager.dispatchPostMergeCleanup('dev-1', { prNumber: 1, taskId: 'task-x', branch: 'bx/task-x' });

    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('runs the full cycle: idle → cleanup prompt (busy→idle) → /clear (busy→idle) → release', async () => {
    const execs: string[] = [];
    const promptInjections: string[] = [];
    manager = new AgentManager({
      config: CONFIG, agentStore, taskStore, lockManager, eventBus,
      runnerFactory: () => compactRunner(execs, (cmd) => {
        const m = cmd.match(/printf '%s' '([^']+)'/);
        if (m && cmd.includes('load-buffer')) promptInjections.push(Buffer.from(m[1], 'base64').toString('utf8'));
      }),
    });
    Object.assign(manager, { compactIdleWaitMs: 100, compactIdlePollMs: 10 });
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%5', taskId: 'merged-task', repoPath: '/repo/main', updatedAt: NOW });

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
    manager = new AgentManager({
      config: CONFIG, agentStore, taskStore, lockManager, eventBus,
      runnerFactory: () => smallPaneClaudeCompactRunner(execs),
    });
    Object.assign(manager, { compactIdleWaitMs: 100, compactIdlePollMs: 10 });
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%5', taskId: 'merged-task', repoPath: '/repo/main', updatedAt: NOW });

    await manager.dispatchPostMergeCleanup('dev-1', { prNumber: 99, taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => !(await agentStore.get('dev-1'))?.taskId);

    expect(execs.join('\n')).toMatch(/tmux send-keys -l -t '%5' '\/clear'/);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('runs server-side fetch+prune + branch -D in repoPath, and surfaces the "deleted" outcome in the prompt', async () => {
    const execs: string[] = [];
    const promptInjections: string[] = [];
    manager = new AgentManager({
      config: CONFIG, agentStore, taskStore, lockManager, eventBus,
      runnerFactory: () => compactRunner(execs, (cmd) => {
        const m = cmd.match(/printf '%s' '([^']+)'/);
        if (m && cmd.includes('load-buffer')) promptInjections.push(Buffer.from(m[1], 'base64').toString('utf8'));
      }),
    });
    Object.assign(manager, { compactIdleWaitMs: 100, compactIdlePollMs: 10 });
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%5', repoPath: '/repo/main-clone', taskId: 'merged-task', updatedAt: NOW });

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
    manager = new AgentManager({
      config: CONFIG, agentStore, taskStore, lockManager, eventBus,
      runnerFactory: () => compactRunner(execs),
    });
    Object.assign(manager, { compactIdleWaitMs: 100, compactIdlePollMs: 10 });
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%5', taskId: 'merged-task', repoPath: '/repo/main', worktreePath: '/wt/merged-task', updatedAt: NOW });

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
    manager = new AgentManager({
      config: CONFIG, agentStore, taskStore, lockManager, eventBus,
      runnerFactory: () => compactRunner(execs, async (cmd) => {
        if (cmd.includes('git branch -D')) taskIdDuringBranchDelete = (await agentStore.get('dev-1'))?.taskId;
      }),
    });
    Object.assign(manager, { compactIdleWaitMs: 100, compactIdlePollMs: 10 });
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%5', repoPath: '/repo/main', updatedAt: NOW });

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
    manager = new AgentManager({
      config: CONFIG, agentStore, taskStore, lockManager, eventBus,
      runnerFactory: () => ({
        exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
          execs.push(cmd);
          const m = cmd.match(/printf '%s' '([^']+)'/);
          if (m && cmd.includes('load-buffer')) promptInjections.push(Buffer.from(m[1], 'base64').toString('utf8'));
          if (cmd.includes('git branch -D')) {
            return { stdout: '', stderr: "error: Cannot delete branch 'bx/merged-task' checked out at '/tmp/wt'", exitCode: 1 };
          }
          if (cmd.includes('send-keys') && cmd.includes("'Enter'")) busyLeft = 3;
          if (cmd.includes('display-message') && cmd.includes('pane_current_command')) {
            return { stdout: 'claude\n', stderr: '', exitCode: 0 };
          }
          if (cmd.includes('capture-pane')) {
            if (busyLeft > 0) { busyLeft--; return { stdout: BUSY, stderr: '', exitCode: 0 }; }
            return { stdout: IDLE, stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        }),
        writeFile: vi.fn(async (): Promise<void> => undefined),
      }) as unknown as CommandRunner,
    });
    Object.assign(manager, { compactIdleWaitMs: 100, compactIdlePollMs: 10 });
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%5', repoPath: '/repo/main', taskId: 'merged-task', updatedAt: NOW });

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
    manager = new AgentManager({
      config: CONFIG, agentStore, taskStore, lockManager, eventBus,
      runnerFactory: () => compactRunner(execs, undefined, 1),
    });
    Object.assign(manager, { compactIdleWaitMs: 100, compactIdlePollMs: 10 });
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%5', taskId: 'merged-task', repoPath: '/repo/main', updatedAt: NOW });

    await manager.dispatchPostMergeCleanup('dev-1', { prNumber: 9, taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => !(await agentStore.get('dev-1'))?.taskId);

    const binding = await agentStore.get('dev-1');
    expect(execs.join('\n')).toMatch(/tmux send-keys -l -t '%5' '\/clear'/);
    expect(binding?.taskId).toBeUndefined();
    expect(binding?.status).not.toBe('awaiting_human');
  });

  it('bails without touching the agent when its binding has moved to a different task', async () => {
    const execs: string[] = [];
    manager = new AgentManager({
      config: CONFIG, agentStore, taskStore, lockManager, eventBus,
      runnerFactory: () => compactRunner(execs),
    });
    Object.assign(manager, { compactIdleWaitMs: 50, compactIdlePollMs: 5 });
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%5', repoPath: '/repo/main', taskId: 'next-task', updatedAt: NOW });

    await manager.dispatchPostMergeCleanup('dev-1', { prNumber: 17, taskId: 'merged-task', branch: 'bx/task-merge' });
    await new Promise(r => setTimeout(r, 60));

    const joined = execs.join('\n');
    expect(joined).not.toContain('git fetch --prune origin');
    expect(joined).not.toContain("send-keys -l -t '%5' '/clear'");
    const binding = await agentStore.get('dev-1');
    expect(binding?.taskId).toBe('next-task');
  });

  it('dispatchPendingTask refuses an agent still bound to a just-merged task (post-merge cleanup in flight → Start disabled)', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%5', taskId: 'merged-task', updatedAt: NOW });
    await taskStore.set(task({ id: 'next-task', status: 'pending', agentId: 'dev-1', preferredAgentId: 'dev-1' }));

    const result = await manager.dispatchPendingTask('next-task', 'dev-1');

    expect(result.errorCode).toBe(409);
    expect((await taskStore.get('next-task'))?.status).toBe('pending');
  });

  it('retries once and releases agent on persistent failure', async () => {
    const execs: string[] = [];
    const alwaysBusy = '⏵⏵ bypass permissions on /tmp/repo\n\n· Compacting… (3s)\n  esc to interrupt\n';
    manager = new AgentManager({
      config: CONFIG, agentStore, taskStore, lockManager, eventBus,
      runnerFactory: () => ({
        exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
          execs.push(cmd);
          if (cmd.includes('display-message') && cmd.includes('pane_current_command')) {
            return { stdout: 'claude\n', stderr: '', exitCode: 0 };
          }
          if (cmd.includes('capture-pane')) return { stdout: alwaysBusy, stderr: '', exitCode: 0 };
          return { stdout: '', stderr: '', exitCode: 0 };
        }),
        writeFile: vi.fn(async () => undefined),
      }) as unknown as CommandRunner,
    });
    Object.assign(manager, { compactIdleWaitMs: 50, compactIdlePollMs: 5 });
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%5', taskId: 'merged-task', repoPath: '/repo/main', updatedAt: NOW });

    await manager.dispatchPostMergeCleanup('dev-1', { prNumber: 3, taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => !(await agentStore.get('dev-1'))?.taskId, 5000);

    const binding = await agentStore.get('dev-1');
    expect(binding?.taskId).toBeUndefined();
    expect(binding?.status).not.toBe('awaiting_human');
  });

  it('does not write taskId when paneId changes between initial read and update (race with retry/restart)', async () => {
    const execs: string[] = [];
    manager = new AgentManager({
      config: CONFIG, agentStore, taskStore, lockManager, eventBus,
      runnerFactory: () => compactRunner(execs),
    });
    Object.assign(manager, { compactIdleWaitMs: 100, compactIdlePollMs: 10 });
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%5', updatedAt: NOW });

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
    manager = new AgentManager({
      config: CONFIG, agentStore, taskStore, lockManager, eventBus,
      runnerFactory: () => ({
        exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
          execs.push(cmd);
          if (cmd.includes('display-message') && cmd.includes('pane_current_command')) {
            return { stdout: 'claude\n', stderr: '', exitCode: 0 };
          }
          if (cmd.includes('capture-pane')) {
            captureCount++;
            if (captureCount === 3) {
              const cur = await agentStore.get('dev-1');
              if (cur) await agentStore.set({ ...cur, taskId: 'new-review-task', updatedAt: new Date().toISOString() });
            }
            return { stdout: BUSY, stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        }),
        writeFile: vi.fn(async () => undefined),
      }) as unknown as CommandRunner,
    });
    Object.assign(manager, { compactIdleWaitMs: 50, compactIdlePollMs: 5 });
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%5', taskId: 'merged-task', repoPath: '/repo/main', updatedAt: NOW });

    await manager.dispatchPostMergeCleanup('dev-1', { prNumber: 1, taskId: 'merged-task', branch: 'bx/merged-task' });
    await new Promise(r => setTimeout(r, 500));

    expect(execs.filter(c => c.includes('send-keys') && c.includes('C-c'))).toHaveLength(0);
    const binding = await agentStore.get('dev-1');
    expect(binding?.taskId).toBe('new-review-task');
  });
});

describe('AgentManager awaiting_human lifecycle', () => {
  it('markAwaitingHuman sets status + emits intervention, preserving binding and lock', async () => {
    const t = task();
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW,
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

  it('resumeAgent on awaiting_human with terminal task: clears binding, releases lock, status=ok', async () => {
    const t = task({ status: 'cancelled' });
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed', updatedAt: NOW,
    });
    await lockManager.acquire('dev-1');

    const result = await manager.resumeAgent('dev-1');

    expect(result).toEqual({ resumed: true, releasedBinding: true });
    const state = await agentStore.get('dev-1');
    expect(state?.status).toBeUndefined();
    expect(state?.taskId).toBeUndefined();
    expect(state?.awaitingPhase).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('resumeAgent on awaiting_human (non-dialog/non-ack_unknown phase) with active task: clears status only, keeps binding', async () => {
    // cancel-interrupt-failed: cancel 内 C-c 失败的 phase。Resume 让 operator 把 agent 切 ok，
    // binding 仍指向 active task（之后再走 cancelTask 推 task terminal → 触发 release）。
    const t = task({ status: 'in_progress' });
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed', updatedAt: NOW,
    });
    await lockManager.acquire('dev-1');

    const result = await manager.resumeAgent('dev-1');

    expect(result).toEqual({ resumed: true, releasedBinding: false });
    const state = await agentStore.get('dev-1');
    expect(state?.status).toBeUndefined();
    expect(state?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('resumeAgent REFUSES on awaitingPhase=agent_dialog_resolved_runtime + active task (crash window: prompt never injected)', async () => {
    // Crash before fail-task with task still active → silently stuck; force operator cancel/DELETE.
    const t = task({ status: 'in_progress' });
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'agent_dialog_resolved_runtime', updatedAt: NOW,
    });
    await lockManager.acquire('dev-1');

    const result = await manager.resumeAgent('dev-1');

    expect(result).toEqual({ resumed: false, releasedBinding: false });
    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect((await agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('resumeAgent REFUSES on awaitingPhase=signal-arm-failed:* + active task (Resume cannot rebuild the watcher)', async () => {
    // Resume here would flip status→ok without re-arming → the dispatched prompt's signal still has
    // no consumer (silent deadlock). Force operator cancel/DELETE instead.
    const t = task({ status: 'in_progress' });
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'signal-arm-failed:spec-done,pr-created', updatedAt: NOW,
    });
    await lockManager.acquire('dev-1');

    const result = await manager.resumeAgent('dev-1');

    expect(result).toEqual({ resumed: false, releasedBinding: false });
    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect((await agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('resumeAgent ALLOWS release on awaitingPhase=agent_dialog_resolved_runtime (slowPoll detected REPL ready)', async () => {
    const t = task({ status: 'failed' }); // terminal (handleDialogPendingFromRuntime already pushed to failed)
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'agent_dialog_resolved_runtime', updatedAt: NOW,
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
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'agent_dialog_pending', updatedAt: NOW,
    });
    await lockManager.acquire('dev-1');

    const result = await manager.resumeAgent('dev-1');

    expect(result).toEqual({ resumed: false, releasedBinding: false });
    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBe('agent_dialog_pending');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('resumeAgent on agent that is not awaiting_human: noop', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: NOW });

    const result = await manager.resumeAgent('dev-1');

    expect(result).toEqual({ resumed: false, releasedBinding: false });
  });

  it('resumeAgent refuses when creationToken still set (bootstrap dialog unresolved)', async () => {
    await agentStore.set({
      id: 'dev-1', projectId: 'proj',
      creationToken: 'tok-still-pending',
      paneId: '%0',
      status: 'awaiting_human',
      awaitingPhase: 'agent_dialog_pending',
      updatedAt: NOW,
    });

    const result = await manager.resumeAgent('dev-1');

    expect(result).toEqual({ resumed: false, releasedBinding: false });
    // 状态保持 awaiting_human，DELETE 路径仍可用
    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect((await agentStore.get('dev-1'))?.creationToken).toBe('tok-still-pending');
  });

  it('resumeAgent REFUSES on dev-wait-gate-failed-after-qa-started + active task (QA prompt may still be running)', async () => {
    // QA prompt may still be running (ack_unknown semantics); outcome handler releases via allowAwaitingHuman.
    const t = task({ id: 'task-qa-stale', status: 'fixing' });
    await taskStore.set(t);
    await agentStore.set({
      id: 'qa-1', projectId: 'proj',
      taskId: t.id, paneId: '%1',
      status: 'awaiting_human', awaitingPhase: 'dev-wait-gate-failed-after-qa-started',
      updatedAt: NOW,
    });
    await lockManager.acquire('qa-1');

    const result = await manager.resumeAgent('qa-1');

    expect(result).toEqual({ resumed: false, releasedBinding: false });
    expect((await agentStore.get('qa-1'))?.status).toBe('awaiting_human');
    expect((await agentStore.get('qa-1'))?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('qa-1')).toBe(true);
  });

  it('resumeAgent ALLOWS release on dev-wait-gate-failed-after-qa-started + terminal task', async () => {
    // task terminal → shouldReleaseHeldBinding 第一条规则放行；Resume 必须能清 binding 让 operator 恢复。
    const t = task({ id: 'task-qa-cancelled', status: 'cancelled' });
    await taskStore.set(t);
    await agentStore.set({
      id: 'qa-1', projectId: 'proj',
      taskId: t.id, paneId: '%1',
      status: 'awaiting_human', awaitingPhase: 'dev-wait-gate-failed-after-qa-started',
      updatedAt: NOW,
    });
    await lockManager.acquire('qa-1');

    const result = await manager.resumeAgent('qa-1');

    expect(result).toEqual({ resumed: true, releasedBinding: true });
    expect((await agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('qa-1')).toBe(false);
  });

  it('releaseAgentForTask with allowAwaitingHuman=true bypasses gate (explicit recovery path)', async () => {
    const t = task();
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj',
      taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
      updatedAt: NOW,
    });
    await lockManager.acquire('dev-1');

    const ok = await manager.releaseAgentForTask('dev-1', t.id, 'idle', { allowAwaitingHuman: true });

    expect(ok).toBe(true);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('validateTaskDispatch ALLOWS create against awaiting_human agent (queues to pending; dispatch-time gates availability)', async () => {
    await agentStore.set({
      id: 'dev-1', projectId: 'proj',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
      updatedAt: NOW,
    });

    await expect(
      manager.validateTaskDispatch('proj', {
        title: 'x', description: 'y', preferredAgentId: 'dev-1',
      }),
    ).resolves.toBeUndefined();
  });

  it('resumeAgent no longer triggers drainQueue (pending tasks wait for explicit dispatchPendingTask)', async () => {
    const t = task({ id: 'task-resume-drain', status: 'cancelled' });
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj',
      taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
      updatedAt: NOW,
    });
    await lockManager.acquire('dev-1');

    const result = await manager.resumeAgent('dev-1');

    expect(result.resumed).toBe(true);
    expect(result.releasedBinding).toBe(true);
    expect('drainQueue' in (manager as unknown as Record<string, unknown>)).toBe(false);
  });

  it('releaseAgentForTask gate allows release when task is terminal even if status=awaiting_human', async () => {
    // Terminal cleanup (pr.merged / partner cleanup) must bypass the gate, else binding leaks to a terminal task.
    const t = task({ status: 'merged' }); // terminal
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj',
      taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
      updatedAt: NOW,
    });
    await lockManager.acquire('dev-1');

    // 不传 allowAwaitingHuman，但 task terminal → shouldReleaseHeldBinding=true → gate 放行
    const ok = await manager.releaseAgentForTask('dev-1', t.id, 'idle');

    expect(ok).toBe(true);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('releaseAgentForTask gate REFUSES release on dev-wait-gate-failed-after-qa-started + active task (QA prompt may still be running)', async () => {
    // Same ack_unknown semantics: outcome handler releases explicitly via allowAwaitingHuman.
    const t = task({ status: 'fixing' }); // active
    await taskStore.set(t);
    await agentStore.set({
      id: 'qa-1', projectId: 'proj',
      taskId: t.id, paneId: '%1',
      status: 'awaiting_human', awaitingPhase: 'dev-wait-gate-failed-after-qa-started',
      updatedAt: NOW,
    });
    await lockManager.acquire('qa-1');

    const ok = await manager.releaseAgentForTask('qa-1', t.id, 'idle');

    expect(ok).toBe(false);
    expect((await agentStore.get('qa-1'))?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('qa-1')).toBe(true);
  });

  it('releaseAgentForTask gate ALLOWS release on dev-wait-gate-failed-after-qa-started WITH allowAwaitingHuman opt (outcome handler path)', async () => {
    const t = task({ status: 'approved' });
    await taskStore.set(t);
    await agentStore.set({
      id: 'qa-1', projectId: 'proj',
      taskId: t.id, paneId: '%1',
      status: 'awaiting_human', awaitingPhase: 'dev-wait-gate-failed-after-qa-started',
      updatedAt: NOW,
    });
    await lockManager.acquire('qa-1');

    const ok = await manager.releaseAgentForTask('qa-1', t.id, 'idle', { allowAwaitingHuman: true });

    expect(ok).toBe(true);
    expect((await agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('qa-1')).toBe(false);
  });

  it('releaseAgentForTask gate REFUSES release when awaitingPhase=dispatch-failed:ack_unknown without allowAwaitingHuman opt', async () => {
    // ack_unknown = prompt may still be running in pane; gate refuses unless caller explicitly opts in.
    const t = task({ status: 'review' });
    await taskStore.set(t);
    await agentStore.set({
      id: 'qa-1', projectId: 'proj',
      taskId: t.id, paneId: '%1',
      status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown',
      updatedAt: NOW,
    });
    await lockManager.acquire('qa-1');

    const ok = await manager.releaseAgentForTask('qa-1', t.id, 'idle');

    expect(ok).toBe(false);
    expect((await agentStore.get('qa-1'))?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('qa-1')).toBe(true);
  });

  it('releaseAgentForTask gate ALLOWS release when awaitingPhase=dispatch-failed:ack_unknown WITH allowAwaitingHuman opt (outcome handler path)', async () => {
    // outcome handler (review.submitted) 显式传 allowAwaitingHuman=true → 放行 Held QA。
    const t = task({ status: 'approved' });
    await taskStore.set(t);
    await agentStore.set({
      id: 'qa-1', projectId: 'proj',
      taskId: t.id, paneId: '%1',
      status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown',
      updatedAt: NOW,
    });
    await lockManager.acquire('qa-1');

    const ok = await manager.releaseAgentForTask('qa-1', t.id, 'idle', { allowAwaitingHuman: true });

    expect(ok).toBe(true);
    expect((await agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('qa-1')).toBe(false);
  });

  it('resumeAgent refuses to resume when awaitingPhase=dispatch-failed:ack_unknown AND bound task is still active', async () => {
    const t = task({ status: 'review' });
    await taskStore.set(t);
    await agentStore.set({
      id: 'qa-1', projectId: 'proj',
      taskId: t.id, paneId: '%1',
      status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown',
      updatedAt: NOW,
    });
    await lockManager.acquire('qa-1');

    const result = await manager.resumeAgent('qa-1');

    expect(result).toEqual({ resumed: false, releasedBinding: false });
    expect((await agentStore.get('qa-1'))?.status).toBe('awaiting_human');
    expect((await agentStore.get('qa-1'))?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('qa-1')).toBe(true);
  });

  it('resumeAgent ALLOWS release when awaitingPhase=dispatch-failed:ack_unknown but bound task is TERMINAL', async () => {
    // Task terminal + agent Held → Resume must release binding+lock, else only DELETE agent can recover.
    const t = task({ status: 'failed' }); // terminal
    await taskStore.set(t);
    await agentStore.set({
      id: 'qa-1', projectId: 'proj',
      taskId: t.id, paneId: '%1',
      status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown',
      updatedAt: NOW,
    });
    await lockManager.acquire('qa-1');

    const result = await manager.resumeAgent('qa-1');

    expect(result).toEqual({ resumed: true, releasedBinding: true });
    expect((await agentStore.get('qa-1'))?.taskId).toBeUndefined();
    // status='ok' 在 normalizeBinding 内被规范化为 undefined（schema 只存 awaiting_human）
    expect((await agentStore.get('qa-1'))?.status).toBeUndefined();
    expect(await lockManager.isLocked('qa-1')).toBe(false);
  });

  it('resumeAgent ALLOWS release when awaitingPhase=dispatch-failed:ack_unknown and bound task is MISSING', async () => {
    // boundTask null (taskStore 缺失) → shouldReleaseHeldBinding 第一条规则放行，Resume 能清 binding。
    await agentStore.set({
      id: 'qa-1', projectId: 'proj',
      taskId: 'ghost-task', paneId: '%1',
      status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown',
      updatedAt: NOW,
    });
    await lockManager.acquire('qa-1');

    const result = await manager.resumeAgent('qa-1');

    expect(result).toEqual({ resumed: true, releasedBinding: true });
    expect((await agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('qa-1')).toBe(false);
  });

  it('dispatchReviewToQa on ack_unknown still transitions task to review (so outcome can be processed)', async () => {
    // QA prompt already sent → skip transition would make outcome handler drop the result on fromStatus mismatch.
    const t = task({ id: 'task-manual-ack', status: 'approved', prNumber: 99, branch: 'bx/x', qaAgentId: 'qa-1', reviewRound: 1 });
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW,
    });
    await agentStore.set({
      id: 'qa-1', projectId: 'proj', taskId: t.id, paneId: '%1', updatedAt: NOW,
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
    vi.restoreAllMocks();
  });

  it('dispatchReviewToQa: emits manual-review-dev-parked-qa-failed (not "interrupted") when QA fails after dev parked', async () => {
    // Phase + note must match actual behavior (parked, no C-c) so operators don't misread.
    const t = task({ id: 'task-park-qa-fail', status: 'in_progress', prNumber: 50, branch: 'bx/x' });
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW,
    });
    await agentStore.set({ id: 'qa-1', projectId: 'proj', updatedAt: NOW });
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
    const t = task({ id: 'task-manual-dialog', status: 'approved', prNumber: 99, branch: 'bx/x', qaAgentId: 'qa-1', reviewRound: 1 });
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW,
    });
    await agentStore.set({
      id: 'qa-1', projectId: 'proj', taskId: t.id, paneId: '%1', updatedAt: NOW,
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
    vi.restoreAllMocks();
  });

  it('dispatchReviewToQa ack_unknown preserves verdict-installed status; new design persists anchor+bump BEFORE startSession', async () => {
    // Original race: prompt was sent before transition/bump, so a fast verdict
    // could race with the cleanup transition. New design: PHASE 1 transition +
    // bump happen BEFORE the verdict watcher is even armed, so there's nothing
    // to "skip" in the ack_unknown branch — it's just a no-op. If a late
    // verdict (mocked here by startSession writing 'fixing' before throwing)
    // changes status post-PHASE-1, that change must survive: ack_unknown means
    // the prompt was sent and the verdict is real, so we don't roll back.
    const t = task({ id: 'task-claim-approved', status: 'approved', prNumber: 99, branch: 'bx/x', qaAgentId: 'qa-1', reviewRound: 1 });
    await taskStore.set(t);
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW });
    await agentStore.set({ id: 'qa-1', projectId: 'proj', taskId: t.id, paneId: '%1', updatedAt: NOW });
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
    vi.restoreAllMocks();
  });

  it('dispatchReviewToQa: PHASE 1 persists status="review" + reviewHeadAnchorSha + reviewRound bump BEFORE startSession sees the task', async () => {
    // worker-legacy requested race-fix coverage: a fast pane verdict can fire
    // the moment startSession injects the prompt, and the review.submitted
    // handler must see the new anchor + status + qaAgentId. We assert by
    // checking what taskStore.get returns INSIDE the startSession mock — that
    // snapshot is what the handler would read if it ran right then.
    const t = task({ id: 'task-phase-order', status: 'in_progress', prNumber: 42, branch: 'bx/x', qaAgentId: 'qa-1', reviewRound: 0 });
    await taskStore.set(t);
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW });
    await agentStore.set({ id: 'qa-1', projectId: 'proj', taskId: t.id, paneId: '%1', updatedAt: NOW });
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
    vi.restoreAllMocks();
  });

  it('dispatchReviewToQa rotates signalToken atomically with the anchor before arming the watcher', async () => {
    // Same fix as the pr.updated push path: the manual review dispatch must rotate the
    // per-pass token together with reviewDispatchedAt, not leave it lagging until PHASE 2.
    // Mock rotateAndSetupPhaseSignal (PHASE 2) to a no-op so the token seen at startSession
    // could only have been rotated by PHASE 1.
    const t = task({
      id: 'task-phase1-tokrot', status: 'review', prNumber: 42, branch: 'bx/x',
      qaAgentId: 'qa-1', reviewRound: 1, signalToken: 'old-pass-token-1',
    });
    await taskStore.set(t);
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW });
    await agentStore.set({ id: 'qa-1', projectId: 'proj', taskId: t.id, paneId: '%1', updatedAt: NOW });
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
    vi.restoreAllMocks();
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
    const m3 = new AgentManager({
      config: CONFIG,
      agentStore,
      taskStore,
      lockManager,
      eventBus,
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => readyRunner(),
      phaseSignalWatcher: watcher as never,
    });
    const t = task({
      id: 'task-rb-rearm', status: 'approved', prNumber: 88, branch: 'bx/x',
      qaAgentId: 'qa-1', reviewRound: 1,
    });
    await taskStore.set(t);
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW });
    await agentStore.set({ id: 'qa-1', projectId: 'proj', taskId: t.id, paneId: '%1', updatedAt: NOW });
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
    vi.restoreAllMocks();
  });

  it('dispatchReviewToQa rollback restores snapshot fields', async () => {
    // For a 'review' task with an existing qaAgentId and an in-flight signal
    // token, a failed manual dispatch must restore both — otherwise a
    // subsequent push-driven recheck reads a stale qaAgentId (release returns
    // false → qa-release-failed-cannot-recheck) and dev's pending emit with
    // the old token strands silently.
    const t = task({
      id: 'task-rb-snap', status: 'review', prNumber: 99, branch: 'bx/x',
      qaAgentId: 'qa-orig', signalToken: 'tok-old-12345', reviewHeadAnchorSha: 'c'.repeat(40),
      reviewRound: 2,
    });
    await taskStore.set(t);
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW });
    await agentStore.set({ id: 'qa-1', projectId: 'proj', updatedAt: NOW });
    await agentStore.set({ id: 'qa-orig', projectId: 'proj', updatedAt: NOW });
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
    vi.restoreAllMocks();
  });

  it('dispatchReviewToQa PHASE 1 always overwrites reviewHeadAnchorSha — fetchPrHeadSha failure clears stale anchor', async () => {
    // Without explicit overwrite, fetch failure preserves a stale anchor from
    // a prior round → pane-signal approvals fall back to it → false stale-head
    // rejection or use of an old commit as "reviewed head".
    const t = task({
      id: 'task-stale-anchor', status: 'fixing', prNumber: 99, branch: 'bx/x',
      qaAgentId: 'qa-1', reviewHeadAnchorSha: 'd'.repeat(40), reviewRound: 1,
    });
    await taskStore.set(t);
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW });
    await agentStore.set({ id: 'qa-1', projectId: 'proj', updatedAt: NOW });
    vi.spyOn(manager, 'fetchPrHeadSha').mockRejectedValue(new Error('gh offline'));
    vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);
    vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await manager.dispatchReviewToQa(t.id);

    const updated = await taskStore.get(t.id);
    expect(updated?.reviewHeadAnchorSha).toBeUndefined();  // stale anchor cleared, NOT preserved
    vi.restoreAllMocks();
  });

  it('handleDialogPendingFromRuntime also releases partner agents on task fail (UI Retry path truly opens)', async () => {
    // Without clearing partner binding, retryTask's validateTaskDispatch sees dev still bound to the terminal task → 409 blocks UI Retry.
    const t = task({ id: 'task-partner-cleanup', status: 'in_progress', qaAgentId: 'qa-1' });
    await taskStore.set(t);
    // QA 触发 runtime dialog
    await agentStore.set({
      id: 'qa-1', projectId: 'proj',
      taskId: t.id, paneId: '%1',
      updatedAt: NOW,
    });
    // dev 同时绑该 task
    await agentStore.set({
      id: 'dev-1', projectId: 'proj',
      taskId: t.id, paneId: '%0',
      updatedAt: NOW,
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
    const t = task({ status: 'in_progress' });
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj',
      taskId: t.id, paneId: '%0',
      updatedAt: NOW,
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
    const t = task({ id: 'task-outcome-arrived', status: 'approved' }); // 并发 outcome 已推 approved
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj',
      taskId: t.id, paneId: '%0',
      updatedAt: NOW,
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
    const t = task({ id: 'task-still-in-progress', status: 'in_progress' });
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj',
      taskId: t.id, paneId: '%0',
      updatedAt: NOW,
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
    const t = task({ id: 'task-already-cancelled', status: 'cancelled' }); // terminal but not failed
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj',
      taskId: t.id, paneId: '%0',
      updatedAt: NOW,
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
    await agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: NOW });
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
    await agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: NOW });
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
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%new', updatedAt: NOW });
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
    await agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: NOW });

    const err = new EnsureSessionError(
      { createdSession: false, agentId: 'dev-1', dialogPending: true },
      'adopt path runtime dialog',
    );
    const handled = await manager.handleDialogPendingFromRuntime('dev-1', err);

    expect(handled).toBe(false);
    const state = await agentStore.get('dev-1');
    expect(state?.status).toBeUndefined();
  });

  it('markAwaitingHuman with expectedTaskId guard: noop when binding has shifted to a different task', async () => {
    // Late mark races with release+reassign; atomic-update guards on expectedTaskId to avoid polluting the new task.
    await agentStore.set({
      id: 'qa-1', projectId: 'proj',
      taskId: 'task-new', paneId: '%0',
      updatedAt: NOW,
    });

    await manager.markAwaitingHuman('qa-1', 'dispatch-failed:ack_unknown', 'stale ack_unknown', {
      expectedTaskId: 'task-old',
    });

    const state = await agentStore.get('qa-1');
    expect(state?.status).toBeUndefined();
    expect(state?.awaitingPhase).toBeUndefined();
    expect(state?.taskId).toBe('task-new');
  });

  it('markAwaitingHuman with expectedTaskId guard: writes when binding still matches', async () => {
    await agentStore.set({
      id: 'qa-1', projectId: 'proj',
      taskId: 'task-current', paneId: '%0',
      updatedAt: NOW,
    });

    await manager.markAwaitingHuman('qa-1', 'dispatch-failed:ack_unknown', 'ack_unknown', {
      expectedTaskId: 'task-current',
    });

    const state = await agentStore.get('qa-1');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('dispatch-failed:ack_unknown');
  });

  it('markAwaitingHuman with expectedCreationToken=null is noop when token has been set (DELETE+recreate race)', async () => {
    await agentStore.set({
      id: 'dev-1', projectId: 'proj',
      creationToken: 'tok-recreated', // 新 agent 已被创建
      updatedAt: NOW,
    });

    await manager.markAwaitingHuman('dev-1', 'agent_dialog_pending', 'stale runtime callback', {
      expectedCreationToken: null, // 旧 runtime callback：期待"仍无 token"
    });

    const state = await agentStore.get('dev-1');
    expect(state?.status).toBeUndefined();
    expect(state?.awaitingPhase).toBeUndefined();
  });

  it('releaseAgentForTask refuses to release when status=awaiting_human (no allowAwaitingHuman opt)', async () => {
    const t = task();
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj',
      taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
      updatedAt: NOW,
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

  it('markAwaitingHuman with expectedCreationToken: noop on token mismatch (DELETE+recreate race)', async () => {
    await agentStore.set({
      id: 'dev-1', projectId: 'proj',
      creationToken: 'tok-new', // newer generation already swapped in
      updatedAt: NOW,
    });

    await manager.markAwaitingHuman('dev-1', 'agent_dialog_pending', 'stale token holder', {
      expectedCreationToken: 'tok-old',
    });

    const state = await agentStore.get('dev-1');
    expect(state?.status).toBeUndefined();
    expect(state?.awaitingPhase).toBeUndefined();
    const emitted = events.filter(
      e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'agent_dialog_pending',
    );
    expect(emitted).toHaveLength(0);
  });

  it('canDispatchWithBinding rejects same-task reentry when awaiting_human (cannot bypass via reentry phase)', async () => {
    // 此场景：agent 已 awaiting_human 但仍绑同一 task；reentry phase 试图 acquire。
    // acquireAgentForTask 走 sameTaskReentry 分支需要校验 status，否则绕过 gate。
    await taskStore.set(task({ id: 'task-reentry-block' }));
    await agentStore.set({
      id: 'dev-1', projectId: 'proj',
      taskId: 'task-reentry-block', paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
      updatedAt: NOW,
    });
    await lockManager.acquire('dev-1');

    const ok = await manager.acquireAgentForTask('dev-1', 'task-reentry-block', 'fix');
    expect(ok).toBe(false);
  });

  it('markAwaitingHuman with expectedCreationToken: writes on token match', async () => {
    await agentStore.set({
      id: 'dev-1', projectId: 'proj',
      creationToken: 'tok-match',
      updatedAt: NOW,
    });

    await manager.markAwaitingHuman('dev-1', 'agent_dialog_pending', 'good', {
      expectedCreationToken: 'tok-match',
    });

    const state = await agentStore.get('dev-1');
    expect(state?.status).toBe('awaiting_human');
  });
});

describe('injectAndAwaitAck ack timeout', () => {
  it('emits human.intervention dispatch-ack-timeout, does not throw, does not send C-c', async () => {
    const sentCommands: string[] = [];
    const stuckRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        sentCommands.push(cmd);
        if (cmd.includes('capture-pane')) {
          return {
            stdout: 'stuck-screen\n___bx-snap-sep___\n42\n',
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const localManager = new AgentManager({
      config: CONFIG,
      agentStore,
      taskStore,
      lockManager,
      eventBus,
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => stuckRunner,
      dispatchAckTimeoutMs: 50,
    });

    const t = task();
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: t.id,
      paneId: '%0',
      updatedAt: NOW,
    });
    await lockManager.acquire('dev-1');

    const tmux = new TmuxManager(stuckRunner);

    await expect(
      (localManager as unknown as {
        injectAndAwaitAck: (
          tmux: TmuxManager,
          paneId: string,
          prompt: string,
          agentId: string,
          runtime: 'claude-code' | 'codex',
        ) => Promise<{ acked: boolean }>;
      }).injectAndAwaitAck(tmux, '%0', 'hello prompt', 'dev-1', 'claude-code'),
    ).resolves.toEqual({ acked: false, composerDelivered: true });

    const interventions = events.filter(
      e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'dispatch-ack-timeout',
    );
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
          return { stdout: `${visible}___bx-snap-sep___\n0\n`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const localManager = new AgentManager({
      config: CONFIG,
      agentStore,
      taskStore,
      lockManager,
      eventBus,
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => flakyRunner,
      dispatchAckTimeoutMs: 3000,
      dispatchSettleTimeoutMs: 10,
    });
    (localManager as unknown as { dispatchAckResendIntervalMs: number }).dispatchAckResendIntervalMs = 50;
    const tmux = new TmuxManager(flakyRunner);

    const result = await (localManager as unknown as {
      injectAndAwaitAck: (
        tmux: TmuxManager,
        paneId: string,
        prompt: string,
        agentId: string,
        runtime: 'claude-code' | 'codex',
      ) => Promise<{ acked: boolean }>;
    }).injectAndAwaitAck(tmux, '%0', 'hello prompt', 'dev-1', 'claude-code');

    expect(result).toEqual({ acked: true, composerDelivered: true });
    expect(enterCount).toBeGreaterThanOrEqual(2);
  });

  it('infrastructure failure during the post-Enter ack wait throws DispatchTerminalError, not human.intervention', async () => {
    let enterSent = false;
    const SETTLED = 'idle\n___bx-snap-sep___\n10\n';
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
    const localManager = new AgentManager({
      config: CONFIG,
      agentStore,
      taskStore,
      lockManager,
      eventBus,
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => failingRunner,
      dispatchAckTimeoutMs: 50,
      dispatchSettleTimeoutMs: 200,
    });
    const t = task();
    await taskStore.set(t);
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: t.id,
      paneId: '%0',
      updatedAt: NOW,
    });
    const tmux = new TmuxManager(failingRunner);

    await expect(
      (localManager as unknown as {
        injectAndAwaitAck: (
          tmux: TmuxManager,
          paneId: string,
          prompt: string,
          agentId: string,
          runtime: 'claude-code' | 'codex',
        ) => Promise<{ acked: boolean }>;
      }).injectAndAwaitAck(tmux, '%0', 'hello prompt', 'dev-1', 'claude-code'),
    ).rejects.toBeInstanceOf(DispatchTerminalError);

    const ackTimeouts = events.filter(
      e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'dispatch-ack-timeout',
    );
    expect(ackTimeouts).toHaveLength(0);
  });
});

describe('injectAndAwaitAck settles the pane before Enter', () => {
  it('settles the pane before Enter, then acks on submission evidence (idle→busy) after Enter', async () => {
    const order: string[] = [];
    const SEP = '___bx-snap-sep___';
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
          return { stdout: `${visible}${SEP}\n0\n`, stderr: '', exitCode: 0 };
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
    const localManager = new AgentManager({
      config: CONFIG,
      agentStore,
      taskStore,
      lockManager,
      eventBus,
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => runner,
      dispatchAckTimeoutMs: 2000,
      dispatchSettleTimeoutMs: 2000,
    });
    const t = task();
    await taskStore.set(t);
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW });
    await lockManager.acquire('dev-1');
    const tmux = new TmuxManager(runner);

    const result = await (localManager as unknown as {
      injectAndAwaitAck: (
        tmux: TmuxManager,
        paneId: string,
        prompt: string,
        agentId: string,
        runtime: 'claude-code' | 'codex',
      ) => Promise<{ acked: boolean }>;
    }).injectAndAwaitAck(tmux, '%0', 'hello prompt', 'dev-1', 'claude-code');

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
    const SEP = '___bx-snap-sep___';
    let enterSent = false;
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('display-message')) {
          return { stdout: `frame ${n++}\n${SEP}\n0\n`, stderr: '', exitCode: 0 };
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
    const localManager = new AgentManager({
      config: CONFIG,
      agentStore,
      taskStore,
      lockManager,
      eventBus,
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => runner,
      dispatchAckTimeoutMs: 60,
      dispatchSettleTimeoutMs: 60,
    });
    const t = task();
    await taskStore.set(t);
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW });
    await lockManager.acquire('dev-1');
    const tmux = new TmuxManager(runner);

    const result = await (localManager as unknown as {
      injectAndAwaitAck: (
        tmux: TmuxManager,
        paneId: string,
        prompt: string,
        agentId: string,
        runtime: 'claude-code' | 'codex',
      ) => Promise<{ acked: boolean }>;
    }).injectAndAwaitAck(tmux, '%0', 'hello prompt', 'dev-1', 'claude-code');

    expect(result).toEqual({ acked: false, composerDelivered: true });
    expect(enterSent).toBe(true);
    const interventions = events.filter(
      e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'dispatch-ack-timeout',
    );
    expect(interventions).toHaveLength(1);
    expect((await taskStore.get(t.id))?.status).toBe('in_progress');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });
});

describe('injectAndAwaitAck post-approve edge cases', () => {
  const SEP = '___bx-snap-sep___';

  it('acks a quick task on its brief idle-to-busy flash after Enter', async () => {
    let enterSent = false;
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('display-message')) {
          // pre-Enter: settled idle. post-Enter: runtime flashes busy (the one fakeable-proof signal).
          const visible = enterSent ? 'working\n  esc to interrupt\n' : 'composer\n';
          return { stdout: `${visible}${SEP}\n5\n`, stderr: '', exitCode: 0 };
        }
        if (cmd.includes('send-keys') && cmd.includes('Enter')) {
          enterSent = true;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const localManager = new AgentManager({
      config: CONFIG, agentStore, taskStore, lockManager, eventBus,
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => runner,
      dispatchAckTimeoutMs: 1000, dispatchSettleTimeoutMs: 1000,
    });
    const t = task();
    await taskStore.set(t);
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW });
    await lockManager.acquire('dev-1');
    const tmux = new TmuxManager(runner);
    const result = await (localManager as unknown as {
      injectAndAwaitAck: (tmux: TmuxManager, paneId: string, prompt: string, agentId: string, runtime: 'claude-code' | 'codex') => Promise<{ acked: boolean }>;
    }).injectAndAwaitAck(tmux, '%0', 'hello prompt', 'dev-1', 'claude-code');
    expect(result).toEqual({ acked: true, composerDelivered: true });
    expect(enterSent).toBe(true);
  });

  it('does NOT ack on scrollback growth from an uncommitted attach redraw when runtime never gets busy', async () => {
    let enterSent = false;
    let h = 5;
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('display-message')) {
          // post-Enter the attach redraw keeps pushing scrollback, but the pane never goes busy.
          if (enterSent) h += 1;
          return { stdout: `composer still open\n${SEP}\n${h}\n`, stderr: '', exitCode: 0 };
        }
        if (cmd.includes('send-keys') && cmd.includes('Enter')) {
          enterSent = true;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const localManager = new AgentManager({
      config: CONFIG, agentStore, taskStore, lockManager, eventBus,
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => runner,
      dispatchAckTimeoutMs: 150, dispatchSettleTimeoutMs: 80,
    });
    const t = task();
    await taskStore.set(t);
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW });
    await lockManager.acquire('dev-1');
    const tmux = new TmuxManager(runner);
    const result = await (localManager as unknown as {
      injectAndAwaitAck: (tmux: TmuxManager, paneId: string, prompt: string, agentId: string, runtime: 'claude-code' | 'codex') => Promise<{ acked: boolean }>;
    }).injectAndAwaitAck(tmux, '%0', 'hello prompt', 'dev-1', 'claude-code');
    expect(result).toEqual({ acked: false, composerDelivered: true });
    expect(enterSent).toBe(true);
    const interventions = events.filter(
      e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'dispatch-ack-timeout',
    );
    expect(interventions).toHaveLength(1);
  });

  it('a failed sendEnter is raw cleanup, not ack_unknown', async () => {
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('display-message')) {
          return { stdout: `idle\n${SEP}\n5\n`, stderr: '', exitCode: 0 };
        }
        if (cmd.includes('send-keys') && cmd.includes('Enter')) {
          return { stdout: '', stderr: 'no such pane: %0', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const localManager = new AgentManager({
      config: CONFIG, agentStore, taskStore, lockManager, eventBus,
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => runner,
      dispatchAckTimeoutMs: 100, dispatchSettleTimeoutMs: 100,
    });
    const t = task();
    await taskStore.set(t);
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW });
    await lockManager.acquire('dev-1');
    const tmux = new TmuxManager(runner);
    let caught: unknown;
    try {
      await (localManager as unknown as {
        injectAndAwaitAck: (tmux: TmuxManager, paneId: string, prompt: string, agentId: string, runtime: 'claude-code' | 'codex') => Promise<{ acked: boolean }>;
      }).injectAndAwaitAck(tmux, '%0', 'hello prompt', 'dev-1', 'claude-code');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof DispatchTerminalError && caught.reason === 'ack_unknown').toBe(false);
  });

  it('does NOT ack on busy text that was already in the pasted prompt when Enter is swallowed', async () => {
    // baseline already shows "esc to interrupt" (user pasted it); Enter is swallowed → nothing changes.
    const screen = `do X\n  esc to interrupt\n`;
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('display-message')) {
          return { stdout: `${screen}${SEP}\n3\n`, stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          return { stdout: screen, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const localManager = new AgentManager({
      config: CONFIG, agentStore, taskStore, lockManager, eventBus,
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => runner,
      dispatchAckTimeoutMs: 150, dispatchSettleTimeoutMs: 150,
    });
    const t = task();
    await taskStore.set(t);
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW });
    await lockManager.acquire('dev-1');
    const tmux = new TmuxManager(runner);
    const result = await (localManager as unknown as {
      injectAndAwaitAck: (tmux: TmuxManager, paneId: string, prompt: string, agentId: string, runtime: 'claude-code' | 'codex') => Promise<{ acked: boolean }>;
    }).injectAndAwaitAck(tmux, '%0', 'do X\n  esc to interrupt', 'dev-1', 'claude-code');
    expect(result).toEqual({ acked: false, composerDelivered: false });
    const interventions = events.filter(
      e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'dispatch-ack-timeout',
    );
    expect(interventions).toHaveLength(1);
  });

  it('a pre-Enter settle/capture failure is not ack_unknown and never sends Enter', async () => {
    const sent: string[] = [];
    let snaps = 0;
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        sent.push(cmd);
        if (cmd.includes('display-message')) {
          snaps++;
          if (snaps === 1) return { stdout: `composer\n${SEP}\n1\n`, stderr: '', exitCode: 0 };
          return { stdout: '', stderr: 'no such pane: %0', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const localManager = new AgentManager({
      config: CONFIG, agentStore, taskStore, lockManager, eventBus,
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => runner,
      dispatchAckTimeoutMs: 150, dispatchSettleTimeoutMs: 150,
    });
    const t = task();
    await taskStore.set(t);
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW });
    await lockManager.acquire('dev-1');
    const tmux = new TmuxManager(runner);

    let caught: unknown;
    try {
      await (localManager as unknown as {
        injectAndAwaitAck: (tmux: TmuxManager, paneId: string, prompt: string, agentId: string, runtime: 'claude-code' | 'codex') => Promise<{ acked: boolean }>;
      }).injectAndAwaitAck(tmux, '%0', 'hello prompt', 'dev-1', 'claude-code');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof DispatchTerminalError && caught.reason === 'ack_unknown').toBe(false);
    const enterCmds = sent.filter(c => c.includes('send-keys') && c.includes('Enter'));
    expect(enterCmds).toHaveLength(0);
  });
});

describe('injectAndAwaitAck makes the pane reuse-safe on pre-Enter failure', () => {
  const SEP = '___bx-snap-sep___';
  const ccCmds = (sent: string[]): string[] =>
    sent.filter(c => c.includes('send-keys') && c.includes('C-c'));
  const hasSessionCmds = (sent: string[]): string[] =>
    sent.filter(c => c.includes('has-session'));

  const runInject = async (
    runner: CommandRunner,
    prompt = 'hello prompt',
  ): Promise<{ result?: { acked: boolean; composerDelivered: boolean }; caught?: unknown }> => {
    const localManager = new AgentManager({
      config: CONFIG, agentStore, taskStore, lockManager, eventBus,
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => runner,
      dispatchAckTimeoutMs: 150, dispatchSettleTimeoutMs: 150,
    });
    const t = task();
    await taskStore.set(t);
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW });
    await lockManager.acquire('dev-1');
    const tmux = new TmuxManager(runner);
    try {
      const result = await (localManager as unknown as {
        injectAndAwaitAck: (tmux: TmuxManager, paneId: string, prompt: string, agentId: string, runtime: 'claude-code' | 'codex') => Promise<{ acked: boolean; composerDelivered: boolean }>;
      }).injectAndAwaitAck(tmux, '%0', prompt, 'dev-1', 'claude-code');
      return { result };
    } catch (caught) {
      return { caught };
    }
  };

  it('clears the composer with C-c after a pre-Enter capture failure → raw, never Enter, no kill probe', async () => {
    const sent: string[] = [];
    let snaps = 0;
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        sent.push(cmd);
        if (cmd.includes('display-message')) {
          snaps++;
          if (snaps === 1) return { stdout: `composer\n${SEP}\n1\n`, stderr: '', exitCode: 0 };
          return { stdout: '', stderr: 'no such pane: %0', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const { caught } = await runInject(runner);
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof DispatchTerminalError && caught.reason === 'ack_unknown').toBe(false);
    expect(ccCmds(sent)).toHaveLength(1);
    expect(hasSessionCmds(sent)).toHaveLength(0); // C-c landed → no need to probe the session
    expect(sent.filter(c => c.includes('send-keys') && c.includes('Enter'))).toHaveLength(0);
  });

  it('clears the composer with C-c after a failed sendEnter → raw', async () => {
    const sent: string[] = [];
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        sent.push(cmd);
        if (cmd.includes('display-message')) {
          return { stdout: `idle\n${SEP}\n5\n`, stderr: '', exitCode: 0 };
        }
        if (cmd.includes('send-keys') && cmd.includes('Enter')) {
          return { stdout: '', stderr: 'no such pane: %0', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const { caught } = await runInject(runner);
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof DispatchTerminalError && caught.reason === 'ack_unknown').toBe(false);
    expect(ccCmds(sent)).toHaveLength(1);
  });

  it('a transient C-c failure on a still-live session escalates to ack_unknown', async () => {
    const sent: string[] = [];
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        sent.push(cmd);
        if (cmd.includes('has-session')) return { stdout: '', stderr: '', exitCode: 0 }; // alive
        // The transient tmux/SSH fault that broke sendEnter also breaks the follow-up C-c — but it is
        // a generic transient error, NOT "no such pane": the pane is still live with the leftover.
        if (cmd.includes('send-keys')) return { stdout: '', stderr: 'ssh: connect: connection timed out', exitCode: 1 };
        if (cmd.includes('display-message')) return { stdout: `idle\n${SEP}\n5\n`, stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const { caught } = await runInject(runner);
    expect(caught).toBeInstanceOf(DispatchTerminalError);
    expect((caught as DispatchTerminalError).reason).toBe('ack_unknown');
    expect(ccCmds(sent)).toHaveLength(1);
    expect(hasSessionCmds(sent)).toHaveLength(1); // probed → still alive → cannot release for reuse
  });

  it('a C-c failure on a CONFIRMED-DEAD session is reuse-safe → raw (next dispatch rebuilds fresh)', async () => {
    const sent: string[] = [];
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        sent.push(cmd);
        if (cmd.includes('has-session')) return { stdout: '', stderr: "can't find session: dev-1", exitCode: 1 }; // gone
        if (cmd.includes('send-keys')) return { stdout: '', stderr: 'no such pane: %0', exitCode: 1 };
        if (cmd.includes('display-message')) return { stdout: `idle\n${SEP}\n5\n`, stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const { caught } = await runInject(runner);
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof DispatchTerminalError && caught.reason === 'ack_unknown').toBe(false);
    expect(ccCmds(sent)).toHaveLength(1);
    expect(hasSessionCmds(sent)).toHaveLength(1); // probed → confirmed dead → safe no-op
  });

  it('an UNCONFIRMABLE session (C-c fails AND has-session probe fails) escalates to ack_unknown', async () => {
    const sent: string[] = [];
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        sent.push(cmd);
        if (cmd.includes('has-session')) return { stdout: '', stderr: 'ssh: connect: connection timed out', exitCode: 2 }; // unexpected → throws
        if (cmd.includes('send-keys')) return { stdout: '', stderr: 'ssh: connect: connection timed out', exitCode: 1 };
        if (cmd.includes('display-message')) return { stdout: `idle\n${SEP}\n5\n`, stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const { caught } = await runInject(runner);
    expect(caught).toBeInstanceOf(DispatchTerminalError);
    expect((caught as DispatchTerminalError).reason).toBe('ack_unknown');
    expect(ccCmds(sent)).toHaveLength(1);
    expect(hasSessionCmds(sent)).toHaveLength(1);
  });

  it('does NOT touch the composer on a post-Enter ack_unknown — the prompt may be running', async () => {
    const sent: string[] = [];
    let enterSent = false;
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        sent.push(cmd);
        if (cmd.includes('send-keys') && cmd.includes('Enter')) {
          enterSent = true;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane') || cmd.includes('display-message')) {
          if (!enterSent) return { stdout: `idle\n${SEP}\n10\n`, stderr: '', exitCode: 0 };
          return { stdout: '', stderr: 'no such pane: %0', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const { caught } = await runInject(runner);
    expect(caught).toBeInstanceOf(DispatchTerminalError);
    expect((caught as DispatchTerminalError).reason).toBe('ack_unknown');
    expect(ccCmds(sent)).toHaveLength(0);
    expect(hasSessionCmds(sent)).toHaveLength(0);
  });

  it('does NOT touch the composer on a clean ack', async () => {
    const sent: string[] = [];
    let enterSent = false;
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        sent.push(cmd);
        if (cmd.includes('display-message')) {
          const visible = enterSent ? 'working\n  esc to interrupt\n' : 'composer\n';
          return { stdout: `${visible}${SEP}\n5\n`, stderr: '', exitCode: 0 };
        }
        if (cmd.includes('send-keys') && cmd.includes('Enter')) {
          enterSent = true;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const { result } = await runInject(runner);
    expect(result).toEqual({ acked: true, composerDelivered: true });
    expect(ccCmds(sent)).toHaveLength(0);
    expect(hasSessionCmds(sent)).toHaveLength(0);
  });
});

describe('injectAndAwaitAck busy-baseline is non-ackable', () => {
  const SEP = '___bx-snap-sep___';

  // A prompt whose own text looks busy ("esc to interrupt" / spinner) gives no observable idle→busy
  // transition, so dispatch can't confirm submission by screen-scrape and conservatively times out.
  // This is rare (real image dispatch carries plain file paths → idle baseline) and a loud intervention
  // beats a silent false ack. Every busy-baseline outcome is acked:false + intervention.
  const expectNonAck = async (frames: (enterSent: boolean) => string, settleMs: number): Promise<void> => {
    let enterSent = false;
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('display-message')) {
          return { stdout: `${frames(enterSent)}${SEP}\n0\n`, stderr: '', exitCode: 0 };
        }
        if (cmd.includes('send-keys') && cmd.includes('Enter')) { enterSent = true; return { stdout: '', stderr: '', exitCode: 0 }; }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
    const m = new AgentManager({
      config: CONFIG, agentStore, taskStore, lockManager, eventBus,
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => runner, dispatchAckTimeoutMs: 150, dispatchSettleTimeoutMs: settleMs,
    });
    const t = task();
    await taskStore.set(t);
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: t.id, paneId: '%0', updatedAt: NOW });
    await lockManager.acquire('dev-1');
    const tmux = new TmuxManager(runner);
    const result = await (m as unknown as { injectAndAwaitAck: (a: TmuxManager, b: string, c: string, d: string, e: 'claude-code'|'codex') => Promise<{acked:boolean}> })
      .injectAndAwaitAck(tmux, '%0', 'review:\n  esc to interrupt', 'dev-1', 'claude-code');
    expect(result).toEqual({ acked: false, composerDelivered: false });
    const interventions = events.filter(
      e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'dispatch-ack-timeout',
    );
    expect(interventions.length).toBeGreaterThanOrEqual(1);
  };

  it('composer "clears" after submit but baseline was busy → still non-ackable', async () => {
    await expectNonAck(enterSent => (enterSent ? 'running the task now\n' : 'review:\n  esc to interrupt\n'), 150);
  });

  it('swallowed Enter plus ongoing attach redraw is non-ackable', async () => {
    let n = 0;
    await expectNonAck(() => `review:\n  esc to interrupt\n[Image #1] frame ${n++}\n`, 80);
  });

  it('settled busy baseline plus late attach redraw and swallowed Enter is non-ackable', async () => {
    let post = 0;
    await expectNonAck(enterSent => (enterSent ? `review:\n  esc to interrupt\n[Image #1] frame ${post++}\n` : 'review:\n  esc to interrupt\n'), 150);
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

    it('rejects a non-max_rounds task with 409', async () => {
      await taskStore.set(maxRoundsTask({ status: 'review' }));
      const mergeSpy = vi.spyOn(manager, 'mergePr').mockResolvedValue();
      await expect(manager.markTaskComplete('task-mr')).rejects.toMatchObject({ status: 409 });
      expect(mergeSpy).not.toHaveBeenCalled();
    });

    it('rejects a task without a PR with 400', async () => {
      await taskStore.set(maxRoundsTask({ prNumber: undefined, prUrl: undefined }));
      await expect(manager.markTaskComplete('task-mr')).rejects.toMatchObject({ status: 400 });
    });

    // I4: spec-phase max_rounds escapes via Retry/Cancel only — the endpoint must reject it too,
    // so a direct API call / older client can't merge a spec cap through complete.
    it('rejects a spec-phase task with 409 (no merge)', async () => {
      await taskStore.set(maxRoundsTask({ phase: 'spec' }));
      const mergeSpy = vi.spyOn(manager, 'mergePr').mockResolvedValue();
      await expect(manager.markTaskComplete('task-mr')).rejects.toMatchObject({ status: 409 });
      expect(mergeSpy).not.toHaveBeenCalled();
    });

    // G3: a held (awaiting_human) dev would survive post-merge cleanup (it skips awaiting_human),
    // orphaning a merged task on a bound+locked dev — refuse before merging.
    it('rejects with 409 (no merge) when the dev is awaiting_human (held)', async () => {
      await taskStore.set(maxRoundsTask());
      await agentStore.set({
        id: 'dev-1', projectId: 'proj', status: 'awaiting_human',
        awaitingPhase: 'signal-arm-failed:pr-fixed', taskId: 'task-mr',
        worktreePath: '/tmp/repo/.baxian-worktrees/task-mr_abc', paneId: '%1', updatedAt: NOW,
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
      await agentStore.set({
        id: 'dev-1', projectId: 'proj', status: 'waiting',
        taskId: 'task-mr', worktreePath: '/tmp/repo/.baxian-worktrees/task-mr_abc', paneId: '%1', updatedAt: NOW,
      });
      await agentStore.set({
        id: 'qa-1', projectId: 'proj', status: 'awaiting_human',
        awaitingPhase: 'ack_unknown', taskId: 'task-mr', paneId: '%2', updatedAt: NOW,
      });
      const mergeSpy = vi.spyOn(manager, 'mergePr').mockResolvedValue();
      await expect(manager.markTaskComplete('task-mr')).rejects.toMatchObject({ status: 409 });
      expect(mergeSpy).not.toHaveBeenCalled();
      expect((await taskStore.get('task-mr'))?.status).toBe('max_rounds');
    });

    // A stale qaAgentId whose agent has moved on (bound elsewhere) must NOT block completion.
    it('does not block completion when a held QA is bound to a DIFFERENT task (stale ref)', async () => {
      await taskStore.set(maxRoundsTask({ qaAgentId: 'qa-1' }));
      await agentStore.set({
        id: 'qa-1', projectId: 'proj', status: 'awaiting_human',
        taskId: 'some-other-task', paneId: '%2', updatedAt: NOW,
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
      await agentStore.set({
        id: 'dev-1', projectId: 'proj', status: 'waiting',
        taskId: 'task-mr', worktreePath: '/tmp/repo/.baxian-worktrees/task-mr_abc',
        paneId: '%1', updatedAt: NOW,
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
      await agentStore.set({
        id: 'dev-1', projectId: 'proj', status: 'waiting',
        taskId: 'task-mr', worktreePath: '/tmp/repo/.baxian-worktrees/task-mr_abc',
        paneId: '%1', updatedAt: NOW,
      });
    }

    it('transitions max_rounds → fixing, bumps the round, and dispatches the fix', async () => {
      await taskStore.set(maxRoundsTask());
      await bindReservedDev();
      vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
      vi.spyOn(manager as unknown as { rotateAndSetupPhaseSignal: () => Promise<{ armed: boolean }> },
        'rotateAndSetupPhaseSignal').mockResolvedValue({ armed: true });
      const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);

      const result = await manager.continueDevRound('task-mr');

      expect(result.status).toBe('fixing');
      expect(result.reviewRound).toBe(3);
      expect(continueSpy).toHaveBeenCalledWith('task-mr', 'dev-1', 'fix');
    });

    it('rejects a non-max_rounds task with 409', async () => {
      await taskStore.set(maxRoundsTask({ status: 'fixing' }));
      await bindReservedDev();
      await expect(manager.continueDevRound('task-mr')).rejects.toMatchObject({ status: 409 });
    });

    it('rejects a spec-phase task with 409', async () => {
      await taskStore.set(maxRoundsTask({ phase: 'spec' }));
      await bindReservedDev();
      await expect(manager.continueDevRound('task-mr')).rejects.toMatchObject({ status: 409 });
    });

    it('rejects with 409 when the reserved worktree is gone, pointing at complete/cancel (not Retry)', async () => {
      await taskStore.set(maxRoundsTask());
      await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'task-mr', updatedAt: NOW }); // no worktreePath
      await expect(manager.continueDevRound('task-mr')).rejects.toMatchObject({
        status: 409,
        message: expect.stringMatching(/mark-complete|cancel/),
      });
      expect((await taskStore.get('task-mr'))?.status).toBe('max_rounds');
    });

    it('rolls back to max_rounds and Holds the dev when the pr-fixed watcher fails to arm', async () => {
      await taskStore.set(maxRoundsTask());
      await bindReservedDev();
      vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
      vi.spyOn(manager as unknown as { rotateAndSetupPhaseSignal: () => Promise<{ armed: boolean }> },
        'rotateAndSetupPhaseSignal').mockResolvedValue({ armed: false });
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
      await taskStore.set(maxRoundsTask());
      await bindReservedDev();
      vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
      vi.spyOn(manager as unknown as { rotateAndSetupPhaseSignal: () => Promise<{ armed: boolean }> },
        'rotateAndSetupPhaseSignal').mockResolvedValue({ armed: true });
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
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', status: 'running',
      taskId: 'task-mr', paneId: '%1', updatedAt: NOW,
    });
    await expect(manager.markAgentWaiting('dev-1', 'task-mr')).resolves.toBe(true);
  });

  it('failTasksForAgent fails a max_rounds task when its reserved dev dies', async () => {
    await taskStore.set(maxRoundsTask());
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', status: 'waiting', taskId: 'task-mr', updatedAt: NOW,
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
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', status: 'waiting',
      taskId: 'task-mr', paneId: '%1', updatedAt: NOW,
    });
    vi.spyOn(manager as unknown as { interruptPaneAndWaitReady: () => Promise<boolean> }, 'interruptPaneAndWaitReady')
      .mockResolvedValue(true);
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);

    const cancelled = await manager.cancelTask('task-mr');

    expect(cancelled.status).toBe('cancelled');
    expect(releaseSpy).toHaveBeenCalledWith('dev-1', 'task-mr', 'idle', { allowAwaitingHuman: true });
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
    return new AgentManager({
      config, agentStore, taskStore, lockManager, eventBus,
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => readyRunner(),
    });
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
