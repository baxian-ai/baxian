import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentManager, DispatchTerminalError } from '../../src/agent/manager.js';
import { AgentStore } from '../../src/state/agent-store.js';
import { TaskStore } from '../../src/state/task-store.js';
import { LockManager } from '../../src/state/lock.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { initStateDir } from '../../src/state/init.js';
import type { BaxianConfig, BaxianEvent, ReviewMode, TaskState } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
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
    server: DEFAULT_SERVER_CONFIG,
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
  return { manager, taskStore, agentStore, events, watcher };
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
    let capturedOpts: { armBeforeInject?: () => Promise<boolean> } | undefined;
    let armedBeforeStart = false;
    const startSpy = vi.spyOn(f.manager, 'startSession').mockImplementation(async (_t, _a, _p, opts) => {
      capturedOpts = opts as { armBeforeInject?: () => Promise<boolean> };
      armedBeforeStart = armedSpecReviewed();
      return false;
    });

    await f.manager.dispatchServerReviewToQa('task-1', { phase: 'spec', content: 'spec text', contentTruncated: true })
      .catch(() => undefined);

    expect(startSpy).toHaveBeenCalled();
    expect(armedBeforeStart).toBe(false);
    expect(capturedOpts?.armBeforeInject).toBeTypeOf('function');
    await capturedOpts!.armBeforeInject!();
    expect(f.watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      expectedKinds: 'spec-reviewed',
      onReadFile: expect.any(Function),
      skipSnapshot: false,
    }));
  });
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
});
