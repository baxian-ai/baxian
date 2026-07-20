import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentManager } from '../../src/agent/manager.js';
import { AgentStore } from '../../src/state/agent-store.js';
import { TaskStore } from '../../src/state/task-store.js';
import { LockManager } from '../../src/state/lock.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { initStateDir } from '../../src/state/init.js';
import { recoverGitPostApprovePending, registerEventHandlers } from '../../src/event/handlers.js';
import type { BaxianConfig, BaxianEvent, TaskState } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';

const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

const CONFIG: BaxianConfig = {
  review: { rounds: 3 },
  server: DEFAULT_SERVER_CONFIG,
  host: [],
  project: [{
    id: 'proj',
    repo: 'git@github.com:owner/repo.git',
    merge: null,
    agent: [[
      { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp/repo' },
      { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local', workdir: '/tmp/qa' },
    ]],
  }],
};

let tempDir: string;
let taskStore: TaskStore;
let eventBus: EventBus;
let manager: AgentManager;
let emitted: BaxianEvent[];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'bx-handlers-git-'));
  await initStateDir(tempDir);
  taskStore = new TaskStore(join(tempDir, 'state', 'tasks'));
  eventBus = new EventBus(new EventLog(join(tempDir, 'events')));
  emitted = [];
  eventBus.on('*', (evt) => { emitted.push(evt); });
  manager = new AgentManager({
    config: CONFIG,
    agentStore: new AgentStore(join(tempDir, 'state', 'agents')),
    taskStore,
    lockManager: new LockManager(join(tempDir, 'locks')),
    eventBus,
  });
  vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);
  registerEventHandlers(eventBus, manager);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

function gitTask(over: Partial<TaskState> = {}): TaskState {
  const now = new Date().toISOString();
  return {
    id: 'task-1', projectId: 'proj', title: 'T', description: 'd',
    preferredAgentId: 'dev-1', agentId: 'dev-1', devAgentId: 'dev-1',
    reviewRound: 0, status: 'in_progress', phase: 'code', createdAt: now, updatedAt: now,
    reviewMode: 'git', branch: 'bx/task-1', branchCreatedByBaxian: true,
    signalToken: 'aaaa11112222',
    ...over,
  };
}

function prCreated(data: Record<string, unknown>): BaxianEvent {
  return {
    id: '', type: 'pr.created', timestamp: new Date().toISOString(),
    projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
    data: { prNumber: 42, prUrl: 'https://x/pull/42', branch: 'bx/task-1', headSha: SHA1, ...data },
  };
}

describe('pr.created (git, poller source)', () => {
  it('adopts with a base snapshot and a provisional reply actor, then no-ops on replay', async () => {
    await taskStore.set(gitTask());
    await eventBus.emit(prCreated({ targetBranch: 'main', prAuthorId: '99' }));
    let task = await taskStore.get('task-1');
    expect(task).toMatchObject({
      status: 'review', prNumber: 42, baseBranch: 'main',
      replyActorId: '99', replyActorStatus: 'provisional',
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1,
    });

    // 派发完成后（pending 清除）同号重放才是纯 no-op；pending 在场时重放是有意的重试驱动
    await manager.clearReviewDispatchPending('task-1', (await taskStore.get('task-1'))!.signalToken!);
    const transitionSpy = vi.spyOn(manager, 'transitionTaskStatus');
    await eventBus.emit(prCreated({ targetBranch: 'main', prAuthorId: '99' }));
    task = await taskStore.get('task-1');
    expect(task?.status).toBe('review');
    expect(transitionSpy).not.toHaveBeenCalled();
  });

  it('adopts without actor fields when the row carried no author id', async () => {
    await taskStore.set(gitTask());
    await eventBus.emit(prCreated({ targetBranch: 'main' }));
    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('review');
    expect(task?.replyActorId).toBeUndefined();
    expect(task?.replyActorStatus).toBeUndefined();
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
    expect(task?.status).toBe('review');
    expect(task?.replyActorStatus).toBeUndefined();
  });

  it('rejects a predicate mismatch to intervention instead of adopting', async () => {
    await taskStore.set(gitTask());
    vi.spyOn(manager, 'platformVerifyPrBinding').mockResolvedValue({ ok: false, reason: 'draft' });
    await eventBus.emit(prCreated({ source: 'pane-signal', token: 'aaaa11112222' }));
    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('in_progress');
    const intervention = emitted.find(e => e.type === 'human.intervention');
    expect(intervention?.data).toMatchObject({ phase: 'pane-pr-created-branch-mismatch', reason: 'draft' });
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

  it('trusts the engine payload and persists pass provenance on approval', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1',
      signalToken: 'ffff00001111', passToken: 'abcdef123456', failToken: '123456abcdef',
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1, reviewRound: 1,
      replyActorId: '77', replyActorStatus: 'verified',
    }));
    const fetchSpy = vi.spyOn(manager, 'fetchPrHeadSha');
    await eventBus.emit(reviewSubmitted({
      action: 'APPROVE', headSha: SHA1, currentHeadSha: SHA1,
      reviewPassToken: 'ffff00001111', verdictToken: 'abcdef123456',
      verdictCarrier: { sourceKey: 'reviews', id: 'r1', bodyDigest: 'f'.repeat(64) },
    }));
    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('approved');
    expect(task?.passProvenance).toEqual({
      sourceKey: 'reviews', id: 'r1', bodyDigest: 'f'.repeat(64),
      token: 'abcdef123456', failToken: '123456abcdef', anchorSha: SHA1,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('APPROVE 原子消费 durable reviewDispatchPending（verdict 即送达证据，#563 R33）', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1',
      signalToken: 'ffff00001111', passToken: 'abcdef123456', failToken: '123456abcdef',
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1, reviewRound: 1,
      reviewDispatchPending: true,
    }));
    await eventBus.emit(reviewSubmitted({
      action: 'APPROVE', headSha: SHA1, currentHeadSha: SHA1,
      reviewPassToken: 'ffff00001111', verdictToken: 'abcdef123456',
      verdictCarrier: { sourceKey: 'reviews', id: 'r1', bodyDigest: 'f'.repeat(64) },
    }));
    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('approved');
    expect(task?.reviewDispatchPending).toBeUndefined();
  });

  it('REQUEST_CHANGES 原子消费 durable reviewDispatchPending（fixing 态不被 sweep 拽回 review，#563 R33）', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1',
      signalToken: 'ffff00001111', failToken: '123456abcdef',
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1, reviewRound: 1,
      reviewDispatchPending: true,
    }));
    await eventBus.emit(reviewSubmitted({
      action: 'REQUEST_CHANGES', headSha: SHA1, currentHeadSha: SHA1,
      reviewPassToken: 'ffff00001111', verdictToken: '123456abcdef',
      verdictCarrier: { sourceKey: 'reviews', id: 'r2', bodyDigest: 'a'.repeat(64) },
    }));
    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('fixing');
    expect(task?.reviewDispatchPending).toBeUndefined();
  });

  it('max_rounds 原子消费 durable reviewDispatchPending（终局同样不给 sweep 留凭据，#563 R33）', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1',
      signalToken: 'ffff00001111', failToken: '123456abcdef',
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1, reviewRound: 3,
      reviewDispatchPending: true,
    }));
    await eventBus.emit(reviewSubmitted({
      action: 'REQUEST_CHANGES', headSha: SHA1, currentHeadSha: SHA1,
      reviewPassToken: 'ffff00001111', verdictToken: '123456abcdef',
      verdictCarrier: { sourceKey: 'reviews', id: 'r3', bodyDigest: 'b'.repeat(64) },
    }));
    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('max_rounds');
    expect(task?.reviewDispatchPending).toBeUndefined();
  });

  it('updates the stored head from the engine-verified current head', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1',
      signalToken: 'ffff00001111', failToken: '123456abcdef',
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA2, reviewRound: 1,
    }));
    const fetchSpy = vi.spyOn(manager, 'fetchPrHeadSha');
    await eventBus.emit(reviewSubmitted({
      action: 'REQUEST_CHANGES', headSha: SHA2, currentHeadSha: SHA2,
      reviewPassToken: 'ffff00001111', verdictToken: '123456abcdef',
      verdictCarrier: { sourceKey: 'reviews', id: 'r2', bodyDigest: 'a'.repeat(64) },
    }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.latestHeadSha).toBe(SHA2);
  });
});

describe('git review dispatch token minting', () => {
  it('review-entering transitions mint the pair atomically with the new round visibility', async () => {
    await taskStore.set(gitTask({
      status: 'in_progress', phase: 'code',
      passToken: 'abcdef123456', failToken: '123456abcdef',
    }));
    await eventBus.emit(prCreated({ targetBranch: 'main', prAuthorId: '99' }));
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
    await manager.rotateAndSetupPhaseSignal('task-1', 'dev-1', 'pr-fixed');
    const task = await taskStore.get('task-1');
    expect(task?.passToken).toBe('abcdef123456');
    expect(task?.failToken).toBe('123456abcdef');
  });

  it('initial git dispatch persists the pr-created expectation token alongside the signal token', async () => {
    const task = gitTask();
    expect(manager.dispatchTokenFields(task, 'cccc33334444')).toEqual({
      signalToken: 'cccc33334444', pendingPrSignalToken: 'cccc33334444',
    });
    expect(manager.dispatchTokenFields({ ...task, reviewMode: 'github' }, 'cccc33334444')).toEqual({
      signalToken: 'cccc33334444',
    });
  });
});

describe('push replay idempotency (git)', () => {
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
    latestHeadSha: SHA1, postApproveHeadSha: SHA1,
    postApproveToken: 'tok123456789', signalToken: 'ffff00001111',
    replyActorId: '77', replyActorStatus: 'verified', reviewRound: 1,
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

  it('records consumption alongside the feedback timestamp while the task is fixing', async () => {
    await taskStore.set(gitTask({ status: 'fixing', prNumber: 42, latestHeadSha: SHA1 }));
    const revision = { sourceKey: 'inline-comments', id: 'i9', bodyDigest: 'b'.repeat(64), versionTime: 1800 };
    await eventBus.emit(commentEvent(revision, { kind: 'review-comment' }));
    const task = await taskStore.get('task-1');
    expect(task?.consumedFeedback).toEqual({ [`inline-comments:i9:${'b'.repeat(64)}`]: 1800 });
    expect(task?.prFeedbackReceivedAt).toBeDefined();
  });

  it('survives a crash between the merge-ready return and the dispatch via the recovery sweep', async () => {
    await taskStore.set(gitTask({
      status: 'merge-ready', prNumber: 42, latestHeadSha: SHA1,
      signalToken: 'ffff00001111', replyActorId: '77', replyActorStatus: 'verified', reviewRound: 1,
    }));
    const returned = await manager.returnMergeReadyToApproved('task-1', {
      key: 'issue-comments:c7:crash', versionTime: 1900,
    });
    expect(returned?.pendingRedispatch).toBe(true);

    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);
    await recoverGitPostApprovePending(eventBus, manager);
    const task = await taskStore.get('task-1');
    expect(task?.postApproveToken).toBeDefined();
    // continueSession 确认后 pending 才清（false 表已确认送达）
    expect(task?.pendingRedispatch).toBe(false);
    expect(continueSpy).toHaveBeenCalledWith('task-1', 'dev-1', 'post-approve', expect.objectContaining({
      postApproveRedispatchCount: 1,
    }));
  });

  it('recovery redispatches durable pending even when a completion token is installed (delivery unconfirmed)', async () => {
    await taskStore.set(gitTask({
      status: 'approved', prNumber: 42, latestHeadSha: SHA1, postApproveHeadSha: SHA1,
      pendingRedispatch: true, postApproveToken: 'tok999888777', signalToken: 'ffff00001111', reviewRound: 1,
    }));
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);
    await recoverGitPostApprovePending(eventBus, manager);
    expect(continueSpy).toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.pendingRedispatch).toBe(false);
  });

  it('recovery isolates one failing task and still redispatches the next', async () => {
    await taskStore.set(gitTask({
      id: 'task-1', status: 'approved', prNumber: 42, latestHeadSha: SHA1, postApproveHeadSha: SHA1,
      pendingRedispatch: true, signalToken: 'ffff00001111', reviewRound: 1,
    }));
    await taskStore.set(gitTask({
      id: 'task-2', status: 'approved', prNumber: 43, latestHeadSha: SHA1, postApproveHeadSha: SHA1,
      pendingRedispatch: true, signalToken: 'ffff00002222', reviewRound: 1,
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
    expect(continueSpy).toHaveBeenCalledWith('task-1', 'dev-1', 'post-approve', expect.objectContaining({
      postApproveRedispatchCount: 1,
    }));
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
    status: 'approved', prNumber: 42, latestHeadSha: SHA1, postApproveHeadSha: SHA1,
    postApproveToken: 'tok123456789', signalToken: 'ffff00001111',
    replyActorId: '77', replyActorStatus: 'verified', reviewRound: 1,
  });

  it('re-runs the pending-feedback set server-side and redispatches instead of migrating', async () => {
    await taskStore.set(approvedWithCompletion());
    vi.spyOn(manager, 'platformVerifyAcceptedPass').mockResolvedValue({ ok: true, pendingCount: 1 });
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);
    await eventBus.emit(mergeReadySignal('tok123456789'));
    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('approved');
    expect(continueSpy).toHaveBeenCalledWith('task-1', 'dev-1', 'post-approve', expect.objectContaining({
      postApproveRedispatchCount: 1,
    }));
  });

  it('stays fail closed with an intervention when the comment scan cannot complete', async () => {
    await taskStore.set(approvedWithCompletion());
    vi.spyOn(manager, 'platformVerifyAcceptedPass').mockRejectedValue(new Error('reviews source down'));
    await eventBus.emit(mergeReadySignal('tok123456789'));
    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('approved');
    // 信号已消费且 dev 不会重发：durable pending + signaled 相位交给 sweep 补派，而不是重放滚动区
    expect(task?.pendingRedispatch).toBe(true);
    expect(task?.postApprovePhase).toBe('signaled');
    expect(emitted.find(e => e.type === 'human.intervention')?.data).toMatchObject({
      phase: 'post-approve-merge-skipped-scan-failed',
    });
  });

  it('refuses the migration when the accepted pass no longer verifies', async () => {
    await taskStore.set(approvedWithCompletion());
    vi.spyOn(manager, 'platformVerifyAcceptedPass').mockResolvedValue({
      ok: false, reason: 'provenance token-dismissed',
    });
    await eventBus.emit(mergeReadySignal('tok123456789'));
    expect((await taskStore.get('task-1'))?.status).toBe('approved');
    expect(emitted.find(e => e.type === 'human.intervention')?.data).toMatchObject({
      phase: 'post-approve-merge-skipped-provenance',
    });
  });

  it('clears a stale pending flag when the authoritative scan comes back empty', async () => {
    await taskStore.set(gitTask({
      status: 'approved', prNumber: 42, latestHeadSha: SHA1, postApproveHeadSha: SHA1,
      postApproveToken: 'tok123456789', pendingRedispatch: true, signalToken: 'ffff00001111',
      replyActorId: '77', replyActorStatus: 'verified', reviewRound: 1,
    }));
    vi.spyOn(manager, 'platformVerifyAcceptedPass').mockResolvedValue({ ok: true, pendingCount: 0 });
    await eventBus.emit(mergeReadySignal('tok123456789'));
    expect((await taskStore.get('task-1'))?.status).toBe('merge-ready');
  });

  it('migrates to merge-ready when the pending set is empty', async () => {
    await taskStore.set(approvedWithCompletion());
    vi.spyOn(manager, 'platformVerifyAcceptedPass').mockResolvedValue({ ok: true, pendingCount: 0 });
    await eventBus.emit(mergeReadySignal('tok123456789'));
    expect((await taskStore.get('task-1'))?.status).toBe('merge-ready');
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
    const fetchLegacy = vi.spyOn(manager, 'fetchPrHeadSha');
    vi.spyOn(manager, 'platformVerifyPrBinding').mockResolvedValue({
      ok: true, headSha: SHA2, branch: 'bx/task-1', targetBranch: 'main',
    });
    await taskStore.set({ ...(await taskStore.get('task-1'))!, latestHeadSha: SHA2, updatedAt: new Date().toISOString() });

    await manager.dispatchReviewToQa('task-1');

    const task = await taskStore.get('task-1');
    expect(fetchLegacy).not.toHaveBeenCalled();
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
    await manager.flushGitOutbox();
    task = await taskStore.get('task-1');
    expect(task?.outbox).toBeUndefined();
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.data).toMatchObject({ eventKey: 'task-1:42:mr-closed-unmerged:1' });
  });
});

describe('review round fixes from PR review', () => {
  it('rejects a git APPROVE whose verdict payload is missing or not the current pass token', async () => {
    const base = {
      status: 'review' as const, prNumber: 42, qaAgentId: 'qa-1',
      signalToken: 'ffff00001111', passToken: 'abcdef123456', failToken: '123456abcdef',
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1, reviewRound: 1,
    };
    for (const data of [
      { action: 'APPROVE', headSha: SHA1, currentHeadSha: SHA1, reviewPassToken: 'ffff00001111' },
      {
        action: 'APPROVE', headSha: SHA1, currentHeadSha: SHA1, reviewPassToken: 'ffff00001111',
        verdictToken: 'aaaa00000000', verdictCarrier: { sourceKey: 'reviews', id: 'r1', bodyDigest: 'f'.repeat(64) },
      },
    ]) {
      emitted.length = 0;
      await taskStore.set(gitTask(base));
      await eventBus.emit({
        id: '', type: 'review.submitted', timestamp: new Date().toISOString(),
        projectId: 'proj', agentId: 'qa-1', taskId: 'task-1', data,
      });
      expect((await taskStore.get('task-1'))?.status).toBe('review');
      expect(emitted.find(e => e.type === 'human.intervention')?.data).toMatchObject({
        phase: 'git-verdict-payload-invalid',
      });
    }
  });

  it('rejects a git REQUEST_CHANGES whose verdict payload is missing or not the current fail token', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1',
      signalToken: 'ffff00001111', passToken: 'abcdef123456', failToken: '123456abcdef',
      latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1, reviewRound: 1,
    }));
    await eventBus.emit({
      id: '', type: 'review.submitted', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'qa-1', taskId: 'task-1',
      data: { action: 'REQUEST_CHANGES', headSha: SHA1, currentHeadSha: SHA1, reviewPassToken: 'ffff00001111' },
    });
    expect((await taskStore.get('task-1'))?.status).toBe('review');
    expect(emitted.find(e => e.type === 'human.intervention')?.data).toMatchObject({
      phase: 'git-verdict-payload-invalid', action: 'REQUEST_CHANGES',
    });
  });

  it('transitionToCodePhase refreshes the pr-created reconciliation token for git tasks', async () => {
    const task = gitTask({ phase: 'code' });
    const fields = manager.dispatchTokenFields(task, 'dddd55556666');
    expect(fields.pendingPrSignalToken).toBe('dddd55556666');
  });

  it('recovery redispatches a durable pending pass even while the waiting dev keeps its binding', async () => {
    await taskStore.set(gitTask({
      status: 'approved', prNumber: 42, latestHeadSha: SHA1, postApproveHeadSha: SHA1,
      pendingRedispatch: true, signalToken: 'ffff00001111', reviewRound: 1,
    }));
    vi.spyOn(manager, 'getAgentState').mockResolvedValue({ taskId: 'task-1' } as never);
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);
    await recoverGitPostApprovePending(eventBus, manager);
    expect(continueSpy).toHaveBeenCalledWith('task-1', 'dev-1', 'post-approve', expect.objectContaining({
      postApproveRedispatchCount: 1,
    }));
  });

  it('consumes a fresh revision even when the pass is already pending (crash-replay stays a no-op)', async () => {
    await taskStore.set(gitTask({
      status: 'approved', prNumber: 42, latestHeadSha: SHA1, postApproveHeadSha: SHA1,
      postApproveToken: 'tok123456789', pendingRedispatch: true,
      signalToken: 'ffff00001111', reviewRound: 1,
      replyActorId: '77', replyActorStatus: 'verified',
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

describe('second review round fixes', () => {
  it('returns merge-ready feedback on platforms whose head shas are not 40 hex chars', async () => {
    const shortSha = 'abc123def456';
    await taskStore.set(gitTask({
      status: 'merge-ready', prNumber: 42, latestHeadSha: shortSha,
      reviewHeadAnchorSha: shortSha, signalToken: 'ffff00001111', reviewRound: 1,
    }));
    const returned = await manager.returnMergeReadyToApproved('task-1', {
      key: 'issue-comments:c1:sha', versionTime: 2200,
    });
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

describe('fourth review round fixes', () => {
  it('review dispatch pending survives a failed QA dispatch and the sweep retries it', async () => {
    await taskStore.set(gitTask());
    await eventBus.emit(prCreated({ targetBranch: 'main', prAuthorId: '99' }));
    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('review');
    expect(task?.reviewDispatchPending).toBe(true);
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa').mockResolvedValue(task!);
    // 直派在 startSession 成功后才计轮：失败后的 sweep 补派带上持久化的未计轮 intent 与首评相位（#563 R16/R17/CX2），
    // 并把实时代际（expectSignalToken + expectReviewDispatchPending）压进 dispatch 锁内复核（#563 R21）
    expect(task?.reviewRoundPending).toBe(true);
    await manager.retryPendingGitReviewDispatches();
    expect(dispatchSpy).toHaveBeenCalledWith('task-1', {
      bumpRound: true,
      qaPhase: 'review',
      expectSignalToken: task!.signalToken,
      expectReviewDispatchPending: true,
      fromStatus: ['review', 'in_progress', 'fixing'],
    });
  });

  it('初次 git review 成功后按 dispatchToken 清掉持久化 pending，sweep 不再重派健康首评（#563 R27）', async () => {
    await taskStore.set(gitTask({ qaAgentId: 'qa-1' }));
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'startSession').mockResolvedValue(true);
    vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);
    await eventBus.emit(prCreated({ targetBranch: 'main', prAuthorId: '99' }));

    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('review');
    expect(task?.reviewDispatchPending).toBeUndefined();

    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa');
    await manager.retryPendingGitReviewDispatches();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('git 首评 arm 失败回滚保留 transition 写入的未计轮 intent（与 durable pending 同持，#563 CX-5.4）', async () => {
    await taskStore.set(gitTask({ qaAgentId: 'qa-1' }));
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'rotateAndSetupPhaseSignal').mockImplementation(async (taskId) => {
      const fresh = (await taskStore.get(taskId as string))!;
      await taskStore.set({ ...fresh, signalToken: 'rot-tok-11111', updatedAt: new Date().toISOString() });
      return { token: 'rot-tok-11111', armed: false };
    });
    await eventBus.emit(prCreated({ targetBranch: 'main', prAuthorId: '99' }));

    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('in_progress');
    expect(task?.reviewDispatchPending).toBe(true);
    expect(task?.reviewRoundPending).toBe(true);
  });

  it('git 首评 startSession 失败回滚保留未计轮 intent（pr.updated 起点，#563 CX-5.4）', async () => {
    await taskStore.set(gitTask({ qaAgentId: 'qa-1', prNumber: 42, latestHeadSha: SHA1 }));
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'rotateAndSetupPhaseSignal').mockImplementation(async (taskId) => {
      const fresh = (await taskStore.get(taskId as string))!;
      await taskStore.set({ ...fresh, signalToken: 'rot-tok-22222', updatedAt: new Date().toISOString() });
      return { token: 'rot-tok-22222', armed: true };
    });
    vi.spyOn(manager, 'startSession').mockResolvedValue(false);
    await eventBus.emit({
      id: '', type: 'pr.updated', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: 'task-1',
      data: { prNumber: 42, headSha: SHA2, action: 'synchronize' },
    });

    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('in_progress');
    expect(task?.reviewDispatchPending).toBe(true);
    expect(task?.reviewRoundPending).toBe(true);
  });

  it('sweep 消费谓词按实时值复核：pending 已被清掉的旧快照不再重派（#563 R21）', async () => {
    await taskStore.set(gitTask());
    await eventBus.emit(prCreated({ targetBranch: 'main', prAuthorId: '99' }));
    const stale = await taskStore.get('task-1');
    expect(stale?.reviewDispatchPending).toBe(true);
    vi.spyOn(manager, 'listActiveGitTasks').mockResolvedValue([stale!]);
    await taskStore.set({ ...(stale!), reviewDispatchPending: undefined, updatedAt: new Date().toISOString() } as never);
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa');

    await manager.retryPendingGitReviewDispatches();

    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('sweep 对同代 busy pending 让位（不空转 release/acquire），交对账观测门消费（#563 CX-3.2）', async () => {
    await taskStore.set(gitTask());
    await eventBus.emit(prCreated({ targetBranch: 'main', prAuthorId: '99' }));
    const live = await taskStore.get('task-1');
    manager.registerPendingDispatchRetry('task-1', {
      kind: 'qa-recheck', agentId: 'qa-1', signalToken: live!.signalToken!,
    });
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa');

    await manager.retryPendingGitReviewDispatches();

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(manager.getPendingDispatchRetry('task-1')).toBeTruthy();
  });

  it('recovery re-arms instead of re-injecting while the delivered prompt is still running', async () => {
    await taskStore.set(gitTask({
      status: 'approved', prNumber: 42, latestHeadSha: SHA1, postApproveHeadSha: SHA1,
      postApproveToken: 'tok123456789', postApprovePhase: 'delivered',
      pendingRedispatch: true, signalToken: 'ffff00001111', reviewRound: 1,
    }));
    vi.spyOn(manager, 'getAgentState').mockResolvedValue({ taskId: 'task-1' } as never);
    const rearm = vi.spyOn(manager, 'rearmPostApproveSignal').mockResolvedValue(true);
    const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);
    await recoverGitPostApprovePending(eventBus, manager);
    expect(continueSpy).not.toHaveBeenCalled();
    expect(rearm).toHaveBeenCalledWith('task-1');

    await taskStore.set({ ...(await taskStore.get('task-1'))!, postApprovePhase: 'signaled', updatedAt: new Date().toISOString() });
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    await recoverGitPostApprovePending(eventBus, manager);
    expect(continueSpy).toHaveBeenCalled();
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
      data: {
        action: 'REQUEST_CHANGES', headSha: SHA1, currentHeadSha: SHA1,
        reviewPassToken: 'ffff00001111', verdictToken: '123456abcdef',
        verdictCarrier: { sourceKey: 'reviews', id: 'r9', bodyDigest: 'a'.repeat(64) },
      },
    });
    expect((await taskStore.get('task-1'))?.status).toBe('review');
  });
});

describe('fifth review round fixes', () => {
  it('sweep re-enters review for a rolled-back fixing task that still owes a dispatch', async () => {
    await taskStore.set(gitTask({
      status: 'fixing', prNumber: 42, reviewDispatchPending: true,
      signalToken: 'ffff00001111', reviewRound: 1,
    }));
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa').mockResolvedValue(gitTask());
    await manager.retryPendingGitReviewDispatches();
    expect(dispatchSpy).toHaveBeenCalledWith('task-1', {
      bumpRound: false,
      expectSignalToken: 'ffff00001111',
      expectReviewDispatchPending: true,
      fromStatus: ['review', 'in_progress', 'fixing'],
    });
  });

  it('keeps a sibling generation pending when a stale clear arrives with the old token', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, reviewDispatchPending: true,
      signalToken: 'bbbb22223333', reviewRound: 2,
    }));
    await manager.clearReviewDispatchPending('task-1', 'aaaa11112222');
    expect((await taskStore.get('task-1'))?.reviewDispatchPending).toBe(true);
    await manager.clearReviewDispatchPending('task-1', 'bbbb22223333');
    expect((await taskStore.get('task-1'))?.reviewDispatchPending).toBeUndefined();
  });

  it('keeps the installed completion for the sweep when the post-approve prompt fails to start', async () => {
    await taskStore.set(gitTask({
      status: 'approved', prNumber: 42, latestHeadSha: SHA1, postApproveHeadSha: SHA1,
      signalToken: 'ffff00001111', reviewRound: 1,
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
      status: 'approved', prNumber: 42, latestHeadSha: SHA1, postApproveHeadSha: SHA1,
      signalToken: 'ffff00001111', reviewRound: 1,
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
  });

  it('a stale approve after a concurrent round rotation cannot overwrite the successor head', async () => {
    await taskStore.set(gitTask({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1',
      signalToken: 'ffff00001111', passToken: 'abcdef123456', failToken: '123456abcdef',
      latestHeadSha: SHA2, reviewHeadAnchorSha: SHA1, reviewRound: 1,
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
      data: {
        action: 'APPROVE', headSha: SHA1, currentHeadSha: SHA1,
        reviewPassToken: 'ffff00001111', verdictToken: 'abcdef123456',
        verdictCarrier: { sourceKey: 'reviews', id: 'r1', bodyDigest: 'f'.repeat(64) },
      },
    });
    const task = await taskStore.get('task-1');
    expect(task?.status).toBe('review');
    expect(task?.latestHeadSha).toBe(SHA2);
  });
});
