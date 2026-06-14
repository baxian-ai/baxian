import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentManager } from '../../src/agent/manager.js';
import { AgentStore } from '../../src/state/agent-store.js';
import { TaskStore } from '../../src/state/task-store.js';
import { LockManager } from '../../src/state/lock.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { initStateDir } from '../../src/state/init.js';
import type { BaxianConfig, BaxianEvent, ReviewMode, TaskState } from '../../src/shared/index.js';
import type { ExecResult } from '../../src/agent/runner.js';

let tempDir: string;
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-server-dispatch-'));
  await initStateDir(tempDir);
});
afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

function makeConfig(mode: ReviewMode, opts: { omitQa?: boolean } = {}): BaxianConfig {
  const agents = [
    { id: 'dev-1', runtime: 'claude-code' as const, role: 'dev' as const, mode: 'local' as const, workdir: tempDir },
    ...(opts.omitQa ? [] : [{ id: 'qa-1', runtime: 'codex' as const, role: 'qa' as const, mode: 'local' as const, workdir: tempDir }]),
  ];
  return {
    review: { rounds: 10, mode },
    server: { port: 3000 },
    host: [],
    project: [{ id: 'proj', repo: 'user/repo', merge: null, agent: [agents] }],
  } as BaxianConfig;
}

async function makeFixture(mode: ReviewMode, opts: { omitQa?: boolean } = {}) {
  const runner = {
    exec: vi.fn(async (): Promise<ExecResult> =>
      ({ stdout: '', stderr: '', exitCode: 0 })),
    writeFile: vi.fn(async () => undefined),
    execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
  };
  const taskStore = new TaskStore(join(tempDir, 'state', 'tasks'));
  const agentStore = new AgentStore(join(tempDir, 'state', 'agents'));
  const eventBus = new EventBus(new EventLog(join(tempDir, 'events')));
  const events: BaxianEvent[] = [];
  eventBus.on('*', (e) => { events.push(e); });
  const manager = new AgentManager({
    config: makeConfig(mode, opts),
    agentStore,
    taskStore,
    lockManager: new LockManager(join(tempDir, 'locks')),
    eventBus,
    runnerFactory: () => runner,
    platformRunner: runner,
  });
  return { manager, taskStore, agentStore, events };
}

function taskFixture(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'task-1', projectId: 'proj', title: 'T', description: 'D',
    preferredAgentId: 'dev-1', agentId: 'dev-1', qaAgentId: 'qa-1',
    reviewRound: 0, branch: 'bx/task-1', status: 'in_progress',
    createdAt: '2026-06-12T00:00:00.000Z', updatedAt: '2026-06-12T00:00:00.000Z',
    ...overrides,
  } as TaskState;
}

describe('server dispatch guards (spec unification)', () => {
  it('dispatchServerReviewToQa rejects github task for code phase', async () => {
    const f = await makeFixture('github');
    await f.taskStore.set(taskFixture({ reviewMode: 'github', phase: 'code', signalToken: 't' }));
    await expect(
      f.manager.dispatchServerReviewToQa('task-1', { phase: 'code', content: 'diff' }),
    ).rejects.toThrow(/not in server review mode/);
  });

  it('dispatchServerReviewToQa accepts github task for spec phase (proceeds past guard)', async () => {
    const f = await makeFixture('github', { omitQa: true });
    await f.taskStore.set(taskFixture({ reviewMode: 'github', phase: undefined, qaAgentId: undefined, signalToken: 't' }));
    const result = await f.manager.dispatchServerReviewToQa('task-1', { phase: 'spec', content: 'spec text' });
    expect(result).toBeNull();
    expect(f.events.some(e => e.type === 'human.intervention'
      && e.data?.phase === 'server-review-no-qa-partner')).toBe(true);
  });

  it('dispatchServerFixToDev rejects github task outside spec phase', async () => {
    const f = await makeFixture('github');
    await f.taskStore.set(taskFixture({ reviewMode: 'github', phase: 'code', status: 'review', signalToken: 't' }));
    await expect(
      f.manager.dispatchServerFixToDev('task-1', '{}'),
    ).rejects.toThrow(/not in server review mode/);
  });
});

describe('dispatchServerReviewToQa rollback restores originalPhase', () => {
  it('first spec dispatch failure rolls task back to pre-spec shape', async () => {
    // Default mock (exitCode:0 everywhere) drives: has-session alive → adoptOrRestartSession
    // → getOption empty → claim mismatch → EnsureSessionError → rollback AFTER phase:'spec' was written.
    const f = await makeFixture('github');
    const NOW = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'github', phase: undefined, status: 'in_progress',
      signalToken: 'orig-token', specReviewRound: 0,
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW,
    }));
    await f.manager.dispatchServerReviewToQa('task-1', { phase: 'spec', content: 'spec text' })
      .catch(() => undefined);
    const after = await f.taskStore.get('task-1');
    expect(after?.status).toBe('in_progress');
    expect(after?.phase).toBeUndefined();
    expect(after?.signalToken).toBe('orig-token');
    expect(after?.specReviewRound).toBe(0);
  });
});
