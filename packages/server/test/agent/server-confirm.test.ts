import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentManager } from '../../src/agent/manager.js';
import { BranchManager } from '../../src/agent/branch.js';
import { AgentStore } from '../../src/state/agent-store.js';
import { TaskStore } from '../../src/state/task-store.js';
import { ReviewStore } from '../../src/state/review-store.js';
import { LockManager } from '../../src/state/lock.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { initStateDir } from '../../src/state/init.js';
import type { AfterDone, BaxianConfig, MergeStrategy, TaskState } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
import type { ExecResult } from '../../src/agent/runner.js';
import { __setNetExecSleepForTests } from '../../src/agent/net-exec.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-confirm-'));
  await initStateDir(tempDir);
  vi.spyOn(BranchManager.prototype, 'cleanupTaskBranch').mockResolvedValue({ status: 'deleted' });
  vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

function makeConfig(merge: MergeStrategy, afterDone: AfterDone): BaxianConfig {
  return {
    review: { rounds: 10, mode: 'server', afterDone },
    server: DEFAULT_SERVER_CONFIG,
    host: [],
    project: [{
      id: 'proj',
      repo: 'user/repo',
      merge,
      agent: [[
        { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: join(tempDir, 'dev-1') },
        { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local', workdir: join(tempDir, 'qa-1') },
      ]],
    }],
  };
}

interface Fixture {
  manager: AgentManager;
  taskStore: TaskStore;
  agentStore: AgentStore;
  execCalls: string[];
  events: { type: string; data?: Record<string, unknown> }[];
}

async function makeFixture(
  merge: MergeStrategy,
  afterDone: AfterDone,
  execImpl?: (cmd: string) => Partial<ExecResult>,
  reviewStore?: ReviewStore,
): Promise<Fixture> {
  const execCalls: string[] = [];
  const runner = {
    exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
      execCalls.push(cmd);
      return { stdout: '', stderr: '', exitCode: 0, ...(execImpl?.(cmd) ?? {}) };
    }),
    writeFile: vi.fn(async () => undefined),
    execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
  };
  const taskStore = new TaskStore(join(tempDir, 'state', 'tasks'));
  const agentStore = new AgentStore(join(tempDir, 'state', 'agents'));
  const lockManager = new LockManager(join(tempDir, 'locks'));
  const updateAgent = agentStore.update.bind(agentStore);
  vi.spyOn(agentStore, 'update').mockImplementation(async (id, update) => {
    await updateAgent(id, update);
    const state = await agentStore.get(id);
    if (!state?.taskId || await lockManager.isLocked(id)) return;
    const token = await lockManager.acquire(id, state.taskId);
    if (!token) return;
    await updateAgent(id, latest => latest?.taskId === state.taskId
      ? { ...latest, lockToken: token, updatedAt: new Date().toISOString() }
      : latest);
  });
  const eventBus = new EventBus(new EventLog(join(tempDir, 'events')));
  const events: { type: string; data?: Record<string, unknown> }[] = [];
  eventBus.on('*', (e) => { events.push({ type: e.type, data: e.data }); });
  const manager = new AgentManager({
    config: makeConfig(merge, afterDone),
    agentStore,
    taskStore,
    lockManager,
    eventBus,
    runnerFactory: () => runner,
    platformRunner: runner,
    ...(reviewStore ? { reviewStore } : {}),
  });
  Object.assign(manager, { compactIdlePollMs: 5, compactIdleWaitMs: 200 });
  return { manager, taskStore, agentStore, execCalls, events };
}

function claimedSessionExec(cmd: string): Partial<ExecResult> {
  const agentId = cmd.match(/=([^':\s]+)/)?.[1];
  if (agentId && cmd.includes('tmux show-option') && cmd.includes('@baxian-agent-id')) {
    return { stdout: `${agentId}\n` };
  }
  if (agentId && cmd.includes('tmux list-panes')) {
    return { stdout: `${agentId === 'qa-1' ? '%2 codex' : '%1 claude'}\n` };
  }
  return {};
}

function readyPaneExec(cmd: string): Partial<ExecResult> {
  const runtimeFact = claimedSessionExec(cmd);
  if (runtimeFact.stdout !== undefined) return runtimeFact;
  if (cmd.includes('display-message') && cmd.includes('pane_current_command')) {
    return { stdout: 'claude\n' };
  }
  if (cmd.includes('capture-pane')) {
    return { stdout: '⏵⏵ bypass permissions on /tmp/repo\n\n>' };
  }
  return {};
}

function bindAgent(
  store: AgentStore,
  id: string,
  fields: Record<string, unknown>,
): Promise<unknown> {
  return store.update(id, () => ({
    id, projectId: 'proj', updatedAt: new Date().toISOString(), ...fields,
  }));
}

function bindToTask(agentStore: AgentStore, id: 'dev-1' | 'qa-1', now: string): Promise<unknown> {
  const paneId = id === 'dev-1' ? '%1' : '%2';
  return agentStore.update(id, () => ({
    id,
    projectId: 'proj',
    taskId: 'task-1',
    paneId,
    workdir: join(tempDir, id),
    updatedAt: now,
  }));
}

function stubMethod<T>(manager: AgentManager, name: string, impl: T): void {
  (manager as unknown as Record<string, T>)[name] = impl;
}

function recordAfterDone(manager: AgentManager, taskStore: TaskStore): string[] {
  const dispatched: string[] = [];
  stubMethod(manager, 'dispatchServerAfterDone', async (id: string, kind: string) => {
    dispatched.push(`${id}:${kind}`);
    return taskStore.get(id);
  });
  return dispatched;
}

function taskFixture(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'task-1',
    projectId: 'proj',
    title: 'T',
    description: 'D',
    preferredAgentId: 'dev-1',
    agentId: 'dev-1',
    devAgentId: 'dev-1',
    qaAgentId: 'qa-1',
    phase: 'code',
    reviewRound: 2,
    reviewMode: 'server',
    branch: 'bx/task-1',
    branchCreatedByBaxian: true,
    status: 'ready',
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    ...overrides,
  };
}

function approvedPrMarkerFixture(overrides: Partial<TaskState> = {}): TaskState {
  return taskFixture({
    status: 'approved', afterDone: 'pr', prNumber: 31,
    publishDispatchedAt: '2026-06-10T01:00:00.000Z',
    ...overrides,
  });
}

function hasRemotePrClose(execCalls: string[]): boolean {
  return execCalls.some(c => c.includes('gh pr close'));
}

function hasCleanupSkippedEvent(events: { type: string; data?: Record<string, unknown> }[]): boolean {
  return events.some(e => e.type === 'human.intervention'
    && e.data?.phase === 'cancel-published-artifact-cleanup-skipped');
}

describe('confirmHumanGate via markTaskComplete', () => {
  it('ready + afterDone:null → done', async () => {
    const { manager, taskStore } = await makeFixture(null, null);
    await taskStore.set(taskFixture());
    const result = await manager.markTaskComplete('task-1');
    expect(result.status).toBe('done');
  });

  it('ready + afterDone:branch + merge:null → done (no git merge)', async () => {
    const { manager, taskStore, execCalls } = await makeFixture(null, 'branch');
    await taskStore.set(taskFixture());
    const result = await manager.markTaskComplete('task-1');
    expect(result.status).toBe('done');
    expect(execCalls.some(c => c.includes('merge --ff-only'))).toBe(false);
  });

  it('ready + afterDone:branch + merge:auto → ref-to-ref ff push → merged', async () => {
    const { manager, taskStore, agentStore, execCalls } = await makeFixture('auto', 'branch', cmd =>
      cmd.includes('symbolic-ref') ? { stdout: 'origin/main\n' } : cmd.includes('rev-parse') ? { stdout: 'head123\n' } : {});
    await bindAgent(agentStore, 'dev-1', { workdir: '/repo/dev' });
    await taskStore.set(taskFixture({ latestHeadSha: 'head123' }));
    const result = await manager.markTaskComplete('task-1');
    expect(result.status).toBe('merged');
    expect(execCalls.some(c => c.includes(`git push origin 'origin/bx/task-1':'main'`))).toBe(true);
    expect(execCalls.some(c => c.includes('git checkout') || c.includes('merge --ff-only'))).toBe(false);
    expect(execCalls.some(c => c.includes('git push origin --delete'))).toBe(false);
  });

  it('ready + afterDone:branch + merge:auto + non-ff failure → stays at the gate for retry', async () => {
    const { manager, taskStore, agentStore } = await makeFixture('auto', 'branch', cmd => {
      if (cmd.includes('symbolic-ref')) return { stdout: 'origin/main\n' };
      if (cmd.includes(`:'main'`)) return { exitCode: 1, stderr: 'rejected: non-fast-forward' };
      return {};
    });
    await bindAgent(agentStore, 'dev-1', { workdir: '/repo/dev' });
    await taskStore.set(taskFixture());
    await expect(manager.markTaskComplete('task-1')).rejects.toThrow(/Merge failed/);
    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('ready');
  });

  it('ready + afterDone:pr + merge:auto → gh pr merge → merged via pr.merged chain', async () => {
    const { manager, taskStore, execCalls } = await makeFixture('auto', 'pr');
    await taskStore.set(taskFixture({ prNumber: 7, latestHeadSha: 'head123' }));
    await manager.markTaskComplete('task-1');
    expect(execCalls.some(c => c.includes('gh pr merge 7') && c.includes('--squash') && c.includes("--match-head-commit 'head123'"))).toBe(true);
  });

  it('merge-ready (github mode) + merge:null → done', async () => {
    const { manager, taskStore } = await makeFixture(null, null);
    await taskStore.set(taskFixture({ status: 'merge-ready', reviewMode: 'github', prNumber: 9 }));
    const result = await manager.markTaskComplete('task-1');
    expect(result.status).toBe('done');
  });

  it('merge-ready (github mode) + merge:auto → gh pr merge', async () => {
    const { manager, taskStore, execCalls } = await makeFixture('auto', null);
    await taskStore.set(taskFixture({ status: 'merge-ready', reviewMode: 'github', prNumber: 9 }));
    await taskStore.set(taskFixture({ status: 'merge-ready', reviewMode: 'github', prNumber: 9, latestHeadSha: 'h9' }));
    await manager.markTaskComplete('task-1');
    expect(execCalls.some(c => c.includes('gh pr merge 9'))).toBe(true);
  });

  it('merge:auto never asks GitHub to delete a user-defined branch', async () => {
    const { manager, taskStore, execCalls } = await makeFixture('auto', 'pr');
    await taskStore.set(taskFixture({
      branch: 'feature/user-owned',
      branchCreatedByBaxian: false,
      prNumber: 7,
      latestHeadSha: 'head123',
    }));

    await manager.markTaskComplete('task-1');

    const merge = execCalls.find(c => c.includes('gh pr merge 7'));
    expect(merge).toBeDefined();
    expect(merge).not.toContain('--delete-branch');
  });

  it('non-gate status keeps legacy behavior (409 for in_progress)', async () => {
    const { manager, taskStore } = await makeFixture(null, null);
    await taskStore.set(taskFixture({ status: 'in_progress' }));
    await expect(manager.markTaskComplete('task-1')).rejects.toThrow(/not awaiting confirmation/);
  });
});

describe('server-mode max_rounds escape', () => {
  it('complete + afterDone:null → done with agents released', async () => {
    const { manager, taskStore } = await makeFixture(null, null);
    await taskStore.set(taskFixture({ status: 'max_rounds', reviewRound: 10 }));
    const result = await manager.markTaskComplete('task-1');
    expect(result.status).toBe('done');
  });

  it('complete + afterDone:branch → approved + publish dispatched', async () => {
    const { manager, taskStore } = await makeFixture(null, 'branch');
    const dispatched = recordAfterDone(manager, taskStore);
    await taskStore.set(taskFixture({ status: 'max_rounds', reviewRound: 10 }));
    await manager.markTaskComplete('task-1');
    expect(dispatched).toEqual(['task-1:branch']);
    expect((await taskStore.get('task-1'))?.status).toBe('approved');
  });

  it('approved (server) retries the publish dispatch', async () => {
    const { manager, taskStore } = await makeFixture(null, 'pr');
    const dispatched = recordAfterDone(manager, taskStore);
    await taskStore.set(taskFixture({ status: 'approved' }));
    await manager.markTaskComplete('task-1');
    expect(dispatched).toEqual(['task-1:pr']);
  });
});

describe('terminal confirm clears agent context before release', () => {
  async function boundAgentsFixture(
    merge: MergeStrategy,
    afterDone: AfterDone,
    taskOverrides: Partial<TaskState> = {},
    execImpl?: (cmd: string) => Partial<ExecResult>,
  ): Promise<Fixture> {
    const fx = await makeFixture(merge, afterDone, cmd => ({
      ...claimedSessionExec(cmd),
      ...(execImpl?.(cmd) ?? {}),
    }));
    const now = new Date().toISOString();
    await bindToTask(fx.agentStore, 'dev-1', now);
    await bindToTask(fx.agentStore, 'qa-1', now);
    await fx.taskStore.set(taskFixture(taskOverrides));
    vi.spyOn(
      fx.manager as never as { waitForReplPromptReady: (...a: unknown[]) => Promise<void> },
      'waitForReplPromptReady',
    ).mockResolvedValue(undefined);
    return fx;
  }

  function clearSentTo(execCalls: string[], paneId: string): boolean {
    return execCalls.some(c =>
      c.includes('send-keys -l') && c.includes(`'${paneId}'`) && c.includes(`'/clear'`));
  }

  async function expectClearedAndReleased(fx: Fixture): Promise<void> {
    await vi.waitFor(async () => {
      expect(clearSentTo(fx.execCalls, '%1')).toBe(true);
      expect(clearSentTo(fx.execCalls, '%2')).toBe(true);
      expect((await fx.agentStore.get('dev-1'))?.taskId).toBeUndefined();
      expect((await fx.agentStore.get('qa-1'))?.taskId).toBeUndefined();
    }, { timeout: 5000 });
  }

  it('ready confirm sends /clear to both dev and qa panes, then releases the bindings', async () => {
    const fx = await boundAgentsFixture(null, null);
    const result = await fx.manager.markTaskComplete('task-1');
    expect(result.status).toBe('done');
    await expectClearedAndReleased(fx);
  });

  it('branch auto-merge confirm sends /clear to both panes after the merged transition', async () => {
    const fx = await boundAgentsFixture('auto', 'branch', { latestHeadSha: 'head123' }, cmd =>
      cmd.includes('symbolic-ref') ? { stdout: 'origin/main\n' }
        : cmd.includes('rev-parse') ? { stdout: 'head123\n' } : {});
    await bindAgent(fx.agentStore, 'dev-1', { taskId: 'task-1', paneId: '%1', workdir: '/repo/dev' });
    const result = await fx.manager.markTaskComplete('task-1');
    expect(result.status).toBe('merged');
    await expectClearedAndReleased(fx);
  });

  it('max_rounds escape with afterDone:null sends /clear to both panes, then releases', async () => {
    const fx = await boundAgentsFixture(null, null, { status: 'max_rounds', reviewRound: 10 });
    const result = await fx.manager.markTaskComplete('task-1');
    expect(result.status).toBe('done');
    await expectClearedAndReleased(fx);
  });

  it('an awaiting_human agent is released directly without /clear', async () => {
    const fx = await boundAgentsFixture(null, null);
    await bindAgent(fx.agentStore, 'dev-1', {
      taskId: 'task-1', paneId: '%1',
      status: 'awaiting_human', awaitingPhase: 'greeting-failed',
      awaitingReason: 'x', awaitingSince: 'now',
    });
    await fx.manager.markTaskComplete('task-1');
    await vi.waitFor(async () => {
      expect((await fx.agentStore.get('dev-1'))?.taskId).toBeUndefined();
      expect((await fx.agentStore.get('qa-1'))?.taskId).toBeUndefined();
    }, { timeout: 5000 });
    expect(clearSentTo(fx.execCalls, '%1')).toBe(false);
    expect(clearSentTo(fx.execCalls, '%2')).toBe(true);
  });

  it('an agent without a live pane is released directly without /clear', async () => {
    const fx = await boundAgentsFixture(null, null);
    await bindAgent(fx.agentStore, 'dev-1', { taskId: 'task-1' });
    await fx.manager.markTaskComplete('task-1');
    await vi.waitFor(async () => {
      expect((await fx.agentStore.get('dev-1'))?.taskId).toBeUndefined();
      expect((await fx.agentStore.get('qa-1'))?.taskId).toBeUndefined();
    }, { timeout: 5000 });
    expect(clearSentTo(fx.execCalls, '%1')).toBe(false);
  });
});

describe('snapshot + resume semantics', () => {
  it('ready confirm uses task.afterDone over hot config', async () => {
    const { manager, taskStore } = await makeFixture(null, 'pr');
    await taskStore.set(taskFixture({ afterDone: 'branch' }));
    const result = await manager.markTaskComplete('task-1');
    expect(result.status).toBe('done');
  });

  it('resumeAgent redispatches the code prompt for code-dispatch-failed', async () => {
    const reviewStore = new ReviewStore();
    const { manager, taskStore, agentStore: agents } = await makeFixture(null, null, undefined, reviewStore);
    const documents = [{ relPath: '.baxian/spec.md', content: '# Approved spec' }];
    await reviewStore.putRound('task-1', 'spec', {
      round: 1,
      phase: 'spec',
      content: '# Approved spec',
      documents,
      startedAt: '2026-06-10T00:00:00.000Z',
    });
    await taskStore.set(taskFixture({
      status: 'in_progress', phase: 'code', specReviewRound: 1, signalToken: 'code-token',
    }));
    await bindAgent(agents, 'dev-1', {
      taskId: 'task-1', paneId: '%1',
      status: 'awaiting_human', awaitingPhase: 'code-dispatch-failed',
      awaitingReason: 'x', awaitingSince: 'now',
    });
    const continued: string[] = [];
    vi.spyOn(manager, 'continueSession').mockImplementation(async (taskId, agentId, phase, opts) => {
      continued.push(`${taskId}:${agentId}:${phase}:${opts.specDocuments?.[0]?.content}`);
      return true;
    });
    const result = await manager.resumeAgent('dev-1');
    expect(result.resumed).toBe(true);
    expect(continued).toEqual(['task-1:dev-1:code:# Approved spec']);
    const state = await agents.get('dev-1');
    expect(state?.status).toBeUndefined();
    expect(state?.taskId).toBe('task-1');
  });
});

describe('cancel closes a published PR but preserves remote branches', () => {
  it('cancel of a published pr gate closes the PR remotely', async () => {
    const { manager, taskStore, execCalls } = await makeFixture('auto', 'pr');
    await taskStore.set(taskFixture({ status: 'ready', afterDone: 'pr', prNumber: 12, latestHeadSha: 'h1' }));
    const result = await manager.cancelTask('task-1');
    expect(result.status).toBe('cancelled');
    expect(execCalls.some(c => c.includes('gh pr close 12'))).toBe(true);
  });

  it('cancel of a published branch gate keeps the remote branch', async () => {
    const { manager, taskStore, agentStore: agents, execCalls } = await makeFixture('auto', 'branch');
    await bindAgent(agents, 'dev-1', { taskId: 'task-1', workdir: '/repo/dev' });
    await taskStore.set(taskFixture({ status: 'ready', afterDone: 'branch', latestHeadSha: 'h1' }));
    await manager.cancelTask('task-1');
    expect(execCalls.some(c => c.includes('git push origin --delete'))).toBe(false);
    expect(execCalls.some(c => c.includes('git/refs/heads/'))).toBe(false);
  });
});

describe('cancel retracts a dispatched-but-unconfirmed publish (approved + marker)', () => {
  it('approved + publishDispatchedAt + prNumber → interrupts the dev FIRST, then closes the PR remotely', async () => {
    const { manager, taskStore, agentStore, execCalls } = await makeFixture('auto', 'pr', readyPaneExec);
    await bindAgent(agentStore, 'dev-1', { taskId: 'task-1', paneId: '%5' });
    await taskStore.set(approvedPrMarkerFixture());
    const result = await manager.cancelTask('task-1');
    expect(result.status).toBe('cancelled');
    const interruptAt = execCalls.findIndex(c => c.includes('send-keys') && c.includes("'Escape'"));
    const closeAt = execCalls.findIndex(c => c.includes('gh pr close 31'));
    expect(interruptAt).toBeGreaterThanOrEqual(0);
    expect(closeAt).toBeGreaterThan(interruptAt);
  });

  it('approved + publishDispatchedAt without prNumber interrupts the dev but preserves the remote branch', async () => {
    const { manager, taskStore, agentStore, execCalls } = await makeFixture('auto', 'branch', readyPaneExec);
    await bindAgent(agentStore, 'dev-1', { taskId: 'task-1', workdir: '/repo/dev', paneId: '%5' });
    await taskStore.set(taskFixture({
      status: 'approved', afterDone: 'branch',
      publishDispatchedAt: '2026-06-10T01:00:00.000Z',
    }));
    await manager.cancelTask('task-1');
    const interruptAt = execCalls.findIndex(c => c.includes('send-keys') && c.includes("'Escape'"));
    expect(interruptAt).toBeGreaterThanOrEqual(0);
    expect(execCalls.some(c => c.includes('git push origin --delete'))).toBe(false);
  });

  it.each([
    {
      label: 'a FAILED dev interrupt → skips remote retirement and intervenes (publish may still be running)',
      seed: (agentStore: AgentStore) => bindAgent(agentStore, 'dev-1', { taskId: 'task-1', workdir: '/repo/dev' }),
      task: {} as Partial<TaskState>,
      checkCancelled: true,
      devAwaiting: true,
    },
    {
      label: 'the dev config hot-removed → skips gh pr close (pane outlives the config)',
      seed: (agentStore: AgentStore) => bindAgent(agentStore, 'ghost', { taskId: 'task-1', paneId: '%5' }),
      task: { agentId: 'ghost', devAgentId: 'ghost' } as Partial<TaskState>,
      checkCancelled: true,
      devAwaiting: false,
    },
    {
      label: 'NO agentStore record for the dev → skips remote retirement (stop unconfirmed)',
      seed: undefined,
      task: {} as Partial<TaskState>,
      checkCancelled: false,
      devAwaiting: false,
    },
    {
      label: 'the dev rebound to another task → skips remote retirement (stop unconfirmed)',
      seed: (agentStore: AgentStore) => bindAgent(agentStore, 'dev-1', { taskId: 'task-OTHER', paneId: '%5' }),
      task: {} as Partial<TaskState>,
      checkCancelled: false,
      devAwaiting: false,
    },
  ])('approved + marker with $label', async ({ seed, task, checkCancelled, devAwaiting }) => {
    const { manager, taskStore, agentStore, execCalls, events } = await makeFixture('auto', 'pr');
    if (seed) await seed(agentStore);
    await taskStore.set(approvedPrMarkerFixture(task));
    const result = await manager.cancelTask('task-1');
    if (checkCancelled) expect(result.status).toBe('cancelled');
    expect(hasRemotePrClose(execCalls)).toBe(false);
    expect(hasCleanupSkippedEvent(events)).toBe(true);
    if (devAwaiting) expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
  });

  it('ready with a FAILED dev interrupt still retires remotely (publish already finished)', async () => {
    const { manager, taskStore, agentStore, execCalls, events } = await makeFixture('auto', 'pr');
    await bindAgent(agentStore, 'dev-1', { taskId: 'task-1', workdir: '/repo/dev' });
    await taskStore.set(taskFixture({ status: 'ready', afterDone: 'pr', prNumber: 12, latestHeadSha: 'h1' }));
    await manager.cancelTask('task-1');
    expect(execCalls.some(c => c.includes('gh pr close 12'))).toBe(true);
    expect(hasCleanupSkippedEvent(events)).toBe(false);
  });

  it('approved WITHOUT the delivery marker → nothing was published, no remote retirement', async () => {
    const { manager, taskStore, execCalls } = await makeFixture('auto', 'pr');
    await taskStore.set(taskFixture({ status: 'approved', afterDone: 'pr' }));
    await manager.cancelTask('task-1');
    expect(hasRemotePrClose(execCalls)).toBe(false);
  });

  it('rejects a hand-edited null delivery marker at the store boundary', async () => {
    const { taskStore } = await makeFixture('auto', 'pr');
    await expect(taskStore.set(
      approvedPrMarkerFixture({ publishDispatchedAt: null as unknown as string }),
    )).rejects.toThrow(/publishDispatchedAt/);
  });
});

describe('merge-ready cancel, Call review mode guard, and confirm head guard', () => {
  it('merge-ready cancel closes the published PR', async () => {
    const { manager, taskStore, execCalls } = await makeFixture('auto', null);
    await taskStore.set(taskFixture({ status: 'merge-ready', reviewMode: 'github', prNumber: 21 }));
    await manager.cancelTask('task-1');
    expect(execCalls.some(c => c.includes('gh pr close 21'))).toBe(true);
  });

  it('Call review refuses server-mode tasks parked at a gate (only in_progress/review/fixing dispatch)', async () => {
    const { manager, taskStore } = await makeFixture(null, 'pr');
    await taskStore.set(taskFixture({ status: 'ready', prNumber: 5 }));
    await expect(manager.dispatchReviewToQa('task-1')).rejects.toThrow(/manual server-side review requires/);
  });

  it.each(['review', 'fixing', 'approved'] as const)(
    'cancelling a github task at %s closes the open PR and preserves the remote branch',
    async (status) => {
      const { manager, taskStore, execCalls } = await makeFixture(null, 'pr');
      await taskStore.set(taskFixture({ status, reviewMode: 'github', prNumber: 33 }));

      const result = await manager.cancelTask('task-1');

      expect(result.status).toBe('cancelled');
      expect(execCalls.some(c => c.includes('gh pr close 33'))).toBe(true);
      expect(execCalls.some(c => c.includes('git push origin --delete'))).toBe(false);
      expect(execCalls.some(c => c.includes('--delete-branch'))).toBe(false);
    },
  );

  it('a terminal re-cancel cleans stale bindings but never touches the remote PR', async () => {
    const { manager, taskStore, agentStore, execCalls } = await makeFixture(null, 'pr', readyPaneExec);
    await taskStore.set(taskFixture({ status: 'cancelled', reviewMode: 'github', prNumber: 44 }));
    await bindToTask(agentStore, 'dev-1', new Date().toISOString());

    const result = await manager.cancelTask('task-1');

    expect(result.status).toBe('cancelled');
    expect(execCalls.some(c => c.includes('gh pr close'))).toBe(false);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('merge-ready confirm without recorded head → 409', async () => {
    const { manager, taskStore } = await makeFixture('auto', null);
    await taskStore.set(taskFixture({ status: 'merge-ready', reviewMode: 'github', prNumber: 9, latestHeadSha: undefined }));
    await expect(manager.markTaskComplete('task-1')).rejects.toThrow(/no approved head/);
  });
});

describe('publish delivery marker', () => {
  it('approved retry with publishDispatchedAt set → 409 even without a live watcher', async () => {
    const { manager, taskStore } = await makeFixture(null, 'pr');
    await taskStore.set(taskFixture({
      status: 'approved', afterDone: 'pr',
      publishDispatchedAt: '2026-06-10T01:00:00.000Z',
    }));
    await expect(manager.markTaskComplete('task-1')).rejects.toThrow(/awaiting code-ready/);
  });

  it('approved retry without the marker dispatches the publish', async () => {
    const { manager, taskStore } = await makeFixture(null, 'pr');
    const dispatched = recordAfterDone(manager, taskStore);
    await taskStore.set(taskFixture({ status: 'approved', afterDone: 'pr' }));
    await manager.markTaskComplete('task-1');
    expect(dispatched).toEqual(['task-1:pr']);
  });
});

describe('pre-paste marker ordering', () => {
  it('failed publish dispatch clears the delivery marker for retry', async () => {
    const { manager, taskStore, agentStore: agents } = await makeFixture(null, 'pr');
    await bindAgent(agents, 'dev-1', { taskId: 'task-1', paneId: '%1' });
    await taskStore.set(taskFixture({ status: 'approved', afterDone: 'pr', signalToken: 'origTok123' }));
    stubMethod(manager, 'acquireAgentForTask', async () => true);
    stubMethod(manager, 'continueSession', async () => false);
    const result = await manager.dispatchServerAfterDone('task-1', 'pr');
    expect(result).toBeNull();
    const fresh = await taskStore.get('task-1');
    expect(fresh?.publishDispatchedAt).toBeUndefined();
    expect(fresh?.signalToken).toBe('origTok123');
  });
});

describe('Codex: dispatch failure recovery + continue/complete race', () => {
  const NOW = new Date().toISOString();
  const STORED_FINDINGS = {
    round: 10,
    verdict: 'request-changes' as const,
    findings: [{ id: 'f-1', severity: 'major' as const, message: 'bug', file: 'a.ts', line: 1 }],
  };

  it('transitionToCodePhase stays at the spec gate when the dev cannot be acquired', async () => {
    const reviewStore = new ReviewStore();
    const { manager, taskStore, events } = await makeFixture(null, 'pr', undefined, reviewStore);
    await reviewStore.putRound('task-1', 'spec', {
      round: 1,
      phase: 'spec',
      content: '# Spec',
      documents: [{ relPath: '.baxian/spec.md', content: '# Spec' }],
      startedAt: NOW,
    });
    await taskStore.set(taskFixture({
      status: 'spec-ready', phase: 'spec', qaAgentId: undefined,
      specReviewRound: 1, signalToken: 'tok',
    }));
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(false);

    const result = await manager.transitionToCodePhase('task-1');

    expect(result).toBeNull();
    expect((await taskStore.get('task-1'))?.status).toBe('spec-ready');
    expect(events.some(event => event.data?.phase === 'code-dev-acquire-failed')).toBe(true);
  });

  it('dispatchServerFixToDev resume failure re-arms the QA reviewed watcher after rollback', async () => {
    const { manager, taskStore, agentStore } = await makeFixture(null, 'pr');
    await taskStore.set(taskFixture({ status: 'review', signalToken: 'tok' }));
    await bindToTask(agentStore, 'qa-1', NOW);
    await bindToTask(agentStore, 'dev-1', NOW);
    vi.spyOn(manager, 'continueSession').mockResolvedValue(false);
    vi.spyOn(
      manager as unknown as { waitForReplPromptReady: (...args: unknown[]) => Promise<void> },
      'waitForReplPromptReady',
    ).mockResolvedValue(undefined);
    const rearmSpy = vi.spyOn(manager, 'setupPhaseSignal').mockResolvedValue(true);

    const result = await manager.dispatchServerFixToDev('task-1', '[]');

    expect(result).toBeNull();
    expect(rearmSpy).toHaveBeenCalledWith('task-1', 'qa-1', 'code-reviewed', { skipSnapshot: true });
    expect((await taskStore.get('task-1'))?.status).toBe('review');
  });

  it('dispatchServerFixToDev keeps the QA bound when dev acquire fails', async () => {
    const { manager, taskStore, agentStore } = await makeFixture(null, 'pr');
    await taskStore.set(taskFixture({ status: 'review', signalToken: 'tok' }));
    await bindToTask(agentStore, 'qa-1', NOW);
    await bindToTask(agentStore, 'dev-1', NOW);
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(false);
    const rearmSpy = vi.spyOn(manager, 'setupPhaseSignal').mockResolvedValue(true);

    const result = await manager.dispatchServerFixToDev('task-1', '[]');

    expect(result).toBeNull();
    expect((await agentStore.get('qa-1'))?.taskId).toBe('task-1');
    expect(rearmSpy).toHaveBeenCalledWith('task-1', 'qa-1', 'code-reviewed', { skipSnapshot: true });
  });

  it('dispatchServerFixToDev keeps the dev binding when the fixing transition is refused', async () => {
    const { manager, taskStore, agentStore } = await makeFixture(null, 'pr');
    await taskStore.set(taskFixture({ status: 'approved', qaAgentId: undefined, signalToken: 'tok' }));
    await bindToTask(agentStore, 'dev-1', NOW);

    const result = await manager.dispatchServerFixToDev('task-1', '[]');

    expect(result).toBeNull();
    expect((await agentStore.get('dev-1'))?.taskId).toBe('task-1');
  });

  it('continueDevRound re-checks the complete gate under the lock after lock-free entry checks', async () => {
    const reviewStore = new ReviewStore();
    const { manager, taskStore } = await makeFixture(null, 'pr', undefined, reviewStore);
    await reviewStore.putRound('task-1', 'code', {
      round: 10, phase: 'code', content: 'd', startedAt: NOW, findings: STORED_FINDINGS,
    });
    await taskStore.set(taskFixture({ status: 'max_rounds', reviewRound: 10 }));
    const dispatchSpy = vi.spyOn(manager, 'dispatchServerFixToDev');
    const origGetRound = reviewStore.getRound.bind(reviewStore);
    vi.spyOn(reviewStore, 'getRound').mockImplementation(async (taskId, phase, round) => {
      const r = await origGetRound(taskId, phase, round);
      (manager as unknown as { markCompleteInFlight: Set<string> }).markCompleteInFlight.add('task-1');
      await taskStore.set(taskFixture({ status: 'approved', reviewRound: 10 }));
      return r;
    });

    await expect(manager.continueDevRound('task-1')).rejects.toMatchObject({ status: 409 });
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.maxRoundsContinues ?? 0).toBe(0);
  });

  it('continueDevRound rolls back its grant by decrement, preserving a concurrent grant', async () => {
    const reviewStore = new ReviewStore();
    const { manager, taskStore } = await makeFixture(null, 'pr', undefined, reviewStore);
    await reviewStore.putRound('task-1', 'code', {
      round: 10, phase: 'code', content: 'd', startedAt: NOW, findings: STORED_FINDINGS,
    });
    await taskStore.set(taskFixture({ status: 'max_rounds', reviewRound: 10 }));
    vi.spyOn(manager, 'dispatchServerFixToDev').mockImplementation(async () => {
      const t = await taskStore.get('task-1');
      await taskStore.set({ ...t!, maxRoundsContinues: (t!.maxRoundsContinues ?? 0) + 1 });
      return null;
    });

    await expect(manager.continueDevRound('task-1')).rejects.toMatchObject({ status: 500 });
    expect((await taskStore.get('task-1'))?.maxRoundsContinues).toBe(1);
  });
});

describe('ffMergeBranch failure branches (via confirm gate)', () => {
  async function ffFixture(
    execImpl: (cmd: string) => Partial<ExecResult>,
    taskOverrides: Partial<TaskState> = {},
  ): Promise<Fixture> {
    const f = await makeFixture('auto', 'branch', execImpl);
    await bindAgent(f.agentStore, 'dev-1', { workdir: '/repo/dev' });
    await f.taskStore.set(taskFixture({ latestHeadSha: 'head123', ...taskOverrides }));
    return f;
  }

  it('fails the confirm when the default branch cannot be resolved', async () => {
    const f = await ffFixture(cmd =>
      cmd.includes('symbolic-ref') ? { exitCode: 1, stderr: 'no origin/HEAD' } : {});
    await expect(f.manager.markTaskComplete('task-1')).rejects.toThrow(/cannot resolve default branch/);
    expect((await f.taskStore.get('task-1'))?.status).toBe('ready');
    expect(f.events.some(e => e.type === 'human.intervention'
      && e.data?.phase === 'confirm-merge-failed')).toBe(true);
  });

  it('fails the confirm when git fetch fails', async () => {
    const f = await ffFixture(cmd => {
      if (cmd.includes('symbolic-ref')) return { stdout: 'origin/main\n' };
      if (cmd.includes('git fetch origin')) return { exitCode: 1, stderr: 'network down' };
      return {};
    });
    await expect(f.manager.markTaskComplete('task-1')).rejects.toThrow(/git fetch/);
    expect((await f.taskStore.get('task-1'))?.status).toBe('ready');
  });

  it('refuses to merge when the remote head drifted past the reviewed head', async () => {
    const f = await ffFixture(cmd => {
      if (cmd.includes('symbolic-ref')) return { stdout: 'origin/main\n' };
      if (cmd.includes('rev-parse')) return { stdout: 'driftedsha\n' };
      return {};
    });
    await expect(f.manager.markTaskComplete('task-1')).rejects.toThrow(/refusing to merge un-reviewed commits/);
    expect((await f.taskStore.get('task-1'))?.status).toBe('ready');
  });

  it('fails the confirm when the ff push is rejected', async () => {
    const f = await ffFixture(cmd => {
      if (cmd.includes('symbolic-ref')) return { stdout: 'origin/main\n' };
      if (cmd.includes('rev-parse')) return { stdout: 'head123\n' };
      if (cmd.includes(`:'main'`)) return { exitCode: 1, stderr: 'remote rejected' };
      return {};
    });
    await expect(f.manager.markTaskComplete('task-1')).rejects.toThrow(/push.*failed|Merge failed/);
    expect((await f.taskStore.get('task-1'))?.status).toBe('ready');
  });

  it('never attempts a remote branch delete after a successful ff merge', async () => {
    const f = await ffFixture(cmd => {
      if (cmd.includes('symbolic-ref')) return { stdout: 'origin/main\n' };
      if (cmd.includes('rev-parse')) return { stdout: 'head123\n' };
      if (cmd.includes('--delete')) return { exitCode: 1, stderr: 'protected branch' };
      return {};
    });
    const result = await f.manager.markTaskComplete('task-1');
    expect(result.status).toBe('merged');
    expect(f.execCalls.some(c => c.includes('--delete'))).toBe(false);
  });

  it('does not probe remote deletion even when a remote-delete failure response is configured', async () => {
    const f = await ffFixture(cmd => {
      if (cmd.includes('symbolic-ref')) return { stdout: 'origin/main\n' };
      if (cmd.includes('rev-parse')) return { stdout: 'head123\n' };
      if (cmd.includes('--delete')) return { exitCode: 1, stderr: 'error: unable to delete: remote ref does not exist' };
      return {};
    });
    const result = await f.manager.markTaskComplete('task-1');
    expect(result.status).toBe('merged');
    expect(f.execCalls.some(c => c.includes('--delete'))).toBe(false);
  });

  it('never deletes a user-defined remote branch after a successful ff merge', async () => {
    const f = await ffFixture(cmd => {
      if (cmd.includes('symbolic-ref')) return { stdout: 'origin/main\n' };
      if (cmd.includes('rev-parse')) return { stdout: 'head123\n' };
      return {};
    }, { branch: 'feature/user-owned', branchCreatedByBaxian: false });

    const result = await f.manager.markTaskComplete('task-1');

    expect(result.status).toBe('merged');
    expect(f.execCalls.some(c => c.includes('git push origin --delete'))).toBe(false);
  });
});

describe('cancel PR closure and remote-branch preservation', () => {
  beforeEach(() => {
    __setNetExecSleepForTests(async () => {});
  });
  afterEach(() => {
    __setNetExecSleepForTests();
  });

  it('closes the PR without deleting its remote branch', async () => {
    const { manager, taskStore, execCalls, events } = await makeFixture('auto', 'pr', () => ({}));
    await taskStore.set(taskFixture({ status: 'ready', afterDone: 'pr', prNumber: 12, latestHeadSha: 'h1' }));

    const result = await manager.cancelTask('task-1');

    expect(result.status).toBe('cancelled');
    const closeCmd = execCalls.find(c => c.includes('gh pr close'));
    expect(closeCmd).toBeDefined();
    expect(closeCmd).not.toContain('--delete-branch');
    expect(execCalls.some(c => c.includes('git/refs/heads/'))).toBe(false);
    expect(execCalls.some(c => c.includes('git push origin --delete'))).toBe(false);
    expect(events.some(e => e.type === 'human.intervention'
      && e.data?.phase === 'cancel-published-artifact-cleanup-failed')).toBe(false);
  });

  it('closes a cancelled PR but preserves its user-defined branch', async () => {
    const { manager, taskStore, execCalls } = await makeFixture('auto', 'pr', () => ({}));
    await taskStore.set(taskFixture({
      status: 'ready',
      afterDone: 'pr',
      branch: 'feature/user-owned',
      branchCreatedByBaxian: false,
      prNumber: 12,
      latestHeadSha: 'h1',
    }));

    await manager.cancelTask('task-1');

    expect(execCalls.some(c => c.includes('gh pr close 12'))).toBe(true);
    expect(execCalls.some(c => c.includes('git/refs/heads/'))).toBe(false);
    expect(execCalls.some(c => c.includes('git push origin --delete'))).toBe(false);
  });

  it('never invokes the configured remote-delete failure path after closing a PR', async () => {
    const { manager, taskStore, events, execCalls } = await makeFixture('auto', 'pr', cmd =>
      cmd.includes('git/refs/heads/')
        ? { exitCode: 1, stderr: 'dial tcp 20.205.243.166:443: i/o timeout' }
        : {});
    await taskStore.set(taskFixture({ status: 'ready', afterDone: 'pr', prNumber: 12, latestHeadSha: 'h1' }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await manager.cancelTask('task-1');

    expect(result.status).toBe('cancelled');
    expect(execCalls.some(c => c.includes('git/refs/heads/'))).toBe(false);
    expect(events.some(e => e.type === 'human.intervention'
      && e.data?.phase === 'cancel-published-artifact-cleanup-failed')).toBe(false);
    warnSpy.mockRestore();
  });

  it('does not inspect whether the remote branch already exists', async () => {
    const { manager, taskStore, events, execCalls } = await makeFixture('auto', 'pr', cmd =>
      cmd.includes('git/refs/heads/')
        ? { exitCode: 1, stderr: 'gh: Reference does not exist (HTTP 422)' }
        : {});
    await taskStore.set(taskFixture({ status: 'ready', afterDone: 'pr', prNumber: 12, latestHeadSha: 'h1' }));

    const result = await manager.cancelTask('task-1');

    expect(result.status).toBe('cancelled');
    expect(execCalls.some(c => c.includes('git/refs/heads/'))).toBe(false);
    expect(events.some(e => e.type === 'human.intervention'
      && e.data?.phase === 'cancel-published-artifact-cleanup-failed')).toBe(false);
  });

  it('emits cleanup-failed (still cancelled) when gh pr close fails', async () => {
    const { manager, taskStore, events } = await makeFixture('auto', 'pr', cmd =>
      cmd.includes('gh pr close') ? { exitCode: 1, stderr: 'PR already closed upstream' } : {});
    await taskStore.set(taskFixture({ status: 'ready', afterDone: 'pr', prNumber: 12, latestHeadSha: 'h1' }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await manager.cancelTask('task-1');

    expect(result.status).toBe('cancelled');
    const failure = events.find(e => e.type === 'human.intervention'
      && e.data?.phase === 'cancel-published-artifact-cleanup-failed');
    expect(failure?.data).toMatchObject({ afterDone: 'pr', prNumber: 12, error: expect.stringContaining('already closed') });
    warnSpy.mockRestore();
  });

  it('afterDone=branch never issues a remote delete or cleanup-failed event', async () => {
    const { manager, taskStore, agentStore, events, execCalls } = await makeFixture('auto', 'branch', cmd =>
      cmd.includes('--delete') ? { exitCode: 1, stderr: 'branch is protected' } : {});
    await bindAgent(agentStore, 'dev-1', { taskId: 'task-1', workdir: '/repo/dev' });
    await taskStore.set(taskFixture({ status: 'ready', afterDone: 'branch', latestHeadSha: 'h1' }));
    const result = await manager.cancelTask('task-1');

    expect(result.status).toBe('cancelled');
    expect(execCalls.some(c => c.includes('--delete'))).toBe(false);
    expect(events.some(e => e.type === 'human.intervention'
      && e.data?.phase === 'cancel-published-artifact-cleanup-failed')).toBe(false);
  });

  it('afterDone=branch does not probe a missing remote branch', async () => {
    const { manager, taskStore, agentStore, events, execCalls } = await makeFixture('auto', 'branch', cmd =>
      cmd.includes('--delete')
        ? { exitCode: 1, stderr: 'error: unable to delete: remote ref does not exist' }
        : {});
    await bindAgent(agentStore, 'dev-1', { taskId: 'task-1', workdir: '/repo/dev' });
    await taskStore.set(taskFixture({ status: 'ready', afterDone: 'branch', latestHeadSha: 'h1' }));

    const result = await manager.cancelTask('task-1');

    expect(result.status).toBe('cancelled');
    expect(execCalls.some(c => c.includes('--delete'))).toBe(false);
    expect(events.some(e => e.type === 'human.intervention'
      && e.data?.phase === 'cancel-published-artifact-cleanup-failed')).toBe(false);
  });
});
