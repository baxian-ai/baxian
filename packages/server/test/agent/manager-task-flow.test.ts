import { describe, it, expect, vi } from 'vitest';
import type { TaskState } from '../../src/shared/index.js';
import { DispatchTerminalError } from '../../src/agent/manager.js';
import { BranchManager } from '../../src/agent/branch.js';
import type { RepoStore } from '../../src/agent/repo-store.js';
import type { PaneStreamerManager } from '../../src/agent/pane-streamer-manager.js';
import type { SubscriberCallbacks } from '../../src/agent/pane-streamer.js';
import type { PhaseSignalWatcher } from '../../src/agent/phase-signal-watcher.js';
import { createManagerSuiteRunner, useManagerSuiteHarness } from '../helpers/manager-harness.js';
import { fakeRunner, type FakeRunner, type FakeRunnerOptions } from '../helpers/fake-runner.js';
import { makeTask } from '../helpers/fixtures.js';

const NOW = '2026-05-14T05:00:00.000Z';
// 既不是 ready 也不是信任对话框的启动遮挡:ensureSession 把它报成 dialogPending + handled
const STARTUP_DIALOG = 'Auto-updating…\nPress enter to continue\n';

const harness = useManagerSuiteHarness();

type ManagerOverrides = Parameters<typeof harness.createManager>[0];

const cmdsOf = (runner: FakeRunner = harness.runner): string[] => runner.exec.mock.calls.map(c => c[0] as string);
const escapesTo = (paneId: string, runner: FakeRunner = harness.runner): string[] =>
  runner.sentKeys.filter(k => k.includes(`-t ${paneId} `) && k.includes("'Escape'"));
const dispatchRollbackEvents = () => harness.events.filter(
  e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'dispatch-rollback',
);
const escapeFails = { match: (cmd: string) => cmd.includes("'Escape'"), reply: { exitCode: 1, stderr: 'tmux: send-keys failed' } };

function useRunner(options: FakeRunnerOptions = {}, overrides: ManagerOverrides = {}): FakeRunner {
  const runner = createManagerSuiteRunner(options);
  harness.manager = harness.createManager({ ...overrides, runnerFactory: () => runner });
  return runner;
}

// Workdir 准备是 live runtime 之外唯一的 git 边界(spec E4):替身决定它的结果,也是 ensureWorkdir 期间交错动作的挂钩点
function useWorkdirStandIn(ensure: () => Promise<string>): void {
  harness.manager = harness.createManager({
    repoStoreFactory: () => ({ ensure, refresh: async () => undefined }) as unknown as RepoStore,
  });
}

function fakeStreamer() {
  const subscribers: Array<NonNullable<SubscriberCallbacks['onVisible']>> = [];
  const streamer = {
    subscribeAtomic: async (cbs: SubscriberCallbacks) => {
      if (cbs.onVisible) subscribers.push(cbs.onVisible);
      return { snapshot: { data: '', cols: 80, rows: 24 }, snapshotSeq: 0, unsubscribe: () => undefined };
    },
  };
  return { subscribers, paneStreamerManager: { ensure: () => streamer } as unknown as PaneStreamerManager };
}

function watcherStandIn(start: () => Promise<boolean>) {
  const startSpy = vi.fn(start);
  const stop = vi.fn();
  const watcher = {
    start: startSpy,
    stop,
    stopIfToken: vi.fn(),
    has: () => false,
    isSettling: () => false,
    rearmNeedInput: async () => new Set<string>(),
  } as unknown as PhaseSignalWatcher;
  return { watcher, start: startSpy, stop };
}

async function boundTaskId(agentId = 'dev-1'): Promise<string> {
  return (await harness.agentStore.get(agentId))?.taskId ?? '';
}

async function cancelBoundTaskInStore(agentId = 'dev-1'): Promise<void> {
  const task = (await harness.taskStore.get(await boundTaskId(agentId)))!;
  await harness.taskStore.set({ ...task, status: 'cancelled', updatedAt: NOW });
}

describe('AgentManager task binding flow', () => {
  it('createTask binds a free preferred dev and holds its lock', async () => {
    await harness.seedAgent({ id: 'dev-1' });

    const created = await harness.manager.createTask('proj', {
      title: 'build it',
      description: 'details',
      preferredAgentId: 'dev-1',
    });

    expect(created.status).toBe('in_progress');
    expect(created.agentId).toBe('dev-1');
    expect(created.devAgentId).toBe('dev-1');
    expect(created.qaAgentId).toBe('qa-1');
    expect(created.phase).toBeUndefined();
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBe(created.id);
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
    expect(harness.events.some(e => e.type === 'task.assigned' && e.agentId === 'dev-1')).toBe(true);
  });

  // createTask 不经 tmux/git:交错点只能挂在 pickAgent 的绑定读取上,读完立刻 bump
  function bumpGenerationAfterBindingRead(agentId: string): void {
    const realGet = harness.agentStore.get.bind(harness.agentStore);
    vi.spyOn(harness.agentStore, 'get').mockImplementationOnce(async (id) => {
      const state = await realGet(id);
      harness.manager.bumpDeletionGeneration(agentId);
      return state;
    });
  }

  it('createTask rejects the binding when a DELETE→recreate bumps the generation during config reads', async () => {
    await harness.seedAgent({ id: 'dev-1' });
    bumpGenerationAfterBindingRead('dev-1');

    const result = await harness.manager.createTask('proj', {
      title: 'racy', description: 'd', preferredAgentId: 'dev-1',
    });

    expect(result.status).toBe('pending');
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
  });

  it('createTask rejects the queued early-return when a DELETE→recreate bumps the generation (no stale participants persisted)', async () => {
    await harness.seedAgent({ id: 'dev-1', taskId: 'other-task' });
    bumpGenerationAfterBindingRead('dev-1');

    await expect(harness.manager.createTask('proj', {
      title: 'racy queued', description: 'd', preferredAgentId: 'dev-1',
    })).rejects.toThrow(/deleted or recreated/);
    expect(await harness.taskStore.list()).toEqual([]);
  });

  it('createTask queued early-return rejects when a team member (QA) is being deleted, even with the dev generation unchanged', async () => {
    await harness.seedAgent({ id: 'dev-1', taskId: 'other-task' });
    harness.manager.tryClaimDeletion(['qa-1']);

    await expect(harness.manager.createTask('proj', {
      title: 'qa-deleting', description: 'd', preferredAgentId: 'dev-1',
    })).rejects.toThrow(/being deleted or recreated/);
  });

  it('createTask does not create an active task when the lock is rotated away after the binding commit (binding-before-active)', async () => {
    await harness.seedAgent({ id: 'dev-1' });
    vi.spyOn(harness.lockManager, 'isOwner').mockResolvedValue(false);

    const result = await harness.manager.createTask('proj', { title: 't', description: 'd', preferredAgentId: 'dev-1' });

    expect(result.status).toBe('pending');
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
  });

  it('createTask does not create an active task when a team participant (QA) is deleted+recreated after the snapshot', async () => {
    await harness.seedAgent({ id: 'dev-1' });
    const realAcquire = harness.lockManager.acquire.bind(harness.lockManager);
    vi.spyOn(harness.lockManager, 'acquire').mockImplementation(async (id: string, taskId: string) => {
      const token = await realAcquire(id, taskId);
      harness.manager.bumpDeletionGeneration('qa-1');
      return token;
    });

    const result = await harness.manager.createTask('proj', { title: 't', description: 'd', preferredAgentId: 'dev-1' });

    expect(result.status).toBe('pending');
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
  });

  it('scanOpenThenClaimDeletion serializes with createTask: a racing delete-claim cannot orphan the in_progress write', async () => {
    await harness.seedAgent({ id: 'dev-1' });
    const create = harness.manager.createTask('proj', { title: 't', description: 'd', preferredAgentId: 'dev-1' });
    const claim = harness.manager.scanOpenThenClaimDeletion(['dev-1']);
    const [created, claimResult] = await Promise.all([create, claim]);

    expect(created.status).toBe('in_progress');
    expect(claimResult).toEqual({ ok: false, code: 'active', agentId: 'dev-1', taskId: created.id });
    expect(harness.manager.isDeletionInFlight('dev-1')).toBe(false);
  });

  it('a delete-claim that wins the task lock forces a racing createTask to reject (no active task on a claimed agent)', async () => {
    await harness.seedAgent({ id: 'dev-1' });
    const claim = harness.manager.scanOpenThenClaimDeletion(['dev-1']);
    const create = harness.manager.createTask('proj', { title: 't', description: 'd', preferredAgentId: 'dev-1' });

    await expect(create).rejects.toThrow(/being deleted or recreated/);
    expect(await claim).toEqual({ ok: true });
    expect(harness.manager.isDeletionInFlight('dev-1')).toBe(true);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('ensureSession refuses and skips the Workdir state-write when a DELETE→recreate bumps the generation mid-flight', async () => {
    await harness.seedAgent({ id: 'dev-1' });
    useWorkdirStandIn(async () => {
      harness.manager.bumpDeletionGeneration('dev-1');
      return '/tmp/stale-workdir';
    });

    await expect(harness.manager.ensureSession('dev-1', 'runtime')).rejects.toThrow(/being deleted|recreated/);
    expect((await harness.agentStore.get('dev-1'))?.workdir).not.toBe('/tmp/stale-workdir');
  });

  it('ensureSession re-gates after the tmux probe: a DELETE tombstone during getSessionSnapshot blocks build/adopt', async () => {
    await harness.seedAgent({ id: 'dev-1' });
    const runner = useRunner({
      session: 'absent',
      onExec: cmd => { if (cmd.includes('list-sessions')) harness.manager.tryClaimDeletion(['dev-1']); },
    });

    await expect(harness.manager.ensureSession('dev-1', 'runtime')).rejects.toThrow(/being deleted|recreated/);

    expect(cmdsOf(runner).some(c => c.includes('list-sessions'))).toBe(true);
    expect(cmdsOf(runner).some(c => c.includes('new-session'))).toBe(false);
    expect(runner.sessions.present('dev-1')).toBe(false);
  });

  it('reconcileTaskBranches skips branch cleanup when a DELETE→recreate bumps the generation during the ref scan', async () => {
    await harness.seedTask({ id: 'rtb-1', status: 'merged', branch: 'bx/rtb-1', branchCreatedByBaxian: true, agentId: 'dev-1' });
    await harness.seedAgent({ id: 'dev-1', workdir: '/repo/wt' });
    const runner = fakeRunner({
      rules: [{
        match: 'for-each-ref',
        reply: () => {
          harness.manager.bumpDeletionGeneration('dev-1');
          return { stdout: 'refs/heads/bx/rtb-1\n' };
        },
      }],
    });
    harness.manager = harness.createManager({ runnerFactory: () => runner });

    await harness.manager.reconcileTaskBranches();

    const cmds = cmdsOf(runner);
    expect(cmds.some(c => c.includes('for-each-ref'))).toBe(true);
    expect(cmds.some(c => c.includes('show-ref --verify'))).toBe(false);
    expect(cmds.some(c => /branch\s+-[dD]\b/.test(c))).toBe(false);
  });

  it('createTask records the QA partner before any review dispatch', async () => {
    await harness.seedAgent({ id: 'dev-1' });

    const created = await harness.manager.createTask('proj', {
      title: 'bind the team',
      description: 'details',
      preferredAgentId: 'dev-1',
    });

    expect(created).toMatchObject({
      agentId: 'dev-1',
      qaAgentId: 'qa-1',
      status: 'in_progress',
      reviewRound: 0,
    });
    expect((await harness.taskStore.get(created.id))?.qaAgentId).toBe('qa-1');
  });

  it('createTask queues when preferred dev has a creation token or task binding', async () => {
    await harness.seedAgent({ id: 'dev-1', creationToken: 'tok' });
    const pendingDuringCreate = await harness.manager.createTask('proj', {
      title: 'blocked',
      description: 'details',
      preferredAgentId: 'dev-1',
    });
    expect(pendingDuringCreate.status).toBe('pending');

    await harness.seedAgent({ id: 'dev-1', taskId: 'other-task' });
    const pendingWhileBound = await harness.manager.createTask('proj', {
      title: 'blocked again',
      description: 'details',
      preferredAgentId: 'dev-1',
    });
    expect(pendingWhileBound.status).toBe('pending');
  });

  it('serializes concurrent createTask calls so only one task binds the preferred dev', async () => {
    await harness.seedAgent({ id: 'dev-1' });

    const [first, second] = await Promise.all([
      harness.manager.createTask('proj', {
        title: 'first',
        description: 'details',
        preferredAgentId: 'dev-1',
      }),
      harness.manager.createTask('proj', {
        title: 'second',
        description: 'details',
        preferredAgentId: 'dev-1',
      }),
    ]);

    const bound = [first, second].filter(t => t.status === 'in_progress');
    const queued = [first, second].filter(t => t.status === 'pending');
    expect(bound).toHaveLength(1);
    expect(queued).toHaveLength(1);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBe(bound[0].id);
  });

  it('safeEmit failures do not block createTask state transitions', async () => {
    await harness.seedAgent({ id: 'dev-1' });
    vi.spyOn(harness.eventBus, 'emit').mockRejectedValueOnce(new Error('event log down'));

    const created = await harness.manager.createTask('proj', {
      title: 'build it',
      description: 'details',
      preferredAgentId: 'dev-1',
    });

    expect(created.status).toBe('in_progress');
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBe(created.id);
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });

  it('createTask stores custom branch in TaskState', async () => {
    await harness.seedAgent({ id: 'dev-1' });
    const created = await harness.manager.createTask('proj', {
      title: 'custom branch',
      description: 'details',
      preferredAgentId: 'dev-1',
      branch: 'feat/my-feature',
    });
    expect(created.branch).toBe('feat/my-feature');
  });

  it('createTask rejects custom branch starting with reserved bx/ prefix', async () => {
    await harness.seedAgent({ id: 'dev-1' });
    await expect(harness.manager.createTask('proj', {
      title: 'reserved prefix',
      description: 'details',
      preferredAgentId: 'dev-1',
      branch: 'bx/task-other',
    })).rejects.toThrow(/reserved prefix/);
  });

  it.each([
    '-flag-like',
    'feat/../escape',
    'feat@{0}',
    'feat/.hidden',
    'feat/foo.lock',
    'feat/',
    'feat//x',
    'feat/x.',
  ])('createTask rejects git-invalid branch name: %s', async (branch) => {
    await harness.seedAgent({ id: 'dev-1' });
    await expect(harness.manager.createTask('proj', {
      title: 'bad branch',
      description: 'details',
      preferredAgentId: 'dev-1',
      branch,
    })).rejects.toThrow(/Invalid branch name/);
  });

  it('createTask rejects duplicate custom branch within the same project', async () => {
    await harness.seedAgent({ id: 'dev-1' });
    await harness.manager.createTask('proj', {
      title: 'first',
      description: 'details',
      preferredAgentId: 'dev-1',
      branch: 'feat/unique',
    });

    await harness.seedAgent({ id: 'dev-1' });
    await expect(harness.manager.createTask('proj', {
      title: 'second',
      description: 'details',
      preferredAgentId: 'dev-1',
      branch: 'feat/unique',
    })).rejects.toThrow(/already bound to task/);
  });

  it('createTask allows the same custom branch name in different repos', async () => {
    harness.manager = harness.createManager({
      config: {
        ...harness.config,
        project: [
          { id: 'proj-a', repo: 'https://github.com/user/repo-a.git', merge: null, agent: [] },
          { id: 'proj-b', repo: 'https://github.com/user/repo-b.git', merge: null, agent: [] },
        ],
      },
    });
    await harness.taskStore.set(makeTask({
      id: 'task-other-repo',
      projectId: 'proj-a',
      preferredAgentId: '',
      agentId: '',
      branch: 'feat/shared',
      branchCreatedByBaxian: false,
    }));

    const created = await harness.manager.createTask('proj-b', {
      title: 'same name in another repo',
      description: 'details',
      preferredAgentId: '',
      branch: 'feat/shared',
    });

    expect(created).toMatchObject({ projectId: 'proj-b', branch: 'feat/shared', status: 'pending' });
  });

  it('cancelTask interrupts both panes, then releases dev and qa after cancelling the task', async () => {
    const t = await harness.seedTask({ qaAgentId: 'qa-1' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });

    const cancelled = await harness.manager.cancelTask(t.id);

    expect(cancelled.status).toBe('cancelled');
    expect(escapesTo('%0')).toHaveLength(1);
    expect(escapesTo('%1')).toHaveLength(1);
    for (const id of ['dev-1', 'qa-1']) {
      const state = await harness.agentStore.get(id);
      expect(state?.taskId).toBeUndefined();
      expect(state?.status).toBeUndefined();
      expect(await harness.lockManager.isLocked(id)).toBe(false);
    }
  });

  it('cancelTask on a terminal task still interrupts and releases stale bound agents without rewriting the status', async () => {
    await harness.seedTask({ id: 'task-term', status: 'merged', agentId: 'dev-1', qaAgentId: 'qa-1', updatedAt: NOW });
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-term', paneId: '%0' });
    await harness.seedAgent({ id: 'qa-1', taskId: 'task-term', paneId: '%1' });

    const result = await harness.manager.cancelTask('task-term');

    expect(result.status).toBe('merged');
    expect(escapesTo('%0')).toHaveLength(1);
    expect(escapesTo('%1')).toHaveLength(1);
    expect(await harness.taskStore.get('task-term')).toMatchObject({ status: 'merged', updatedAt: NOW });
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await harness.agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(harness.events.some(e => e.type === 'task.updated' && e.taskId === 'task-term')).toBe(false);
  });

  it('cancelTask on a terminal task with no live bindings is a clean no-op', async () => {
    await harness.seedTask({ id: 'task-term2', status: 'cancelled', agentId: 'dev-1', updatedAt: NOW });
    await harness.seedAgent({ id: 'dev-1' });

    const result = await harness.manager.cancelTask('task-term2');

    expect(result.status).toBe('cancelled');
    expect(harness.runner.sentKeys).toEqual([]);
    expect((await harness.taskStore.get('task-term2'))?.updatedAt).toBe(NOW);
  });

  it('cancelTask refuses (409) while a complete verdict is still merging', async () => {
    await harness.seedTask({
      id: 'task-term3', status: 'max_rounds', phase: 'code', prNumber: 5, branch: 'bx/task-term3',
      latestHeadSha: 'a'.repeat(40),
      agentId: 'dev-1', devAgentId: 'dev-1', qaAgentId: 'qa-1',
    });
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-term3' });
    let release!: () => void;
    const merging = new Promise<void>(resolve => { release = resolve; });
    const merge = vi.spyOn(harness.manager, 'platformConfirmMerge').mockImplementation(() => merging);

    const completing = harness.manager.markTaskComplete('task-term3');
    await vi.waitFor(() => expect(merge).toHaveBeenCalledTimes(1));
    await expect(harness.manager.cancelTask('task-term3')).rejects.toMatchObject({ status: 409 });

    release();
    await completing;
    expect((await harness.taskStore.get('task-term3'))?.status).toBe('merge-ready');
  });

  it('re-clicking cancel on a cancelled task retries a failed interrupt cleanup and frees the held agent', async () => {
    await harness.seedTask({ id: 'task-term4', status: 'cancelled', agentId: 'dev-1', updatedAt: NOW });
    await harness.seedAgent({
      id: 'dev-1',
      taskId: 'task-term4',
      paneId: '%0',
      status: 'awaiting_human',
      awaitingPhase: 'cancel-interrupt-failed',
    });

    await harness.manager.cancelTask('task-term4');

    expect(escapesTo('%0')).toHaveLength(1);
    const dev = await harness.agentStore.get('dev-1');
    expect(dev?.taskId).toBeUndefined();
    expect(dev?.status).toBeUndefined();
  });

  it('cancelTask stops the watcher again after the cancelled write (closes rollback re-arm race)', async () => {
    const { watcher, stop } = watcherStandIn(async () => true);
    const m = harness.createManager({ phaseSignalWatcher: watcher });
    const t = await harness.seedTask({ qaAgentId: 'qa-1' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });

    await m.cancelTask(t.id);

    expect(stop.mock.calls.filter(c => c[0] === t.id)).toHaveLength(2);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await harness.agentStore.get('qa-1'))?.taskId).toBeUndefined();
  });

  it('cancelTask releases a bound dev through the real release path without task-lock deadlock', async () => {
    const t = await harness.seedTask();
    await harness.seedAgent({
      id: 'dev-1',
      taskId: t.id,
      paneId: '%0',
    });

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('cancelTask timed out')), 1_500);
    });
    const cancelled = await Promise.race([harness.manager.cancelTask(t.id), timeout]);

    expect(cancelled.status).toBe('cancelled');
    const state = await harness.agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(state?.paneId).toBe('%0');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
  });

  // Workdir 准备失败让 startSession 在 tmux 之前就倒下:`during` 在失败前执行交错动作
  const failDispatch = (during: (taskId: string) => Promise<void> = async () => undefined, message = 'boot failed') =>
    useWorkdirStandIn(async () => {
      await during(await boundTaskId());
      throw new Error(message);
    });
  const createOnDev1 = () => harness.manager.createAndStartTask('proj', {
    title: 'T', description: 'D', preferredAgentId: 'dev-1',
  });

  it('a failed dispatch rolls the task back to pending, unbinds the dev, releases its lock, and keeps its pane/workdir', async () => {
    await harness.seedAgent({ id: 'dev-1', workdir: '/tmp/wt', paneId: '%0' });
    failDispatch();

    const created = await createOnDev1();

    expect(created.status).toBe('pending');
    const state = await harness.agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(state?.workdir).toBe('/tmp/wt');
    expect(state?.paneId).toBe('%0');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
    expect(harness.runner.pastedPrompts).toEqual([]);
  });

  it('a failed dispatch still rolls back and releases the lock when the agent state vanished mid-bootstrap', async () => {
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });
    failDispatch(async () => { await harness.agentStore.delete('dev-1'); });

    const created = await createOnDev1();

    expect(created.status).toBe('pending');
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
  });

  it('a failed dispatch does not resurrect agent state deleted by a DELETE→recreate during the rollback', async () => {
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });
    failDispatch(async () => {
      const realSet = harness.taskStore.set.bind(harness.taskStore);
      vi.spyOn(harness.taskStore, 'set').mockImplementationOnce(async (task) => {
        await realSet(task);
        harness.manager.bumpDeletionGeneration('dev-1');
        await harness.agentStore.delete('dev-1');
      });
    });

    await createOnDev1();

    expect(await harness.agentStore.get('dev-1')).toBeNull();
  });

  it('a failed dispatch whose task already left in_progress raises no dispatch-rollback intervention', async () => {
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });
    failDispatch(async (taskId) => {
      const t = (await harness.taskStore.get(taskId))!;
      await harness.taskStore.set({ ...t, status: 'review', updatedAt: NOW });
    });

    await createOnDev1();

    expect(dispatchRollbackEvents()).toEqual([]);
  });

  it('a failed dispatch cannot roll back over a newer lock generation taken for the same task', async () => {
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });
    let newToken: string | null = null;
    failDispatch(async (taskId) => {
      const oldToken = (await harness.agentStore.get('dev-1'))!.lockToken!;
      await harness.lockManager.releaseIfOwner('dev-1', taskId, oldToken);
      newToken = await harness.lockManager.acquire('dev-1', taskId);
      await harness.agentStore.update('dev-1', state => ({ ...state!, lockToken: newToken!, updatedAt: NOW }));
    });

    const created = await createOnDev1();

    expect(created.status).toBe('in_progress');
    expect((await harness.agentStore.get('dev-1'))?.lockToken).toBe(newToken);
    expect(await harness.lockManager.isOwner('dev-1', created.id, newToken!)).toBe(true);
  });

  it('createAndStartTask surfaces a non-terminal dispatch error as a dispatch-rollback intervention', async () => {
    failDispatch(undefined, 'git fetch failed at /repo: Connection timed out');

    const created = await harness.manager.createAndStartTask('proj', {
      title: 'T', description: 'D', preferredAgentId: 'dev-1',
    });

    expect(created?.status).toBe('pending');
    const intervention = harness.events.find(
      e => e.type === 'human.intervention'
        && (e.data as { phase?: string }).phase === 'dispatch-rollback',
    );
    expect(intervention).toBeDefined();
    expect((intervention!.data as { message?: string }).message).toContain('Connection timed out');
  });

  it('createAndStartTask leaves the dispatch bound when checkout preparation fails (startSession already holds the agent)', async () => {
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });
    vi.spyOn(BranchManager.prototype, 'switchToTaskBranch').mockRejectedValue(new Error('git checkout failed'));

    const created = await harness.manager.createAndStartTask('proj', {
      title: 'T', description: 'D', preferredAgentId: 'dev-1',
    });

    expect(created.status).toBe('in_progress');
    const dev = await harness.agentStore.get('dev-1');
    expect(dev?.taskId).toBe(created.id);
    expect(dev?.awaitingPhase).toBe('checkout-preparation-failed');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
    expect(dispatchRollbackEvents()).toEqual([]);
    expect(harness.runner.pastedPrompts).toEqual([]);
  });

  it('createAndStartTask leaves the dispatch bound when the runtime is blocked on a startup dialog (handled EnsureSessionError)', async () => {
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });
    const runner = useRunner({ agents: { 'dev-1': { screen: STARTUP_DIALOG } } });

    const created = await createOnDev1();

    expect(created.status).toBe('failed');
    expect(await harness.agentStore.get('dev-1')).toMatchObject({
      taskId: created.id,
      status: 'awaiting_human',
      awaitingPhase: 'agent_dialog_pending',
    });
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
    expect(dispatchRollbackEvents()).toEqual([]);
    expect(cmdsOf(runner).some(c => c.includes('kill-session'))).toBe(false);
    expect(runner.pastedPrompts).toEqual([]);
  });

  it('createAndStartTask({ background: true }) returns before the prompt is delivered; the dispatch then completes on its own', async () => {
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });

    const created = await harness.manager.createAndStartTask(
      'proj',
      { title: 'T', description: 'D', preferredAgentId: 'dev-1' },
      { background: true },
    );

    expect(created.status).toBe('in_progress');
    expect(harness.runner.pastedPrompts).toEqual([]);
    await vi.waitFor(() => expect(harness.runner.pastedPrompts).toHaveLength(1), { timeout: 5_000 });
    await vi.waitFor(() => expect(harness.events.some(e => e.type === 'session.started' && e.taskId === created.id)).toBe(true));
    expect((await harness.taskStore.get(created.id))?.status).toBe('in_progress');
  });

  it('createAndStartTask({ background: true }) rolls a failed bootstrap back off the create path', async () => {
    failDispatch();

    const created = await harness.manager.createAndStartTask(
      'proj',
      { title: 'T', description: 'D', preferredAgentId: 'dev-1' },
      { background: true },
    );

    expect(created.status).toBe('in_progress');
    await vi.waitFor(async () => expect((await harness.taskStore.get(created.id))?.status).toBe('pending'));
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(dispatchRollbackEvents()).toHaveLength(1);
  });

  // 提示词已粘贴、尚未回车时任务被取消:startSession 仍会送达并返回 true,收尾落在 createAndStartTask
  function cancelOnPaste(): FakeRunnerOptions['onExec'] {
    let cancelled = false;
    return async cmd => {
      if (cancelled || !cmd.includes('paste-buffer')) return;
      cancelled = true;
      await cancelBoundTaskInStore();
    };
  }

  it('createAndStartTask({ background: true }): cancel mid-bootstrap interrupts the pane, then idle-releases without arming', async () => {
    const streamer = fakeStreamer();
    const runner = useRunner({ onExec: cancelOnPaste() }, { paneStreamerManager: streamer.paneStreamerManager });
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });

    const created = await harness.manager.createAndStartTask(
      'proj',
      { title: 'T', description: 'D', preferredAgentId: 'dev-1' },
      { background: true },
    );

    await vi.waitFor(async () => expect(await harness.lockManager.isLocked('dev-1')).toBe(false), { timeout: 5_000 });
    expect(runner.pastedPrompts).toHaveLength(1);
    expect(escapesTo('%0', runner)).toHaveLength(1);
    const dev = await harness.agentStore.get('dev-1');
    expect(dev?.taskId).toBeUndefined();
    expect(dev?.status).toBeUndefined();
    expect((await harness.taskStore.get(created.id))?.status).toBe('cancelled');
    expect(streamer.subscribers).toEqual([]);
  });

  it('createAndStartTask({ background: true }): cancel mid-bootstrap holds the agent when the pane can not be interrupted', async () => {
    const runner = useRunner({ onExec: cancelOnPaste(), rules: [escapeFails] });
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });

    const created = await harness.manager.createAndStartTask(
      'proj',
      { title: 'T', description: 'D', preferredAgentId: 'dev-1' },
      { background: true },
    );

    await vi.waitFor(
      async () => expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBe('cancel-interrupt-failed'),
      { timeout: 5_000 },
    );
    expect(escapesTo('%0', runner)).toHaveLength(1);
    const dev = await harness.agentStore.get('dev-1');
    expect(dev?.taskId).toBe(created.id);
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });

  it('createAndStartTask({ background: true }): a watcher that throws while arming holds the agent instead of being swallowed', async () => {
    const { watcher } = watcherStandIn(async () => { throw new Error('watcher store down'); });
    harness.manager = harness.createManager({ phaseSignalWatcher: watcher });
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });

    const created = await harness.manager.createAndStartTask(
      'proj',
      { title: 'T', description: 'D', preferredAgentId: 'dev-1' },
      { background: true },
    );

    expect(created.status).toBe('in_progress');
    await vi.waitFor(
      async () => expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBe('signal-arm-failed:spec-done,pr-created'),
      { timeout: 5_000 },
    );
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBe(created.id);
    expect(harness.runner.pastedPrompts).toHaveLength(1);
  });

  it('createAndStartTask: a cancel-cleanup hold from a cancel-before-delivery is NOT auto-released by the !started path', async () => {
    let held = false;
    const runner = useRunner({
      // 会话已就绪、提示词尚未粘贴的窗口:任务上下文读取是这一段里第一条 tmux 命令
      onExec: async cmd => {
        if (held || !cmd.includes('@baxian-context-task-id')) return;
        held = true;
        await cancelBoundTaskInStore();
        await harness.agentStore.update('dev-1', (s) => (s
          ? { ...s, status: 'awaiting_human' as const, awaitingPhase: 'cancel-interrupt-failed', awaitingSince: NOW }
          : s));
      },
    });
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });

    const created = await harness.manager.createAndStartTask('proj', { title: 'T', description: 'D', preferredAgentId: 'dev-1' });

    expect(runner.pastedPrompts).toEqual([]);
    const dev = await harness.agentStore.get('dev-1');
    expect(dev?.taskId).toBe(created.id);
    expect(dev?.awaitingPhase).toBe('cancel-interrupt-failed');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });

  it('develop dispatch holds the dev when the spec/pr-created watcher fails to arm', async () => {
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });
    const { watcher, start } = watcherStandIn(async () => false);
    const m = harness.createManager({ phaseSignalWatcher: watcher });

    const created = await m.createAndStartTask('proj', { title: 'T', description: 'D', preferredAgentId: 'dev-1' });

    expect(start).toHaveBeenCalled();
    expect(harness.runner.pastedPrompts).toHaveLength(1);
    const dev = await harness.agentStore.get('dev-1');
    expect(dev?.taskId).toBe(created.id);
    expect(dev?.status).toBe('awaiting_human');
    expect(dev?.awaitingPhase).toBe('signal-arm-failed:spec-done,pr-created');
    expect(harness.events.some(
      e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'signal-arm-failed:spec-done,pr-created',
    )).toBe(true);
  });

  it('setupPhaseSignal through the REAL watcher reports false for a config-removed agent; the hold marks it awaiting_human', async () => {
    const t = await harness.seedTask({ id: 'task-ghost', agentId: 'ghost', devAgentId: 'ghost', signalToken: 'tok-1' });
    await harness.seedAgent({ id: 'ghost', taskId: t.id });
    const m = harness.createManager({
      paneStreamerManager: {
        ensure: () => { throw new Error('unreachable: resolveAgent fails before ensure'); },
      } as never,
    });

    const armed = await m.setupPhaseSignal(t.id, 'ghost', 'pr-created', { skipSnapshot: true });

    expect(armed).toBe(false);
    expect(harness.events.some(
      e => e.type === 'human.intervention'
        && (e.data as { phase?: string }).phase === 'signal-setup-no-agent:pr-created',
    )).toBe(true);

    await m.holdAgentForUnarmedSignal(t.id, 'ghost', 'pr-created');
    const held = await harness.agentStore.get('ghost');
    expect(held?.status).toBe('awaiting_human');
    expect(held?.awaitingPhase).toBe('signal-arm-failed:pr-created');
  });

  it('setupPhaseSignal through the REAL watcher arms and reports true for a configured agent', async () => {
    const t = await harness.seedTask({ id: 'task-armed', signalToken: 'tok-2' });
    const m = harness.createManager({
      paneStreamerManager: {
        ensure: () => ({
          subscribeAtomic: async () => ({ unsubscribe: () => undefined, snapshot: { data: '' } }),
        }),
      } as never,
    });

    const armed = await m.setupPhaseSignal(t.id, 'dev-1', 'pr-created', { skipSnapshot: true });

    expect(armed).toBe(true);
  });

  it('failTaskForDispatchError fails the task and releases its agent binding', async () => {
    const t = await harness.seedTask();
    await harness.seedAgent({
      id: 'dev-1',
      taskId: t.id,
      paneId: '%0',
    });
    await harness.acquireAgentLock('dev-1');

    await harness.manager.failTaskForDispatchError(
      t.id,
      'develop',
      'dev-1',
      new DispatchTerminalError('prompt_too_large', 'prompt too large'),
    );

    expect((await harness.taskStore.get(t.id))?.status).toBe('failed');
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
  });

  it('startSession ack_unknown preserves binding/lock/worktree (so downstream markAwaitingHuman can take over)', async () => {
    const t = await harness.seedTask({
      id: 'task-startsession-ack-unknown',
      branch: 'bx/task-startsession-ack-unknown',
      signalToken: 'dispatch12345',
    });
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    const beforeUpdatedAt = NOW;
    // 回车已发出,随后的第一次抓屏断连:提交结果无法判定
    let submitted = false;
    const runner = useRunner({
      onExec: cmd => { if (runner.pastedPrompts.length > 0 && /send-keys -t %0 .*Enter/.test(cmd)) submitted = true; },
      rules: [{ match: cmd => submitted && cmd.includes('capture-pane'), reply: { exitCode: 255, stderr: 'ssh: connection reset' } }],
    });

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).rejects.toMatchObject({
      name: 'DispatchTerminalError',
      reason: 'ack_unknown',
    });

    expect(runner.pastedPrompts).toHaveLength(1);
    const stateAfter = await harness.agentStore.get('dev-1');
    expect(stateAfter?.taskId).toBe(t.id);
    expect(stateAfter?.workdir).toBeTruthy();
    expect(stateAfter?.updatedAt).not.toBe(beforeUpdatedAt);
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });

  it('startSession cleanup leaves the binding to cancel when cancel takes the agent over at the composer-clear key (cancel-clearing → cancel-interrupt-failed)', async () => {
    const t = await harness.seedTask({
      id: 'task-ss-cancel-clearing',
      branch: 'bx/task-ss-cancel-clearing',
      signalToken: 'dispatch12345',
    });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    let cancel: Promise<TaskState> | undefined;
    let holdAtTakeover: string | undefined;
    const runner = useRunner({
      // 清稿键是派单标记 running 之后、粘贴之前的第一条 tmux 命令:cancel 在这里接管绑定
      onExec: async cmd => {
        if (cancel || !cmd.includes('send-keys -l -t %0')) return;
        cancel = harness.manager.cancelTask(t.id);
        await vi.waitFor(async () => {
          holdAtTakeover = (await harness.agentStore.get('dev-1'))?.awaitingPhase;
          expect(holdAtTakeover).toBe('cancel-clearing');
        });
      },
      rules: [escapeFails],
    });

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).rejects.toThrow(/taken over by cancel/);
    await cancel;

    expect(runner.pastedPrompts).toEqual([]);
    expect(holdAtTakeover).toBe('cancel-clearing');
    const stateAfter = await harness.agentStore.get('dev-1');
    expect(stateAfter?.taskId).toBe(t.id);
    expect(stateAfter?.awaitingPhase).toBe('cancel-interrupt-failed');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });

  it('startSession set-running write preserves a cancel-clearing hold present at write time (does NOT wipe it)', async () => {
    const t = await harness.seedTask({
      id: 'task-ss-cancel-clearing-prewrite',
      branch: 'bx/task-ss-cancel-clearing-prewrite',
      signalToken: 'dispatch12345',
    });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });

    const result = await harness.manager.startSession(t.id, 'dev-1', 'develop');

    expect(result).toBe(false);
    expect(harness.runner.pastedPrompts).toEqual([]);
    const stateAfter = await harness.agentStore.get('dev-1');
    expect(stateAfter?.taskId).toBe(t.id);
    expect(stateAfter?.awaitingPhase).toBe('cancel-clearing');
    expect(stateAfter?.bootstrappingTaskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });

  it('a failed dispatch leaves the binding/lock alone when cancel cleanup already holds the agent', async () => {
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });
    failDispatch(async () => {
      await harness.agentStore.update('dev-1', state => ({
        ...state!, status: 'awaiting_human', awaitingPhase: 'cancel-clearing', updatedAt: NOW,
      }));
    });

    const created = await createOnDev1();

    const st = await harness.agentStore.get('dev-1');
    expect(st?.taskId).toBe(created.id);
    expect(st?.awaitingPhase).toBe('cancel-clearing');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });

  it('failTaskForDispatchError on ack_unknown releases partner agents (terminal cleanup)', async () => {
    const t = await harness.seedTask({ id: 'task-ack-partner', status: 'review', qaAgentId: 'qa-1' });
    await harness.seedAgent({
      id: 'qa-1', taskId: t.id, paneId: '%1',
    });
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await harness.acquireAgentLock('qa-1');
    await harness.acquireAgentLock('dev-1');

    await harness.manager.failTaskForDispatchError(
      t.id, 'review', 'qa-1',
      new DispatchTerminalError('ack_unknown', 'simulated'),
    );

    expect((await harness.agentStore.get('qa-1'))?.status).toBe('awaiting_human');
    expect((await harness.agentStore.get('qa-1'))?.taskId).toBe(t.id);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
  });

  it('failTaskForDispatchError preserves binding on ack_unknown (prompt may already be running)', async () => {
    const t = await harness.seedTask({ id: 'task-ack-unknown', qaAgentId: 'qa-1' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });

    await harness.manager.failTaskForDispatchError(
      t.id,
      'develop',
      'dev-1',
      new DispatchTerminalError('ack_unknown', 'capture-pane failed mid-wait'),
    );

    expect((await harness.taskStore.get(t.id))?.status).toBe('failed');
    const stateAfter = await harness.agentStore.get('dev-1');
    expect(stateAfter?.taskId).toBe(t.id);
    expect(stateAfter?.status).toBe('awaiting_human');
    expect(stateAfter?.awaitingPhase).toBe('dispatch-failed:ack_unknown');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
    expect(escapesTo('%0')).toEqual([]);
    expect((await harness.agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('qa-1')).toBe(false);

    const interventions = harness.events.filter(
      e => e.type === 'human.intervention' &&
        typeof (e.data as { phase?: string }).phase === 'string' &&
        (e.data as { phase: string }).phase.startsWith('dispatch-failed:ack_unknown'),
    );
    expect(interventions).toHaveLength(1);
  });
});
