import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentManager } from '../../src/agent/manager.js';
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

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-confirm-'));
  await initStateDir(tempDir);
});

afterEach(async () => {
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
        { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: tempDir },
        { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local', workdir: tempDir },
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
  const eventBus = new EventBus(new EventLog(join(tempDir, 'events')));
  const events: { type: string; data?: Record<string, unknown> }[] = [];
  eventBus.on('*', (e) => { events.push({ type: e.type, data: e.data }); });
  const manager = new AgentManager({
    config: makeConfig(merge, afterDone),
    agentStore,
    taskStore,
    lockManager: new LockManager(join(tempDir, 'locks')),
    eventBus,
    runnerFactory: () => runner,
    platformRunner: runner,
    ...(reviewStore ? { reviewStore } : {}),
  });
  Object.assign(manager, { compactIdlePollMs: 5, compactIdleWaitMs: 200 });
  return { manager, taskStore, agentStore, execCalls, events };
}

function readyPaneExec(cmd: string): Partial<ExecResult> {
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
  return agentStore.update(id, () => ({ id, projectId: 'proj', taskId: 'task-1', paneId, updatedAt: now }));
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
    qaAgentId: 'qa-1',
    reviewRound: 2,
    reviewMode: 'server',
    branch: 'bx/task-1',
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

function hasRemoteRetirement(execCalls: string[]): boolean {
  return execCalls.some(c => c.includes('gh pr close') || c.includes('--delete'));
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
    await bindAgent(agentStore, 'dev-1', { repoPath: '/repo/dev' });
    await taskStore.set(taskFixture({ latestHeadSha: 'head123' }));
    const result = await manager.markTaskComplete('task-1');
    expect(result.status).toBe('merged');
    expect(execCalls.some(c => c.includes(`git push origin 'origin/bx/task-1':'main'`))).toBe(true);
    expect(execCalls.some(c => c.includes('git checkout') || c.includes('merge --ff-only'))).toBe(false);
    expect(execCalls.some(c => c.includes('git push origin --delete'))).toBe(true);
  });

  it('ready + afterDone:branch + merge:auto + non-ff failure → stays at the gate for retry', async () => {
    const { manager, taskStore, agentStore } = await makeFixture('auto', 'branch', cmd => {
      if (cmd.includes('symbolic-ref')) return { stdout: 'origin/main\n' };
      if (cmd.includes(`:'main'`)) return { exitCode: 1, stderr: 'rejected: non-fast-forward' };
      return {};
    });
    await bindAgent(agentStore, 'dev-1', { repoPath: '/repo/dev' });
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

describe('snapshot + resume semantics', () => {
  it('ready confirm uses task.afterDone over hot config', async () => {
    const { manager, taskStore } = await makeFixture(null, 'pr');
    await taskStore.set(taskFixture({ afterDone: 'branch' }));
    const result = await manager.markTaskComplete('task-1');
    expect(result.status).toBe('done');
  });

  it('resumeAgent redispatches the code prompt for code-dispatch-failed', async () => {
    const { manager, taskStore, agentStore: agents } = await makeFixture(null, null);
    await taskStore.set(taskFixture({ status: 'in_progress', phase: 'code' }));
    await bindAgent(agents, 'dev-1', {
      taskId: 'task-1', paneId: '%1',
      status: 'awaiting_human', awaitingPhase: 'code-dispatch-failed',
      awaitingReason: 'x', awaitingSince: 'now',
    });
    const continued: string[] = [];
    stubMethod(manager, 'continueSession', async (t: string, a: string, p: string) => {
      continued.push(`${t}:${a}:${p}`);
      return true;
    });
    const result = await manager.resumeAgent('dev-1');
    expect(result.resumed).toBe(true);
    expect(continued).toEqual(['task-1:dev-1:code']);
    const state = await agents.get('dev-1');
    expect(state?.status).toBeUndefined();
    expect(state?.taskId).toBe('task-1');
  });
});

describe('cancel a published gate cleans up the remote (pr / branch)', () => {
  it('cancel of a published pr gate closes the PR remotely', async () => {
    const { manager, taskStore, execCalls } = await makeFixture('auto', 'pr');
    await taskStore.set(taskFixture({ status: 'ready', afterDone: 'pr', prNumber: 12, latestHeadSha: 'h1' }));
    const result = await manager.cancelTask('task-1');
    expect(result.status).toBe('cancelled');
    expect(execCalls.some(c => c.includes('gh pr close 12') && c.includes('--delete-branch'))).toBe(true);
  });

  it('cancel of a published branch gate deletes the remote branch', async () => {
    const { manager, taskStore, agentStore: agents, execCalls } = await makeFixture('auto', 'branch');
    await bindAgent(agents, 'dev-1', { taskId: 'task-1', repoPath: '/repo/dev' });
    await taskStore.set(taskFixture({ status: 'ready', afterDone: 'branch', latestHeadSha: 'h1' }));
    await manager.cancelTask('task-1');
    expect(execCalls.some(c => c.includes('git push origin --delete') && c.includes('bx/task-1'))).toBe(true);
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
    const closeAt = execCalls.findIndex(c => c.includes('gh pr close 31') && c.includes('--delete-branch'));
    expect(interruptAt).toBeGreaterThanOrEqual(0);
    expect(closeAt).toBeGreaterThan(interruptAt);
  });

  it('approved + publishDispatchedAt without prNumber (branch publish) → interrupts the dev FIRST, then deletes the remote branch', async () => {
    const { manager, taskStore, agentStore, execCalls } = await makeFixture('auto', 'branch', readyPaneExec);
    await bindAgent(agentStore, 'dev-1', { taskId: 'task-1', repoPath: '/repo/dev', paneId: '%5' });
    await taskStore.set(taskFixture({
      status: 'approved', afterDone: 'branch',
      publishDispatchedAt: '2026-06-10T01:00:00.000Z',
    }));
    await manager.cancelTask('task-1');
    const interruptAt = execCalls.findIndex(c => c.includes('send-keys') && c.includes("'Escape'"));
    const deleteAt = execCalls.findIndex(c => c.includes('git push origin --delete') && c.includes('bx/task-1'));
    expect(interruptAt).toBeGreaterThanOrEqual(0);
    expect(deleteAt).toBeGreaterThan(interruptAt);
  });

  it.each([
    {
      label: 'a FAILED dev interrupt → skips remote retirement and intervenes (publish may still be running)',
      seed: (agentStore: AgentStore) => bindAgent(agentStore, 'dev-1', { taskId: 'task-1', repoPath: '/repo/dev' }),
      task: {} as Partial<TaskState>,
      checkCancelled: true,
      devAwaiting: true,
    },
    {
      label: 'the dev config hot-removed → skips gh pr close (pane outlives the config)',
      seed: (agentStore: AgentStore) => bindAgent(agentStore, 'ghost', { taskId: 'task-1', paneId: '%5' }),
      task: { agentId: 'ghost' } as Partial<TaskState>,
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
    expect(hasRemoteRetirement(execCalls)).toBe(false);
    expect(hasCleanupSkippedEvent(events)).toBe(true);
    if (devAwaiting) expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
  });

  it('ready with a FAILED dev interrupt still retires remotely (publish already finished)', async () => {
    const { manager, taskStore, agentStore, execCalls, events } = await makeFixture('auto', 'pr');
    await bindAgent(agentStore, 'dev-1', { taskId: 'task-1', repoPath: '/repo/dev' });
    await taskStore.set(taskFixture({ status: 'ready', afterDone: 'pr', prNumber: 12, latestHeadSha: 'h1' }));
    await manager.cancelTask('task-1');
    expect(execCalls.some(c => c.includes('gh pr close 12') && c.includes('--delete-branch'))).toBe(true);
    expect(hasCleanupSkippedEvent(events)).toBe(false);
  });

  it('approved WITHOUT the delivery marker → nothing was published, no remote retirement', async () => {
    const { manager, taskStore, execCalls } = await makeFixture('auto', 'pr');
    await taskStore.set(taskFixture({ status: 'approved', afterDone: 'pr' }));
    await manager.cancelTask('task-1');
    expect(hasRemoteRetirement(execCalls)).toBe(false);
  });

  it('approved with a hand-edited null marker → treated as not dispatched, no remote retirement', async () => {
    const { manager, taskStore, execCalls } = await makeFixture('auto', 'pr');
    await taskStore.set(approvedPrMarkerFixture({ publishDispatchedAt: null as unknown as string }));
    await manager.cancelTask('task-1');
    expect(hasRemoteRetirement(execCalls)).toBe(false);
  });
});

describe('merge-ready cancel, Call review mode guard, and confirm head guard', () => {
  it('merge-ready cancel closes the published PR', async () => {
    const { manager, taskStore, execCalls } = await makeFixture('auto', null);
    await taskStore.set(taskFixture({ status: 'merge-ready', reviewMode: 'github', prNumber: 21 }));
    await manager.cancelTask('task-1');
    expect(execCalls.some(c => c.includes('gh pr close 21') && c.includes('--delete-branch'))).toBe(true);
  });

  it('Call review refuses server-mode tasks', async () => {
    const { manager, taskStore } = await makeFixture(null, 'pr');
    await taskStore.set(taskFixture({ status: 'ready', prNumber: 5 }));
    await expect(manager.dispatchReviewToQa('task-1')).rejects.toThrow(/server review mode/);
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

  it('transitionToCodePhase holds the dev (code-dispatch-failed) when acquire fails', async () => {
    const { manager, taskStore, agentStore } = await makeFixture(null, 'pr');
    await taskStore.set(taskFixture({ status: 'review', phase: 'spec', qaAgentId: undefined, signalToken: 'tok' }));
    await bindToTask(agentStore, 'dev-1', NOW);
    vi.spyOn(manager as unknown as { setupPhaseSignalWatcher: () => Promise<boolean> }, 'setupPhaseSignalWatcher')
      .mockResolvedValue(true);
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(false);
    const holdSpy = vi.spyOn(manager, 'markAwaitingHuman').mockResolvedValue();

    const result = await manager.transitionToCodePhase('task-1');

    expect(result).toBeNull();
    expect(holdSpy).toHaveBeenCalledWith(
      'dev-1', 'code-dispatch-failed', expect.any(String), { expectedTaskId: 'task-1' },
    );
  });

  it('dispatchServerReviewToQa continuation failure re-arms the reviewed watcher and keeps the QA bound', async () => {
    const { manager, taskStore, agentStore } = await makeFixture(null, 'pr');
    await taskStore.set(taskFixture({ status: 'review', signalToken: 'tok', batchIndex: 0, batchTotal: 2 }));
    await bindToTask(agentStore, 'qa-1', NOW);
    vi.spyOn(manager, 'continueSession').mockResolvedValue(false);
    const rearmSpy = vi.spyOn(manager, 'setupPhaseSignal').mockResolvedValue(true);
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask');

    const result = await manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', recheck: true, continuation: true, content: 'diff', batch: { index: 1, total: 2 },
    });

    expect(result).toBeNull();
    expect(rearmSpy).toHaveBeenCalledWith('task-1', 'qa-1', 'code-reviewed', { skipSnapshot: true });
    expect(releaseSpy).not.toHaveBeenCalled();
    expect((await agentStore.get('qa-1'))?.taskId).toBe('task-1');
  });

  it('dispatchServerFixToDev resume failure re-arms the QA reviewed watcher after rollback', async () => {
    const { manager, taskStore, agentStore } = await makeFixture(null, 'pr');
    await taskStore.set(taskFixture({ status: 'review', signalToken: 'tok' }));
    await bindToTask(agentStore, 'qa-1', NOW);
    await bindToTask(agentStore, 'dev-1', NOW);
    vi.spyOn(manager, 'continueSession').mockResolvedValue(false);
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
    await bindAgent(f.agentStore, 'dev-1', { repoPath: '/repo/dev' });
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

  it('a failing post-merge branch delete only warns; the task still lands merged', async () => {
    const f = await ffFixture(cmd => {
      if (cmd.includes('symbolic-ref')) return { stdout: 'origin/main\n' };
      if (cmd.includes('rev-parse')) return { stdout: 'head123\n' };
      if (cmd.includes('--delete')) return { exitCode: 1, stderr: 'protected branch' };
      return {};
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await f.manager.markTaskComplete('task-1');
    expect(result.status).toBe('merged');
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('post-merge branch delete failed'))).toBe(true);
    warnSpy.mockRestore();
  });
});

describe('cancel remote retirement failure tolerance', () => {
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

  it('emits cleanup-failed when the remote branch delete fails', async () => {
    const { manager, taskStore, agentStore, events } = await makeFixture('auto', 'branch', cmd =>
      cmd.includes('--delete') ? { exitCode: 1, stderr: 'branch is protected' } : {});
    await bindAgent(agentStore, 'dev-1', { taskId: 'task-1', repoPath: '/repo/dev' });
    await taskStore.set(taskFixture({ status: 'ready', afterDone: 'branch', latestHeadSha: 'h1' }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await manager.cancelTask('task-1');

    expect(result.status).toBe('cancelled');
    const failure = events.find(e => e.type === 'human.intervention'
      && e.data?.phase === 'cancel-published-artifact-cleanup-failed');
    expect(failure?.data).toMatchObject({ afterDone: 'branch', error: expect.stringContaining('protected') });
    warnSpy.mockRestore();
  });
});
