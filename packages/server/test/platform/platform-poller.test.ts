import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PlatformPoller, type PlatformTaskView,
} from '../../src/platform/platform-poller.js';
import { platformPollerStatePath, CommentCursorStore } from '../../src/platform/comment-cursor.js';
import {
  DriverOpError,
  type CommentSource,
  type PlatformEvent,
  type PlatformDriver,
} from '../../src/platform/types.js';
import type { NormalizedRow } from '../../src/platform/row-schema.js';
import { buildReviewTokenLine, buildAckMarker } from '../../src/platform/markers.js';
import { bodyDigest } from '../../src/platform/body-digest.js';
import { repoIdentityKey } from '../../src/shared/git-url.js';

const REPO = 'https://github.com/owner/repo';
const SHA1 = '1'.repeat(40);
const SHA2 = '2'.repeat(40);
const ANCHOR = SHA1;
const PASS = 'aaaaaaaaaaaa';
const FAIL = 'bbbbbbbbbbbb';
const T0 = Date.parse('2026-07-17T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const OLD_TS = iso(T0 - 120_000);

const SOURCES: CommentSource[] = [
  { key: 'issue-comments', category: 'top-level' },
  { key: 'inline-comments', category: 'threaded' },
  { key: 'reviews', category: 'reviews' },
];

const prRow = (over: Partial<Record<string, unknown>> = {}): NormalizedRow => ({
  prNumber: 42, prUrl: 'https://github.com/owner/repo/pull/42', branch: 'bx/task-1',
  headSha: SHA1, state: 'open', draft: false, mergedAt: null, updatedAt: OLD_TS,
  sourceProjectId: '7', targetProjectId: '7', targetBranch: 'main', ...over,
});

const comment = (id: string, body: string, ts: string = OLD_TS, extra: Record<string, unknown> = {}): NormalizedRow =>
  ({ id, body, createdAt: ts, updatedAt: ts, ...extra });

class FakeDriver implements PlatformDriver {
  visibilityLagMs = 5000;
  commentSources = SOURCES;
  defaultBranch: string | (() => string) = 'main';
  projectViewExtra: Record<string, unknown> = { pushPermitted: true };
  projectViewError?: Error;
  listPrsRows: NormalizedRow[] = [];
  listPrsPages?: NormalizedRow[][];
  pagesFetched = 0;
  listPrsError?: Error;
  prViews = new Map<number, NormalizedRow | Error>();
  prViewSeq = new Map<number, NormalizedRow[]>();
  comments: Record<string, NormalizedRow[] | Error> = {};
  calls: string[] = [];

  async runPreflightSteps(): Promise<Array<{ step: string; ok: boolean; message: string }>> {
    return [];
  }

  async projectView(): Promise<NormalizedRow> {
    this.calls.push('projectView');
    if (this.projectViewError) throw this.projectViewError;
    const value = typeof this.defaultBranch === 'function' ? this.defaultBranch() : this.defaultBranch;
    return { defaultBranch: value, ...this.projectViewExtra };
  }

  async prView(prNumber: number): Promise<NormalizedRow> {
    this.calls.push('prView');
    const seq = this.prViewSeq.get(prNumber);
    if (seq !== undefined && seq.length > 0) return seq.shift()!;
    const row = this.prViews.get(prNumber);
    if (row === undefined) throw new Error(`no prView fixture for #${prNumber}`);
    if (row instanceof Error) throw row;
    return row;
  }

  async listPrs(
    shouldStop?: (pageRows: NormalizedRow[], page: number) => boolean,
  ): Promise<NormalizedRow[]> {
    this.calls.push('listPrs');
    if (this.listPrsError) throw this.listPrsError;
    if (this.listPrsPages !== undefined) {
      const all: NormalizedRow[] = [];
      this.pagesFetched = 0;
      for (let page = 1; page <= this.listPrsPages.length; page++) {
        const rows = this.listPrsPages[page - 1];
        if (rows.length === 0) return all;
        this.pagesFetched = page;
        all.push(...rows);
        if (shouldStop?.(rows, page) === true) return all;
      }
      return all;
    }
    return this.listPrsRows;
  }

  async listComments(source: CommentSource): Promise<NormalizedRow[]> {
    this.calls.push(`listComments:${source.key}`);
    const rows = this.comments[source.key] ?? [];
    if (rows instanceof Error) throw rows;
    return rows;
  }

  async branchView(): Promise<NormalizedRow> { throw new Error('unexpected branchView'); }
  async postComment(): Promise<void> { throw new Error('unexpected postComment'); }
  async mergePr(): Promise<void> { throw new Error('unexpected mergePr'); }
  async closePr(): Promise<void> { throw new Error('unexpected closePr'); }
  async deleteBranch(): Promise<void> { throw new Error('unexpected deleteBranch'); }
}

let dir = '';
let driver: FakeDriver;
type PlatformTaskFixture = PlatformTaskView;
let tasks: PlatformTaskFixture[];
let events: PlatformEvent[];
let failEventMatch: ((e: PlatformEvent) => boolean) | undefined;
let clockNow = T0;

function makePoller(extra: Partial<ConstructorParameters<typeof PlatformPoller>[0]> = {}) {
  const materialize = (task: PlatformTaskFixture): PlatformTaskView => task;
  const poller = new PlatformPoller({
    onEvent: (_projectId, event) => {
      if (failEventMatch?.(event)) throw new Error('delivery rejected');
      events.push(event);
    },
    tasks: async () => tasks.map(materialize),
    task: async taskId => {
      const task = tasks.find(candidate => candidate.taskId === taskId);
      return task === undefined ? null : materialize(task);
    },
    now: () => clockNow,
    ...extra,
  });
  poller.add({ projectId: 'p1', repoUrl: REPO, driver, statePath: platformPollerStatePath(dir, REPO) });
  return poller;
}

const ofType = (type: string) => events.filter(e => e.type === type);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bx-poller-'));
  driver = new FakeDriver();
  tasks = [];
  events = [];
  failEventMatch = undefined;
  clockNow = T0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('PlatformPoller: adoption predicate', () => {
  it('adopts an open non-draft same-repo bx branch onto the matching base and rejects the rest', async () => {
    tasks = [
      { taskId: 'task-1', terminal: false, branch: 'bx/task-1', expectedBase: 'main' },
      { taskId: 'task-2', terminal: false, branch: 'bx/task-2', expectedBase: 'main' },
      { taskId: 'task-3', terminal: false, branch: 'bx/task-3', expectedBase: 'main' },
      { taskId: 'task-4', terminal: false, branch: 'bx/task-4', expectedBase: 'main' },
      { taskId: 'task-5', terminal: false, branch: 'bx/task-5', expectedBase: 'release' },
    ];
    driver.listPrsRows = [
      prRow({ prAuthorId: '77' }),
      prRow({ prNumber: 43, branch: 'bx/task-2', draft: true }),
      prRow({ prNumber: 44, branch: 'bx/task-3', sourceProjectId: null }),
      prRow({ prNumber: 45, branch: 'bx/task-4', sourceProjectId: '8' }),
      prRow({ prNumber: 46, branch: 'bx/task-5', targetBranch: 'main' }),
    ];
    await makePoller().poll();
    expect(ofType('pr.created')).toHaveLength(1);
    expect(ofType('pr.created')[0]!.data).toMatchObject({
      prNumber: 42, branch: 'bx/task-1', headSha: SHA1, targetBranch: 'main', prAuthorId: '77',
    });
    const cursor = new CommentCursorStore(platformPollerStatePath(dir, REPO), REPO);
    await cursor.load();
    expect(cursor.isAdoptionPending('task-5', 46)).toBe(false);
  });

  it('omits prAuthorId from adoption when the row does not carry one', async () => {
    tasks = [{ taskId: 'task-1', terminal: false, branch: 'bx/task-1', expectedBase: 'main' }];
    driver.listPrsRows = [prRow()];
    await makePoller().poll();
    expect(ofType('pr.created')).toHaveLength(1);
    expect('prAuthorId' in ofType('pr.created')[0]!.data).toBe(false);
  });

  it('persists adoption delivery so an unbound server task is emitted only once across cycles and reloads', async () => {
    tasks = [{ taskId: 'task-1', terminal: false, branch: 'bx/task-1', expectedBase: 'main' }];
    driver.listPrsRows = [prRow()];
    const onEvent = vi.fn((_projectId: string, event: PlatformEvent) => {
      events.push(event);
      if (event.type === 'pr.created') tasks[0]!.prNumber = event.data.prNumber as number;
    });
    const first = makePoller({ onEvent });
    await first.poll();
    tasks[0]!.prNumber = undefined;
    await first.poll();
    expect(ofType('pr.created')).toHaveLength(1);

    const reloaded = makePoller({ onEvent });
    await reloaded.poll();
    expect(ofType('pr.created')).toHaveLength(1);
  });

  it('suppresses an unchanged refused adoption, escalates once, and retries after the task generation changes', async () => {
    tasks = [{
      taskId: 'task-1', terminal: false, branch: 'bx/task-1', expectedBase: 'main',
      status: 'in_progress', phase: 'code', signalToken: 'aaaaaaaaaaaa',
    }];
    driver.listPrsRows = [prRow()];
    const poller = makePoller();

    await poller.poll();
    await poller.poll();
    await poller.poll();
    await poller.poll();

    expect(ofType('pr.created')).toHaveLength(1);
    expect(ofType('human.intervention')).toHaveLength(1);
    expect(ofType('human.intervention')[0]!.data).toMatchObject({
      reason: 'pr-adoption-deferred', taskId: 'task-1', status: 'in_progress', phase: 'code', cycles: 3,
    });
    const cursor = new CommentCursorStore(platformPollerStatePath(dir, REPO), REPO);
    await cursor.load();
    expect(cursor.isAdoptionDelivered('task-1', 42)).toBe(false);
    expect(cursor.isAdoptionPending('task-1', 42)).toBe(true);
    expect(cursor.listPrsCursor().watermarkTime).not.toBeNull();

    tasks[0]!.signalToken = 'bbbbbbbbbbbb';
    await poller.poll();
    await poller.poll();
    expect(ofType('pr.created')).toHaveLength(2);
    expect(ofType('human.intervention')).toHaveLength(1);
  });

  it('retries a durable refused adoption after reload even when listPrs has advanced past it', async () => {
    tasks = [{
      taskId: 'task-1', terminal: false, branch: 'bx/task-1', expectedBase: 'main',
      status: 'in_progress', phase: 'code', signalToken: 'aaaaaaaaaaaa',
    }];
    driver.listPrsRows = [prRow()];
    await makePoller().poll();

    driver.listPrsRows = [];
    driver.prViews.set(42, prRow({ prNumber: undefined }));
    const reloaded = makePoller({
      onEvent: (_projectId, event) => {
        events.push(event);
        if (event.type === 'pr.created') tasks[0]!.prNumber = event.data.prNumber as number;
      },
    });
    await reloaded.poll();

    expect(ofType('pr.created')).toHaveLength(2);
    const cursor = new CommentCursorStore(platformPollerStatePath(dir, REPO), REPO);
    await cursor.load();
    expect(cursor.isAdoptionDelivered('task-1', 42)).toBe(true);
    expect(cursor.isAdoptionPending('task-1', 42)).toBe(false);
  });

  it('retains a deferred-adoption fingerprint across a transient pending prView failure', async () => {
    tasks = [{
      taskId: 'task-1', terminal: false, branch: 'bx/task-1', expectedBase: 'main',
      status: 'fixing', phase: 'code', signalToken: 'aaaaaaaaaaaa',
    }];
    driver.listPrsRows = [prRow()];
    const poller = makePoller();
    await poller.poll();

    driver.listPrsRows = [];
    driver.prViews.set(42, new Error('temporary prView failure'));
    await poller.poll();
    driver.prViews.set(42, prRow({ prNumber: undefined }));
    await poller.poll();
    await poller.poll();

    expect(ofType('pr.created')).toHaveLength(1);
    expect(ofType('human.intervention')).toHaveLength(1);
    expect(ofType('human.intervention')[0]!.data).toMatchObject({
      reason: 'pr-adoption-deferred', prNumber: 42, cycles: 3,
    });
  });

  it('clears stale pending adoptions for missing, terminal, or differently bound tasks', async () => {
    const statePath = platformPollerStatePath(dir, REPO);
    const seed = new CommentCursorStore(statePath, REPO);
    await seed.load();
    await seed.markAdoptionPending('task-gone', 42);
    await seed.markAdoptionPending('task-terminal', 43);
    await seed.markAdoptionPending('task-rebound', 44);
    tasks = [
      { taskId: 'task-terminal', terminal: true },
      { taskId: 'task-rebound', terminal: false, prNumber: 99 },
    ];

    await makePoller().poll();

    const reloaded = new CommentCursorStore(statePath, REPO);
    await reloaded.load();
    expect(reloaded.pendingAdoptions()).toEqual([]);
  });

  it('converges a pending adoption already reflected by the task into delivered state', async () => {
    const statePath = platformPollerStatePath(dir, REPO);
    const seed = new CommentCursorStore(statePath, REPO);
    await seed.load();
    await seed.markAdoptionPending('task-1', 42);
    tasks = [{ taskId: 'task-1', terminal: false, branch: 'bx/task-1', prNumber: 42 }];

    await makePoller().poll();

    const reloaded = new CommentCursorStore(statePath, REPO);
    await reloaded.load();
    expect(reloaded.isAdoptionDelivered('task-1', 42)).toBe(true);
    expect(reloaded.isAdoptionPending('task-1', 42)).toBe(false);
  });

  it('clears pending adoption work when the listed PR no longer satisfies the adoption predicate', async () => {
    const statePath = platformPollerStatePath(dir, REPO);
    const seed = new CommentCursorStore(statePath, REPO);
    await seed.load();
    await seed.markAdoptionPending('task-1', 42);
    tasks = [{ taskId: 'task-1', terminal: false, branch: 'bx/task-1', expectedBase: 'main' }];
    driver.listPrsRows = [prRow({ draft: true })];

    await makePoller().poll();

    const reloaded = new CommentCursorStore(statePath, REPO);
    await reloaded.load();
    expect(reloaded.isAdoptionPending('task-1', 42)).toBe(false);
    expect(ofType('pr.created')).toHaveLength(0);
  });

  it('retries a failed deferred-adoption intervention without resending pr.created', async () => {
    tasks = [{
      taskId: 'task-1', terminal: false, branch: 'bx/task-1', expectedBase: 'main',
      status: 'fixing', phase: 'code', signalToken: 'aaaaaaaaaaaa',
    }];
    driver.listPrsRows = [prRow()];
    const poller = makePoller();
    await poller.poll();
    await poller.poll();
    failEventMatch = event => event.type === 'human.intervention';
    await poller.poll();
    expect(ofType('human.intervention')).toHaveLength(0);

    failEventMatch = undefined;
    await poller.poll();
    await poller.poll();
    expect(ofType('pr.created')).toHaveLength(1);
    expect(ofType('human.intervention')).toHaveLength(1);
  });

  it('records adoption only after downstream delivery succeeds', async () => {
    tasks = [{ taskId: 'task-1', terminal: false, branch: 'bx/task-1', expectedBase: 'main' }];
    driver.listPrsRows = [prRow()];
    failEventMatch = event => event.type === 'pr.created';
    const poller = makePoller({
      onEvent: (_projectId, event) => {
        if (failEventMatch?.(event)) throw new Error('delivery rejected');
        events.push(event);
        if (event.type === 'pr.created') tasks[0]!.prNumber = event.data.prNumber as number;
      },
    });
    await poller.poll();
    expect(ofType('pr.created')).toHaveLength(0);

    failEventMatch = undefined;
    await poller.poll();
    tasks[0]!.prNumber = undefined;
    await poller.poll();
    expect(ofType('pr.created')).toHaveLength(1);
  });

  it('preserves a refused adoption across a temporary default-branch probe failure', async () => {
    tasks = [{ taskId: 'task-1', terminal: false, branch: 'bx/task-1' }];
    driver.listPrsRows = [prRow()];
    const poller = makePoller();

    await poller.poll();
    expect(ofType('pr.created')).toHaveLength(1);

    driver.projectViewError = new Error('projectView down');
    await poller.poll();
    driver.projectViewError = undefined;
    await poller.poll();

    expect(ofType('pr.created')).toHaveLength(1);
  });

  it('without a base snapshot compares against the cycle default branch and escalates mismatches', async () => {
    tasks = [
      { taskId: 'task-1', terminal: false, branch: 'bx/task-1' },
      { taskId: 'task-2', terminal: false, branch: 'bx/task-2' },
    ];
    driver.defaultBranch = 'develop';
    driver.listPrsRows = [
      prRow({ targetBranch: 'develop' }),
      prRow({ prNumber: 43, branch: 'bx/task-2', targetBranch: 'main' }),
    ];
    await makePoller().poll();
    expect(ofType('pr.created')).toHaveLength(1);
    const intervention = ofType('human.intervention');
    expect(intervention).toHaveLength(1);
    expect(intervention[0]!.data).toMatchObject({
      reason: 'base-mismatch', prNumber: 43, targetBranch: 'main', expectedBase: 'develop', taskId: 'task-2',
    });
    const cursor = new CommentCursorStore(platformPollerStatePath(dir, REPO), REPO);
    await cursor.load();
    expect(cursor.isAdoptionPending('task-2', 43)).toBe(false);
  });

  it('delivers a base-mismatch escalation once per condition, retries failed deliveries, and re-alerts on change', async () => {
    tasks = [{ taskId: 'task-2', terminal: false, branch: 'bx/task-2' }];
    driver.listPrsRows = [prRow({ prNumber: 43, branch: 'bx/task-2', targetBranch: 'release' })];
    failEventMatch = e => e.type === 'human.intervention';
    const poller = makePoller();
    await poller.poll();
    expect(ofType('human.intervention')).toHaveLength(0);

    failEventMatch = undefined;
    await poller.poll();
    await poller.poll();
    expect(ofType('human.intervention')).toHaveLength(1);

    driver.listPrsRows = [prRow({ prNumber: 43, branch: 'bx/task-2', targetBranch: 'hotfix' })];
    await poller.poll();
    expect(ofType('human.intervention')).toHaveLength(2);
    expect(ofType('human.intervention')[1]!.data).toMatchObject({ targetBranch: 'hotfix' });
  });

  it('defers no-snapshot adoption when projectView fails but still adopts snapshot-carrying tasks', async () => {
    tasks = [
      { taskId: 'task-1', terminal: false, branch: 'bx/task-1', expectedBase: 'main' },
      { taskId: 'task-2', terminal: false, branch: 'bx/task-2' },
    ];
    driver.projectViewError = new Error('projectView down');
    driver.listPrsRows = [prRow(), prRow({ prNumber: 43, branch: 'bx/task-2' })];
    const poller = makePoller();
    await poller.poll();
    expect(ofType('pr.created')).toHaveLength(1);
    expect(ofType('human.intervention')).toHaveLength(0);
    expect(poller.snapshots()[0]!.consecutiveFailures).toBe(1);
  });

  it('never adopts for terminal, already-bound, branch-mismatched, or branch-missing tasks', async () => {
    tasks = [
      { taskId: 'task-1', terminal: true, branch: 'bx/task-1', expectedBase: 'main' },
      { taskId: 'task-2', terminal: false, branch: 'custom/branch', expectedBase: 'main' },
      { taskId: 'task-3', terminal: false, branch: 'bx/task-3', prNumber: 99, expectedBase: 'main' },
      { taskId: 'task-6', terminal: false, expectedBase: 'main' },
    ];
    driver.listPrsRows = [
      prRow({ branch: 'bx/task-1' }),
      prRow({ prNumber: 43, branch: 'bx/task-2' }),
      prRow({ prNumber: 44, branch: 'bx/task-3' }),
      prRow({ prNumber: 46, branch: 'bx/task-6' }),
    ];
    driver.prViews.set(99, prRow({ prNumber: 99, branch: 'bx/task-3' }));
    await makePoller().poll();
    expect(ofType('pr.created')).toHaveLength(0);
  });
});

describe('PlatformPoller: reopen and generations', () => {
  it('synthesizes a reopened update for an anchored task when its PR shows open again', async () => {
    tasks = [{ taskId: 'task-1', terminal: false, branch: 'bx/task-1', prNumber: 42, closedUnmergedAnchor: true }];
    driver.listPrsRows = [prRow()];
    driver.prViews.set(42, prRow());
    await makePoller().poll();
    expect(ofType('pr.updated').filter(e => e.data.kind === 'reopened')).toHaveLength(1);
  });

  it('halts the entire sub-poll while the closed-unmerged anchor is set, until the durable state clears it', async () => {
    tasks = [{ taskId: 'task-1', terminal: false, branch: 'bx/task-1', prNumber: 42, closedUnmergedAnchor: true, latestHeadSha: SHA1 }];
    driver.listPrsError = new Error('listing offline');
    driver.prViews.set(42, prRow());
    driver.comments['issue-comments'] = [comment('c1', 'new blocker')];
    const poller = makePoller();
    await poller.poll();
    expect(driver.calls).not.toContain('prView');
    expect(driver.calls.filter(c => c.startsWith('listComments'))).toHaveLength(0);
    expect(events).toHaveLength(0);

    driver.listPrsError = undefined;
    driver.listPrsRows = [];
    tasks = [{ taskId: 'task-1', terminal: false, branch: 'bx/task-1', prNumber: 42, latestHeadSha: SHA1 }];
    await poller.poll();
    expect(ofType('pr.updated').filter(e => e.data.kind === 'comment')).toHaveLength(1);
  });

  it('drops cursor generations for terminal or vanished tasks', async () => {
    const statePath = platformPollerStatePath(dir, REPO);
    const seed = new CommentCursorStore(statePath, REPO);
    await seed.load();
    await seed.commitSource('task-gone', 42, 'issue-comments', [comment('1', 'x')], T0);
    await seed.commitSource('task-done', 42, 'issue-comments', [comment('1', 'x')], T0);
    const seeded = new CommentCursorStore(statePath, REPO);
    await seeded.load();
    expect(seeded.generations().sort()).toEqual(['task-done', 'task-gone']);

    tasks = [{ taskId: 'task-done', terminal: true }];
    await makePoller().poll();
    const check = new CommentCursorStore(statePath, REPO);
    await check.load();
    expect(check.generations()).toEqual([]);
  });

  it('keeps cursor generations for an authoritative live task hidden by the entry filter', async () => {
    const statePath = platformPollerStatePath(dir, REPO);
    const seed = new CommentCursorStore(statePath, REPO);
    await seed.load();
    await seed.commitSource('task-hidden', 42, 'issue-comments', [comment('1', 'x')], T0);
    tasks = [];

    await makePoller({
      task: async taskId => taskId === 'task-hidden'
        ? { taskId, terminal: false, branch: 'bx/task-hidden' }
        : null,
    }).poll();

    const check = new CommentCursorStore(statePath, REPO);
    await check.load();
    expect(check.generations()).toEqual(['task-hidden']);
  });
});

describe('PlatformPoller: pr lifecycle sub-poll', () => {
  beforeEach(() => {
    tasks = [{ taskId: 'task-1', terminal: false, branch: 'bx/task-1', prNumber: 42, latestHeadSha: SHA1 }];
  });

  it('emits push once per observed head change', async () => {
    driver.prViews.set(42, prRow({ headSha: SHA2 }));
    const poller = makePoller();
    await poller.poll();
    await poller.poll();
    const pushes = ofType('pr.updated').filter(e => e.data.kind === 'push');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.data).toMatchObject({ headSha: SHA2, prNumber: 42 });
  });

  it('emits pr.merged for a merged close and closed-unmerged otherwise, skipping comment scans', async () => {
    driver.prViews.set(42, prRow({ state: 'closed', mergedAt: OLD_TS }));
    driver.comments['issue-comments'] = [comment('1', 'should not be scanned')];
    await makePoller().poll();
    expect(ofType('pr.merged')).toHaveLength(1);
    expect(ofType('pr.updated')).toHaveLength(0);

    events = [];
    driver.prViews.set(42, prRow({ state: 'closed', mergedAt: null }));
    const poller = makePoller();
    await poller.poll();
    await poller.poll();
    const closed = ofType('pr.updated').filter(e => e.data.kind === 'closed-unmerged');
    expect(closed).toHaveLength(1);
    expect(events.some(e => e.data.kind === 'comment')).toBe(false);
  });

});

describe('PlatformPoller: comment flow', () => {
  beforeEach(() => {
    tasks = [{
      taskId: 'task-1', terminal: false, branch: 'bx/task-1', prNumber: 42, latestHeadSha: SHA1,
      replyActorId: '77', replyActorStatus: 'verified',
    }];
    driver.prViews.set(42, prRow());
  });

  it('emits feedback events with revision keys and thread flags', async () => {
    driver.comments['issue-comments'] = [comment('100', 'top level feedback')];
    driver.comments['inline-comments'] = [comment('200', 'thread reply', OLD_TS, { discussionId: '150' })];
    await makePoller().poll();
    const feedback = ofType('pr.updated');
    expect(feedback).toHaveLength(2);
    expect(feedback[0]!.data).toMatchObject({
      kind: 'comment', commentId: '100',
      revision: { sourceKey: 'issue-comments', id: '100', bodyDigest: bodyDigest('top level feedback') },
    });
    expect(feedback[1]!.data).toMatchObject({ kind: 'review-comment', reviewCommentReply: true });
  });

  it('retries only the failed delivery thanks to the ledger, then goes quiet', async () => {
    driver.comments['issue-comments'] = [comment('a1', 'first'), comment('b1', 'second')];
    failEventMatch = e => e.data.commentId === 'b1';
    const poller = makePoller();
    await poller.poll();
    expect(ofType('pr.updated')).toHaveLength(1);

    failEventMatch = undefined;
    events = [];
    await poller.poll();
    expect(ofType('pr.updated').map(e => e.data.commentId)).toEqual(['b1']);

    events = [];
    await poller.poll();
    expect(events).toHaveLength(0);
  });

  it('filters verdict-token rows and valid ack replies, but treats forged acks as human comments', async () => {
    const ack = buildAckMarker({ sourceKey: 'issue-comments', commentId: '100', bodyDigest: bodyDigest('x') });
    driver.comments['issue-comments'] = [
      comment('1', `findings\n${buildReviewTokenLine({ kind: 'fail', anchorSha: ANCHOR, token: FAIL })}`),
      comment('2', `done\n${ack}`, OLD_TS, { authorId: '77' }),
      comment('3', `forged\n${ack}`, OLD_TS, { authorId: '999' }),
      comment('4', '', OLD_TS),
    ];
    await makePoller().poll();
    const feedback = ofType('pr.updated');
    expect(feedback.map(e => e.data.commentId)).toEqual(['3']);
  });

  it('skips undated pending rows and re-emits edited revisions', async () => {
    driver.comments['reviews'] = [{ id: 'r1', body: 'pending review' }];
    const poller = makePoller();
    await poller.poll();
    expect(ofType('pr.updated')).toHaveLength(0);

    driver.comments['issue-comments'] = [comment('9', 'v1')];
    events = [];
    await poller.poll();
    expect(ofType('pr.updated')).toHaveLength(1);

    driver.comments['issue-comments'] = [comment('9', 'v2 edited')];
    events = [];
    await poller.poll();
    expect(ofType('pr.updated')[0]!.data.revision).toMatchObject({ bodyDigest: bodyDigest('v2 edited') });
  });

  it('keeps healthy sources flowing while a failed source holds its watermark', async () => {
    driver.comments['issue-comments'] = [comment('1', 'ok source')];
    driver.comments['inline-comments'] = new Error('boom') as unknown as NormalizedRow[];
    const poller = makePoller();
    await poller.poll();
    expect(ofType('pr.updated')).toHaveLength(1);
    expect(poller.snapshots()[0]!.consecutiveFailures).toBe(1);

    driver.comments['inline-comments'] = [comment('5', 'late but preserved', OLD_TS, { discussionId: null })];
    events = [];
    await poller.poll();
    expect(ofType('pr.updated').map(e => e.data.commentId)).toEqual(['5']);
    expect(poller.snapshots()[0]!.consecutiveFailures).toBe(0);
  });

  it('honors cross-source acks: an acked revision never re-emits even from a zero watermark', async () => {
    const blocker = comment('55', 'inline blocker', OLD_TS, { discussionId: null, authorId: '99' });
    driver.comments['inline-comments'] = [blocker];
    driver.comments['issue-comments'] = [
      comment('700', `handled\n${buildAckMarker({ sourceKey: 'inline-comments', commentId: '55', bodyDigest: bodyDigest('inline blocker') })}`, OLD_TS, { authorId: '77' }),
      comment('701', 'unrelated feedback', OLD_TS, { authorId: '99' }),
    ];
    await makePoller().poll();
    expect(ofType('pr.updated').map(e => e.data.commentId)).toEqual(['701']);
  });

  it('logs undated rows once per generation and re-logs for a new owner task', async () => {
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    });
    try {
      driver.comments['reviews'] = [{ id: 'r1', body: 'pending review' }];
      const poller = makePoller();
      await poller.poll();
      await poller.poll();
      const undatedWarns = () => warns.filter(w => w.includes('without timestamps'));
      expect(undatedWarns()).toHaveLength(1);

      tasks = [{ taskId: 'task-1', terminal: true }];
      await poller.poll();

      tasks = [{
        taskId: 'task-2', terminal: false, branch: 'bx/task-1', prNumber: 42, latestHeadSha: SHA1,
        replyActorId: '77', replyActorStatus: 'verified',
      }];
      await poller.poll();
      expect(undatedWarns()).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('PlatformPoller: verdict integration', () => {
  beforeEach(() => {
    tasks = [{
      taskId: 'task-1', terminal: false, branch: 'bx/task-1', prNumber: 42, latestHeadSha: SHA1,
      anchorSha: ANCHOR, passToken: PASS, failToken: FAIL, signalToken: 'sig-token-123', inReview: true,
    }];
    driver.prViews.set(42, prRow());
  });

  it('emits REQUEST_CHANGES immediately on a fail token and dedupes the same decision', async () => {
    driver.comments['reviews'] = [comment('r1', `findings\n${buildReviewTokenLine({ kind: 'fail', anchorSha: ANCHOR, token: FAIL })}`)];
    const poller = makePoller();
    await poller.poll();
    await poller.poll();
    const verdicts = ofType('review.submitted');
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.data).toMatchObject({
      action: 'REQUEST_CHANGES', prNumber: 42, headSha: ANCHOR, currentHeadSha: SHA1,
      reviewPassToken: 'sig-token-123', submittedAt: OLD_TS,
    });
  });

  it('holds a pass for the confirmation cycle and approves on the next poll', async () => {
    driver.comments['reviews'] = [comment('r1', `LGTM\n${buildReviewTokenLine({ kind: 'pass', anchorSha: ANCHOR, token: PASS })}`)];
    const poller = makePoller();
    await poller.poll();
    expect(ofType('review.submitted')).toHaveLength(0);
    clockNow = T0 + 30_000;
    await poller.poll();
    expect(ofType('review.submitted')).toHaveLength(1);
    expect(ofType('review.submitted')[0]!.data).toMatchObject({ action: 'APPROVE' });
  });

  it('produces no verdict while any comment source fails', async () => {
    driver.comments['reviews'] = [comment('r1', `LGTM\n${buildReviewTokenLine({ kind: 'pass', anchorSha: ANCHOR, token: PASS })}`)];
    driver.comments['issue-comments'] = new Error('offline') as unknown as NormalizedRow[];
    const poller = makePoller();
    await poller.poll();
    clockNow = T0 + 30_000;
    await poller.poll();
    expect(ofType('review.submitted')).toHaveLength(0);
  });
});

describe('PlatformPoller: health accounting', () => {
  it('does not count rate-limited cycles as consecutive failures but surfaces the class', async () => {
    tasks = [];
    driver.listPrsError = new DriverOpError('op listPrs failed (exit 1, class RATE_LIMIT): HTTP 429', {
      opName: 'listPrs', errorClass: 'RATE_LIMIT', exitCode: 1,
    });
    const poller = makePoller();
    await poller.poll();
    const snap = poller.snapshots()[0]!;
    expect(snap.consecutiveFailures).toBe(0);
    expect(snap.lastErrorClass).toBe('RATE_LIMIT');
    expect(snap.health).toBe('healthy');
  });

  it('counts and classifies non-rate-limit driver failures', async () => {
    tasks = [];
    driver.listPrsError = new DriverOpError('op listPrs failed (exit 1, class ACCESS_DENIED): HTTP 403', {
      opName: 'listPrs', errorClass: 'ACCESS_DENIED', exitCode: 1,
    });
    const poller = makePoller();
    await poller.poll();
    const snap = poller.snapshots()[0]!;
    expect(snap.consecutiveFailures).toBe(1);
    expect(snap.lastErrorClass).toBe('ACCESS_DENIED');
    expect(snap.health).toBe('degraded');
  });
});

describe('PlatformPoller: durability and retention', () => {
  it('confines a cursor persist failure to the cycle error budget and keeps scanning other tasks', async () => {
    tasks = [
      { taskId: 'task-1', terminal: false, branch: 'bx/task-1', prNumber: 42, latestHeadSha: SHA1 },
      { taskId: 'task-2', terminal: false, branch: 'bx/task-2', prNumber: 43, latestHeadSha: SHA1 },
    ];
    driver.prViews.set(42, prRow());
    driver.prViews.set(43, prRow({ prNumber: 43, branch: 'bx/task-2' }));
    driver.comments['issue-comments'] = [comment('1', 'first round feedback')];
    const poller = makePoller();
    await poller.poll();

    await rm(join(dir, 'state'), { recursive: true, force: true });
    await writeFile(join(dir, 'state'), 'not a directory');
    driver.comments['issue-comments'] = [comment('1', 'first round feedback'), comment('2', 'second round feedback')];
    events = [];
    await poller.poll();
    const perTask = ofType('pr.updated').filter(e => e.data.kind === 'comment');
    expect(perTask.map(e => e.data.commentId)).toEqual(['2', '2']);
    expect(poller.snapshots()[0]!.consecutiveFailures).toBe(1);
    expect(poller.snapshots()[0]!.lastErrorMessage).toBeTruthy();
  });

  it('retries a failed pass delivery on the very next cycle', async () => {
    tasks = [{
      taskId: 'task-1', terminal: false, branch: 'bx/task-1', prNumber: 42, latestHeadSha: SHA1,
      anchorSha: ANCHOR, passToken: PASS, failToken: FAIL, signalToken: 'sig', inReview: true,
    }];
    driver.prViews.set(42, prRow());
    driver.comments['reviews'] = [comment('r1', `LGTM\n${buildReviewTokenLine({ kind: 'pass', anchorSha: ANCHOR, token: PASS })}`)];
    const poller = makePoller();
    await poller.poll();
    failEventMatch = e => e.type === 'review.submitted';
    clockNow = T0 + 30_000;
    await poller.poll();
    expect(ofType('review.submitted')).toHaveLength(0);

    failEventMatch = undefined;
    clockNow = T0 + 60_000;
    await poller.poll();
    expect(ofType('review.submitted')).toHaveLength(1);
  });

  it('prunes per-pr observation caches when the owning task reaches a terminal state', async () => {
    tasks = [{ taskId: 'task-a', terminal: false, branch: 'bx/task-a', prNumber: 42, latestHeadSha: SHA1 }];
    driver.prViews.set(42, prRow({ branch: 'bx/task-a', state: 'closed', mergedAt: OLD_TS }));
    const poller = makePoller();
    await poller.poll();
    expect(ofType('pr.merged')).toHaveLength(1);

    tasks = [{ taskId: 'task-a', terminal: true, prNumber: 42 }];
    await poller.poll();

    tasks = [{ taskId: 'task-b', terminal: false, branch: 'bx/task-a', prNumber: 42, latestHeadSha: SHA1 }];
    events = [];
    await poller.poll();
    expect(ofType('pr.merged')).toHaveLength(1);
  });

  it('re-observes lifecycle events for a new owner task handed the same pr with no idle cycle in between', async () => {
    tasks = [{ taskId: 'task-a', terminal: false, branch: 'bx/task-a', prNumber: 42, latestHeadSha: SHA1 }];
    driver.prViews.set(42, prRow({ branch: 'bx/task-a', state: 'closed', mergedAt: OLD_TS }));
    const poller = makePoller();
    await poller.poll();
    expect(ofType('pr.merged')).toHaveLength(1);

    tasks = [
      { taskId: 'task-a', terminal: true, prNumber: 42 },
      { taskId: 'task-b', terminal: false, branch: 'bx/task-a', prNumber: 42, latestHeadSha: SHA1 },
    ];
    events = [];
    await poller.poll();
    expect(ofType('pr.merged')).toHaveLength(1);
  });
});

describe('PlatformPoller: listPrs cursor integrity', () => {
  it('keeps paging through a fully-known watermark page until a strictly older row appears', async () => {
    tasks = [{ taskId: 'task-x', terminal: false, branch: 'bx/task-x', expectedBase: 'main' }];
    driver.listPrsRows = [prRow({ prNumber: 42, branch: 'other/seed' })];
    const poller = makePoller();
    await poller.poll();

    const atWatermark = (n: number, branch: string) => prRow({ prNumber: n, branch, updatedAt: OLD_TS });
    driver.listPrsPages = [
      Array.from({ length: 10 }, (_, i) => atWatermark(42 + i, i === 0 ? 'other/seed' : `other/k${i}`)),
      [atWatermark(60, 'bx/task-x'), prRow({ prNumber: 2, branch: 'other/ancient', updatedAt: iso(T0 - 600_000) })],
    ];
    await poller.poll();
    expect(driver.pagesFetched).toBe(2);
    expect(ofType('pr.created')).toHaveLength(1);
    expect(ofType('pr.created')[0]!.data.prNumber).toBe(60);
  });

  it('advances listPrs while independently retaining a no-snapshot adoption', async () => {
    tasks = [{ taskId: 'task-1', terminal: false, branch: 'bx/task-1' }];
    driver.projectViewError = new Error('projectView down');
    driver.listPrsRows = [prRow()];
    const poller = makePoller({
      onEvent: (_projectId, event) => {
        events.push(event);
        if (event.type === 'pr.created') tasks[0]!.prNumber = event.data.prNumber as number;
      },
    });
    await poller.poll();
    const pending = new CommentCursorStore(platformPollerStatePath(dir, REPO), REPO);
    await pending.load();
    const initialWatermark = pending.listPrsCursor().watermarkTime;
    expect(initialWatermark).not.toBe(null);
    expect(pending.isAdoptionPending('task-1', 42)).toBe(true);
    expect(ofType('pr.created')).toHaveLength(0);

    driver.projectViewError = undefined;
    driver.listPrsRows = [];
    driver.prViews.set(42, prRow({ updatedAt: iso(T0 - 10_000) }));
    await poller.poll();
    expect(ofType('pr.created')).toHaveLength(1);
    const advanced = new CommentCursorStore(platformPollerStatePath(dir, REPO), REPO);
    await advanced.load();
    expect(advanced.listPrsCursor().watermarkTime).toBe(initialWatermark);
    expect(advanced.isAdoptionPending('task-1', 42)).toBe(false);
  });
});

describe('PlatformPoller: source key lifecycle', () => {
  it('drops removed source cursors so a re-added key rescans from zero', async () => {
    tasks = [{ taskId: 'task-1', terminal: false, branch: 'bx/task-1', prNumber: 42, latestHeadSha: SHA1 }];
    driver.prViews.set(42, prRow());
    const extra: CommentSource = { key: 'extra', category: 'top-level' };
    driver.commentSources = [...SOURCES, extra];
    driver.comments['extra'] = [comment('9', 'seen once')];
    const poller = makePoller();
    await poller.poll();
    expect(ofType('pr.updated').filter(e => e.data.kind === 'comment')).toHaveLength(1);

    driver.commentSources = SOURCES;
    await poller.poll();

    driver.commentSources = [...SOURCES, extra];
    events = [];
    await poller.poll();
    expect(ofType('pr.updated').filter(e => e.data.kind === 'comment')).toHaveLength(1);
  });
});

describe('PlatformPoller: sub-poll binding predicate', () => {
  beforeEach(() => {
    tasks = [{
      taskId: 'task-1', terminal: false, branch: 'bx/task-1', prNumber: 42, latestHeadSha: SHA1,
      expectedBase: 'main', anchorSha: ANCHOR, passToken: PASS, failToken: FAIL, signalToken: 'sig', inReview: true,
    }];
    driver.comments['reviews'] = [comment('r1', `LGTM\n${buildReviewTokenLine({ kind: 'pass', anchorSha: ANCHOR, token: PASS })}`)];
  });

  it('suppresses verdicts on a retargeted PR and escalates the mismatch once', async () => {
    driver.prViews.set(42, prRow({ targetBranch: 'release' }));
    const poller = makePoller();
    await poller.poll();
    clockNow = T0 + 30_000;
    await poller.poll();
    expect(ofType('review.submitted')).toHaveLength(0);
    const escalations = ofType('human.intervention');
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.data).toMatchObject({ reason: 'binding-mismatch', mismatch: 'target', prNumber: 42 });
  });

  it('suppresses pr.merged while the binding is broken', async () => {
    driver.prViews.set(42, prRow({ state: 'closed', mergedAt: OLD_TS, targetBranch: 'release' }));
    await makePoller().poll();
    expect(ofType('pr.merged')).toHaveLength(0);
    expect(ofType('human.intervention')).toHaveLength(1);
  });

  it('gates branch hijack and fork drift', async () => {
    driver.prViews.set(42, prRow({ branch: 'hijack/x' }));
    await makePoller().poll();
    expect(ofType('human.intervention')[0]!.data).toMatchObject({ mismatch: 'branch' });

    events = [];
    driver.prViews.set(42, prRow({ sourceProjectId: null }));
    await makePoller().poll();
    expect(ofType('human.intervention')[0]!.data).toMatchObject({ mismatch: 'fork' });
  });

  it('resumes the verdict flow once the binding is restored', async () => {
    driver.prViews.set(42, prRow({ targetBranch: 'release' }));
    const poller = makePoller();
    await poller.poll();
    expect(ofType('human.intervention')).toHaveLength(1);

    driver.prViews.set(42, prRow());
    clockNow = T0 + 30_000;
    await poller.poll();
    clockNow = T0 + 60_000;
    await poller.poll();
    expect(ofType('review.submitted')).toHaveLength(1);
    expect(ofType('review.submitted')[0]!.data).toMatchObject({ action: 'APPROVE' });

    events = [];
    driver.prViews.set(42, prRow({ targetBranch: 'release' }));
    clockNow = T0 + 90_000;
    await poller.poll();
    expect(ofType('human.intervention')).toHaveLength(1);
  });

  it('invalidates an established pass candidate across a retarget instead of confirming on recovery', async () => {
    const poller = makePoller();
    driver.prViews.set(42, prRow());
    await poller.poll();

    driver.prViews.set(42, prRow({ targetBranch: 'release' }));
    clockNow = T0 + 30_000;
    await poller.poll();
    expect(ofType('review.submitted')).toHaveLength(0);

    driver.prViews.set(42, prRow());
    clockNow = T0 + 60_000;
    await poller.poll();
    expect(ofType('review.submitted')).toHaveLength(0);
    clockNow = T0 + 90_000;
    await poller.poll();
    expect(ofType('review.submitted')).toHaveLength(1);
  });

  it('invalidates an established pass candidate across a draft flip', async () => {
    const poller = makePoller();
    driver.prViews.set(42, prRow());
    await poller.poll();

    driver.prViews.set(42, prRow({ draft: true }));
    clockNow = T0 + 30_000;
    await poller.poll();

    driver.prViews.set(42, prRow());
    clockNow = T0 + 60_000;
    await poller.poll();
    expect(ofType('review.submitted')).toHaveLength(0);
    clockNow = T0 + 90_000;
    await poller.poll();
    expect(ofType('review.submitted')).toHaveLength(1);
  });

  it('never lets tokens anchored to an old head approve a moved head', async () => {
    tasks[0] = { ...tasks[0]!, latestHeadSha: SHA1 };
    driver.prViews.set(42, prRow({ headSha: SHA2 }));
    const poller = makePoller();
    await poller.poll();
    clockNow = T0 + 30_000;
    await poller.poll();
    expect(ofType('review.submitted')).toHaveLength(0);
    expect(ofType('pr.updated').filter(e => e.data.kind === 'push')).toHaveLength(1);
  });

  it('re-checks the authoritative view after evaluation and withholds the verdict when the head moved mid-scan', async () => {
    const poller = makePoller();
    driver.prViews.set(42, prRow());
    await poller.poll();

    clockNow = T0 + 30_000;
    driver.prViewSeq.set(42, [prRow(), prRow({ headSha: SHA2 })]);
    await poller.poll();
    expect(ofType('review.submitted')).toHaveLength(0);

    clockNow = T0 + 60_000;
    await poller.poll();
    clockNow = T0 + 90_000;
    await poller.poll();
    expect(ofType('review.submitted')).toHaveLength(1);
  });

  it('requires a non-blank task signal token before emitting any verdict', async () => {
    driver.prViews.set(42, prRow());
    for (const signalToken of [undefined, '', '   ']) {
      events = [];
      tasks[0] = { ...tasks[0]!, signalToken };
      const poller = makePoller();
      await poller.poll();
      clockNow += 30_000;
      await poller.poll();
      expect(ofType('review.submitted')).toHaveLength(0);
      clockNow += 30_000;
    }
  });

  it('escalates once and stays silent when the task view carries no branch binding', async () => {
    tasks[0] = { taskId: 'task-1', terminal: false, prNumber: 42, latestHeadSha: SHA1, expectedBase: 'main' };
    driver.prViews.set(42, prRow({ state: 'closed', mergedAt: OLD_TS }));
    const poller = makePoller();
    await poller.poll();
    await poller.poll();
    expect(ofType('pr.merged')).toHaveLength(0);
    const escalations = ofType('human.intervention');
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.data).toMatchObject({ mismatch: 'branch' });
  });
});

describe('PlatformPoller: default-branch expectations for the binding guard', () => {
  beforeEach(() => {
    tasks = [{ taskId: 'task-1', terminal: false, branch: 'bx/task-1', prNumber: 42, latestHeadSha: SHA1 }];
    driver.prViews.set(42, prRow());
  });

  it('stops the sub-poll entirely while the base expectation is unverifiable, then recovers', async () => {
    driver.projectViewError = new Error('projectView down');
    driver.comments['issue-comments'] = [comment('c1', 'blocker')];
    const poller = makePoller();
    await poller.poll();
    expect(driver.calls.filter(c => c.startsWith('listComments'))).toHaveLength(0);
    expect(ofType('pr.updated')).toHaveLength(0);

    driver.projectViewError = undefined;
    await poller.poll();
    expect(ofType('pr.updated')).toHaveLength(1);
  });

  it('bridges up to two failed projectView cycles with the cached default branch, then fails closed', async () => {
    driver.comments['issue-comments'] = [comment('c1', 'first')];
    const poller = makePoller();
    await poller.poll();
    expect(ofType('pr.updated')).toHaveLength(1);

    driver.projectViewError = new Error('projectView down');
    driver.comments['issue-comments'] = [comment('c1', 'first'), comment('c2', 'second')];
    await poller.poll();
    expect(ofType('pr.updated')).toHaveLength(2);

    driver.comments['issue-comments'] = [comment('c1', 'first'), comment('c2', 'second'), comment('c3', 'third')];
    await poller.poll();
    expect(ofType('pr.updated')).toHaveLength(3);

    driver.comments['issue-comments'] = [comment('c1', 'first'), comment('c2', 'second'), comment('c3', 'third'), comment('c4', 'fourth')];
    await poller.poll();
    expect(ofType('pr.updated')).toHaveLength(3);
  });
});

describe('PlatformPoller: rate limit backoff', () => {
  const rateLimited = (op: string) => new DriverOpError(`op ${op} failed (exit 1, class RATE_LIMIT): HTTP 429`, {
    opName: op, errorClass: 'RATE_LIMIT', exitCode: 1,
  });

  it('short-circuits the entry, skips until the backoff expires, and grows the window exponentially', async () => {
    tasks = [{ taskId: 'task-1', terminal: false, branch: 'bx/task-1', prNumber: 42, latestHeadSha: SHA1 }];
    driver.prViews.set(42, prRow());
    driver.projectViewError = new DriverOpError('projectView rate limited', {
      opName: 'projectView', errorClass: 'RATE_LIMIT', exitCode: 1,
    });
    const poller = makePoller();
    await poller.poll();
    expect(driver.calls).toEqual(['projectView']);
    let snap = poller.snapshots()[0]!;
    expect(snap.consecutiveFailures).toBe(0);
    expect(snap.lastErrorClass).toBe('RATE_LIMIT');
    expect(snap.rateLimitedUntil).toBe(new Date(T0 + 60_000).toISOString());

    driver.calls = [];
    clockNow = T0 + 30_000;
    await poller.poll();
    expect(driver.calls).toEqual([]);

    clockNow = T0 + 61_000;
    await poller.poll();
    expect(driver.calls).toEqual(['projectView']);
    snap = poller.snapshots()[0]!;
    expect(snap.rateLimitedUntil).toBe(new Date(T0 + 61_000 + 120_000).toISOString());

    driver.projectViewError = undefined;
    driver.calls = [];
    clockNow = T0 + 300_000;
    await poller.poll();
    expect(driver.calls.length).toBeGreaterThan(1);
    expect(poller.snapshots()[0]!.rateLimitedUntil).toBe(undefined);

    driver.projectViewError = new DriverOpError('projectView rate limited', {
      opName: 'projectView', errorClass: 'RATE_LIMIT', exitCode: 1,
    });
    clockNow = T0 + 400_000;
    await poller.poll();
    expect(poller.snapshots()[0]!.rateLimitedUntil).toBe(new Date(T0 + 400_000 + 60_000).toISOString());
  });

  it('stops scanning remaining comment sources after a mid-cycle rate limit', async () => {
    tasks = [{ taskId: 'task-1', terminal: false, branch: 'bx/task-1', prNumber: 42, latestHeadSha: SHA1 }];
    driver.prViews.set(42, prRow());
    driver.comments['issue-comments'] = rateLimited('listComments') as unknown as NormalizedRow[];
    driver.comments['inline-comments'] = [comment('5', 'never scanned', OLD_TS, { discussionId: null })];
    const poller = makePoller();
    await poller.poll();
    expect(driver.calls.filter(c => c.startsWith('listComments'))).toEqual(['listComments:issue-comments']);
    expect(ofType('pr.updated')).toHaveLength(0);
  });

  it('keeps earlier real failures in the health accounting when a later call rate-limits', async () => {
    tasks = [];
    driver.projectViewError = new DriverOpError('op projectView failed (exit 1, class ACCESS_DENIED): HTTP 403', {
      opName: 'projectView', errorClass: 'ACCESS_DENIED', exitCode: 1,
    });
    driver.listPrsError = rateLimited('listPrs');
    const poller = makePoller();
    await poller.poll();
    const snap = poller.snapshots()[0]!;
    expect(snap.consecutiveFailures).toBe(1);
    expect(snap.lastErrorClass).toBe('ACCESS_DENIED');
    expect(snap.lastErrorMessage).toContain('projectView');
    expect(snap.rateLimitedUntil).toBe(new Date(T0 + 60_000).toISOString());
  });
});

describe('PlatformPoller: reentrancy', () => {
  it('lets only one cycle run at a time across direct poll calls', async () => {
    tasks = [{ taskId: 'task-1', terminal: false, branch: 'bx/task-1', prNumber: 42, latestHeadSha: SHA1 }];
    driver.prViews.set(42, prRow());
    driver.comments['issue-comments'] = [comment('c1', 'fresh feedback')];
    const poller = makePoller();
    await Promise.all([poller.poll(), poller.poll()]);
    expect(ofType('pr.updated')).toHaveLength(1);
  });
});

describe('PlatformPoller: server-track preflight gate', () => {
  it('fails the cycle into health with the fixMessage until steps pass, then never reruns', async () => {
    let calls = 0;
    let stepOk = false;
    driver.runPreflightSteps = async () => {
      calls += 1;
      return stepOk
        ? [{ step: 'driver-preflight-1', ok: true, message: 'gh --version OK' }]
        : [{ step: 'driver-preflight-1', ok: false, message: 'gh 需 ≥ 2.40.0，安装见 https://cli.github.com' }];
    };
    driver.projectViewExtra = { pushPermitted: true };
    const poller = makePoller();

    await poller.poll();
    expect(driver.calls).toEqual([]);
    let snap = poller.snapshots()[0]!;
    expect(snap.consecutiveFailures).toBe(1);
    expect(snap.lastErrorMessage).toContain('cli.github.com');

    stepOk = true;
    await poller.poll();
    snap = poller.snapshots()[0]!;
    expect(snap.consecutiveFailures).toBe(0);
    expect(driver.calls).toContain('projectView');

    await poller.poll();
    expect(calls).toBe(2);
  });

  it('backs off when the preflight itself is rate limited instead of hammering every cycle', async () => {
    driver.runPreflightSteps = async () => {
      throw new DriverOpError('preflight driver-preflight-2 failed (class RATE_LIMIT): HTTP 429', {
        opName: 'driver-preflight-2', errorClass: 'RATE_LIMIT',
      });
    };
    const poller = makePoller();
    await poller.poll();
    const snap = poller.snapshots()[0]!;
    expect(snap.rateLimitedUntil).toBe(new Date(T0 + 60_000).toISOString());
    expect(driver.calls).toEqual([]);

    driver.calls = [];
    clockNow = T0 + 30_000;
    await poller.poll();
    expect(driver.calls).toEqual([]);
  });

  it('expires the default-branch snapshot while rate-limit backoff skips refresh cycles', async () => {
    const repoKey = repoIdentityKey(REPO);
    const poller = makePoller();
    await poller.poll();
    expect(poller.defaultBranchSnapshot(repoKey)).toBe('main');

    driver.projectViewError = new DriverOpError('projectView rate limited', {
      opName: 'projectView', errorClass: 'RATE_LIMIT', exitCode: 1,
    });
    clockNow = T0 + 1_000;
    await poller.poll();
    expect(poller.defaultBranchSnapshot(repoKey)).toBe('main');

    clockNow = T0 + 10_000;
    await poller.poll();
    expect(poller.defaultBranchSnapshot(repoKey)).toBe('main');

    clockNow = T0 + 20_000;
    await poller.poll();
    expect(poller.defaultBranchSnapshot(repoKey)).toBeUndefined();
  });

  it('ages the default-branch cache on step-failing cycles so the snapshot expires', async () => {
    const repoKey = repoIdentityKey(REPO);
    let stepOk = true;
    driver.runPreflightSteps = async () => (stepOk
      ? []
      : [{ step: 'driver-preflight-1', ok: false, message: 'auth broken' }]);
    driver.projectViewExtra = { pushPermitted: false };
    const poller = makePoller();

    await poller.poll();
    expect(poller.defaultBranchSnapshot(repoKey)).toBe('main');

    stepOk = false;
    await poller.poll();
    await poller.poll();
    expect(poller.defaultBranchSnapshot(repoKey)).toBe('main');
    await poller.poll();
    expect(poller.defaultBranchSnapshot(repoKey)).toBeUndefined();
  });

  it('holds the gate open while push permission is missing and closes it when granted', async () => {
    let calls = 0;
    driver.runPreflightSteps = async () => {
      calls += 1;
      return [];
    };
    driver.projectViewExtra = { pushPermitted: false };
    const poller = makePoller();

    await poller.poll();
    let snap = poller.snapshots()[0]!;
    expect(snap.consecutiveFailures).toBe(1);
    expect(snap.lastErrorMessage).toContain('push permission missing');

    driver.projectViewExtra = { pushPermitted: true };
    await poller.poll();
    snap = poller.snapshots()[0]!;
    expect(snap.consecutiveFailures).toBe(0);

    await poller.poll();
    expect(calls).toBe(2);
  });
});

describe('PlatformPoller: default-branch snapshot accessor', () => {
  it('serves the cached branch while fresh and reports missing after three failed cycles', async () => {
    const repoKey = repoIdentityKey(REPO);
    const poller = makePoller();
    expect(poller.defaultBranchSnapshot(repoKey)).toBeUndefined();

    await poller.poll();
    expect(poller.defaultBranchSnapshot(repoKey)).toBe('main');

    driver.projectViewError = new Error('projectView down');
    await poller.poll();
    await poller.poll();
    expect(poller.defaultBranchSnapshot(repoKey)).toBe('main');

    await poller.poll();
    expect(poller.defaultBranchSnapshot(repoKey)).toBeUndefined();

    driver.projectViewError = undefined;
    await poller.poll();
    expect(poller.defaultBranchSnapshot(repoKey)).toBe('main');
    expect(poller.defaultBranchSnapshot('github.com/other/repo')).toBeUndefined();
  });
});

describe('PlatformPoller: conversation projection revision', () => {
  let revisions: string[];

  beforeEach(() => {
    revisions = [];
    tasks = [{ taskId: 'task-1', terminal: false, branch: 'bx/task-1', prNumber: 42, expectedBase: 'main' }];
    driver.prViews.set(42, prRow());
    driver.comments['inline-comments'] = [];
    driver.comments['reviews'] = [];
  });

  const pollerWithRevisions = () => makePoller({
    onConversationRevision: (taskId) => { revisions.push(taskId); },
  });

  it('fires once per projection change and stays quiet on identical rescans', async () => {
    driver.comments['issue-comments'] = [comment('c1', 'feedback')];
    const poller = pollerWithRevisions();
    await poller.poll();
    expect(revisions).toEqual(['task-1']);

    await poller.poll();
    expect(revisions).toEqual(['task-1']);

    driver.comments['issue-comments'] = [comment('c1', 'feedback edited')];
    await poller.poll();
    expect(revisions).toEqual(['task-1', 'task-1']);
  });

  it('delivers the assembled conversation payload (with bodies) alongside the revision bump', async () => {
    driver.comments['issue-comments'] = [comment('c1', 'top feedback')];
    driver.comments['reviews'] = [comment('r1', 'looks good', OLD_TS, { reviewState: 'COMMENTED' })];
    const conversations: Array<{ prNumber: number; payload: { items: Array<Record<string, unknown>>; error?: string } } | undefined> = [];
    const poller = makePoller({
      onConversationRevision: (taskId, conversation) => {
        revisions.push(taskId);
        conversations.push(conversation);
      },
    });
    await poller.poll();
    expect(revisions).toEqual(['task-1']);
    expect(conversations).toHaveLength(1);
    const conversation = conversations[0]!;
    expect(conversation.prNumber).toBe(42);
    expect(conversation.payload.error).toBeUndefined();
    const bodies = conversation.payload.items.map(item => [item.kind, item.body]);
    expect(bodies).toContainEqual(['issue-comment', 'top feedback']);
    expect(bodies).toContainEqual(['review', 'looks good']);
  });

  it('ignores pure row reordering across rescans', async () => {
    const a = comment('a1', 'first');
    const b = comment('b2', 'second');
    driver.comments['issue-comments'] = [a, b];
    const poller = pollerWithRevisions();
    await poller.poll();
    expect(revisions).toHaveLength(1);

    driver.comments['issue-comments'] = [b, a];
    await poller.poll();
    expect(revisions).toHaveLength(1);
  });

  it('bumps on a state-only change of an existing row', async () => {
    driver.comments['reviews'] = [comment('r1', 'looks good', OLD_TS, { reviewState: 'COMMENTED' })];
    const poller = pollerWithRevisions();
    await poller.poll();
    expect(revisions).toHaveLength(1);

    driver.comments['reviews'] = [comment('r1', 'looks good', OLD_TS, { reviewState: 'DISMISSED' })];
    await poller.poll();
    expect(revisions).toHaveLength(2);
  });

  it('bumps when only the revision time moves (same body re-submitted)', async () => {
    driver.comments['issue-comments'] = [comment('c1', 'same body', OLD_TS)];
    const poller = pollerWithRevisions();
    await poller.poll();
    expect(revisions).toHaveLength(1);

    driver.comments['issue-comments'] = [comment('c1', 'same body', iso(T0 - 60_000))];
    await poller.poll();
    expect(revisions).toHaveLength(2);
  });

  it('stays silent while any source fails and fires once on recovery', async () => {
    driver.comments['issue-comments'] = [comment('c1', 'feedback')];
    driver.comments['reviews'] = new Error('HTTP 500') as unknown as NormalizedRow[];
    const poller = pollerWithRevisions();
    await poller.poll();
    expect(revisions).toEqual([]);

    driver.comments['reviews'] = [];
    await poller.poll();
    expect(revisions).toEqual(['task-1']);
  });

  it('drops the projection baseline with the task generation so a re-adopting task starts fresh', async () => {
    driver.comments['issue-comments'] = [comment('c1', 'feedback')];
    const poller = pollerWithRevisions();
    await poller.poll();
    expect(revisions).toEqual(['task-1']);

    tasks = [{ taskId: 'task-1', terminal: true }];
    await poller.poll();

    tasks = [{ taskId: 'task-1', terminal: false, branch: 'bx/task-1', prNumber: 42, expectedBase: 'main' }];
    await poller.poll();
    expect(revisions).toEqual(['task-1', 'task-1']);
  });
});

describe('PlatformPoller: cursor commit notification', () => {
  it('notifies per source only after the cursor is durably committed', async () => {
    tasks = [{
      taskId: 'task-1', terminal: false, branch: 'bx/task-1', prNumber: 42,
      expectedBase: 'main', replyActorId: '77', replyActorStatus: 'verified',
    }];
    driver.prViews.set(42, prRow());
    driver.comments['issue-comments'] = [comment('c1', 'feedback', OLD_TS)];
    driver.comments['inline-comments'] = [];
    driver.comments['reviews'] = new Error('HTTP 500');
    const committed: Array<[string, number, string, number]> = [];
    const poller = makePoller({
      onCursorCommitted: (taskId, prNumber, sourceKey, watermarkTime) => {
        committed.push([taskId, prNumber, sourceKey, watermarkTime]);
      },
    });
    await poller.poll();
    const keys = committed.map(([, , key]) => key);
    expect(keys).toContain('issue-comments');
    expect(keys).not.toContain('reviews');
    for (const [taskId, prNumber, , watermark] of committed) {
      expect(taskId).toBe('task-1');
      expect(prNumber).toBe(42);
      expect(watermark).toBe(Date.parse(OLD_TS));
    }
  });
});
