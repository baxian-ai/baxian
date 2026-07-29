import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  BaxianConfig,
  CodeVerdictOutboxEntry,
  SpecVerdictOutboxEntry,
  TaskState,
} from '../../src/shared/index.js';
import { taskAttentionGeneration } from '../../src/shared/index.js';
import {
  DispatchTerminalError, PlatformMergeRecheckError, type AgentManager,
} from '../../src/agent/manager.js';
import { AgentStore } from '../../src/state/agent-store.js';
import type { TaskStore } from '../../src/state/task-store.js';
import { LockManager } from '../../src/state/lock.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import type { GitDriver, OpVars } from '../../src/platform/git-driver.js';
import { DriverOpError } from '../../src/platform/git-driver.js';
import type { NormalizedRow } from '../../src/platform/row-schema.js';
import type { CommentSourceOp } from '../../src/platform/types.js';
import { buildAckMarker, buildReviewTokenLine } from '../../src/platform/markers.js';
import { PrConversationCache, prReviewCacheRevision } from '../../src/platform/pr-conversation-cache.js';
import { sha256Hex } from '../../src/platform/body-digest.js';
import { COMMENT_BODY_MAX_BYTES } from '../../src/platform/command-renderer.js';
import { createManagerHarness } from '../helpers/manager-harness.js';
import { makeAgent, makeConfig, makeTask } from '../helpers/fixtures.js';

const SHA1 = 'a'.repeat(40);
const TS = '2026-07-17T01:02:03Z';
const POST_APPROVE_GENERATION = 'feedfeedfeed';

const SOURCES: CommentSourceOp[] = [
  { key: 'issue-comments', argv: ['{binary}'], map: { id: 'id', body: 'body' } },
  { key: 'inline-comments', argv: ['{binary}'], map: { id: 'id', body: 'body', discussionId: { sources: ['r'], optional: true } } },
  { key: 'reviews', argv: ['{binary}'], map: { id: 'id', body: 'body', reviewState: { sources: ['s'], optional: true } } },
] as unknown as CommentSourceOp[];

class FakeDriver {
  visibilityLagMs = 5000;
  commentSources = SOURCES;
  prView: NormalizedRow | Error = prRow();
  defaultBranch: string | Error = 'main';
  remoteProjectId: string | Error = 'R_repo';
  branchHead: string | undefined | Error = undefined;
  closeError: Error | undefined;
  deleteError: Error | undefined;
  commentError: Error | undefined;
  commentLandsBeforeError = false;
  commentVisibleAfterWrite = true;
  comments: Record<string, NormalizedRow[] | Error> = { 'issue-comments': [], 'inline-comments': [], 'reviews': [] };
  ops: Array<{ op: string; vars: OpVars }> = [];
  mergeError: Error | undefined;

  async runOp(opName: string, vars: OpVars = {}): Promise<NormalizedRow[]> {
    this.ops.push({ op: opName, vars });
    if (opName === 'prView') {
      if (this.prView instanceof Error) throw this.prView;
      return [this.prView];
    }
    if (opName === 'projectView') {
      if (this.defaultBranch instanceof Error) throw this.defaultBranch;
      if (this.remoteProjectId instanceof Error) throw this.remoteProjectId;
      return [{ defaultBranch: this.defaultBranch, remoteProjectId: this.remoteProjectId }];
    }
    if (opName === 'branchView') {
      if (this.branchHead instanceof Error) throw this.branchHead;
      if (this.remoteProjectId instanceof Error) throw this.remoteProjectId;
      return [{ remoteProjectId: this.remoteProjectId, headSha: this.branchHead }];
    }
    if (opName === 'merge') {
      if (this.mergeError) throw this.mergeError;
      return [];
    }
    if (opName === 'comment') {
      if (typeof vars.body === 'string'
        && (this.commentLandsBeforeError || (this.commentError === undefined && this.commentVisibleAfterWrite))) {
        const rows = this.comments['issue-comments'];
        if (Array.isArray(rows)) rows.push(comment(`human-spec-${rows.length + 1}`, vars.body));
      }
      if (this.commentError) throw this.commentError;
      return [];
    }
    if (opName === 'close' && this.closeError) throw this.closeError;
    if (opName === 'deleteBranch' && this.deleteError) throw this.deleteError;
    if (opName === 'close' || opName === 'deleteBranch') return [];
    throw new Error(`unexpected op ${opName}`);
  }

  async runCommentSource(
    source: CommentSourceOp,
    _vars: OpVars,
    projectPage?: (rows: NormalizedRow[]) => NormalizedRow[],
  ): Promise<NormalizedRow[]> {
    const rows = this.comments[source.key];
    if (rows instanceof Error) throw rows;
    const copy = rows.map(r => ({ ...r }));
    return projectPage ? projectPage(copy) : copy;
  }
}

function prRow(over: Partial<Record<string, unknown>> = {}): NormalizedRow {
  return {
    prNumber: 42, prUrl: 'https://github.com/owner/repo/pull/42', branch: 'bx/task-1',
    headSha: SHA1, state: 'open', draft: false, mergedAt: null,
    sourceProjectId: '7', targetProjectId: '7', targetBranch: 'main', ...over,
  };
}

function comment(id: string, body: string, extra: Record<string, unknown> = {}): NormalizedRow {
  return { id, body, createdAt: TS, updatedAt: TS, ...extra };
}

const failLine = buildReviewTokenLine({ kind: 'fail', anchorSha: SHA1, token: '123456abcdef' });

function gitTask(over: Partial<TaskState> = {}): TaskState {
  const now = new Date().toISOString();
  const task = makeTask({
    description: 'd',
    reviewRound: 1, status: 'merge-ready', createdAt: now, updatedAt: now,
    phase: 'code',
    deliveryConfirmation: { phase: 'code', source: 'signal', at: now },
    prNumber: 42, branch: 'bx/task-1', branchCreatedByBaxian: true,
    platformBinding: { mode: 'git', repoKey: 'github.com/owner/repo', tool: 'gh' },
    baseBranch: 'main', latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1,
    replyActorId: '77', replyActorStatus: 'verified',
    passToken: 'abcdef123456', failToken: '123456abcdef',
    passProvenance: {
      sourceKey: 'reviews', id: 'r1', bodyDigest: 'f'.repeat(64), token: 'abcdef123456',
      failToken: '123456abcdef', anchorSha: SHA1,
    },
    ...over,
  });
  if (task.phase === undefined) delete task.deliveryConfirmation;
  else if (!Object.hasOwn(over, 'deliveryConfirmation')) {
    task.deliveryConfirmation = { phase: task.phase, source: 'signal', at: now };
  }
  return task;
}

let tempDir: string;
let config: BaxianConfig;
let agentStore: AgentStore;
let lockManager: LockManager;
let taskStore: TaskStore;
let manager: AgentManager;
let createManager: Awaited<ReturnType<typeof createManagerHarness>>['createManager'];
let driver: FakeDriver;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'bx-mgr-platform-'));
  config = makeConfig({
    review: { rounds: 2 },
    project: [{
      id: 'proj',
      repo: 'git@github.com:owner/repo.git',
      merge: null,
      agent: [[
        makeAgent(),
        makeAgent({ id: 'qa-1', runtime: 'codex', role: 'qa', workdir: '/tmp/qa-repo' }),
      ]],
    }],
  });
  const harness = await createManagerHarness(tempDir, { config });
  ({ manager, createManager, agentStore, taskStore, lockManager } = harness);
  driver = new FakeDriver();
  vi.spyOn(manager, 'platformDriverFor').mockReturnValue(driver as unknown as GitDriver);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function asReturned(
  result: { kind: string } | { kind: string; task: TaskState },
): TaskState | null {
  return 'task' in result && result.kind === 'returned' ? result.task : null;
}

async function seed(over: Partial<TaskState> = {}): Promise<TaskState> {
  const task = gitTask(over);
  await taskStore.set(task);
  return task;
}

function postApproveEpisode(over: Partial<TaskState> = {}): Partial<TaskState> {
  return {
    postApproveGeneration: POST_APPROVE_GENERATION,
    postApproveHeadSha: SHA1,
    postApproveToken: 'tok123456789',
    postApprovePhase: 'installed',
    ...over,
  };
}

function specVerdictOutbox(
  over: Partial<SpecVerdictOutboxEntry['data']> = {},
): SpecVerdictOutboxEntry {
  return {
    key: 'abc123abc123',
    type: 'git.spec-verdict',
    data: {
      prNumber: 42,
      comments: '补充失败回滚方案',
      ...over,
    },
  };
}

function specVerdictBody(entry: SpecVerdictOutboxEntry): string {
  return [
    'Human spec verdict: request changes',
    '',
    entry.data.comments,
    '',
    `<!-- baxian:spec-verdict:${entry.key} -->`,
  ].join('\n');
}

function pendingSpecVerdict(task: Pick<TaskState, 'outbox'>): SpecVerdictOutboxEntry | undefined {
  return task.outbox?.find(
    (entry): entry is SpecVerdictOutboxEntry => entry.type === 'git.spec-verdict',
  );
}

function pendingCodeVerdict(task: Pick<TaskState, 'outbox'>): CodeVerdictOutboxEntry | undefined {
  return task.outbox?.find(
    (entry): entry is CodeVerdictOutboxEntry => entry.type === 'git.code-verdict',
  );
}

describe('git cancellation state cleanup', () => {
  it('atomically removes an approved episode while cancelling', async () => {
    await seed({
      status: 'approved',
      ...postApproveEpisode({ pendingRedispatch: true, redispatchCount: 1 }),
    });

    const cancelled = await manager.cancelTask('task-1');
    const stored = await taskStore.get('task-1');

    expect(cancelled.status).toBe('cancelled');
    expect(stored?.status).toBe('cancelled');
    expect(stored?.postApproveGeneration).toBeUndefined();
    expect(stored?.postApproveHeadSha).toBeUndefined();
    expect(stored?.postApproveToken).toBeUndefined();
    expect(stored?.postApprovePhase).toBeUndefined();
    expect(stored?.pendingRedispatch).toBeUndefined();
    expect(stored?.redispatchCount).toBeUndefined();
  });

  it('removes an active review lease while cancelling', async () => {
    await seed({ status: 'in_progress', reviewRound: 1 });
    const begun = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['in_progress'], headSha: SHA1, bumpRound: true,
    });
    expect(begun?.task.reviewDispatch).toBeDefined();

    await manager.cancelTask('task-1');
    const stored = await taskStore.get('task-1');

    expect(stored?.status).toBe('cancelled');
    expect(stored?.reviewDispatch).toBeUndefined();
    expect(stored?.reviewRoundPending).toBeUndefined();
  });

  it('removes an approved episode when runtime recovery fails the task', async () => {
    await seed({
      status: 'approved',
      ...postApproveEpisode({ pendingRedispatch: true, redispatchCount: 1 }),
    });

    await manager.failTasksForAgent('dev-1', 'runtime unavailable');
    const stored = await taskStore.get('task-1');

    expect(stored?.status).toBe('failed');
    expect(stored?.postApproveGeneration).toBeUndefined();
    expect(stored?.pendingRedispatch).toBeUndefined();
  });
});

describe('post-approve episode rollback fences', () => {
  it('refuses to rotate an episode whose durable redispatch intent was already cleared', async () => {
    await seed({ status: 'approved', ...postApproveEpisode({ pendingRedispatch: false }) });
    const oldEpisode = {
      generation: POST_APPROVE_GENERATION,
      token: 'tok123456789',
      headSha: SHA1,
    };

    await expect(manager.rotateGitPostApproveEpisode('task-1', oldEpisode, 1)).resolves.toBeNull();
    expect(await taskStore.get('task-1')).toMatchObject({
      postApproveToken: oldEpisode.token, pendingRedispatch: false,
    });
  });

  it('does not park the dev for a superseded episode', async () => {
    await seed({ status: 'approved', ...postApproveEpisode({ pendingRedispatch: true }) });
    const lock = await lockManager.acquire('dev-1', 'task-1');
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', lockToken: lock!, updatedAt: TS,
    });
    const oldEpisode = {
      generation: POST_APPROVE_GENERATION,
      token: 'tok123456789',
      headSha: SHA1,
    };
    const successor = await manager.rotateGitPostApproveEpisode('task-1', oldEpisode, 2);

    await expect(manager.markAgentWaiting('dev-1', 'task-1', {
      expectedPostApproveEpisode: oldEpisode,
    })).resolves.toBe(false);

    expect((await agentStore.get('dev-1'))?.needInput).toBeUndefined();
    expect((await taskStore.get('task-1'))?.postApproveToken).toBe(successor?.token);
  });

  it('does not fail a successor episode for a stale terminal delivery error', async () => {
    await seed({ status: 'approved', ...postApproveEpisode({ pendingRedispatch: true }) });
    const oldEpisode = {
      generation: POST_APPROVE_GENERATION,
      token: 'tok123456789',
      headSha: SHA1,
    };
    const successor = await manager.rotateGitPostApproveEpisode('task-1', oldEpisode, 2);

    await manager.failTaskForDispatchError(
      'task-1',
      'post-approve',
      'dev-1',
      new DispatchTerminalError('ack_unknown', 'late delivery outcome'),
      { expectedPostApproveEpisode: oldEpisode },
    );

    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'approved',
      postApproveGeneration: POST_APPROVE_GENERATION,
      postApproveToken: successor?.token,
      redispatchCount: 2,
    });
  });
});

function passBody(): string {
  return `LGTM\n${buildReviewTokenLine({ kind: 'pass', anchorSha: SHA1, token: 'abcdef123456' })}`;
}

function seedAcceptedPass(): void {
  const body = passBody();
  driver.comments.reviews = [comment('r1', body)];
}

function provenanceFor(body: string) {
  return {
    sourceKey: 'reviews', id: 'r1', bodyDigest: sha256Hex(body), token: 'abcdef123456',
    failToken: '123456abcdef', anchorSha: SHA1,
  };
}

describe('platformVerifyPrBinding', () => {
  it('accepts a bound open PR and reports its URL, head, branch, and target', async () => {
    await seed();
    await expect(manager.platformVerifyPrBinding('task-1', 42)).resolves.toEqual({
      ok: true,
      prUrl: 'https://github.com/owner/repo/pull/42',
      headSha: SHA1,
      branch: 'bx/task-1',
      targetBranch: 'main',
    });
  });

  it('rejects drafts, forks, closed, and retargeted rows with the predicate vocabulary', async () => {
    await seed();
    for (const [reason, over] of [
      ['draft', { draft: true }],
      ['fork', { sourceProjectId: null }],
      ['state', { state: 'closed' }],
      ['target', { targetBranch: 'develop' }],
    ] as const) {
      driver.prView = prRow(over);
      await expect(manager.platformVerifyPrBinding('task-1', 42)).resolves.toEqual({ ok: false, reason });
    }
    driver.prView = prRow({ branch: 'bx/task-9' });
    await expect(manager.platformVerifyPrBinding('task-1', 42)).resolves.toEqual({
      ok: false, reason: 'branch', prBranch: 'bx/task-9',
    });
    await expect(manager.platformVerifyPrBinding('task-1', 42, { branchOverride: 'bx/task-9' }))
      .resolves.toMatchObject({ ok: true, branch: 'bx/task-9' });
  });

  it('falls back to the live default branch when the task has no base snapshot', async () => {
    await seed({ baseBranch: undefined });
    driver.defaultBranch = 'main';
    await expect(manager.platformVerifyPrBinding('task-1', 42)).resolves.toMatchObject({ ok: true });
    driver.defaultBranch = new Error('projectView down');
    await expect(manager.platformVerifyPrBinding('task-1', 42)).rejects.toThrow('projectView down');
  });
});

describe('git spec approval gate verdicts', () => {
  async function seedSpecGate(over: Partial<TaskState> = {}): Promise<TaskState> {
    return seed({
      status: 'spec-ready',
      phase: 'spec',
      signalToken: 'spec-verdict-gate',
      specReviewRound: 2,
      reviewRound: 1,
      ...over,
    });
  }

  function submitChanges(comments = '补充失败回滚方案'): Promise<TaskState> {
    return manager.submitSpecVerdict('task-1', 'request-changes', comments);
  }

  it('approves directly into the code handoff', async () => {
    const gate = await seedSpecGate();
    const codeTask = gitTask({
      ...gate,
      status: 'in_progress',
      phase: 'code',
      deliveryConfirmation: undefined,
      signalToken: 'code-delivery-gate',
    });
    const transition = vi.spyOn(manager, 'transitionToCodePhase').mockResolvedValue(codeTask);

    const result = await manager.submitSpecVerdict('task-1', 'approve');

    expect(transition).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'spec-ready',
        phase: 'spec',
        signalToken: 'spec-verdict-gate',
        reviewRound: 1,
        specReviewRound: 2,
      }),
      expect.objectContaining({
        specReviewRound: 2,
        expectedSignalToken: 'spec-verdict-gate',
        prNumber: 42,
        headSha: SHA1,
        passProvenance: expect.objectContaining({ anchorSha: SHA1 }),
      }),
    );
    expect(result).toBe(codeTask);
    expect(driver.ops.map(op => op.op)).toEqual(['prView']);
  });

  it('uses the live head as an explicit human override at the git spec max-rounds gate', async () => {
    const liveHead = 'b'.repeat(40);
    const gate = await seedSpecGate({
      status: 'max_rounds',
      passProvenance: undefined,
      reviewHeadAnchorSha: SHA1,
    });
    driver.prView = prRow({ headSha: liveHead });
    const codeTask = gitTask({
      ...gate,
      status: 'in_progress',
      phase: 'code',
      deliveryConfirmation: undefined,
      latestHeadSha: liveHead,
      reviewHeadAnchorSha: liveHead,
      passProvenance: undefined,
    });
    const transition = vi.spyOn(manager, 'transitionToCodePhase').mockResolvedValue(codeTask);

    const result = await manager.submitSpecVerdict('task-1', 'approve');

    const approval = transition.mock.calls[0]?.[2];
    expect(approval).toMatchObject({
      specReviewRound: 2,
      expectedSignalToken: 'spec-verdict-gate',
      prNumber: 42,
      headSha: liveHead,
      humanOverride: true,
    });
    expect(approval).not.toHaveProperty('passProvenance');
    expect(result).toBe(codeTask);
    expect(driver.ops.map(op => op.op)).toEqual(['prView']);
  });

  it('still requires QA pass provenance at the ordinary git spec-ready gate', async () => {
    await seedSpecGate({ passProvenance: undefined });
    const transition = vi.spyOn(manager, 'transitionToCodePhase');

    await expect(manager.submitSpecVerdict('task-1', 'approve'))
      .rejects.toMatchObject({ status: 409 });

    expect(transition).not.toHaveBeenCalled();
    expect(driver.ops).toEqual([]);
  });

  it('rechecks a newer live head instead of approving the stale spec pass', async () => {
    await seedSpecGate();
    const changedHead = 'b'.repeat(40);
    driver.prView = prRow({ headSha: changedHead });
    const transition = vi.spyOn(manager, 'transitionToCodePhase');
    const dispatch = vi.spyOn(manager, 'dispatchReviewToQa').mockResolvedValue(
      gitTask({ status: 'review', phase: 'spec', latestHeadSha: changedHead }),
    );

    await expect(manager.submitSpecVerdict('task-1', 'approve'))
      .rejects.toMatchObject({ status: 409 });

    expect(transition).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith('task-1', expect.objectContaining({
      fromStatus: ['spec-ready'],
      bumpRound: true,
      qaPhase: 'recheck',
      expectPhase: 'spec',
    }));
    expect(await taskStore.get('task-1')).toMatchObject({ latestHeadSha: changedHead });
  });

  it('keeps the spec gate closed when the live head probe fails', async () => {
    await seedSpecGate();
    driver.prView = new Error('HTTP 503');
    const transition = vi.spyOn(manager, 'transitionToCodePhase');

    await expect(manager.submitSpecVerdict('task-1', 'approve'))
      .rejects.toMatchObject({ status: 503 });

    expect(transition).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.status).toBe('spec-ready');
  });

  it('does not overwrite a newer persisted head observation with an older live-probe result', async () => {
    await seedSpecGate();
    vi.spyOn(manager, 'platformVerifyPrBinding').mockImplementationOnce(async () => {
      const current = (await taskStore.get('task-1'))!;
      await taskStore.set({
        ...current,
        latestHeadSha: 'b'.repeat(40),
        updatedAt: new Date().toISOString(),
      });
      return {
        ok: true,
        headSha: SHA1,
        branch: 'bx/task-1',
        targetBranch: 'main',
      };
    });
    const transition = vi.spyOn(manager, 'transitionToCodePhase');

    await expect(manager.submitSpecVerdict('task-1', 'approve'))
      .rejects.toMatchObject({ status: 409 });

    expect(transition).not.toHaveBeenCalled();
    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'spec-ready',
      latestHeadSha: 'b'.repeat(40),
      reviewHeadAnchorSha: SHA1,
    });
  });

  it('writes one durable PR comment, expands a capped spec budget, and dispatches spec fix', async () => {
    const notice: NonNullable<TaskState['outbox']>[number] = {
      key: 'existing-notice', type: 'human.intervention', data: { phase: 'existing' },
    };
    await seedSpecGate({ outbox: [notice] });
    const dispatch = vi.spyOn(manager, 'dispatchGitFixToDev').mockResolvedValue(true);

    const result = await submitChanges(' 补充失败回滚方案 ');

    expect(result).toMatchObject({
      status: 'fixing',
      phase: 'spec',
      specReviewRound: 3,
      reviewRound: 1,
      maxRoundsContinues: 1,
    });
    expect(pendingSpecVerdict(result)).toBeUndefined();
    expect(result.outbox).toEqual([notice]);
    expect(dispatch).toHaveBeenCalledOnce();
    const writes = driver.ops.filter(op => op.op === 'comment');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.vars).toMatchObject({
      prNumber: 42,
      body: expect.stringMatching(
        /^Human spec verdict: request changes\n\n补充失败回滚方案\n\n<!-- baxian:spec-verdict:[0-9a-f]{12} -->$/,
      ),
    });
  });

  it('reconciles a comment whose success response was lost without writing a duplicate', async () => {
    await seedSpecGate({ specReviewRound: 1 });
    driver.commentLandsBeforeError = true;
    driver.commentError = new DriverOpError('comment outcome unknown', {
      opName: 'comment',
      exitCode: 255,
      stderrTail: 'ssh: connect: connection timed out',
    });
    vi.spyOn(manager, 'dispatchGitFixToDev').mockResolvedValue(true);

    const result = await submitChanges();

    expect(result).toMatchObject({ status: 'fixing', specReviewRound: 2 });
    expect(driver.ops.filter(op => op.op === 'comment')).toHaveLength(1);
    expect((driver.comments['issue-comments'] as NormalizedRow[])).toHaveLength(1);
    expect(pendingSpecVerdict((await taskStore.get('task-1'))!)).toBeUndefined();
  });

  it('recovers a crash after the comment landed but before the status transition', async () => {
    const entry = specVerdictOutbox({ writeAttemptedAt: TS });
    await seedSpecGate({ outbox: [entry] });
    driver.comments['issue-comments'] = [comment('human-spec-1', specVerdictBody(entry))];
    const dispatch = vi.spyOn(manager, 'dispatchGitFixToDev').mockResolvedValue(true);

    await manager.flushTaskOutboxes();

    expect(driver.ops.filter(op => op.op === 'comment')).toHaveLength(0);
    expect(dispatch).toHaveBeenCalledOnce();
    const recovered = await taskStore.get('task-1');
    expect(recovered).toMatchObject({
      status: 'fixing',
      specReviewRound: 3,
      reviewRound: 1,
    });
    expect(pendingSpecVerdict(recovered!)).toBeUndefined();
  });

  it('waits for a posted verdict comment to become scan-visible before dispatching the fix', async () => {
    await seedSpecGate({ specReviewRound: 1 });
    driver.commentVisibleAfterWrite = false;
    const dispatch = vi.spyOn(manager, 'dispatchGitFixToDev').mockResolvedValue(true);

    await expect(submitChanges()).rejects.toMatchObject({ status: 503 });

    const pendingTask = (await taskStore.get('task-1'))!;
    const pending = pendingSpecVerdict(pendingTask)!;
    expect(pendingTask).toMatchObject({
      status: 'spec-ready',
      specReviewRound: 1,
      reviewRound: 1,
    });
    expect(pending).toMatchObject({
      data: {
        comments: '补充失败回滚方案',
        writeAttemptedAt: expect.any(String),
      },
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(driver.ops.filter(op => op.op === 'comment')).toHaveLength(1);

    driver.comments['issue-comments'] = [comment('human-spec-1', specVerdictBody(pending))];
    await manager.flushTaskOutboxes();

    expect(driver.ops.filter(op => op.op === 'comment')).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'fixing',
      specReviewRound: 2,
      reviewRound: 1,
    });
    expect(pendingSpecVerdict((await taskStore.get('task-1'))!)).toBeUndefined();
  });

  it('keeps an uncertain outbox operation without advancing, then retries only after an absent full scan', async () => {
    await seedSpecGate({ specReviewRound: 1 });
    driver.commentError = new Error('transport result unavailable');
    driver.comments.reviews = new Error('review source unavailable');
    const dispatch = vi.spyOn(manager, 'dispatchGitFixToDev').mockResolvedValue(true);

    await expect(submitChanges()).rejects.toMatchObject({ status: 503 });

    const uncertain = (await taskStore.get('task-1'))!;
    expect(uncertain).toMatchObject({
      status: 'spec-ready',
      specReviewRound: 1,
      reviewRound: 1,
    });
    expect(pendingSpecVerdict(uncertain)).toMatchObject({
      data: {
        comments: '补充失败回滚方案',
        writeAttemptedAt: expect.any(String),
      },
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(driver.ops.filter(op => op.op === 'comment')).toHaveLength(1);

    const pending = pendingSpecVerdict(uncertain)!;
    await taskStore.set({
      ...uncertain,
      outbox: uncertain.outbox!.map(entry => entry.key === pending.key
        ? {
            ...pending,
            data: { ...pending.data, writeAttemptedAt: '2020-01-01T00:00:00.000Z' },
          }
        : entry),
    });
    driver.commentError = undefined;
    driver.comments.reviews = [];

    await manager.flushTaskOutboxes();

    expect(driver.ops.filter(op => op.op === 'comment')).toHaveLength(2);
    expect(dispatch).toHaveBeenCalledOnce();
    const recovered = await taskStore.get('task-1');
    expect(recovered).toMatchObject({
      status: 'fixing',
      specReviewRound: 2,
      reviewRound: 1,
    });
    expect(pendingSpecVerdict(recovered!)).toBeUndefined();
  });

  it('reports a definite comment rejection and clears the intent without advancing', async () => {
    await seedSpecGate({ specReviewRound: 1 });
    driver.commentError = new DriverOpError('comment rejected', {
      opName: 'comment',
      exitCode: 1,
      stderrTail: 'validation failed',
    });
    const dispatch = vi.spyOn(manager, 'dispatchGitFixToDev');

    await expect(submitChanges()).rejects.toMatchObject({ status: 502 });

    const rejected = await taskStore.get('task-1');
    expect(rejected).toMatchObject({
      status: 'spec-ready',
      specReviewRound: 1,
      reviewRound: 1,
    });
    expect(pendingSpecVerdict(rejected!)).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
    expect(driver.ops.filter(op => op.op === 'comment')).toHaveLength(1);
  });

  it('rejects an oversized spec verdict before persisting an outbox operation or invoking the driver', async () => {
    await seedSpecGate({ specReviewRound: 1 });
    const dispatch = vi.spyOn(manager, 'dispatchGitFixToDev');

    await expect(submitChanges('x'.repeat(COMMENT_BODY_MAX_BYTES)))
      .rejects.toMatchObject({ status: 400 });

    expect(pendingSpecVerdict((await taskStore.get('task-1'))!)).toBeUndefined();
    expect(driver.ops).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('human code verdict delivery', () => {
  async function seedCodeReview(over: Partial<TaskState> = {}): Promise<TaskState> {
    return seed({
      status: 'review',
      phase: 'code',
      signalToken: 'aaaa11112222',
      reviewHeadAnchorSha: SHA1,
      latestHeadSha: SHA1,
      passToken: 'abcdef123456',
      failToken: '123456abcdef',
      ...over,
    });
  }

  it('writes a current-anchor pass marker and leaves transition ownership to the poller', async () => {
    await seedCodeReview();

    const result = await manager.submitCodeVerdict('task-1', 'pass', 'checked locally');

    expect(result.status).toBe('review');
    expect(pendingCodeVerdict(result)).toMatchObject({
      key: 'abcdef123456',
      data: { writeAttemptedAt: expect.any(String) },
    });
    const writes = driver.ops.filter(op => op.op === 'comment');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.vars).toMatchObject({
      prNumber: 42,
      body: [
        'Human code verdict: pass',
        '',
        'checked locally',
        '',
        buildReviewTokenLine({ kind: 'pass', anchorSha: SHA1, token: 'abcdef123456' }),
      ].join('\n'),
    });
  });

  it('refuses to write a verdict after the live PR head has changed', async () => {
    await seedCodeReview();
    driver.prView = prRow({ headSha: 'b'.repeat(40) });

    await expect(manager.submitCodeVerdict('task-1', 'pass'))
      .rejects.toMatchObject({ status: 409 });

    expect(driver.ops.filter(op => op.op === 'comment')).toEqual([]);
    expect(pendingCodeVerdict((await taskStore.get('task-1'))!)).toBeUndefined();
  });

  it('fails closed when the live PR head cannot be verified', async () => {
    await seedCodeReview();
    driver.prView = new Error('platform offline');

    await expect(manager.submitCodeVerdict('task-1', 'pass'))
      .rejects.toMatchObject({ status: 503 });

    expect(driver.ops.filter(op => op.op === 'comment')).toEqual([]);
    expect(pendingCodeVerdict((await taskStore.get('task-1'))!)).toBeUndefined();
  });

  it('requires comments for a human request-changes verdict', async () => {
    await seedCodeReview();

    await expect(manager.submitCodeVerdict('task-1', 'request-changes', '   '))
      .rejects.toMatchObject({ status: 400 });

    expect(driver.ops).toEqual([]);
    expect(pendingCodeVerdict((await taskStore.get('task-1'))!)).toBeUndefined();
  });

  it('rejects review markers embedded in human comments', async () => {
    await seedCodeReview();

    await expect(manager.submitCodeVerdict(
      'task-1',
      'pass',
      buildReviewTokenLine({ kind: 'fail', anchorSha: SHA1, token: '123456abcdef' }),
    )).rejects.toMatchObject({ status: 400 });

    expect(driver.ops).toEqual([]);
    expect(pendingCodeVerdict((await taskStore.get('task-1'))!)).toBeUndefined();
  });

  it('rejects an oversized code verdict before recording or writing it', async () => {
    await seedCodeReview();

    await expect(manager.submitCodeVerdict(
      'task-1',
      'pass',
      'x'.repeat(COMMENT_BODY_MAX_BYTES),
    )).rejects.toMatchObject({ status: 400 });

    expect(driver.ops).toEqual([]);
    expect(pendingCodeVerdict((await taskStore.get('task-1'))!)).toBeUndefined();
  });

  it('rejects a verdict when both current tokens are already live', async () => {
    await seedCodeReview();
    driver.comments['issue-comments'] = [
      comment('existing-pass', buildReviewTokenLine({
        kind: 'pass',
        anchorSha: SHA1,
        token: 'abcdef123456',
      })),
      comment('existing-fail', buildReviewTokenLine({
        kind: 'fail',
        anchorSha: SHA1,
        token: '123456abcdef',
      })),
    ];

    await expect(manager.submitCodeVerdict('task-1', 'pass'))
      .rejects.toMatchObject({ status: 409 });

    expect(driver.ops.filter(op => op.op === 'comment')).toEqual([]);
  });

  it('requires a new review pass when the selected token was dismissed', async () => {
    await seedCodeReview();
    driver.comments.reviews = [
      comment('dismissed-pass', buildReviewTokenLine({
        kind: 'pass',
        anchorSha: SHA1,
        token: 'abcdef123456',
      }), { reviewState: 'DISMISSED' }),
    ];

    await expect(manager.submitCodeVerdict('task-1', 'pass'))
      .rejects.toMatchObject({ status: 409 });

    expect(driver.ops.filter(op => op.op === 'comment')).toEqual([]);
  });

  it('does not reconcile a verdict from a system-authored marker carrier', async () => {
    await seedCodeReview();
    const body = [
      'Human code verdict: pass',
      '',
      buildReviewTokenLine({ kind: 'pass', anchorSha: SHA1, token: 'abcdef123456' }),
    ].join('\n');
    driver.comments['issue-comments'] = [
      comment('system-pass', body, { system: true }),
    ];
    driver.commentVisibleAfterWrite = false;

    await expect(manager.submitCodeVerdict('task-1', 'pass'))
      .rejects.toMatchObject({ status: 503 });

    expect(driver.ops.filter(op => op.op === 'comment')).toHaveLength(1);
    expect(pendingCodeVerdict((await taskStore.get('task-1'))!)).toBeDefined();
  });

  it('persists an uncertain write and reconciles it without a duplicate comment', async () => {
    await seedCodeReview();
    driver.commentVisibleAfterWrite = false;

    await expect(manager.submitCodeVerdict('task-1', 'request-changes', 'fix the race'))
      .rejects.toMatchObject({ status: 503 });

    const pendingTask = (await taskStore.get('task-1'))!;
    const pending = pendingCodeVerdict(pendingTask)!;
    expect(pending).toMatchObject({
      key: '123456abcdef',
      data: {
        kind: 'fail',
        anchorSha: SHA1,
        comments: 'fix the race',
        writeAttemptedAt: expect.any(String),
      },
    });
    const body = [
      'Human code verdict: request changes',
      '',
      'fix the race',
      '',
      buildReviewTokenLine({ kind: 'fail', anchorSha: SHA1, token: '123456abcdef' }),
    ].join('\n');
    driver.comments['issue-comments'] = [comment('human-code-1', body)];

    await manager.flushTaskOutboxes();

    expect(driver.ops.filter(op => op.op === 'comment')).toHaveLength(1);
    expect(pendingCodeVerdict((await taskStore.get('task-1'))!)).toEqual(pending);
  });

  it('retires an uncertain verdict if the PR head changes before recovery', async () => {
    await seedCodeReview();
    driver.commentVisibleAfterWrite = false;

    await expect(manager.submitCodeVerdict('task-1', 'pass'))
      .rejects.toMatchObject({ status: 503 });
    driver.prView = prRow({ headSha: 'b'.repeat(40) });

    await manager.flushTaskOutboxes();

    expect(driver.ops.filter(op => op.op === 'comment')).toHaveLength(1);
    expect(pendingCodeVerdict((await taskStore.get('task-1'))!)).toBeUndefined();
  });

  it('drops a pending human verdict when a new review pass rotates the token pair', async () => {
    await seedCodeReview({
      outbox: [{
        key: 'abcdef123456',
        type: 'git.code-verdict',
        data: {
          prNumber: 42,
          kind: 'pass',
          anchorSha: SHA1,
          token: 'abcdef123456',
          comments: '',
        },
      }],
    });

    const begun = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['review'],
      headSha: 'b'.repeat(40),
      bumpRound: true,
    });

    expect(begun?.task.outbox).toBeUndefined();
    expect(begun?.task.passToken).not.toBe('abcdef123456');
    expect((await taskStore.get('task-1'))?.outbox).toBeUndefined();
  });

  it('keeps the current review pass fenced until the poller consumes the human verdict', async () => {
    await seedCodeReview({
      outbox: [{
        key: 'abcdef123456',
        type: 'git.code-verdict',
        data: {
          prNumber: 42,
          kind: 'pass',
          anchorSha: SHA1,
          token: 'abcdef123456',
          comments: '',
          writeAttemptedAt: TS,
        },
      }],
    });

    const sameHead = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['review'],
      headSha: SHA1,
      bumpRound: true,
    });

    expect(sameHead).toBeNull();
    expect(pendingCodeVerdict((await taskStore.get('task-1'))!)).toBeDefined();

    await manager.transitionTaskStatus(
      'task-1',
      'fixing',
      { fromStatus: ['review'], expectSignalToken: 'aaaa11112222' },
    );

    expect(pendingCodeVerdict((await taskStore.get('task-1'))!)).toBeUndefined();
  });
});

describe('processGitRemoteCleanup', () => {
  const intent = (over: Partial<NonNullable<TaskState['remoteCleanup']>> = {}): NonNullable<TaskState['remoteCleanup']> => ({
    generation: 'abc123abc123', stage: 'close-pending', prNumber: 42, branch: 'bx/task-1',
    expectedHeadSha: SHA1, updatedAt: TS, ...over,
  });

  it('keeps a close failure at close-pending and never attempts branch deletion', async () => {
    await seed({ status: 'cancelled', remoteCleanup: intent() });
    driver.closeError = new Error('close transport failed');

    await expect(manager.processGitRemoteCleanup('task-1', 'abc123abc123'))
      .rejects.toThrow('close transport failed');

    expect((await taskStore.get('task-1'))?.remoteCleanup).toMatchObject({
      stage: 'close-pending',
      failure: { kind: 'close', message: expect.stringContaining('close transport failed') },
    });
    expect(driver.ops.some(op => op.op === 'deleteBranch')).toBe(false);
  });

  it('closes and conditionally deletes only after an absent authoritative probe', async () => {
    await seed({ status: 'cancelled', remoteCleanup: intent() });
    await manager.processGitRemoteCleanup('task-1', 'abc123abc123');
    expect(driver.ops.map(o => o.op)).toEqual(['prView', 'projectView', 'close', 'deleteBranch', 'branchView']);
    expect(driver.ops[3]!.vars).toEqual({
      branch: 'bx/task-1', expectedHeadSha: SHA1, remoteProjectId: 'R_repo',
    });
    expect((await taskStore.get('task-1'))?.remoteCleanup).toBeUndefined();
  });

  it('does not call the platform when cancelled plus the cleanup intent cannot be persisted', async () => {
    await seed({ status: 'in_progress' });
    const realSet = taskStore.set.bind(taskStore);
    vi.spyOn(taskStore, 'set').mockImplementation(async (task) => {
      if (task.id === 'task-1' && task.status === 'cancelled') throw new Error('intent write failed');
      return realSet(task);
    });

    await expect(manager.cancelTask('task-1')).rejects.toThrow(/intent write failed/);

    expect(driver.ops).toHaveLength(0);
    expect(await taskStore.get('task-1')).toMatchObject({ status: 'in_progress' });
    expect((await taskStore.get('task-1'))?.remoteCleanup).toBeUndefined();
  });

  it('converges a missing saved binding to manual without touching the platform or retrying', async () => {
    await seed({
      status: 'cancelled', platformBinding: undefined, remoteCleanup: intent(),
    });

    await manager.processGitRemoteCleanup('task-1');

    expect(driver.ops).toHaveLength(0);
    expect((await taskStore.get('task-1'))?.remoteCleanup).toMatchObject({
      stage: 'manual', failure: { kind: 'binding' },
    });
    expect(await manager.listActiveGitTasks('proj')).toEqual([]);
    await manager.processGitRemoteCleanup('task-1');
    expect(driver.ops).toHaveLength(0);
  });

  it('converges a missing project configuration to manual', async () => {
    await seed({ status: 'cancelled', remoteCleanup: intent() });
    const missingConfigManager = createManager({
      config: makeConfig({ ...config, project: [] }),
    });

    await missingConfigManager.processGitRemoteCleanup('task-1');

    expect(driver.ops).toHaveLength(0);
    expect((await taskStore.get('task-1'))?.remoteCleanup).toMatchObject({
      stage: 'manual', failure: { kind: 'config' },
    });
    expect(await missingConfigManager.listActiveGitTasks()).toEqual([]);
  });

  it('converges an unresolved cleanup driver to manual without platform calls', async () => {
    await seed({ status: 'cancelled', remoteCleanup: intent() });
    vi.mocked(manager.platformDriverFor).mockReturnValueOnce(undefined);

    await manager.processGitRemoteCleanup('task-1');

    expect(driver.ops).toHaveLength(0);
    expect((await taskStore.get('task-1'))?.remoteCleanup).toMatchObject({
      stage: 'manual',
      failure: { kind: 'config', message: expect.stringContaining('no git driver resolvable') },
    });
  });

  it('converges a cleanup driver resolution error to manual with its diagnostic', async () => {
    await seed({ status: 'cancelled', remoteCleanup: intent() });
    vi.mocked(manager.platformDriverFor).mockImplementationOnce(() => {
      throw new Error('plugin manifest unavailable');
    });

    await manager.processGitRemoteCleanup('task-1');

    expect(driver.ops).toHaveLength(0);
    expect((await taskStore.get('task-1'))?.remoteCleanup).toMatchObject({
      stage: 'manual',
      failure: { kind: 'config', message: expect.stringContaining('plugin manifest unavailable') },
    });
  });

  it('converges a definitive PR binding mismatch to manual before close', async () => {
    driver.prView = prRow({ targetBranch: 'release' });
    await seed({ status: 'cancelled', remoteCleanup: intent() });

    await manager.processGitRemoteCleanup('task-1');

    expect(driver.ops.map(op => op.op)).toEqual(['prView', 'projectView']);
    expect((await taskStore.get('task-1'))?.remoteCleanup).toMatchObject({
      stage: 'manual', failure: { kind: 'binding' },
    });
    expect(await manager.listActiveGitTasks('proj')).toEqual([]);
  });

  it('converges a permanent PR probe refusal to manual and releases the config lock', async () => {
    driver.prView = new DriverOpError('repository not found', {
      opName: 'prView', errorClass: 'NOT_FOUND', exitCode: 1,
    });
    await seed({ status: 'cancelled', remoteCleanup: intent() });

    await manager.processGitRemoteCleanup('task-1');

    expect(driver.ops.map(op => op.op)).toEqual(['prView']);
    expect((await taskStore.get('task-1'))?.remoteCleanup).toMatchObject({
      stage: 'manual', failure: { kind: 'probe' },
    });
    expect(await manager.listActiveGitTasks('proj')).toEqual([]);
  });

  it('converges a permanent close refusal to manual instead of retaining the config lock forever', async () => {
    driver.closeError = new DriverOpError('close forbidden', {
      opName: 'close', errorClass: 'ACCESS_DENIED', exitCode: 1,
    });
    await seed({ status: 'cancelled', remoteCleanup: intent() });

    await manager.processGitRemoteCleanup('task-1');

    expect(driver.ops.map(op => op.op)).toEqual(['prView', 'projectView', 'close']);
    expect((await taskStore.get('task-1'))?.remoteCleanup).toMatchObject({
      stage: 'manual', failure: { kind: 'close' },
    });
    expect(await manager.listActiveGitTasks('proj')).toEqual([]);
  });

  it('keeps a transient cleanup probe failure retryable', async () => {
    driver.prView = new DriverOpError('temporary gateway failure', {
      opName: 'prView', errorClass: 'SERVER_ERROR', exitCode: 1,
    });
    await seed({ status: 'cancelled', remoteCleanup: intent() });

    await expect(manager.processGitRemoteCleanup('task-1')).rejects.toThrow('temporary gateway failure');

    expect((await taskStore.get('task-1'))?.remoteCleanup).toMatchObject({
      stage: 'close-pending', failure: { kind: 'probe' },
    });
    expect((await manager.listActiveGitTasks('proj')).map(task => task.id)).toEqual(['task-1']);
  });

  it('does not turn a task-store read failure into a permanent manual cleanup', async () => {
    await seed({ status: 'cancelled', remoteCleanup: intent() });
    const get = taskStore.get.bind(taskStore);
    let reads = 0;
    vi.spyOn(taskStore, 'get').mockImplementation(async (taskId) => {
      reads += 1;
      if (reads === 2) throw Object.assign(new Error('read EIO'), { code: 'EIO' });
      return get(taskId);
    });

    await expect(manager.processGitRemoteCleanup('task-1')).rejects.toThrow('read EIO');

    expect((await taskStore.get('task-1'))?.remoteCleanup?.stage).toBe('close-pending');
    expect(driver.ops.map(op => op.op)).toEqual(['prView', 'projectView']);
  });

  it('keeps a user-owned branch: custom name or missing flag both skip deletion', async () => {
    driver.prView = prRow({ branch: 'feat/custom' });
    await seed({
      status: 'cancelled', branch: 'feat/custom', branchCreatedByBaxian: false,
      remoteCleanup: intent({ branch: 'feat/custom' }),
    });
    await manager.processGitRemoteCleanup('task-1');
    expect(driver.ops.map(o => o.op)).toEqual(['prView', 'projectView', 'close']);

    driver.ops = [];
    await seed({
      status: 'cancelled', branch: 'feat/custom', branchCreatedByBaxian: true,
      remoteCleanup: intent({ branch: 'feat/custom' }),
    });
    await manager.processGitRemoteCleanup('task-1');
    expect(driver.ops.map(o => o.op)).toEqual(['prView', 'projectView', 'close']);
  });

  it('persists the successful remote PR close audit before retiring a custom-branch intent', async () => {
    driver.prView = prRow({ branch: 'feat/custom' });
    await seed({
      status: 'cancelled', branch: 'feat/custom', branchCreatedByBaxian: false,
      prUrl: 'https://github.com/owner/repo/pull/42',
      remoteCleanup: intent({ branch: 'feat/custom' }),
    });

    await manager.processGitRemoteCleanup('task-1');

    const date = new Date().toISOString().slice(0, 10);
    const audit = (await new EventLog(`${tempDir}/events`).readDate(date)).find(event =>
      event.type === 'task.updated' && event.data.operation === 'git-pr-close');
    expect(audit).toMatchObject({
      projectId: 'proj', taskId: 'task-1',
      data: {
        status: 'cancelled', operation: 'git-pr-close', outcome: 'succeeded',
        generation: 'abc123abc123', prNumber: 42,
        prUrl: 'https://github.com/owner/repo/pull/42', branch: 'feat/custom', remoteProjectId: 'R_repo',
      },
    });
    expect((await taskStore.get('task-1'))?.remoteCleanup).toBeUndefined();
  });

  it('retains the close intent when the successful-close audit cannot be persisted', async () => {
    driver.prView = prRow({ branch: 'feat/custom' });
    await seed({
      status: 'cancelled', branch: 'feat/custom', branchCreatedByBaxian: false,
      remoteCleanup: intent({ branch: 'feat/custom' }),
    });
    const auditFailureManager = createManager({
      eventBus: new EventBus({
        append: async (event: { type: string; data: Record<string, unknown> }) => {
          if (event.type === 'task.updated' && event.data.operation === 'git-pr-close') {
            throw new Error('audit disk full');
          }
        },
      } as unknown as EventLog),
    });
    vi.spyOn(auditFailureManager, 'platformDriverFor').mockReturnValue(driver as unknown as GitDriver);

    await expect(auditFailureManager.processGitRemoteCleanup('task-1')).rejects.toThrow('audit disk full');

    expect((await taskStore.get('task-1'))?.remoteCleanup).toMatchObject({
      stage: 'close-pending', failure: { kind: 'persist', message: expect.stringContaining('audit disk full') },
    });
    expect(driver.ops.map(op => op.op)).toEqual(['prView', 'projectView', 'close']);
  });

  it('fails closed when the branch tip changed before close', async () => {
    driver.prView = prRow({ headSha: 'b'.repeat(40) });
    await seed({ status: 'cancelled', remoteCleanup: intent() });
    await manager.processGitRemoteCleanup('task-1');
    expect(driver.ops.map(o => o.op)).toEqual(['prView', 'projectView', 'close']);
    expect((await taskStore.get('task-1'))?.remoteCleanup).toMatchObject({
      stage: 'manual', failure: { kind: 'tip-changed' },
    });
  });

  it('treats a failed mutation plus absent probe as completed', async () => {
    driver.deleteError = new Error('GraphQL beforeOid mismatch');
    await seed({
      status: 'cancelled',
      remoteCleanup: intent({ stage: 'delete-pending', remoteProjectId: 'R_repo' }),
    });
    await manager.processGitRemoteCleanup('task-1');
    expect((await taskStore.get('task-1'))?.remoteCleanup).toBeUndefined();
  });

  it('persists the successful branch-delete audit before retiring the intent', async () => {
    await seed({
      status: 'cancelled',
      remoteCleanup: intent({ stage: 'delete-pending', remoteProjectId: 'R_repo' }),
    });

    await manager.processGitRemoteCleanup('task-1');

    const date = new Date().toISOString().slice(0, 10);
    const audit = (await new EventLog(`${tempDir}/events`).readDate(date)).find(event =>
      event.type === 'task.updated' && event.data.operation === 'git-branch-delete');
    expect(audit).toMatchObject({
      projectId: 'proj', taskId: 'task-1',
      data: {
        status: 'cancelled', operation: 'git-branch-delete', outcome: 'succeeded',
        generation: 'abc123abc123', prNumber: 42, branch: 'bx/task-1',
        expectedHeadSha: SHA1, remoteProjectId: 'R_repo',
      },
    });
    expect((await taskStore.get('task-1'))?.remoteCleanup).toBeUndefined();
  });

  it('retains the delete intent when the successful-delete audit cannot be persisted', async () => {
    await seed({
      status: 'cancelled',
      remoteCleanup: intent({ stage: 'delete-pending', remoteProjectId: 'R_repo' }),
    });
    const auditFailureManager = createManager({
      eventBus: new EventBus({
        append: async (event: { type: string; data: Record<string, unknown> }) => {
          if (event.type === 'task.updated' && event.data.operation === 'git-branch-delete') {
            throw new Error('audit disk full');
          }
        },
      } as unknown as EventLog),
    });
    vi.spyOn(auditFailureManager, 'platformDriverFor').mockReturnValue(driver as unknown as GitDriver);

    await expect(auditFailureManager.processGitRemoteCleanup('task-1')).rejects.toThrow('audit disk full');

    expect((await taskStore.get('task-1'))?.remoteCleanup).toMatchObject({
      stage: 'delete-pending', failure: { kind: 'persist', message: expect.stringContaining('audit disk full') },
    });
    expect(driver.ops.map(op => op.op)).toEqual(['deleteBranch', 'branchView']);
  });

  it('classifies a failed mutation plus a different authoritative tip as manual', async () => {
    driver.deleteError = new Error('GraphQL updateRefs rejected');
    driver.branchHead = 'b'.repeat(40);
    await seed({
      status: 'cancelled',
      remoteCleanup: intent({ stage: 'delete-pending', remoteProjectId: 'R_repo' }),
    });

    await manager.processGitRemoteCleanup('task-1');

    expect((await taskStore.get('task-1'))?.remoteCleanup).toMatchObject({
      stage: 'manual', failure: { kind: 'tip-changed' },
    });
  });

  it('converges after delete succeeded but clearing the durable intent failed', async () => {
    await seed({
      status: 'cancelled',
      remoteCleanup: intent({ stage: 'delete-pending', remoteProjectId: 'R_repo' }),
    });
    const realSet = taskStore.set.bind(taskStore);
    let failClear = true;
    const setSpy = vi.spyOn(taskStore, 'set').mockImplementation(async (task) => {
      if (failClear && task.id === 'task-1' && task.remoteCleanup === undefined) {
        failClear = false;
        throw new Error('disk full after remote delete');
      }
      return realSet(task);
    });
    await expect(manager.processGitRemoteCleanup('task-1')).rejects.toThrow(/disk full/);
    setSpy.mockRestore();
    expect((await taskStore.get('task-1'))?.remoteCleanup?.stage).toBe('delete-pending');

    driver.deleteError = new Error('GraphQL ref no longer exists');
    await mkdir(`${tempDir}/events-restarted`, { recursive: true });
    const restarted = createManager({
      agentStore: new AgentStore(join(tempDir, 'state', 'agents')),
      lockManager: new LockManager(join(tempDir, 'locks')),
      eventBus: new EventBus(new EventLog(`${tempDir}/events-restarted`)),
    });
    vi.spyOn(restarted, 'platformDriverFor').mockReturnValue(driver as unknown as GitDriver);

    await restarted.retryGitRemoteCleanupIntents();

    expect((await taskStore.get('task-1'))?.remoteCleanup).toBeUndefined();
    const date = new Date().toISOString().slice(0, 10);
    const firstAudit = (await new EventLog(`${tempDir}/events`).readDate(date)).find(event =>
      event.type === 'task.updated' && event.data.operation === 'git-branch-delete');
    const replayAudit = (await new EventLog(`${tempDir}/events-restarted`).readDate(date)).find(event =>
      event.type === 'task.updated' && event.data.operation === 'git-branch-delete');
    expect(firstAudit?.id).toBeDefined();
    expect(replayAudit?.id).toBe(firstAudit?.id);
  });

  it('repeats the idempotent close after persisting delete-pending failed', async () => {
    await seed({ status: 'cancelled', remoteCleanup: intent() });
    const realSet = taskStore.set.bind(taskStore);
    let failAdvance = true;
    const setSpy = vi.spyOn(taskStore, 'set').mockImplementation(async (task) => {
      if (failAdvance && task.id === 'task-1' && task.remoteCleanup?.stage === 'delete-pending') {
        failAdvance = false;
        throw new Error('disk full after close');
      }
      return realSet(task);
    });

    await expect(manager.processGitRemoteCleanup('task-1')).rejects.toThrow(/disk full after close/);
    expect((await taskStore.get('task-1'))?.remoteCleanup?.stage).toBe('close-pending');
    setSpy.mockRestore();

    await manager.processGitRemoteCleanup('task-1');

    expect(driver.ops.filter(op => op.op === 'close')).toHaveLength(2);
    expect((await taskStore.get('task-1'))?.remoteCleanup).toBeUndefined();
  });

  it('keeps delete-pending when the expected ref remains or the probe fails', async () => {
    driver.branchHead = SHA1;
    await seed({
      status: 'cancelled',
      remoteCleanup: intent({ stage: 'delete-pending', remoteProjectId: 'R_repo' }),
    });
    await expect(manager.processGitRemoteCleanup('task-1')).rejects.toThrow(/still sees/);
    expect((await taskStore.get('task-1'))?.remoteCleanup).toMatchObject({
      stage: 'delete-pending', failure: { kind: 'delete' },
    });

    driver.branchHead = new Error('network timeout');
    await expect(manager.processGitRemoteCleanup('task-1')).rejects.toThrow(/network timeout/);
    expect((await taskStore.get('task-1'))?.remoteCleanup).toMatchObject({
      stage: 'delete-pending', failure: { kind: 'probe' },
    });
  });

  it('continues after one task fails, records one durable intervention, and never retries manual intents', async () => {
    await seed({
      status: 'cancelled',
      remoteCleanup: intent({ stage: 'delete-pending', remoteProjectId: 'R_repo' }),
    });
    await taskStore.set(gitTask({
      id: 'task-2', status: 'cancelled', branch: 'bx/task-2',
      remoteCleanup: intent({
        generation: 'def456def456', stage: 'delete-pending', branch: 'bx/task-2', remoteProjectId: 'R_repo',
      }),
    }));
    await taskStore.set(gitTask({
      id: 'task-3', status: 'cancelled', branch: 'bx/task-3',
      remoteCleanup: intent({
        generation: 'fed654fed654', stage: 'manual', branch: 'bx/task-3',
        failure: { kind: 'tip-changed', message: 'operator required', at: TS },
      }),
    }));
    const realProcess = manager.processGitRemoteCleanup.bind(manager);
    const process = vi.spyOn(manager, 'processGitRemoteCleanup').mockImplementation(async (taskId, generation) => {
      if (taskId === 'task-1') throw new Error('first task failed');
      return realProcess(taskId, generation);
    });
    const intervention = vi.spyOn(
      manager as unknown as {
        emitIntervention: (...args: unknown[]) => Promise<void>;
      },
      'emitIntervention',
    );

    await manager.retryGitRemoteCleanupIntents();

    expect(process.mock.calls.map(call => call[0])).toEqual(['task-1', 'task-2']);
    expect(intervention).toHaveBeenCalledWith('proj', 'dev-1', 'task-1', expect.objectContaining({
      phase: 'remote-cleanup-failed', stage: 'delete-pending', kind: 'probe',
      message: expect.stringContaining('first task failed'),
    }));
    expect((await taskStore.get('task-2'))?.remoteCleanup).toBeUndefined();
    expect((await taskStore.get('task-3'))?.remoteCleanup?.stage).toBe('manual');

    const interventionCount = intervention.mock.calls.length;
    await manager.retryGitRemoteCleanupIntents();
    expect(intervention).toHaveBeenCalledTimes(interventionCount);
  });
});

describe('platformPendingFeedback', () => {
  it('reports unacked human comments and sole fail verdicts as pending', async () => {
    await seed();
    driver.comments['issue-comments'] = [comment('c1', 'please fix', { authorId: '5' })];
    driver.comments.reviews = [comment('r9', `findings\n${failLine}`)];
    const result = await manager.platformPendingFeedback('task-1');
    expect(result.pending.size).toBe(2);
  });

  it('returns an empty set once every revision is validly acked', async () => {
    await seed();
    const feedback = 'please fix';
    driver.comments['issue-comments'] = [
      comment('c1', feedback, { authorId: '5' }),
      comment('c2', `done\n${buildAckMarker({ sourceKey: 'issue-comments', commentId: 'c1', bodyDigest: sha256Hex(feedback) })}`, { authorId: '77' }),
    ];
    const result = await manager.platformPendingFeedback('task-1');
    expect(result.pending.size).toBe(0);
  });

  it('fails closed when any comment source cannot be fetched', async () => {
    await seed();
    driver.comments.reviews = new Error('HTTP 500');
    await expect(manager.platformPendingFeedback('task-1')).rejects.toThrow(/reviews/);
  });
});

describe('platformConfirmMerge', () => {
  it('merges with the expected head after provenance and ack recheck pass', async () => {
    const body = passBody();
    await seed({ passProvenance: provenanceFor(body) });
    seedAcceptedPass();
    await manager.platformConfirmMerge('task-1', { expectedHeadSha: SHA1 });
    const merge = driver.ops.find(o => o.op === 'merge');
    expect(merge?.vars).toEqual({ prNumber: 42, expectedHeadSha: SHA1 });
  });

  it('fails early when the live head moved past the expected sha', async () => {
    const body = passBody();
    await seed({ passProvenance: provenanceFor(body) });
    seedAcceptedPass();
    driver.prView = prRow({ headSha: 'b'.repeat(40) });
    await expect(manager.platformConfirmMerge('task-1', { expectedHeadSha: SHA1 }))
      .rejects.toThrow(/head/);
    expect(driver.ops.some(o => o.op === 'merge')).toBe(false);
  });

  it('blocks the merge when the accepted pass body was edited afterwards', async () => {
    const body = passBody();
    await seed({ passProvenance: provenanceFor(body) });
    driver.comments.reviews = [comment('r1', `${body}\nedited`)];
    await expect(manager.platformConfirmMerge('task-1', { expectedHeadSha: SHA1 }))
      .rejects.toThrow(/carrier-body-edited/);
    expect(driver.ops.some(o => o.op === 'merge')).toBe(false);
  });

  it('blocks the merge while feedback revisions remain unacked', async () => {
    const body = passBody();
    await seed({ passProvenance: provenanceFor(body) });
    seedAcceptedPass();
    driver.comments['issue-comments'] = [comment('c1', 'wait, one more thing', { authorId: '5' })];
    await expect(manager.platformConfirmMerge('task-1', { expectedHeadSha: SHA1 }))
      .rejects.toThrow(/pending/);
    expect(driver.ops.some(o => o.op === 'merge')).toBe(false);
  });

  it('surfaces MERGE_BLOCKED with the authoritative mergeable state for diagnosis', async () => {
    const body = passBody();
    await seed({ passProvenance: provenanceFor(body) });
    seedAcceptedPass();
    driver.mergeError = new DriverOpError('merge failed', {
      opName: 'merge', errorClass: 'MERGE_BLOCKED', exitCode: 1, stderrTail: 'Pull Request is not mergeable',
    });
    driver.prView = prRow({ detailedMergeStatus: 'blocked' });
    await expect(manager.platformConfirmMerge('task-1', { expectedHeadSha: SHA1 }))
      .rejects.toThrow(/blocked/);
  });
});

describe('mintReviewTokenPair', () => {
  it('mints two independent 12-hex tokens', () => {
    const pair = manager.mintReviewTokenPair();
    expect(pair.passToken).toMatch(/^[0-9a-f]{12}$/);
    expect(pair.failToken).toMatch(/^[0-9a-f]{12}$/);
    expect(pair.passToken).not.toBe(pair.failToken);
  });
});

describe('git post-approve completion on TaskState', () => {
  it('get/complete round-trip lives entirely on the approved git task record', async () => {
    await seed({ status: 'approved', ...postApproveEpisode() });
    const task = await taskStore.get('task-1');
    expect(task?.postApproveToken).toBe('tok123456789');
    expect(await manager.getPostApproveCompletion('task-1')).toMatchObject({
      token: 'tok123456789', approvedHeadSha: SHA1,
    });

    const completed = await manager.completeApprovedPassToMergeReady('task-1', {
      generation: task!.postApproveGeneration!, headSha: SHA1, token: 'tok123456789',
    });
    expect('task' in completed && completed.task.status).toBe('merge-ready');
    const after = await taskStore.get('task-1');
    expect(after?.postApproveToken).toBeUndefined();
    expect(after?.postApproveHeadSha).toBeUndefined();
    expect(await manager.getPostApproveCompletion('task-1')).toBeNull();
  });

  it('token CAS writes pending, count, and the consumed revision in one durable update', async () => {
    await seed({ status: 'approved', ...postApproveEpisode() });
    const ok = await manager.updatePostApproveCompletionIfToken('task-1', 'tok123456789', {
      pendingRedispatch: true,
    }, {
      expectedGeneration: POST_APPROVE_GENERATION,
      expectedHeadSha: SHA1,
      consumeRevision: { key: 'issue-comments:c1:aa', versionTime: 1700 },
    });
    expect(ok).toBe(true);
    const task = await taskStore.get('task-1');
    expect(task?.pendingRedispatch).toBe(true);
    expect(task?.consumedFeedback).toEqual({ 'issue-comments:c1:aa': 1700 });
    expect(await manager.updatePostApproveCompletionIfToken('task-1', 'wrong0000000', { pendingRedispatch: false }))
      .toBe(false);
  });

  it('revoke strips the completion and stamps the marker in a single write', async () => {
    await seed({
      status: 'approved',
      ...postApproveEpisode({ pendingRedispatch: true, redispatchCount: 2 }),
    });
    expect(await manager.revokePostApproveCompletion('task-1', 'redispatch-cap', {
      expectedToken: 'tok123456789', expectedGeneration: POST_APPROVE_GENERATION, expectedHeadSha: SHA1,
    }))
      .toBe(true);
    const task = await taskStore.get('task-1');
    expect(task?.postApproveRevoked).toMatchObject({
      generation: POST_APPROVE_GENERATION, reason: 'redispatch-cap',
    });
    expect(task?.postApproveToken).toBeUndefined();
    expect(task?.pendingRedispatch).toBeUndefined();
    expect(task?.redispatchCount).toBeUndefined();
  });

  it('keeps one generation across redispatch while stale token callbacks become no-ops', async () => {
    await seed({
      status: 'approved',
      ...postApproveEpisode({ pendingRedispatch: true, redispatchCount: 0 }),
    });
    const oldKey = {
      generation: POST_APPROVE_GENERATION, headSha: SHA1, token: 'tok123456789',
    };
    const nextKey = await manager.rotateGitPostApproveEpisode('task-1', oldKey, 1);
    await manager.confirmPostApprovePromptDelivered('task-1', oldKey);
    expect(await taskStore.get('task-1')).toMatchObject({
      postApproveGeneration: POST_APPROVE_GENERATION,
      postApproveToken: nextKey!.token,
      postApprovePhase: 'installed',
      pendingRedispatch: true,
    });

    await manager.confirmPostApprovePromptDelivered('task-1', nextKey!);
    expect(await taskStore.get('task-1')).toMatchObject({
      postApproveGeneration: POST_APPROVE_GENERATION,
      postApproveToken: nextKey!.token,
      postApprovePhase: 'delivered',
      pendingRedispatch: false,
    });
  });

  it('consumeGitFeedbackRevision re-enters post-approve with the consumed key in the same write', async () => {
    await seed({ status: 'merge-ready', latestHeadSha: SHA1 });
    const returned = asReturned(await manager.consumeGitFeedbackRevision('task-1', {
      key: 'issue-comments:c9:bb', versionTime: 1800,
    }));
    expect(returned?.status).toBe('approved');
    expect(returned?.postApproveHeadSha).toBe(SHA1);
    expect(returned?.consumedFeedback).toEqual({ 'issue-comments:c9:bb': 1800 });
    expect(asReturned(await manager.consumeGitFeedbackRevision('task-1', { key: 'x:y:z', versionTime: 1 }))).toBeNull();
  });

  it('pruneConsumedFeedback drops only same-source keys strictly below the watermark', async () => {
    await seed({
      consumedFeedback: {
        'issue-comments:c1:aa': 100,
        'issue-comments:c2:bb': 200,
        'reviews:r1:cc': 50,
      },
    });
    await manager.pruneConsumedFeedback('task-1', 'issue-comments', 200);
    expect((await taskStore.get('task-1'))?.consumedFeedback).toEqual({
      'issue-comments:c2:bb': 200,
      'reviews:r1:cc': 50,
    });
  });
});

describe('mergePr (git)', () => {
  it('routes to the platform confirm-merge orchestration with the expected head', async () => {
    await seed({ status: 'merge-ready', latestHeadSha: SHA1 });
    const confirm = vi.spyOn(manager, 'platformConfirmMerge').mockResolvedValue(undefined);
    await manager.mergePr('task-1', { matchHeadSha: SHA1 });
    expect(confirm).toHaveBeenCalledWith('task-1', { expectedHeadSha: SHA1 });
    await manager.mergePr('task-1');
    expect(confirm).toHaveBeenLastCalledWith('task-1', { expectedHeadSha: SHA1 });
  });
});

describe('platform binding fingerprint', () => {
  it('refuses platform ops and raises an intervention when the snapshot no longer matches live config', async () => {
    await seed({
      platformBinding: { mode: 'git', repoKey: 'github.com/owner/renamed', tool: 'gh' },
    });
    await expect(manager.platformFetchPrView('task-1')).rejects.toThrow(/binding mismatch/);
    expect(driver.ops).toHaveLength(0);
  });

  it('proceeds when the snapshot matches and refuses a git task with no snapshot at all', async () => {
    await seed();
    await expect(manager.platformFetchPrView('task-1')).resolves.toBeDefined();
    await seed({ platformBinding: undefined });
    await expect(manager.platformFetchPrView('task-1')).rejects.toThrow(/binding missing/);
  });

  it('platformBindingFields snapshots the identity trio only for git-mode projects', () => {
    expect(manager.platformBindingFields('proj')).toEqual({
      platformBinding: { mode: 'git', repoKey: 'github.com/owner/repo', tool: 'gh' },
    });
  });
});

describe('confirm-merge provenance anchoring', () => {
  it('refuses to merge a head the accepted pass never anchored', async () => {
    const body = passBody();
    await seed({
      passProvenance: { ...provenanceFor(body), anchorSha: 'b'.repeat(40) },
      latestHeadSha: SHA1,
    });
    seedAcceptedPass();
    await expect(manager.platformConfirmMerge('task-1', { expectedHeadSha: SHA1 }))
      .rejects.toThrow(/provenance anchors/);
    expect(driver.ops.some(o => o.op === 'merge')).toBe(false);
  });
});

describe('git QA dispatch anchoring', () => {
  it('aborts the dispatch instead of arming an unanchorable review round', async () => {
    await seed({
      status: 'review', signalToken: 'ffff00001111', reviewRound: 1,
    });
    const acquire = vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    driver.prView = new Error('HTTP 502');
    const release = vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    await expect(manager.dispatchReviewToQa('task-1')).rejects.toThrow('HTTP 502');
    expect(acquire).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(driver.ops.some(o => o.op === 'merge')).toBe(false);
  });
});

describe('git review lease outcomes', () => {
  it('recovers a confirmed initial delivery that crashed before creating its review lease', async () => {
    await seed({
      status: 'in_progress',
      phase: 'spec',
      specReviewRound: 0,
      reviewRound: 0,
      signalToken: 'confirmed-spec-token',
      deliveryConfirmation: { phase: 'spec', source: 'signal', at: TS },
      reviewDispatch: undefined,
    });
    const dispatch = vi.spyOn(manager, 'dispatchGitReviewLease').mockResolvedValue({} as TaskState);

    await manager.retryPendingGitReviewDispatches();

    const recovered = await taskStore.get('task-1');
    expect(recovered).toMatchObject({
      status: 'review',
      phase: 'spec',
      reviewRoundPending: true,
      reviewDispatch: {
        phase: 'pending',
        qaPhase: 'review',
        headSha: SHA1,
        effectiveRound: 1,
      },
    });
    expect(dispatch).toHaveBeenCalledWith('task-1', {
      expectedGeneration: recovered!.reviewDispatch!.generation,
    });
  });

  it('reports an invalid binding once while preserving a confirmed delivery for recovery', async () => {
    await seed({
      status: 'in_progress',
      phase: 'spec',
      specReviewRound: 0,
      reviewRound: 0,
      signalToken: 'confirmed-spec-token',
      deliveryConfirmation: { phase: 'spec', source: 'signal', at: TS },
      reviewDispatch: undefined,
    });
    driver.prView = prRow({ draft: true });
    const bus = (manager as unknown as { eventBus: EventBus }).eventBus;
    const emit = vi.spyOn(bus, 'emit');
    const dispatch = vi.spyOn(manager, 'dispatchGitReviewLease');

    await manager.retryPendingGitReviewDispatches();
    await manager.retryPendingGitReviewDispatches();

    const alerts = emit.mock.calls
      .map(([event]) => event)
      .filter(event => event.type === 'human.intervention'
        && event.data.phase === 'git-review-delivery-binding-invalid');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.data).toMatchObject({
      reason: 'draft',
      prNumber: 42,
      deliveryPhase: 'spec',
    });
    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'in_progress',
      phase: 'spec',
      signalToken: 'confirmed-spec-token',
    });
    expect((await taskStore.get('task-1'))?.reviewDispatch).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not report an obsolete binding failure after the delivery generation changes', async () => {
    await seed({
      status: 'in_progress',
      phase: 'spec',
      specReviewRound: 0,
      reviewRound: 0,
      signalToken: 'confirmed-spec-token',
      deliveryConfirmation: { phase: 'spec', source: 'signal', at: TS },
      reviewDispatch: undefined,
    });
    vi.spyOn(manager, 'platformVerifyPrBinding').mockImplementation(async () => {
      const current = await taskStore.get('task-1');
      await taskStore.set({
        ...current!,
        signalToken: 'successor-spec-token',
        updatedAt: new Date().toISOString(),
      });
      return { ok: false, reason: 'draft' };
    });
    const bus = (manager as unknown as { eventBus: EventBus }).eventBus;
    const emit = vi.spyOn(bus, 'emit');

    await manager.retryPendingGitReviewDispatches();

    expect(emit.mock.calls
      .map(([event]) => event)
      .filter(event => event.type === 'human.intervention'
        && event.data.phase === 'git-review-delivery-binding-invalid')).toHaveLength(0);
    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'in_progress',
      signalToken: 'successor-spec-token',
    });
  });

  it('does not invent a review lease before the initial delivery is confirmed', async () => {
    await seed({
      status: 'in_progress',
      phase: 'spec',
      specReviewRound: 0,
      reviewRound: 0,
      signalToken: 'unconfirmed-spec-token',
      deliveryConfirmation: undefined,
      reviewDispatch: undefined,
    });
    const dispatch = vi.spyOn(manager, 'dispatchGitReviewLease');

    await manager.retryPendingGitReviewDispatches();

    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'in_progress',
      phase: 'spec',
    });
    expect((await taskStore.get('task-1'))?.reviewDispatch).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('allows only one dispatcher to claim and start the same generation', async () => {
    await seed({ status: 'in_progress', reviewRound: 0 });
    const begun = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['in_progress'], headSha: SHA1, bumpRound: true,
    });
    const acquire = vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    const start = vi.spyOn(manager, 'startSession').mockResolvedValue(true);
    const generation = begun!.task.reviewDispatch!.generation;

    const outcomes = await Promise.allSettled([
      manager.dispatchGitReviewLease('task-1', { expectedGeneration: generation }),
      manager.dispatchGitReviewLease('task-1', { expectedGeneration: generation }),
    ]);

    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('does not release a successor QA binding after the claimed pass is superseded', async () => {
    await seed({ status: 'review', reviewRound: 1, signalToken: 'ffff00001111' });
    const begun = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['review'], headSha: SHA1, bumpRound: true,
    });
    const oldLease = begun!.task.reviewDispatch!;
    const oldLock = await lockManager.acquire('qa-1', 'task-1');
    expect(oldLock).not.toBeNull();
    await agentStore.set({
      id: 'qa-1', projectId: 'proj', taskId: 'task-1', lockToken: oldLock!, updatedAt: TS,
    });

    const realGet = agentStore.get.bind(agentStore);
    let successorGeneration: string | undefined;
    let successorLock: string | null = null;
    vi.spyOn(agentStore, 'get').mockImplementation(async (agentId) => {
      if (agentId === 'qa-1' && successorGeneration === undefined) {
        const successor = await manager.beginGitReviewPass('task-1', {
          fromStatus: ['review'], headSha: SHA1, bumpRound: true,
          expectSignalToken: oldLease.signalToken,
        });
        successorGeneration = successor!.task.reviewDispatch!.generation;
        await lockManager.releaseIfOwner('qa-1', 'task-1', oldLock!);
        successorLock = await lockManager.acquire('qa-1', 'task-1');
        await agentStore.set({
          ...(await realGet('qa-1'))!, lockToken: successorLock!, updatedAt: new Date().toISOString(),
        });
      }
      return realGet(agentId);
    });

    await expect(manager.dispatchGitReviewLease('task-1', {
      expectedGeneration: oldLease.generation,
    })).rejects.toThrow(/could not be released/);

    expect((await taskStore.get('task-1'))?.reviewDispatch?.generation).toBe(successorGeneration);
    expect((await realGet('qa-1'))?.lockToken).toBe(successorLock);
    expect(await lockManager.isOwner('qa-1', 'task-1', successorLock!)).toBe(true);
  });

  it('does not park the dev after the claimed review pass is superseded', async () => {
    await seed({ status: 'review', reviewRound: 1, signalToken: 'ffff00001111' });
    const begun = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['review'], headSha: SHA1, bumpRound: true,
    });
    const oldLease = begun!.task.reviewDispatch!;
    const devLock = await lockManager.acquire('dev-1', 'task-1');
    expect(devLock).not.toBeNull();
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', lockToken: devLock!, updatedAt: TS,
    });
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);

    const realGet = agentStore.get.bind(agentStore);
    let successorGeneration: string | undefined;
    vi.spyOn(agentStore, 'get').mockImplementation(async (agentId) => {
      if (agentId === 'dev-1' && successorGeneration === undefined) {
        const successor = await manager.beginGitReviewPass('task-1', {
          fromStatus: ['review'], headSha: SHA1, bumpRound: true,
          expectSignalToken: oldLease.signalToken,
        });
        successorGeneration = successor!.task.reviewDispatch!.generation;
      }
      return realGet(agentId);
    });

    await expect(manager.dispatchGitReviewLease('task-1', {
      expectedGeneration: oldLease.generation,
    })).rejects.toThrow(/Cannot park dev/);

    expect((await taskStore.get('task-1'))?.reviewDispatch?.generation).toBe(successorGeneration);
    expect((await realGet('dev-1'))?.needInput).toBeUndefined();
    expect(await lockManager.isOwner('dev-1', 'task-1', devLock!)).toBe(true);
  });

  it('does not fail a successor review lease for a stale terminal dispatch error', async () => {
    await seed({ status: 'review', reviewRound: 1, signalToken: 'ffff00001111' });
    const first = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['review'], headSha: SHA1, bumpRound: false,
    });
    const second = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['review'], headSha: 'b'.repeat(40), bumpRound: true,
      expectSignalToken: first!.task.signalToken,
    });

    await manager.failTaskForDispatchError(
      'task-1',
      'recheck',
      'qa-1',
      new DispatchTerminalError('prompt_too_large', 'late failure from the old lease'),
      { expectedReviewDispatch: first!.task.reviewDispatch! },
    );

    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'review',
      reviewDispatch: { generation: second!.task.reviewDispatch!.generation },
    });
  });

  it('rechecks the PR binding and head before a pending lease is claimed', async () => {
    await seed({ status: 'review', reviewRound: 1, signalToken: 'ffff00001111' });
    const begun = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['review'], headSha: SHA1, bumpRound: false,
    });
    driver.prView = prRow({ headSha: 'b'.repeat(40) });
    const dispatch = vi.spyOn(manager, 'dispatchGitReviewLease');

    await manager.retryPendingGitReviewDispatches();

    expect(dispatch).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.reviewDispatch).toMatchObject({
      generation: begun!.task.reviewDispatch!.generation,
      phase: 'pending',
      headSha: SHA1,
    });
  });

  it('reports an invalid binding once while preserving a pending review lease', async () => {
    await seed({ status: 'review', phase: 'spec', specReviewRound: 1, signalToken: 'spec-pass' });
    const begun = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['review'], headSha: SHA1, bumpRound: false,
    });
    driver.prView = prRow({ draft: true });
    const bus = (manager as unknown as { eventBus: EventBus }).eventBus;
    const emit = vi.spyOn(bus, 'emit');
    const dispatch = vi.spyOn(manager, 'dispatchGitReviewLease');

    await manager.retryPendingGitReviewDispatches();
    driver.prView = prRow({ state: 'closed' });
    await manager.retryPendingGitReviewDispatches();

    const alerts = emit.mock.calls
      .map(([event]) => event)
      .filter(event => event.type === 'human.intervention'
        && event.data.phase === 'git-review-lease-binding-invalid');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.data).toMatchObject({
      reason: 'draft',
      prNumber: 42,
      generation: begun!.task.reviewDispatch!.generation,
      deliveryPhase: 'spec',
      qaPhase: begun!.task.reviewDispatch!.qaPhase,
    });
    expect((await taskStore.get('task-1'))?.reviewDispatch).toEqual(begun!.task.reviewDispatch);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not report an obsolete pending-lease binding failure after its generation changes', async () => {
    await seed({ status: 'review', phase: 'spec', specReviewRound: 1, signalToken: 'spec-pass' });
    const first = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['review'], headSha: SHA1, bumpRound: false,
    });
    let successorGeneration: string | undefined;
    vi.spyOn(manager, 'platformVerifyPrBinding').mockImplementation(async () => {
      const successor = await manager.beginGitReviewPass('task-1', {
        fromStatus: ['review'],
        headSha: SHA1,
        bumpRound: true,
        expectSignalToken: first!.task.signalToken,
      });
      successorGeneration = successor!.task.reviewDispatch!.generation;
      return { ok: false, reason: 'draft' };
    });
    const bus = (manager as unknown as { eventBus: EventBus }).eventBus;
    const emit = vi.spyOn(bus, 'emit');

    await manager.retryPendingGitReviewDispatches();

    expect(emit.mock.calls
      .map(([event]) => event)
      .filter(event => event.type === 'human.intervention'
        && event.data.phase === 'git-review-lease-binding-invalid')).toHaveLength(0);
    expect((await taskStore.get('task-1'))?.reviewDispatch?.generation).toBe(successorGeneration);
  });

  it('fails a pending lease when its retry hits a terminal dispatch error', async () => {
    await seed({ status: 'review', reviewRound: 1, signalToken: 'ffff00001111' });
    await manager.beginGitReviewPass('task-1', {
      fromStatus: ['review'], headSha: SHA1, bumpRound: false,
    });
    vi.spyOn(manager, 'dispatchGitReviewLease').mockRejectedValue(
      new DispatchTerminalError('required_skills_missing', 'QA skill missing'),
    );

    await manager.retryPendingGitReviewDispatches();

    expect((await taskStore.get('task-1'))?.status).toBe('failed');
  });

  it('marks an ack_unknown claim uncertain so the sweep cannot double-dispatch it', async () => {
    await seed({ status: 'in_progress', reviewRound: 0 });
    const begun = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['in_progress'], headSha: SHA1, bumpRound: true,
    });
    const start = vi.spyOn(manager, 'startSession').mockRejectedValueOnce(
      new DispatchTerminalError('ack_unknown', 'delivery outcome unknown'),
    );

    await expect(manager.dispatchGitReviewLease('task-1', {
      expectedGeneration: begun!.task.reviewDispatch!.generation,
    })).rejects.toMatchObject({ reason: 'ack_unknown' });

    expect((await taskStore.get('task-1'))?.reviewDispatch?.phase).toBe('uncertain');
    expect(await agentStore.get('qa-1')).toMatchObject({
      taskId: 'task-1',
      status: 'awaiting_human',
      awaitingPhase: 'dispatch-failed:ack_unknown',
    });
    const retry = vi.spyOn(manager, 'dispatchGitReviewLease');
    await manager.retryPendingGitReviewDispatches();
    expect(retry).not.toHaveBeenCalled();

    await expect(manager.dispatchReviewToQa('task-1')).rejects.toMatchObject({
      status: 409, code: 'dispatch-uncertain',
    });
    const intervention = vi.spyOn(
      manager as unknown as {
        emitIntervention: (
          projectId: string,
          agentId: string | undefined,
          taskId: string | undefined,
          data: Record<string, unknown> & { phase: string },
        ) => Promise<boolean>;
      },
      'emitIntervention',
    );
    start.mockResolvedValue(true);
    driver.prView = prRow({ headSha: 'b'.repeat(40) });
    const manual = await manager.dispatchReviewToQa('task-1', {
      confirmUncertainNotDelivered: true,
    });

    expect(manual.reviewDispatch).toBeUndefined();
    expect(manual.reviewRound).toBe(1);
    expect(manual.latestHeadSha).toBe('b'.repeat(40));
    expect(manual.reviewHeadAnchorSha).toBe('b'.repeat(40));
    expect(start).toHaveBeenCalledTimes(2);
    expect(await agentStore.get('qa-1')).toMatchObject({ taskId: 'task-1' });
    expect((await agentStore.get('qa-1'))?.awaitingPhase).toBeUndefined();
    expect(intervention).toHaveBeenCalledWith('proj', 'qa-1', 'task-1', {
      phase: 'git-review-dispatch-hold-cleared',
      previousPhase: 'dispatch-failed:ack_unknown',
      generation: begun!.task.reviewDispatch!.generation,
    });
  });

  it('retires an old-head code verdict before confirming an uncertain dispatch on a new head', async () => {
    await seed({ status: 'in_progress', reviewRound: 0 });
    const begun = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['in_progress'], headSha: SHA1, bumpRound: true,
    });
    const start = vi.spyOn(manager, 'startSession').mockRejectedValueOnce(
      new DispatchTerminalError('ack_unknown', 'delivery outcome unknown'),
    );
    await expect(manager.dispatchGitReviewLease('task-1', {
      expectedGeneration: begun!.task.reviewDispatch!.generation,
    })).rejects.toMatchObject({ reason: 'ack_unknown' });
    const uncertain = (await taskStore.get('task-1'))!;
    await taskStore.set({
      ...uncertain,
      outbox: [{
        key: uncertain.passToken!,
        type: 'git.code-verdict',
        data: {
          prNumber: uncertain.prNumber!,
          kind: 'pass',
          anchorSha: SHA1,
          token: uncertain.passToken!,
          comments: '',
        },
      }],
    });
    driver.prView = prRow({ headSha: 'b'.repeat(40) });
    start.mockResolvedValue(true);

    const confirmed = await manager.dispatchReviewToQa('task-1', {
      confirmUncertainNotDelivered: true,
    });

    expect(confirmed.latestHeadSha).toBe('b'.repeat(40));
    expect(confirmed.reviewHeadAnchorSha).toBe('b'.repeat(40));
    expect(pendingCodeVerdict(confirmed)).toBeUndefined();
  });

  it('keeps the QA hold when persisting the confirmed pending lease fails', async () => {
    await seed({ status: 'in_progress', reviewRound: 0 });
    const begun = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['in_progress'], headSha: SHA1, bumpRound: true,
    });
    vi.spyOn(manager, 'startSession').mockRejectedValueOnce(
      new DispatchTerminalError('ack_unknown', 'delivery outcome unknown'),
    );
    await expect(manager.dispatchGitReviewLease('task-1', {
      expectedGeneration: begun!.task.reviewDispatch!.generation,
    })).rejects.toMatchObject({ reason: 'ack_unknown' });
    const clear = vi.spyOn(manager, 'clearAwaitingHuman');
    vi.spyOn(taskStore, 'set').mockRejectedValueOnce(new Error('task store unavailable'));

    await expect(manager.dispatchReviewToQa('task-1', {
      confirmUncertainNotDelivered: true,
    })).rejects.toThrow('task store unavailable');

    expect(clear).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.reviewDispatch?.phase).toBe('uncertain');
    expect(await agentStore.get('qa-1')).toMatchObject({
      status: 'awaiting_human',
      awaitingPhase: 'dispatch-failed:ack_unknown',
    });
  });

  it('refuses uncertain-delivery confirmation when the authoritative PR binding changed', async () => {
    await seed({ status: 'in_progress', reviewRound: 0 });
    const begun = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['in_progress'], headSha: SHA1, bumpRound: true,
    });
    const start = vi.spyOn(manager, 'startSession').mockRejectedValueOnce(
      new DispatchTerminalError('ack_unknown', 'delivery outcome unknown'),
    );
    await expect(manager.dispatchGitReviewLease('task-1', {
      expectedGeneration: begun!.task.reviewDispatch!.generation,
    })).rejects.toMatchObject({ reason: 'ack_unknown' });
    driver.prView = prRow({ branch: 'feature/rebound' });

    await expect(manager.dispatchReviewToQa('task-1', {
      confirmUncertainNotDelivered: true,
    })).rejects.toMatchObject({ status: 409 });

    expect(start).toHaveBeenCalledTimes(1);
    expect((await taskStore.get('task-1'))?.reviewDispatch?.phase).toBe('uncertain');
    expect(await agentStore.get('qa-1')).toMatchObject({
      status: 'awaiting_human',
      awaitingPhase: 'dispatch-failed:ack_unknown',
    });
  });

  it('reports an uncertain-confirmation write before rejecting a post-confirm generation drift', async () => {
    await seed({ status: 'in_progress', reviewRound: 0 });
    const begun = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['in_progress'], headSha: SHA1, bumpRound: true,
    });
    vi.spyOn(manager, 'startSession').mockRejectedValueOnce(
      new DispatchTerminalError('ack_unknown', 'delivery outcome unknown'),
    );
    await expect(manager.dispatchGitReviewLease('task-1', {
      expectedGeneration: begun!.task.reviewDispatch!.generation,
    })).rejects.toMatchObject({ reason: 'ack_unknown' });
    const uncertain = (await taskStore.get('task-1'))!;
    const internal = manager as unknown as {
      confirmUncertainGitReviewDispatch: (
        taskId: string,
        expectedGeneration: string,
        verifiedHeadSha: string,
      ) => Promise<TaskState | null>;
    };
    const confirm = internal.confirmUncertainGitReviewDispatch.bind(internal);
    vi.spyOn(internal, 'confirmUncertainGitReviewDispatch').mockImplementationOnce(async (...args) => {
      const confirmed = await confirm(...args);
      const drifted = {
        ...confirmed!,
        specReviewRound: 1,
        updatedAt: new Date().toISOString(),
      };
      await taskStore.set(drifted);
      return drifted;
    });
    const onSideEffect = vi.fn();

    await expect(manager.dispatchReviewToQa('task-1', {
      confirmUncertainNotDelivered: true,
      expectedTask: {
        status: uncertain.status,
        phase: uncertain.phase,
        signalToken: uncertain.signalToken,
        agentId: uncertain.agentId,
        reviewRound: uncertain.reviewRound,
        specReviewRound: uncertain.specReviewRound,
      },
      onSideEffect,
    })).rejects.toMatchObject({
      status: 409,
      code: 'dispatch-superseded',
      message: 'Task task-1 review generation changed during uncertain-delivery confirmation',
    });

    expect(onSideEffect).toHaveBeenCalledOnce();
    expect(await taskStore.get('task-1')).toMatchObject({
      specReviewRound: 1,
      reviewDispatch: { phase: 'pending' },
    });
  });

  it('restores the same uncertain generation when the QA hold changes during confirmation', async () => {
    await seed({ status: 'in_progress', reviewRound: 0 });
    const begun = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['in_progress'], headSha: SHA1, bumpRound: true,
    });
    const start = vi.spyOn(manager, 'startSession').mockRejectedValueOnce(
      new DispatchTerminalError('ack_unknown', 'delivery outcome unknown'),
    );
    await expect(manager.dispatchGitReviewLease('task-1', {
      expectedGeneration: begun!.task.reviewDispatch!.generation,
    })).rejects.toMatchObject({ reason: 'ack_unknown' });
    vi.spyOn(manager, 'clearAwaitingHuman').mockResolvedValueOnce(false);
    const writes = vi.spyOn(taskStore, 'set');

    await expect(manager.dispatchReviewToQa('task-1', {
      confirmUncertainNotDelivered: true,
    })).rejects.toMatchObject({ status: 409, code: 'dispatch-superseded' });

    expect(writes.mock.calls.map(([task]) => task.reviewDispatch?.phase)).toEqual(['pending', 'uncertain']);
    expect((await taskStore.get('task-1'))?.reviewDispatch).toMatchObject({
      phase: 'uncertain',
      generation: begun!.task.reviewDispatch!.generation,
    });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('recovers a persisted pending lease when its ack-unknown QA hold survived a crash', async () => {
    await seed({ status: 'in_progress', reviewRound: 0 });
    const begun = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['in_progress'], headSha: SHA1, bumpRound: true,
    });
    vi.spyOn(manager, 'startSession').mockRejectedValueOnce(
      new DispatchTerminalError('ack_unknown', 'delivery outcome unknown'),
    );
    await expect(manager.dispatchGitReviewLease('task-1', {
      expectedGeneration: begun!.task.reviewDispatch!.generation,
    })).rejects.toMatchObject({ reason: 'ack_unknown' });
    const uncertain = (await taskStore.get('task-1'))!;
    const {
      claimId: _claimId,
      claimedAt: _claimedAt,
      ...pendingLease
    } = uncertain.reviewDispatch!;
    await taskStore.set({
      ...uncertain,
      reviewDispatch: { ...pendingLease, phase: 'pending', updatedAt: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
    });
    const dispatch = vi.spyOn(manager, 'dispatchGitReviewLease');

    await manager.retryPendingGitReviewDispatches();

    expect(dispatch).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.reviewDispatch).toMatchObject({
      phase: 'uncertain',
      generation: begun!.task.reviewDispatch!.generation,
      claimId: expect.stringMatching(/^[0-9a-f]{12}$/),
    });
  });

  it('records reviewDispatchedAt when delivery completes rather than when the lease begins', async () => {
    await seed({ status: 'in_progress', reviewRound: 0 });
    const begun = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['in_progress'], headSha: SHA1, bumpRound: true,
    });
    const staleDispatchTime = '2020-01-01T00:00:00.000Z';
    await taskStore.set({ ...begun!.task, reviewDispatchedAt: staleDispatchTime });
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await manager.dispatchGitReviewLease('task-1', {
      expectedGeneration: begun!.task.reviewDispatch!.generation,
    });

    const delivered = await taskStore.get('task-1');
    expect(delivered?.reviewDispatch).toBeUndefined();
    expect(Date.parse(delivered!.reviewDispatchedAt!)).toBeGreaterThan(Date.parse(staleDispatchTime));
  });

  it('does not replace an uncertain lease while QA still holds its unknown-delivery prompt', async () => {
    await seed({ status: 'in_progress', reviewRound: 0 });
    const begun = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['in_progress'], headSha: SHA1, bumpRound: true,
    });
    vi.spyOn(manager, 'startSession').mockRejectedValueOnce(
      new DispatchTerminalError('ack_unknown', 'delivery outcome unknown'),
    );
    await expect(manager.dispatchGitReviewLease('task-1', {
      expectedGeneration: begun!.task.reviewDispatch!.generation,
    })).rejects.toMatchObject({ reason: 'ack_unknown' });

    const successor = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['review'], headSha: 'b'.repeat(40), bumpRound: true,
      expectSignalToken: (await taskStore.get('task-1'))!.signalToken,
    });

    expect(successor).toBeNull();
    expect((await taskStore.get('task-1'))?.reviewDispatch).toMatchObject({
      phase: 'uncertain',
      generation: begun!.task.reviewDispatch!.generation,
      headSha: SHA1,
    });
    expect(await agentStore.get('qa-1')).toMatchObject({
      status: 'awaiting_human',
      awaitingPhase: 'dispatch-failed:ack_unknown',
      taskId: 'task-1',
    });
  });

  it('keeps an uncertain lease when its QA hold changed before confirmation', async () => {
    await seed({ status: 'in_progress', reviewRound: 0 });
    const begun = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['in_progress'], headSha: SHA1, bumpRound: true,
    });
    const start = vi.spyOn(manager, 'startSession').mockRejectedValueOnce(
      new DispatchTerminalError('ack_unknown', 'delivery outcome unknown'),
    );
    await expect(manager.dispatchGitReviewLease('task-1', {
      expectedGeneration: begun!.task.reviewDispatch!.generation,
    })).rejects.toMatchObject({ reason: 'ack_unknown' });
    const held = await agentStore.get('qa-1');
    await agentStore.set({
      ...held!,
      awaitingPhase: 'branch-cleanup-pending',
      awaitingReason: 'newer operator hold',
      awaitingNonce: 'newer-hold',
      updatedAt: new Date().toISOString(),
    });

    await expect(manager.dispatchReviewToQa('task-1', {
      confirmUncertainNotDelivered: true,
    })).rejects.toMatchObject({ status: 409, code: 'dispatch-superseded' });

    expect((await taskStore.get('task-1'))?.reviewDispatch?.phase).toBe('uncertain');
    expect((await agentStore.get('qa-1'))?.awaitingPhase).toBe('branch-cleanup-pending');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('does not place an ack-unknown hold after the claimed lease was superseded', async () => {
    await seed({ status: 'in_progress', reviewRound: 0 });
    const begun = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['in_progress'], headSha: SHA1, bumpRound: true,
    });
    const oldLease = begun!.task.reviewDispatch!;
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'startSession').mockImplementation(async () => {
      await manager.beginGitReviewPass('task-1', {
        fromStatus: ['review'], headSha: SHA1, bumpRound: true,
        expectSignalToken: oldLease.signalToken,
      });
      throw new DispatchTerminalError('ack_unknown', 'late delivery outcome');
    });
    const hold = vi.spyOn(
      manager as unknown as { markAwaitingIfAckUnknown: () => Promise<void> },
      'markAwaitingIfAckUnknown',
    ).mockResolvedValue();

    await expect(manager.dispatchGitReviewLease('task-1', {
      expectedGeneration: oldLease.generation,
    })).rejects.toMatchObject({ reason: 'ack_unknown' });

    expect(hold).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.reviewDispatch?.generation).not.toBe(oldLease.generation);
    expect((await taskStore.get('task-1'))?.reviewDispatch?.phase).toBe('pending');
  });

  it('a verdict can atomically consume a claimed lease before late delivery cleanup', async () => {
    await seed({ status: 'review', reviewRound: 1, signalToken: 'ffff00001111' });
    const begun = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['review'], headSha: SHA1, bumpRound: true,
    });
    const claimed = await manager.claimGitReviewDispatch(
      'task-1', begun!.task.reviewDispatch!.generation,
    );
    const approved = await manager.approveGitReviewPass('task-1', {
      expectedSignalToken: claimed!.lease.signalToken,
      headSha: SHA1,
      reviewRound: claimed!.lease.effectiveRound,
      provenance: {
        sourceKey: 'reviews', id: 'r1', bodyDigest: 'f'.repeat(64),
        token: claimed!.lease.passToken, failToken: claimed!.lease.failToken, anchorSha: SHA1,
      },
    });
    const lateCleanup = manager as unknown as {
      completeGitReviewDispatch: (
        taskId: string, lease: NonNullable<TaskState['reviewDispatch']>,
      ) => Promise<boolean>;
    };

    expect(await lateCleanup.completeGitReviewDispatch('task-1', claimed!.lease)).toBe(false);
    expect(approved).toMatchObject({ status: 'approved', reviewRound: 2 });
    expect(approved?.reviewDispatch).toBeUndefined();
    expect((await taskStore.get('task-1'))?.postApproveGeneration).toMatch(/^[0-9a-f]{12}$/);
  });

  it('clears an uncertain-recovery attention after the matching review dispatch completes', async () => {
    await seed({ status: 'review', reviewRound: 1, signalToken: 'ffff00001111' });
    const begun = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['review'], headSha: SHA1, bumpRound: false,
    });
    const claimed = await manager.claimGitReviewDispatch(
      'task-1',
      begun!.task.reviewDispatch!.generation,
    );
    const current = (await taskStore.get('task-1'))!;
    await taskStore.set({
      ...current,
      attention: {
        reason: 'git-review-dispatch-recovery-uncertain',
        runbook: 'Confirm whether the claimed dispatch landed.',
        occurredAt: TS,
        recommendedActions: ['advance', 'cancel'],
        generation: taskAttentionGeneration(current),
      },
    });
    const internal = manager as unknown as {
      completeGitReviewDispatch: (
        taskId: string,
        lease: NonNullable<TaskState['reviewDispatch']>,
      ) => Promise<boolean>;
    };

    await expect(internal.completeGitReviewDispatch('task-1', claimed!.lease)).resolves.toBe(true);

    expect((await taskStore.get('task-1'))?.attention).toBeUndefined();
  });
});

describe('confirm merge recovery routing', () => {
  const execute = (task: TaskState, error: PlatformMergeRecheckError) => (
    manager as unknown as {
      executeConfirmMerge: (current: TaskState, merge: () => Promise<void>) => Promise<void>;
    }
  ).executeConfirmMerge(task, async () => { throw error; });

  it('routes pending feedback back to a generated dev post-approve episode', async () => {
    const task = await seed({ status: 'merge-ready', latestHeadSha: SHA1 });
    await expect(execute(task, new PlatformMergeRecheckError('pending-feedback', 'one reply is unacked')))
      .rejects.toMatchObject({ status: 409 });

    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'approved', postApproveHeadSha: SHA1, postApprovePhase: 'installed',
      pendingRedispatch: true, redispatchCount: 0,
    });
  });

  it('routes invalid provenance back to a generated QA review lease', async () => {
    const task = await seed({ status: 'merge-ready', latestHeadSha: SHA1 });
    await expect(execute(task, new PlatformMergeRecheckError('provenance-invalid', 'pass body changed')))
      .rejects.toMatchObject({ status: 409 });

    const recovered = await taskStore.get('task-1');
    expect(recovered).toMatchObject({
      status: 'review',
      reviewDispatch: { phase: 'pending', headSha: SHA1, effectiveRound: 2 },
    });
    expect(recovered?.postApproveGeneration).toBeUndefined();
  });

  it('does not retreat a successor merge gate for a stale recheck failure', async () => {
    const entry = await seed({
      status: 'merge-ready', latestHeadSha: SHA1, signalToken: 'aaaa11112222',
    });
    await taskStore.set({
      ...entry,
      signalToken: 'bbbb11112222',
      updatedAt: new Date().toISOString(),
    });

    await expect(execute(entry, new PlatformMergeRecheckError('pending-feedback', 'stale scan result')))
      .rejects.toMatchObject({ status: 409 });

    const successor = await taskStore.get('task-1');
    expect(successor).toMatchObject({ status: 'merge-ready', signalToken: 'bbbb11112222' });
    expect(successor?.postApproveGeneration).toBeUndefined();
    expect(successor?.reviewDispatch).toBeUndefined();
  });

  it('provenance recovery treats missing phase and token as an exact merge-gate tuple', async () => {
    const entry = await seed({
      status: 'merge-ready', latestHeadSha: SHA1, phase: undefined, signalToken: undefined,
    });
    const realBegin = manager.beginGitReviewPass.bind(manager);
    let capturedOptions: Record<string, unknown> | undefined;
    vi.spyOn(manager, 'beginGitReviewPass').mockImplementation(async (taskId, options) => {
      capturedOptions = options;
      const current = await taskStore.get(taskId);
      await taskStore.set({
        ...current!, phase: 'code', signalToken: 'successor-merge-gate', updatedAt: new Date().toISOString(),
      });
      return realBegin(taskId, options);
    });

    await expect(execute(entry, new PlatformMergeRecheckError('provenance-invalid', 'pass body changed')))
      .rejects.toMatchObject({ status: 409 });

    expect(Object.hasOwn(capturedOptions ?? {}, 'expectPhase')).toBe(true);
    expect(Object.hasOwn(capturedOptions ?? {}, 'expectSignalToken')).toBe(true);
    expect(capturedOptions).toMatchObject({ fromStatus: ['merge-ready'] });
    const successor = await taskStore.get('task-1');
    expect(successor).toMatchObject({
      status: 'merge-ready', phase: 'code', signalToken: 'successor-merge-gate',
    });
    expect(successor?.reviewDispatch).toBeUndefined();
  });
});

describe('git reconciliation watcher rearm on lease dispatch', () => {
  it('arms the dev reconciliation entry only while the actor remains provisional', async () => {
    await seed({
      status: 'review', prNumber: 42, qaAgentId: 'qa-1', signalToken: 'ffff00001111',
      pendingPrSignalToken: 'aaaa11112222', replyActorId: '99', replyActorStatus: 'provisional',
    });
    const armCalls: Array<{ agentId: string; kinds: unknown; token: string }> = [];
    const managerAny = manager as unknown as {
      setupPhaseSignalWatcher: (
        taskId: string, agentId: string, kinds: unknown, token: string, opts?: unknown,
      ) => Promise<boolean>;
    };
    vi.spyOn(managerAny, 'setupPhaseSignalWatcher').mockImplementation(
      async (_taskId, agentId, kinds, token) => {
        armCalls.push({ agentId, kinds, token });
        return true;
      },
    );
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'startSession').mockResolvedValue(true);
    const first = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['review'], headSha: SHA1, bumpRound: false,
    });
    await manager.dispatchGitReviewLease('task-1', {
      expectedGeneration: first!.task.reviewDispatch!.generation,
    });
    expect(armCalls).toHaveLength(2);
    expect(armCalls[1]).toMatchObject({ agentId: 'dev-1', token: 'aaaa11112222' });

    armCalls.length = 0;
    await taskStore.set({ ...(await taskStore.get('task-1'))!, replyActorStatus: 'verified', updatedAt: new Date().toISOString() });
    const second = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['review'], headSha: SHA1, bumpRound: false,
    });
    await manager.dispatchGitReviewLease('task-1', {
      expectedGeneration: second!.task.reviewDispatch!.generation,
    });
    expect(armCalls).toHaveLength(1);
  });
});

describe('manual dispatch binding recheck', () => {
  it('requires an explicit stage before manually recovering an unconfirmed git delivery', async () => {
    await seed({
      status: 'in_progress',
      phase: undefined,
      deliveryConfirmation: undefined,
      reviewRound: 0,
      signalToken: 'initial-delivery',
      pendingPrSignalToken: 'initial-delivery',
      replyActorId: '99',
      replyActorStatus: 'provisional',
    });
    const verify = vi.spyOn(manager, 'platformVerifyPrBinding');

    await expect(manager.dispatchReviewToQa('task-1', {
      actorId: '77',
    })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('stage is required'),
    });

    expect(verify).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.phase).toBeUndefined();
  });

  it('verifies and records a manual spec delivery before creating its first git review lease', async () => {
    await seed({
      status: 'in_progress',
      phase: undefined,
      deliveryConfirmation: undefined,
      reviewRound: 0,
      signalToken: 'initial-delivery',
      pendingPrSignalToken: 'initial-delivery',
      replyActorId: '99',
      replyActorStatus: 'provisional',
    });
    const verify = vi.spyOn(manager, 'platformVerifyPrBinding').mockResolvedValue({
      ok: true,
      headSha: SHA1,
      branch: 'bx/task-1',
      targetBranch: 'main',
    });
    vi.spyOn(manager, 'dispatchGitReviewLease').mockImplementation(async () =>
      (await taskStore.get('task-1'))!);

    const result = await manager.dispatchReviewToQa('task-1', {
      stage: 'spec',
      actorId: '77',
    });

    expect(result).toMatchObject({
      status: 'review',
      phase: 'spec',
      deliveryConfirmation: { phase: 'spec', source: 'human' },
      replyActorId: '77',
      replyActorStatus: 'verified',
      reviewRound: 0,
      reviewDispatch: {
        phase: 'pending',
        effectiveRound: 1,
      },
    });
    expect(result.specReviewRound ?? 0).toBe(0);
    expect(result.pendingPrSignalToken).toBeUndefined();
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('repairs a missing delivery confirmation before redispatching an existing review', async () => {
    await seed({
      status: 'review',
      phase: 'code',
      deliveryConfirmation: undefined,
      reviewRound: 1,
      signalToken: 'ffff00001111',
      replyActorId: '99',
      replyActorStatus: 'provisional',
    });
    const verify = vi.spyOn(manager, 'platformVerifyPrBinding').mockResolvedValue({
      ok: true,
      headSha: SHA1,
      branch: 'bx/task-1',
      targetBranch: 'main',
    });
    vi.spyOn(manager, 'dispatchGitReviewLease').mockImplementation(async () =>
      (await taskStore.get('task-1'))!);

    const result = await manager.dispatchReviewToQa('task-1', {
      stage: 'code',
      actorId: '77',
    });

    expect(result).toMatchObject({
      status: 'review',
      phase: 'code',
      deliveryConfirmation: { phase: 'code', source: 'human' },
      replyActorId: '77',
      replyActorStatus: 'verified',
      reviewDispatch: { phase: 'pending', effectiveRound: 2 },
    });
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('does not repair delivery confirmation after the review generation changes', async () => {
    await seed({
      status: 'review',
      phase: 'code',
      deliveryConfirmation: undefined,
      reviewRound: 1,
      signalToken: 'ffff00001111',
      replyActorId: '99',
      replyActorStatus: 'provisional',
    });
    vi.spyOn(manager, 'platformVerifyPrBinding').mockImplementationOnce(async () => {
      await manager.updateTask('task-1', { signalToken: 'eeee99990000' });
      return {
        ok: true,
        headSha: SHA1,
        branch: 'bx/task-1',
        targetBranch: 'main',
      };
    });

    await expect(manager.dispatchReviewToQa('task-1', {
      stage: 'code',
      actorId: '77',
    })).rejects.toMatchObject({
      status: 409,
      code: 'dispatch-superseded',
    });

    expect(await taskStore.get('task-1')).toMatchObject({
      signalToken: 'eeee99990000',
      replyActorId: '99',
      replyActorStatus: 'provisional',
    });
    expect((await taskStore.get('task-1'))?.deliveryConfirmation).toBeUndefined();
  });

  it('binds an explicit PR on the task custom branch when the initial pane signal was lost', async () => {
    await seed({
      status: 'in_progress',
      phase: undefined,
      deliveryConfirmation: undefined,
      prNumber: undefined,
      prUrl: undefined,
      branch: 'feature/manual-review',
      branchCreatedByBaxian: false,
      reviewRound: 0,
      signalToken: 'initial-delivery',
      pendingPrSignalToken: 'initial-delivery',
      replyActorId: undefined,
      replyActorStatus: undefined,
      reviewDispatch: undefined,
    });
    driver.prView = prRow({
      prNumber: 73,
      prUrl: 'https://github.com/owner/repo/pull/73',
      branch: 'feature/manual-review',
    });
    vi.spyOn(manager, 'dispatchGitReviewLease').mockImplementation(async () =>
      (await taskStore.get('task-1'))!);

    const result = await manager.dispatchReviewToQa('task-1', {
      prNumber: 73,
      stage: 'code',
      actorId: '77',
    });

    expect(result).toMatchObject({
      status: 'review',
      prNumber: 73,
      prUrl: 'https://github.com/owner/repo/pull/73',
      branch: 'feature/manual-review',
      phase: 'code',
      deliveryConfirmation: { phase: 'code', source: 'human' },
      replyActorId: '77',
      replyActorStatus: 'verified',
      reviewDispatch: { phase: 'pending', effectiveRound: 1 },
    });
    expect(driver.ops.filter(op => op.op === 'prView').map(op => op.vars))
      .toEqual([{ prNumber: 73 }, { prNumber: 73 }]);
  });

  it('rejects an explicit PR whose branch does not match the task custom branch', async () => {
    await seed({
      status: 'in_progress',
      phase: undefined,
      deliveryConfirmation: undefined,
      prNumber: undefined,
      branch: 'feature/manual-review',
      branchCreatedByBaxian: false,
      signalToken: 'initial-delivery',
      pendingPrSignalToken: 'initial-delivery',
      replyActorId: undefined,
      replyActorStatus: undefined,
      reviewDispatch: undefined,
    });
    driver.prView = prRow({ prNumber: 73, branch: 'feature/unrelated' });

    await expect(manager.dispatchReviewToQa('task-1', {
      prNumber: 73,
      stage: 'code',
      actorId: '77',
    })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('binding branch'),
    });

    const task = await taskStore.get('task-1');
    expect(task).toMatchObject({
      status: 'in_progress',
      branch: 'feature/manual-review',
    });
    expect(task?.prNumber).toBeUndefined();
    expect(task?.reviewDispatch).toBeUndefined();
  });

  it('rejects an explicit PR number that conflicts with the persisted binding', async () => {
    await seed({
      status: 'in_progress',
      phase: undefined,
      deliveryConfirmation: undefined,
      signalToken: 'initial-delivery',
      pendingPrSignalToken: 'initial-delivery',
      replyActorStatus: 'provisional',
    });
    const verify = vi.spyOn(manager, 'platformVerifyPrBinding');

    await expect(manager.dispatchReviewToQa('task-1', {
      prNumber: 73,
      stage: 'code',
      actorId: '77',
    })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('already bound to PR #42'),
    });

    expect(verify).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.prNumber).toBe(42);
  });

  it('rejects a manual stage that disagrees with an already confirmed delivery', async () => {
    await seed({ status: 'review', phase: 'code' });
    const verify = vi.spyOn(manager, 'platformVerifyPrBinding');

    await expect(manager.dispatchReviewToQa('task-1', {
      stage: 'spec',
    })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('in code, not spec'),
    });

    expect(verify).not.toHaveBeenCalled();
  });

  it('preserves the current git review round when redispatch explicitly disables the bump', async () => {
    await seed({
      status: 'review',
      reviewRound: 2,
      signalToken: 'ffff00001111',
      reviewDispatch: undefined,
    });
    const dispatch = vi.spyOn(manager, 'dispatchGitReviewLease').mockImplementation(async () => {
      return (await taskStore.get('task-1'))!;
    });

    const result = await manager.dispatchReviewToQa('task-1', { bumpRound: false });

    expect(result.reviewRound).toBe(2);
    expect(result.reviewDispatch).toMatchObject({ effectiveRound: 2 });
    expect(dispatch).toHaveBeenCalledWith('task-1', expect.objectContaining({
      expectedGeneration: result.reviewDispatch?.generation,
    }));
  });

  it('rejects a stale route guard before verifying the PR binding', async () => {
    await seed({
      status: 'review',
      phase: 'code',
      reviewRound: 2,
      signalToken: 'current-pass',
      reviewDispatch: undefined,
    });
    const verify = vi.spyOn(manager, 'platformVerifyPrBinding');

    await expect(manager.dispatchReviewToQa('task-1', {
      expectedTask: {
        status: 'review',
        phase: 'code',
        signalToken: 'current-pass',
        agentId: 'dev-1',
        reviewRound: 1,
      },
    })).rejects.toMatchObject({ status: 409, code: 'dispatch-superseded' });

    expect(verify).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.reviewDispatch).toBeUndefined();
  });

  it('dispatches an existing pending lease under a matching full guard and commits its round', async () => {
    await seed({
      status: 'review',
      phase: 'code',
      reviewRound: 1,
      specReviewRound: 1,
      signalToken: 'entry-pass',
    });
    const begun = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['review'], headSha: SHA1, bumpRound: true,
    });
    vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    const result = await manager.dispatchReviewToQa('task-1', {
      expectedTask: {
        status: 'review',
        phase: 'code',
        signalToken: begun!.task.signalToken,
        agentId: 'dev-1',
        reviewRound: 1,
        specReviewRound: 1,
      },
    });

    expect(result).toMatchObject({
      status: 'review',
      reviewRound: 2,
      specReviewRound: 1,
      signalToken: begun!.task.signalToken,
    });
    expect(result.reviewRoundPending).toBeUndefined();
    expect(result.reviewDispatch).toBeUndefined();
    expect(await taskStore.get('task-1')).toEqual(result);
  });

  it('restores a claimed git lease and reports unsupported if the QA hold races the route precheck', async () => {
    await seed({ status: 'review', phase: 'code', signalToken: 'entry-pass' });
    const begun = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['review'], headSha: SHA1, bumpRound: false,
    });
    await agentStore.set({
      id: 'qa-1', projectId: 'proj', taskId: 'task-1', status: 'awaiting_human',
      awaitingPhase: 'dispatch-failed:ack_unknown', awaitingSince: TS,
      awaitingNonce: 'raced-hold', updatedAt: TS,
    });

    await expect(manager.dispatchGitReviewLease('task-1', {
      expectedGeneration: begun!.task.reviewDispatch!.generation,
    })).rejects.toMatchObject({ status: 409, code: 'dispatch-unsupported' });

    expect((await taskStore.get('task-1'))?.reviewDispatch).toMatchObject({
      generation: begun!.task.reviewDispatch!.generation,
      phase: begun!.task.reviewDispatch!.phase,
    });
  });

  it('fences the route snapshot before creating a missing git review lease', async () => {
    await seed({
      status: 'review', phase: undefined, signalToken: undefined, reviewDispatch: undefined,
    });
    vi.spyOn(manager, 'platformVerifyPrBinding').mockImplementation(async () => {
      const current = await taskStore.get('task-1');
      await taskStore.set({
        ...current!, phase: 'code', signalToken: 'manual-git-successor', updatedAt: new Date().toISOString(),
      });
      return { ok: true, headSha: SHA1, branch: 'bx/task-1', targetBranch: 'main' };
    });
    const dispatchSpy = vi.spyOn(manager, 'dispatchGitReviewLease');

    await expect(manager.dispatchReviewToQa('task-1', { stage: 'code' })).rejects.toMatchObject({
      status: 409, code: 'dispatch-superseded',
    });

    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'review', phase: 'code', signalToken: 'manual-git-successor',
    });
    expect((await taskStore.get('task-1'))?.reviewDispatch).toBeUndefined();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('checks the full task generation while claiming an existing git lease', async () => {
    await seed({
      status: 'review',
      phase: 'code',
      reviewRound: 1,
      specReviewRound: 1,
      signalToken: 'entry-pass',
    });
    const begun = await manager.beginGitReviewPass('task-1', {
      fromStatus: ['review'], headSha: SHA1, bumpRound: false,
    });
    await taskStore.set({
      ...begun!.task,
      specReviewRound: 2,
      updatedAt: new Date().toISOString(),
    });
    const acquire = vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(false);
    const onSideEffect = vi.fn();

    await expect(manager.dispatchGitReviewLease('task-1', {
      expectedGeneration: begun!.task.reviewDispatch!.generation,
      expectedTask: {
        status: 'review',
        phase: 'code',
        signalToken: begun!.task.signalToken,
        agentId: 'dev-1',
        reviewRound: 1,
        specReviewRound: 1,
      },
      onSideEffect,
    })).rejects.toMatchObject({ status: 409, code: 'dispatch-superseded' });

    expect(onSideEffect).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect((await taskStore.get('task-1'))?.reviewDispatch?.phase).toBe('pending');
  });

  it('refuses to dispatch a git review onto a PR that fails the binding predicate', async () => {
    await seed({ status: 'review', signalToken: 'ffff00001111', reviewRound: 1 });
    const acquire = vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    driver.prView = prRow({ draft: true });
    const release = vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    await expect(manager.dispatchReviewToQa('task-1')).rejects.toMatchObject({
      status: 409, message: expect.stringContaining('binding draft'),
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});

describe('merge gate and post-review recovery integrity', () => {
  it('human override merges a never-passed task claimed at merge-ready, but not one that left the gate', async () => {
    await seed({ status: 'merge-ready', passProvenance: undefined, latestHeadSha: SHA1 });
    await manager.mergePr('task-1', { matchHeadSha: SHA1, humanOverride: true });
    expect(driver.ops.find(o => o.op === 'merge')?.vars).toEqual({ prNumber: 42, expectedHeadSha: SHA1 });

    driver.ops = [];
    await seed({ status: 'fixing', passProvenance: undefined, latestHeadSha: SHA1 });
    await expect(manager.mergePr('task-1', { matchHeadSha: SHA1, humanOverride: true }))
      .rejects.toThrow(/left its merge gate/);
    expect(driver.ops.some(o => o.op === 'merge')).toBe(false);
  });

  it('refuses the confirm once the task has durably left its merge gate', async () => {
    const body = passBody();
    await seed({
      passProvenance: provenanceFor(body), status: 'approved',
      ...postApproveEpisode({ pendingRedispatch: true }),
    });
    seedAcceptedPass();
    await expect(manager.platformConfirmMerge('task-1', { expectedHeadSha: SHA1 }))
      .rejects.toThrow(/left its merge gate/);
    expect(driver.ops.some(o => o.op === 'merge')).toBe(false);
  });

  it('retries every durable remote cleanup intent regardless of terminal filtering', async () => {
    await seed({
      status: 'cancelled',
      remoteCleanup: {
        generation: 'abc123abc123', stage: 'delete-pending', prNumber: 42, branch: 'bx/task-1',
        expectedHeadSha: SHA1, remoteProjectId: 'R_repo', updatedAt: TS,
      },
    });
    await manager.retryGitRemoteCleanupIntents();
    expect(driver.ops.map(o => o.op)).toEqual(['deleteBranch', 'branchView']);
    expect((await taskStore.get('task-1'))?.remoteCleanup).toBeUndefined();
  });

  it('delivers outbox entries under a deterministic id so replays can be deduped', async () => {
    await seed({
      status: 'review',
      outbox: [{ key: 'task-1:42:mr-closed-unmerged:1', type: 'human.intervention', data: { phase: 'mr-closed-unmerged' } }],
    });
    const emitted: Array<{ id: string }> = [];
    const bus = (manager as unknown as { eventBus: { emit: (e: { id: string }) => Promise<void> } }).eventBus;
    vi.spyOn(bus, 'emit').mockImplementation(async (e: { id: string }) => { emitted.push(e); });
    await manager.deliverTaskOutbox('task-1');
    expect(emitted[0]?.id).toBe('outbox:task-1:42:mr-closed-unmerged:1');
  });
});

describe('platform dispatch descriptor context', () => {
  it('derives the live cli descriptor for a git task', () => {
    expect(manager.platformCliContextOf(gitTask())).toEqual({
      tool: 'gh', host: 'github.com', repo: 'owner/repo', repoEncoded: 'owner%2Frepo',
    });
  });

  it('carries operator notes and follows config changes live', () => {
    manager.replaceConfig({
      ...config,
      project: [{ ...config.project[0], gitCli: { tool: 'gh', notes: 'runs behind :8443' } }],
    });
    expect(manager.platformCliContextOf(gitTask())?.notes).toBe('runs behind :8443');
  });

  it('fails loud when the identity drifted away', () => {
    manager.replaceConfig({
      ...config,
      project: [{
        ...config.project[0],
        repo: 'https://git.corp.example.com/g/p.git',
        gitCli: { tool: 'gh' },
      }],
    });
    expect(() => manager.platformCliContextOf(gitTask())).toThrow(/platform binding mismatch/);
  });
});

describe('ensureGitBaseSnapshot', () => {
  function managerWithBaseSource(source?: (projectId: string) => string | undefined): AgentManager {
    const m = createManager({
      ...(source ? { platformDefaultBranchOf: source } : {}),
    });
    return m;
  }

  it('persists the injected default branch once for develop and code dispatch', async () => {
    const m = managerWithBaseSource(() => 'main');
    const task = await seed({ baseBranch: undefined, status: 'in_progress' });
    const out = await m.ensureGitBaseSnapshot(task, 'develop');
    expect(out.baseBranch).toBe('main');
    expect((await taskStore.get('task-1'))?.baseBranch).toBe('main');
  });

  it('never overwrites an existing snapshot even when the live default moved', async () => {
    const m = managerWithBaseSource(() => 'develop');
    const task = await seed();
    const out = await m.ensureGitBaseSnapshot(task, 'code');
    expect(out.baseBranch).toBe('main');
    expect((await taskStore.get('task-1'))?.baseBranch).toBe('main');
  });

  it('stays inert without a source and outside develop/code', async () => {
    const task = await seed({ baseBranch: undefined });
    expect((await manager.ensureGitBaseSnapshot(task, 'develop')).baseBranch).toBeUndefined();
    const m = managerWithBaseSource(() => 'main');
    expect((await m.ensureGitBaseSnapshot(task, 'review')).baseBranch).toBeUndefined();
    expect((await taskStore.get('task-1'))?.baseBranch).toBeUndefined();
  });
});

describe('ensureGitBaseSnapshot binding guard', () => {
  it('refuses to persist a base from a drifted project and leaves the task untouched', async () => {
    const m = createManager({
      platformDefaultBranchOf: () => 'main',
    });
    const task = await seed({
      baseBranch: undefined,
      status: 'in_progress',
      platformBinding: { mode: 'git', repoKey: 'github.com/owner/other-repo', tool: 'gh' },
    });
    await expect(m.ensureGitBaseSnapshot(task, 'develop')).rejects.toThrow(/platform binding mismatch/);
    expect((await taskStore.get('task-1'))?.baseBranch).toBeUndefined();
  });

  it('queues a detached binding intervention before later task mutations', async () => {
    const m = createManager({ platformDefaultBranchOf: () => 'main' });
    const task = await seed({ baseBranch: undefined, status: 'in_progress' });
    await taskStore.set({
      ...task,
      platformBinding: { mode: 'git', repoKey: 'github.com/owner/other-repo', tool: 'gh' },
    });
    const bus = (m as unknown as { eventBus: EventBus }).eventBus;
    vi.spyOn(bus, 'emit').mockImplementation(event => m.recordTaskAttention(event));
    const realSet = taskStore.set.bind(taskStore);
    let releaseAttention!: () => void;
    const attentionRelease = new Promise<void>((resolve) => {
      releaseAttention = resolve;
    });
    let markAttentionStarted!: () => void;
    const attentionStarted = new Promise<void>((resolve) => {
      markAttentionStarted = resolve;
    });
    let blocked = false;
    vi.spyOn(taskStore, 'set').mockImplementation(async (next) => {
      if (!blocked && next.attention?.reason === 'platform-binding-mismatch') {
        blocked = true;
        markAttentionStarted();
        await attentionRelease;
      }
      await realSet(next);
    });

    await expect(m.ensureGitBaseSnapshot(task, 'develop')).rejects.toThrow(/platform binding mismatch/);
    await attentionStarted;
    const revision = m.noteReviewConversationRevision('task-1');
    try {
      const settledEarly = await Promise.race([
        revision.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 30)),
      ]);
      expect(settledEarly).toBe(false);
    } finally {
      releaseAttention();
    }
    await revision;

    expect(await taskStore.get('task-1')).toMatchObject({
      attention: { reason: 'platform-binding-mismatch' },
      reviewConversationUpdatedAt: expect.any(String),
    });
  });
});

describe('noteReviewConversationRevision', () => {
  const injectCache = (): PrConversationCache => {
    const cache = new PrConversationCache();
    (manager as unknown as { prConversationCache?: PrConversationCache }).prConversationCache = cache;
    return cache;
  };
  const payloadOf = (body: string) => ({ items: [{ kind: 'issue-comment' as const, id: 'c1', body }] });

  it('stamps the display revision on a live task', async () => {
    await seed({ status: 'review' });
    await manager.noteReviewConversationRevision('task-1');
    expect((await taskStore.get('task-1'))?.reviewConversationUpdatedAt).toMatch(/^\d{4}-/);
  });

  it('skips terminal and missing tasks', async () => {
    await seed({ status: 'merged' });
    await manager.noteReviewConversationRevision('task-1');
    expect((await taskStore.get('task-1'))?.reviewConversationUpdatedAt).toBeUndefined();
    await expect(manager.noteReviewConversationRevision('task-404')).resolves.toBeUndefined();
  });

  it('warms the conversation cache under the post-bump revision before persisting the task', async () => {
    await seed({ status: 'review' });
    const cache = injectCache();
    let entriesWhenTaskPersisted = -1;
    const originalSet = taskStore.set.bind(taskStore);
    const setSpy = vi.spyOn(taskStore, 'set').mockImplementation(async (task) => {
      entriesWhenTaskPersisted = cache.stats().entries;
      return originalSet(task);
    });
    await manager.noteReviewConversationRevision('task-1', { prNumber: 42, payload: payloadOf('warm body') });
    setSpy.mockRestore();
    expect(entriesWhenTaskPersisted).toBe(1);

    const updated = await taskStore.get('task-1');
    const revision = prReviewCacheRevision(updated!, updated!.platformBinding!.repoKey);
    const served = await cache.get(updated!.id, revision, () => Promise.reject(new Error('must not build')));
    expect(served.items[0]?.body).toBe('warm body');
  });

  it('a force that read the pre-bump snapshot and lands after the warm write cannot evict it', async () => {
    const before = await seed({ status: 'review' });
    const cache = injectCache();
    await manager.noteReviewConversationRevision('task-1', { prNumber: 42, payload: payloadOf('warm body') });

    const after = await taskStore.get('task-1');
    const repoKey = after!.platformBinding!.repoKey;
    const staleRevision = prReviewCacheRevision(before, repoKey);
    const staleResult = await cache.force(
      before.id,
      staleRevision,
      async () => payloadOf('stale fetch'),
      before.reviewConversationUpdatedAt ?? '',
    );
    expect(staleResult.items[0]?.body).toBe('stale fetch');

    const served = await cache.get(
      after!.id,
      prReviewCacheRevision(after!, repoKey),
      () => Promise.reject(new Error('must not build')),
      after!.reviewConversationUpdatedAt ?? '',
    );
    expect(served.items[0]?.body).toBe('warm body');
  });

  it('bumps the revision but skips the cache write when the scanned PR no longer matches', async () => {
    await seed({ status: 'review', prNumber: 43 });
    const cache = injectCache();
    await manager.noteReviewConversationRevision('task-1', { prNumber: 42, payload: payloadOf('stale pr') });
    expect((await taskStore.get('task-1'))?.reviewConversationUpdatedAt).toMatch(/^\d{4}-/);
    expect(cache.stats().entries).toBe(0);
  });

  it('does not warm the cache for a terminal task', async () => {
    await seed({ status: 'merged' });
    const cache = injectCache();
    await manager.noteReviewConversationRevision('task-1', { prNumber: 42, payload: payloadOf('late') });
    expect(cache.stats().entries).toBe(0);
  });
});

describe('agentGitPreflightContext', () => {
  it('builds the agent-track context with the tool name as binary and live steps', () => {
    const plugin = {
      manifest: { tool: 'gh', minToolVersion: '2.40.0' },
      spec: {
        preflight: [{ argv: ['{binary}', '--version'], versionCheck: true, fixMessage: 'need {minToolVersion}' }],
        errorClasses: [],
      },
    };
    (manager as unknown as { pluginRegistry: unknown }).pluginRegistry = {
      resolveTool: (tool: string) => (tool === 'gh' ? plugin : undefined),
    };
    const ctx = manager.agentGitPreflightContext('proj');
    expect(ctx?.tool).toBe('gh');
    expect(ctx?.minToolVersion).toBe('2.40.0');
    expect(ctx?.renderCtx.binary).toBe('gh');
    expect(ctx?.renderCtx.repoPath).toBe('owner/repo');
    expect(ctx?.steps).toHaveLength(1);
    expect(typeof ctx?.driverFor).toBe('function');
  });

  it('returns undefined without a plugin registry or a resolved plugin', () => {
    expect(manager.agentGitPreflightContext('proj')).toBeUndefined();
    (manager as unknown as { pluginRegistry: unknown }).pluginRegistry = { resolveTool: () => undefined };
    expect(manager.agentGitPreflightContext('proj')).toBeUndefined();
  });
});

describe('platformCliContextOf binding guard', () => {
  it('refuses to render the cli descriptor when the live identity drifted from the binding', () => {
    const drifted = gitTask({
      platformBinding: { mode: 'git', repoKey: 'github.com/owner/other-repo', tool: 'gh' },
    });
    expect(() => manager.platformCliContextOf(drifted)).toThrow(/platform binding mismatch/);
  });

  it('refuses a git task without a binding snapshot', () => {
    const bare = gitTask({ platformBinding: undefined });
    expect(() => manager.platformCliContextOf(bare)).toThrow(/binding missing/);
  });
});

describe('config intervention fingerprints', () => {
  it('deduplicates an active fingerprint and emits it again after the condition clears', async () => {
    const bus = (manager as unknown as { eventBus: EventBus }).eventBus;
    const emit = vi.spyOn(bus, 'emit').mockResolvedValue();
    const data = { phase: 'repo-conflict', repoKey: 'github.com/owner/repo', claimedBy: 'proj-a' };

    await manager.emitConfigIntervention('proj', data);
    await manager.emitConfigIntervention('proj', data);
    expect(emit).toHaveBeenCalledTimes(1);

    manager.retainConfigInterventionKeys(new Set());
    await manager.emitConfigIntervention('proj', data);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('does not latch a fingerprint when event delivery fails', async () => {
    const bus = (manager as unknown as { eventBus: EventBus }).eventBus;
    const emit = vi.spyOn(bus, 'emit')
      .mockRejectedValueOnce(new Error('event log unavailable'))
      .mockResolvedValueOnce(undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const data = { phase: 'repo-conflict', repoKey: 'github.com/owner/repo', claimedBy: 'proj-a' };

    try {
      await manager.emitConfigIntervention('proj', data);
      await manager.emitConfigIntervention('proj', data);
    } finally {
      warn.mockRestore();
    }

    expect(emit).toHaveBeenCalledTimes(2);
  });
});

describe('listTasksForPlatformEntry', () => {
  it('returns nothing for an unknown entry project id', async () => {
    expect(await manager.listTasksForPlatformEntry('ghost')).toEqual([]);
  });

  it('excludes tasks whose project is no longer present even when their binding matches the live entry', async () => {
    await taskStore.set(gitTask({ id: 'task-live', projectId: 'proj' }));
    await taskStore.set(gitTask({ id: 'task-offline', projectId: 'removed-project' }));

    expect((await manager.listTasksForPlatformEntry('proj')).map(task => task.id)).toEqual(['task-live']);
  });

  it('fail-closes on tasks without a binding', async () => {
    await taskStore.set(gitTask({ id: 'task-bound' }));
    await taskStore.set(gitTask({
      id: 'task-unbound', platformBinding: undefined,
    }));

    const ids = (await manager.listTasksForPlatformEntry('proj')).map(t => t.id);
    expect(ids).toEqual(['task-bound']);
  });

  it('fail-closes on a tool drift (gh→forge) even when repoKey still matches', async () => {
    manager.replaceConfig({ ...config, project: [
      { id: 'proj', repo: 'https://github.com/owner/repo.git', merge: null,
        gitCli: { tool: 'forge' }, agent: [] },
    ] });
    await taskStore.set(gitTask({ id: 'task-gh', projectId: 'proj' }));
    await taskStore.set({
      ...gitTask({ id: 'task-forge', projectId: 'proj' }),
      platformBinding: { mode: 'git', repoKey: 'github.com/owner/repo', tool: 'forge' },
    });

    const ids = (await manager.listTasksForPlatformEntry('proj')).map(t => t.id);
    expect(ids).toEqual(['task-forge']);
  });

  it('fail-closes on an offline-drifted binding that no longer matches the entry repo', async () => {
    manager.replaceConfig({ ...config, project: [
      { id: 'proj', repo: 'git@github.com:owner/repo.git', merge: null, agent: [] },
    ] });
    await taskStore.set({
      ...gitTask({ id: 'task-drift', projectId: 'proj' }),
      platformBinding: { mode: 'git', repoKey: 'github.com/owner/OLD-repo', tool: 'gh' },
    });
    await taskStore.set(gitTask({ id: 'task-current', projectId: 'proj' }));

    const ids = (await manager.listTasksForPlatformEntry('proj')).map(t => t.id);
    expect(ids).toEqual(['task-current']);
  });
});

describe('guardGitConfigCommit', () => {
  const noBlockers = async () => [];

  it('commits inside the task lock when the scan finds no blocker', async () => {
    const commit = vi.fn(async () => undefined);
    const result = await manager.guardGitConfigCommit(config, config, noBlockers, commit);
    expect(result).toEqual({ ok: true });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('never commits when the scan reports blockers, and hands them back', async () => {
    const commit = vi.fn(async () => undefined);
    const blockers = [{ projectId: 'proj', taskIds: ['task-1'] }];
    const result = await manager.guardGitConfigCommit(config, config, async () => blockers, commit);
    expect(result).toEqual({ ok: false, blockers });
    expect(commit).not.toHaveBeenCalled();
  });

  it('serializes the scan against a concurrent task write so a late task cannot slip past it', async () => {
    let scanned = false;
    const guarded = manager.guardGitConfigCommit(config, config, async (m) => {
      scanned = true;
      return (await m.listActiveGitTasks('proj')).map(t => ({ projectId: 'proj', taskIds: [t.id] }));
    }, async () => undefined);
    const concurrent = seed({ id: 'task-late-arrival' });

    const [result] = await Promise.all([guarded, concurrent]);

    expect(scanned).toBe(true);
    const active = await manager.listActiveGitTasks('proj');
    if (result.ok) expect(active.some(t => t.id === 'task-late-arrival')).toBe(true);
    else expect(result.blockers.length).toBeGreaterThan(0);
  });

  it('lets a commit failure surface instead of reporting success', async () => {
    await expect(manager.guardGitConfigCommit(config, config, noBlockers, async () => {
      throw new Error('disk gone');
    })).rejects.toThrow('disk gone');
  });
});
