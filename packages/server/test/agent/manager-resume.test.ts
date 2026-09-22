import { describe, it, expect, vi } from 'vitest';
import type { TaskState } from '../../src/shared/index.js';
import { DispatchTerminalError, EnsureSessionError, canDispatchWithBinding } from '../../src/agent/manager.js';
import { ApiError } from '../../src/errors.js';
import { BranchManager } from '../../src/agent/branch.js';
import { createManagerSuiteRunner, useManagerSuiteHarness } from '../helpers/manager-harness.js';
import type { FakeRunner, FakeRunnerOptions } from '../helpers/fake-runner.js';
import { makeTask } from '../helpers/fixtures.js';

const NOW = '2026-05-14T05:00:00.000Z';

const harness = useManagerSuiteHarness();

// 已确认交付的 code 评审任务:Resume 的复评走真实 lease → 派单链路
function seedReviewTask(overrides: Partial<TaskState> = {}): Promise<TaskState> {
  return harness.seedTask({
    status: 'review',
    phase: 'code',
    deliveryConfirmation: { phase: 'code', source: 'signal', at: NOW },
    qaAgentId: 'qa-1',
    prNumber: 12,
    ...overrides,
    ...(overrides.phase === 'spec'
      ? { deliveryConfirmation: { phase: 'spec', source: 'signal', at: NOW } }
      : {}),
  });
}

// 没有补派复评:既没往任何 pane 粘贴提示词,也没开出新的评审租约
async function expectNoRedispatch(taskId: string): Promise<void> {
  expect(harness.runner.pastedPrompts).toEqual([]);
  expect((await harness.taskStore.get(taskId))?.reviewDispatch).toBeUndefined();
}

// 换一台带不同布置的 live runner,manager 经公共依赖重建
function useRunner(options: FakeRunnerOptions): FakeRunner {
  const runner = createManagerSuiteRunner(options);
  harness.manager = harness.createManager({ runnerFactory: () => runner });
  return runner;
}

describe('AgentManager awaiting_human lifecycle', () => {
  it('markAwaitingHuman sets status + emits intervention, preserving binding and lock', async () => {
    const t = await harness.seedTask();
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await harness.acquireAgentLock('dev-1');

    await harness.manager.markAwaitingHuman('dev-1', 'test-phase', 'test reason');

    const state = await harness.agentStore.get('dev-1');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('test-phase');
    expect(state?.awaitingReason).toBe('test reason');
    expect(state?.awaitingSince).toBeTruthy();
    expect(state?.taskId).toBe(t.id);
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);

    const emitted = harness.events.filter(
      e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'test-phase',
    );
    expect(emitted).toHaveLength(1);
  });

  it.each([
    { name: 'terminal task clears binding + releases lock', taskStatus: 'cancelled' as const, expectRelease: true },
    { name: 'active task clears status only, keeps binding', taskStatus: 'in_progress' as const, expectRelease: false },
  ])('resumeAgent on awaiting_human (cancel-interrupt-failed): $name', async ({ taskStatus, expectRelease }) => {
    const t = await harness.seedTask({ status: taskStatus });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed' });
    await harness.acquireAgentLock('dev-1');

    const result = await harness.manager.resumeAgent('dev-1');

    expect(result).toEqual({ resumed: true, releasedBinding: expectRelease });
    const state = await harness.agentStore.get('dev-1');
    expect(state?.status).toBeUndefined();
    if (expectRelease) {
      expect(state?.taskId).toBeUndefined();
      expect(state?.awaitingPhase).toBeUndefined();
    } else {
      expect(state?.taskId).toBe(t.id);
    }
    expect(await harness.lockManager.isLocked('dev-1')).toBe(!expectRelease);
  });

  it.each([
    'agent_dialog_resolved_runtime',
    'signal-arm-failed:spec-done,pr-created',
    'restart-redispatch-failed',
    'bootstrap-marker-clear-failed',
  ])('resumeAgent REFUSES on awaitingPhase=%s + active task', async (phase) => {
    const t = await harness.seedTask({ status: 'in_progress' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: phase });
    await harness.acquireAgentLock('dev-1');

    const result = await harness.manager.resumeAgent('dev-1');

    expect(result).toMatchObject({ resumed: false, releasedBinding: false });
    expect(result.reason).toBeTruthy();
    expect((await harness.agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });

  it.each(['restart-redispatch-failed', 'bootstrap-marker-clear-failed'])('releases a %s hold once its task is cancelled', async (awaitingPhase) => {
    const task = await harness.seedTask({ status: 'cancelled' });
    await harness.seedAgent({
      id: 'dev-1', taskId: task.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase, bootstrappingTaskId: task.id,
    });
    await harness.acquireAgentLock('dev-1');

    await expect(harness.manager.resumeAgent('dev-1')).resolves.toEqual({
      resumed: true, releasedBinding: true,
    });

    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
    await expectNoRedispatch(task.id);
  });

  it.each([undefined, 'code'] as const)('preserves delivered bootstrap evidence on Resume for phase=%s', async (phase) => {
    const task = await harness.seedTask({ status: 'in_progress', phase, signalToken: 'delivered-token' });
    await harness.seedAgent({
      id: 'dev-1', taskId: task.id, paneId: '%0', bootstrappingTaskId: task.id,
      status: 'awaiting_human', awaitingPhase: 'bootstrap-marker-clear-failed',
      awaitingReason: 'initial prompt was already delivered', awaitingSince: NOW, awaitingNonce: 'hold-1',
    });
    await harness.acquireAgentLock('dev-1');
    const held = await harness.agentStore.get('dev-1');

    await expect(harness.manager.resumeAgent('dev-1')).resolves.toMatchObject({
      resumed: false, releasedBinding: false, reason: expect.stringContaining('already delivered'),
    });
    expect(await harness.agentStore.get('dev-1')).toEqual(held);
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
    await expect(harness.manager.advanceTask(task.id)).rejects.toMatchObject({ status: 409 });
    await harness.manager.redispatchTaskPromptAfterReplRestart('dev-1', task.id);

    expect(harness.runner.pastedPrompts).toEqual([]);
    expect((await harness.taskStore.get(task.id))?.signalToken).toBe('delivered-token');
    expect((await harness.agentStore.get('dev-1'))?.bootstrappingTaskId).toBe(task.id);
  });

  it.each(['spec-ready', 'review', 'fixing', 'approved', 'merge-ready', 'max_rounds'] as const)(
    'clears a stale delivered-bootstrap hold after the task reaches %s without replaying', async (status) => {
      const task = await harness.seedTask({ status, signalToken: 'advanced-token' });
      await harness.seedAgent({
        id: 'dev-1', taskId: task.id, paneId: '%0', bootstrappingTaskId: task.id,
        status: 'awaiting_human', awaitingPhase: 'bootstrap-marker-clear-failed',
      });
      const held = await harness.agentStore.get('dev-1');

      await expect(harness.manager.resumeAgent('dev-1')).resolves.toMatchObject({ resumed: true });

      expect(await harness.agentStore.get('dev-1')).toMatchObject({ taskId: task.id, lockToken: held?.lockToken });
      expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBeUndefined();
      expect((await harness.agentStore.get('dev-1'))?.bootstrappingTaskId).toBeUndefined();
      expect(await harness.taskStore.get(task.id)).toEqual(task);
      expect(harness.runner.pastedPrompts).toEqual([]);
    },
  );

  it.each([
    { status: 'spec-ready', phase: 'spec', nextPhase: 'code' },
    { status: 'fixing', phase: 'spec', nextPhase: 'fix' },
    { status: 'fixing', phase: 'code', nextPhase: 'fix' },
  ] as const)('allows $status/$phase dispatch after clearing its stale bootstrap hold', async ({ status, phase, nextPhase }) => {
    const task = await harness.seedTask({ status, phase, prNumber: 42, signalToken: 'advanced-token' });
    await harness.seedAgent({
      id: 'dev-1', taskId: task.id, paneId: '%0', bootstrappingTaskId: task.id,
      status: 'awaiting_human', awaitingPhase: 'bootstrap-marker-clear-failed',
    });

    await expect(harness.manager.resumeAgent('dev-1')).resolves.toMatchObject({ resumed: true });
    if (status === 'spec-ready') {
      await expect(harness.manager.transitionToCodePhase(task.id)).resolves.toMatchObject({ status: 'in_progress', phase: 'code' });
    } else {
      await expect(harness.manager.dispatchGitFixToDev(task.id)).resolves.toBe(true);
    }

    expect(harness.runner.pastedPrompts).toEqual([{ pane: '%0', body: expect.stringContaining(`phase: ${nextPhase}`) }]);
    expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBeUndefined();
    expect(harness.events.some(event => event.type === 'human.intervention'
      && (event.data.phase === 'code-dev-acquire-failed' || event.data.phase === 'dev-acquire-failed-fix'))).toBe(false);
  });

  it('logs the task and reason when Resume is blocked by a replay failure', async () => {
    const task = await harness.seedTask({ status: 'in_progress' });
    await harness.seedAgent({
      id: 'dev-1', taskId: task.id, status: 'awaiting_human',
      awaitingPhase: 'restart-redispatch-failed',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await harness.manager.resumeAgent('dev-1');

    expect(result).toMatchObject({ resumed: false, releasedBinding: false });
    expect(result.reason).toContain(task.id);
    expect(result.reason).toContain('restart-redispatch-failed');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dev-1'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(result.reason!));
    await expectNoRedispatch(task.id);
  });

  it.each(['in_progress', 'fixing', 'approved'] as const)(
    'keeps a replay failure held while the Dev prompt is still needed in %s', async (status) => {
      const task = await harness.seedTask({ status, signalToken: 'held-token' });
      await harness.seedAgent({
        taskId: task.id, paneId: '%0', status: 'awaiting_human',
        awaitingPhase: 'restart-redispatch-failed', bootstrappingTaskId: task.id,
      });
      const held = await harness.agentStore.get('dev-1');

      await expect(harness.manager.resumeAgent('dev-1')).resolves.toMatchObject({ resumed: false });

      expect(await harness.agentStore.get('dev-1')).toEqual(held);
      expect(await harness.taskStore.get(task.id)).toEqual(task);
      expect(harness.runner.pastedPrompts).toEqual([]);
    },
  );

  it.each(['spec-ready', 'review', 'merge-ready', 'max_rounds'] as const)(
    'clears a stale replay failure when the task no longer needs that prompt in %s', async (status) => {
      const task = await harness.seedTask({ status, signalToken: 'advanced-token' });
      await harness.seedAgent({
        taskId: task.id, paneId: '%0', status: 'awaiting_human',
        awaitingPhase: 'restart-redispatch-failed',
      });
      const held = await harness.agentStore.get('dev-1');

      await expect(harness.manager.resumeAgent('dev-1')).resolves.toEqual({ resumed: true, releasedBinding: false });

      expect(await harness.agentStore.get('dev-1')).toMatchObject({ taskId: task.id, lockToken: held?.lockToken });
      expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBeUndefined();
      expect(await harness.taskStore.get(task.id)).toEqual(task);
      expect(harness.runner.pastedPrompts).toEqual([]);
    },
  );

  it.each(['spec', 'code'] as const)(
    'recovers QA Advance after fixing/%s moves to review with a stale Dev replay failure', async (phase) => {
      const task = await harness.seedTask({
        status: 'fixing', phase, prNumber: 42, signalToken: 'fix-token',
        deliveryConfirmation: { phase, source: 'signal', at: NOW },
      });
      await harness.seedAgent({
        taskId: task.id, paneId: '%0', status: 'awaiting_human',
        awaitingPhase: 'restart-redispatch-failed',
      });

      await expect(harness.manager.advanceTask(task.id, { executor: 'qa' })).rejects.toMatchObject({
        status: 500, message: expect.stringContaining('Cannot park dev'),
      });
      const review = await harness.taskStore.get(task.id);
      expect(review).toMatchObject({ status: 'review', phase, reviewDispatch: { phase: 'pending' } });
      expect(harness.runner.pastedPrompts).toEqual([]);

      await expect(harness.manager.resumeAgent('dev-1')).resolves.toEqual({ resumed: true, releasedBinding: false });
      expect(await harness.taskStore.get(task.id)).toEqual(review);
      expect(harness.runner.pastedPrompts).toEqual([]);
      await expect(harness.manager.advanceTask(task.id, { executor: 'qa' })).resolves.toMatchObject({ status: 'review' });

      expect(harness.runner.pastedPrompts).toHaveLength(1);
      expect(harness.runner.pastedPrompts[0]?.pane).toBe('%1');
      expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBeUndefined();
      expect((await harness.taskStore.get(task.id))?.signalToken).toBe(review?.signalToken);
    },
  );

  it('resumeAgent ALLOWS release on awaitingPhase=agent_dialog_resolved_runtime (slowPoll detected REPL ready)', async () => {
    const t = await harness.seedTask({ status: 'failed' });
    await harness.taskStore.set(t);
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'agent_dialog_resolved_runtime',
    });
    await harness.acquireAgentLock('dev-1');

    const result = await harness.manager.resumeAgent('dev-1');

    expect(result).toEqual({ resumed: true, releasedBinding: true });
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
  });

  it('resumeAgent refuses when awaitingPhase=agent_dialog_pending (pane still blocked on dialog)', async () => {
    const t = makeTask({ status: 'failed' });
    await harness.taskStore.set(t);
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'agent_dialog_pending',
    });
    await harness.acquireAgentLock('dev-1');

    const result = await harness.manager.resumeAgent('dev-1');

    expect(result).toMatchObject({ resumed: false, releasedBinding: false });
    expect(result.reason).toBeTruthy();
    expect((await harness.agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBe('agent_dialog_pending');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });

  it('resumeAgent on agent that is not awaiting_human: noop', async () => {
    await harness.seedAgent({ id: 'dev-1' });

    const result = await harness.manager.resumeAgent('dev-1');

    expect(result).toMatchObject({ resumed: false, releasedBinding: false });
  });

  it('resumeAgent refuses when creationToken still set (bootstrap dialog unresolved)', async () => {
    await harness.seedAgent({
      id: 'dev-1', creationToken: 'tok-still-pending',
      paneId: '%0',
      status: 'awaiting_human',
      awaitingPhase: 'agent_dialog_pending',
    });

    const result = await harness.manager.resumeAgent('dev-1');

    expect(result).toMatchObject({ resumed: false, releasedBinding: false });
    expect(result.reason).toBeTruthy();
    expect((await harness.agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect((await harness.agentStore.get('dev-1'))?.creationToken).toBe('tok-still-pending');
  });

  it.each([
    { name: 'active task (fixing) refuses', taskId: 'task-qa-stale', taskStatus: 'fixing' as const, expectRelease: false },
    { name: 'terminal task (cancelled) releases', taskId: 'task-qa-cancelled', taskStatus: 'cancelled' as const, expectRelease: true },
  ])('resumeAgent on dev-wait-gate-failed-after-qa-started: $name', async ({ taskId, taskStatus, expectRelease }) => {
    const t = await harness.seedTask({ id: taskId, status: taskStatus });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1', status: 'awaiting_human', awaitingPhase: 'dev-wait-gate-failed-after-qa-started' });
    await harness.acquireAgentLock('qa-1');

    const result = await harness.manager.resumeAgent('qa-1');

    expect(result).toMatchObject({ resumed: expectRelease, releasedBinding: expectRelease });
    if (!expectRelease) expect(result.reason).toBeTruthy();
    expect((await harness.agentStore.get('qa-1'))?.taskId).toBe(expectRelease ? undefined : t.id);
    if (!expectRelease) expect((await harness.agentStore.get('qa-1'))?.status).toBe('awaiting_human');
    expect(await harness.lockManager.isLocked('qa-1')).toBe(!expectRelease);
  });

  it('releaseAgentForTask with allowAwaitingHuman=true bypasses gate (explicit recovery path)', async () => {
    const t = await harness.seedTask();
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown',
    });
    await harness.acquireAgentLock('dev-1');

    const ok = await harness.manager.releaseAgentForTask('dev-1', t.id, 'idle', { allowAwaitingHuman: true });

    expect(ok).toBe(true);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
  });

  it('validateTaskDispatch ALLOWS create against awaiting_human agent (queues to pending; dispatch-time gates availability)', async () => {
    await harness.seedAgent({
      id: 'dev-1', status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
    });

    await expect(
      harness.manager.validateTaskDispatch('proj', {
        title: 'x', description: 'y', preferredAgentId: 'dev-1',
      }),
    ).resolves.toBeUndefined();
  });

  it('resumeAgent no longer triggers drainQueue (pending tasks wait for explicit dispatchPendingTask)', async () => {
    const t = await harness.seedTask({ id: 'task-resume-drain', status: 'cancelled' });
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
    });
    await harness.acquireAgentLock('dev-1');

    const result = await harness.manager.resumeAgent('dev-1');

    expect(result.resumed).toBe(true);
    expect(result.releasedBinding).toBe(true);
    expect('drainQueue' in (harness.manager as unknown as Record<string, unknown>)).toBe(false);
  });

  it.each([
    { name: 'task terminal → bypass even without opt', agentId: 'dev-1', paneId: '%0', taskStatus: 'merged' as const, phase: 'dispatch-failed:ack_unknown', opt: undefined, expectedOk: true },
    { name: 'dev-wait-gate-failed + active task refuses', agentId: 'qa-1', paneId: '%1', taskStatus: 'fixing' as const, phase: 'dev-wait-gate-failed-after-qa-started', opt: undefined, expectedOk: false },
    { name: 'dev-wait-gate-failed WITH allowAwaitingHuman releases', agentId: 'qa-1', paneId: '%1', taskStatus: 'approved' as const, phase: 'dev-wait-gate-failed-after-qa-started', opt: { allowAwaitingHuman: true }, expectedOk: true },
    { name: 'dispatch-failed:ack_unknown without opt refuses', agentId: 'qa-1', paneId: '%1', taskStatus: 'review' as const, phase: 'dispatch-failed:ack_unknown', opt: undefined, expectedOk: false },
    { name: 'dispatch-failed:ack_unknown WITH allowAwaitingHuman releases', agentId: 'qa-1', paneId: '%1', taskStatus: 'approved' as const, phase: 'dispatch-failed:ack_unknown', opt: { allowAwaitingHuman: true }, expectedOk: true },
  ])('releaseAgentForTask gate: $name', async ({ agentId, paneId, taskStatus, phase, opt, expectedOk }) => {
    const t = await harness.seedTask({ status: taskStatus });
    await harness.seedAgent({ id: agentId, taskId: t.id, paneId, status: 'awaiting_human', awaitingPhase: phase });
    await harness.acquireAgentLock(agentId);

    const ok = await harness.manager.releaseAgentForTask(agentId, t.id, 'idle', opt);

    expect(ok).toBe(expectedOk);
    expect((await harness.agentStore.get(agentId))?.taskId).toBe(expectedOk ? undefined : t.id);
    expect(await harness.lockManager.isLocked(agentId)).toBe(!expectedOk);
  });

  it.each([
    { name: 'bound task still active refuses', boundTaskId: undefined, taskStatus: 'review' as const, expectRelease: false },
    { name: 'bound task TERMINAL releases', boundTaskId: undefined, taskStatus: 'failed' as const, expectRelease: true },
    { name: 'bound task MISSING releases', boundTaskId: 'ghost-task', taskStatus: undefined, expectRelease: true },
  ])('resumeAgent on dispatch-failed:ack_unknown: $name', async ({ boundTaskId, taskStatus, expectRelease }) => {
    let taskId = boundTaskId ?? 'ghost-task';
    if (taskStatus) {
      const t = await harness.seedTask({ status: taskStatus });
      taskId = t.id;
    }
    await harness.seedAgent({ id: 'qa-1', taskId, paneId: '%1', status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown' });
    await harness.acquireAgentLock('qa-1');

    const result = await harness.manager.resumeAgent('qa-1');

    expect(result).toMatchObject({ resumed: expectRelease, releasedBinding: expectRelease });
    if (!expectRelease) {
      expect(result.reason).toContain('Confirm the uncertain review dispatch');
    }
    const after = await harness.agentStore.get('qa-1');
    if (expectRelease) {
      expect(after?.taskId).toBeUndefined();
      if (taskStatus === 'failed') expect(after?.status).toBeUndefined();
    } else {
      expect(after?.status).toBe('awaiting_human');
      expect(after?.taskId).toBe(taskId);
    }
    expect(await harness.lockManager.isLocked('qa-1')).toBe(!expectRelease);
  });

  it.each(['spec-ready', 'review', 'merge-ready', 'max_rounds'] as const)(
    'resumes an uncertain Dev delivery after the task reaches %s', async (status) => {
      const task = await harness.seedTask({ status, phase: 'spec', prNumber: 42, signalToken: 'outcome-token' });
      await harness.seedAgent({
        taskId: task.id, paneId: '%0', status: 'awaiting_human',
        awaitingPhase: 'dispatch-failed:ack_unknown', bootstrappingTaskId: task.id,
      });
      const held = await harness.agentStore.get('dev-1');

      await expect(harness.manager.resumeAgent('dev-1')).resolves.toEqual({ resumed: true, releasedBinding: false });

      expect(await harness.agentStore.get('dev-1')).toMatchObject({ taskId: task.id, lockToken: held?.lockToken });
      expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBeUndefined();
      expect((await harness.agentStore.get('dev-1'))?.bootstrappingTaskId).toBeUndefined();
      expect(await harness.taskStore.get(task.id)).toEqual(task);
      expect(harness.runner.pastedPrompts).toEqual([]);
      if (status === 'spec-ready') {
        await expect(harness.manager.transitionToCodePhase(task.id)).resolves.toMatchObject({ status: 'in_progress', phase: 'code' });
        expect(harness.runner.pastedPrompts).toEqual([{ pane: '%0', body: expect.stringContaining('phase: code') }]);
      }
    },
  );

  it.each(['in_progress', 'fixing', 'approved'] as const)(
    'keeps an uncertain Dev delivery blocked while the task remains %s', async (status) => {
      const task = await harness.seedTask({ status, signalToken: 'uncertain-token' });
      await harness.seedAgent({
        taskId: task.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown',
      });
      const held = await harness.agentStore.get('dev-1');

      await expect(harness.manager.resumeAgent('dev-1')).resolves.toMatchObject({ resumed: false });

      expect(await harness.agentStore.get('dev-1')).toEqual(held);
      expect(await harness.taskStore.get(task.id)).toEqual(task);
      expect(harness.runner.pastedPrompts).toEqual([]);
    },
  );

  it('handleDialogPendingFromRuntime also releases partner agents on task fail (UI Retry path truly opens)', async () => {
    const t = await harness.seedTask({ id: 'task-partner-cleanup', status: 'in_progress', qaAgentId: 'qa-1' });
    await harness.seedAgent({
      id: 'qa-1', taskId: t.id, paneId: '%1',
    });
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await harness.acquireAgentLock('qa-1');
    await harness.acquireAgentLock('dev-1');

    const err = new EnsureSessionError(
      { createdSession: false, agentId: 'qa-1', dialogPending: true },
      'runtime dialog',
    );
    await harness.manager.handleDialogPendingFromRuntime('qa-1', err);

    expect((await harness.taskStore.get(t.id))?.status).toBe('failed');
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
    expect((await harness.agentStore.get('qa-1'))?.status).toBe('awaiting_human');
  });

  it('handleDialogPendingFromRuntime fails active task (prompt not injected; UI Retry path opens)', async () => {
    const t = await harness.seedTask({ status: 'in_progress' });
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await harness.acquireAgentLock('dev-1');

    const err = new EnsureSessionError(
      { createdSession: false, agentId: 'dev-1', dialogPending: true },
      'runtime dialog',
    );
    const handled = await harness.manager.handleDialogPendingFromRuntime('dev-1', err);

    expect(handled).toBe(true);
    expect((await harness.taskStore.get(t.id))?.status).toBe('failed');
    expect((await harness.agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBe('agent_dialog_pending');
    expect(err.partial.handled).toBe(true);
  });

  it('handleDialogPendingFromRuntime task fail SKIPS when outcome moved task past dispatch phase expected status', async () => {
    const t = await harness.seedTask({ id: 'task-outcome-arrived', status: 'approved' });
    await harness.taskStore.set(t);
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await harness.acquireAgentLock('dev-1');

    const err = new EnsureSessionError(
      { createdSession: false, agentId: 'dev-1', dialogPending: true },
      'late dialog after outcome',
    );
    const handled = await harness.manager.handleDialogPendingFromRuntime('dev-1', err, { expectedFromStatuses: ['in_progress'] });

    expect(handled).toBe(true);
    expect((await harness.taskStore.get(t.id))?.status).toBe('approved');
    expect((await harness.agentStore.get('dev-1'))?.status).toBe('awaiting_human');
  });

  it('handleDialogPendingFromRuntime task fail WORKS when task still in dispatch expected fromStatus', async () => {
    const t = await harness.seedTask({ id: 'task-still-in-progress', status: 'in_progress' });
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await harness.acquireAgentLock('dev-1');

    const err = new EnsureSessionError(
      { createdSession: false, agentId: 'dev-1', dialogPending: true },
      'dialog during in_progress dispatch',
    );
    const handled = await harness.manager.handleDialogPendingFromRuntime('dev-1', err, { expectedFromStatuses: ['in_progress'] });

    expect(handled).toBe(true);
    expect((await harness.taskStore.get(t.id))?.status).toBe('failed');
    expect((await harness.agentStore.get('dev-1'))?.status).toBe('awaiting_human');
  });

  it('handleDialogPendingFromRuntime task fail is serialized via transitionTaskStatus (does not overwrite concurrent terminal)', async () => {
    const t = await harness.seedTask({ id: 'task-already-cancelled', status: 'cancelled' });
    await harness.taskStore.set(t);
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await harness.acquireAgentLock('dev-1');

    const err = new EnsureSessionError(
      { createdSession: false, agentId: 'dev-1', dialogPending: true },
      'runtime dialog after cancel',
    );
    const handled = await harness.manager.handleDialogPendingFromRuntime('dev-1', err);

    expect(handled).toBe(true);
    expect((await harness.taskStore.get(t.id))?.status).toBe('cancelled');
    expect((await harness.agentStore.get('dev-1'))?.status).toBe('awaiting_human');
  });

  it('handleDialogPendingFromRuntime: retry path (state empty + createdSession=true) probes tmux paneId and marks awaiting_human', async () => {
    await harness.seedAgent({ id: 'dev-1' });
    useRunner({ agents: { 'dev-1': { paneId: '%99' } } });

    const err = new EnsureSessionError(
      { createdSession: true, agentId: 'dev-1', dialogPending: true },
      'retry path runtime dialog',
    );
    const handled = await harness.manager.handleDialogPendingFromRuntime('dev-1', err);

    expect(handled).toBe(true);
    const state = await harness.agentStore.get('dev-1');
    expect(state?.paneId).toBe('%99');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('agent_dialog_pending');
  });

  it('handleDialogPendingFromRuntime: retry path with tmux probe failure returns false (caller rollbacks)', async () => {
    await harness.seedAgent({ id: 'dev-1' });
    // 会话不在了:pane 探测失败,调用方回滚
    useRunner({ session: 'absent' });

    const err = new EnsureSessionError(
      { createdSession: true, agentId: 'dev-1', dialogPending: true },
      'retry path runtime dialog',
    );
    const handled = await harness.manager.handleDialogPendingFromRuntime('dev-1', err);

    expect(handled).toBe(false);
    const state = await harness.agentStore.get('dev-1');
    expect(state?.status).toBeUndefined();
    expect(state?.paneId).toBeUndefined();
  });

  it('handleDialogPendingFromRuntime retry path: paneId guard rejects writes when fresh agent already has paneId (DELETE+recreate covered)', async () => {
    await harness.seedAgent({ id: 'dev-1', paneId: '%new' });
    useRunner({ agents: { 'dev-1': { paneId: '%old' } } });

    const err = new EnsureSessionError(
      { createdSession: true, agentId: 'dev-1', dialogPending: true },
      'stale retry runtime dialog',
    );
    const handled = await harness.manager.handleDialogPendingFromRuntime('dev-1', err);

    expect(handled).toBe(true);
    const state = await harness.agentStore.get('dev-1');
    expect(state?.paneId).toBe('%new');
    expect(state?.status).toBe('awaiting_human');
  });

  it('handleDialogPendingFromRuntime: state empty + createdSession=false returns false (no generation evidence available)', async () => {
    await harness.seedAgent({ id: 'dev-1' });

    const err = new EnsureSessionError(
      { createdSession: false, agentId: 'dev-1', dialogPending: true },
      'adopt path runtime dialog',
    );
    const handled = await harness.manager.handleDialogPendingFromRuntime('dev-1', err);

    expect(handled).toBe(false);
    const state = await harness.agentStore.get('dev-1');
    expect(state?.status).toBeUndefined();
  });

  it.each([
    { name: 'noop when binding has shifted to a different task', boundTaskId: 'task-new', expectedTaskId: 'task-old', expectWrite: false },
    { name: 'writes when binding still matches', boundTaskId: 'task-current', expectedTaskId: 'task-current', expectWrite: true },
  ])('markAwaitingHuman with expectedTaskId guard: $name', async ({ boundTaskId, expectedTaskId, expectWrite }) => {
    await harness.seedAgent({ id: 'qa-1', taskId: boundTaskId, paneId: '%0' });

    await harness.manager.markAwaitingHuman('qa-1', 'dispatch-failed:ack_unknown', 'ack_unknown', { expectedTaskId });

    const state = await harness.agentStore.get('qa-1');
    if (expectWrite) {
      expect(state?.status).toBe('awaiting_human');
      expect(state?.awaitingPhase).toBe('dispatch-failed:ack_unknown');
    } else {
      expect(state?.status).toBeUndefined();
      expect(state?.awaitingPhase).toBeUndefined();
      expect(state?.taskId).toBe('task-new');
    }
  });

  it.each([
    { name: 'expectedCreationToken=null noop when token has been set', seededToken: 'tok-recreated', expectedToken: null, reason: 'stale runtime callback', expectWrite: false, checkNoEmit: false },
    { name: 'noop on token mismatch', seededToken: 'tok-new', expectedToken: 'tok-old', reason: 'stale token holder', expectWrite: false, checkNoEmit: true },
    { name: 'writes on token match', seededToken: 'tok-match', expectedToken: 'tok-match', reason: 'good', expectWrite: true, checkNoEmit: false },
  ])('markAwaitingHuman with expectedCreationToken: $name (DELETE+recreate race)', async ({ seededToken, expectedToken, reason, expectWrite, checkNoEmit }) => {
    await harness.seedAgent({ id: 'dev-1', creationToken: seededToken });

    await harness.manager.markAwaitingHuman('dev-1', 'agent_dialog_pending', reason, { expectedCreationToken: expectedToken });

    const state = await harness.agentStore.get('dev-1');
    if (expectWrite) {
      expect(state?.status).toBe('awaiting_human');
    } else {
      expect(state?.status).toBeUndefined();
      expect(state?.awaitingPhase).toBeUndefined();
    }
    if (checkNoEmit) {
      const emitted = harness.events.filter(
        e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'agent_dialog_pending',
      );
      expect(emitted).toHaveLength(0);
    }
  });

  it('releaseAgentForTask refuses to release when status=awaiting_human (no allowAwaitingHuman opt)', async () => {
    const t = await harness.seedTask();
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
    });
    await harness.acquireAgentLock('dev-1');

    const ok = await harness.manager.releaseAgentForTask('dev-1', t.id, 'idle');

    expect(ok).toBe(false);
    expect((await harness.agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });

  it('canDispatchWithBinding rejects awaiting_human agent even if taskId cleared', async () => {
    expect(canDispatchWithBinding({
      id: 'dev-1', projectId: 'proj', updatedAt: NOW, status: 'awaiting_human',
    })).toBe(false);
    expect(canDispatchWithBinding({
      id: 'dev-1', projectId: 'proj', updatedAt: NOW, status: 'ok',
    })).toBe(true);
    expect(canDispatchWithBinding({
      id: 'dev-1', projectId: 'proj', updatedAt: NOW,
    })).toBe(true);
  });

  it('canDispatchWithBinding rejects same-task reentry when awaiting_human (cannot bypass via reentry phase)', async () => {
    await harness.seedTask({ id: 'task-reentry-block' });
    await harness.seedAgent({
      id: 'dev-1', taskId: 'task-reentry-block', paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
    });
    await harness.acquireAgentLock('dev-1');

    const ok = await harness.manager.acquireAgentForTask('dev-1', 'task-reentry-block', 'fix');
    expect(ok).toBe(false);
  });
});

describe('AgentManager.resumeAgent binding cleanup & code redispatch failures', () => {
  async function seedFailedCodeRedispatch(): Promise<TaskState> {
    const t = await harness.seedTask({
      status: 'in_progress',
      phase: 'code',
      specReviewRound: 1,
      signalToken: 'code-redispatch-token',
    });
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'code-dispatch-failed',
    });
    await harness.acquireAgentLock('dev-1');
    return t;
  }

  it('cleans the exact baxian task branch when the release path runs', async () => {
    const t = await harness.seedTask({ status: 'cancelled' });
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
      workdir: '/tmp/repo',
    });
    await harness.acquireAgentLock('dev-1');
    const cleanupSpy = vi.spyOn(BranchManager.prototype, 'cleanupTaskBranch')
      .mockResolvedValue({ status: 'deleted' });

    const result = await harness.manager.resumeAgent('dev-1');

    expect(result).toEqual({ resumed: true, releasedBinding: true });
    expect(cleanupSpy).toHaveBeenCalledWith('/tmp/repo', expect.objectContaining({
      taskId: t.id,
      taskBranch: t.branch,
    }), expect.any(Function));
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
  });

  async function releaseWithCleanupSpy(seed: Partial<TaskState>) {
    const t = await harness.seedTask(seed);
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
      workdir: '/tmp/repo',
    });
    await harness.acquireAgentLock('dev-1');
    const cleanupSpy = vi.spyOn(BranchManager.prototype, 'cleanupTaskBranch')
      .mockResolvedValue({ status: 'deleted' });
    expect(await harness.manager.resumeAgent('dev-1')).toEqual({ resumed: true, releasedBinding: true });
    return cleanupSpy;
  }

  it('attaches a lazy platform merged-head resolver when releasing a merged task', async () => {
    const fetchSpy = vi.spyOn(harness.manager, 'platformFetchPrHeadSha').mockResolvedValue('b'.repeat(40));
    const cleanupSpy = await releaseWithCleanupSpy({
      status: 'merged', prNumber: 12, latestHeadSha: 'a'.repeat(40),
    });
    const identity = cleanupSpy.mock.calls[0]?.[1] as { resolveMergedHeadSha?: () => Promise<string> };
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(typeof identity.resolveMergedHeadSha).toBe('function');
    await expect(identity.resolveMergedHeadSha!()).resolves.toBe('b'.repeat(40));
    expect(fetchSpy).toHaveBeenCalledWith('task-1');
  });

  it('skips the platform credential resolver for a cancelled task', async () => {
    const fetchSpy = vi.spyOn(harness.manager, 'platformFetchPrHeadSha');
    const cleanupSpy = await releaseWithCleanupSpy({
      status: 'cancelled', prNumber: 12, latestHeadSha: 'a'.repeat(40),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    const identity = cleanupSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(identity.resolveMergedHeadSha).toBeUndefined();
  });

  it('passes no credential resolver for a merged task without a bound PR', async () => {
    const fetchSpy = vi.spyOn(harness.manager, 'platformFetchPrHeadSha');
    const cleanupSpy = await releaseWithCleanupSpy({ status: 'merged', latestHeadSha: 'a'.repeat(40) });
    expect(fetchSpy).not.toHaveBeenCalled();
    const identity = cleanupSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(identity.resolveMergedHeadSha).toBeUndefined();
  });

  it('persists the remote tip credential carried by a pending config cleanup', async () => {
    const t = await harness.seedTask({ status: 'cancelled' });
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
      workdir: '/tmp/repo',
    });
    await harness.acquireAgentLock('dev-1');
    vi.spyOn(BranchManager.prototype, 'cleanupTaskBranch').mockResolvedValue({
      status: 'pending', reason: 'branch config cleanup failed: lock', remoteTipSha: 'c'.repeat(40),
    });

    expect(await harness.manager.resumeAgent('dev-1')).toEqual({ resumed: true, releasedBinding: true });

    const after = await harness.taskStore.get(t.id);
    expect(after?.branchLocalCleaned?.remoteTipSha).toBe('c'.repeat(40));
    expect(after?.branchCleanupPending?.reason).toContain('config cleanup failed');
  });

  it('keeps the persisted cleanup credential when the post-cleanup park fails', async () => {
    const t = await harness.seedTask({ status: 'cancelled' });
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
      workdir: '/tmp/repo',
    });
    await harness.acquireAgentLock('dev-1');
    vi.spyOn(BranchManager.prototype, 'cleanupTaskBranch').mockResolvedValue({
      status: 'pending', reason: 'branch config cleanup failed: lock', remoteTipSha: 'c'.repeat(40),
    });
    vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockRejectedValue(new Error('ssh reset'));

    const result = await harness.manager.resumeAgent('dev-1');

    expect(result).toMatchObject({ resumed: false, releasedBinding: false });
    const after = await harness.taskStore.get(t.id);
    expect(after?.branchLocalCleaned?.remoteTipSha).toBe('c'.repeat(40));
    expect(after?.branchCleanupPending?.reason).toContain('checkout cleanup failed');
  });

  it('records the branchLocalCleaned credential when release deletes a pushed local branch', async () => {
    const t = await harness.seedTask({ status: 'cancelled' });
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
      workdir: '/tmp/repo',
    });
    await harness.acquireAgentLock('dev-1');
    vi.spyOn(BranchManager.prototype, 'cleanupTaskBranch')
      .mockResolvedValue({ status: 'deleted', remoteTipSha: 'a'.repeat(40) });

    const result = await harness.manager.resumeAgent('dev-1');

    expect(result).toEqual({ resumed: true, releasedBinding: true });
    expect((await harness.taskStore.get(t.id))?.branchLocalCleaned).toMatchObject({
      remoteTipSha: 'a'.repeat(40),
    });
  });

  it('keeps the binding and lock when fixed-Workdir branch cleanup fails', async () => {
    const t = await harness.seedTask({ status: 'cancelled' });
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
      workdir: '/tmp/repo',
    });
    await harness.acquireAgentLock('dev-1');
    vi.spyOn(BranchManager.prototype, 'cleanupTaskBranch').mockRejectedValue(new Error('cleanup blip'));

    const result = await harness.manager.resumeAgent('dev-1');

    expect(result).toMatchObject({
      resumed: false,
      releasedBinding: false,
      reason: expect.stringContaining('cleanup blip'),
    });
    expect(await harness.agentStore.get('dev-1')).toMatchObject({
      taskId: t.id,
      status: 'awaiting_human',
      awaitingPhase: 'branch-cleanup-pending',
      awaitingReason: expect.stringContaining('cleanup blip'),
    });
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });

  it.each(['checkout-preparation-failed', 'dirty-workdir'])(
    'resumes a QA held on %s + active review task by redispatching the review with pass fences',
    async (phase) => {
      const t = await seedReviewTask({ signalToken: 'pass-t1' });
      await harness.seedAgent({
        id: 'qa-1', taskId: t.id, paneId: '%1',
        status: 'awaiting_human', awaitingPhase: phase,
        awaitingReason: 'repl not ready', awaitingSince: NOW,
      });
      await harness.acquireAgentLock('qa-1', t.id);

      const result = await harness.manager.resumeAgent('qa-1');

      expect(result).toEqual({ resumed: true, releasedBinding: false });
      const after = (await harness.taskStore.get(t.id))!;
      // 不 bump:轮次原地不动,也没留下未计轮 intent
      expect(after.reviewRound).toBe(0);
      expect(after.reviewRoundPending).toBeUndefined();
      expect(after.signalToken).not.toBe('pass-t1');
      // 复评提示词落在 QA 的 pane 上,phase=review,带着这一轮的 pass/fail 围栏
      expect(harness.runner.pastedPrompts).toEqual([{ pane: '%1', body: expect.any(String) }]);
      const body = harness.runner.pastedPrompts[0]!.body;
      expect(body).toContain('phase: review');
      expect(body).toContain(after.passToken!);
      expect(body).toContain(after.failToken!);
      const qa = await harness.agentStore.get('qa-1');
      expect(qa?.taskId).toBe(t.id);
      expect(qa?.status).toBeUndefined();
      expect(qa?.awaitingPhase).toBeUndefined();
    },
  );

  it('Resume treats a later spec review round as recheck even when code reviewRound is zero', async () => {
    const t = await seedReviewTask({
      phase: 'spec',
      specReviewRound: 2,
      reviewRound: 0,
      signalToken: 'spec-pass-r2',
    });
    await harness.seedAgent({
      id: 'qa-1',
      taskId: t.id,
      paneId: '%1',
      status: 'awaiting_human',
      awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready',
      awaitingSince: NOW,
    });
    await harness.acquireAgentLock('qa-1', t.id);

    await harness.manager.resumeAgent('qa-1');

    // Resume 不指定 qaPhase,由轮次自行判定:spec 第 2 轮 → recheck
    expect(harness.runner.pastedPrompts).toEqual([{ pane: '%1', body: expect.stringContaining('phase: recheck') }]);
    expect((await harness.taskStore.get(t.id))?.specReviewRound).toBe(2);
  });

  it('Resume 首评 hold 携带持久化未计轮 intent：bumpRound=true + qaPhase=review', async () => {
    const t = await seedReviewTask({
      signalToken: 'pass-t2', reviewRound: 0, reviewRoundPending: true,
    });
    await harness.seedAgent({
      id: 'qa-1', taskId: t.id, paneId: '%1',
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW,
    });
    await harness.acquireAgentLock('qa-1', t.id);

    await harness.manager.resumeAgent('qa-1');

    // 未计轮 intent 在派成后落成第 1 轮,仍是 review 首评
    const after = (await harness.taskStore.get(t.id))!;
    expect(after.reviewRound).toBe(1);
    expect(after.reviewRoundPending).toBeUndefined();
    expect(harness.runner.pastedPrompts).toEqual([{ pane: '%1', body: expect.stringContaining('phase: review') }]);
  });

  it('releases the held QA binding instead of redispatching when the task has left review', async () => {
    const t = await harness.seedTask({ status: 'fixing', qaAgentId: 'qa-1', prNumber: 12, signalToken: 'pass-t1' });
    await harness.seedAgent({
      id: 'qa-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW,
    });
    await harness.acquireAgentLock('qa-1', t.id);

    const result = await harness.manager.resumeAgent('qa-1');

    expect(result).toEqual({ resumed: true, releasedBinding: true });
    await expectNoRedispatch(t.id);
    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.taskId).toBeUndefined();
    expect(qa?.status).toBeUndefined();
    expect(await harness.lockManager.isLocked('qa-1')).toBe(false);
  });

  it('aborts the QA resume when the hold generation changed after the pre-read', async () => {
    const t = await harness.seedTask({ status: 'review', qaAgentId: 'qa-1', prNumber: 12, signalToken: 'pass-t1' });
    await harness.seedAgent({
      id: 'qa-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown',
      awaitingReason: 'prompt may be running', awaitingSince: NOW, awaitingNonce: 'gen-b',
    });
    await harness.acquireAgentLock('qa-1', t.id);
    const real = await harness.agentStore.get('qa-1');
    vi.spyOn(harness.agentStore, 'get').mockResolvedValueOnce({
      ...real!,
      awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready',
      awaitingNonce: 'gen-a',
    });

    const result = await harness.manager.resumeAgent('qa-1');

    expect(result).toMatchObject({ resumed: false, releasedBinding: false });
    expect(result.reason).toBeTruthy();
    await expectNoRedispatch(t.id);
    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.status).toBe('awaiting_human');
    expect(qa?.awaitingPhase).toBe('dispatch-failed:ack_unknown');
    expect(qa?.awaitingNonce).toBe('gen-b');
  });

  it('does not re-hold the QA when the review round advanced during a failed redispatch', async () => {
    const t = await harness.seedTask({ status: 'review', qaAgentId: 'qa-1', prNumber: 12, signalToken: 'pass-t1' });
    await harness.seedAgent({
      id: 'qa-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW,
    });
    await harness.acquireAgentLock('qa-1', t.id);
    // E2: 派单途中「本轮 pass 被后继取代」是状态机内部的并发换代,runner 层造不出
    vi.spyOn(harness.manager, 'dispatchReviewToQa').mockImplementation(async () => {
      const fresh = await harness.taskStore.get(t.id);
      await harness.taskStore.set({
        ...fresh!,
        reviewRound: fresh!.reviewRound + 1,
        updatedAt: new Date().toISOString(),
      });
      throw new Error('pass superseded during dispatch');
    });

    const result = await harness.manager.resumeAgent('qa-1');

    expect(result).toMatchObject({ resumed: false, reason: expect.stringContaining('pass superseded') });
    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.status).toBeUndefined();
  });

  it('Resume 把缺失 phase/token 作为完整入口 pass，successor 换代后不补挂旧 hold', async () => {
    const t = await harness.seedTask({
      status: 'review', phase: undefined, qaAgentId: 'qa-1', prNumber: 12, signalToken: undefined,
    });
    await harness.seedAgent({
      id: 'qa-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW,
    });
    await harness.acquireAgentLock('qa-1', t.id);
    // E2: 同上——用例要在派单中途换掉 phase/token,只有从派单入口内部才能精确插进这个窗口
    const dispatchSpy = vi.spyOn(harness.manager, 'dispatchReviewToQa').mockImplementation(async (_taskId, opts = {}) => {
      expect(Object.hasOwn(opts, 'expectPhase')).toBe(true);
      expect(Object.hasOwn(opts, 'expectSignalToken')).toBe(true);
      expect(opts.expectPhase).toBeUndefined();
      expect(opts.expectSignalToken).toBeUndefined();
      const fresh = await harness.taskStore.get(t.id);
      await harness.taskStore.set({
        ...fresh!, phase: 'code', signalToken: 'successor-pass', updatedAt: new Date().toISOString(),
      });
      throw new Error('missing-value pass superseded');
    });

    const result = await harness.manager.resumeAgent('qa-1');

    expect(result).toMatchObject({ resumed: false, reason: expect.stringContaining('superseded') });
    expect(dispatchSpy).toHaveBeenCalledOnce();
    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.status).toBeUndefined();
    expect(qa?.awaitingPhase).toBeUndefined();
  });

  it('does not re-hold the QA when the task left review with an unchanged token during a failed redispatch', async () => {
    const t = await harness.seedTask({ status: 'review', qaAgentId: 'qa-1', prNumber: 12, signalToken: 'pass-t1' });
    await harness.seedAgent({
      id: 'qa-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW,
    });
    await harness.acquireAgentLock('qa-1', t.id);
    // E2: 派单途中任务离开 review 而 token 不变,是状态机内部的并发换代
    vi.spyOn(harness.manager, 'dispatchReviewToQa').mockImplementation(async () => {
      const fresh = await harness.taskStore.get(t.id);
      await harness.taskStore.set({ ...fresh!, status: 'approved', updatedAt: new Date().toISOString() });
      throw new Error('Task task-1 left review during dispatch');
    });

    const result = await harness.manager.resumeAgent('qa-1');

    expect(result).toMatchObject({ resumed: false });
    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.status).toBeUndefined();
    expect(qa?.awaitingPhase).toBeUndefined();
  });

  it('keeps a newer hold and the lock when the non-review release races a hold rewrite', async () => {
    const t = await harness.seedTask({ status: 'fixing', qaAgentId: 'qa-1', prNumber: 12, signalToken: 'pass-t1' });
    await harness.seedAgent({
      id: 'qa-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown',
      awaitingReason: 'prompt may be running', awaitingSince: NOW, awaitingNonce: 'gen-b',
    });
    await harness.acquireAgentLock('qa-1', t.id);
    const real = await harness.agentStore.get('qa-1');
    vi.spyOn(harness.agentStore, 'get').mockResolvedValueOnce({
      ...real!,
      awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready',
      awaitingNonce: 'gen-a',
    });

    const result = await harness.manager.resumeAgent('qa-1');

    expect(result).toMatchObject({ resumed: false, releasedBinding: false });
    await expectNoRedispatch(t.id);
    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.awaitingPhase).toBe('dispatch-failed:ack_unknown');
    expect(qa?.awaitingNonce).toBe('gen-b');
    expect(await harness.lockManager.isLocked('qa-1')).toBe(true);
  });

  it('restores the dispatch-failed:ack_unknown hold when the redispatch dies with an unknown ack', async () => {
    const t = await harness.seedTask({ status: 'review', qaAgentId: 'qa-1', prNumber: 12, signalToken: 'pass-t1' });
    await harness.seedAgent({
      id: 'qa-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW,
    });
    await harness.acquireAgentLock('qa-1', t.id);
    // E2: ack_unknown 要与「派单中途换 token」同时发生,runner 只能造出其中一个
    vi.spyOn(harness.manager, 'dispatchReviewToQa').mockImplementation(async () => {
      const fresh = await harness.taskStore.get(t.id);
      await harness.taskStore.set({ ...fresh!, signalToken: 'armed-token', updatedAt: new Date().toISOString() });
      throw new DispatchTerminalError('ack_unknown', 'runtime ack timeout (paneId=%1)');
    });

    const result = await harness.manager.resumeAgent('qa-1');

    expect(result).toMatchObject({ resumed: false });
    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.status).toBe('awaiting_human');
    expect(qa?.awaitingPhase).toBe('dispatch-failed:ack_unknown');
  });

  it('returns resumed:false and restores visibility when the recovery task read also fails', async () => {
    const t = await harness.seedTask({ status: 'review', qaAgentId: 'qa-1', prNumber: 12, signalToken: 'pass-t1' });
    await harness.seedAgent({
      id: 'qa-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW,
    });
    await harness.acquireAgentLock('qa-1', t.id);
    // E2: 「派单失败且随后的任务读也失败」是两级存储故障的叠加,不是 tmux 边界能造的
    vi.spyOn(harness.manager, 'dispatchReviewToQa').mockImplementation(async () => {
      vi.spyOn(harness.taskStore, 'get').mockRejectedValueOnce(new Error('task store read failed'));
      throw new Error('dispatch blew up');
    });

    const result = await harness.manager.resumeAgent('qa-1');

    expect(result).toMatchObject({
      resumed: false,
      reason: expect.stringContaining('dispatch blew up'),
    });
    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.status).toBe('awaiting_human');
    expect(qa?.awaitingReason).toContain('dispatch blew up');
  });

  it('does not re-hold a QA that was rebound by a concurrent redispatch', async () => {
    const t = await harness.seedTask({ status: 'review', qaAgentId: 'qa-1', prNumber: 12, signalToken: 'pass-t1' });
    await harness.seedAgent({
      id: 'qa-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW,
    });
    await harness.acquireAgentLock('qa-1', t.id);
    // E2: 派单途中 QA 被并发重派抢走锁,是状态机内部的锁换代
    vi.spyOn(harness.manager, 'dispatchReviewToQa').mockImplementation(async () => {
      const cur = await harness.agentStore.get('qa-1');
      await harness.lockManager.releaseIfOwner('qa-1', t.id, cur!.lockToken!);
      const successor = await harness.lockManager.acquire('qa-1', t.id);
      await harness.agentStore.set({ ...cur!, lockToken: successor!, updatedAt: new Date().toISOString() });
      throw new ApiError(409, `Manual review already in progress for task ${t.id}`);
    });

    const result = await harness.manager.resumeAgent('qa-1');

    expect(result).toMatchObject({ resumed: false });
    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.status).toBeUndefined();
    expect(qa?.awaitingPhase).toBeUndefined();
    expect(qa?.taskId).toBe(t.id);
  });

  it('restores the hold when a handled dispatch failure did not persist it', async () => {
    const t = await harness.seedTask({ status: 'review', qaAgentId: 'qa-1', prNumber: 12, signalToken: 'pass-t1' });
    await harness.seedAgent({
      id: 'qa-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW,
    });
    await harness.acquireAgentLock('qa-1', t.id);
    // E2: handled 的 EnsureSessionError(已自行收尾但没落下 hold)是状态机内部约定
    vi.spyOn(harness.manager, 'dispatchReviewToQa').mockRejectedValue(new EnsureSessionError(
      { createdSession: false, agentId: 'qa-1', handled: true },
      'checkout preparation failed for task task-1: repl not ready',
    ));

    const result = await harness.manager.resumeAgent('qa-1');

    expect(result).toMatchObject({ resumed: false });
    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.status).toBe('awaiting_human');
    expect(qa?.awaitingPhase).toBe('checkout-preparation-failed');
    expect(qa?.awaitingReason).toContain('repl not ready');
  });

  it('Resume git 路由把 onQaAcquired 转发到 lease 派发，并用 L2 恢复 handled hold', async () => {
    const headSha = 'a'.repeat(40);
    const t = await harness.seedTask({
      status: 'review', phase: 'code', qaAgentId: 'qa-1', prNumber: 12,
      deliveryConfirmation: { phase: 'code', source: 'signal', at: NOW },
      reviewRound: 1, signalToken: '111111111111', reviewHeadAnchorSha: headSha,
      passToken: '222222222222', failToken: '333333333333',
      reviewDispatch: {
        generation: '444444444444', phase: 'pending', qaPhase: 'recheck', signalToken: '111111111111',
        headSha, passToken: '222222222222', failToken: '333333333333',
        effectiveRound: 1, updatedAt: NOW,
      },
    });
    await harness.seedAgent({
      id: 'qa-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW,
    });
    const l1 = await harness.acquireAgentLock('qa-1', t.id);
    await harness.agentStore.update('qa-1', existing => ({ ...existing!, lockToken: l1!, updatedAt: NOW }));
    // E2: 同上,handled 语义由派单内部设置,runner 层的失败都会带上自己的收尾
    vi.spyOn(harness.manager, 'startSession').mockRejectedValue(new EnsureSessionError(
      { createdSession: false, agentId: 'qa-1', handled: true },
      'git checkout preparation failed after reacquire',
    ));

    const result = await harness.manager.resumeAgent('qa-1');

    expect(result).toMatchObject({ resumed: false });
    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.lockToken).toBeTruthy();
    expect(qa?.lockToken).not.toBe(l1);
    expect(qa?.status).toBe('awaiting_human');
    expect(qa?.awaitingPhase).toBe('checkout-preparation-failed');
  });

  it('surfaces the re-hold failure in the reason when restoring the hold also fails', async () => {
    const t = await harness.seedTask({ status: 'review', qaAgentId: 'qa-1', prNumber: 12, signalToken: 'pass-t1' });
    await harness.seedAgent({
      id: 'qa-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW,
    });
    await harness.acquireAgentLock('qa-1', t.id);
    // E2: 泛型派单失败 + 重新停驻本身也失败,属状态机内部错误叠加
    vi.spyOn(harness.manager, 'dispatchReviewToQa').mockRejectedValue(new Error('dispatch blew up'));
    vi.spyOn(harness.manager, 'markAwaitingHuman').mockRejectedValue(new Error('store down'));

    const result = await harness.manager.resumeAgent('qa-1');

    expect(result).toMatchObject({
      resumed: false,
      reason: expect.stringContaining('dispatch blew up'),
    });
    expect(result.reason).toContain('store down');
  });

  it('re-holds the QA with the dispatch failure when the Resume review redispatch throws before releasing', async () => {
    const t = await harness.seedTask({ status: 'review', qaAgentId: 'qa-1', prNumber: 12 });
    await harness.seedAgent({
      id: 'qa-1', taskId: t.id, paneId: '%1',
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW,
    });
    await harness.acquireAgentLock('qa-1', t.id);
    // E2: 「QA 忙/不可用」由派单入口的绑定闸门判定,不经过 tmux
    vi.spyOn(harness.manager, 'dispatchReviewToQa').mockRejectedValue(new Error('QA agent qa-1 is busy or unavailable'));

    const result = await harness.manager.resumeAgent('qa-1');

    expect(result).toMatchObject({
      resumed: false,
      releasedBinding: false,
      reason: expect.stringContaining('busy or unavailable'),
    });
    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.status).toBe('awaiting_human');
    expect(qa?.awaitingReason).toContain('busy or unavailable');
  });

  it('still refuses to resume a dev held on checkout-preparation-failed with an active task', async () => {
    const t = await harness.seedTask({ status: 'in_progress', qaAgentId: 'qa-1' });
    await harness.seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'workdir broken', awaitingSince: NOW,
    });
    await harness.acquireAgentLock('dev-1', t.id);

    const result = await harness.manager.resumeAgent('dev-1');

    expect(result).toMatchObject({ resumed: false, releasedBinding: false });
    expect(result.reason).toContain('cancel');
    await expectNoRedispatch(t.id);
    expect((await harness.agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });

  it('resumes a code redispatch without a server Spec handoff', async () => {
    const m = harness.createManager();
    const t = await harness.seedTask({
      status: 'in_progress',
      phase: 'code',
      specReviewRound: 2,
      signalToken: 'git-code-resume-token',
    });
    await harness.seedAgent({
      id: 'dev-1',
      taskId: t.id,
      paneId: '%0',
      status: 'awaiting_human',
      awaitingPhase: 'code-dispatch-failed',
    });
    await harness.acquireAgentLock('dev-1');

    const result = await m.resumeAgent('dev-1');

    expect(result).toMatchObject({ resumed: true, releasedBinding: false });
    // code 续派直接落到 Dev 的 pane 上,带着原有的 code 信号 token
    expect(harness.runner.pastedPrompts).toEqual([{ pane: '%0', body: expect.stringContaining('phase: code') }]);
    expect(harness.runner.pastedPrompts[0]!.body).toContain('token: git-code-resume-token');
    expect((await harness.agentStore.get('dev-1'))?.status).toBeUndefined();
    expect((await harness.taskStore.get(t.id))?.status).toBe('in_progress');
  });

  it('re-holds the agent when the code redispatch is not delivered', async () => {
    const t = await seedFailedCodeRedispatch();
    // 派单途中任务离开 in_progress:code 提示词的状态闸门关上,提示词不投递
    let flipped = false;
    const runner = useRunner({
      onExec: async command => {
        if (flipped || !command.includes('capture-pane')) return;
        flipped = true;
        const fresh = (await harness.taskStore.get(t.id))!;
        await harness.taskStore.set({ ...fresh, status: 'review', updatedAt: new Date().toISOString() });
      },
    });

    const result = await harness.manager.resumeAgent('dev-1');

    expect(flipped).toBe(true);
    expect(result).toMatchObject({
      resumed: false,
      releasedBinding: false,
      reason: expect.stringContaining('not delivered'),
    });
    expect(await harness.agentStore.get('dev-1')).toMatchObject({
      taskId: t.id,
      status: 'awaiting_human',
      awaitingPhase: 'code-dispatch-failed',
      awaitingReason: expect.stringContaining('not delivered'),
    });
    expect(runner.pastedPrompts).toEqual([]);
  });

  it('re-holds the agent when the code redispatch throws', async () => {
    const t = await seedFailedCodeRedispatch();
    useRunner({ rules: [{ match: 'capture-pane', reply: { stderr: 'redispatch boom', exitCode: 1 } }] });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await harness.manager.resumeAgent('dev-1');

    expect(result).toMatchObject({
      resumed: false,
      releasedBinding: false,
      reason: expect.stringContaining('redispatch boom'),
    });
    expect(await harness.agentStore.get('dev-1')).toMatchObject({
      taskId: t.id,
      status: 'awaiting_human',
      awaitingPhase: 'code-dispatch-failed',
      awaitingReason: expect.stringContaining('failed'),
    });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
