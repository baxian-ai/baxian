import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DispatchTerminalError, type AgentManager } from '../../src/agent/manager.js';
import type { TaskStore } from '../../src/state/task-store.js';
import type { LockManager } from '../../src/state/lock.js';
import type { EventBus } from '../../src/event/bus.js';
import { recoverGitPostApprovePending, registerEventHandlers } from '../../src/event/handlers.js';
import type { BaxianEvent, TaskState } from '../../src/shared/index.js';
import { DirtyWorkdirError } from '../../src/agent/branch.js';
import { createManagerHarness } from '../helpers/manager-harness.js';
import { makeAgent, makeConfig, makeTask } from '../helpers/fixtures.js';

const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const POST_APPROVE_GENERATION = 'feedfeedfeed';
const RECOVERY_READY_AT = '2000-01-01T00:00:00.000Z';

let tempDir: string;
let taskStore: TaskStore;
let lockManager: LockManager;
let eventBus: EventBus;
let manager: AgentManager;
let emitted: BaxianEvent[];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'bx-handlers-git-'));
  const config = makeConfig({
    review: { rounds: 3 },
    project: [{
      id: 'proj',
      repo: 'git@github.com:owner/repo.git',
      merge: null,
      agent: [[
        makeAgent(),
        makeAgent({ id: 'qa-1', runtime: 'codex', role: 'qa', workdir: '/tmp/qa' }),
      ]],
    }],
  });
  const harness = await createManagerHarness(tempDir, { config });
  ({ taskStore, lockManager, eventBus, manager, events: emitted } = harness);
  vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);
  vi.spyOn(manager, 'platformVerifyPrBinding').mockResolvedValue({
    ok: true, headSha: SHA1, branch: 'bx/task-1', targetBranch: 'main',
  });
  registerEventHandlers(eventBus, manager);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

function gitTask(over: Partial<TaskState> = {}): TaskState {
  const now = new Date().toISOString();
  const task = makeTask({
    description: 'd',
    phase: 'code',
    platformBinding: undefined,
    deliveryConfirmation: { phase: 'code', source: 'signal', at: now },
    signalToken: 'aaaa11112222',
    createdAt: now,
    updatedAt: now,
    ...over,
  });
  if (task.phase === undefined) delete task.deliveryConfirmation;
  else if (!Object.hasOwn(over, 'deliveryConfirmation')) {
    task.deliveryConfirmation = { phase: task.phase, source: 'signal', at: now };
  }
  return task;
}

function prCreated(data: Record<string, unknown>): BaxianEvent {
  return {
    id: '', type: 'pr.created', timestamp: new Date().toISOString(),
    projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
    data: { prNumber: 42, prUrl: 'https://x/pull/42', branch: 'bx/task-1', headSha: SHA1, ...data },
  };
}

function panePrCreated(data: Record<string, unknown> = {}): BaxianEvent {
  return prCreated({
    source: 'pane-signal',
    token: 'aaaa11112222',
    actorB64: Buffer.from('77', 'utf8').toString('base64url'),
    ...data,
  });
}

function paneSpecDone(data: Record<string, unknown> = {}): BaxianEvent {
  return {
    id: '', type: 'spec.ready', timestamp: new Date().toISOString(),
    projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
    data: {
      source: 'pane-signal',
      kind: 'spec-done',
      token: 'aaaa11112222',
      prNumber: 42,
      actorB64: Buffer.from('77', 'utf8').toString('base64url'),
      ...data,
    },
  };
}

function asReturned(
  result: { kind: string } | { kind: string; task: TaskState },
): TaskState | null {
  return 'task' in result && result.kind === 'returned' ? result.task : null;
}

function gitVerdict(data: Record<string, unknown>): Record<string, unknown> {
  return {
    source: 'platform-poller',
    action: 'APPROVE',
    reviewPassToken: 'ffff00001111',
    verdictToken: 'abcdef123456',
    headSha: SHA1,
    currentHeadSha: SHA1,
    prNumber: 42,
    prUrl: 'https://x/pull/42',
    branch: 'bx/task-1',
    verdictCarrier: { sourceKey: 'reviews', id: 'r1', bodyDigest: 'f'.repeat(64) },
    ...data,
  };
}

function postApproveEpisode(data: Partial<TaskState> = {}): Partial<TaskState> {
  return {
    postApproveGeneration: POST_APPROVE_GENERATION,
    postApproveHeadSha: SHA1,
    postApproveToken: 'tok123456789',
    postApprovePhase: 'installed',
    updatedAt: RECOVERY_READY_AT,
    ...data,
  };
}

function reviewDispatch(effectiveRound: number) {
  return {
    generation: 'decafdecaf12',
    phase: 'pending' as const,
    qaPhase: 'recheck' as const,
    signalToken: 'ffff00001111',
    headSha: SHA1,
    passToken: 'abcdef123456',
    failToken: '123456abcdef',
    effectiveRound,
    updatedAt: new Date().toISOString(),
  };
}

function gitSpecReviewTask(over: Partial<TaskState> = {}): TaskState {
  return gitTask({
    status: 'review',
    phase: 'spec',
    prNumber: 42,
    signalToken: 'ffff00001111',
    passToken: 'abcdef123456',
    failToken: '123456abcdef',
    latestHeadSha: SHA1,
    reviewHeadAnchorSha: SHA1,
    specReviewRound: 1,
    reviewRound: 0,
    reviewDispatch: reviewDispatch(1),
    ...over,
  });
}

describe('pr.created (git, poller source)', () => {
  it('records discovery but never creates a review lease when phase and token are missing', async () => {
    await taskStore.set(gitTask({ phase: undefined, signalToken: undefined }));
    const begin = vi.spyOn(manager, 'beginGitReviewPass');
    const dispatchSpy = vi.spyOn(manager, 'dispatchGitReviewLease');

    await eventBus.emit(prCreated({ targetBranch: 'main', prAuthorId: '99' }));

    const task = await taskStore.get('task-1');
    expect(task).toMatchObject({
      status: 'in_progress', prNumber: 42, latestHeadSha: SHA1,
    });
    expect(task?.phase).toBeUndefined();
    expect(task?.signalToken).toBeUndefined();
    expect(begin).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('records a base snapshot and provisional actor, then no-ops on replay without starting review', async () => {
    await taskStore.set(gitTask({ qaAgentId: 'qa-1' }));
    const begin = vi.spyOn(manager, 'beginGitReviewPass');
    await eventBus.emit(prCreated({ targetBranch: 'main', prAuthorId: '99' }));
    let task = await taskStore.get('task-1');
    expect(task).toMatchObject({
      status: 'in_progress', prNumber: 42, baseBranch: 'main',
      replyActorId: '99', replyActorStatus: 'provisional',
      latestHeadSha: SHA1,
    });
    expect(task?.reviewHeadAnchorSha).toBeUndefined();
    expect(task?.reviewDispatch).toBeUndefined();
    await eventBus.emit(prCreated({ targetBranch: 'main', prAuthorId: '99' }));
    task = await taskStore.get('task-1');
    expect(task?.status).toBe('in_progress');
    expect(begin).not.toHaveBeenCalled();
  });

  it('adopts without actor fields when the row carried no author id', async () => {
    await taskStore.set(gitTask());
    await eventBus.emit(prCreated({ targetBranch: 'main' }));
    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('in_progress');
    expect(task?.replyActorId).toBeUndefined();
    expect(task?.replyActorStatus).toBeUndefined();
  });

  it('records a fixing-task observation without creating or dispatching a review lease', async () => {
    await taskStore.set(gitTask({ status: 'fixing', qaAgentId: 'qa-1', reviewRound: 1 }));
    const dispatch = vi.spyOn(manager, 'dispatchGitReviewLease').mockImplementation(async () =>
      (await taskStore.get('task-1'))!);

    await eventBus.emit(prCreated({ targetBranch: 'main', prAuthorId: '99' }));

    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('fixing');
    expect(task?.reviewDispatch).toBeUndefined();
    expect(task?.reviewRoundPending).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('falls back to an authoritative PR read when the creation event has no head', async () => {
    await taskStore.set(gitTask());
    const verify = vi.spyOn(manager, 'platformVerifyPrBinding').mockResolvedValue({
      ok: true, headSha: SHA2, branch: 'bx/task-1', targetBranch: 'main',
    });

    await eventBus.emit(prCreated({ headSha: undefined, targetBranch: 'main' }));

    expect(verify).toHaveBeenCalledWith('task-1', 42);
    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'in_progress', latestHeadSha: SHA2,
    });
    expect((await taskStore.get('task-1'))?.reviewHeadAnchorSha).toBeUndefined();
  });

  it('reports a creation event whose head cannot be recovered authoritatively', async () => {
    await taskStore.set(gitTask());
    vi.spyOn(manager, 'platformVerifyPrBinding').mockResolvedValue({ ok: false, reason: 'head' });

    await eventBus.emit(prCreated({ headSha: undefined, targetBranch: 'main' }));

    expect((await taskStore.get('task-1'))?.status).toBe('in_progress');
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'git-review-head-unavailable',
    });
  });
});

describe('pr.merged (git)', () => {
  it('transitions its tracked PR to merged and runs cleanup', async () => {
    await taskStore.set(gitTask({ status: 'merge-ready', reviewRound: 1, prNumber: 42 }));
    const cleanup = vi.spyOn(manager, 'cleanupAfterMerge').mockResolvedValue();

    await eventBus.emit({
      id: '', type: 'pr.merged', timestamp: new Date().toISOString(),
      projectId: 'proj', taskId: 'task-1',
      data: { prNumber: 42, prUrl: 'https://x/pull/42', branch: 'bx/task-1' },
    });

    expect((await taskStore.get('task-1'))?.status).toBe('merged');
    expect(cleanup).toHaveBeenCalledWith('task-1');
  });

  it('dispatches post-merge cleanup to the snapshotted QA', async () => {
    await taskStore.set(gitTask({
      status: 'merge-ready', reviewRound: 1, prNumber: 42, qaAgentId: 'qa-1',
    }));
    vi.spyOn(manager, 'cleanupAfterMerge').mockResolvedValue();
    const dispatch = vi.spyOn(manager, 'dispatchPostMergeCleanup').mockResolvedValue();

    await eventBus.emit({
      id: '', type: 'pr.merged', timestamp: new Date().toISOString(),
      projectId: 'proj', taskId: 'task-1',
      data: { prNumber: 42, branch: 'bx/task-1' },
    });

    expect(dispatch).toHaveBeenCalledWith('qa-1', { taskId: 'task-1', branch: 'bx/task-1' });
  });

  it('persistently fails a premature tracked-PR merge, clears its review lease, and stops its watcher', async () => {
    await taskStore.set(gitTask({
      status: 'review',
      reviewRound: 1,
      prNumber: 42,
      signalToken: 'ffff00001111',
      passToken: 'abcdef123456',
      failToken: '123456abcdef',
      latestHeadSha: SHA1,
      reviewHeadAnchorSha: SHA1,
      reviewDispatch: reviewDispatch(1),
    }));
    const cleanup = vi.spyOn(manager, 'cleanupAfterMerge').mockResolvedValue();
    const stopWatcher = vi.spyOn(manager, 'stopPhaseSignalWatcher');
    const settleParticipants = vi.spyOn(manager, 'cancelTask');

    await eventBus.emit({
      id: '', type: 'pr.merged', timestamp: new Date().toISOString(),
      projectId: 'proj', taskId: 'task-1',
      data: { prNumber: 42, branch: 'bx/task-1' },
    });

    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'failed',
      prNumber: 42,
    });
    expect((await taskStore.get('task-1'))?.reviewDispatch).toBeUndefined();
    expect(stopWatcher).toHaveBeenCalledOnce();
    expect(stopWatcher).toHaveBeenCalledWith('task-1');
    expect(settleParticipants).toHaveBeenCalledWith('task-1');
    expect(cleanup).not.toHaveBeenCalled();
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'pr-merged-outside-merge-ready', status: 'review', prNumber: 42,
    });

    await eventBus.emit({
      id: '', type: 'review.submitted', timestamp: new Date().toISOString(),
      projectId: 'proj', taskId: 'task-1',
      data: gitVerdict({ action: 'APPROVE' }),
    });

    expect((await taskStore.get('task-1'))?.status).toBe('failed');
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('keeps the watcher armed when persisting the premature-merge block fails', async () => {
    await taskStore.set(gitTask({ status: 'review', reviewRound: 1, prNumber: 42 }));
    const stopWatcher = vi.spyOn(manager, 'stopPhaseSignalWatcher');
    const settleParticipants = vi.spyOn(manager, 'cancelTask');
    vi.spyOn(manager, 'transitionTaskStatus').mockRejectedValueOnce(new Error('task store down'));

    await expect(eventBus.emit({
      id: '', type: 'pr.merged', timestamp: new Date().toISOString(),
      projectId: 'proj', taskId: 'task-1',
      data: { prNumber: 42, branch: 'bx/task-1' },
    })).rejects.toThrow('task store down');

    expect((await taskStore.get('task-1'))?.status).toBe('review');
    expect(stopWatcher).not.toHaveBeenCalled();
    expect(settleParticipants).not.toHaveBeenCalled();
  });

  it('reports participant cleanup failure after the premature-merge block is durable', async () => {
    await taskStore.set(gitTask({ status: 'fixing', reviewRound: 1, prNumber: 42 }));
    vi.spyOn(manager, 'cancelTask').mockRejectedValue(new Error('pane cleanup failed'));

    await eventBus.emit({
      id: '', type: 'pr.merged', timestamp: new Date().toISOString(),
      projectId: 'proj', taskId: 'task-1',
      data: { prNumber: 42, branch: 'bx/task-1' },
    });

    expect((await taskStore.get('task-1'))?.status).toBe('failed');
    expect(emitted.find(event =>
      event.type === 'human.intervention'
      && event.data.phase === 'premature-merge-participant-cleanup-failed')?.data,
    ).toMatchObject({
      participants: ['dev-1', 'qa-1'],
      errors: ['pane cleanup failed'],
    });
  });

  it('reports a task lock left behind after participant bindings were cleared', async () => {
    await taskStore.set(gitTask({ status: 'review', reviewRound: 1, prNumber: 42 }));
    await lockManager.acquire('dev-1', 'task-1');

    await eventBus.emit({
      id: '', type: 'pr.merged', timestamp: new Date().toISOString(),
      projectId: 'proj', taskId: 'task-1',
      data: { prNumber: 42, branch: 'bx/task-1' },
    });

    expect(await lockManager.acquire('dev-1', 'task-next')).toBeNull();
    expect(emitted.find(event =>
      event.type === 'human.intervention'
      && event.data.phase === 'premature-merge-participant-cleanup-failed')?.data,
    ).toMatchObject({
      participants: ['dev-1', 'qa-1'],
      remainingParticipants: ['dev-1'],
      errors: ['dev-1: exclusive lock still owned by task task-1'],
    });
  });

  it('reports a lock ownership probe failure instead of assuming cleanup succeeded', async () => {
    await taskStore.set(gitTask({ status: 'approved', reviewRound: 1, prNumber: 42 }));
    vi.spyOn(manager, 'getAgentLockOwner')
      .mockRejectedValueOnce(new Error('lock store unavailable'))
      .mockResolvedValueOnce(null);

    await eventBus.emit({
      id: '', type: 'pr.merged', timestamp: new Date().toISOString(),
      projectId: 'proj', taskId: 'task-1',
      data: { prNumber: 42, branch: 'bx/task-1' },
    });

    expect(emitted.find(event =>
      event.type === 'human.intervention'
      && event.data.phase === 'premature-merge-participant-cleanup-failed')?.data,
    ).toMatchObject({
      remainingParticipants: ['dev-1'],
      errors: ['dev-1: lock probe failed: lock store unavailable'],
    });
  });

  it('does not overwrite a PR binding that changes inside the premature-merge CAS', async () => {
    await taskStore.set(gitTask({
      status: 'review',
      reviewRound: 1,
      prNumber: undefined,
    }));
    const transition = manager.transitionTaskStatus.bind(manager);
    vi.spyOn(manager, 'transitionTaskStatus').mockImplementationOnce(async (...args) => {
      const current = (await taskStore.get('task-1'))!;
      await taskStore.set({
        ...current,
        prNumber: 73,
        updatedAt: new Date().toISOString(),
      });
      return transition(...args);
    });
    const settleParticipants = vi.spyOn(manager, 'cancelTask');

    await eventBus.emit({
      id: '', type: 'pr.merged', timestamp: new Date().toISOString(),
      projectId: 'proj', taskId: 'task-1',
      data: { prNumber: 42, branch: 'bx/task-1' },
    });

    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'review',
      prNumber: 73,
    });
    expect(settleParticipants).not.toHaveBeenCalled();
    expect(emitted.find(event =>
      event.type === 'human.intervention'
      && event.data.phase === 'pr-merged-status-race')?.data,
    ).toMatchObject({
      reason: 'pr-binding-changed',
      boundPrNumber: 73,
      prNumber: 42,
    });
  });

  it('does not accept a merge-ready fallback after the PR binding changes', async () => {
    await taskStore.set(gitTask({
      status: 'review',
      reviewRound: 1,
      prNumber: undefined,
    }));
    const transition = vi.spyOn(manager, 'transitionTaskStatus').mockImplementationOnce(async () => {
      const current = (await taskStore.get('task-1'))!;
      await taskStore.set({
        ...current,
        status: 'merge-ready',
        prNumber: 73,
        updatedAt: new Date().toISOString(),
      });
      return null;
    });
    const cleanup = vi.spyOn(manager, 'cleanupAfterMerge').mockResolvedValue();

    await eventBus.emit({
      id: '', type: 'pr.merged', timestamp: new Date().toISOString(),
      projectId: 'proj', taskId: 'task-1',
      data: { prNumber: 42, branch: 'bx/task-1' },
    });

    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'merge-ready',
      prNumber: 73,
    });
    expect(transition).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('accepts a racing move to merge-ready instead of overwriting it with the premature-merge block', async () => {
    await taskStore.set(gitTask({ status: 'review', reviewRound: 1, prNumber: 42 }));
    const cleanup = vi.spyOn(manager, 'cleanupAfterMerge').mockResolvedValue();
    vi.spyOn(manager, 'transitionTaskStatus').mockImplementationOnce(async () => {
      const current = (await taskStore.get('task-1'))!;
      await taskStore.set({
        ...current,
        status: 'merge-ready',
        updatedAt: new Date().toISOString(),
      });
      return null;
    });

    await eventBus.emit({
      id: '', type: 'pr.merged', timestamp: new Date().toISOString(),
      projectId: 'proj', taskId: 'task-1',
      data: { prNumber: 42, branch: 'bx/task-1' },
    });

    expect((await taskStore.get('task-1'))?.status).toBe('merged');
    expect(cleanup).toHaveBeenCalledWith('task-1');
    expect(emitted.find(event => event.type === 'human.intervention')).toBeUndefined();
  });

  it.each(['failed', 'cancelled'] as const)(
    'keeps a tracked PR merge in %s as an intervention instead of rewriting task history',
    async (status) => {
      await taskStore.set(gitTask({ status, prNumber: 42 }));
      const cleanup = vi.spyOn(manager, 'cleanupAfterMerge').mockResolvedValue();

      await eventBus.emit({
        id: '', type: 'pr.merged', timestamp: new Date().toISOString(),
        projectId: 'proj', taskId: 'task-1',
        data: { prNumber: 42, branch: 'bx/task-1' },
      });

      expect((await taskStore.get('task-1'))?.status).toBe(status);
      expect(cleanup).not.toHaveBeenCalled();
      expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
        phase: 'pr-merged-outside-merge-ready', status, prNumber: 42,
      });
    },
  );

  it.each(['merged', 'done'] as const)('treats a replay for a terminal %s task as a no-op', async (status) => {
    await taskStore.set(gitTask({ status, prNumber: 42 }));
    const cleanup = vi.spyOn(manager, 'cleanupAfterMerge').mockResolvedValue();

    await eventBus.emit({
      id: '', type: 'pr.merged', timestamp: new Date().toISOString(),
      projectId: 'proj', taskId: 'task-1',
      data: { prNumber: 42, branch: 'bx/task-1' },
    });

    expect((await taskStore.get('task-1'))?.status).toBe(status);
    expect(cleanup).not.toHaveBeenCalled();
    expect(emitted.find(event => event.type === 'human.intervention')).toBeUndefined();
  });

  it('reports a merged event that arrives after the task PR binding changed', async () => {
    await taskStore.set(gitTask({ prNumber: 42, branch: 'feature/reused', branchCreatedByBaxian: false }));
    const cleanup = vi.spyOn(manager, 'cleanupAfterMerge').mockResolvedValue();

    await eventBus.emit({
      id: '', type: 'pr.merged', timestamp: new Date().toISOString(),
      projectId: 'proj', taskId: 'task-1',
      data: { prNumber: 99, branch: 'feature/reused' },
    });

    expect((await taskStore.get('task-1'))?.status).toBe('in_progress');
    expect(cleanup).not.toHaveBeenCalled();
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'pr-merged-status-race',
      status: 'in_progress',
      reason: 'pr-binding-changed',
      boundPrNumber: 42,
      prNumber: 99,
    });
  });

  it('reports an unbound custom-branch merge that cannot be attributed', async () => {
    await taskStore.set(gitTask({
      prNumber: undefined,
      branch: 'feature/reused',
      branchCreatedByBaxian: false,
    }));
    const cleanup = vi.spyOn(manager, 'cleanupAfterMerge').mockResolvedValue();

    await eventBus.emit({
      id: '', type: 'pr.merged', timestamp: new Date().toISOString(),
      projectId: 'proj', taskId: 'task-1',
      data: { prNumber: 99, branch: 'feature/reused' },
    });

    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'in_progress',
      branch: 'feature/reused',
    });
    expect((await taskStore.get('task-1'))?.prNumber).toBeUndefined();
    expect(cleanup).not.toHaveBeenCalled();
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'pr-merged-status-race',
      status: 'in_progress',
      reason: 'pr-binding-unconfirmed',
      prNumber: 99,
    });
  });
});

describe('pr.created (git, pane signal)', () => {
  it('verifies via the platform predicate and records a verified self-reported actor', async () => {
    await taskStore.set(gitTask({ pendingPrSignalToken: 'aaaa11112222' }));
    vi.spyOn(manager, 'platformVerifyPrBinding').mockResolvedValue({
      ok: true, headSha: SHA1, branch: 'bx/task-1', targetBranch: 'main',
    });
    await eventBus.emit(prCreated({
      source: 'pane-signal', token: 'aaaa11112222',
      actorB64: Buffer.from('77', 'utf8').toString('base64url'),
    }));
    const task = await taskStore.get('task-1');
    expect(task).toMatchObject({
      status: 'review', baseBranch: 'main', replyActorId: '77', replyActorStatus: 'verified',
    });
    expect(task?.pendingPrSignalToken).toBeUndefined();
  });

  it('keeps actor fields unset when the signal has no valid actor segment (fail closed)', async () => {
    await taskStore.set(gitTask());
    vi.spyOn(manager, 'platformVerifyPrBinding').mockResolvedValue({
      ok: true, headSha: SHA1, branch: 'bx/task-1', targetBranch: 'main',
    });
    await eventBus.emit(prCreated({ source: 'pane-signal', token: 'aaaa11112222' }));
    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('in_progress');
    expect(task?.replyActorStatus).toBeUndefined();
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'git-pr-delivery-actor-missing',
    });
  });

  it('rejects a predicate mismatch to intervention instead of adopting', async () => {
    await taskStore.set(gitTask());
    vi.spyOn(manager, 'platformVerifyPrBinding').mockResolvedValue({ ok: false, reason: 'draft' });
    await eventBus.emit(panePrCreated());
    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('in_progress');
    const intervention = emitted.find(e => e.type === 'human.intervention');
    expect(intervention?.data).toMatchObject({ phase: 'pane-pr-created-branch-mismatch', reason: 'draft' });
  });

  it('re-arms the develop watcher when platform verification throws', async () => {
    await taskStore.set(gitTask());
    vi.spyOn(manager, 'platformVerifyPrBinding').mockRejectedValue(new Error('platform offline'));
    const rearm = vi.spyOn(manager, 'setupPhaseSignal').mockResolvedValue(true);

    await eventBus.emit(panePrCreated());

    expect(rearm).toHaveBeenCalledWith('task-1', 'dev-1', ['pr-created'], { skipSnapshot: true });
    expect(emitted.find(e => e.type === 'human.intervention')?.data).toMatchObject({
      phase: 'pane-pr-created-verify-error',
      error: 'platform offline',
    });
    expect((await taskStore.get('task-1'))?.status).toBe('in_progress');
  });

  it('re-arms on a live transition race but stays silent after the task becomes terminal', async () => {
    await taskStore.set(gitTask());
    vi.spyOn(manager, 'platformVerifyPrBinding').mockResolvedValue({
      ok: true, headSha: SHA1, branch: 'bx/task-1', targetBranch: 'main',
    });
    vi.spyOn(manager, 'beginGitReviewPass').mockResolvedValue(null);
    const rearm = vi.spyOn(manager, 'setupPhaseSignal').mockResolvedValue(true);

    await eventBus.emit(panePrCreated());
    expect(rearm).toHaveBeenCalledTimes(1);
    expect(emitted.find(e => e.type === 'human.intervention')?.data).toMatchObject({
      phase: 'pane-pr-created-transition-failed',
    });

    await taskStore.set(gitTask({ status: 'cancelled' }));
    emitted.length = 0;
    rearm.mockClear();
    await eventBus.emit(panePrCreated());
    expect(rearm).not.toHaveBeenCalled();
    expect(emitted.find(e => e.type === 'human.intervention')).toBeUndefined();
  });

  it('accepts a valid custom branch only when it is already owned by the same task', async () => {
    await taskStore.set(gitTask({ branch: 'feature/owned' }));
    const verify = vi.spyOn(manager, 'platformVerifyPrBinding')
      .mockResolvedValueOnce({ ok: false, reason: 'branch', prBranch: 'feature/owned' })
      .mockResolvedValueOnce({
        ok: true, headSha: SHA1, branch: 'feature/owned', targetBranch: 'main',
      });

    await eventBus.emit(panePrCreated());

    expect(verify).toHaveBeenNthCalledWith(2, 'task-1', 42, { branchOverride: 'feature/owned' });
    expect((await taskStore.get('task-1'))).toMatchObject({ status: 'review', branch: 'feature/owned' });
  });

  it.each(['bx/task-foreign', 'invalid..branch'])(
    'refuses an unowned or invalid branch fallback: %s',
    async (prBranch) => {
      await taskStore.set(gitTask());
      const verify = vi.spyOn(manager, 'platformVerifyPrBinding')
        .mockResolvedValue({ ok: false, reason: 'branch', prBranch });

      await eventBus.emit(panePrCreated());

      expect(verify).toHaveBeenCalledTimes(1);
      expect((await taskStore.get('task-1'))?.status).toBe('in_progress');
      expect(emitted.find(e => e.type === 'human.intervention')?.data).toMatchObject({
        phase: 'pane-pr-created-branch-mismatch', reason: 'branch',
      });
    },
  );
});

describe('spec.ready (git delivery)', () => {
  it('lets poller discovery enrich the task without starting review, then confirms spec delivery from the signal', async () => {
    await taskStore.set(gitTask({
      phase: undefined,
      pendingPrSignalToken: 'aaaa11112222',
    }));
    const begin = vi.spyOn(manager, 'beginGitReviewPass');
    const dispatch = vi.spyOn(manager, 'dispatchGitReviewLease').mockImplementation(async () =>
      (await taskStore.get('task-1'))!);

    await eventBus.emit(prCreated({ targetBranch: 'main', prAuthorId: '99' }));
    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'in_progress',
      prNumber: 42,
      replyActorId: '99',
      replyActorStatus: 'provisional',
    });
    expect(begin).not.toHaveBeenCalled();

    await eventBus.emit(paneSpecDone());

    const task = await taskStore.get('task-1');
    expect(task).toMatchObject({
      status: 'review',
      phase: 'spec',
      prNumber: 42,
      replyActorId: '77',
      replyActorStatus: 'verified',
      deliveryConfirmation: { phase: 'spec', source: 'signal' },
      reviewRound: 0,
      reviewDispatch: {
        phase: 'pending',
        qaPhase: 'review',
        effectiveRound: 1,
      },
    });
    expect(task?.specReviewRound ?? 0).toBe(0);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(begin).toHaveBeenCalledWith('task-1', expect.objectContaining({
      fromStatus: ['in_progress'],
      bumpRound: true,
      qaPhase: 'review',
      expectPhase: 'spec',
    }));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate the spec review pass when the pane signal arrives before poller discovery', async () => {
    await taskStore.set(gitTask({
      phase: undefined,
      pendingPrSignalToken: 'aaaa11112222',
    }));
    const begin = vi.spyOn(manager, 'beginGitReviewPass');
    const dispatch = vi.spyOn(manager, 'dispatchGitReviewLease').mockImplementation(async () =>
      (await taskStore.get('task-1'))!);

    await eventBus.emit(paneSpecDone());
    const first = await taskStore.get('task-1');
    expect(first).toMatchObject({ status: 'review', phase: 'spec', prNumber: 42 });
    const generation = first?.reviewDispatch?.generation;

    await eventBus.emit(prCreated({ targetBranch: 'main', prAuthorId: '99' }));

    const replayed = await taskStore.get('task-1');
    expect(replayed?.reviewDispatch?.generation).toBe(generation);
    expect(replayed?.replyActorId).toBe('77');
    expect(replayed?.replyActorStatus).toBe('verified');
    expect(begin).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('blocks a merge observed before spec delivery and never starts a review pass', async () => {
    await taskStore.set(gitTask({
      phase: undefined,
      pendingPrSignalToken: 'aaaa11112222',
    }));
    const begin = vi.spyOn(manager, 'beginGitReviewPass');
    await eventBus.emit(prCreated({ targetBranch: 'main', prAuthorId: '99' }));

    await eventBus.emit({
      id: '', type: 'pr.merged', timestamp: new Date().toISOString(),
      projectId: 'proj', taskId: 'task-1',
      data: { prNumber: 42, branch: 'bx/task-1' },
    });

    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('failed');
    expect(task?.phase).toBeUndefined();
    expect(begin).not.toHaveBeenCalled();
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'pr-merged-outside-merge-ready',
      status: 'in_progress',
      prNumber: 42,
    });
  });
});

describe('actor reconciliation on a late publish signal', () => {
  it('verifies the provisional actor after poller adoption rotated the review token', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1',
      signalToken: 'ffff00001111',
      pendingPrSignalToken: 'aaaa11112222',
      replyActorId: '99', replyActorStatus: 'provisional',
      baseBranch: 'main',
    }));
    const stopAgent = vi.spyOn(manager, 'stopPhaseSignalWatcherAgent');
    await eventBus.emit(prCreated({
      source: 'pane-signal', token: 'aaaa11112222',
      actorB64: Buffer.from('77', 'utf8').toString('base64url'),
    }));
    const task = await taskStore.get('task-1');
    expect(task).toMatchObject({ replyActorId: '77', replyActorStatus: 'verified' });
    expect(task?.pendingPrSignalToken).toBeUndefined();
    expect(stopAgent).toHaveBeenCalledWith('task-1', 'dev-1');
  });

  it('ignores a reconciliation attempt whose token does not match the persisted expectation', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, signalToken: 'ffff00001111',
      pendingPrSignalToken: 'aaaa11112222',
      replyActorId: '99', replyActorStatus: 'provisional',
    }));
    await eventBus.emit(prCreated({
      source: 'pane-signal', token: 'ffff00001111',
      actorB64: Buffer.from('66', 'utf8').toString('base64url'),
    }));
    const task = await taskStore.get('task-1');
    expect(task).toMatchObject({ replyActorId: '99', replyActorStatus: 'provisional' });
  });

  it('is a no-op when the actor is already verified', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, signalToken: 'ffff00001111',
      pendingPrSignalToken: 'aaaa11112222',
      replyActorId: '77', replyActorStatus: 'verified',
    }));
    const updateSpy = vi.spyOn(manager, 'updateTask');
    await eventBus.emit(prCreated({
      source: 'pane-signal', token: 'aaaa11112222',
      actorB64: Buffer.from('55', 'utf8').toString('base64url'),
    }));
    expect(updateSpy).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.replyActorId).toBe('77');
  });

  it('does not let a wrong-stage pane signal consume the code-stage actor reconciliation token', async () => {
    await taskStore.set(gitTask({
      status: 'review',
      phase: 'code',
      prNumber: 42,
      signalToken: 'ffff00001111',
      pendingPrSignalToken: 'aaaa11112222',
      replyActorId: '99',
      replyActorStatus: 'provisional',
    }));
    const update = vi.spyOn(manager, 'updateTask');

    await eventBus.emit(paneSpecDone());

    expect(update).not.toHaveBeenCalled();
    expect(await taskStore.get('task-1')).toMatchObject({
      phase: 'code',
      pendingPrSignalToken: 'aaaa11112222',
      replyActorId: '99',
      replyActorStatus: 'provisional',
    });
  });
});

describe('review.submitted (git)', () => {
  function reviewSubmitted(data: Record<string, unknown>): BaxianEvent {
    return {
      id: '', type: 'review.submitted', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'qa-1', taskId: 'task-1',
      data,
    };
  }

  it('rejects pane-sourced verdicts outright', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1',
      signalToken: 'aaaa11112222', latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1,
    }));
    await eventBus.emit(reviewSubmitted({ action: 'APPROVE', source: 'pane-signal', token: 'aaaa11112222' }));
    expect((await taskStore.get('task-1'))?.status).toBe('review');
    expect(emitted.find(e => e.type === 'human.intervention')).toBeUndefined();
  });

  it('rejects an incomplete verdict that bypasses the platform engine', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1',
      signalToken: 'ffff00001111', passToken: 'abcdef123456', failToken: '123456abcdef',
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1, reviewRound: 1,
    }));

    await eventBus.emit(reviewSubmitted({
      action: 'APPROVE', prNumber: 42, reviewPassToken: 'ffff00001111',
    }));

    expect((await taskStore.get('task-1'))?.status).toBe('review');
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'git-verdict-payload-invalid',
      error: expect.stringContaining('invalid source'),
    });
  });

  it('auto-redispatches a stale verdict when the QA session does not own the current pass', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42,
      signalToken: 'ffff00001111', passToken: 'abcdef123456', failToken: '123456abcdef',
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1, reviewRound: 1,
    }));
    const dispatch = vi.spyOn(manager, 'dispatchReviewToQa').mockResolvedValue(undefined);

    await eventBus.emit(reviewSubmitted(gitVerdict({
      action: 'REQUEST_CHANGES', reviewPassToken: 'eeeeeeeeeeee', verdictToken: '123456abcdef',
    })));

    expect(dispatch).toHaveBeenCalledWith('task-1', {
      fromStatus: ['review'], bumpRound: false, expectPhase: 'code', expectSignalToken: 'ffff00001111',
    });
    expect(emitted.find(event => event.type === 'human.intervention')).toBeUndefined();
  });

  it('rejects a verdict submitted before the current review pass freshness window', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1',
      signalToken: 'ffff00001111', passToken: 'abcdef123456', failToken: '123456abcdef',
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1, reviewRound: 1,
      reviewDispatchedAt: '2026-07-21T12:00:10.000Z',
    }));
    vi.spyOn(manager, 'getAgentState').mockResolvedValue({ taskId: 'task-1' } as never);

    await eventBus.emit(reviewSubmitted(gitVerdict({
      action: 'REQUEST_CHANGES', verdictToken: '123456abcdef',
      submittedAt: '2026-07-21T12:00:00.000Z',
    })));

    expect((await taskStore.get('task-1'))?.status).toBe('review');
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'stale-verdict-superseded-pass',
    });
  });

  it('trusts the engine payload and persists pass provenance on approval', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1',
      signalToken: 'ffff00001111', passToken: 'abcdef123456', failToken: '123456abcdef',
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1, reviewRound: 1,
      replyActorId: '77', replyActorStatus: 'verified',
    }));
    await eventBus.emit(reviewSubmitted(gitVerdict({})));
    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('approved');
    expect(task?.passProvenance).toEqual({
      sourceKey: 'reviews', id: 'r1', bodyDigest: 'f'.repeat(64),
      token: 'abcdef123456', failToken: '123456abcdef', anchorSha: SHA1,
    });
  });

  it('keeps review unchanged when an approval was issued for a stale head', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1',
      signalToken: 'ffff00001111', passToken: 'abcdef123456', failToken: '123456abcdef',
      latestHeadSha: SHA2, reviewHeadAnchorSha: SHA1, reviewRound: 1,
    }));
    const approve = vi.spyOn(manager, 'approveGitReviewPass');

    await eventBus.emit(reviewSubmitted(gitVerdict({ currentHeadSha: SHA2 })));

    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'review', latestHeadSha: SHA2, reviewHeadAnchorSha: SHA1,
      signalToken: 'ffff00001111',
    });
    expect(approve).not.toHaveBeenCalled();
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'stale-approval-head-mismatch', reviewedHeadSha: SHA1, currentHeadSha: SHA2,
    });
  });

  it('keeps review unchanged when request-changes was issued for a stale head', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1',
      signalToken: 'ffff00001111', passToken: 'abcdef123456', failToken: '123456abcdef',
      latestHeadSha: SHA2, reviewHeadAnchorSha: SHA1, reviewRound: 1,
    }));
    const transition = vi.spyOn(manager, 'transitionTaskStatus');
    const release = vi.spyOn(manager, 'releaseAgentForTask');

    await eventBus.emit(reviewSubmitted(gitVerdict({
      action: 'REQUEST_CHANGES', verdictToken: '123456abcdef', currentHeadSha: SHA2,
    })));

    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'review', reviewRound: 1, signalToken: 'ffff00001111',
    });
    expect(transition).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'stale-request-changes-head-mismatch', reviewedHeadSha: SHA1, currentHeadSha: SHA2,
    });
  });

  it('APPROVE 原子消费 durable reviewDispatch lease', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1',
      signalToken: 'ffff00001111', passToken: 'abcdef123456', failToken: '123456abcdef',
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1, reviewRound: 1,
      reviewDispatch: reviewDispatch(1),
    }));
    await eventBus.emit(reviewSubmitted(gitVerdict({})));
    const task = await taskStore.get('task-1');
    expect(task).toMatchObject({
      status: 'approved',
      reviewRound: 1,
      postApproveHeadSha: SHA1,
      postApprovePhase: 'installed',
      pendingRedispatch: true,
      redispatchCount: 0,
    });
    expect(task?.postApproveGeneration).toMatch(/^[0-9a-f]{12}$/);
    expect(task?.postApproveToken).toMatch(/^[0-9a-f]{12}$/);
    expect(task?.postApproveToken).not.toBe(task?.postApproveGeneration);
    expect(task?.reviewDispatch).toBeUndefined();
  });

  it('REQUEST_CHANGES 原子消费 durable reviewDispatch lease', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1',
      signalToken: 'ffff00001111', failToken: '123456abcdef',
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1, reviewRound: 1,
      passToken: 'abcdef123456', reviewDispatch: reviewDispatch(1),
    }));
    vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(false);
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'rotateAndSetupPhaseSignal').mockResolvedValue({ token: 'eeee11112222', armed: true });
    vi.spyOn(manager, 'continueSession').mockResolvedValue(true);
    await eventBus.emit(reviewSubmitted(gitVerdict({
      action: 'REQUEST_CHANGES', verdictToken: '123456abcdef',
      verdictCarrier: { sourceKey: 'reviews', id: 'r2', bodyDigest: 'a'.repeat(64) },
    })));
    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('fixing');
    expect(task?.reviewDispatch).toBeUndefined();
    expect(emitted.find(event => event.type === 'human.intervention')).toBeUndefined();
  });

  it('max_rounds 原子消费 durable reviewDispatch lease', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1',
      signalToken: 'ffff00001111', failToken: '123456abcdef',
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1, reviewRound: 3,
      passToken: 'abcdef123456', reviewDispatch: reviewDispatch(3),
    }));
    vi.spyOn(manager, 'getAgentState').mockResolvedValue({ taskId: 'task-1' } as never);
    const release = vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    await eventBus.emit(reviewSubmitted(gitVerdict({
      action: 'REQUEST_CHANGES', verdictToken: '123456abcdef',
      verdictCarrier: { sourceKey: 'reviews', id: 'r3', bodyDigest: 'b'.repeat(64) },
    })));
    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('max_rounds');
    expect(task?.reviewDispatch).toBeUndefined();
    expect(release).toHaveBeenCalledWith('qa-1', 'task-1', 'idle', { allowAwaitingHuman: true });
    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'review.max_rounds',
      data: expect.objectContaining({ phase: 'code', reviewRound: 3 }),
    }));
  });

  it('parks an approved spec for human approval without consuming a code review round', async () => {
    vi.spyOn(manager, 'getProjectConfig').mockReturnValue({
      ...manager.getConfig().project[0]!,
      specApproval: 'human',
    });
    vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    await taskStore.set(gitSpecReviewTask());

    await eventBus.emit(reviewSubmitted(gitVerdict({})));

    const task = await taskStore.get('task-1');
    expect(task).toMatchObject({
      status: 'spec-ready',
      phase: 'spec',
      specReviewRound: 1,
      reviewRound: 0,
      passProvenance: {
        sourceKey: 'reviews',
        id: 'r1',
        bodyDigest: 'f'.repeat(64),
        token: 'abcdef123456',
        failToken: '123456abcdef',
        anchorSha: SHA1,
      },
    });
    expect(task?.reviewDispatch).toBeUndefined();
  });

  it('routes an approved spec directly into the code phase when human approval is disabled', async () => {
    const codeTask = gitTask({
      status: 'in_progress',
      phase: 'code',
      specReviewRound: 1,
      reviewRound: 0,
    });
    const transition = vi.spyOn(manager, 'transitionToCodePhase').mockResolvedValue(codeTask);
    const approveCode = vi.spyOn(manager, 'approveGitReviewPass');
    await taskStore.set(gitSpecReviewTask());

    await eventBus.emit(reviewSubmitted(gitVerdict({})));

    expect(manager.platformVerifyPrBinding).toHaveBeenCalledWith('task-1', 42);
    expect(transition).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'review',
        phase: 'spec',
        signalToken: 'ffff00001111',
        specReviewRound: 1,
        reviewRound: 0,
      }),
      expect.objectContaining({
        specReviewRound: 1,
        expectedSignalToken: 'ffff00001111',
        prUrl: 'https://x/pull/42',
        headSha: SHA1,
      }),
    );
    expect(approveCode).not.toHaveBeenCalled();
  });

  it('keeps automatic spec approval closed when the live PR head moved after the poller snapshot', async () => {
    vi.mocked(manager.platformVerifyPrBinding).mockResolvedValueOnce({
      ok: true,
      headSha: SHA2,
      branch: 'bx/task-1',
      targetBranch: 'main',
    });
    const transition = vi.spyOn(manager, 'transitionToCodePhase');
    await taskStore.set(gitSpecReviewTask());

    await eventBus.emit(reviewSubmitted(gitVerdict({})));

    expect(transition).not.toHaveBeenCalled();
    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'review',
      phase: 'spec',
      latestHeadSha: SHA1,
      reviewHeadAnchorSha: SHA1,
    });
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'git-spec-auto-approve-head-mismatch',
      reviewedHeadSha: SHA1,
      currentHeadSha: SHA2,
      source: 'platform-live-read',
    });
  });

  it('keeps automatic spec approval retryable when the live PR binding is temporarily invalid', async () => {
    vi.mocked(manager.platformVerifyPrBinding).mockResolvedValueOnce({
      ok: false,
      reason: 'draft',
    });
    const codeTask = gitTask({
      status: 'in_progress',
      phase: 'code',
      specReviewRound: 1,
      reviewRound: 0,
    });
    const transition = vi.spyOn(manager, 'transitionToCodePhase').mockResolvedValue(codeTask);
    await taskStore.set(gitSpecReviewTask());

    await expect(eventBus.emit(reviewSubmitted(gitVerdict({}))))
      .rejects.toThrow('automatic spec approval binding is invalid: draft');

    expect(transition).not.toHaveBeenCalled();
    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'review',
      phase: 'spec',
      latestHeadSha: SHA1,
    });
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'git-spec-auto-approve-binding-invalid',
      reason: 'draft',
    });

    await expect(eventBus.emit(reviewSubmitted(gitVerdict({})))).resolves.toBeUndefined();
    expect(transition).toHaveBeenCalledOnce();
  });

  it('keeps automatic spec approval retryable when the live PR probe fails', async () => {
    vi.mocked(manager.platformVerifyPrBinding).mockRejectedValueOnce(new Error('platform timeout'));
    const codeTask = gitTask({
      status: 'in_progress',
      phase: 'code',
      specReviewRound: 1,
      reviewRound: 0,
    });
    const transition = vi.spyOn(manager, 'transitionToCodePhase').mockResolvedValue(codeTask);
    await taskStore.set(gitSpecReviewTask());

    await expect(eventBus.emit(reviewSubmitted(gitVerdict({}))))
      .rejects.toThrow('platform timeout');

    expect(transition).not.toHaveBeenCalled();
    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'review',
      phase: 'spec',
      latestHeadSha: SHA1,
    });
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'git-spec-auto-approve-head-verify-failed',
      error: 'platform timeout',
    });

    await expect(eventBus.emit(reviewSubmitted(gitVerdict({})))).resolves.toBeUndefined();
    expect(transition).toHaveBeenCalledOnce();
  });

  it('increments only the spec round when a spec review requests changes', async () => {
    const dispatchFix = vi.spyOn(manager, 'dispatchGitFixToDev').mockResolvedValue(true);
    await taskStore.set(gitTask({
      status: 'review',
      phase: 'spec',
      prNumber: 42,
      signalToken: 'ffff00001111',
      passToken: 'abcdef123456',
      failToken: '123456abcdef',
      latestHeadSha: SHA1,
      reviewHeadAnchorSha: SHA1,
      specReviewRound: 1,
      reviewRound: 0,
      reviewDispatch: reviewDispatch(1),
    }));

    await eventBus.emit(reviewSubmitted(gitVerdict({
      action: 'REQUEST_CHANGES',
      verdictToken: '123456abcdef',
    })));

    const task = await taskStore.get('task-1');
    expect(task).toMatchObject({
      status: 'fixing',
      phase: 'spec',
      specReviewRound: 2,
      reviewRound: 0,
    });
    expect(task?.reviewDispatch).toBeUndefined();
    expect(dispatchFix).toHaveBeenCalledWith('task-1');
  });

  it('caps spec review rounds independently from code review rounds', async () => {
    vi.spyOn(manager, 'getAgentState').mockResolvedValue({ taskId: 'task-1' } as never);
    vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    await taskStore.set(gitTask({
      status: 'review',
      phase: 'spec',
      prNumber: 42,
      signalToken: 'ffff00001111',
      passToken: 'abcdef123456',
      failToken: '123456abcdef',
      latestHeadSha: SHA1,
      reviewHeadAnchorSha: SHA1,
      specReviewRound: 3,
      reviewRound: 0,
      reviewDispatch: reviewDispatch(3),
    }));

    await eventBus.emit(reviewSubmitted(gitVerdict({
      action: 'REQUEST_CHANGES',
      verdictToken: '123456abcdef',
    })));

    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'max_rounds',
      phase: 'spec',
      specReviewRound: 3,
      reviewRound: 0,
    });
    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'review.max_rounds',
      data: expect.objectContaining({ phase: 'spec', reviewRound: 3 }),
    }));
  });

  it('holds the dev when the pr-fixed watcher cannot be armed', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1',
      signalToken: 'ffff00001111', passToken: 'abcdef123456', failToken: '123456abcdef',
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1, reviewRound: 1,
    }));
    vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'rotateAndSetupPhaseSignal').mockResolvedValue({ token: 'eeee11112222', armed: false });
    const hold = vi.spyOn(manager, 'markAwaitingHuman').mockResolvedValue(true);
    const dispatch = vi.spyOn(manager, 'continueSession');

    await eventBus.emit(reviewSubmitted(gitVerdict({
      action: 'REQUEST_CHANGES', verdictToken: '123456abcdef',
    })));

    expect((await taskStore.get('task-1'))?.status).toBe('fixing');
    expect(hold).toHaveBeenCalledWith(
      'dev-1', 'signal-arm-failed:pr-fixed', expect.stringContaining('completion signal'),
      { expectedTaskId: 'task-1' },
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('registers a durable dev-fix retry when the fix prompt meets a dirty workdir', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1',
      signalToken: 'ffff00001111', passToken: 'abcdef123456', failToken: '123456abcdef',
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1, reviewRound: 1,
    }));
    vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'rotateAndSetupPhaseSignal').mockResolvedValue({ token: 'eeee11112222', armed: true });
    vi.spyOn(manager, 'continueSession').mockRejectedValue(new DirtyWorkdirError('/tmp/repo'));

    await eventBus.emit(reviewSubmitted(gitVerdict({
      action: 'REQUEST_CHANGES', verdictToken: '123456abcdef',
    })));

    expect(manager.getPendingDispatchRetry('task-1')).toMatchObject({
      kind: 'dev-fix', agentId: 'dev-1', signalToken: 'eeee11112222',
    });
    expect(emitted.find(event => event.type === 'human.intervention'
      && event.data.phase === 'fix-resume-failed')).toBeUndefined();
  });

  it('updates the stored head from the engine-verified current head', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1',
      signalToken: 'ffff00001111', failToken: '123456abcdef',
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA2, reviewRound: 1,
    }));
    await eventBus.emit(reviewSubmitted(gitVerdict({
      action: 'REQUEST_CHANGES', headSha: SHA2, currentHeadSha: SHA2,
      verdictToken: '123456abcdef',
      verdictCarrier: { sourceKey: 'reviews', id: 'r2', bodyDigest: 'a'.repeat(64) },
    })));
    expect((await taskStore.get('task-1'))?.latestHeadSha).toBe(SHA2);
  });
});

describe('git review dispatch token minting', () => {
  it('review-entering transitions mint the pair atomically with the new round visibility', async () => {
    await taskStore.set(gitTask({
      status: 'in_progress', phase: 'code',
      passToken: 'abcdef123456', failToken: '123456abcdef',
    }));
    await eventBus.emit(panePrCreated({ targetBranch: 'main' }));
    const afterAdoption = await taskStore.get('task-1');
    expect(afterAdoption?.status).toBe('review');
    expect(afterAdoption?.passToken).toMatch(/^[0-9a-f]{12}$/);
    expect(afterAdoption?.passToken).not.toBe('abcdef123456');
    expect(afterAdoption?.failToken).not.toBe('123456abcdef');
  });

  it('fix arms rotate the signal token without touching the verdict pair', async () => {
    await taskStore.set(gitTask({
      status: 'fixing', prNumber: 42,
      passToken: 'abcdef123456', failToken: '123456abcdef',
    }));
    await manager.rotateAndSetupPhaseSignal('task-1', 'dev-1', 'pr-fixed', {
      expectedStatus: 'fixing', expectedToken: 'aaaa11112222',
    });
    const task = await taskStore.get('task-1');
    expect(task?.passToken).toBe('abcdef123456');
    expect(task?.failToken).toBe('123456abcdef');
  });

  it('rejects git signal rotation without a status and token guard', async () => {
    await taskStore.set(gitTask({ status: 'fixing' }));
    await expect(manager.rotateAndSetupPhaseSignal('task-1', 'dev-1', 'pr-fixed'))
      .rejects.toThrow(/requires a status\/token guard/);
    expect((await taskStore.get('task-1'))?.signalToken).toBe('aaaa11112222');
  });

  it('initial git dispatch persists the pr-created expectation token alongside the signal token', async () => {
    expect(manager.dispatchTokenFields('cccc33334444')).toEqual({
      signalToken: 'cccc33334444', pendingPrSignalToken: 'cccc33334444',
    });
  });
});

describe('push replay idempotency (git)', () => {
  it('warns and defers an in-progress catch-up without any PR identity', async () => {
    await taskStore.set(gitTask({ prNumber: undefined, latestHeadSha: undefined }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const begin = vi.spyOn(manager, 'beginGitReviewPass');

    await eventBus.emit({
      id: '', type: 'pr.updated', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
      data: { kind: 'push', branch: 'bx/task-1' },
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('deferring catch-up'));
    expect(begin).not.toHaveBeenCalled();
  });

  it('raises an intervention when a review push has no authoritative head', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: undefined, latestHeadSha: undefined,
      reviewHeadAnchorSha: undefined,
    }));

    await eventBus.emit({
      id: '', type: 'pr.updated', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
      data: { kind: 'push', branch: 'bx/task-1' },
    });

    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'git-review-head-unavailable',
    });
  });

  it('uses the event PR number to recover a missing push head authoritatively', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: undefined, latestHeadSha: undefined,
      reviewHeadAnchorSha: undefined, reviewRound: 1,
    }));
    const verify = vi.spyOn(manager, 'platformVerifyPrBinding').mockResolvedValue({
      ok: true, headSha: SHA2, branch: 'bx/task-1', targetBranch: 'main',
    });
    const dispatch = vi.spyOn(manager, 'dispatchGitReviewLease').mockResolvedValue({} as TaskState);

    await eventBus.emit({
      id: '', type: 'pr.updated', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
      data: { kind: 'push', prNumber: 42, branch: 'bx/task-1' },
    });

    expect(verify).toHaveBeenCalledWith('task-1', 42);
    expect(await taskStore.get('task-1')).toMatchObject({
      prNumber: 42, latestHeadSha: SHA2, reviewHeadAnchorSha: SHA2,
    });
    expect(dispatch).toHaveBeenCalledWith('task-1', {
      expectedGeneration: expect.stringMatching(/^[0-9a-f]{12}$/),
    });
  });

  it('reports when authoritative push-head recovery rejects the PR binding', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, latestHeadSha: undefined,
      reviewHeadAnchorSha: undefined, reviewRound: 1,
    }));
    vi.spyOn(manager, 'platformVerifyPrBinding').mockResolvedValue({ ok: false, reason: 'state' });
    const begin = vi.spyOn(manager, 'beginGitReviewPass');

    await eventBus.emit({
      id: '', type: 'pr.updated', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
      data: { kind: 'push', prNumber: 42, branch: 'bx/task-1' },
    });

    expect(begin).not.toHaveBeenCalled();
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'git-review-head-unavailable',
    });
  });

  it('records but does not review a push at the max-rounds human gate', async () => {
    await taskStore.set(gitTask({
      status: 'max_rounds', prNumber: 42, qaAgentId: 'qa-1', reviewRound: 3,
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1, signalToken: 'ffff00001111',
    }));
    const begin = vi.spyOn(manager, 'beginGitReviewPass');
    const dispatch = vi.spyOn(manager, 'dispatchGitReviewLease');

    await eventBus.emit({
      id: '', type: 'pr.updated', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
      data: { kind: 'push', prNumber: 42, branch: 'bx/task-1', headSha: SHA2 },
    });

    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'max_rounds', reviewRound: 3, latestHeadSha: SHA2,
    });
    expect(begin).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('revokes a spec-ready approval gate when a newer head is pushed', async () => {
    await taskStore.set(gitTask({
      status: 'spec-ready',
      phase: 'spec',
      specReviewRound: 1,
      reviewRound: 0,
      prNumber: 42,
      qaAgentId: 'qa-1',
      latestHeadSha: SHA1,
      reviewHeadAnchorSha: SHA1,
      signalToken: 'spec-gate-token',
    }));
    vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    const start = vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await eventBus.emit({
      id: '',
      type: 'pr.updated',
      timestamp: new Date().toISOString(),
      projectId: 'proj',
      agentId: 'dev-1',
      taskId: 'task-1',
      data: { kind: 'push', prNumber: 42, branch: 'bx/task-1', headSha: SHA2 },
    });

    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'review',
      phase: 'spec',
      latestHeadSha: SHA2,
      reviewHeadAnchorSha: SHA2,
    });
    expect(start).toHaveBeenCalledWith('task-1', 'qa-1', 'recheck', expect.any(Object));
  });

  it('fences the entry tuple before a push replaces the current git review lease', async () => {
    await taskStore.set(gitTask({
      status: 'review', phase: undefined, signalToken: undefined, prNumber: 42, qaAgentId: 'qa-1',
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1,
    }));
    const realBegin = manager.beginGitReviewPass.bind(manager);
    let capturedOptions: Record<string, unknown> | undefined;
    vi.spyOn(manager, 'beginGitReviewPass').mockImplementation(async (taskId, options) => {
      capturedOptions = options;
      const current = await taskStore.get(taskId);
      await taskStore.set({
        ...current!, phase: 'code', signalToken: 'updated-git-successor', updatedAt: new Date().toISOString(),
      });
      return realBegin(taskId, options);
    });
    const dispatchSpy = vi.spyOn(manager, 'dispatchGitReviewLease');

    await eventBus.emit({
      id: '', type: 'pr.updated', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
      data: { kind: 'push', prNumber: 42, branch: 'bx/task-1', headSha: SHA2 },
    });

    expect(Object.hasOwn(capturedOptions ?? {}, 'expectPhase')).toBe(true);
    expect(Object.hasOwn(capturedOptions ?? {}, 'expectSignalToken')).toBe(true);
    expect(capturedOptions).toMatchObject({ fromStatus: ['review'] });
    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'review', phase: 'code', signalToken: 'updated-git-successor',
    });
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('no-ops a redelivered push whose head already anchors the dispatched review round', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1',
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1, signalToken: 'ffff00001111',
    }));
    const transitionSpy = vi.spyOn(manager, 'transitionTaskStatus');
    await eventBus.emit({
      id: '', type: 'pr.updated', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
      data: { kind: 'push', prNumber: 42, branch: 'bx/task-1', headSha: SHA1 },
    });
    expect(transitionSpy).not.toHaveBeenCalled();
    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('review');
    expect(task?.signalToken).toBe('ffff00001111');
  });

  it('processes a genuinely new head as a normal push', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1',
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1, signalToken: 'ffff00001111',
    }));
    vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'startSession').mockResolvedValue(true);
    await eventBus.emit({
      id: '', type: 'pr.updated', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
      data: { kind: 'push', prNumber: 42, branch: 'bx/task-1', headSha: SHA2 },
    });
    const task = await taskStore.get('task-1');
    expect(task?.latestHeadSha).toBe(SHA2);
    expect(task?.reviewHeadAnchorSha).toBe(SHA2);
    expect(task?.signalToken).not.toBe('ffff00001111');
  });
});

describe('post-approve feedback consumption (git)', () => {
  const approvedTask = () => gitTask({
    status: 'approved', prNumber: 42, qaAgentId: 'qa-1',
    latestHeadSha: SHA1, signalToken: 'ffff00001111',
    replyActorId: '77', replyActorStatus: 'verified', reviewRound: 1,
    ...postApproveEpisode(),
  });

  function commentEvent(revision: Record<string, unknown>, over: Record<string, unknown> = {}): BaxianEvent {
    return {
      id: '', type: 'pr.updated', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
      data: { kind: 'comment', prNumber: 42, commentId: 'c1', revision, ...over },
    };
  }

  it('marks pending and records the consumed revision in one write, then no-ops the replay', async () => {
    await taskStore.set(approvedTask());
    vi.spyOn(manager, 'getAgentState').mockResolvedValue({ taskId: 'task-1' } as never);
    const revision = { sourceKey: 'issue-comments', id: 'c1', bodyDigest: 'a'.repeat(64), versionTime: 1700 };
    await eventBus.emit(commentEvent(revision));
    let task = await taskStore.get('task-1');
    expect(task?.pendingRedispatch).toBe(true);
    expect(task?.consumedFeedback).toEqual({ [`issue-comments:c1:${'a'.repeat(64)}`]: 1700 });

    const updateSpy = vi.spyOn(manager, 'updatePostApproveCompletionIfToken');
    await eventBus.emit(commentEvent(revision));
    expect(updateSpy).not.toHaveBeenCalled();
    task = await taskStore.get('task-1');
    expect(Object.keys(task?.consumedFeedback ?? {})).toHaveLength(1);
  });

  it('revokes the post-approve episode when fresh feedback exceeds the redispatch cap', async () => {
    await taskStore.set(approvedTask());
    await manager.updateTask('task-1', { redispatchCount: 10 });
    vi.spyOn(manager, 'getAgentState').mockResolvedValue(null);
    const dispatch = vi.spyOn(manager, 'continueSession');
    const revision = { sourceKey: 'issue-comments', id: 'cap', bodyDigest: 'd'.repeat(64), versionTime: 1750 };

    await eventBus.emit(commentEvent(revision));

    const task = await taskStore.get('task-1');
    expect(task?.postApproveRevoked).toMatchObject({ reason: 'redispatch-cap' });
    expect(task?.postApproveToken).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'post-approve-redispatch-cap-exceeded', cap: 10,
    });
  });

  it('records but does not redispatch feedback for a revoked post-approve episode', async () => {
    await taskStore.set(gitTask({
      status: 'approved', prNumber: 42, latestHeadSha: SHA1, reviewRound: 1,
      postApproveRevoked: { generation: POST_APPROVE_GENERATION, reason: 'redispatch-cap', at: new Date().toISOString() },
    }));
    const dispatch = vi.spyOn(manager, 'continueSession');
    const revision = { sourceKey: 'issue-comments', id: 'revoked', bodyDigest: 'e'.repeat(64), versionTime: 1760 };

    await eventBus.emit(commentEvent(revision));

    expect((await taskStore.get('task-1'))?.consumedFeedback).toEqual({
      [`issue-comments:revoked:${'e'.repeat(64)}`]: 1760,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(emitted.find(event => event.type === 'human.intervention')).toBeUndefined();
  });

  it('rejects malformed feedback revisions before mutating the task', async () => {
    const before = gitTask({ status: 'fixing', prNumber: 42, latestHeadSha: SHA1 });
    await taskStore.set(before);
    await eventBus.emit(commentEvent({
      sourceKey: 'issue-comments', id: 'bad:id', bodyDigest: 'a'.repeat(64), versionTime: 1700,
    }, { prUrl: 'https://x/pull/42' }));
    expect(await taskStore.get('task-1')).toEqual(before);
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'git-feedback-revision-invalid',
    });
  });

  it('records consumption alongside the feedback timestamp while the task is fixing', async () => {
    await taskStore.set(gitTask({ status: 'fixing', prNumber: 42, latestHeadSha: SHA1 }));
    const revision = { sourceKey: 'inline-comments', id: 'i9', bodyDigest: 'b'.repeat(64), versionTime: 1800 };
    await eventBus.emit(commentEvent(revision, { kind: 'review-comment' }));
    const task = await taskStore.get('task-1');
    expect(task?.consumedFeedback).toEqual({ [`inline-comments:i9:${'b'.repeat(64)}`]: 1800 });
    expect(task?.prFeedbackReceivedAt).toBeDefined();
  });

  it('ignores an unknown pr.updated kind instead of treating it as feedback or a push', async () => {
    const before = gitTask({ status: 'fixing', prNumber: 42, latestHeadSha: SHA1 });
    await taskStore.set(before);
    const consume = vi.spyOn(manager, 'consumeGitFeedbackRevision');
    const begin = vi.spyOn(manager, 'beginGitReviewPass');

    await eventBus.emit({
      id: '', type: 'pr.updated', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
      data: { kind: 'future-kind', prNumber: 99, headSha: SHA2 },
    });

    expect(await taskStore.get('task-1')).toEqual(before);
    expect(consume).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
  });

  it('survives a crash between the merge-ready return and the dispatch via the recovery sweep', async () => {
    await taskStore.set(gitTask({
      status: 'merge-ready', prNumber: 42, latestHeadSha: SHA1,
      signalToken: 'ffff00001111', replyActorId: '77', replyActorStatus: 'verified', reviewRound: 1,
    }));
    const returned = asReturned(await manager.consumeGitFeedbackRevision('task-1', {
      key: 'issue-comments:c7:crash', versionTime: 1900,
    }));
    expect(returned?.pendingRedispatch).toBe(true);
    await taskStore.set({ ...returned!, updatedAt: RECOVERY_READY_AT });

    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);
    await recoverGitPostApprovePending(eventBus, manager);
    const task = await taskStore.get('task-1');
    expect(task?.postApproveToken).toBeDefined();
    expect(task?.pendingRedispatch).toBe(false);
    expect(continueSpy).toHaveBeenCalledWith('task-1', 'dev-1', 'post-approve', expect.not.objectContaining({
      postApproveRedispatchCount: expect.anything(),
    }));
  });

  it('recovery redispatches durable pending even when a completion token is installed (delivery unconfirmed)', async () => {
    await taskStore.set(gitTask({
      status: 'approved', prNumber: 42, latestHeadSha: SHA1,
      signalToken: 'ffff00001111', reviewRound: 1,
      ...postApproveEpisode({ postApproveToken: 'tok999888777', pendingRedispatch: true }),
    }));
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);
    await recoverGitPostApprovePending(eventBus, manager);
    expect(continueSpy).toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.pendingRedispatch).toBe(false);
  });

  it('does not rotate a freshly installed post-approve episode while its normal dispatch may still be running', async () => {
    const updatedAt = new Date().toISOString();
    await taskStore.set(gitTask({
      status: 'approved', prNumber: 42, latestHeadSha: SHA1,
      signalToken: 'ffff00001111', reviewRound: 1,
      ...postApproveEpisode({ pendingRedispatch: true, redispatchCount: 0, updatedAt }),
    }));
    const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);

    await recoverGitPostApprovePending(eventBus, manager);

    expect(continueSpy).not.toHaveBeenCalled();
    expect(await taskStore.get('task-1')).toMatchObject({
      postApproveToken: 'tok123456789', pendingRedispatch: true, redispatchCount: 0, updatedAt,
    });
  });

  it('does not rotate a successor episode installed after the recovery snapshot was read', async () => {
    const stale = gitTask({
      status: 'approved', prNumber: 42, latestHeadSha: SHA1,
      signalToken: 'ffff00001111', reviewRound: 1,
      ...postApproveEpisode({ pendingRedispatch: true, redispatchCount: 0 }),
    });
    const successor = {
      ...stale,
      postApproveToken: 'beefbeefbeef',
      updatedAt: new Date().toISOString(),
    };
    vi.spyOn(manager, 'listActiveGitTasks').mockResolvedValue([stale]);
    vi.spyOn(manager, 'getTask')
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(successor);
    const rotate = vi.spyOn(manager, 'rotateGitPostApproveEpisode');
    const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);

    await recoverGitPostApprovePending(eventBus, manager);

    expect(rotate).not.toHaveBeenCalled();
    expect(continueSpy).not.toHaveBeenCalled();
  });

  it('warns and skips recovery when the live updatedAt is unparseable', async () => {
    const stale = gitTask({
      status: 'approved', prNumber: 42, latestHeadSha: SHA1,
      signalToken: 'ffff00001111', reviewRound: 1,
      ...postApproveEpisode({ pendingRedispatch: true, redispatchCount: 0 }),
    });
    vi.spyOn(manager, 'listActiveGitTasks').mockResolvedValue([stale]);
    vi.spyOn(manager, 'getTask').mockResolvedValue({ ...stale, updatedAt: 'not-a-timestamp' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rotate = vi.spyOn(manager, 'rotateGitPostApproveEpisode');
    const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);

    await recoverGitPostApprovePending(eventBus, manager);

    expect(rotate).not.toHaveBeenCalled();
    expect(continueSpy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('updatedAt unparseable'),
      'not-a-timestamp',
    );
  });

  it('warns once per broken updatedAt value across recovery sweeps and again on change', async () => {
    const stale = gitTask({
      status: 'approved', prNumber: 42, latestHeadSha: SHA1,
      signalToken: 'ffff00001111', reviewRound: 1,
      ...postApproveEpisode({ pendingRedispatch: true, redispatchCount: 0 }),
    });
    vi.spyOn(manager, 'listActiveGitTasks').mockResolvedValue([stale]);
    const live = vi.spyOn(manager, 'getTask');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(manager, 'continueSession').mockResolvedValue(true);

    live.mockResolvedValue({ ...stale, updatedAt: 'still-broken' });
    await recoverGitPostApprovePending(eventBus, manager);
    await recoverGitPostApprovePending(eventBus, manager);
    const firstValueWarns = warn.mock.calls.filter(call => call[1] === 'still-broken');
    expect(firstValueWarns).toHaveLength(1);

    live.mockResolvedValue({ ...stale, updatedAt: 'broken-differently' });
    await recoverGitPostApprovePending(eventBus, manager);
    expect(warn.mock.calls.filter(call => call[1] === 'broken-differently')).toHaveLength(1);
  });

  it('recovery revokes a durable pending episode at the redispatch cap', async () => {
    await taskStore.set(gitTask({
      status: 'approved', prNumber: 42, latestHeadSha: SHA1,
      signalToken: 'ffff00001111', reviewRound: 1,
      ...postApproveEpisode({ pendingRedispatch: true, redispatchCount: 10 }),
    }));
    const continueSpy = vi.spyOn(manager, 'continueSession');

    await recoverGitPostApprovePending(eventBus, manager);

    const task = await taskStore.get('task-1');
    expect(task?.postApproveRevoked).toMatchObject({ reason: 'redispatch-cap' });
    expect(task?.postApproveToken).toBeUndefined();
    expect(continueSpy).not.toHaveBeenCalled();
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'post-approve-redispatch-cap-exceeded', redispatchCount: 10, cap: 10,
    });
  });

  it('recovery isolates one failing task and still redispatches the next', async () => {
    await taskStore.set(gitTask({
      id: 'task-1', status: 'approved', prNumber: 42, latestHeadSha: SHA1,
      signalToken: 'ffff00001111', reviewRound: 1,
      ...postApproveEpisode({ pendingRedispatch: true }),
    }));
    await taskStore.set(gitTask({
      id: 'task-2', status: 'approved', prNumber: 43, latestHeadSha: SHA1,
      signalToken: 'ffff00002222', reviewRound: 1,
      ...postApproveEpisode({ pendingRedispatch: true }),
    }));
    vi.spyOn(manager, 'acquireAgentForTask')
      .mockRejectedValueOnce(new Error('store io error'))
      .mockResolvedValue(true);
    const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);
    await recoverGitPostApprovePending(eventBus, manager);
    expect(continueSpy).toHaveBeenCalledWith('task-2', 'dev-1', 'post-approve', expect.anything());
    expect(emitted.find(e => e.type === 'human.intervention' && e.taskId === 'task-1')?.data).toMatchObject({
      phase: 'post-approve-recovery-failed',
    });
  });

  it('returns a merge-ready task to approved and redispatches on fresh feedback', async () => {
    await taskStore.set(gitTask({
      status: 'merge-ready', prNumber: 42, latestHeadSha: SHA1,
      signalToken: 'ffff00001111', replyActorId: '77', replyActorStatus: 'verified', reviewRound: 1,
    }));
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);
    const revision = { sourceKey: 'issue-comments', id: 'c7', bodyDigest: 'c'.repeat(64), versionTime: 1900 };
    await eventBus.emit(commentEvent(revision));
    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('approved');
    expect(task?.consumedFeedback).toEqual({ [`issue-comments:c7:${'c'.repeat(64)}`]: 1900 });
    expect(task?.postApproveToken).toBeDefined();
    expect(continueSpy).toHaveBeenCalledWith('task-1', 'dev-1', 'post-approve', expect.not.objectContaining({
      postApproveRedispatchCount: expect.anything(),
    }));
  });

  it('reports fresh approved feedback when neither durable head source is usable', async () => {
    await taskStore.set(approvedTask());
    const withoutHead = gitTask({
      status: 'approved', prNumber: 42, latestHeadSha: undefined, reviewRound: 1,
    });
    vi.spyOn(manager, 'consumeGitFeedbackRevision').mockResolvedValue({
      kind: 'pending', task: withoutHead,
    });
    vi.spyOn(manager, 'getPostApproveCompletion').mockResolvedValue(null);
    vi.spyOn(manager, 'getAgentState').mockResolvedValue(null);
    const revision = { sourceKey: 'issue-comments', id: 'no-head', bodyDigest: '8'.repeat(64), versionTime: 2500 };

    await eventBus.emit(commentEvent(revision));

    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'post-approve-approved-head-unavailable',
    });
  });

  it('reports a recovery record whose approved head is unavailable', async () => {
    const malformed = gitTask({
      status: 'approved', pendingRedispatch: true, latestHeadSha: undefined,
      updatedAt: RECOVERY_READY_AT,
    });
    vi.spyOn(manager, 'listActiveGitTasks').mockResolvedValue([malformed]);
    vi.spyOn(manager, 'getTask').mockResolvedValue(malformed);

    await recoverGitPostApprovePending(eventBus, manager);

    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'post-approve-approved-head-unavailable',
    });
  });
});

describe('merge-ready receipt recheck (git)', () => {
  function mergeReadySignal(token: string): BaxianEvent {
    return {
      id: '', type: 'pr.updated', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
      data: { kind: 'pr-merge-ready', token, verdictAgentId: 'dev-1', source: 'pane-signal', prNumber: 42 },
    };
  }

  const approvedWithCompletion = () => gitTask({
    status: 'approved', prNumber: 42, latestHeadSha: SHA1, signalToken: 'ffff00001111',
    replyActorId: '77', replyActorStatus: 'verified', reviewRound: 1,
    ...postApproveEpisode(),
  });

  it('reports when the dev cannot be parked before merge-ready revalidation', async () => {
    await taskStore.set(approvedWithCompletion());
    vi.mocked(manager.markAgentWaiting).mockResolvedValueOnce(false);

    await eventBus.emit(mergeReadySignal('tok123456789'));

    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'post-approve-dev-wait-gate-failed',
    });
  });

  it('reports when the approved episode changes after the dev is parked', async () => {
    await taskStore.set(approvedWithCompletion());
    vi.mocked(manager.markAgentWaiting).mockImplementationOnce(async () => {
      await manager.revokePostApproveCompletion('task-1', 'redispatch-cap', {
        expectedToken: 'tok123456789',
        expectedGeneration: POST_APPROVE_GENERATION,
        expectedHeadSha: SHA1,
      });
      return true;
    });
    const verify = vi.spyOn(manager, 'platformVerifyAcceptedPass');

    await eventBus.emit(mergeReadySignal('tok123456789'));

    expect(verify).not.toHaveBeenCalled();
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'post-approve-merge-skipped-stale-task',
    });
  });

  it('reports when the refreshed task no longer has a complete approved episode', async () => {
    const stored = approvedWithCompletion();
    await taskStore.set(stored);
    vi.spyOn(manager, 'getTask')
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce({
        ...stored,
        postApproveGeneration: undefined,
        postApproveHeadSha: undefined,
        postApproveToken: undefined,
        postApprovePhase: undefined,
      });

    await eventBus.emit(mergeReadySignal('tok123456789'));

    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'post-approve-merge-skipped-stale-task',
    });
  });

  it('re-runs the pending-feedback set server-side and redispatches instead of migrating', async () => {
    await taskStore.set(approvedWithCompletion());
    vi.spyOn(manager, 'platformVerifyAcceptedPass').mockResolvedValue({ kind: 'valid', pendingCount: 1 });
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);
    await eventBus.emit(mergeReadySignal('tok123456789'));
    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('approved');
    expect(continueSpy).toHaveBeenCalledWith('task-1', 'dev-1', 'post-approve', expect.not.objectContaining({
      postApproveRedispatchCount: expect.anything(),
    }));
    expect(manager.markAgentWaiting).toHaveBeenCalledWith('dev-1', 'task-1', {
      expectedPostApproveEpisode: {
        generation: POST_APPROVE_GENERATION,
        token: 'tok123456789',
        headSha: SHA1,
      },
    });
  });

  it('revokes at the redispatch cap when merge-ready recheck finds pending feedback', async () => {
    await taskStore.set({ ...approvedWithCompletion(), redispatchCount: 10 });
    vi.spyOn(manager, 'platformVerifyAcceptedPass').mockResolvedValue({ kind: 'valid', pendingCount: 1 });
    const continueSpy = vi.spyOn(manager, 'continueSession');

    await eventBus.emit(mergeReadySignal('tok123456789'));

    const task = await taskStore.get('task-1');
    expect(task?.postApproveRevoked).toMatchObject({ reason: 'redispatch-cap' });
    expect(task?.postApproveToken).toBeUndefined();
    expect(continueSpy).not.toHaveBeenCalled();
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'post-approve-redispatch-cap-exceeded', redispatchCount: 10, cap: 10,
    });
  });

  it('reports a stale cap decision when the episode rotates before revocation', async () => {
    await taskStore.set({ ...approvedWithCompletion(), pendingRedispatch: true, redispatchCount: 10 });
    vi.spyOn(manager, 'platformVerifyAcceptedPass').mockResolvedValue({ kind: 'valid', pendingCount: 1 });
    vi.spyOn(manager, 'revokePostApproveCompletion').mockResolvedValue(false);

    await eventBus.emit(mergeReadySignal('tok123456789'));

    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'post-approve-merge-skipped-stale-task',
    });
  });

  it('reports an unusable completion head before pending-feedback redispatch', async () => {
    await taskStore.set({ ...approvedWithCompletion(), pendingRedispatch: true });
    vi.spyOn(manager, 'getPostApproveCompletion').mockResolvedValue({
      token: 'tok123456789', approvedHeadSha: '', pendingRedispatch: true, redispatchCount: 0,
    } as never);
    vi.spyOn(manager, 'platformVerifyAcceptedPass').mockResolvedValue({ kind: 'valid', pendingCount: 1 });

    await eventBus.emit(mergeReadySignal('tok123456789'));

    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'post-approve-approved-head-unavailable',
    });
  });

  it('stays fail closed with an intervention when the comment scan cannot complete', async () => {
    await taskStore.set(approvedWithCompletion());
    vi.spyOn(manager, 'platformVerifyAcceptedPass').mockRejectedValue(new Error('reviews source down'));
    await eventBus.emit(mergeReadySignal('tok123456789'));
    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('approved');
    expect(task?.pendingRedispatch).toBe(true);
    expect(task?.postApprovePhase).toBe('signaled');
    expect(emitted.find(e => e.type === 'human.intervention')?.data).toMatchObject({
      phase: 'post-approve-merge-skipped-scan-failed',
    });
  });

  it('refuses the migration when the accepted pass no longer verifies', async () => {
    await taskStore.set(approvedWithCompletion());
    vi.spyOn(manager, 'platformVerifyAcceptedPass').mockResolvedValue({
      kind: 'provenance-invalid', reason: 'provenance token-dismissed',
    });
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(false);
    await eventBus.emit(mergeReadySignal('tok123456789'));
    expect((await taskStore.get('task-1'))?.status).toBe('review');
    expect(emitted.find(e => e.type === 'human.intervention')?.data).toMatchObject({
      phase: 'post-approve-provenance-redispatch-failed',
    });
  });

  it('does not let a provenance recheck replace a successor approved tuple', async () => {
    await taskStore.set(gitTask({
      status: 'approved', phase: undefined, signalToken: undefined, prNumber: 42,
      latestHeadSha: SHA1, replyActorId: '77', replyActorStatus: 'verified', reviewRound: 1,
      ...postApproveEpisode(),
    }));
    vi.spyOn(manager, 'platformVerifyAcceptedPass').mockResolvedValue({
      kind: 'provenance-invalid', reason: 'provenance token-dismissed',
    });
    const realBegin = manager.beginGitReviewPass.bind(manager);
    let capturedOptions: Record<string, unknown> | undefined;
    vi.spyOn(manager, 'beginGitReviewPass').mockImplementation(async (taskId, options) => {
      capturedOptions = options;
      const current = await taskStore.get(taskId);
      await taskStore.set({
        ...current!, phase: 'code', signalToken: 'approved-git-successor', updatedAt: new Date().toISOString(),
      });
      return realBegin(taskId, options);
    });
    const dispatchSpy = vi.spyOn(manager, 'dispatchGitReviewLease');

    await eventBus.emit(mergeReadySignal('tok123456789'));

    expect(Object.hasOwn(capturedOptions ?? {}, 'expectPhase')).toBe(true);
    expect(Object.hasOwn(capturedOptions ?? {}, 'expectSignalToken')).toBe(true);
    expect(capturedOptions).toMatchObject({ fromStatus: ['approved'] });
    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'approved', phase: 'code', signalToken: 'approved-git-successor',
    });
    expect((await taskStore.get('task-1'))?.reviewDispatch).toBeUndefined();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('fails a provenance recheck when its QA dispatch has a terminal error', async () => {
    await taskStore.set(approvedWithCompletion());
    await taskStore.set({
      ...(await taskStore.get('task-1'))!,
      qaAgentId: 'qa-1',
      updatedAt: new Date().toISOString(),
    });
    vi.spyOn(manager, 'platformVerifyAcceptedPass').mockResolvedValue({
      kind: 'provenance-invalid', reason: 'provenance token-dismissed',
    });
    vi.spyOn(manager, 'dispatchGitReviewLease').mockRejectedValue(
      new DispatchTerminalError('prompt_too_large', 'review prompt exceeds the limit'),
    );

    await eventBus.emit(mergeReadySignal('tok123456789'));

    expect((await taskStore.get('task-1'))?.status).toBe('failed');
  });

  it('clears a stale pending flag when the authoritative scan comes back empty', async () => {
    await taskStore.set(gitTask({
      status: 'approved', prNumber: 42, latestHeadSha: SHA1, signalToken: 'ffff00001111',
      replyActorId: '77', replyActorStatus: 'verified', reviewRound: 1,
      ...postApproveEpisode({ pendingRedispatch: true }),
    }));
    vi.spyOn(manager, 'platformVerifyAcceptedPass').mockResolvedValue({ kind: 'valid', pendingCount: 0 });
    await eventBus.emit(mergeReadySignal('tok123456789'));
    expect((await taskStore.get('task-1'))?.status).toBe('merge-ready');
  });

  it('migrates to merge-ready when the pending set is empty', async () => {
    await taskStore.set(approvedWithCompletion());
    vi.spyOn(manager, 'platformVerifyAcceptedPass').mockResolvedValue({ kind: 'valid', pendingCount: 0 });
    await eventBus.emit(mergeReadySignal('tok123456789'));
    expect((await taskStore.get('task-1'))?.status).toBe('merge-ready');
  });

  it('reports a stale merge-ready completion refusal', async () => {
    await taskStore.set(approvedWithCompletion());
    vi.spyOn(manager, 'platformVerifyAcceptedPass').mockResolvedValue({ kind: 'valid', pendingCount: 0 });
    vi.spyOn(manager, 'completeApprovedPassToMergeReady').mockResolvedValue({ refused: 'stale' } as never);

    await eventBus.emit(mergeReadySignal('tok123456789'));

    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'post-approve-merge-skipped-stale-task',
    });
  });
});

describe('pr-fixed no-op gate (git)', () => {
  function prFixed(token: string): BaxianEvent {
    return {
      id: '', type: 'pr.fix.submitted', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
      data: { kind: 'pr-fixed', token, source: 'pane-signal' },
    };
  }

  const fixingTask = () => gitTask({
    status: 'fixing', prNumber: 42, latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1,
    signalToken: 'ffff00001111', qaAgentId: 'qa-1', reviewRound: 1,
    replyActorId: '77', replyActorStatus: 'verified',
  });

  it('rejects a stale completion token before reading the PR', async () => {
    await taskStore.set(fixingTask());
    const verify = vi.spyOn(manager, 'platformVerifyPrBinding');

    await eventBus.emit(prFixed('eeeeeeeeeeee'));

    expect(verify).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.status).toBe('fixing');
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'stale-pr-fixed-wrong-pass',
    });
  });

  it('re-arms fixing without probing when the task has no PR number', async () => {
    await taskStore.set({ ...fixingTask(), prNumber: undefined });
    const verify = vi.spyOn(manager, 'platformVerifyPrBinding');
    const rearm = vi.spyOn(manager, 'setupPhaseSignal').mockResolvedValue(true);

    await eventBus.emit(prFixed('ffff00001111'));

    expect(verify).not.toHaveBeenCalled();
    expect(rearm).toHaveBeenCalledWith('task-1', 'dev-1', 'pr-fixed', {
      skipSnapshot: true, replaceScope: 'agent',
    });
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'fix-verify-no-anchor',
    });
  });

  it('re-arms the same fixing pass when authoritative PR verification throws', async () => {
    await taskStore.set(fixingTask());
    vi.spyOn(manager, 'platformVerifyPrBinding').mockRejectedValue(new Error('prView transport failed'));
    const rearm = vi.spyOn(manager, 'setupPhaseSignal').mockResolvedValue(true);

    await eventBus.emit(prFixed('ffff00001111'));

    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'fixing', signalToken: 'ffff00001111',
    });
    expect(rearm).toHaveBeenCalledWith('task-1', 'dev-1', 'pr-fixed', {
      skipSnapshot: true, replaceScope: 'agent',
    });
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'fix-verify-head-fetch-failed', error: 'prView transport failed',
    });
  });

  it('re-arms fixing when the current review head anchor is missing', async () => {
    await taskStore.set(fixingTask());
    await manager.updateTask('task-1', { reviewHeadAnchorSha: undefined });
    vi.spyOn(manager, 'platformVerifyPrBinding').mockResolvedValue({
      ok: true, headSha: SHA1, branch: 'bx/task-1', targetBranch: 'main',
    });
    const rearm = vi.spyOn(manager, 'setupPhaseSignal').mockResolvedValue(true);

    await eventBus.emit(prFixed('ffff00001111'));

    expect((await taskStore.get('task-1'))?.status).toBe('fixing');
    expect(rearm).toHaveBeenCalledWith('task-1', 'dev-1', 'pr-fixed', {
      skipSnapshot: true, replaceScope: 'agent',
    });
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'fix-verify-no-anchor', headSha: SHA1,
    });
  });

  it('holds the fixing round while feedback revisions still lack a valid ack', async () => {
    await taskStore.set(fixingTask());
    vi.spyOn(manager, 'platformVerifyPrBinding').mockResolvedValue({
      ok: true, headSha: SHA1, branch: 'bx/task-1', targetBranch: 'main',
    });
    vi.spyOn(manager, 'platformPendingFeedback').mockResolvedValue({
      allSourcesOk: true,
      pending: new Map([['reviews:r1:dd', { sourceKey: 'reviews', id: 'r1', bodyDigest: 'dd' }]]),
    });
    await eventBus.emit(prFixed('ffff00001111'));
    expect((await taskStore.get('task-1'))?.status).toBe('fixing');
    expect(emitted.find(e => e.type === 'human.intervention')?.data).toMatchObject({
      phase: 'fix-no-op-pending-feedback', pendingCount: 1,
    });
  });

  it('holds the fixing round when the PR no longer satisfies the binding predicate', async () => {
    await taskStore.set(fixingTask());
    vi.spyOn(manager, 'platformVerifyPrBinding').mockResolvedValue({ ok: false, reason: 'state' });
    await eventBus.emit(prFixed('ffff00001111'));
    expect((await taskStore.get('task-1'))?.status).toBe('fixing');
    expect(emitted.find(e => e.type === 'human.intervention')?.data).toMatchObject({
      phase: 'fix-verify-binding-mismatch', reason: 'state',
    });
  });

  it('dispatches the same-head recheck once every revision is acked', async () => {
    await taskStore.set(fixingTask());
    vi.spyOn(manager, 'platformVerifyPrBinding').mockResolvedValue({
      ok: true, headSha: SHA1, branch: 'bx/task-1', targetBranch: 'main',
    });
    vi.spyOn(manager, 'platformPendingFeedback').mockResolvedValue({ allSourcesOk: true, pending: new Map() });
    vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'startSession').mockResolvedValue(true);
    await eventBus.emit(prFixed('ffff00001111'));
    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('review');
    expect(task?.signalToken).not.toBe('ffff00001111');
    expect(task?.passToken).toMatch(/^[0-9a-f]{12}$/);
  });

  it('stays fail closed in fixing when the scan cannot complete', async () => {
    await taskStore.set(fixingTask());
    vi.spyOn(manager, 'platformVerifyPrBinding').mockResolvedValue({
      ok: true, headSha: SHA1, branch: 'bx/task-1', targetBranch: 'main',
    });
    vi.spyOn(manager, 'platformPendingFeedback').mockRejectedValue(new Error('HTTP 500'));
    await eventBus.emit(prFixed('ffff00001111'));
    expect((await taskStore.get('task-1'))?.status).toBe('fixing');
    expect(emitted.find(e => e.type === 'human.intervention')?.data).toMatchObject({
      phase: 'fix-verify-replies-fetch-failed',
    });
  });

  it('escalates when the synthetic push cannot advance the fixing task', async () => {
    await taskStore.set(fixingTask());
    vi.spyOn(manager, 'platformVerifyPrBinding').mockResolvedValue({
      ok: true, headSha: SHA2, branch: 'bx/task-1', targetBranch: 'main',
    });
    vi.spyOn(manager, 'beginGitReviewPass').mockResolvedValue(null);

    await eventBus.emit(prFixed('ffff00001111'));

    expect((await taskStore.get('task-1'))?.status).toBe('fixing');
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'fix-advance-rolled-back',
    });
  });
});

describe('manual git review dispatch (dispatchReviewToQa)', () => {
  it('anchors via the driver, re-mints the pair, and keeps the dev reconciliation entry', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1', signalToken: 'ffff00001111',
      passToken: 'abcdef123456', failToken: '123456abcdef',
      pendingPrSignalToken: 'aaaa11112222', replyActorStatus: 'provisional', replyActorId: '99',
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1, reviewRound: 1,
    }));
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'startSession').mockResolvedValue(true);
    vi.spyOn(manager, 'platformVerifyPrBinding').mockResolvedValue({
      ok: true, headSha: SHA2, branch: 'bx/task-1', targetBranch: 'main',
    });
    await taskStore.set({ ...(await taskStore.get('task-1'))!, latestHeadSha: SHA2, updatedAt: new Date().toISOString() });

    await manager.dispatchReviewToQa('task-1', { actorId: '99' });

    const task = await taskStore.get('task-1');
    expect(task?.reviewHeadAnchorSha).toBe(SHA2);
    expect(task?.passToken).toMatch(/^[0-9a-f]{12}$/);
    expect(task?.passToken).not.toBe('abcdef123456');
    expect(task?.failToken).not.toBe('123456abcdef');
  });
});

describe('closed-unmerged / reopen anchor with outbox (git)', () => {
  function lifecycleEvent(kind: 'closed-unmerged' | 'reopened'): BaxianEvent {
    return {
      id: '', type: 'pr.updated', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
      data: { kind, prNumber: 42, prUrl: 'https://x/pull/42', branch: 'bx/task-1' },
    };
  }

  const reviewTask = () => gitTask({
    status: 'review', prNumber: 42, qaAgentId: 'qa-1', signalToken: 'ffff00001111',
  });

  it('anchors once per close, notifies with a deterministic key, and clears the outbox', async () => {
    await taskStore.set(reviewTask());
    await eventBus.emit(lifecycleEvent('closed-unmerged'));
    const task = await taskStore.get('task-1');
    expect(task?.closedUnmergedAnchor).toEqual({ prNumber: 42, generation: 1 });
    expect(task?.status).toBe('review');
    expect(task?.outbox).toBeUndefined();
    const interventions = emitted.filter(e => e.type === 'human.intervention');
    expect(interventions).toHaveLength(1);
    expect(interventions[0]!.data).toMatchObject({
      phase: 'mr-closed-unmerged', prNumber: 42, eventKey: 'task-1:42:mr-closed-unmerged:1',
    });

    await eventBus.emit(lifecycleEvent('closed-unmerged'));
    expect(emitted.filter(e => e.type === 'human.intervention')).toHaveLength(1);
    expect((await taskStore.get('task-1'))?.closedUnmergedAnchor?.generation).toBe(1);
  });

  it('reopen durably clears the anchor so the next close fires exactly one new intervention', async () => {
    await taskStore.set(reviewTask());
    await eventBus.emit(lifecycleEvent('closed-unmerged'));
    await eventBus.emit(lifecycleEvent('reopened'));
    let task = await taskStore.get('task-1');
    expect(task?.closedUnmergedAnchor).toEqual({ prNumber: 42, generation: 1, cleared: true });
    expect(emitted.filter(e => e.type === 'human.intervention').map(e => e.data.phase))
      .toEqual(['mr-closed-unmerged', 'mr-reopened']);

    await eventBus.emit(lifecycleEvent('reopened'));
    expect(emitted.filter(e => e.type === 'human.intervention')).toHaveLength(2);

    await eventBus.emit(lifecycleEvent('closed-unmerged'));
    task = await taskStore.get('task-1');
    expect(task?.closedUnmergedAnchor).toEqual({ prNumber: 42, generation: 2 });
    expect(emitted.filter(e => e.type === 'human.intervention')[2]!.data).toMatchObject({
      eventKey: 'task-1:42:mr-closed-unmerged:2',
    });
  });

  it('retries a stuck outbox entry on the next lifecycle observation without re-anchoring', async () => {
    await taskStore.set(reviewTask());
    const emitSpy = vi.spyOn(eventBus, 'emit');
    let failInterventions = true;
    emitSpy.mockImplementation(async (evt: BaxianEvent) => {
      if (evt.type === 'human.intervention' && failInterventions) throw new Error('bus down');
      emitted.push(evt);
    });
    await manager.recordClosedUnmergedAnchor('task-1', 42);
    await manager.deliverTaskOutbox('task-1');
    expect((await taskStore.get('task-1'))?.outbox).toHaveLength(1);

    failInterventions = false;
    emitSpy.mockRestore();
    const replayed: BaxianEvent[] = [];
    eventBus.on('human.intervention', (evt) => { replayed.push(evt); });
    await eventBus.emit(lifecycleEvent('closed-unmerged'));
    const task = await taskStore.get('task-1');
    expect(task?.outbox).toBeUndefined();
    expect(task?.closedUnmergedAnchor?.generation).toBe(1);
    expect(replayed).toHaveLength(1);
  });

  it('keeps the undelivered notification in the outbox and replays it on recovery', async () => {
    await taskStore.set(reviewTask());
    const emitSpy = vi.spyOn(eventBus, 'emit');
    emitSpy.mockImplementation(async (evt: BaxianEvent) => {
      if (evt.type === 'human.intervention') throw new Error('bus down');
      emitted.push(evt);
    });
    await manager.recordClosedUnmergedAnchor('task-1', 42);
    await manager.deliverTaskOutbox('task-1');
    let task = await taskStore.get('task-1');
    expect(task?.closedUnmergedAnchor).toEqual({ prNumber: 42, generation: 1 });
    expect(task?.outbox).toHaveLength(1);

    emitSpy.mockRestore();
    const replayed: BaxianEvent[] = [];
    eventBus.on('human.intervention', (evt) => { replayed.push(evt); });
    await manager.flushTaskOutboxes();
    task = await taskStore.get('task-1');
    expect(task?.outbox).toBeUndefined();
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.data).toMatchObject({ eventKey: 'task-1:42:mr-closed-unmerged:1' });
  });

});
describe('git review state transition guards', () => {
  it('rejects malformed git verdicts before any task or agent side effect', async () => {
    const base = {
      prNumber: 42, qaAgentId: 'qa-1',
      signalToken: 'ffff00001111', passToken: 'abcdef123456', failToken: '123456abcdef',
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1, reviewRound: 1,
    };
    const valid = gitVerdict({});
    const cases = [
      { ...valid, action: 'DISMISS' },
      { ...valid, source: 'untrusted-source' },
      { ...valid, reviewPassToken: undefined },
      { ...valid, reviewPassToken: 'short' },
      { ...valid, reviewPassToken: 'eeeeeeeeeeee' },
      { ...valid, headSha: 'not-a-sha' },
      { ...valid, verdictCarrier: undefined },
      { ...valid, verdictCarrier: { sourceKey: 'reviews', id: 'r1', bodyDigest: 'bad' } },
      { ...valid, verdictToken: 'aaaa00000000' },
    ];
    for (const status of ['in_progress', 'fixing'] as const) {
      for (const data of cases) {
        const before = gitTask({ ...base, status });
        await taskStore.set(before);
        const transition = vi.spyOn(manager, 'transitionTaskStatus');
        const approve = vi.spyOn(manager, 'approveGitReviewPass');
        const acquire = vi.spyOn(manager, 'acquireAgentForTask');
        const dispatch = vi.spyOn(manager, 'dispatchGitReviewLease');
        const wait = vi.mocked(manager.markAgentWaiting);
        wait.mockClear();
        emitted.length = 0;
        await eventBus.emit({
          id: '', type: 'review.submitted', timestamp: new Date().toISOString(),
          projectId: 'proj', agentId: 'qa-1', taskId: 'task-1', data,
        });
        expect(await taskStore.get('task-1')).toEqual(before);
        expect(transition).not.toHaveBeenCalled();
        expect(approve).not.toHaveBeenCalled();
        expect(acquire).not.toHaveBeenCalled();
        expect(dispatch).not.toHaveBeenCalled();
        expect(wait).not.toHaveBeenCalled();
        expect(emitted.find(event => event.type === 'human.intervention')?.data)
          .toMatchObject({ phase: 'git-verdict-payload-invalid' });
        transition.mockRestore();
        approve.mockRestore();
        acquire.mockRestore();
        dispatch.mockRestore();
      }
    }
  });

  it('rejects a git REQUEST_CHANGES whose verdict token is not the current fail token', async () => {
    const before = gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1',
      signalToken: 'ffff00001111', passToken: 'abcdef123456', failToken: '123456abcdef',
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1, reviewRound: 1,
    });
    await taskStore.set(before);
    await eventBus.emit({
      id: '', type: 'review.submitted', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'qa-1', taskId: 'task-1',
      data: gitVerdict({ action: 'REQUEST_CHANGES', verdictToken: 'aaaa00000000' }),
    });
    expect(await taskStore.get('task-1')).toEqual(before);
    expect(emitted.find(event => event.type === 'human.intervention')?.data)
      .toMatchObject({ phase: 'git-verdict-payload-invalid' });
  });

  it('keeps the legal stale-verdict path for a structurally valid old review pass', async () => {
    const before = gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1',
      signalToken: 'ffff00001111', passToken: 'abcdef123456', failToken: '123456abcdef',
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1, reviewRound: 1,
    });
    await taskStore.set(before);
    vi.spyOn(manager, 'getAgentState').mockResolvedValue({ taskId: 'task-1' } as never);

    await eventBus.emit({
      id: '', type: 'review.submitted', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'qa-1', taskId: 'task-1',
      data: gitVerdict({
        action: 'REQUEST_CHANGES', reviewPassToken: 'eeeeeeeeeeee',
        verdictToken: '123456abcdef',
      }),
    });

    expect(await taskStore.get('task-1')).toEqual(before);
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'stale-verdict-wrong-pass', verdictPassToken: 'eeeeeeeeeeee',
    });
  });

  it('transitionToCodePhase refreshes the pr-created reconciliation token for git tasks', async () => {
    const fields = manager.dispatchTokenFields('dddd55556666');
    expect(fields.pendingPrSignalToken).toBe('dddd55556666');
  });

  it('recovery redispatches a durable pending pass even while the waiting dev keeps its binding', async () => {
    await taskStore.set(gitTask({
      status: 'approved', prNumber: 42, latestHeadSha: SHA1,
      signalToken: 'ffff00001111', reviewRound: 1,
      ...postApproveEpisode({ pendingRedispatch: true }),
    }));
    vi.spyOn(manager, 'getAgentState').mockResolvedValue({ taskId: 'task-1' } as never);
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);
    await recoverGitPostApprovePending(eventBus, manager);
    expect(continueSpy).toHaveBeenCalledWith('task-1', 'dev-1', 'post-approve', expect.not.objectContaining({
      postApproveRedispatchCount: expect.anything(),
    }));
  });

  it('consumes a fresh revision even when the pass is already pending (crash-replay stays a no-op)', async () => {
    await taskStore.set(gitTask({
      status: 'approved', prNumber: 42, latestHeadSha: SHA1,
      signalToken: 'ffff00001111', reviewRound: 1,
      replyActorId: '77', replyActorStatus: 'verified',
      ...postApproveEpisode({ pendingRedispatch: true }),
    }));
    vi.spyOn(manager, 'getAgentState').mockResolvedValue({ taskId: 'task-1' } as never);
    const revision = { sourceKey: 'issue-comments', id: 'c8', bodyDigest: 'd'.repeat(64), versionTime: 2000 };
    await eventBus.emit({
      id: '', type: 'pr.updated', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
      data: { kind: 'comment', prNumber: 42, commentId: 'c8', revision },
    });
    const task = await taskStore.get('task-1');
    expect(task?.consumedFeedback).toEqual({ [`issue-comments:c8:${'d'.repeat(64)}`]: 2000 });
    expect(task?.pendingRedispatch).toBe(true);
  });

  it('consumes merge-ready feedback against the live state when the entry snapshot is stale', async () => {
    await taskStore.set(gitTask({
      status: 'approved', prNumber: 42, latestHeadSha: SHA1,
      signalToken: 'ffff00001111', reviewRound: 1,
    }));
    const realGet = manager.getTask.bind(manager);
    let first = true;
    vi.spyOn(manager, 'getTask').mockImplementation(async (id: string) => {
      const task = await realGet(id);
      if (first && task) {
        first = false;
        await taskStore.set({ ...task, status: 'merge-ready', updatedAt: new Date().toISOString() });
        return task;
      }
      return task;
    });
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);
    const revision = { sourceKey: 'issue-comments', id: 'c9', bodyDigest: 'e'.repeat(64), versionTime: 2100 };
    await eventBus.emit({
      id: '', type: 'pr.updated', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
      data: { kind: 'comment', prNumber: 42, commentId: 'c9', revision },
    });
    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('approved');
    expect(task?.consumedFeedback).toEqual({ [`issue-comments:c9:${'e'.repeat(64)}`]: 2100 });
    expect(continueSpy).toHaveBeenCalled();
  });
});

describe('git feedback return and reconciliation re-arm', () => {
  it('returns merge-ready feedback on platforms whose head shas are not 40 hex chars', async () => {
    const shortSha = 'abc123def456';
    await taskStore.set(gitTask({
      status: 'merge-ready', prNumber: 42, latestHeadSha: shortSha,
      reviewHeadAnchorSha: shortSha, signalToken: 'ffff00001111', reviewRound: 1,
    }));
    const returned = asReturned(await manager.consumeGitFeedbackRevision('task-1', {
      key: 'issue-comments:c1:sha', versionTime: 2200,
    }));
    expect(returned?.status).toBe('approved');
    expect(returned?.postApproveHeadSha).toBe(shortSha);
  });

  it('re-arms the reconciliation entry when a matching late signal carries no actor segment', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1',
      signalToken: 'ffff00001111', pendingPrSignalToken: 'aaaa11112222',
      replyActorId: '99', replyActorStatus: 'provisional',
    }));
    const rearm = vi.spyOn(manager, 'rearmGitReconciliationWatcher').mockResolvedValue(undefined);
    await eventBus.emit(prCreated({ source: 'pane-signal', token: 'aaaa11112222' }));
    const task = await taskStore.get('task-1');
    expect(task).toMatchObject({ replyActorId: '99', replyActorStatus: 'provisional' });
    expect(task?.pendingPrSignalToken).toBe('aaaa11112222');
    expect(rearm).toHaveBeenCalledWith('task-1', { skipSnapshot: true });
    expect(emitted.find(e => e.type === 'human.intervention')?.data).toMatchObject({
      phase: 'git-pr-created-actor-missing',
    });
  });
});

describe('generation-fenced review dispatch', () => {
  it('derives the QA phase from the locked lease when the entry snapshot becomes stale', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1', reviewRound: 0,
      reviewRoundPending: true, latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1,
    }));
    const realGet = manager.getTask.bind(manager);
    vi.spyOn(manager, 'getTask').mockImplementationOnce(async (id: string) => {
      const task = await realGet(id);
      if (task) {
        await taskStore.set({ ...task, reviewRound: 1, updatedAt: new Date().toISOString() });
      }
      return task;
    });
    const dispatch = vi.spyOn(manager, 'dispatchGitReviewLease').mockImplementation(async () => {
      return (await realGet('task-1'))!;
    });

    await eventBus.emit({
      id: '', type: 'pr.updated', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
      data: { kind: 'push', prNumber: 42, branch: 'bx/task-1', headSha: SHA2 },
    });

    const task = await taskStore.get('task-1');
    expect(task?.reviewDispatch).toMatchObject({ effectiveRound: 2, qaPhase: 'recheck' });
    expect(dispatch).toHaveBeenCalledWith('task-1', {
      expectedGeneration: task!.reviewDispatch!.generation,
    });
  });

  it('pending lease survives a failed QA dispatch and the sweep retries the same generation', async () => {
    await taskStore.set(gitTask({ qaAgentId: 'qa-1' }));
    await eventBus.emit(panePrCreated({ targetBranch: 'main' }));
    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('review');
    expect(task?.reviewDispatch?.phase).toBe('pending');
    vi.spyOn(manager, 'platformVerifyPrBinding').mockResolvedValue({
      ok: true, headSha: SHA1, branch: 'bx/task-1', targetBranch: 'main',
    });
    const dispatchSpy = vi.spyOn(manager, 'dispatchGitReviewLease').mockResolvedValue(task!);
    expect(task?.reviewRoundPending).toBe(true);
    await manager.retryPendingGitReviewDispatches();
    expect(dispatchSpy).toHaveBeenCalledWith('task-1', {
      expectedGeneration: task!.reviewDispatch!.generation,
    });
  });

  it('alerts once when the bound QA is missing from config and stops probing the lease', async () => {
    await taskStore.set(gitTask({ qaAgentId: 'qa-gone' }));
    await eventBus.emit(panePrCreated({ targetBranch: 'main' }));
    const verify = vi.spyOn(manager, 'platformVerifyPrBinding');
    const dispatch = vi.spyOn(manager, 'dispatchGitReviewLease');

    await manager.retryPendingGitReviewDispatches();
    await manager.retryPendingGitReviewDispatches();

    expect(verify).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    const alerts = emitted.filter(event => event.type === 'human.intervention'
      && event.data.phase === 'git-review-qa-config-missing');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.data).toMatchObject({ qaAgentId: 'qa-gone' });
    expect((await taskStore.get('task-1'))?.reviewDispatch?.phase).toBe('pending');
  });

  it('treats a bound QA whose config role changed as missing and alerts once', async () => {
    await taskStore.set(gitTask({ qaAgentId: 'qa-1' }));
    await eventBus.emit(panePrCreated({ targetBranch: 'main' }));
    expect((await taskStore.get('task-1'))?.reviewDispatch?.phase).toBe('pending');
    const originalConfig = manager.getAgentConfig.bind(manager);
    vi.spyOn(manager, 'getAgentConfig').mockImplementation(id => {
      const config = originalConfig(id);
      return id === 'qa-1' && config ? { ...config, role: 'dev' } : config;
    });
    const dispatch = vi.spyOn(manager, 'dispatchGitReviewLease');

    await manager.retryPendingGitReviewDispatches();
    await manager.retryPendingGitReviewDispatches();

    expect(dispatch).not.toHaveBeenCalled();
    expect(emitted.filter(event => event.type === 'human.intervention'
      && event.data.phase === 'git-review-qa-config-missing')).toHaveLength(1);
  });

  it('treats a bound QA moved to another project as missing and alerts once', async () => {
    await taskStore.set(gitTask({ qaAgentId: 'qa-1' }));
    await eventBus.emit(panePrCreated({ targetBranch: 'main' }));
    expect((await taskStore.get('task-1'))?.reviewDispatch?.phase).toBe('pending');
    const originalConfig = manager.getAgentConfig.bind(manager);
    vi.spyOn(manager, 'getAgentConfig').mockImplementation(id => {
      const config = originalConfig(id);
      return id === 'qa-1' && config ? { ...config, projectId: 'other' } : config;
    });
    const verify = vi.spyOn(manager, 'platformVerifyPrBinding');
    const dispatch = vi.spyOn(manager, 'dispatchGitReviewLease');

    await manager.retryPendingGitReviewDispatches();
    await manager.retryPendingGitReviewDispatches();

    expect(verify).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(emitted.filter(event => event.type === 'human.intervention'
      && event.data.phase === 'git-review-qa-config-missing')).toHaveLength(1);
  });

  it('the dispatch entry refuses a QA bound to another project and resets the claim', async () => {
    await taskStore.set(gitTask({ qaAgentId: 'qa-1' }));
    await eventBus.emit(panePrCreated({ targetBranch: 'main' }));
    expect((await taskStore.get('task-1'))?.reviewDispatch?.phase).toBe('pending');
    const originalConfig = manager.getAgentConfig.bind(manager);
    vi.spyOn(manager, 'getAgentConfig').mockImplementation(id => {
      const config = originalConfig(id);
      return id === 'qa-1' && config ? { ...config, projectId: 'other' } : config;
    });

    await expect(manager.dispatchGitReviewLease('task-1', {}))
      .rejects.toThrow('QA participant is unavailable');
    expect((await taskStore.get('task-1'))?.reviewDispatch?.phase).toBe('pending');
  });

  it('isolates a task read failure in the config alert branch from the rest of the sweep', async () => {
    await taskStore.set(gitTask({ qaAgentId: 'qa-gone' }));
    await taskStore.set(gitTask({ id: 'task-2', branch: 'bx/task-2', qaAgentId: 'qa-1' }));
    await eventBus.emit(panePrCreated({ targetBranch: 'main' }));
    await eventBus.emit({
      ...panePrCreated({
        prNumber: 43, prUrl: 'https://x/pull/43', branch: 'bx/task-2', targetBranch: 'main',
      }),
      taskId: 'task-2',
    });
    const task2 = await taskStore.get('task-2');
    expect(task2?.reviewDispatch?.phase).toBe('pending');
    const originalGet = taskStore.get.bind(taskStore);
    vi.spyOn(taskStore, 'get').mockImplementation(async id => {
      if (id === 'task-1') throw new Error('transient read failure');
      return originalGet(id);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(manager, 'platformVerifyPrBinding').mockResolvedValue({
      ok: true, headSha: SHA1, branch: 'bx/task-2', targetBranch: 'main',
    });
    const dispatch = vi.spyOn(manager, 'dispatchGitReviewLease').mockResolvedValue(task2!);

    await manager.retryPendingGitReviewDispatches();

    expect(dispatch).toHaveBeenCalledWith('task-2', {
      expectedGeneration: task2!.reviewDispatch!.generation,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('qa-config alert check failed'),
      expect.any(Error),
    );
  });

  it('lists participant seats only for active tasks with their expected roles', async () => {
    await taskStore.set(gitTask({ qaAgentId: 'qa-1' }));
    await taskStore.set(gitTask({ id: 'task-2', branch: 'bx/task-2', status: 'merged' }));

    expect(await manager.listActiveParticipantSeats()).toEqual([
      {
        taskId: 'task-1',
        projectId: 'proj',
        participants: [
          { agentId: 'dev-1', expectedRole: 'dev' },
          { agentId: 'qa-1', expectedRole: 'qa' },
        ],
      },
    ]);
  });

  it('propagates task store read failures out of the participant seat scan', async () => {
    vi.spyOn(taskStore, 'listStrict').mockRejectedValue(new Error('scan read failed'));

    await expect(manager.listActiveParticipantSeats()).rejects.toThrow('scan read failed');
  });

  it('does not alert from a stale sweep snapshot once the live lease has rotated', async () => {
    await taskStore.set(gitTask({ qaAgentId: 'qa-gone' }));
    await eventBus.emit(panePrCreated({ targetBranch: 'main' }));
    const stale = (await taskStore.get('task-1'))!;
    expect(stale.reviewDispatch?.phase).toBe('pending');
    await taskStore.set({
      ...stale,
      reviewDispatch: { ...stale.reviewDispatch!, generation: 'aaaa11112222' },
    });
    vi.spyOn(taskStore, 'list').mockResolvedValue([stale]);

    await manager.retryPendingGitReviewDispatches();

    expect(emitted.filter(event => event.type === 'human.intervention'
      && event.data.phase === 'git-review-qa-config-missing')).toHaveLength(0);
  });

  it('successful delivery clears the lease and the sweep does not replay it', async () => {
    await taskStore.set(gitTask({ qaAgentId: 'qa-1' }));
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'startSession').mockResolvedValue(true);
    vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);
    await eventBus.emit(panePrCreated({ targetBranch: 'main' }));

    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('review');
    expect(task?.reviewDispatch).toBeUndefined();

    const dispatchSpy = vi.spyOn(manager, 'dispatchGitReviewLease');
    await manager.retryPendingGitReviewDispatches();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('watcher arm failure resets the claim to pending without rolling back the pass', async () => {
    await taskStore.set(gitTask({ qaAgentId: 'qa-1' }));
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    const watcher = manager as unknown as { setupPhaseSignalWatcher: () => Promise<boolean> };
    vi.spyOn(watcher, 'setupPhaseSignalWatcher').mockResolvedValue(false);
    await eventBus.emit(panePrCreated({ targetBranch: 'main' }));

    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('review');
    expect(task?.reviewDispatch?.phase).toBe('pending');
    expect(task?.reviewRoundPending).toBe(true);
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'git-review-dispatch-failed', qaPhase: 'review',
    });
  });

  it('startSession failure resets the claim to pending', async () => {
    await taskStore.set(gitTask({ qaAgentId: 'qa-1', prNumber: 42, latestHeadSha: SHA1 }));
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'startSession').mockResolvedValue(false);
    await eventBus.emit({
      id: '', type: 'pr.updated', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
      data: { prNumber: 42, headSha: SHA2, action: 'synchronize' },
    });

    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('review');
    expect(task?.reviewDispatch?.phase).toBe('pending');
    expect(task?.reviewRoundPending).toBe(true);
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'git-review-dispatch-failed', qaPhase: 'review',
    });
  });

  it('keeps an ack-unknown delivery as an uncertain lease instead of failing the task', async () => {
    await taskStore.set(gitTask({ qaAgentId: 'qa-1' }));
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'startSession').mockRejectedValue(
      new DispatchTerminalError('ack_unknown', 'delivery outcome unknown'),
    );
    const fail = vi.spyOn(manager, 'failTaskForDispatchError');

    await eventBus.emit(panePrCreated({ targetBranch: 'main' }));

    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('review');
    expect(task?.reviewDispatch?.phase).toBe('uncertain');
    expect(fail).not.toHaveBeenCalled();
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'git-review-dispatch-uncertain', qaPhase: 'review',
    });
  });

  it('keeps a pr.updated push ack-unknown as an uncertain lease without failing the task', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1', reviewRound: 1,
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1,
      signalToken: 'ffff00001111', passToken: 'abcdef123456', failToken: '123456abcdef',
    }));
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'startSession').mockRejectedValue(
      new DispatchTerminalError('ack_unknown', 'push delivery outcome unknown'),
    );
    const fail = vi.spyOn(manager, 'failTaskForDispatchError');

    await eventBus.emit({
      id: '', type: 'pr.updated', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
      data: { kind: 'push', prNumber: 42, branch: 'bx/task-1', headSha: SHA2 },
    });

    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'review', latestHeadSha: SHA2,
      reviewDispatch: { phase: 'uncertain', headSha: SHA2 },
    });
    expect(fail).not.toHaveBeenCalled();
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'git-review-dispatch-uncertain', qaPhase: 'recheck',
    });
  });

  it('surfaces a newer push deferred behind an uncertain review delivery', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1', reviewRound: 1,
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1,
      signalToken: 'ffff00001111', passToken: 'abcdef123456', failToken: '123456abcdef',
    }));
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'startSession').mockRejectedValue(
      new DispatchTerminalError('ack_unknown', 'push delivery outcome unknown'),
    );
    await eventBus.emit({
      id: '', type: 'pr.updated', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
      data: { kind: 'push', prNumber: 42, branch: 'bx/task-1', headSha: SHA2 },
    });
    emitted.length = 0;
    const newestHead = 'c'.repeat(40);

    await eventBus.emit({
      id: '', type: 'pr.updated', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
      data: { kind: 'push', prNumber: 42, branch: 'bx/task-1', headSha: newestHead },
    });

    expect((await taskStore.get('task-1'))?.reviewDispatch).toMatchObject({
      phase: 'uncertain', headSha: SHA2,
    });
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'git-review-dispatch-uncertain', qaPhase: 'recheck', headSha: newestHead,
    });
  });

  it('routes a terminal review dispatch error through failTaskForDispatchError', async () => {
    await taskStore.set(gitTask({ qaAgentId: 'qa-1' }));
    const error = new DispatchTerminalError('prompt_too_large', 'prompt too large');
    vi.spyOn(manager, 'dispatchGitReviewLease').mockRejectedValue(error);
    const fail = vi.spyOn(manager, 'failTaskForDispatchError').mockResolvedValue(undefined);

    await eventBus.emit(panePrCreated({ targetBranch: 'main' }));

    expect(fail).toHaveBeenCalledWith(
      'task-1', 'review', 'qa-1', error,
      { expectedReviewDispatch: expect.objectContaining({ phase: 'pending' }) },
    );
  });

  it('routes a terminal pr.updated dispatch error through failTaskForDispatchError', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1', reviewRound: 1,
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1,
      signalToken: 'ffff00001111', passToken: 'abcdef123456', failToken: '123456abcdef',
    }));
    const error = new DispatchTerminalError('required_skills_missing', 'QA skill missing');
    vi.spyOn(manager, 'dispatchGitReviewLease').mockRejectedValue(error);
    const fail = vi.spyOn(manager, 'failTaskForDispatchError').mockResolvedValue(undefined);

    await eventBus.emit({
      id: '', type: 'pr.updated', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
      data: { kind: 'push', prNumber: 42, branch: 'bx/task-1', headSha: SHA2 },
    });

    expect(fail).toHaveBeenCalledWith(
      'task-1', 'recheck', 'qa-1', error,
      { expectedReviewDispatch: expect.objectContaining({ phase: 'pending', headSha: SHA2 }) },
    );
  });

  it('the sweep ignores a lease removed after its old snapshot was observed', async () => {
    await taskStore.set(gitTask());
    await eventBus.emit(panePrCreated({ targetBranch: 'main' }));
    const stale = await taskStore.get('task-1');
    expect(stale?.reviewDispatch?.phase).toBe('pending');
    await taskStore.set({ ...(stale!), reviewDispatch: undefined, updatedAt: new Date().toISOString() });
    const dispatchSpy = vi.spyOn(manager, 'dispatchGitReviewLease');

    await manager.retryPendingGitReviewDispatches();

    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('the sweep yields to a matching in-memory busy observation', async () => {
    await taskStore.set(gitTask());
    await eventBus.emit(panePrCreated({ targetBranch: 'main' }));
    const live = await taskStore.get('task-1');
    manager.registerPendingDispatchRetry('task-1', {
      kind: 'qa-recheck', agentId: 'qa-1', signalToken: live!.signalToken!,
    });
    const dispatchSpy = vi.spyOn(manager, 'dispatchGitReviewLease');

    await manager.retryPendingGitReviewDispatches();

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(manager.getPendingDispatchRetry('task-1')).toBeTruthy();
  });

  it('recovery re-arms instead of re-injecting while the delivered prompt is still running', async () => {
    await taskStore.set(gitTask({
      status: 'approved', prNumber: 42, latestHeadSha: SHA1,
      signalToken: 'ffff00001111', reviewRound: 1,
      ...postApproveEpisode({ postApprovePhase: 'delivered', pendingRedispatch: true }),
    }));
    vi.spyOn(manager, 'getAgentState').mockResolvedValue({ taskId: 'task-1' } as never);
    const rearm = vi.spyOn(manager, 'rearmPostApproveSignal').mockResolvedValue(true);
    const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);
    await recoverGitPostApprovePending(eventBus, manager);
    expect(continueSpy).not.toHaveBeenCalled();
    expect(rearm).toHaveBeenCalledWith('task-1');

    await taskStore.set({
      ...(await taskStore.get('task-1'))!, postApprovePhase: 'signaled', updatedAt: RECOVERY_READY_AT,
    });
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    await recoverGitPostApprovePending(eventBus, manager);
    expect(continueSpy).toHaveBeenCalled();
  });

  it.each([
    ['refuses the active episode', false, 're-arm refused'],
    ['throws', new Error('watcher unavailable'), 'watcher unavailable'],
  ])('recovery reports an intervention when post-approve re-arm %s', async (_label, result, message) => {
    await taskStore.set(gitTask({
      status: 'approved', prNumber: 42, latestHeadSha: SHA1,
      signalToken: 'ffff00001111', reviewRound: 1,
      ...postApproveEpisode({ postApprovePhase: 'delivered', pendingRedispatch: true }),
    }));
    vi.spyOn(manager, 'getAgentState').mockResolvedValue({ taskId: 'task-1' } as never);
    const rearm = vi.spyOn(manager, 'rearmPostApproveSignal');
    if (result instanceof Error) rearm.mockRejectedValue(result);
    else rearm.mockResolvedValue(result);

    await recoverGitPostApprovePending(eventBus, manager);

    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'human.intervention',
      data: expect.objectContaining({ phase: 'post-approve-recovery-failed', error: expect.stringContaining(message) }),
    }));
  });

  it('rejects a stale REQUEST_CHANGES once the round rotated during its await window', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1',
      signalToken: 'ffff00001111', passToken: 'abcdef123456', failToken: '123456abcdef',
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1, reviewRound: 1,
    }));
    const realTransition = manager.transitionTaskStatus.bind(manager);
    vi.spyOn(manager, 'transitionTaskStatus').mockImplementationOnce(async (id, to, guard, patch) => {
      const t = await taskStore.get('task-1');
      await taskStore.set({ ...t!, signalToken: 'eeee99990000', updatedAt: new Date().toISOString() });
      return realTransition(id, to, guard, patch);
    });
    await eventBus.emit({
      id: '', type: 'review.submitted', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'qa-1', taskId: 'task-1',
      data: gitVerdict({
        action: 'REQUEST_CHANGES', verdictToken: '123456abcdef',
        verdictCarrier: { sourceKey: 'reviews', id: 'r9', bodyDigest: 'a'.repeat(64) },
      }),
    });
    expect((await taskStore.get('task-1'))?.status).toBe('review');
  });

  it('keeps the task merged when post-merge cleanup fails', async () => {
    await taskStore.set(gitTask({ status: 'merge-ready', prNumber: 42 }));
    vi.spyOn(manager, 'cleanupAfterMerge').mockRejectedValue(new Error('cleanup unavailable'));

    await expect(eventBus.emit({
      id: '', type: 'pr.merged', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
      data: { prNumber: 42, branch: 'bx/task-1', prUrl: 'https://x/pull/42' },
    })).resolves.toBeUndefined();

    expect((await taskStore.get('task-1'))?.status).toBe('merged');
  });
});

describe('durable review dispatch and post-approve retry fencing', () => {
  it('sweep dispatches a durable pending lease by generation', async () => {
    await taskStore.set(gitTask({ status: 'fixing', prNumber: 42, qaAgentId: 'qa-1', reviewRound: 1 }));
    const begun = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['fixing'], headSha: SHA1, bumpRound: false,
    });
    vi.spyOn(manager, 'platformVerifyPrBinding').mockResolvedValue({
      ok: true, headSha: SHA1, branch: 'bx/task-1', targetBranch: 'main',
    });
    const dispatchSpy = vi.spyOn(manager, 'dispatchGitReviewLease').mockResolvedValue(begun!.task);
    await manager.retryPendingGitReviewDispatches();
    expect(dispatchSpy).toHaveBeenCalledWith('task-1', {
      expectedGeneration: begun!.task.reviewDispatch!.generation,
    });
  });

  it('a stale generation cannot claim its successor lease', async () => {
    await taskStore.set(gitTask({ status: 'review', prNumber: 42, reviewRound: 1 }));
    const first = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['review'], headSha: SHA1, bumpRound: false,
    });
    const second = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['review'], headSha: SHA2, bumpRound: true,
      expectSignalToken: first!.task.signalToken,
    });
    expect(await manager.claimGitReviewDispatch('task-1', first!.task.reviewDispatch!.generation)).toBeNull();
    const claimed = await manager.claimGitReviewDispatch('task-1', second!.task.reviewDispatch!.generation);
    expect(claimed?.lease).toMatchObject({
      generation: second!.task.reviewDispatch!.generation,
      phase: 'claimed',
      headSha: SHA2,
    });
  });

  it('keeps the installed completion for the sweep when the post-approve prompt fails to start', async () => {
    await taskStore.set(gitTask({
      status: 'approved', prNumber: 42, latestHeadSha: SHA1,
      signalToken: 'ffff00001111', reviewRound: 1,
      ...postApproveEpisode(),
    }));
    vi.spyOn(manager, 'getAgentState').mockResolvedValue(undefined as never);
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'continueSession').mockResolvedValue(false);
    const revision = { sourceKey: 'issue-comments', id: 'cf', bodyDigest: 'f'.repeat(64), versionTime: 2300 };
    await eventBus.emit({
      id: '', type: 'pr.updated', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
      data: { kind: 'comment', prNumber: 42, commentId: 'cf', revision },
    });
    const task = await taskStore.get('task-1');
    expect(task?.postApproveToken).toBeDefined();
    expect(task?.pendingRedispatch).toBe(true);
    expect(task?.postApprovePhase).toBe('installed');
  });

  it('leaves a durable retry anchor when the dev cannot be acquired for post-approve', async () => {
    await taskStore.set(gitTask({
      status: 'approved', prNumber: 42, latestHeadSha: SHA1,
      signalToken: 'ffff00001111', reviewRound: 1,
      ...postApproveEpisode(),
    }));
    vi.spyOn(manager, 'getAgentState').mockResolvedValue(undefined as never);
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(false);
    const revision = { sourceKey: 'issue-comments', id: 'cg', bodyDigest: '9'.repeat(64), versionTime: 2400 };
    await eventBus.emit({
      id: '', type: 'pr.updated', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
      data: { kind: 'comment', prNumber: 42, commentId: 'cg', revision },
    });
    expect((await taskStore.get('task-1'))?.pendingRedispatch).toBe(true);
    expect(emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'post-approve-dev-acquire-failed', devAgentId: 'dev-1',
    });
  });

  it('a stale approve after a concurrent round rotation cannot overwrite the successor head', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1',
      signalToken: 'ffff00001111', passToken: 'abcdef123456', failToken: '123456abcdef',
      latestHeadSha: SHA2, reviewHeadAnchorSha: SHA1, reviewRound: 1,
    }));
    const realApprove = manager.approveGitReviewPass.bind(manager);
    vi.spyOn(manager, 'approveGitReviewPass').mockImplementationOnce(async (id, opts) => {
      const t = await taskStore.get('task-1');
      await taskStore.set({ ...t!, signalToken: 'eeee99990000', updatedAt: new Date().toISOString() });
      return realApprove(id, opts);
    });
    await eventBus.emit({
      id: '', type: 'review.submitted', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'qa-1', taskId: 'task-1',
      data: gitVerdict({}),
    });
    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('review');
    expect(task?.latestHeadSha).toBe(SHA2);
  });
});
