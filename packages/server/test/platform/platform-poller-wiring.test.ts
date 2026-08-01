import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditPlatformBindings, platformEntries } from '../../src/platform/startup.js';
import { PlatformPoller, platformTaskView } from '../../src/platform/platform-poller.js';
import type { PlatformDriver } from '../../src/platform/types.js';
import { computePollerHealth } from '../../src/platform/poller-health.js';
import { applyConfigHotReload, prepareConfigHotReload } from '../../src/config/hot-reload.js';
import { createPlatformPollerOptions } from '../../src/index.js';
import type { AgentManager } from '../../src/agent/manager.js';
import type { EventBus } from '../../src/event/bus.js';
import type { BaxianConfig, ProjectConfig, TaskState } from '../../src/shared/index.js';

const driver = (): PlatformDriver => ({
  visibilityLagMs: 0,
  commentSources: [],
  runPreflightSteps: async () => [],
  projectView: async () => ({ defaultBranch: 'main', pushPermitted: true }),
  prView: async () => ({}),
  branchView: async () => ({}),
  listPrs: async () => [],
  listComments: async () => [],
  postComment: async () => undefined,
  mergePr: async () => undefined,
  closePr: async () => undefined,
  deleteBranch: async () => undefined,
});

const cfg = (projects: Array<Partial<ProjectConfig>>): BaxianConfig => ({
  server: { port: 3000 },
  review: { rounds: 3 },
  project: projects.map(p => ({ id: 'p', repo: 'https://github.com/a/b.git', merge: null, agent: [], ...p })),
} as BaxianConfig);

const deps = { driverFor: driver, statePathFor: (repoUrl: string) => `/state/${repoUrl}.json` };

const task = (over: Partial<TaskState> = {}): TaskState => ({
  id: 't1', projectId: 'p', title: 't', status: 'in_progress', createdAt: '', updatedAt: '', ...over,
} as TaskState);

describe('createPlatformPollerOptions', () => {
  it('routes every poller callback through the task owner and manager projection', async () => {
    const owned = task({ id: 'owned', projectId: 'owner-project', agentId: 'dev-1' });
    const manager = {
      getTask: vi.fn(async (taskId: string) => taskId === owned.id ? owned : null),
      listTasksForPlatformEntry: vi.fn(async () => [owned]),
      pruneConsumedFeedback: vi.fn(async () => undefined),
      noteReviewConversationRevision: vi.fn(async () => undefined),
    } as unknown as AgentManager;
    const emit = vi.fn(async () => undefined);
    const options = createPlatformPollerOptions(manager, { emit } as unknown as EventBus);

    await options.onEvent('entry-project', {
      type: 'pr.updated', taskId: owned.id, data: { headSha: 'a'.repeat(40) },
    });
    await options.onEvent('entry-project', { type: 'human.intervention', data: { phase: 'repo' } });
    expect(emit).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: 'pr.updated', projectId: 'owner-project', taskId: owned.id, agentId: 'dev-1',
    }));
    expect(emit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'human.intervention', projectId: 'entry-project',
    }));

    expect(await options.tasks('entry-project')).toEqual([platformTaskView(owned)]);
    expect(await options.task(owned.id)).toEqual(platformTaskView(owned));
    expect(await options.task('missing')).toBeNull();
    await options.onCursorCommitted!(owned.id, 42, 'reviews', 123);
    const conversation = { prNumber: 42, payload: { items: [] } };
    await options.onConversationRevision!(owned.id, conversation);
    expect(manager.listTasksForPlatformEntry).toHaveBeenCalledWith('entry-project');
    expect(manager.pruneConsumedFeedback).toHaveBeenCalledWith(owned.id, 'reviews', 123);
    expect(manager.noteReviewConversationRevision).toHaveBeenCalledWith(owned.id, conversation);
  });
});

describe('platformEntries', () => {
  it('builds one entry per validated project through the injected driver factory', () => {
    const entries = platformEntries(cfg([{}]), deps);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ projectId: 'p', repoUrl: 'https://github.com/a/b.git' });
    expect(entries[0]?.driver).toBeDefined();
  });
});

describe('auditPlatformBindings', () => {
  const platformCfg = cfg([{}]);

  it('reports an active task whose project was removed', async () => {
    const onMismatch = vi.fn();
    await auditPlatformBindings(platformCfg, async () => [task({
      projectId: 'removed',
      platformBinding: { repoKey: 'github.com/removed/repo' },
    })], onMismatch);
    expect(onMismatch).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }), expect.objectContaining({
      reason: 'project-missing', differences: ['project'],
    }));
  });

  it('reports an active task whose repository binding no longer matches', async () => {
    const onMismatch = vi.fn();
    await auditPlatformBindings(platformCfg, async () => [task({
      platformBinding: { repoKey: 'github.com/other/repo' },
    })], onMismatch);
    expect(onMismatch).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }), expect.objectContaining({
      reason: 'identity-mismatch', differences: ['repoKey'],
    }));
  });

  it('reports an active platform task that lacks its required binding', async () => {
    const onMismatch = vi.fn();
    await auditPlatformBindings(platformCfg, async () => [task()], onMismatch);
    expect(onMismatch).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }), expect.objectContaining({
      reason: 'missing-binding-snapshot', differences: ['repoKey'],
    }));
  });

  it('ignores matching and terminal tasks', async () => {
    const onMismatch = vi.fn();
    await auditPlatformBindings(platformCfg, async () => [
      task({ platformBinding: { repoKey: 'github.com/a/b' } }),
      task({ id: 'done', status: 'merged', platformBinding: { repoKey: 'github.com/other/repo' } }),
    ], onMismatch);
    expect(onMismatch).not.toHaveBeenCalled();
  });
});

describe('config hot reload platform interventions', () => {
  it('reconciles entries and emits active binding interventions', async () => {
    const validated = cfg([{ id: 'live', repo: 'https://github.com/a/b.git' }]);
    const removed = task({
      id: 'removed', projectId: 'removed-project',
      platformBinding: { repoKey: 'github.com/removed/repo' },
    });
    const retainKeys = vi.fn();
    const emitBinding = vi.fn(async () => undefined);
    const reconcile = vi.fn();
    const reschedule = vi.fn();
    const manager = {
      listActiveGitTasks: vi.fn(async () => [removed]),
      replaceConfig: vi.fn(),
      platformBindingInterventionKey: vi.fn((t: TaskState) => `binding:${t.id}`),
      retainPlatformBindingInterventionKeys: retainKeys,
      emitPlatformBindingIntervention: emitBinding,
    };
    const ctx = {
      agentManager: manager,
      poller: { reconcile, reschedule },
      platformEntryDeps: deps,
    } as never;

    const prepared = await prepareConfigHotReload(ctx, validated);
    expect(prepared.bindingMismatches).toEqual([
      expect.objectContaining({
        task: expect.objectContaining({ id: 'removed' }),
        mismatch: expect.objectContaining({ reason: 'project-missing' }),
      }),
    ]);
    expect(prepared.platform).toHaveLength(1);

    await applyConfigHotReload(ctx, validated, prepared);

    expect(reconcile).toHaveBeenCalledWith(prepared.platform);
    expect(retainKeys).toHaveBeenCalledWith(new Set(['binding:removed']));
    expect(emitBinding).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'removed' }),
      expect.objectContaining({ reason: 'project-missing' }),
    );
  });
});

describe('PlatformPoller.reconcile', () => {
  const poller = (): PlatformPoller => new PlatformPoller({
    onEvent: () => undefined,
    tasks: async () => [],
    task: async () => null,
  });

  it('adds, keeps and removes entries to match the planned set', () => {
    const p = poller();
    p.reconcile([
      { projectId: 'a', repoUrl: 'https://github.com/o/a.git', driver: driver(), statePath: '/s/a' },
      { projectId: 'b', repoUrl: 'https://github.com/o/b.git', driver: driver(), statePath: '/s/b' },
    ]);
    p.reconcile([
      { projectId: 'a2', repoUrl: 'git@github.com:o/a.git', driver: driver(), statePath: '/s/a' },
      { projectId: 'c', repoUrl: 'https://github.com/o/c.git', driver: driver(), statePath: '/s/c' },
    ]);
    expect(p.snapshots().map(s => s.projectId).sort()).toEqual(['a2', 'c']);
  });

  it('keeps preflight state when hot reload reconstructs the fixed driver', () => {
    const p = poller();
    p.reconcile([{ projectId: 'a', repoUrl: 'https://github.com/o/a.git', driver: driver(), statePath: '/s/a' }]);
    const entries = p['entries'] as Array<{ driver: PlatformDriver; preflightPassed?: boolean }>;
    entries[0].preflightPassed = true;
    p.reconcile([{ projectId: 'a', repoUrl: 'https://github.com/o/a.git', driver: driver(), statePath: '/s/a' }]);
    expect(entries[0].preflightPassed).toBe(true);
  });

  it('keeps preflight state when the driver instance is unchanged', () => {
    const p = poller();
    const d = driver();
    p.reconcile([{ projectId: 'a', repoUrl: 'https://github.com/o/a.git', driver: d, statePath: '/s/a' }]);
    const entries = p['entries'] as Array<{ preflightPassed?: boolean }>;
    entries[0].preflightPassed = true;
    p.reconcile([{ projectId: 'a', repoUrl: 'https://github.com/o/a.git', driver: d, statePath: '/s/a' }]);
    expect(entries[0].preflightPassed).toBe(true);
  });

  it('preserves the observation state of a surviving entry while swapping its driver', () => {
    const p = poller();
    const first = driver();
    const second = driver();
    p.reconcile([{ projectId: 'a', repoUrl: 'https://github.com/o/a.git', driver: first, statePath: '/s/a' }]);
    const entries = p['entries'] as Array<{ driver: PlatformDriver; observedPr: Map<string, unknown> }>;
    entries[0].observedPr.set('t1:7', { merged: true });
    p.reconcile([{ projectId: 'a', repoUrl: 'https://github.com/o/a.git', driver: second, statePath: '/s/a' }]);
    expect(entries[0].driver).toBe(second);
    expect(entries[0].observedPr.get('t1:7')).toEqual({ merged: true });
  });

  it('applies a reconstructed driver only after the in-flight cycle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bx-poller-swap-'));
    try {
      let releasePreflight!: () => void;
      let markPreflightStarted!: () => void;
      const preflightStarted = new Promise<void>(resolve => { markPreflightStarted = resolve; });
      const preflightGate = new Promise<void>(resolve => { releasePreflight = resolve; });
      const oldDriver: PlatformDriver = {
        ...driver(),
        runPreflightSteps: vi.fn(async () => {
          markPreflightStarted();
          await preflightGate;
          return [{ step: 'old', ok: true, message: 'ok' }];
        }),
        projectView: vi.fn(async () => ({ defaultBranch: 'main', pushPermitted: true })),
        listPrs: vi.fn(async () => []),
      };
      const newDriver: PlatformDriver = {
        ...driver(),
        runPreflightSteps: vi.fn(async () => [{ step: 'new', ok: true, message: 'ok' }]),
        projectView: vi.fn(async () => ({ defaultBranch: 'main', pushPermitted: true })),
        listPrs: vi.fn(async () => []),
      };
      const p = poller();
      const entry = { projectId: 'a', repoUrl: 'https://github.com/o/a.git', driver: oldDriver, statePath: join(dir, 'cursor.json') };
      p.reconcile([entry]);

      const inFlight = p.poll();
      await preflightStarted;
      p.reconcile([{ ...entry, projectId: 'a2', driver: newDriver }]);
      releasePreflight();
      await inFlight;

      expect(oldDriver.listPrs).toHaveBeenCalledTimes(1);
      expect(newDriver.runPreflightSteps).not.toHaveBeenCalled();
      const entries = p['entries'] as Array<{ projectId: string; driver: PlatformDriver; preflightPassed?: boolean }>;
      expect(entries[0]).toMatchObject({ projectId: 'a2', driver: newDriver, preflightPassed: true });

      await p.poll();
      expect(newDriver.runPreflightSteps).not.toHaveBeenCalled();
      expect(newDriver.listPrs).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('notifies the lifecycle hook so the poller snapshot topic republishes', () => {
    const p = poller();
    const hook = vi.fn();
    p.setLifecycleHook(hook);
    p.reconcile([{ projectId: 'a', repoUrl: 'https://github.com/o/a.git', driver: driver(), statePath: '/s/a' }]);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('keeps serving snapshots after every entry is dropped', () => {
    const p = poller();
    p.reconcile([{ projectId: 'a', repoUrl: 'https://github.com/o/a.git', driver: driver(), statePath: '/s/a' }]);
    p.reconcile([]);
    expect(p.snapshots()).toEqual([]);
  });

  it('polls entries in declaration order, isolates failures, and keeps later entries moving', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bx-poller-multi-'));
    try {
      const calls: string[] = [];
      const makeDriver = (name: string, fail = false): PlatformDriver => ({
        visibilityLagMs: 0,
        commentSources: [],
        runPreflightSteps: async () => [],
        projectView: vi.fn(async () => {
          calls.push(`${name}:project`);
          if (fail) throw new Error(`${name} offline`);
          return { defaultBranch: 'main', pushPermitted: true };
        }),
        listPrs: vi.fn(async () => {
          calls.push(`${name}:list`);
          return [];
        }),
        listComments: vi.fn(async () => []),
      });
      const p = poller();
      p.reconcile(['a', 'b', 'c'].map((name, index) => ({
        projectId: name,
        repoUrl: `https://github.com/o/${name}.git`,
        driver: makeDriver(name, index === 0),
        statePath: join(dir, `${name}.json`),
      })));

      await p.poll();

      expect(calls).toEqual(['a:project', 'a:list', 'b:project', 'b:list', 'c:project', 'c:list']);
      expect(p.snapshots().map(snapshot => [snapshot.projectId, snapshot.consecutiveFailures]))
        .toEqual([['a', 1], ['b', 0], ['c', 0]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('retires an in-flight entry before it can emit or commit after reconcile removes it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bx-poller-retire-'));
    try {
      let releaseList!: () => void;
      let markListStarted!: () => void;
      const listStarted = new Promise<void>(resolve => { markListStarted = resolve; });
      const listGate = new Promise<void>(resolve => { releaseList = resolve; });
      const retiringDriver: PlatformDriver = {
        visibilityLagMs: 0,
        commentSources: [],
        runPreflightSteps: async () => [],
        projectView: vi.fn(async () => ({ defaultBranch: 'main', pushPermitted: true })),
        listPrs: vi.fn(async () => {
          markListStarted();
          await listGate;
          return [{
            prNumber: 42, prUrl: 'https://github.com/o/a/pull/42', branch: 'bx/t1',
            headSha: 'a'.repeat(40), state: 'open', draft: false,
            sourceProjectId: '1', targetProjectId: '1', targetBranch: 'main',
            createdAt: '2026-07-21T00:00:00Z', updatedAt: '2026-07-21T00:00:00Z',
          }];
        }),
        listComments: vi.fn(async () => []),
      };
      const onEvent = vi.fn();
      const p = new PlatformPoller({
        onEvent,
        tasks: async () => [{
          taskId: 't1', terminal: false, branch: 'bx/t1', expectedBase: 'main',
        }],
        task: async taskId => ({ taskId, terminal: false, branch: `bx/${taskId}` }),
      });
      p.reconcile([{
        projectId: 'a', repoUrl: 'https://github.com/o/a.git', driver: retiringDriver,
        statePath: join(dir, 'a.json'),
      }]);

      const inFlight = p.poll();
      await listStarted;
      p.reconcile([]);
      releaseList();
      await inFlight;

      expect(onEvent).not.toHaveBeenCalled();
      expect(p.snapshots()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persists a delivered adoption even when the entry retires while its event is being handled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bx-poller-retire-delivered-'));
    try {
      let releaseEvent!: () => void;
      let markEventStarted!: () => void;
      const eventStarted = new Promise<void>(resolve => { markEventStarted = resolve; });
      const eventGate = new Promise<void>(resolve => { releaseEvent = resolve; });
      const row = {
        prNumber: 42, prUrl: 'https://github.com/o/a/pull/42', branch: 'bx/t1',
        headSha: 'a'.repeat(40), state: 'open', draft: false,
        sourceProjectId: '1', targetProjectId: '1', targetBranch: 'main',
        createdAt: '2026-07-21T00:00:00Z', updatedAt: '2026-07-21T00:00:00Z',
      };
      const adoptingDriver: PlatformDriver = {
        visibilityLagMs: 0,
        commentSources: [],
        runPreflightSteps: async () => [],
        projectView: vi.fn(async () => ({ defaultBranch: 'main', pushPermitted: true })),
        listPrs: vi.fn(async () => [row]),
        listComments: vi.fn(async () => []),
      };
      const taskView: PlatformTaskView = {
        taskId: 't1', terminal: false, branch: 'bx/t1', expectedBase: 'main',
      };
      const statePath = join(dir, 'a.json');
      const onEvent = vi.fn(async () => {
        markEventStarted();
        await eventGate;
        taskView.prNumber = 42;
      });
      const first = new PlatformPoller({
        onEvent,
        tasks: async () => [taskView],
        task: async () => taskView,
      });
      first.reconcile([{ projectId: 'a', repoUrl: 'https://github.com/o/a.git', driver: adoptingDriver, statePath }]);

      const inFlight = first.poll();
      await eventStarted;
      first.reconcile([]);
      releaseEvent();
      await inFlight;
      expect(onEvent).toHaveBeenCalledTimes(1);
      taskView.prNumber = undefined;

      const replay = vi.fn();
      const restarted = new PlatformPoller({
        onEvent: replay,
        tasks: async () => [taskView],
        task: async () => taskView,
      });
      restarted.reconcile([{ projectId: 'a', repoUrl: 'https://github.com/o/a.git', driver: adoptingDriver, statePath }]);
      await restarted.poll();
      expect(replay).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fires lifecycle at cycle start and end and isolates hook failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bx-poller-hook-'));
    try {
      const p = poller();
      p.reconcile([{
        projectId: 'a', repoUrl: 'https://github.com/o/a.git', driver: {
          ...driver(),
          projectView: async () => ({ defaultBranch: 'main', pushPermitted: true }),
        },
        statePath: join(dir, 'a.json'),
      }]);
      const hook = vi.fn(() => { throw new Error('render failed'); });
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      p.setLifecycleHook(hook);

      await expect(p.poll()).resolves.toBeUndefined();

      expect(hook).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenCalledTimes(2);
      expect(p.snapshots()[0]).toMatchObject({ isPolling: false, health: 'healthy' });
      error.mockRestore();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('wires start, reschedule, and stop to the running timer', async () => {
    vi.useFakeTimers();
    try {
      const p = poller();
      const run = vi.spyOn(p, 'poll').mockResolvedValue();
      p.start(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(run).toHaveBeenCalledTimes(1);

      p.reschedule(2_000);
      run.mockClear();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(1);

      p.stop();
      run.mockClear();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('computePollerHealth', () => {
  it('distinguishes never-run, healthy, degraded, and failed thresholds', () => {
    expect(computePollerHealth(0, undefined)).toBe('unknown');
    expect(computePollerHealth(0, '2026-07-21T00:00:00Z')).toBe('healthy');
    expect(computePollerHealth(1, '2026-07-21T00:00:00Z')).toBe('degraded');
    expect(computePollerHealth(2, '2026-07-21T00:00:00Z')).toBe('degraded');
    expect(computePollerHealth(3, '2026-07-21T00:00:00Z')).toBe('failed');
  });
});

describe('platformTaskView', () => {
  it('marks a task in the review window and carries its verdict pair', () => {
    const view = platformTaskView(task({
      status: 'review', branch: 'bx/t1', prNumber: 7, reviewHeadAnchorSha: 'a'.repeat(40),
      passToken: 'pass', failToken: 'fail', signalToken: 'sig', baseBranch: 'main',
    }));
    expect(view).toMatchObject({
      taskId: 't1', terminal: false, status: 'review', inReview: true, prNumber: 7,
      anchorSha: 'a'.repeat(40), passToken: 'pass', failToken: 'fail', expectedBase: 'main',
    });
  });

  it('closes the verdict window outside review while the task is still live', () => {
    expect(platformTaskView(task({ status: 'fixing' }))).toMatchObject({ inReview: false, terminal: false });
  });

  it('reports a terminal task so the poller stops adopting for it', () => {
    expect(platformTaskView(task({ status: 'cancelled' })).terminal).toBe(true);
  });

  it('drops a cleared close anchor so a reopen is not synthesized twice', () => {
    expect(platformTaskView(task({ closedUnmergedAnchor: { prNumber: 7, generation: 2, cleared: true } })))
      .toMatchObject({ closedUnmergedAnchor: false });
    expect(platformTaskView(task({ closedUnmergedAnchor: { prNumber: 7, generation: 2 } })))
      .toMatchObject({ closedUnmergedAnchor: true });
  });

  it('omits absent optional fields instead of publishing undefined values', () => {
    expect(Object.keys(platformTaskView(task())).sort())
      .toEqual(['closedUnmergedAnchor', 'inReview', 'status', 'taskId', 'terminal']);
  });
});
