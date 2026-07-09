import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentManager, type DispatchArmContext, DispatchTerminalError } from '../../src/agent/manager.js';
import { AgentStore } from '../../src/state/agent-store.js';
import { TaskStore } from '../../src/state/task-store.js';
import { LockManager } from '../../src/state/lock.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { initStateDir } from '../../src/state/init.js';
import type { BaxianConfig, BaxianEvent, ReviewMode, TaskState } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
import type { ExecResult } from '../../src/agent/runner.js';
import { __setNetExecSleepForTests } from '../../src/agent/net-exec.js';

let tempDir: string;
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-server-dispatch-'));
  await initStateDir(tempDir);
});
afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

function makeConfig(mode: ReviewMode, opts: { omitQa?: boolean; siblingProjects?: boolean } = {}): BaxianConfig {
  const agents = [
    { id: 'dev-1', runtime: 'claude-code' as const, role: 'dev' as const, mode: 'local' as const, workdir: tempDir },
    ...(opts.omitQa ? [] : [{ id: 'qa-1', runtime: 'codex' as const, role: 'qa' as const, mode: 'local' as const, workdir: tempDir }]),
  ];
  return {
    review: { rounds: 10, mode },
    server: DEFAULT_SERVER_CONFIG,
    host: [],
    project: [
      { id: 'proj', repo: 'user/repo', merge: null, agent: [agents] },
      ...(opts.siblingProjects
        ? [
          { id: 'proj-same-repo', repo: 'User/Repo', merge: null, agent: [] },
          { id: 'proj-other-repo', repo: 'user/elsewhere', merge: null, agent: [] },
        ]
        : []),
    ],
  } as BaxianConfig;
}

async function makeFixture(mode: ReviewMode, opts: { omitQa?: boolean; siblingProjects?: boolean } = {}) {
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
  const watcher = {
    start: vi.fn(async () => true),
    stop: vi.fn(),
    has: vi.fn(() => false),
  };
  const manager = new AgentManager({
    config: makeConfig(mode, opts),
    agentStore,
    taskStore,
    lockManager: new LockManager(join(tempDir, 'locks')),
    eventBus,
    runnerFactory: () => runner,
    platformRunner: runner,
    phaseSignalWatcher: watcher as never,
  });
  return { manager, taskStore, agentStore, events, watcher, runner };
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

describe('dispatchServerReviewToQa arms the read-file watcher in startSession\'s pre-inject hook', () => {
  it('defers the spec-reviewed read-file watcher arm into startSession (not eagerly before the session exists)', async () => {
    const f = await makeFixture('github');
    const NOW = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'github', phase: undefined, status: 'in_progress',
      signalToken: 'orig-token', specReviewRound: 0,
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW,
    }));

    const armedSpecReviewed = () => f.watcher.start.mock.calls.some(
      (c) => (c[0] as { expectedKinds?: unknown }).expectedKinds === 'spec-reviewed',
    );
    let capturedOpts: { armBeforeInject?: (ctx: DispatchArmContext) => Promise<boolean> } | undefined;
    let armedBeforeStart = false;
    const startSpy = vi.spyOn(f.manager, 'startSession').mockImplementation(async (_t, _a, _p, opts) => {
      capturedOpts = opts as { armBeforeInject?: (ctx: DispatchArmContext) => Promise<boolean> };
      armedBeforeStart = armedSpecReviewed();
      return false;
    });

    await f.manager.dispatchServerReviewToQa('task-1', { phase: 'spec', content: 'spec text' })
      .catch(() => undefined);

    expect(startSpy).toHaveBeenCalled();
    expect(armedBeforeStart).toBe(false);
    expect(capturedOpts?.armBeforeInject).toBeTypeOf('function');
    await capturedOpts!.armBeforeInject!({});
    expect(f.watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      expectedKinds: 'spec-reviewed',
      onReadFile: expect.any(Function),
      skipSnapshot: false,
    }));
  });

  it('does not arm read-file for code review when the QA worktree holds the reviewed head', async () => {
    const f = await makeFixture('server');
    const NOW = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'in_progress',
      signalToken: 'orig-token', reviewRound: 0,
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW,
    }));
    let capturedOpts: { armBeforeInject?: (ctx: DispatchArmContext) => Promise<boolean> } | undefined;
    vi.spyOn(f.manager, 'startSession').mockImplementation(async (_t, _a, _p, opts) => {
      capturedOpts = opts as { armBeforeInject?: (ctx: DispatchArmContext) => Promise<boolean> };
      return false;
    });

    await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', content: 'diff text', reviewHeadAnchorSha: 'head123', headTree: 'tree123',
    }).catch(() => undefined);

    await capturedOpts!.armBeforeInject!({ serverReviewWorktree: 'head' });
    expect(f.watcher.start).toHaveBeenCalledWith(expect.not.objectContaining({
      onReadFile: expect.any(Function),
    }));
    expect(f.watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      expectedKinds: 'code-reviewed',
      skipSnapshot: false,
    }));
  });

  it('arms read-file for code review fallback worktrees', async () => {
    const f = await makeFixture('server');
    const NOW = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'in_progress',
      signalToken: 'orig-token', reviewRound: 0,
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW,
    }));
    let capturedOpts: { armBeforeInject?: (ctx: DispatchArmContext) => Promise<boolean> } | undefined;
    vi.spyOn(f.manager, 'startSession').mockImplementation(async (_t, _a, _p, opts) => {
      capturedOpts = opts as { armBeforeInject?: (ctx: DispatchArmContext) => Promise<boolean> };
      return false;
    });

    await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', content: 'diff text', reviewHeadAnchorSha: 'head123', headTree: 'tree123',
    }).catch(() => undefined);

    await capturedOpts!.armBeforeInject!({ serverReviewWorktree: 'base' });
    expect(f.watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      expectedKinds: 'code-reviewed',
      onReadFile: expect.any(Function),
      skipSnapshot: false,
    }));
  });

  it.each(['base', 'head'] as const)(
    'persists reviewWorktreeMode=%s from the materialized worktree so recovery can re-arm read-file',
    async (mode) => {
      const f = await makeFixture('server');
      const NOW = new Date().toISOString();
      await f.taskStore.set(taskFixture({
        reviewMode: 'server', phase: 'code', status: 'in_progress',
        signalToken: 'orig-token', reviewRound: 0,
      }));
      await f.agentStore.update('dev-1', () => ({
        id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW,
      }));
      vi.spyOn(f.manager, 'startSession').mockImplementation(async (_t, _a, _p, opts) => {
        await (opts as { armBeforeInject?: (ctx: DispatchArmContext) => Promise<boolean> })
          .armBeforeInject?.({ serverReviewWorktree: mode });
        return true;
      });

      await f.manager.dispatchServerReviewToQa('task-1', {
        phase: 'code', content: 'diff text', reviewHeadAnchorSha: 'head123', headTree: 'tree123',
      });

      const task = await f.taskStore.get('task-1');
      expect(task?.reviewWorktreeMode).toBe(mode);
    },
  );
});

describe('dispatchServerReviewToQa rollback restores originalPhase', () => {
  it('first spec dispatch failure rolls task back to pre-spec shape', async () => {
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

function interventionPhases(events: BaxianEvent[]): string[] {
  return events
    .filter(e => e.type === 'human.intervention')
    .map(e => (e.data as { phase?: string }).phase ?? '');
}

describe('dispatchServerReviewToQa failure & success paths', () => {
  it('no QA partner while fixing re-arms the *-fixed entry signal', async () => {
    const f = await makeFixture('github', { omitQa: true });
    await f.taskStore.set(taskFixture({
      reviewMode: 'github', phase: 'spec', status: 'fixing',
      qaAgentId: undefined, signalToken: 't', specReviewRound: 1,
    }));

    const result = await f.manager.dispatchServerReviewToQa('task-1', { phase: 'spec', content: 'spec' });

    expect(result).toBeNull();
    expect(interventionPhases(f.events)).toContain('server-review-no-qa-partner');
    expect(f.watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'dev-1', expectedKinds: 'spec-fixed', skipSnapshot: true,
    }));
  });

  it('falls back to the configured QA partner when task.qaAgentId left the config', async () => {
    const f = await makeFixture('server');
    const NOW = new Date().toISOString();
    await f.taskStore.set(taskFixture({ reviewMode: 'server', phase: 'code', status: 'in_progress', signalToken: 't', qaAgentId: 'ghost' }));
    await f.agentStore.update('dev-1', () => ({ id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW }));
    vi.spyOn(f.manager, 'startSession').mockResolvedValue(true);

    const result = await f.manager.dispatchServerReviewToQa('task-1', { phase: 'code', content: 'diff' });

    expect(result?.qaAgentId).toBe('qa-1');
    expect((await f.agentStore.get('qa-1'))?.taskId).toBe('task-1');
  });

  it('releases a QA still bound to the same task before re-acquiring (manual redispatch from review)', async () => {
    const f = await makeFixture('server');
    const NOW = new Date().toISOString();
    await f.taskStore.set(taskFixture({ reviewMode: 'server', phase: 'code', status: 'review', signalToken: 't', reviewRound: 1 }));
    await f.agentStore.update('qa-1', () => ({ id: 'qa-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW }));
    await f.agentStore.update('dev-1', () => ({ id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW }));
    const releaseSpy = vi.spyOn(f.manager, 'releaseAgentForTask');
    vi.spyOn(f.manager, 'startSession').mockResolvedValue(true);

    const result = await f.manager.dispatchServerReviewToQa('task-1', { phase: 'code', content: 'diff', recheck: true });

    expect(releaseSpy).toHaveBeenCalledWith('qa-1', 'task-1', 'idle');
    expect(result?.status).toBe('review');
    expect(result?.reviewRound).toBe(2);
    expect((await f.agentStore.get('qa-1'))?.taskId).toBe('task-1');
  });

  it('a failed redispatch from review does not re-arm the dev entry signal (long consumed)', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({ reviewMode: 'server', phase: 'code', status: 'review', signalToken: 't', reviewRound: 1 }));
    await f.agentStore.update('qa-1', () => ({
      id: 'qa-1', projectId: 'proj', taskId: 'someone-else', updatedAt: new Date().toISOString(),
    }));

    const result = await f.manager.dispatchServerReviewToQa('task-1', { phase: 'code', content: 'diff', recheck: true });

    expect(result).toBeNull();
    expect(interventionPhases(f.events)).toContain('server-review-qa-acquire-failed');
    expect(f.watcher.start).not.toHaveBeenCalled();
  });

  it('QA acquire failure re-arms code-fixed and emits qa-acquire-failed', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'fixing', signalToken: 't',
    }));
    await f.agentStore.update('qa-1', () => ({
      id: 'qa-1', projectId: 'proj', taskId: 'someone-else', updatedAt: new Date().toISOString(),
    }));

    const result = await f.manager.dispatchServerReviewToQa('task-1', { phase: 'code', content: 'diff' });

    expect(result).toBeNull();
    expect(interventionPhases(f.events)).toContain('server-review-qa-acquire-failed');
    expect(f.watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'dev-1', expectedKinds: 'code-fixed',
    }));
    expect((await f.taskStore.get('task-1'))?.status).toBe('fixing');
  });

  it('dev park failure releases the QA, re-arms code-done and emits dev-park-failed', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'in_progress', signalToken: 't',
    }));

    const result = await f.manager.dispatchServerReviewToQa('task-1', { phase: 'code', content: 'diff' });

    expect(result).toBeNull();
    expect(interventionPhases(f.events)).toContain('server-review-dev-park-failed');
    expect((await f.agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(f.watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'dev-1', expectedKinds: 'code-done',
    }));
  });

  it('a lost review transition releases the QA and emits transition-failed', async () => {
    const f = await makeFixture('server');
    const NOW = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'in_progress', signalToken: 't',
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW,
    }));
    vi.spyOn(f.manager, 'transitionTaskStatus').mockResolvedValue(undefined);

    const result = await f.manager.dispatchServerReviewToQa('task-1', { phase: 'code', content: 'diff' });

    expect(result).toBeNull();
    expect(interventionPhases(f.events)).toContain('server-review-transition-failed');
    expect((await f.agentStore.get('qa-1'))?.taskId).toBeUndefined();
  });

  it('a DispatchTerminalError from the QA session fails the task via failTaskForDispatchError', async () => {
    const f = await makeFixture('server');
    const NOW = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'in_progress', signalToken: 't',
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW,
    }));
    vi.spyOn(f.manager, 'startSession').mockRejectedValue(
      new DispatchTerminalError('prompt_too_large', 'diff too big'),
    );
    const failSpy = vi.spyOn(f.manager, 'failTaskForDispatchError').mockResolvedValue();

    await expect(
      f.manager.dispatchServerReviewToQa('task-1', { phase: 'code', content: 'diff' }),
    ).rejects.toMatchObject({ reason: 'prompt_too_large' });

    expect(failSpy).toHaveBeenCalledWith('task-1', 'server-review', 'qa-1', expect.anything());
    expect(f.watcher.stop).toHaveBeenCalledWith('task-1');
  });

  it('a delivered QA session leaves the task in review with the bumped round', async () => {
    const f = await makeFixture('server');
    const NOW = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'in_progress', signalToken: 't', reviewRound: 1,
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW,
    }));
    vi.spyOn(f.manager, 'startSession').mockResolvedValue(true);

    const result = await f.manager.dispatchServerReviewToQa('task-1', { phase: 'code', content: 'diff' });

    expect(result).toMatchObject({ status: 'review', reviewRound: 2, qaAgentId: 'qa-1' });
  });

  it('threads the recheck interdiff payload into startSession as serverInterdiff', async () => {
    const f = await makeFixture('server');
    const NOW = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'in_progress', signalToken: 't', reviewRound: 1,
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW,
    }));
    let captured: Record<string, unknown> | undefined;
    vi.spyOn(f.manager, 'startSession').mockImplementation(async (_t, _a, _p, opts) => {
      captured = opts as Record<string, unknown>;
      return true;
    });

    await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', content: 'full diff', recheck: true, interdiff: 'round-2 delta',
    });

    expect(captured?.serverContent).toBe('full diff');
    expect(captured?.serverInterdiff).toBe('round-2 delta');
  });

  it('threads captured review head metadata into startSession for QA worktree materialization', async () => {
    const f = await makeFixture('server');
    const NOW = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'in_progress', signalToken: 't', reviewRound: 0,
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW,
    }));
    let captured: Record<string, unknown> | undefined;
    vi.spyOn(f.manager, 'startSession').mockImplementation(async (_t, _a, _p, opts) => {
      captured = opts as Record<string, unknown>;
      return true;
    });

    await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code',
      content: 'full diff',
      diffstat: 'stat',
      baseSha: 'base123',
      reviewHeadAnchorSha: 'head123',
      headTree: 'tree123',
    });

    expect(captured?.serverContent).toBe('full diff');
    expect(captured?.serverDiffstat).toBe('stat');
    expect(captured?.serverBaseSha).toBe('base123');
    expect(captured?.serverHeadSha).toBe('head123');
    expect(captured?.serverHeadTree).toBe('tree123');
  });
});

describe('dispatchServerFixToDev failure & success paths', () => {
  it('QA release failure re-arms code-reviewed and emits qa-release-failed', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'review', signalToken: 't',
    }));

    const result = await f.manager.dispatchServerFixToDev('task-1', '[]');

    expect(result).toBeNull();
    expect(interventionPhases(f.events)).toContain('server-fix-qa-release-failed');
    expect(f.watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'qa-1', expectedKinds: 'code-reviewed',
    }));
  });

  it('dev acquire failure re-arms code-reviewed and emits dev-acquire-failed', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'review', signalToken: 't',
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'someone-else', updatedAt: new Date().toISOString(),
    }));

    const result = await f.manager.dispatchServerFixToDev('task-1', '[]');

    expect(result).toBeNull();
    expect(interventionPhases(f.events)).toContain('server-fix-dev-acquire-failed');
  });

  it('spec continuation passes currentSpecRound and arms spec-fixed after delivery', async () => {
    const f = await makeFixture('github');
    await f.taskStore.set(taskFixture({
      reviewMode: 'github', phase: 'spec', status: 'review', signalToken: 't',
      qaAgentId: undefined, specReviewRound: 2,
    }));
    let seenOpts: Record<string, unknown> | undefined;
    vi.spyOn(f.manager, 'continueSession').mockImplementation(async (_t, _a, _p, opts) => {
      seenOpts = opts as Record<string, unknown>;
      return true;
    });

    const result = await f.manager.dispatchServerFixToDev('task-1', '[{"note":"fix me"}]');

    expect(result).not.toBeNull();
    expect(seenOpts).toMatchObject({
      currentSpecRound: 2,
      serverPriorFindings: '[{"note":"fix me"}]',
      bypassTaskStatusGate: true,
    });
    expect(f.watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'dev-1', expectedKinds: 'spec-fixed',
    }));
    expect((await f.taskStore.get('task-1'))?.status).toBe('fixing');
  });

  it('a generic dispatch error rolls back to review, releases the dev and re-arms code-reviewed', async () => {
    const f = await makeFixture('server');
    const NOW = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'review', signalToken: 'orig-token',
    }));
    await f.agentStore.update('qa-1', () => ({
      id: 'qa-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW,
    }));
    vi.spyOn(f.manager, 'continueSession').mockRejectedValue(new Error('pane vanished'));

    await expect(f.manager.dispatchServerFixToDev('task-1', '[]')).rejects.toThrow('pane vanished');

    const after = await f.taskStore.get('task-1');
    expect(after?.status).toBe('review');
    expect(after?.signalToken).toBe('orig-token');
    expect((await f.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(f.watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'qa-1', expectedKinds: 'code-reviewed',
    }));
  });

  it('a DispatchTerminalError from the fix dispatch fails the task', async () => {
    const f = await makeFixture('server');
    const NOW = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'review', signalToken: 't',
    }));
    await f.agentStore.update('qa-1', () => ({
      id: 'qa-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW,
    }));
    vi.spyOn(f.manager, 'continueSession').mockRejectedValue(
      new DispatchTerminalError('required_skills_missing', 'skills gone'),
    );
    const failSpy = vi.spyOn(f.manager, 'failTaskForDispatchError').mockResolvedValue();

    await expect(f.manager.dispatchServerFixToDev('task-1', '[]'))
      .rejects.toMatchObject({ reason: 'required_skills_missing' });
    expect(failSpy).toHaveBeenCalledWith('task-1', 'server-feedback', 'dev-1', expect.anything());
  });
});

describe('dispatchServerAfterDone failure & success paths', () => {
  it('dev acquire failure restores the signal token and clears the publish marker', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'approved', signalToken: 'orig-token',
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'someone-else', updatedAt: new Date().toISOString(),
    }));

    const result = await f.manager.dispatchServerAfterDone('task-1', 'pr');

    expect(result).toBeNull();
    expect(interventionPhases(f.events)).toContain('server-after-done-dev-acquire-failed');
    const after = await f.taskStore.get('task-1');
    expect(after?.signalToken).toBe('orig-token');
    expect(after?.publishDispatchedAt).toBeUndefined();
  });

  it('a rebound dev reaches dev-acquire-failed, not a lineage verdict computed on the wrong worktree', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'approved', signalToken: 'orig-token',
    }));
    await f.taskStore.set(taskFixture({
      id: 'task-2', branch: 'bx/task-2', agentId: '', qaAgentId: undefined, status: 'in_progress',
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-9', worktreePath: '/wt/task-9',
      updatedAt: new Date().toISOString(),
    }));
    const SHA = 'c'.repeat(40);
    f.runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('rev-list')) return { stdout: `${SHA}\n`, stderr: '', exitCode: 0 };
      if (cmd.includes('merge-base --is-ancestor')) return { stdout: '', stderr: '', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await f.manager.dispatchServerAfterDone('task-1', 'pr');

    expect(result).toBeNull();
    const phases = interventionPhases(f.events);
    expect(phases).toContain('server-after-done-dev-acquire-failed');
    expect(phases).not.toContain('server-after-done-lineage-violation');
  });

  it('a generic publish dispatch error restores the signal token and rethrows', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'approved', signalToken: 'orig-token',
    }));
    vi.spyOn(f.manager, 'continueSession').mockRejectedValue(new Error('publish paste failed'));

    await expect(f.manager.dispatchServerAfterDone('task-1', 'branch')).rejects.toThrow('publish paste failed');
    const after = await f.taskStore.get('task-1');
    expect(after?.signalToken).toBe('orig-token');
    expect(after?.publishDispatchedAt).toBeUndefined();
  });

  it('a DispatchTerminalError from the publish dispatch fails the task', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'approved', signalToken: 't',
    }));
    vi.spyOn(f.manager, 'continueSession').mockRejectedValue(
      new DispatchTerminalError('prompt_too_large', 'publish prompt too big'),
    );
    const failSpy = vi.spyOn(f.manager, 'failTaskForDispatchError').mockResolvedValue();

    await expect(f.manager.dispatchServerAfterDone('task-1', 'pr'))
      .rejects.toMatchObject({ reason: 'prompt_too_large' });
    expect(failSpy).toHaveBeenCalledWith('task-1', 'server-after-done', 'dev-1', expect.anything());
  });

  it('a delivered publish prompt marks the dispatch and arms code-ready', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'approved', signalToken: 't',
    }));
    let seenOpts: Record<string, unknown> | undefined;
    vi.spyOn(f.manager, 'continueSession').mockImplementation(async (_t, _a, _p, opts) => {
      seenOpts = opts as Record<string, unknown>;
      return true;
    });

    const result = await f.manager.dispatchServerAfterDone('task-1', 'branch');

    expect(result).not.toBeNull();
    expect(result?.publishDispatchedAt).toBeTruthy();
    expect(seenOpts).toMatchObject({ serverAfterDone: { kind: 'branch', branch: 'bx/task-1' } });
    expect(f.watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'dev-1', expectedKinds: 'code-ready',
    }));
  });

  it('a lineage check failure blocks the publish dispatch recoverably instead of leaking the error', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'approved', signalToken: 'orig-token',
    }));
    const continueSpy = vi.spyOn(f.manager, 'continueSession').mockResolvedValue(true);
    vi.spyOn(f.manager, 'findLineageViolation').mockRejectedValue(new Error('merge-base exploded'));

    const result = await f.manager.dispatchServerAfterDone('task-1', 'pr');

    expect(result).toBeNull();
    expect(continueSpy).not.toHaveBeenCalled();
    const intervention = f.events.find(e => e.type === 'human.intervention');
    expect(intervention?.data).toMatchObject({ phase: 'server-after-done-lineage-check-failed' });
    const after = await f.taskStore.get('task-1');
    expect(after?.signalToken).toBe('orig-token');
    expect(after?.publishDispatchedAt).toBeUndefined();
  });

  it('refuses the publish dispatch when the branch embeds another active task branch', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'approved', signalToken: 'orig-token',
    }));
    const continueSpy = vi.spyOn(f.manager, 'continueSession').mockResolvedValue(true);
    vi.spyOn(f.manager, 'findLineageViolation').mockResolvedValue({
      taskId: 'task-2', branch: 'bx/task-2', sha: 'a'.repeat(40),
    });

    const result = await f.manager.dispatchServerAfterDone('task-1', 'pr');

    expect(result).toBeNull();
    expect(continueSpy).not.toHaveBeenCalled();
    const intervention = f.events.find(e => e.type === 'human.intervention');
    expect(intervention?.data).toMatchObject({
      phase: 'server-after-done-lineage-violation',
      offendingTaskId: 'task-2',
      offendingBranch: 'bx/task-2',
    });
    const after = await f.taskStore.get('task-1');
    expect(after?.signalToken).toBe('orig-token');
    expect(after?.publishDispatchedAt).toBeUndefined();
  });
});

describe('findLineageViolation', () => {
  const NOW = new Date().toISOString();
  const SHA_A = 'a'.repeat(40);
  const SHA_B = 'b'.repeat(40);

  async function seedLineageFixture(otherTask: Partial<TaskState>) {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({ reviewMode: 'server', phase: 'code', signalToken: 't' }));
    await f.taskStore.set(taskFixture({
      id: 'task-2', branch: 'bx/task-2', agentId: '', qaAgentId: undefined,
      status: 'in_progress', ...otherTask,
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1',
      worktreePath: '/wt/task-1', updatedAt: NOW,
    }));
    f.runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes("rev-list 'base123..refs/heads/bx/task-2'")) {
        return { stdout: `${SHA_A}\n`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes("rev-list 'base123..HEAD'")) {
        return { stdout: `${SHA_B}\n${SHA_A}\n`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('merge-base --is-ancestor')) return { stdout: '', stderr: '', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    return f;
  }

  it('reports another active task whose branch tip sits inside this branch history', async () => {
    const f = await seedLineageFixture({});
    const violation = await f.manager.findLineageViolation('task-1', 'base123');
    expect(violation).toEqual({ taskId: 'task-2', branch: 'bx/task-2', sha: SHA_A });
  });

  it('ignores terminal tasks when collecting candidates', async () => {
    const f = await seedLineageFixture({ status: 'merged' });
    const violation = await f.manager.findLineageViolation('task-1', 'base123');
    expect(violation).toBeNull();
  });

  it('resolves the merge base itself when no baseSha is provided', async () => {
    const f = await seedLineageFixture({});
    f.runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('merge-base origin/HEAD HEAD')) return { stdout: 'base456\n', stderr: '', exitCode: 0 };
      if (cmd.includes("rev-list 'base456..refs/heads/bx/task-2'")) {
        return { stdout: `${SHA_A}\n`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes("rev-list 'base456..HEAD'")) return { stdout: `${SHA_A}\n`, stderr: '', exitCode: 0 };
      if (cmd.includes('merge-base --is-ancestor')) return { stdout: '', stderr: '', exitCode: 1 };
      if (cmd.includes('rev-list')) return { stdout: '', stderr: 'wrong base', exitCode: 128 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const violation = await f.manager.findLineageViolation('task-1');
    expect(violation).toEqual({ taskId: 'task-2', branch: 'bx/task-2', sha: SHA_A });
    const cmds = f.runner.exec.mock.calls.map(c => c[0] as string);
    const fetchIdx = cmds.findIndex(c => c.includes('fetch origin'));
    const mergeBaseIdx = cmds.findIndex(c => c.includes('merge-base origin/HEAD HEAD'));
    expect(fetchIdx).toBeGreaterThanOrEqual(0);
    expect(fetchIdx).toBeLessThan(mergeBaseIdx);
  });

  it('throws when the freshness fetch fails while self-resolving the base', async () => {
    const f = await seedLineageFixture({});
    f.runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('fetch origin')) return { stdout: '', stderr: 'network down', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    await expect(f.manager.findLineageViolation('task-1')).rejects.toThrow(/fetch/i);
  });

  it('retries a transient freshness fetch before self-resolving the base', async () => {
    __setNetExecSleepForTests(async () => {});
    try {
      const f = await seedLineageFixture({});
      let fetchAttempts = 0;
      f.runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('fetch origin')) {
          fetchAttempts++;
          return fetchAttempts === 1
            ? { stdout: '', stderr: 'fatal: unable to access: Could not resolve host: github.com', exitCode: 128 }
            : { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('merge-base origin/HEAD HEAD')) return { stdout: 'base456\n', stderr: '', exitCode: 0 };
        if (cmd.includes("rev-list 'base456..HEAD'")) return { stdout: '', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      const violation = await f.manager.findLineageViolation('task-1');
      expect(violation).toBeNull();
      expect(fetchAttempts).toBe(2);
    } finally {
      __setNetExecSleepForTests();
    }
  });

  it('returns null when the dev agent has no recorded worktree', async () => {
    const f = await seedLineageFixture({});
    await f.agentStore.update('dev-1', (s) => {
      const { worktreePath: _w, ...rest } = s!;
      return rest;
    });
    const violation = await f.manager.findLineageViolation('task-1', 'base123');
    expect(violation).toBeNull();
  });

  it('returns null when the dev agent has been rebound to another task — its worktree belongs to that task', async () => {
    const f = await seedLineageFixture({});
    await f.agentStore.update('dev-1', (s) => ({
      ...s!, taskId: 'task-9', worktreePath: '/wt/task-9',
    }));
    const violation = await f.manager.findLineageViolation('task-1', 'base123');
    expect(violation).toBeNull();
    const probed = f.runner.exec.mock.calls.map(c => c[0] as string);
    expect(probed.some(c => c.includes('/wt/task-9'))).toBe(false);
  });

  it('collects candidates from sibling projects sharing the same repo (shared branch namespace)', async () => {
    const f = await makeFixture('server', { siblingProjects: true });
    await f.taskStore.set(taskFixture({ reviewMode: 'server', phase: 'code', signalToken: 't' }));
    await f.taskStore.set(taskFixture({
      id: 'task-5', projectId: 'proj-same-repo', branch: 'bx/task-5',
      agentId: '', qaAgentId: undefined, status: 'in_progress',
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1',
      worktreePath: '/wt/task-1', updatedAt: NOW,
    }));
    f.runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes("rev-list 'base123..refs/heads/bx/task-5'")) {
        return { stdout: `${SHA_A}\n`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes("rev-list 'base123..HEAD'")) {
        return { stdout: `${SHA_B}\n${SHA_A}\n`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('merge-base --is-ancestor')) return { stdout: '', stderr: '', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const violation = await f.manager.findLineageViolation('task-1', 'base123');
    expect(violation).toEqual({ taskId: 'task-5', branch: 'bx/task-5', sha: SHA_A });
  });

  it('excludes tasks whose project points at a different repo', async () => {
    const f = await makeFixture('server', { siblingProjects: true });
    await f.taskStore.set(taskFixture({ reviewMode: 'server', phase: 'code', signalToken: 't' }));
    await f.taskStore.set(taskFixture({
      id: 'task-6', projectId: 'proj-other-repo', branch: 'bx/task-6',
      agentId: '', qaAgentId: undefined, status: 'in_progress',
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1',
      worktreePath: '/wt/task-1', updatedAt: NOW,
    }));
    f.runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes("rev-list 'base123..HEAD'")) {
        return { stdout: `${SHA_B}\n${SHA_A}\n`, stderr: '', exitCode: 0 };
      }
      return { stdout: `${SHA_A}\n`, stderr: '', exitCode: 0 };
    });

    const violation = await f.manager.findLineageViolation('task-1', 'base123');
    expect(violation).toBeNull();
    const probed = f.runner.exec.mock.calls.map(c => c[0] as string);
    expect(probed.some(c => c.includes('refs/heads/bx/task-6'))).toBe(false);
  });
});

describe('dispatchServerReviewToQa forwards full content to startSession (split happens later)', () => {
  it('passes oversized spec content through untruncated', async () => {
    const f = await makeFixture('github');
    await f.taskStore.set(taskFixture({
      reviewMode: 'github', phase: undefined, status: 'in_progress',
      signalToken: 'orig-token', specReviewRound: 0,
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: new Date().toISOString(),
    }));
    const huge = '哈'.repeat(30000);
    let captured: { serverContent?: string; contentTruncated?: boolean } | undefined;
    vi.spyOn(f.manager, 'startSession').mockImplementation(async (_t, _a, _p, opts) => {
      captured = opts as typeof captured;
      return true;
    });
    await f.manager.dispatchServerReviewToQa('task-1', { phase: 'spec', content: huge });
    expect(captured?.serverContent).toBe(huge);
    expect(captured && 'contentTruncated' in captured).toBe(false);
  });
});

describe('startSession/continueSession resolve server payloads before prompt build', () => {
  type Fixture = Awaited<ReturnType<typeof makeFixture>>;

  function stubSessionEnv(f: Fixture) {
    vi.spyOn(f.manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: true, paneId: '%1', workdir: tempDir,
    });
  }

  function stubTransport(f: Fixture) {
    const deliverToInbox = vi.fn(async (_agent: unknown, _wt: string, filename: string, content: string) => ({
      path: `.baxian/review/inbox/${filename}`,
      bytes: Buffer.byteLength(content, 'utf8'),
    }));
    vi.spyOn(f.manager, 'getReviewTransport').mockReturnValue({ deliverToInbox } as never);
    return deliverToInbox;
  }

  it('startSession delivers oversized review content to the consumer inbox with round-derived naming', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'review', signalToken: 'tok', reviewRound: 1,
    }));
    stubSessionEnv(f);
    const deliver = stubTransport(f);
    const huge = 'd'.repeat(10 * 1024 + 1);

    await expect(f.manager.startSession('task-1', 'qa-1', 'server-review', {
      bypassTaskStatusGate: true, signalToken: 'tok', serverContent: huge,
    })).rejects.toMatchObject({ reason: 'required_skills_missing' });

    expect(deliver).toHaveBeenCalledTimes(1);
    const [agentArg, worktreeArg, filename, content] = deliver.mock.calls[0]!;
    expect((agentArg as { id: string }).id).toBe('qa-1');
    expect(worktreeArg).toContain('task-1-review_');
    expect(filename).toBe('diff-round-1.patch');
    expect(content).toBe(huge);
  });

  it('continueSession delivers oversized prior findings to the dev inbox for server-feedback', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'fixing', signalToken: 'tok', reviewRound: 2,
    }));
    const devWorktree = join(tempDir, 'wt-dev');
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1',
      worktreePath: devWorktree, updatedAt: new Date().toISOString(),
    }));
    stubSessionEnv(f);
    const deliver = stubTransport(f);
    const findings = JSON.stringify({ pad: 'f'.repeat(10 * 1024 + 1) });

    await expect(f.manager.continueSession('task-1', 'dev-1', 'server-feedback', {
      signalToken: 'tok', serverPriorFindings: findings,
    })).rejects.toMatchObject({ reason: 'required_skills_missing' });

    expect(deliver).toHaveBeenCalledTimes(1);
    const [agentArg, worktreeArg, filename, content] = deliver.mock.calls[0]!;
    expect((agentArg as { id: string }).id).toBe('dev-1');
    expect(worktreeArg).toBe(devWorktree);
    expect(filename).toBe('findings-round-2.json');
    expect(content).toBe(findings);
  });

  it('startSession forces a small review diff into diff-file when the QA worktree materializes the head tree', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'review', signalToken: 'tok', reviewRound: 1,
    }));
    stubSessionEnv(f);
    f.runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('git rev-parse HEAD^{tree}')) return { stdout: 'tree123\n', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const deliver = stubTransport(f);

    await expect(f.manager.startSession('task-1', 'qa-1', 'server-review', {
      bypassTaskStatusGate: true,
      signalToken: 'tok',
      serverContent: 'small diff',
      serverBaseSha: 'base123',
      serverHeadSha: 'head123',
      serverHeadTree: 'tree123',
    })).rejects.toMatchObject({ reason: 'required_skills_missing' });

    expect(deliver).toHaveBeenCalledTimes(1);
    const [, , filename, content] = deliver.mock.calls[0]!;
    expect(filename).toBe('diff-round-1.patch');
    expect(content).toBe('small diff');
  });

  it('a within-threshold payload stays inline: prompt build is reached with zero inbox deliveries', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'review', signalToken: 'tok', reviewRound: 1,
    }));
    stubSessionEnv(f);
    const deliver = stubTransport(f);

    await expect(f.manager.startSession('task-1', 'qa-1', 'server-review', {
      bypassTaskStatusGate: true, signalToken: 'tok', serverContent: 'small diff',
    })).rejects.toMatchObject({ reason: 'required_skills_missing' });

    expect(deliver).not.toHaveBeenCalled();
  });
});
