import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BaxianConfig, TaskState } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
import { AgentManager } from '../../src/agent/manager.js';
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
      return [{ defaultBranch: this.defaultBranch }];
    }
    if (opName === 'merge') {
      if (this.mergeError) throw this.mergeError;
      return [];
    }
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
let taskStore: TaskStore;
let manager: AgentManager;
let driver: FakeDriver;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'bx-mgr-platform-'));
  await initStateDir(tempDir);
  const agentStore = new AgentStore(`${tempDir}/state/agents`);
  taskStore = new TaskStore(`${tempDir}/state/tasks`);
  const eventBus = new EventBus(new EventLog(`${tempDir}/events`));
  manager = new AgentManager({
    config: CONFIG,
    agentStore,
    taskStore,
    lockManager: new LockManager(`${tempDir}/state`),
    eventBus,
  });
  driver = new FakeDriver();
  vi.spyOn(manager, 'platformDriverFor').mockReturnValue(driver as unknown as GitDriver);
  vi.spyOn(manager, 'effectiveReviewMode').mockReturnValue('git');
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function seed(over: Partial<TaskState> = {}): Promise<TaskState> {
  const task = gitTask(over);
  await taskStore.set(task);
  return task;
}

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
    await expect(manager.platformVerifyPrBinding('task-1', 42)).resolves.toEqual({ ok: false, reason: 'unverifiable' });
  });
});

describe('platformClosePr', () => {
  it('closes without a comment op and deletes only a provably baxian-owned branch', async () => {
    await seed();
    await manager.platformClosePr('task-1', { deleteBranch: true });
    expect(driver.ops.map(o => o.op)).toEqual(['close', 'deleteBranch']);
    expect(driver.ops[1]!.vars).toEqual({ branch: 'bx/task-1' });
  });

  it('keeps a user-owned branch: custom name or missing flag both skip deletion', async () => {
    await seed({ branch: 'feat/custom', branchCreatedByBaxian: false });
    await manager.platformClosePr('task-1', { deleteBranch: true });
    expect(driver.ops.map(o => o.op)).toEqual(['close']);

    driver.ops = [];
    await seed({ branch: 'feat/custom', branchCreatedByBaxian: true });
    await manager.platformClosePr('task-1', { deleteBranch: true });
    expect(driver.ops.map(o => o.op)).toEqual(['close']);
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
  it('set/get/complete round-trip lives entirely on the task record', async () => {
    await seed({ status: 'approved', postApproveHeadSha: SHA1 });
    expect(await manager.setPostApproveCompletion('task-1', { token: 'tok123456789', approvedHeadSha: SHA1 }))
      .toBe(true);
    const task = await taskStore.get('task-1');
    expect(task?.postApproveToken).toBe('tok123456789');
    expect(await manager.getPostApproveCompletion('task-1')).toMatchObject({
      token: 'tok123456789', approvedHeadSha: SHA1,
    });

    const completed = await manager.completeApprovedPassToMergeReady('task-1', 'tok123456789');
    expect('task' in completed && completed.task.status).toBe('merge-ready');
    const after = await taskStore.get('task-1');
    expect(after?.postApproveToken).toBeUndefined();
    expect(after?.postApproveHeadSha).toBeUndefined();
    expect(await manager.getPostApproveCompletion('task-1')).toBeNull();
  });

  it('token CAS writes pending, count, and the consumed revision in one durable update', async () => {
    await seed({ status: 'approved', postApproveHeadSha: SHA1, postApproveToken: 'tok123456789' });
    const ok = await manager.updatePostApproveCompletionIfToken('task-1', 'tok123456789', {
      pendingRedispatch: true,
    }, { consumeRevision: { key: 'issue-comments:c1:aa', versionTime: 1700 } });
    expect(ok).toBe(true);
    const task = await taskStore.get('task-1');
    expect(task?.pendingRedispatch).toBe(true);
    expect(task?.consumedFeedback).toEqual({ 'issue-comments:c1:aa': 1700 });
    expect(await manager.updatePostApproveCompletionIfToken('task-1', 'wrong0000000', { pendingRedispatch: false }))
      .toBe(false);
  });

  it('revoke strips the completion and stamps the marker in a single write', async () => {
    await seed({
      status: 'approved', postApproveHeadSha: SHA1, postApproveToken: 'tok123456789',
      pendingRedispatch: true, redispatchCount: 2,
    });
    expect(await manager.revokePostApproveCompletion('task-1', 'redispatch-cap', { expectedToken: 'tok123456789' }))
      .toBe(true);
    const task = await taskStore.get('task-1');
    expect(task?.postApproveRevoked?.reason).toBe('redispatch-cap');
    expect(task?.postApproveToken).toBeUndefined();
    expect(task?.pendingRedispatch).toBeUndefined();
    expect(task?.redispatchCount).toBeUndefined();
  });

  it('a fresh set clears leftover pending state like the store replacement it mirrors', async () => {
    await seed({
      status: 'approved', postApproveHeadSha: SHA1, postApproveToken: 'oldtok123456',
      pendingRedispatch: true, redispatchCount: 3,
    });
    await manager.setPostApproveCompletion('task-1', {
      token: 'newtok123456', approvedHeadSha: SHA1, redispatchCount: 4,
    });
    const task = await taskStore.get('task-1');
    expect(task?.postApproveToken).toBe('newtok123456');
    expect(task?.pendingRedispatch).toBeUndefined();
    expect(task?.redispatchCount).toBe(4);
  });

  it('returnMergeReadyToApproved re-enters post-approve with the consumed key in the same write', async () => {
    await seed({ status: 'merge-ready', latestHeadSha: SHA1 });
    const returned = await manager.returnMergeReadyToApproved('task-1', {
      key: 'issue-comments:c9:bb', versionTime: 1800,
    });
    expect(returned?.status).toBe('approved');
    expect(returned?.postApproveHeadSha).toBe(SHA1);
    expect(returned?.consumedFeedback).toEqual({ 'issue-comments:c9:bb': 1800 });
    expect(await manager.returnMergeReadyToApproved('task-1', { key: 'x:y:z', versionTime: 1 })).toBeNull();
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
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    driver.prView = new Error('HTTP 502');
    const release = vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    await expect(manager.dispatchReviewToQa('task-1')).rejects.toMatchObject({ status: 502 });
    expect(release).toHaveBeenCalledWith('qa-1', 'task-1', 'idle', expect.any(Object));
    expect(driver.ops.some(o => o.op === 'merge')).toBe(false);
  });
});

describe('git reconciliation watcher rearm on verdict arm', () => {
  it('re-arms the dev pr-created entry after each QA verdict arm while the actor is provisional', async () => {
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
    await manager.rotateAndSetupPhaseSignal('task-1', 'qa-1', ['pr-approved', 'pr-changes-requested']);
    expect(armCalls).toHaveLength(2);
    expect(armCalls[1]).toMatchObject({ agentId: 'dev-1', token: 'aaaa11112222' });

    armCalls.length = 0;
    await taskStore.set({ ...(await taskStore.get('task-1'))!, replyActorStatus: 'verified', updatedAt: new Date().toISOString() });
    await manager.rotateAndSetupPhaseSignal('task-1', 'qa-1', ['pr-approved', 'pr-changes-requested']);
    expect(armCalls).toHaveLength(1);
  });
});

describe('manual dispatch binding recheck', () => {
  it('refuses to dispatch a git review onto a PR that fails the binding predicate', async () => {
    await seed({ status: 'review', signalToken: 'ffff00001111', reviewRound: 1 });
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
    driver.prView = prRow({ draft: true });
    const release = vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    await expect(manager.dispatchReviewToQa('task-1')).rejects.toMatchObject({
      status: 409, message: expect.stringContaining('binding draft'),
    });
    expect(release).toHaveBeenCalledWith('qa-1', 'task-1', 'idle', expect.any(Object));
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
    await seed({ passProvenance: provenanceFor(body), status: 'approved', pendingRedispatch: true });
    seedAcceptedPass();
    await expect(manager.platformConfirmMerge('task-1', { expectedHeadSha: SHA1 }))
      .rejects.toThrow(/left its merge gate/);
    expect(driver.ops.some(o => o.op === 'merge')).toBe(false);
  });

  it('retries only the remote branch deletion after a partially failed cancel cleanup', async () => {
    await seed({
      status: 'cancelled',
      branchCleanupPending: { agentId: 'dev-1', reason: 'remote-delete-failed', updatedAt: TS },
    });
    await manager.retryGitRemoteBranchCleanup();
    expect(driver.ops.map(o => o.op)).toEqual(['deleteBranch']);
    expect((await taskStore.get('task-1'))?.branchCleanupPending).toBeUndefined();
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
