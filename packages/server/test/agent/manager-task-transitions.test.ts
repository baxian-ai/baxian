import { describe, it, expect, vi } from 'vitest';
import type { TaskState } from '../../src/shared/index.js';
import { taskAttentionGeneration } from '../../src/shared/index.js';
import { AgentManager, DispatchTerminalError } from '../../src/agent/manager.js';
import { useManagerSuiteHarness } from '../helpers/manager-harness.js';
import { makeTask } from '../helpers/fixtures.js';

const NOW = '2026-05-14T05:00:00.000Z';

async function waitUntilAsync(predicate: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('waitUntilAsync: predicate never became true');
}
const harness = useManagerSuiteHarness();

describe('AgentManager transitionTaskStatus', () => {
  it('persists a valid non-terminal transition and returns the previous status', async () => {
    await harness.seedTask({ id: 'task-transition', status: 'in_progress', updatedAt: NOW });

    const result = await harness.manager.transitionTaskStatus(
      'task-transition',
      'review',
      { fromStatus: ['in_progress', 'fixing'] },
    );

    expect(result).toMatchObject({
      previousStatus: 'in_progress',
      task: { id: 'task-transition', status: 'review' },
    });
    expect((await harness.taskStore.get('task-transition'))?.status).toBe('review');
    expect((await harness.taskStore.get('task-transition'))?.updatedAt).not.toBe(NOW);
  });

  it('returns null and leaves the task unchanged when fromStatus does not match', async () => {
    await harness.seedTask({ id: 'task-guard', status: 'in_progress', updatedAt: NOW });

    const result = await harness.manager.transitionTaskStatus(
      'task-guard',
      'merged',
      { fromStatus: ['review', 'approved'] },
    );

    expect(result).toBeNull();
    expect(await harness.taskStore.get('task-guard')).toMatchObject({
      status: 'in_progress',
      updatedAt: NOW,
    });
  });

  it('refuses terminal tasks even when the guard includes the terminal status', async () => {
    for (const terminal of ['merged', 'failed', 'cancelled'] as const) {
      await harness.seedTask({ id: `task-${terminal}`, status: terminal });
      await expect(
        harness.manager.transitionTaskStatus(`task-${terminal}`, 'review', { fromStatus: [terminal] }),
      ).resolves.toBeNull();
      expect((await harness.taskStore.get(`task-${terminal}`))?.status).toBe(terminal);
    }
  });

  it('returns null for an unknown task', async () => {
    await expect(
      harness.manager.transitionTaskStatus('missing-task', 'review', { fromStatus: ['in_progress'] }),
    ).resolves.toBeNull();
  });

  it('persists the supplied task patch with the transition', async () => {
    await harness.seedTask({ id: 'task-patch', status: 'in_progress', reviewRound: 0 });

    const result = await harness.manager.transitionTaskStatus(
      'task-patch',
      'review',
      { fromStatus: ['in_progress'] },
      {
        reviewRound: 1,
        prNumber: 87,
        prUrl: 'https://github.com/baxian-ai/baxian/pull/87',
        qaAgentId: 'qa-1',
        latestHeadSha: 'abc123',
      },
    );

    expect(result?.task).toMatchObject({
      status: 'review',
      reviewRound: 1,
      prNumber: 87,
      prUrl: 'https://github.com/baxian-ai/baxian/pull/87',
      qaAgentId: 'qa-1',
      latestHeadSha: 'abc123',
    });
    expect(await harness.taskStore.get('task-patch')).toMatchObject({
      status: 'review',
      reviewRound: 1,
      prNumber: 87,
      qaAgentId: 'qa-1',
      latestHeadSha: 'abc123',
    });
  });

  it('updates only the captured task generation including its bound agent', async () => {
    await harness.seedTask({
      id: 'task-update-guard',
      status: 'review',
      phase: 'code',
      signalToken: 'token-1',
      agentId: 'dev-1',
      reviewRound: 2,
      pendingPrSignalToken: 'pending-token-1',
    });

    await expect(harness.manager.updateTaskIfStatus(
      'task-update-guard',
      'review',
      { pendingPrSignalToken: undefined },
      {
        phase: 'code',
        signalToken: 'token-1',
        agentId: 'dev-2',
        reviewRound: 2,
      },
    )).resolves.toBe(false);
    expect(await harness.taskStore.get('task-update-guard')).toMatchObject({
      agentId: 'dev-1',
      pendingPrSignalToken: 'pending-token-1',
    });

    await expect(harness.manager.updateTaskIfStatus(
      'task-update-guard',
      'review',
      { pendingPrSignalToken: undefined },
      {
        phase: 'code',
        signalToken: 'token-1',
        agentId: 'dev-1',
        reviewRound: 2,
      },
    )).resolves.toBe(true);
    const updated = await harness.taskStore.get('task-update-guard');
    expect(updated?.pendingPrSignalToken).toBeUndefined();
  });
});

describe('AgentManager.parkTaskAtSpecReady / submitSpecVerdict', () => {
  const watcherStub = () => ({
    start: vi.fn(async () => true),
    stop: vi.fn(),
    stopAgentIfToken: vi.fn(),
    has: vi.fn(() => false),
  });
  function specManager(): AgentManager {
    return harness.createManager({
      config: harness.config,
      phaseSignalWatcher: watcherStub() as never,
    });
  }

  async function seedSpecTask(overrides: Partial<TaskState> = {}): Promise<TaskState> {
    return harness.seedTask({
      id: 'task-spec-1',
      branch: 'bx/task-spec-1',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      devAgentId: 'dev-1',
      qaAgentId: 'qa-1',
      phase: 'spec',
      ...overrides,
    });
  }

  it('parks a review task at spec-ready, retains qaAgentId, marks Dev waiting, and releases QA', async () => {
    const m = specManager();
    await seedSpecTask({ status: 'review', specReviewRound: 1 });
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-spec-1' });
    await harness.seedAgent({ id: 'qa-1', taskId: 'task-spec-1' });
    const releaseSpy = vi.spyOn(m, 'releaseAgentForTask').mockResolvedValue(true);
    const waitingSpy = vi.spyOn(m, 'markAgentWaiting').mockResolvedValue(true);

    const result = await m.parkTaskAtSpecReady('task-spec-1');
    expect(result?.status).toBe('spec-ready');
    expect(result?.phase).toBe('spec');
    expect(result?.qaAgentId).toBe('qa-1');
    expect((await harness.taskStore.get('task-spec-1'))?.qaAgentId).toBe('qa-1');
    const parkedGeneration = {
      status: 'spec-ready',
      phase: 'spec',
      signalToken: undefined,
      agentId: 'dev-1',
      reviewRound: 0,
      specReviewRound: 1,
    };
    expect(waitingSpy).toHaveBeenCalledWith(
      'dev-1',
      'task-spec-1',
      { expectedTask: parkedGeneration },
    );
    expect(releaseSpy).toHaveBeenCalledWith(
      'qa-1',
      'task-spec-1',
      'idle',
      { expectedTask: parkedGeneration },
    );
  });

  it('parks from fixing with an explicit specReviewRound patch', async () => {
    const m = specManager();
    await seedSpecTask({ status: 'fixing', specReviewRound: 1 });
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-spec-1' });
    vi.spyOn(m, 'markAgentWaiting').mockResolvedValue(true);

    const result = await m.parkTaskAtSpecReady('task-spec-1', { specReviewRound: 2 });
    expect(result?.status).toBe('spec-ready');
    expect(result?.specReviewRound).toBe(2);
  });

  it('does not park or release participants for a stale captured generation', async () => {
    const m = specManager();
    const original = await seedSpecTask({
      status: 'review',
      specReviewRound: 1,
      signalToken: 'old-token',
    });
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-spec-1' });
    await harness.seedAgent({ id: 'qa-1', taskId: 'task-spec-1' });
    const releaseSpy = vi.spyOn(m, 'releaseAgentForTask');
    const waitingSpy = vi.spyOn(m, 'markAgentWaiting');
    await seedSpecTask({
      status: 'review',
      specReviewRound: 2,
      signalToken: 'successor-token',
    });

    const result = await m.parkTaskAtSpecReady('task-spec-1', {
      expectedTask: {
        status: original.status,
        phase: original.phase,
        signalToken: original.signalToken,
        agentId: original.agentId,
        reviewRound: original.reviewRound,
        specReviewRound: original.specReviewRound,
      },
    });

    expect(result).toBeNull();
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(waitingSpy).not.toHaveBeenCalled();
    expect(await harness.taskStore.get('task-spec-1')).toMatchObject({
      status: 'review',
      specReviewRound: 2,
      signalToken: 'successor-token',
    });
  });

  it('does not park or release participants when the parked generation is superseded', async () => {
    const m = specManager();
    await seedSpecTask({
      status: 'review',
      specReviewRound: 1,
      signalToken: 'same-token',
    });
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-spec-1' });
    await harness.seedAgent({ id: 'qa-1', taskId: 'task-spec-1' });
    const transitionTaskStatus = m.transitionTaskStatus.bind(m);
    vi.spyOn(m, 'transitionTaskStatus').mockImplementation(async (...args) => {
      const result = await transitionTaskStatus(...args);
      if (result) {
        await harness.taskStore.set({
          ...result.task,
          specReviewRound: 2,
          updatedAt: new Date().toISOString(),
        });
      }
      return result;
    });

    const result = await m.parkTaskAtSpecReady('task-spec-1', {
      expectedTask: {
        status: 'review',
        phase: 'spec',
        signalToken: 'same-token',
        agentId: 'dev-1',
        reviewRound: 0,
        specReviewRound: 1,
      },
    });

    expect(result?.status).toBe('spec-ready');
    expect(await harness.taskStore.get('task-spec-1')).toMatchObject({
      status: 'spec-ready',
      signalToken: 'same-token',
      specReviewRound: 2,
    });
    expect((await harness.agentStore.get('dev-1'))?.status).not.toBe('waiting');
    expect((await harness.agentStore.get('qa-1'))?.taskId).toBe('task-spec-1');
  });

});

describe('AgentManager max_rounds manual actions', () => {
  function maxRoundsTask(overrides: Partial<TaskState> = {}): TaskState {
    const value = makeTask({
      id: 'task-mr',
      status: 'max_rounds',
      reviewRound: 2,
      prNumber: 42,
      prUrl: 'https://github.com/user/repo/pull/42',
      branch: 'bx/task-mr',
      phase: 'code',
      deliveryConfirmation: { phase: 'code', source: 'signal', at: NOW },
      replyActorId: '77',
      replyActorStatus: 'verified',
      ...overrides,
    });
    if (value.phase === undefined) delete value.deliveryConfirmation;
    else if (!Object.hasOwn(overrides, 'deliveryConfirmation')) {
      value.deliveryConfirmation = { phase: value.phase, source: 'signal', at: NOW };
    }
    return value;
  }

  describe('markTaskComplete', () => {
    it('claims merge-ready before merging, then emits pr.merged to drive the cleanup chain', async () => {
      await harness.taskStore.set(maxRoundsTask());
      const mergeSpy = vi.spyOn(harness.manager, 'mergePr').mockImplementation(async () => {
        expect((await harness.taskStore.get('task-mr'))?.status).toBe('merge-ready');
      });

      const result = await harness.manager.markTaskComplete('task-mr');

      expect(mergeSpy).toHaveBeenCalledWith('task-mr', { humanOverride: true });
      const merged = harness.events.find(e => e.type === 'pr.merged' && e.taskId === 'task-mr');
      expect(merged).toBeTruthy();
      expect(merged!.data).toMatchObject({ prNumber: 42 });
      expect(result.id).toBe('task-mr');
    });

    it.each([
      { name: 'non-max_rounds task', overrides: { status: 'review' as const } },
      { name: 'spec-phase task', overrides: { phase: 'spec' as const } },
    ])('rejects a $name with 409 (no merge)', async ({ overrides }) => {
      await harness.taskStore.set(maxRoundsTask(overrides));
      const mergeSpy = vi.spyOn(harness.manager, 'mergePr').mockResolvedValue();
      await expect(harness.manager.markTaskComplete('task-mr')).rejects.toMatchObject({ status: 409 });
      expect(mergeSpy).not.toHaveBeenCalled();
    });

    it('rejects a task without a PR with 400', async () => {
      await harness.taskStore.set(maxRoundsTask({ prNumber: undefined, prUrl: undefined }));
      await expect(harness.manager.markTaskComplete('task-mr')).rejects.toMatchObject({ status: 400 });
    });

    it('rejects with 409 (no merge) when the dev is awaiting_human (held)', async () => {
      await harness.taskStore.set(maxRoundsTask());
      await harness.seedAgent({
        id: 'dev-1', status: 'awaiting_human',
        awaitingPhase: 'signal-arm-failed:pr-fixed', taskId: 'task-mr',
        workdir: '/tmp/repo/.baxian-worktrees/task-mr_abc', paneId: '%1',
      });
      const mergeSpy = vi.spyOn(harness.manager, 'mergePr').mockResolvedValue();
      await expect(harness.manager.markTaskComplete('task-mr')).rejects.toMatchObject({ status: 409 });
      expect(mergeSpy).not.toHaveBeenCalled();
      expect((await harness.taskStore.get('task-mr'))?.status).toBe('max_rounds');
    });

    it('rejects with 409 (no merge) when the QA is awaiting_human and bound to the task', async () => {
      await harness.taskStore.set(maxRoundsTask({ qaAgentId: 'qa-1' }));
      await harness.seedAgent({
        id: 'dev-1', status: 'waiting',
        taskId: 'task-mr', workdir: '/tmp/repo/.baxian-worktrees/task-mr_abc', paneId: '%1',
      });
      await harness.seedAgent({
        id: 'qa-1', status: 'awaiting_human',
        awaitingPhase: 'ack_unknown', taskId: 'task-mr', paneId: '%2',
      });
      const mergeSpy = vi.spyOn(harness.manager, 'mergePr').mockResolvedValue();
      await expect(harness.manager.markTaskComplete('task-mr')).rejects.toMatchObject({ status: 409 });
      expect(mergeSpy).not.toHaveBeenCalled();
      expect((await harness.taskStore.get('task-mr'))?.status).toBe('max_rounds');
    });

    it('does not block completion when a held QA is bound to a DIFFERENT task (stale ref)', async () => {
      await harness.taskStore.set(maxRoundsTask({ qaAgentId: 'qa-1' }));
      await harness.seedAgent({
        id: 'qa-1', status: 'awaiting_human',
        taskId: 'some-other-task', paneId: '%2',
      });
      const mergeSpy = vi.spyOn(harness.manager, 'mergePr').mockResolvedValue();
      await harness.manager.markTaskComplete('task-mr');
      expect(mergeSpy).toHaveBeenCalledWith('task-mr', { humanOverride: true });
    });

    it('surfaces a merge failure as 409, rolls back to max_rounds, and does not emit pr.merged', async () => {
      await harness.taskStore.set(maxRoundsTask());
      vi.spyOn(harness.manager, 'mergePr').mockRejectedValue(new Error('gh pr merge failed: not approved'));
      await expect(harness.manager.markTaskComplete('task-mr')).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('not approved'),
      });
      expect(harness.events.some(e => e.type === 'pr.merged')).toBe(false);
      expect((await harness.taskStore.get('task-mr'))?.status).toBe('max_rounds');
    });

    async function completeInFlight(): Promise<{ release: () => void; done: Promise<TaskState> }> {
      await harness.taskStore.set(maxRoundsTask());
      await harness.seedAgent({
        id: 'dev-1', status: 'waiting',
        taskId: 'task-mr', workdir: '/tmp/repo/.baxian-worktrees/task-mr_abc',
        paneId: '%1',
      });
      let release: () => void = () => {};
      vi.spyOn(harness.manager, 'mergePr').mockImplementation(
        () => new Promise<void>(resolve => { release = resolve; }),
      );
      const done = harness.manager.markTaskComplete('task-mr');
      await waitUntilAsync(async () => (await harness.taskStore.get('task-mr'))?.status === 'merge-ready');
      return { release, done };
    }

    it('claims so a racing continueDevRound is rejected (no merge-while-fixing)', async () => {
      const { release, done } = await completeInFlight();
      await expect(harness.manager.continueDevRound('task-mr')).rejects.toMatchObject({ status: 409 });
      release();
      await done;
    });

    it('claims so a racing cancelTask is rejected (no merge-then-skip-cleanup)', async () => {
      const { release, done } = await completeInFlight();
      await expect(harness.manager.cancelTask('task-mr')).rejects.toMatchObject({ status: 409 });
      expect((await harness.taskStore.get('task-mr'))?.status).toBe('merge-ready');
      release();
      await done;
    });

    it('claims so a racing dispatchReviewToQa (Call review) is rejected (no merge-while-reviewing)', async () => {
      const { release, done } = await completeInFlight();
      await expect(harness.manager.dispatchReviewToQa('task-mr')).rejects.toMatchObject({ status: 409 });
      expect((await harness.taskStore.get('task-mr'))?.status).toBe('merge-ready');
      release();
      await done;
    });
  });

  describe('continueDevRound', () => {
    async function bindReservedDev(): Promise<void> {
      await harness.seedAgent({
        id: 'dev-1', status: 'waiting',
        taskId: 'task-mr', workdir: '/tmp/repo/.baxian-worktrees/task-mr_abc',
        paneId: '%1',
      });
    }

    async function setupContinueDev(armed: boolean): Promise<void> {
      await harness.taskStore.set(maxRoundsTask());
      await bindReservedDev();
      vi.spyOn(harness.manager, 'acquireAgentForTask').mockResolvedValue(true);
      vi.spyOn(harness.manager as unknown as {
        rotateAndSetupPhaseSignal: () => Promise<{ token: string; armed: boolean }>;
      },
        'rotateAndSetupPhaseSignal').mockResolvedValue({ token: 'fix-token', armed });
    }

    it('transitions max_rounds → fixing, bumps the round, and dispatches the fix', async () => {
      await setupContinueDev(true);
      const continueSpy = vi.spyOn(harness.manager, 'continueSession').mockResolvedValue(true);

      const result = await harness.manager.continueDevRound('task-mr');

      expect(result.status).toBe('fixing');
      expect(result.reviewRound).toBe(3);
      expect(continueSpy).toHaveBeenCalledWith(
        'task-mr',
        'dev-1',
        'fix',
        expect.objectContaining({ signalToken: 'fix-token' }),
      );
    });

    it.each([
      { name: 'non-max_rounds task', overrides: { status: 'fixing' as const } },
      { name: 'spec-phase task', overrides: { phase: 'spec' as const } },
    ])('rejects a $name with 409', async ({ overrides }) => {
      await harness.taskStore.set(maxRoundsTask(overrides));
      await bindReservedDev();
      await expect(harness.manager.continueDevRound('task-mr')).rejects.toMatchObject({ status: 409 });
    });

    it('rejects with 409 when the reserved worktree is gone, pointing at complete/cancel (not Retry)', async () => {
      await harness.taskStore.set(maxRoundsTask());
      await harness.seedAgent({ id: 'dev-1', taskId: 'task-mr', workdir: '' });
      await expect(harness.manager.continueDevRound('task-mr')).rejects.toMatchObject({
        status: 409,
        message: expect.stringMatching(/complete verdict|cancel/),
      });
      expect((await harness.taskStore.get('task-mr'))?.status).toBe('max_rounds');
    });

    it('rolls back to max_rounds and Holds the dev when the pr-fixed watcher fails to arm', async () => {
      await setupContinueDev(false);
      const holdSpy = vi.spyOn(harness.manager, 'markAwaitingHuman').mockResolvedValue(true);
      const continueSpy = vi.spyOn(harness.manager, 'continueSession').mockResolvedValue(true);

      await expect(harness.manager.continueDevRound('task-mr')).rejects.toMatchObject({ status: 500 });
      expect(continueSpy).not.toHaveBeenCalled();
      expect(holdSpy).toHaveBeenCalled();
      const t = await harness.taskStore.get('task-mr');
      expect(t?.status).toBe('max_rounds');
      expect(t?.reviewRound).toBe(2);
    });

    it('rolls back to max_rounds and re-parks the dev when continueSession returns false', async () => {
      await setupContinueDev(true);
      vi.spyOn(harness.manager, 'continueSession').mockResolvedValue(false);
      const waitSpy = vi.spyOn(harness.manager, 'markAgentWaiting').mockResolvedValue(true);

      await expect(harness.manager.continueDevRound('task-mr')).rejects.toMatchObject({ status: 500 });
      const t = await harness.taskStore.get('task-mr');
      expect(t?.status).toBe('max_rounds');
      expect(t?.reviewRound).toBe(2);
      expect(waitSpy).toHaveBeenCalledWith('dev-1', 'task-mr');
    });
  });

  it('markAgentWaiting succeeds for a dev bound to a max_rounds task (active set unification)', async () => {
    await harness.taskStore.set(maxRoundsTask());
    await harness.seedAgent({
      id: 'dev-1', status: 'running',
      taskId: 'task-mr', paneId: '%1',
    });
    await expect(harness.manager.markAgentWaiting('dev-1', 'task-mr')).resolves.toBe(true);
  });

  it('failTasksForAgent fails a max_rounds task when its reserved dev dies', async () => {
    await harness.taskStore.set(maxRoundsTask());
    await harness.seedAgent({
      id: 'dev-1', status: 'waiting', taskId: 'task-mr',
    });
    const { failedTaskIds } = await harness.manager.failTasksForAgent('dev-1', 'tmux-absent');
    expect(failedTaskIds).toContain('task-mr');
    expect((await harness.taskStore.get('task-mr'))?.status).toBe('failed');
  });

  it('failTasksForAgent fails a spec-ready task when its dev dies (approve/reject both need the dev worktree)', async () => {
    await harness.taskStore.set(makeTask({
      id: 'task-sr', status: 'spec-ready', phase: 'spec', agentId: 'dev-1',
    }));
    await harness.seedAgent({ id: 'dev-1', status: 'waiting', taskId: 'task-sr' });
    const { failedTaskIds } = await harness.manager.failTasksForAgent('dev-1', 'tmux-absent');
    expect(failedTaskIds).toContain('task-sr');
    expect((await harness.taskStore.get('task-sr'))?.status).toBe('failed');
  });

  describe('retryTask phase gate', () => {
    it('rejects code-phase max_rounds with 409 (use continue/complete instead)', async () => {
      await harness.taskStore.set(maxRoundsTask());
      await expect(harness.manager.retryTask('task-mr')).rejects.toMatchObject({ status: 409 });
    });

    it('rejects spec-phase max_rounds with 409 because active tasks must use a verdict', async () => {
      await harness.taskStore.set(maxRoundsTask({ phase: 'spec', prNumber: undefined, prUrl: undefined }));
      const createSpy = vi
        .spyOn(harness.manager, 'createAndStartTask')
        .mockResolvedValue(makeTask({ id: 'task-mr-retry', status: 'in_progress' }));

      await expect(harness.manager.retryTask('task-mr')).rejects.toMatchObject({ status: 409 });

      expect(createSpy).not.toHaveBeenCalled();
      expect((await harness.taskStore.get('task-mr'))?.status).toBe('max_rounds');
    });

    it('resolves the current Dev through the surviving QA team when the historical Dev was replaced', async () => {
      await harness.taskStore.set(makeTask({ id: 'task-retry-replaced', status: 'failed' }));
      harness.manager.replaceConfig({
        ...harness.config,
        project: [{
          ...harness.config.project[0]!,
          agent: [[
            { ...harness.config.project[0]!.agent[0]![0]!, id: 'dev-next' },
            harness.config.project[0]!.agent[0]![1]!,
          ]],
        }],
      });
      const validate = vi.spyOn(harness.manager, 'validateTaskDispatch').mockResolvedValue();
      const create = vi.spyOn(harness.manager, 'createTask')
        .mockResolvedValue(makeTask({ id: 'task-retry-created', status: 'pending', agentId: '' }));

      await harness.manager.retryTask('task-retry-replaced');

      expect(validate).toHaveBeenCalledWith('proj', expect.objectContaining({
        preferredAgentId: 'dev-next',
      }));
      expect(create).toHaveBeenCalledWith('proj', expect.objectContaining({
        preferredAgentId: 'dev-next',
      }));
    });

    it('settles the source attention, records the replacement, and rejects another retry', async () => {
      const source = makeTask({ id: 'task-retry-source', status: 'failed' });
      source.attention = {
        reason: 'tmux-probe-absent',
        runbook: 'Retry the failed task.',
        occurredAt: NOW,
        recommendedActions: ['retry'],
        generation: taskAttentionGeneration(source),
      };
      await harness.taskStore.set(source);
      vi.spyOn(harness.manager, 'validateTaskDispatch').mockResolvedValue();
      const create = vi.spyOn(harness.manager, 'createTask')
        .mockResolvedValue(makeTask({ id: 'task-retry-created', status: 'pending', agentId: '' }));

      await expect(harness.manager.retryTask(source.id))
        .resolves.toMatchObject({ id: 'task-retry-created' });

      expect(await harness.taskStore.get(source.id)).toMatchObject({
        replacementTaskId: 'task-retry-created',
      });
      expect((await harness.taskStore.get(source.id))?.attention).toBeUndefined();
      await expect(harness.manager.retryTask(source.id))
        .rejects.toMatchObject({ status: 409, message: expect.stringContaining('task-retry-created') });
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('preserves an intervention that supersedes the attention captured by retry', async () => {
      const source = makeTask({ id: 'task-retry-attention-race', status: 'failed' });
      source.attention = {
        reason: 'first-failure',
        runbook: 'Retry the failed task.',
        occurredAt: NOW,
        recommendedActions: ['retry'],
        generation: taskAttentionGeneration(source),
      };
      await harness.taskStore.set(source);
      vi.spyOn(harness.manager, 'validateTaskDispatch').mockResolvedValue();
      vi.spyOn(harness.manager, 'createTask').mockImplementation(async () => {
        const current = (await harness.taskStore.get(source.id))!;
        await harness.taskStore.set({
          ...current,
          attention: {
            reason: 'newer-failure',
            runbook: 'Inspect the newer failure.',
            occurredAt: '2026-05-14T05:01:00.000Z',
            recommendedActions: ['cancel'],
            generation: taskAttentionGeneration(current),
          },
        });
        return makeTask({ id: 'task-retry-race-created', status: 'pending', agentId: '' });
      });

      await harness.manager.retryTask(source.id);

      expect((await harness.taskStore.get(source.id))?.attention).toMatchObject({
        reason: 'newer-failure',
        occurredAt: '2026-05-14T05:01:00.000Z',
      });
      expect((await harness.taskStore.get(source.id))?.replacementTaskId)
        .toBe('task-retry-race-created');
    });

    it('allows only one replacement creation while concurrent retries overlap', async () => {
      const source = makeTask({ id: 'task-retry-concurrent', status: 'failed' });
      await harness.taskStore.set(source);
      vi.spyOn(harness.manager, 'validateTaskDispatch').mockResolvedValue();
      let releaseCreate!: (task: TaskState) => void;
      const create = vi.spyOn(harness.manager, 'createTask').mockImplementation(() => (
        new Promise<TaskState>(resolve => { releaseCreate = resolve; })
      ));

      const first = harness.manager.retryTask(source.id);
      await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());

      await expect(harness.manager.retryTask(source.id))
        .rejects.toMatchObject({ status: 409, message: expect.stringContaining('in progress') });

      releaseCreate(makeTask({ id: 'task-retry-concurrent-created', status: 'pending', agentId: '' }));
      await expect(first).resolves.toMatchObject({ id: 'task-retry-concurrent-created' });
      expect(create).toHaveBeenCalledOnce();
    });
  });

  it('cancelTask cancels a max_rounds task (non-terminal) and releases the reserved dev', async () => {
    await harness.taskStore.set(maxRoundsTask({ prNumber: undefined, prUrl: undefined }));
    await harness.seedAgent({
      id: 'dev-1', status: 'waiting',
      taskId: 'task-mr', paneId: '%1',
    });
    harness.mockInterruptPane(harness.manager, true);
    const releaseSpy = vi.spyOn(harness.manager, 'releaseAgentForTask').mockResolvedValue(true);

    const cancelled = await harness.manager.cancelTask('task-mr');

    expect(cancelled.status).toBe('cancelled');
    expect(releaseSpy).toHaveBeenCalledWith('dev-1', 'task-mr', 'idle', { allowAwaitingHuman: true, fromCancelCleanup: true });
  });
});

describe('AgentManager.createTask queue reasons', () => {
  it('queues an unassigned task without an agent id in the creation event', async () => {
    const created = await harness.manager.createTask('proj', {
      title: 'pick later',
      description: 'details',
      preferredAgentId: '',
    });

    expect(created).toMatchObject({ status: 'pending', agentId: '', devAgentId: '' });
    const queuedEvent = harness.events.find(e => e.type === 'task.created' && e.taskId === created.id);
    expect(queuedEvent?.data).toEqual({ queued: true, queueReason: 'unassigned' });
  });

  it('queues with agent_locked when the dev binding is free but its lock is already held', async () => {
    await harness.seedAgent({ id: 'dev-1' });
    await harness.acquireAgentLock('dev-1', 'foreign-holder');

    const created = await harness.manager.createTask('proj', {
      title: 'locked out',
      description: 'details',
      preferredAgentId: 'dev-1',
    });

    expect(created.status).toBe('pending');
    expect(created.agentId).toBe('');
    expect(created.qaAgentId).toBe('qa-1');
    const queuedEvent = harness.events.find(e => e.type === 'task.created' && e.taskId === created.id);
    expect(queuedEvent?.data).toMatchObject({ queued: true, queueReason: 'agent_locked', agentId: 'dev-1' });
  });
});

describe('AgentManager.editTask', () => {
  it('404s for an unknown task', async () => {
    await expect(harness.manager.editTask('nope', { title: 'x' })).rejects.toMatchObject({ status: 404 });
  });

  it('409s for a non-pending task', async () => {
    await harness.seedTask({ status: 'in_progress' });
    await expect(harness.manager.editTask('task-1', { title: 'x' })).rejects.toMatchObject({ status: 409 });
  });

  it('edits title and description on a pending task', async () => {
    await harness.seedTask({ status: 'pending' });
    const updated = await harness.manager.editTask('task-1', { title: 'new title', description: 'new desc' });
    expect(updated).toMatchObject({ title: 'new title', description: 'new desc' });
    expect((await harness.taskStore.get('task-1'))?.title).toBe('new title');
  });

  it('clearing preferredAgentId also drops the snapshotted participants and initial phase', async () => {
    await harness.seedTask({
      status: 'pending',
      preferredAgentId: 'dev-1',
      agentId: '',
      devAgentId: 'dev-1',
      qaAgentId: 'qa-1',
    });
    const updated = await harness.manager.editTask('task-1', { preferredAgentId: '' });
    expect(updated.preferredAgentId).toBe('');
    expect(updated).toMatchObject({ agentId: '', devAgentId: '' });
    expect(updated.phase).toBeUndefined();
    expect(updated.qaAgentId).toBeUndefined();
  });

  it('rejects an unknown preferred agent with 400', async () => {
    await harness.seedTask({ status: 'pending' });
    await expect(harness.manager.editTask('task-1', { preferredAgentId: 'ghost' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('rejects a non-dev preferred agent with 400', async () => {
    await harness.seedTask({ status: 'pending' });
    await expect(harness.manager.editTask('task-1', { preferredAgentId: 'qa-1' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('switching the preferred owner to Dev re-derives QA and leaves the initial phase undecided', async () => {
    await harness.seedTask({
      status: 'pending',
      preferredAgentId: '',
      agentId: '',
      devAgentId: '',
      qaAgentId: undefined,
    });
    const updated = await harness.manager.editTask('task-1', { preferredAgentId: 'dev-1' });
    expect(updated.preferredAgentId).toBe('dev-1');
    expect(updated.devAgentId).toBe('dev-1');
    expect(updated.qaAgentId).toBe('qa-1');
    expect(updated.phase).toBeUndefined();
  });
});

describe('AgentManager.failTaskForDispatchError edge paths', () => {
  it('warns (does not transition) when the task is outside the expected fromStatus and still emits the intervention', async () => {
    await harness.seedTask({ status: 'done' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await harness.manager.failTaskForDispatchError(
      'task-1', 'develop', 'dev-1', new DispatchTerminalError('gate_failed', 'gate exploded'),
    );

    expect((await harness.taskStore.get('task-1'))?.status).toBe('done');
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('skipping task transition'))).toBe(true);
    expect(harness.events.some(e => e.type === 'human.intervention'
      && (e.data as { phase?: string }).phase === 'dispatch-failed:gate_failed')).toBe(true);
    warnSpy.mockRestore();
  });

  it('warns when the post-failure release itself throws', async () => {
    await harness.seedTask({ status: 'in_progress' });
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-1' });
    vi.spyOn(harness.manager, 'releaseAgentForTask').mockRejectedValue(new Error('release blip'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await harness.manager.failTaskForDispatchError(
      'task-1', 'develop', 'dev-1', new DispatchTerminalError('prompt_too_large', 'too big'),
    );

    expect((await harness.taskStore.get('task-1'))?.status).toBe('failed');
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('releaseAgentForTask'))).toBe(true);
    warnSpy.mockRestore();
  });
});

describe('AgentManager.transitionToCodePhase failure paths', () => {
  async function seedSpecApproved(overrides: Partial<TaskState> = {}): Promise<void> {
    await harness.seedTask({
      id: 'task-code-1',
      branch: 'bx/task-code-1',
      status: 'review',
      phase: 'spec',
      specReviewRound: 1,
      signalToken: 'old-token',
      qaAgentId: 'qa-1',
      ...overrides,
    });
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-code-1', paneId: '%0' });
  }

  it('holds the dev when the pr-created watcher prevents code-phase delivery', async () => {
    const watcher = { start: vi.fn(async () => false), stop: vi.fn(), has: vi.fn(() => false) };
    const m2 = harness.createManager({ phaseSignalWatcher: watcher as never,
    });
    await seedSpecApproved();
    vi.spyOn(m2, 'releaseAgentForTask').mockResolvedValue(true);
    vi.spyOn(m2, 'acquireAgentForTask').mockResolvedValue(true);
    vi.spyOn(m2, 'continueSession').mockImplementation(async (_taskId, _agentId, _phase, opts) => {
      await opts.armBeforeInject?.({});
      return false;
    });
    const holdSpy = vi.spyOn(m2, 'markAwaitingHuman').mockResolvedValue(true);

    const result = await m2.transitionToCodePhase('task-code-1');

    expect(result).toBeNull();
    expect(watcher.start).toHaveBeenCalledWith(expect.objectContaining({ expectedKinds: 'pr-created' }));
    expect(holdSpy).toHaveBeenCalledWith(
      'dev-1', 'code-dispatch-failed', expect.any(String), { expectedTaskId: 'task-code-1' },
    );
  });

  it('stays at the spec gate and emits code-dev-acquire-failed when the dev is unavailable', async () => {
    const m = harness.createManager();
    await seedSpecApproved();
    vi.spyOn(m, 'releaseAgentForTask').mockResolvedValue(true);
    vi.spyOn(m, 'acquireAgentForTask').mockResolvedValue(false);
    const holdSpy = vi.spyOn(m, 'markAwaitingHuman').mockResolvedValue(true);

    const result = await m.transitionToCodePhase('task-code-1');

    expect(result).toBeNull();
    expect(holdSpy).not.toHaveBeenCalled();
    expect((await harness.taskStore.get('task-code-1'))?.status).toBe('review');
    expect(harness.events.some(e => e.type === 'human.intervention'
      && (e.data as { phase?: string }).phase === 'code-dev-acquire-failed')).toBe(true);
  });

  it('fails the task on a DispatchTerminalError from the code dispatch', async () => {
    const m = harness.createManager();
    await seedSpecApproved();
    vi.spyOn(m, 'releaseAgentForTask').mockResolvedValue(true);
    vi.spyOn(m, 'acquireAgentForTask').mockResolvedValue(true);
    vi.spyOn(m, 'continueSession').mockRejectedValue(new DispatchTerminalError('prompt_too_large', 'too big'));
    const failSpy = vi.spyOn(m, 'failTaskForDispatchError').mockResolvedValue();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(m.transitionToCodePhase('task-code-1')).rejects.toMatchObject({ reason: 'prompt_too_large' });
    expect(failSpy).toHaveBeenCalledWith('task-code-1', 'code', 'dev-1', expect.anything());
    errSpy.mockRestore();
  });

  it('holds the dev on a generic code dispatch error', async () => {
    const m = harness.createManager();
    await seedSpecApproved();
    vi.spyOn(m, 'releaseAgentForTask').mockResolvedValue(true);
    vi.spyOn(m, 'acquireAgentForTask').mockResolvedValue(true);
    vi.spyOn(m, 'continueSession').mockRejectedValue(new Error('pane vanished'));
    const holdSpy = vi.spyOn(m, 'markAwaitingHuman').mockResolvedValue(true);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(m.transitionToCodePhase('task-code-1')).rejects.toThrow('pane vanished');
    expect(holdSpy).toHaveBeenCalledWith('dev-1', 'code-dispatch-failed', expect.any(String), { expectedTaskId: 'task-code-1' });
    errSpy.mockRestore();
  });

  it('holds the dev and emits code-resume-failed when the code prompt is not delivered', async () => {
    const m = harness.createManager();
    await seedSpecApproved();
    vi.spyOn(m, 'releaseAgentForTask').mockResolvedValue(true);
    vi.spyOn(m, 'acquireAgentForTask').mockResolvedValue(true);
    vi.spyOn(m, 'continueSession').mockResolvedValue(false);
    const holdSpy = vi.spyOn(m, 'markAwaitingHuman').mockResolvedValue(true);

    const result = await m.transitionToCodePhase('task-code-1');

    expect(result).toBeNull();
    expect(holdSpy).toHaveBeenCalled();
    expect(harness.events.some(e => e.type === 'human.intervention'
      && (e.data as { phase?: string }).phase === 'code-resume-failed')).toBe(true);
  });
});
