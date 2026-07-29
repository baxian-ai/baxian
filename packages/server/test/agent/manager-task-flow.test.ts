import { describe, it, expect, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DispatchTerminalError, EnsureSessionError } from '../../src/agent/manager.js';
import { ApiError } from '../../src/errors.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';
import { TmuxManager } from '../../src/agent/tmux.js';
import { SkillRegistry } from '../../src/skill/registry.js';
import { useManagerSuiteHarness } from '../helpers/manager-harness.js';
import { clearAwareRunner } from '../helpers/fake-runner.js';
import { makeTask } from '../helpers/fixtures.js';

const NOW = '2026-05-14T05:00:00.000Z';

const CLAUDE_PANE = { proc: 'claude', idle: '⏵⏵ bypass permissions on /tmp/repo\n\n>' };

const harness = useManagerSuiteHarness();

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

  it('createTask rejects the binding when a DELETE→recreate bumps the generation during config reads', async () => {
    await harness.seedAgent({ id: 'dev-1' });
    const realPick = harness.manager.pickAgent.bind(harness.manager);
    vi.spyOn(harness.manager, 'pickAgent').mockImplementation(async (projectId, agentId) => {
      const picked = await realPick(projectId, agentId);
      harness.manager.bumpDeletionGeneration(agentId);
      return picked;
    });

    const result = await harness.manager.createTask('proj', {
      title: 'racy', description: 'd', preferredAgentId: 'dev-1',
    });

    expect(result.status).toBe('pending');
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
  });

  it('createTask rejects the queued early-return when a DELETE→recreate bumps the generation (no stale participants persisted)', async () => {
    await harness.seedAgent({ id: 'dev-1' });
    vi.spyOn(harness.manager, 'pickAgent').mockImplementation(async (_projectId, agentId) => {
      harness.manager.bumpDeletionGeneration(agentId);
      return null;
    });

    await expect(harness.manager.createTask('proj', {
      title: 'racy queued', description: 'd', preferredAgentId: 'dev-1',
    })).rejects.toThrow(/deleted or recreated/);
  });

  it('createTask queued early-return rejects when a group member (QA) is being deleted, even with the dev generation unchanged', async () => {
    await harness.seedAgent({ id: 'dev-1' });
    harness.manager.tryClaimDeletion(['qa-1']);
    vi.spyOn(harness.manager, 'pickAgent').mockResolvedValue(null);

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

  it('createTask does not create an active task when a group participant (QA) is deleted+recreated after the snapshot', async () => {
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
    vi.spyOn(harness.manager as unknown as { ensureWorkdir: (...a: unknown[]) => Promise<{ workdir: string }> }, 'ensureWorkdir')
      .mockImplementation(async () => {
        harness.manager.bumpDeletionGeneration('dev-1');
        return { workdir: '/tmp/stale-workdir' };
      });

    await expect(harness.manager.ensureSession('dev-1', 'runtime')).rejects.toThrow(/being deleted|recreated/);
    expect((await harness.agentStore.get('dev-1'))?.workdir).not.toBe('/tmp/stale-workdir');
  });

  it('ensureSession re-gates after the tmux probe: a DELETE tombstone during getSessionSnapshot blocks build/adopt', async () => {
    await harness.seedAgent({ id: 'dev-1', workdir: '/repo/wt' });
    vi.spyOn(harness.manager as unknown as { ensureWorkdir: (...a: unknown[]) => Promise<{ workdir: string }> }, 'ensureWorkdir')
      .mockResolvedValue({ workdir: '/repo/wt' });
    vi.spyOn(harness.manager as unknown as { provisionRepoSkills: (...a: unknown[]) => Promise<void> }, 'provisionRepoSkills')
      .mockResolvedValue(undefined);
    const buildSpy = vi.spyOn(
      harness.manager as unknown as { buildFreshSession: (...a: unknown[]) => Promise<unknown> }, 'buildFreshSession',
    ).mockResolvedValue({ createdSession: true, agentId: 'dev-1' });
    vi.spyOn(TmuxManager.prototype, 'getSessionSnapshot').mockImplementation(async () => {
      harness.manager.tryClaimDeletion(['dev-1']);
      return null;
    });

    await expect(harness.manager.ensureSession('dev-1', 'runtime')).rejects.toThrow(/being deleted|recreated/);
    expect(buildSpy).not.toHaveBeenCalled();
  });

  it('reconcileTaskBranches skips branch cleanup when a DELETE→recreate bumps the generation during the ref scan', async () => {
    await harness.seedTask({ id: 'rtb-1', status: 'merged', branch: 'bx/rtb-1', branchCreatedByBaxian: true, agentId: 'dev-1' });
    await harness.seedAgent({ id: 'dev-1', workdir: '/repo/wt' });

    const cmds: string[] = [];
    vi.spyOn(harness.manager as unknown as { createRunnerFor: (a: unknown) => CommandRunner }, 'createRunnerFor')
      .mockReturnValue({
        exec: vi.fn(async (cmd: string) => {
          cmds.push(cmd);
          if (cmd.includes('for-each-ref')) {
            harness.manager.bumpDeletionGeneration('dev-1');
            return { stdout: 'refs/heads/bx/rtb-1\n', stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        }),
        writeFile: vi.fn(async () => {}),
      } as unknown as CommandRunner);

    await harness.manager.reconcileTaskBranches();

    expect(cmds.some(c => c.includes('show-ref --verify'))).toBe(false);
    expect(cmds.some(c => /branch\s+-[dD]\b/.test(c))).toBe(false);
  });

  it('createTask records the QA partner before any review dispatch', async () => {
    await harness.seedAgent({ id: 'dev-1' });

    const created = await harness.manager.createTask('proj', {
      title: 'bind the group',
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
          { id: 'proj-a', repo: 'user/repo-a', merge: null, agent: [] },
          { id: 'proj-b', repo: 'user/repo-b', merge: null, agent: [] },
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

  it('cancelTask delegates releaseAgentForTask for dev and qa after cancelling the task', async () => {
    const t = await harness.seedTask({ qaAgentId: 'qa-1' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    harness.mockInterruptPane(harness.manager, true);
    const releaseSpy = vi.spyOn(harness.manager, 'releaseAgentForTask').mockResolvedValue(true);

    const cancelled = await harness.manager.cancelTask(t.id);

    expect(cancelled.status).toBe('cancelled');
    expect(releaseSpy).toHaveBeenCalledWith('dev-1', t.id, 'idle', { allowAwaitingHuman: true, fromCancelCleanup: true });
    expect(releaseSpy).toHaveBeenCalledWith('qa-1', t.id, 'idle', { allowAwaitingHuman: true, fromCancelCleanup: true });
  });

  it('cancelTask on a terminal task still interrupts and releases stale bound agents without rewriting the status', async () => {
    await harness.seedTask({ id: 'task-term', status: 'merged', agentId: 'dev-1', qaAgentId: 'qa-1', updatedAt: NOW });
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-term', paneId: '%0' });
    await harness.seedAgent({ id: 'qa-1', taskId: 'task-term', paneId: '%1' });
    const interruptSpy = harness.mockInterruptPane(harness.manager, true);

    const result = await harness.manager.cancelTask('task-term');

    expect(result.status).toBe('merged');
    expect(interruptSpy).toHaveBeenCalledTimes(2);
    expect(await harness.taskStore.get('task-term')).toMatchObject({ status: 'merged', updatedAt: NOW });
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await harness.agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(harness.events.some(e => e.type === 'task.updated' && e.taskId === 'task-term')).toBe(false);
  });

  it('cancelTask on a terminal task with no live bindings is a clean no-op', async () => {
    await harness.seedTask({ id: 'task-term2', status: 'cancelled', agentId: 'dev-1', updatedAt: NOW });
    await harness.seedAgent({ id: 'dev-1' });
    const interruptSpy = harness.mockInterruptPane(harness.manager, true);

    const result = await harness.manager.cancelTask('task-term2');

    expect(result.status).toBe('cancelled');
    expect(interruptSpy).not.toHaveBeenCalled();
    expect((await harness.taskStore.get('task-term2'))?.updatedAt).toBe(NOW);
  });

  it('cancelTask on a terminal task still refuses while completion is in flight (409)', async () => {
    await harness.seedTask({ id: 'task-term3', status: 'merged' });
    harness.manager['markCompleteInFlight'].add('task-term3');
    try {
      await expect(harness.manager.cancelTask('task-term3')).rejects.toMatchObject({ status: 409 });
    } finally {
      harness.manager['markCompleteInFlight'].delete('task-term3');
    }
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
    harness.mockInterruptPane(harness.manager, true);

    await harness.manager.cancelTask('task-term4');

    const dev = await harness.agentStore.get('dev-1');
    expect(dev?.taskId).toBeUndefined();
    expect(dev?.status).toBeUndefined();
  });

  it('cancelTask stops the watcher again after the cancelled write (closes rollback re-arm race)', async () => {
    const stop = vi.fn();
    const m = harness.createManager({ phaseSignalWatcher: { start: vi.fn(), stop } as never });
    const t = await harness.seedTask({ qaAgentId: 'qa-1' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    harness.mockInterruptPane(m, true);
    vi.spyOn(m, 'releaseAgentForTask').mockResolvedValue(true);

    await m.cancelTask(t.id);

    expect(stop.mock.calls.filter(c => c[0] === t.id)).toHaveLength(2);
  });

  it('cancelTask releases a bound dev through the real release path without task-lock deadlock', async () => {
    const localManager = harness.createManager({ runnerFactory: () => clearAwareRunner([], () => CLAUDE_PANE) });
    harness.setCompactTiming(localManager);
    const t = await harness.seedTask();
    await harness.seedAgent({
      id: 'dev-1',
      taskId: t.id,
      paneId: '%0',
    });
    await harness.acquireAgentLock('dev-1');

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('cancelTask timed out')), 1_500);
    });
    const cancelled = await Promise.race([localManager.cancelTask(t.id), timeout]);

    expect(cancelled.status).toBe('cancelled');
    const state = await harness.agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(state?.paneId).toBe('%0');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
  });

  it('rollbackFailedDispatch clears only the matching binding and releases the lock', async () => {
    const t = await harness.seedTask();
    await harness.seedAgent({
      id: 'dev-1',
      taskId: t.id,
      workdir: '/tmp/wt',
      paneId: '%0',
    });
    await harness.acquireAgentLock('dev-1');

    const token = (await harness.agentStore.get('dev-1'))?.lockToken;
    await harness.manager['rollbackFailedDispatch'](t.id, 'dev-1', undefined, token);

    expect((await harness.taskStore.get(t.id))?.status).toBe('pending');
    const state = await harness.agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(state?.workdir).toBe('/tmp/wt');
    expect(state?.paneId).toBe('%0');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
  });

  it('rollbackFailedDispatch can safely recover when agent state disappeared but the exact lock remains', async () => {
    const t = await harness.seedTask({ id: 'task-state-missing' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    const token = (await harness.agentStore.get('dev-1'))!.lockToken!;
    await harness.agentStore.delete('dev-1');

    await harness.manager['rollbackFailedDispatch'](t.id, 'dev-1', undefined, token);

    expect((await harness.taskStore.get(t.id))?.status).toBe('pending');
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
  });

  it('rollbackFailedDispatch does not resurrect state deleted by a DELETE→recreate during the rollback', async () => {
    const t = await harness.seedTask({ id: 'task-rb-revive', status: 'in_progress' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    const token = (await harness.agentStore.get('dev-1'))!.lockToken!;
    const realSet = harness.taskStore.set.bind(harness.taskStore);
    vi.spyOn(harness.taskStore, 'set').mockImplementation(async (task) => {
      await realSet(task);
      harness.manager.bumpDeletionGeneration('dev-1');
      await harness.agentStore.delete('dev-1');
    });

    await harness.manager['rollbackFailedDispatch'](t.id, 'dev-1', undefined, token);

    expect(await harness.agentStore.get('dev-1')).toBeNull();
  });

  it('rollbackFailedDispatch with a reason emits a human.intervention naming the failure', async () => {
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');

    const token = (await harness.agentStore.get('dev-1'))?.lockToken;
    await harness.manager['rollbackFailedDispatch'](t.id, 'dev-1', {
      phase: 'dispatch-rollback',
      message: 'ensureWorkdir failed: git fetch failed: Could not resolve host',
    }, token);

    expect((await harness.taskStore.get(t.id))?.status).toBe('pending');
    const intervention = harness.events.find(
      e => e.type === 'human.intervention'
        && (e.data as { phase?: string }).phase === 'dispatch-rollback',
    );
    expect(intervention).toBeDefined();
    expect((intervention!.data as { message?: string }).message).toContain('Could not resolve host');
  });

  it('rollbackFailedDispatch stays silent when the task did not need rolling back', async () => {
    const t = await harness.seedTask({ status: 'cancelled' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    const token = (await harness.agentStore.get('dev-1'))?.lockToken;

    await harness.manager['rollbackFailedDispatch'](t.id, 'dev-1', {
      phase: 'dispatch-rollback',
      message: 'irrelevant',
    }, token);

    expect(harness.events.some(
      e => e.type === 'human.intervention'
        && (e.data as { phase?: string }).phase === 'dispatch-rollback',
    )).toBe(false);
  });

  it('rollbackFailedDispatch cannot clear a newer lock generation for the same task', async () => {
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    const oldToken = (await harness.agentStore.get('dev-1'))!.lockToken!;
    await harness.lockManager.releaseIfOwner('dev-1', t.id, oldToken);
    const newToken = await harness.lockManager.acquire('dev-1', t.id);
    await harness.agentStore.update('dev-1', state => ({ ...state!, lockToken: newToken!, updatedAt: NOW }));

    await harness.manager['rollbackFailedDispatch'](t.id, 'dev-1', undefined, oldToken);

    expect((await harness.taskStore.get(t.id))?.status).toBe('in_progress');
    expect((await harness.agentStore.get('dev-1'))?.lockToken).toBe(newToken);
    expect(await harness.lockManager.isOwner('dev-1', t.id, newToken!)).toBe(true);
  });

  it('createAndStartTask surfaces a non-terminal dispatch error as a dispatch-rollback intervention', async () => {
    vi.spyOn(harness.manager, 'startSession').mockRejectedValue(
      new Error('ensureWorkdir failed: git fetch failed at /repo: Connection timed out'),
    );

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

  it('createAndStartTask skips rollbackFailedDispatch when startSession throws EnsureSessionError(handled=true)', async () => {
    const dialogErr = new EnsureSessionError(
      { createdSession: true, agentId: 'dev-1', dialogPending: true, handled: true },
      'develop dispatch runtime dialog handled',
    );
    vi.spyOn(harness.manager, 'startSession').mockRejectedValue(dialogErr);
    const rollbackSpy = vi.spyOn(harness.manager as never as { rollbackFailedDispatch: (taskId: string, agentId: string) => Promise<void> }, 'rollbackFailedDispatch');

    const created = await harness.manager.createAndStartTask('proj', {
      title: 'T', description: 'D', preferredAgentId: 'dev-1',
    });

    expect(rollbackSpy).not.toHaveBeenCalled();
    expect(created.status).toBe('in_progress');
  });

  it('createAndStartTask({ background: true }) returns without waiting for the session bootstrap', async () => {
    const startSpy = vi.spyOn(harness.manager, 'startSession').mockReturnValue(new Promise<boolean>(() => {}));

    const created = await harness.manager.createAndStartTask(
      'proj',
      { title: 'T', description: 'D', preferredAgentId: 'dev-1' },
      { background: true },
    );

    expect(created.status).toBe('in_progress');
    await vi.waitFor(() => expect(startSpy).toHaveBeenCalledTimes(1));
  });

  it('createAndStartTask({ background: true }) rolls a failed bootstrap back off the create path', async () => {
    vi.spyOn(harness.manager, 'startSession').mockRejectedValue(new Error('boot failed'));
    let rolledBack!: () => void;
    const rollbackDone = new Promise<void>((resolve) => { rolledBack = resolve; });
    const rollbackSpy = vi
      .spyOn(harness.manager as never as { rollbackFailedDispatch: (taskId: string, agentId: string) => Promise<void> }, 'rollbackFailedDispatch')
      .mockImplementation(async () => { rolledBack(); });

    const created = await harness.manager.createAndStartTask(
      'proj',
      { title: 'T', description: 'D', preferredAgentId: 'dev-1' },
      { background: true },
    );

    expect(created.status).toBe('in_progress');
    await rollbackDone;
    expect(rollbackSpy).toHaveBeenCalledTimes(1);
  });

  function mockStartSessionThatCancels(): void {
    vi.spyOn(harness.manager, 'startSession').mockImplementation(async (cancelledTaskId: string) => {
      const t = await harness.taskStore.get(cancelledTaskId);
      if (t) await harness.taskStore.set({ ...t, status: 'cancelled', updatedAt: NOW });
      return true;
    });
  }

  it('createAndStartTask({ background: true }): cancel mid-bootstrap interrupts the pane, then idle-releases', async () => {
    mockStartSessionThatCancels();
    const interruptSpy = harness.mockInterruptPane(harness.manager, true);
    let released!: () => void;
    const releaseDone = new Promise<void>((resolve) => { released = resolve; });
    const releaseSpy = vi.spyOn(harness.manager, 'releaseAgentForTask').mockImplementation(async () => { released(); return true; });
    const armSpy = vi.spyOn(
      harness.manager as never as { armPostDispatchSignalOrHold: (...args: unknown[]) => Promise<void> },
      'armPostDispatchSignalOrHold',
    );

    const created = await harness.manager.createAndStartTask(
      'proj',
      { title: 'T', description: 'D', preferredAgentId: 'dev-1' },
      { background: true },
    );

    await releaseDone;
    expect(interruptSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledWith('dev-1', created.id, 'idle', { allowAwaitingHuman: true, fromCancelCleanup: true });
    expect(armSpy).not.toHaveBeenCalled();
  });

  it('createAndStartTask({ background: true }): cancel mid-bootstrap holds the agent when the pane can not be interrupted', async () => {
    mockStartSessionThatCancels();
    harness.mockInterruptPane(harness.manager, false);
    const releaseSpy = vi.spyOn(harness.manager, 'releaseAgentForTask').mockResolvedValue(true);
    let held!: () => void;
    const holdDone = new Promise<void>((resolve) => { held = resolve; });
    const holdSpy = vi.spyOn(harness.manager, 'markAwaitingHuman').mockImplementation(async () => { held(); return true; });

    const created = await harness.manager.createAndStartTask(
      'proj',
      { title: 'T', description: 'D', preferredAgentId: 'dev-1' },
      { background: true },
    );

    await holdDone;
    expect(holdSpy).toHaveBeenCalledWith('dev-1', 'cancel-interrupt-failed', expect.any(String), { expectedTaskId: created.id });
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  it('createAndStartTask({ background: true }): a watcher arm failure holds the agent instead of being swallowed', async () => {
    vi.spyOn(harness.manager, 'startSession').mockResolvedValue(true);
    vi.spyOn(harness.manager as never as { armPostDispatchSignalOrHold: (...args: unknown[]) => Promise<void> }, 'armPostDispatchSignalOrHold')
      .mockRejectedValue(new Error('watcher store down'));
    let held!: () => void;
    const holdDone = new Promise<void>((resolve) => { held = resolve; });
    const holdSpy = vi
      .spyOn(harness.manager as never as { holdAgentForUnarmedSignal: (...args: unknown[]) => Promise<void> }, 'holdAgentForUnarmedSignal')
      .mockImplementation(async () => { held(); });

    const created = await harness.manager.createAndStartTask(
      'proj',
      { title: 'T', description: 'D', preferredAgentId: 'dev-1' },
      { background: true },
    );

    expect(created.status).toBe('in_progress');
    await holdDone;
    expect(holdSpy).toHaveBeenCalledWith(created.id, 'dev-1', ['spec-done', 'pr-created']);
  });

  it('createAndStartTask: a cancel-cleanup hold from a cancel-before-delivery is NOT auto-released by the !started path', async () => {
    vi.spyOn(harness.manager, 'startSession').mockImplementation(async (cancelledTaskId: string) => {
      const t = await harness.taskStore.get(cancelledTaskId);
      if (t) await harness.taskStore.set({ ...t, status: 'cancelled', updatedAt: NOW });
      await harness.agentStore.update('dev-1', (s) => (s
        ? { ...s, status: 'awaiting_human' as const, awaitingPhase: 'cancel-interrupt-failed', awaitingSince: NOW }
        : s));
      return false;
    });

    const created = await harness.manager.createAndStartTask('proj', { title: 'T', description: 'D', preferredAgentId: 'dev-1' });

    const dev = await harness.agentStore.get('dev-1');
    expect(dev?.taskId).toBe(created.id);
    expect(dev?.awaitingPhase).toBe('cancel-interrupt-failed');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });

  it('develop dispatch holds the dev when the spec/pr-created watcher fails to arm', async () => {
    await harness.seedAgent({ id: 'dev-1' });
    const watcher = { start: vi.fn(async () => false), stop: vi.fn(), has: vi.fn(() => false) };
    const skillRegistry = new SkillRegistry(join(harness.tempDir, 'skills'));
    await skillRegistry.scan();
    const m = harness.createManager({ skillRegistry, phaseSignalWatcher: watcher as never });
    vi.spyOn(m, 'startSession').mockResolvedValue(true);
    const holdSpy = vi.spyOn(m, 'markAwaitingHuman');

    await m.createAndStartTask('proj', { title: 'T', description: 'D', preferredAgentId: 'dev-1' });

    expect(watcher.start).toHaveBeenCalled();
    expect(holdSpy).toHaveBeenCalledWith(
      'dev-1',
      expect.stringContaining('signal-arm-failed'),
      expect.any(String),
      expect.objectContaining({ expectedTaskId: expect.any(String) }),
    );
  });

  it('setupPhaseSignal through the REAL watcher reports false for a config-removed agent; the hold marks it awaiting_human', async () => {
    const t = await harness.seedTask({ id: 'task-ghost', agentId: 'ghost', devAgentId: 'ghost', signalToken: 'tok-1' });
    await harness.seedAgent({ id: 'ghost', taskId: t.id });
    const skillRegistry = new SkillRegistry(join(harness.tempDir, 'skills'));
    await skillRegistry.scan();
    const m = harness.createManager({
      skillRegistry,
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
    const skillRegistry = new SkillRegistry(join(harness.tempDir, 'skills'));
    await skillRegistry.scan();
    const m = harness.createManager({
      skillRegistry,
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

  it('validateTaskDispatch raises ApiError(500) when preflight hits RequiredSkillsMissingError', async () => {
    const unseededSkillsDir = join(harness.tempDir, 'skills-empty');
    await mkdir(unseededSkillsDir, { recursive: true });
    const emptyRegistry = new SkillRegistry(unseededSkillsDir);
    await emptyRegistry.scan();
    const badManager = harness.createManager({ skillRegistry: emptyRegistry });
    await harness.seedAgent({ id: 'dev-1' });

    let caught: unknown;
    try {
      await badManager.validateTaskDispatch('proj', {
        title: 'x',
        description: 'y',
        preferredAgentId: 'dev-1',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(500);
    expect((caught as Error).message).toMatch(/required skill/i);
  });

  it('validateTaskDispatch fails fast when baxian-signals is missing (preview carries a signal token)', async () => {
    const partialDir = join(harness.tempDir, 'skills-no-signals');
    await mkdir(join(partialDir, 'baxian-task-check'), { recursive: true });
    await writeFile(
      join(partialDir, 'baxian-task-check', 'SKILL.md'),
      `---\nname: baxian-task-check\ndescription: stub\n---\nstub`,
    );
    const registry = new SkillRegistry(partialDir);
    await registry.scan();
    const mgr2 = harness.createManager({ skillRegistry: registry });
    await harness.seedAgent({ id: 'dev-1' });

    let caught: unknown;
    try {
      await mgr2.validateTaskDispatch('proj', { title: 'x', description: 'y', preferredAgentId: 'dev-1' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(500);
    expect((caught as Error).message).toMatch(/baxian-signals/);
  });

  it('failTaskForDispatchError accepts required_skills_missing reason', async () => {
    const t = await harness.seedTask({ id: 'task-skills' });
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
      new DispatchTerminalError('required_skills_missing', 'missing baxian-task-check'),
    );

    expect((await harness.taskStore.get(t.id))?.status).toBe('failed');
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('startSession ack_unknown preserves binding/lock/worktree (so downstream markAwaitingHuman can take over)', async () => {
    const t = await harness.seedTask({ id: 'task-startsession-ack-unknown', branch: 'bx/task-startsession-ack-unknown' });
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await harness.acquireAgentLock('dev-1');
    const beforeUpdatedAt = NOW;

    harness.stubEnsureSession(harness.manager);
    vi.spyOn(harness.manager as unknown as { injectAndAwaitAck: () => Promise<void> }, 'injectAndAwaitAck')
      .mockRejectedValue(new DispatchTerminalError('ack_unknown', 'simulated ack_unknown from infra failure'));
    const minimalRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('git worktree add')) return { stdout: '', stderr: '', exitCode: 0 };
        if (cmd.includes('git rev-parse')) return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async () => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    (harness.manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => minimalRunner;

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).rejects.toBeInstanceOf(DispatchTerminalError);

    const stateAfter = await harness.agentStore.get('dev-1');
    expect(stateAfter?.taskId).toBe(t.id);
    expect(stateAfter?.workdir).toBeTruthy();
    expect(stateAfter?.updatedAt).not.toBe(beforeUpdatedAt);
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });

  it('startSession cleanup leaves the binding when cancel took it over (cancel-clearing) during the mutex wait', async () => {
    const t = await harness.seedTask({ id: 'task-ss-cancel-clearing', branch: 'bx/task-ss-cancel-clearing' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');

    harness.stubEnsureSession(harness.manager);
    vi.spyOn(harness.manager as unknown as { injectAndAwaitAck: () => Promise<unknown> }, 'injectAndAwaitAck')
      .mockImplementation(async () => {
        await (harness.manager as unknown as { markPaneCancelClearing: (a: string, tid: string) => Promise<void> })
          .markPaneCancelClearing('dev-1', t.id);
        throw new Error('dispatch aborted: task went terminal while waiting for pane mutex');
      });
    const minimalRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('git worktree add')) return { stdout: '', stderr: '', exitCode: 0 };
        if (cmd.includes('git rev-parse')) return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async () => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    (harness.manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => minimalRunner;

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).rejects.toThrow(/went terminal/);

    const stateAfter = await harness.agentStore.get('dev-1');
    expect(stateAfter?.taskId).toBe(t.id);
    expect(stateAfter?.awaitingPhase).toBe('cancel-clearing');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });

  it('startSession set-running write preserves a cancel-clearing hold present at write time (does NOT wipe it)', async () => {
    const t = await harness.seedTask({ id: 'task-ss-cancel-clearing-prewrite', branch: 'bx/task-ss-cancel-clearing-prewrite' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await harness.acquireAgentLock('dev-1');

    harness.stubEnsureSession(harness.manager);
    const injectSpy = vi.spyOn(harness.manager as unknown as { injectAndAwaitAck: () => Promise<unknown> }, 'injectAndAwaitAck')
      .mockRejectedValue(new Error('injectAndAwaitAck must not run when a cancel hold owns the binding'));
    const minimalRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('git worktree add')) return { stdout: '', stderr: '', exitCode: 0 };
        if (cmd.includes('git rev-parse')) return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async () => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    (harness.manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => minimalRunner;

    const result = await harness.manager.startSession(t.id, 'dev-1', 'develop');

    expect(result).toBe(false);
    expect(injectSpy).not.toHaveBeenCalled();
    const stateAfter = await harness.agentStore.get('dev-1');
    expect(stateAfter?.taskId).toBe(t.id);
    expect(stateAfter?.awaitingPhase).toBe('cancel-clearing');
    expect(stateAfter?.bootstrappingTaskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });

  it('rollbackFailedDispatch leaves the binding/lock when the agent is held by cancel cleanup', async () => {
    const t = await harness.seedTask({ id: 'task-rollback-cancel', status: 'cancelled' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await harness.acquireAgentLock('dev-1');

    const token = (await harness.agentStore.get('dev-1'))?.lockToken;
    await (harness.manager as unknown as {
      rollbackFailedDispatch: (tid: string, aid: string, reason?: unknown, token?: string) => Promise<void>;
    }).rollbackFailedDispatch(t.id, 'dev-1', undefined, token);

    const st = await harness.agentStore.get('dev-1');
    expect(st?.taskId).toBe(t.id);
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
    const t = await harness.seedTask({ id: 'task-ack-unknown' });
    await harness.seedAgent({
      id: 'dev-1',
      taskId: t.id,
      paneId: '%0',
    });
    await harness.acquireAgentLock('dev-1');
    const releaseSpy = vi.spyOn(harness.manager, 'releaseAgentForTask');

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
    expect(releaseSpy).toHaveBeenCalledWith(
      'qa-1',
      t.id,
      'idle',
      { allowAwaitingHuman: true },
    );
    expect(releaseSpy.mock.calls.some(([agentId]) => agentId === 'dev-1')).toBe(false);

    const interventions = harness.events.filter(
      e => e.type === 'human.intervention' &&
        typeof (e.data as { phase?: string }).phase === 'string' &&
        (e.data as { phase: string }).phase.startsWith('dispatch-failed:ack_unknown'),
    );
    expect(interventions).toHaveLength(1);

    releaseSpy.mockRestore();
  });
});
