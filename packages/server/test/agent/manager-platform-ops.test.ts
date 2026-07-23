import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BaxianConfig, TaskState } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
import {
  AgentManager, DispatchTerminalError, PlatformMergeRecheckError,
} from '../../src/agent/manager.js';
import { AgentStore } from '../../src/state/agent-store.js';
import { TaskStore } from '../../src/state/task-store.js';
import { LockManager } from '../../src/state/lock.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { initStateDir } from '../../src/state/init.js';
import type { GitDriver, OpVars } from '../../src/platform/git-driver.js';
import { DriverOpError } from '../../src/platform/git-driver.js';
import type { NormalizedRow } from '../../src/platform/row-schema.js';
import type { CommentSourceOp } from '../../src/platform/types.js';
import { buildAckMarker, buildReviewTokenLine } from '../../src/platform/markers.js';
import { sha256Hex } from '../../src/platform/body-digest.js';

const SHA1 = 'a'.repeat(40);
const TS = '2026-07-17T01:02:03Z';
const POST_APPROVE_GENERATION = 'feedfeedfeed';

const CONFIG: BaxianConfig = {
  review: { rounds: 2 },
  server: DEFAULT_SERVER_CONFIG,
  host: [],
  project: [{
    id: 'proj',
    repo: 'git@github.com:owner/repo.git',
    merge: null,
    agent: [[
      { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp/repo' },
      { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local', workdir: '/tmp/qa-repo' },
    ]],
  }],
};

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
  return {
    id: 'task-1', projectId: 'proj', title: 'T', description: 'd',
    preferredAgentId: 'dev-1', agentId: 'dev-1', devAgentId: 'dev-1', qaAgentId: 'qa-1',
    reviewRound: 1, status: 'merge-ready', createdAt: now, updatedAt: now,
    reviewMode: 'git', prNumber: 42, branch: 'bx/task-1', branchCreatedByBaxian: true,
    platformBinding: { mode: 'git', repoKey: 'github.com/owner/repo', tool: 'gh' },
    baseBranch: 'main', latestHeadSha: SHA1, reviewHeadAnchorSha: SHA1,
    replyActorId: '77', replyActorStatus: 'verified',
    passToken: 'abcdef123456', failToken: '123456abcdef',
    passProvenance: {
      sourceKey: 'reviews', id: 'r1', bodyDigest: 'f'.repeat(64), token: 'abcdef123456',
      failToken: '123456abcdef', anchorSha: SHA1,
    },
    ...over,
  };
}

let tempDir: string;
let agentStore: AgentStore;
let lockManager: LockManager;
let taskStore: TaskStore;
let manager: AgentManager;
let driver: FakeDriver;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'bx-mgr-platform-'));
  await initStateDir(tempDir);
  agentStore = new AgentStore(`${tempDir}/state/agents`);
  taskStore = new TaskStore(`${tempDir}/state/tasks`);
  lockManager = new LockManager(`${tempDir}/state`);
  const eventBus = new EventBus(new EventLog(`${tempDir}/events`));
  manager = new AgentManager({
    config: CONFIG,
    agentStore,
    taskStore,
    lockManager,
    eventBus,
  });
  driver = new FakeDriver();
  vi.spyOn(manager, 'platformDriverFor').mockReturnValue(driver as unknown as GitDriver);
  vi.spyOn(manager, 'effectiveReviewMode').mockReturnValue('git');
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

describe('manual server review dispatch', () => {
  function reviewDriver() {
    return {
      dispatchCodeReview: vi.fn().mockResolvedValue(true),
      dispatchSpecReview: vi.fn().mockResolvedValue(true),
    };
  }

  it('routes a server code review through the configured review driver', async () => {
    await seed({
      reviewMode: 'server', status: 'review', prNumber: undefined, prUrl: undefined,
      platformBinding: undefined, baseBranch: undefined,
    });
    const review = reviewDriver();
    manager.setServerReviewDriver(review);

    const result = await manager.dispatchReviewToQa('task-1');

    expect(review.dispatchCodeReview).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1' }));
    expect(review.dispatchSpecReview).not.toHaveBeenCalled();
    expect(result.id).toBe('task-1');
  });

  it('routes a git task in the spec phase through the server-side spec driver', async () => {
    await seed({ phase: 'spec', status: 'review', specReviewRound: 1 });
    const review = reviewDriver();
    manager.setServerReviewDriver(review);

    await manager.dispatchReviewToQa('task-1');

    expect(review.dispatchSpecReview).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1' }));
    expect(review.dispatchCodeReview).not.toHaveBeenCalled();
  });

  it('rejects a manual review when its snapshotted QA is absent', async () => {
    await seed({
      reviewMode: 'server', status: 'review', qaAgentId: undefined,
      prNumber: undefined, prUrl: undefined, platformBinding: undefined, baseBranch: undefined,
    });
    const review = reviewDriver();
    manager.setServerReviewDriver(review);

    await expect(manager.dispatchReviewToQa('task-1')).rejects.toMatchObject({ status: 400 });
    expect(review.dispatchCodeReview).not.toHaveBeenCalled();
  });
});

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
  it('accepts a bound open PR and reports head, branch, and target', async () => {
    await seed();
    await expect(manager.platformVerifyPrBinding('task-1', 42)).resolves.toEqual({
      ok: true, headSha: SHA1, branch: 'bx/task-1', targetBranch: 'main',
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
    const missingConfigManager = new AgentManager({
      config: { ...CONFIG, project: [] },
      agentStore,
      taskStore,
      lockManager,
      eventBus: new EventBus(new EventLog(`${tempDir}/events`)),
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
    const auditFailureManager = new AgentManager({
      config: CONFIG,
      agentStore,
      taskStore,
      lockManager,
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
    const restarted = new AgentManager({
      config: CONFIG,
      agentStore: new AgentStore(`${tempDir}/state/agents`),
      taskStore,
      lockManager: new LockManager(`${tempDir}/state`),
      eventBus: new EventBus(new EventLog(`${tempDir}/events-restarted`)),
    });
    vi.spyOn(restarted, 'platformDriverFor').mockReturnValue(driver as unknown as GitDriver);
    vi.spyOn(restarted, 'effectiveReviewMode').mockReturnValue('git');

    await restarted.retryGitRemoteCleanupIntents();

    expect((await taskStore.get('task-1'))?.remoteCleanup).toBeUndefined();
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

    await expect(manager.dispatchReviewToQa('task-1')).rejects.toMatchObject({
      status: 409, code: 'dispatch-superseded',
    });

    expect(await taskStore.get('task-1')).toMatchObject({
      status: 'review', phase: 'code', signalToken: 'manual-git-successor',
    });
    expect((await taskStore.get('task-1'))?.reviewDispatch).toBeUndefined();
    expect(dispatchSpy).not.toHaveBeenCalled();
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

describe('third review round: merge gate integrity', () => {
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
      ...CONFIG,
      project: [{ ...CONFIG.project[0], gitCli: { tool: 'gh', notes: 'runs behind :8443' } }],
    });
    expect(manager.platformCliContextOf(gitTask())?.notes).toBe('runs behind :8443');
  });

  it('returns undefined for server tasks and fails loud when the identity drifted away', () => {
    expect(manager.platformCliContextOf(gitTask({ reviewMode: 'server' }))).toBeUndefined();
    manager.replaceConfig({
      ...CONFIG,
      project: [{
        ...CONFIG.project[0],
        repo: 'https://git.corp.example.com/g/p.git',
        review: { mode: 'server' },
      }],
    });
    expect(() => manager.platformCliContextOf(gitTask())).toThrow(/platform binding mismatch/);
  });
});

describe('ensureGitBaseSnapshot', () => {
  function managerWithBaseSource(source?: (projectId: string) => string | undefined): AgentManager {
    const m = new AgentManager({
      config: CONFIG,
      agentStore: new AgentStore(`${tempDir}/state/agents`),
      taskStore,
      lockManager: new LockManager(`${tempDir}/state`),
      eventBus: new EventBus(new EventLog(`${tempDir}/events`)),
      ...(source ? { platformDefaultBranchOf: source } : {}),
    });
    vi.spyOn(m, 'effectiveReviewMode').mockReturnValue('git');
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

  it('stays inert without a source, outside develop/code, and for server tasks', async () => {
    const task = await seed({ baseBranch: undefined });
    expect((await manager.ensureGitBaseSnapshot(task, 'develop')).baseBranch).toBeUndefined();
    const m = managerWithBaseSource(() => 'main');
    expect((await m.ensureGitBaseSnapshot(task, 'review')).baseBranch).toBeUndefined();
    expect((await m.ensureGitBaseSnapshot({ ...task, reviewMode: 'server' }, 'develop')).baseBranch)
      .toBeUndefined();
    expect((await taskStore.get('task-1'))?.baseBranch).toBeUndefined();
  });
});

describe('ensureGitBaseSnapshot binding guard', () => {
  it('refuses to persist a base from a drifted project and leaves the task untouched', async () => {
    const m = new AgentManager({
      config: CONFIG,
      agentStore: new AgentStore(`${tempDir}/state/agents`),
      taskStore,
      lockManager: new LockManager(`${tempDir}/state`),
      eventBus: new EventBus(new EventLog(`${tempDir}/events`)),
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
});

describe('noteReviewConversationRevision', () => {
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

  it('returns undefined without a plugin registry or outside git mode', () => {
    expect(manager.agentGitPreflightContext('proj')).toBeUndefined();
    (manager as unknown as { pluginRegistry: unknown }).pluginRegistry = { resolveTool: () => undefined };
    expect(manager.agentGitPreflightContext('proj')).toBeUndefined();
    vi.mocked(manager.effectiveReviewMode).mockReturnValue('server');
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

describe('config lock scope and afterDone late binding', () => {
  it('covers a server task that already bound its identity, and skips one that has not', async () => {
    await seed({ id: 'task-git' });
    await taskStore.set({
      ...gitTask({ id: 'task-srv-bound' }),
      reviewMode: 'server',
      afterDone: 'pr',
      platformBinding: { mode: 'server', repoKey: 'github.com/owner/repo', tool: 'gh' },
    });
    await taskStore.set({
      ...gitTask({ id: 'task-srv-open' }),
      reviewMode: 'server',
      platformBinding: undefined,
    });

    const active = await manager.listActiveGitTasks('proj');
    expect(active.map(t => t.id).sort()).toEqual(['task-git', 'task-srv-bound']);
  });

  it('fails the safety-critical config-lock scan when any task file is unreadable', async () => {
    await seed({ id: 'task-git' });
    await writeFile(join(tempDir, 'state', 'tasks', 'task-corrupt.json'), '{ not json', 'utf-8');

    await expect(manager.listActiveGitTasks('proj')).rejects.toBeInstanceOf(SyntaxError);
  });

  it('fails the platform-entry task provider when any sibling task file is unreadable', async () => {
    await seed({ id: 'task-git' });
    await writeFile(join(tempDir, 'state', 'tasks', 'task-corrupt.json'), '{ not json', 'utf-8');

    await expect(manager.listTasksForPlatformEntry('proj')).rejects.toBeInstanceOf(SyntaxError);
  });

  it('drops a bound server task from the lock scope once it reaches a terminal status', async () => {
    await taskStore.set({
      ...gitTask({ id: 'task-srv-done' }),
      reviewMode: 'server',
      status: 'done',
      afterDone: 'pr',
      platformBinding: { mode: 'server', repoKey: 'github.com/owner/repo', tool: 'gh' },
    });
    expect(await manager.listActiveGitTasks('proj')).toEqual([]);
  });

  it('keeps a terminal git task in the config lock while remote cleanup is pending', async () => {
    await taskStore.set(gitTask({
      status: 'cancelled',
      remoteCleanup: {
        generation: 'abc123abc123', stage: 'close-pending', prNumber: 42,
        branch: 'bx/task-1', expectedHeadSha: SHA1, updatedAt: TS,
      },
    }));
    expect((await manager.listActiveGitTasks('proj')).map(task => task.id)).toEqual(['task-1']);
  });

  it('releases the config lock once remote cleanup is explicitly manual', async () => {
    await taskStore.set(gitTask({
      status: 'cancelled',
      remoteCleanup: {
        generation: 'abc123abc123', stage: 'manual', prNumber: 42,
        branch: 'bx/task-1', expectedHeadSha: SHA1, updatedAt: TS,
        failure: { kind: 'binding', message: 'operator required', at: TS },
      },
    }));
    expect(await manager.listActiveGitTasks('proj')).toEqual([]);
  });

  it('commits the resolved afterDone and the identity trio in a single write', async () => {
    await taskStore.set({
      ...gitTask({ id: 'task-late' }),
      reviewMode: 'server',
      status: 'approved',
      afterDone: undefined,
      platformBinding: undefined,
    });
    manager.replaceConfig({ ...CONFIG, review: { rounds: 2, mode: 'server', afterDone: 'pr' } });
    vi.spyOn(manager, 'effectiveReviewMode').mockReturnValue('server');
    const writes: Array<Partial<TaskState>> = [];
    const original = taskStore.set.bind(taskStore);
    vi.spyOn(taskStore, 'set').mockImplementation(async (t) => {
      writes.push({ afterDone: t.afterDone, platformBinding: t.platformBinding });
      return original(t);
    });
    vi.spyOn(manager, 'findLineageViolation').mockResolvedValue(null);
    vi.spyOn(manager, 'continueSession').mockResolvedValue(true);

    await manager.dispatchServerAfterDone('task-late', 'pr');

    const bindingWrite = writes.find(w => w.platformBinding !== undefined);
    expect(bindingWrite).toEqual({
      afterDone: 'pr',
      platformBinding: { mode: 'server', repoKey: 'github.com/owner/repo', tool: 'gh' },
    });
    expect(writes.filter(w => w.afterDone === 'pr' && w.platformBinding === undefined)).toEqual([]);
  });

  it('markTaskComplete binds the identity before dispatch (no afterDone-only window)', async () => {
    await taskStore.set({
      ...gitTask({ id: 'task-mc' }),
      reviewMode: 'server',
      status: 'max_rounds',
      afterDone: undefined,
      platformBinding: undefined,
    });
    manager.replaceConfig({ ...CONFIG, review: { rounds: 2, mode: 'server', afterDone: 'pr' } });
    vi.spyOn(manager, 'effectiveReviewMode').mockReturnValue('server');
    vi.spyOn(manager, 'transitionTaskStatus').mockResolvedValue(true);
    const commitSpy = vi.spyOn(manager, 'commitServerAfterDone');
    const dispatchSpy = vi.spyOn(manager, 'dispatchServerAfterDone').mockResolvedValue(undefined as never);
    const updateSpy = vi.spyOn(manager, 'updateTask');

    await manager.markTaskComplete('task-mc');

    // 走 commitServerAfterDone 漏斗:binding 与 afterDone 同一次写,dispatch 之前落盘
    expect(commitSpy).toHaveBeenCalledWith('task-mc');
    expect(dispatchSpy).toHaveBeenCalledWith('task-mc', 'pr');
    // 旧的两段写（updateTask 单写 afterDone）已消除
    expect(updateSpy.mock.calls.some(c => c[1] && Object.keys(c[1]).length === 1 && 'afterDone' in (c[1] as object))).toBe(false);
    const after = await taskStore.get('task-mc');
    expect(after?.platformBinding).toEqual({ mode: 'server', repoKey: 'github.com/owner/repo', tool: 'gh' });
  });

  it('binds on the auto-approve path too, not only on mark-complete', async () => {
    await taskStore.set({
      ...gitTask({ id: 'task-auto' }),
      reviewMode: 'server',
      status: 'approved',
      afterDone: undefined,
      platformBinding: undefined,
    });
    manager.replaceConfig({ ...CONFIG, review: { rounds: 2, mode: 'server', afterDone: 'pr' } });
    vi.spyOn(manager, 'effectiveReviewMode').mockReturnValue('server');
    vi.spyOn(manager, 'findLineageViolation').mockResolvedValue(null);
    vi.spyOn(manager, 'continueSession').mockResolvedValue(true);

    await manager.dispatchServerAfterDone('task-auto', 'pr');

    const after = await taskStore.get('task-auto');
    expect(after?.afterDone).toBe('pr');
    expect(after?.platformBinding).toEqual({ mode: 'server', repoKey: 'github.com/owner/repo', tool: 'gh' });
  });

  it('commitServerAfterDone is idempotent and never rewrites a matching existing binding', async () => {
    await taskStore.set({
      ...gitTask({ id: 'task-idem' }),
      reviewMode: 'server',
      status: 'approved',
      afterDone: 'pr',
      platformBinding: { mode: 'server', repoKey: 'github.com/owner/repo', tool: 'gh' },
    });
    manager.replaceConfig({ ...CONFIG, review: { rounds: 2, mode: 'server', afterDone: 'pr' } });
    vi.spyOn(manager, 'effectiveReviewMode').mockReturnValue('server');
    const setSpy = vi.spyOn(taskStore, 'set');

    const afterDone = await manager.commitServerAfterDone('task-idem');

    expect(afterDone).toBe('pr');
    expect(setSpy).not.toHaveBeenCalled();
    expect((await taskStore.get('task-idem'))?.platformBinding).toEqual(
      { mode: 'server', repoKey: 'github.com/owner/repo', tool: 'gh' });
  });

  it('refuses a resolved server PR task whose live platform identity drifted', async () => {
    await taskStore.set({
      ...gitTask({ id: 'task-drifted' }),
      reviewMode: 'server',
      status: 'approved',
      afterDone: 'pr',
      platformBinding: { mode: 'server', repoKey: 'github.com/frozen/repo', tool: 'gh' },
      baseBranch: undefined,
    });
    manager.replaceConfig({ ...CONFIG, review: { rounds: 2, mode: 'server', afterDone: 'pr' } });
    const setSpy = vi.spyOn(taskStore, 'set');

    await expect(manager.commitServerAfterDone('task-drifted')).rejects.toThrow(/platform binding mismatch/);

    expect(setSpy).not.toHaveBeenCalled();
    expect((await taskStore.get('task-drifted'))?.baseBranch).toBeUndefined();
  });

  it('refuses an already-resolved PR task whose binding snapshot is missing', async () => {
    const invalid = {
      ...gitTask({ id: 'task-orphan', projectId: 'gone' }),
      reviewMode: 'server',
      status: 'approved',
      afterDone: 'pr',
      platformBinding: undefined,
      baseBranch: undefined,
    } as TaskState;
    vi.spyOn(taskStore, 'get').mockResolvedValueOnce(invalid);
    const setSpy = vi.spyOn(taskStore, 'set');

    await expect(manager.commitServerAfterDone('task-orphan')).rejects.toThrow(
      /binding missing.*refusing to reconstruct it from live config/,
    );

    expect(setSpy).not.toHaveBeenCalled();
  });

  it('snapshots the cached platform default branch together with server PR publication', async () => {
    await taskStore.set({
      ...gitTask({ id: 'task-base' }),
      reviewMode: 'server',
      status: 'approved',
      afterDone: undefined,
      platformBinding: undefined,
      baseBranch: undefined,
    });
    const serverConfig: BaxianConfig = {
      ...CONFIG,
      review: { rounds: 2, mode: 'server', afterDone: 'pr' },
    };
    const withBase = new AgentManager({
      config: serverConfig,
      agentStore,
      taskStore,
      lockManager: new LockManager(`${tempDir}/state/base-locks`),
      eventBus: new EventBus(new EventLog(`${tempDir}/events-base`)),
      platformDefaultBranchOf: () => 'trunk',
    });

    await withBase.commitServerAfterDone('task-base');

    expect(await taskStore.get('task-base')).toMatchObject({
      afterDone: 'pr',
      baseBranch: 'trunk',
      platformBinding: { mode: 'server', repoKey: 'github.com/owner/repo', tool: 'gh' },
    });
  });

  it('makes the binding visible to the config-lock scan the moment afterDone becomes pr', async () => {
    await taskStore.set({
      ...gitTask({ id: 'task-window' }),
      reviewMode: 'server',
      status: 'approved',
      afterDone: undefined,
      platformBinding: undefined,
    });
    manager.replaceConfig({ ...CONFIG, review: { rounds: 2, mode: 'server', afterDone: 'pr' } });
    vi.spyOn(manager, 'effectiveReviewMode').mockReturnValue('server');

    // approve→dispatch 窗口内没有单独的「afterDone 已写、binding 未写」中间态：
    // commitServerAfterDone 之后任务即进入锁范围
    expect(await manager.listActiveGitTasks('proj')).toEqual([]);
    await manager.commitServerAfterDone('task-window');
    expect((await manager.listActiveGitTasks('proj')).map(t => t.id)).toEqual(['task-window']);
  });

  it('binds nothing when the resolved afterDone only pushes a branch', async () => {
    await taskStore.set({
      ...gitTask({ id: 'task-late-branch' }),
      reviewMode: 'server',
      status: 'approved',
      afterDone: undefined,
      platformBinding: undefined,
    });
    manager.replaceConfig({ ...CONFIG, review: { rounds: 2, mode: 'server', afterDone: 'branch' } });
    vi.spyOn(manager, 'effectiveReviewMode').mockReturnValue('server');
    vi.spyOn(manager, 'findLineageViolation').mockResolvedValue(null);
    vi.spyOn(manager, 'continueSession').mockResolvedValue(true);

    await manager.dispatchServerAfterDone('task-late-branch', 'branch');

    const after = await taskStore.get('task-late-branch');
    expect(after?.afterDone).toBe('branch');
    expect(after?.platformBinding).toBeUndefined();
  });
});

describe('server PR adoption', () => {
  it('persists the discovered PR identity without changing the server review state', async () => {
    await seed({
      reviewMode: 'server', status: 'approved', afterDone: 'pr',
      prNumber: undefined, prUrl: undefined, latestHeadSha: undefined, baseBranch: undefined,
      platformBinding: { mode: 'server', repoKey: 'github.com/owner/repo', tool: 'gh' },
    });

    const adopted = await manager.adoptServerPr('task-1', {
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      headSha: SHA1,
      targetBranch: 'main',
    });

    expect(adopted).toBe(true);
    expect(await taskStore.get('task-1')).toMatchObject({
      reviewMode: 'server', status: 'approved', prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42', latestHeadSha: SHA1, baseBranch: 'main',
    });
  });

  it('refuses to replace an already bound PR number', async () => {
    await seed({
      reviewMode: 'server', status: 'approved', afterDone: 'pr', prNumber: 41,
      platformBinding: { mode: 'server', repoKey: 'github.com/owner/repo', tool: 'gh' },
    });
    const before = await taskStore.get('task-1');

    expect(await manager.adoptServerPr('task-1', { prNumber: 42 })).toBe(false);
    expect(await taskStore.get('task-1')).toEqual(before);
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

describe('listTasksForPlatformEntry (one entry serves the whole repo)', () => {
  it('aggregates tasks from every project sharing the entry repo identity', async () => {
    manager.replaceConfig({
      ...CONFIG,
      review: { rounds: 2, mode: 'server', afterDone: 'branch' },
      project: [
        { id: 'proj', repo: 'git@github.com:owner/repo.git', merge: null, agent: [] },
        { id: 'proj-b', repo: 'https://github.com/owner/repo.git', merge: null, agent: [] },
      ],
    });
    await taskStore.set(gitTask({ id: 'task-a', projectId: 'proj' }));
    await taskStore.set(gitTask({ id: 'task-b', projectId: 'proj-b' }));

    // 不管 entry claim 的是 proj 还是 proj-b,provider 都覆盖两者——retained/live 遮蔽不丢轮询
    const viaA = (await manager.listTasksForPlatformEntry('proj')).map(t => t.id).sort();
    const viaB = (await manager.listTasksForPlatformEntry('proj-b')).map(t => t.id).sort();
    expect(viaA).toEqual(['task-a', 'task-b']);
    expect(viaB).toEqual(['task-a', 'task-b']);
  });

  it('reads the task directory once while aggregating sibling projects', async () => {
    manager.replaceConfig({
      ...CONFIG,
      review: { rounds: 2, mode: 'server', afterDone: 'branch' },
      project: [
        { id: 'proj', repo: 'git@github.com:owner/repo.git', merge: null, agent: [] },
        { id: 'proj-b', repo: 'https://github.com/owner/repo.git', merge: null, agent: [] },
      ],
    });
    await taskStore.set(gitTask({ id: 'task-a', projectId: 'proj' }));
    await taskStore.set(gitTask({ id: 'task-b', projectId: 'proj-b' }));
    const list = vi.spyOn(taskStore, 'listStrict');

    expect((await manager.listTasksForPlatformEntry('proj')).map(task => task.id).sort())
      .toEqual(['task-a', 'task-b']);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith();
  });

  it('returns nothing for an unknown entry project id', async () => {
    expect(await manager.listTasksForPlatformEntry('ghost')).toEqual([]);
  });

  it('excludes tasks whose project is no longer present even when their binding matches the live entry', async () => {
    await taskStore.set(gitTask({ id: 'task-live', projectId: 'proj' }));
    await taskStore.set(gitTask({ id: 'task-offline', projectId: 'removed-project' }));

    expect((await manager.listTasksForPlatformEntry('proj')).map(task => task.id)).toEqual(['task-live']);
  });

  it('fail-closes on tasks without a binding (server+branch never enters PR lifecycle)', async () => {
    manager.replaceConfig({
      ...CONFIG,
      review: { rounds: 2, mode: 'server', afterDone: 'branch' },
      project: [
        { id: 'proj', repo: 'git@github.com:owner/repo.git', merge: null, agent: [] },
        { id: 'proj-b', repo: 'https://github.com/owner/repo.git', merge: null, agent: [] },
      ],
    });
    // proj 有一个正常绑定的 git 任务;proj-b 是 server+branch,任务无 binding
    await taskStore.set(gitTask({ id: 'task-bound', projectId: 'proj' }));
    await taskStore.set({ ...gitTask({ id: 'task-unbound', projectId: 'proj-b' }), reviewMode: 'server', platformBinding: undefined });

    const ids = (await manager.listTasksForPlatformEntry('proj')).map(t => t.id);
    expect(ids).toEqual(['task-bound']);
  });

  it('fail-closes on a tool drift (gh→forge) even when repoKey still matches', async () => {
    manager.replaceConfig({ ...CONFIG, project: [
      { id: 'proj', repo: 'https://github.com/owner/repo.git', merge: null, review: { mode: 'git' },
        gitCli: { tool: 'forge' }, agent: [] },
    ] });
    // 任务 binding tool=gh,项目离线改成 forge:旧 gh 任务不得落到 forge entry/driver 上
    await taskStore.set(gitTask({ id: 'task-gh', projectId: 'proj' }));
    await taskStore.set({
      ...gitTask({ id: 'task-forge', projectId: 'proj' }),
      platformBinding: { mode: 'git', repoKey: 'github.com/owner/repo', tool: 'forge' },
    });

    const ids = (await manager.listTasksForPlatformEntry('proj')).map(t => t.id);
    expect(ids).toEqual(['task-forge']);
  });

  it('fail-closes on a mode drift even when repo and tool still match', async () => {
    manager.replaceConfig({ ...CONFIG, review: { rounds: 2, mode: 'server', afterDone: 'pr' }, project: [
      { id: 'proj', repo: 'https://github.com/owner/repo.git', merge: null, review: { mode: 'server' }, agent: [] },
    ] });
    vi.spyOn(manager, 'effectiveReviewMode').mockReturnValue('server');
    // 项目现为 server(entry 身份 mode=server),旧 git 任务 binding.mode=git 不匹配
    await taskStore.set(gitTask({ id: 'task-git-mode', projectId: 'proj' }));
    await taskStore.set({
      ...gitTask({ id: 'task-server-mode', projectId: 'proj' }),
      platformBinding: { mode: 'server', repoKey: 'github.com/owner/repo', tool: 'gh' },
    });

    const ids = (await manager.listTasksForPlatformEntry('proj')).map(t => t.id);
    expect(ids).toEqual(['task-server-mode']);
  });

  it('fail-closes on an offline-drifted binding that no longer matches the entry repo', async () => {
    manager.replaceConfig({ ...CONFIG, project: [
      { id: 'proj', repo: 'git@github.com:owner/repo.git', merge: null, review: { mode: 'git' }, agent: [] },
    ] });
    // 任务的 binding 指向旧仓库(离线把 repo 改了),不得被交给新仓库的 driver
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
    const result = await manager.guardGitConfigCommit(CONFIG, CONFIG, noBlockers, commit);
    expect(result).toEqual({ ok: true });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('never commits when the scan reports blockers, and hands them back', async () => {
    const commit = vi.fn(async () => undefined);
    const blockers = [{ projectId: 'proj', taskIds: ['task-1'] }];
    const result = await manager.guardGitConfigCommit(CONFIG, CONFIG, async () => blockers, commit);
    expect(result).toEqual({ ok: false, blockers });
    expect(commit).not.toHaveBeenCalled();
  });

  it('serializes the scan against a concurrent task write so a late task cannot slip past it', async () => {
    let scanned = false;
    const guarded = manager.guardGitConfigCommit(CONFIG, CONFIG, async (m) => {
      scanned = true;
      return (await m.listActiveGitTasks('proj')).map(t => ({ projectId: 'proj', taskIds: [t.id] }));
    }, async () => undefined);
    const concurrent = seed({ id: 'task-late-arrival' });

    const [result] = await Promise.all([guarded, concurrent]);

    expect(scanned).toBe(true);
    // 两者共用任务锁：任一顺序都合法，但绝不能出现「扫描看不见却已落盘」的中间态
    const active = await manager.listActiveGitTasks('proj');
    if (result.ok) expect(active.some(t => t.id === 'task-late-arrival')).toBe(true);
    else expect(result.blockers.length).toBeGreaterThan(0);
  });

  it('lets a commit failure surface instead of reporting success', async () => {
    await expect(manager.guardGitConfigCommit(CONFIG, CONFIG, noBlockers, async () => {
      throw new Error('disk gone');
    })).rejects.toThrow('disk gone');
  });
});
