import { describe, it, expect, vi } from 'vitest';
import type { TaskState } from '../../src/shared/index.js';
import { DispatchTerminalError, EnsureSessionError, canDispatchWithBinding } from '../../src/agent/manager.js';
import { ApiError } from '../../src/errors.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';
import { BranchManager } from '../../src/agent/branch.js';
import { useManagerSuiteHarness } from '../helpers/manager-harness.js';
import { makeTask } from '../helpers/fixtures.js';

const NOW = '2026-05-14T05:00:00.000Z';

const harness = useManagerSuiteHarness();

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
    const probingRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('list-sessions')) {
          return { stdout: '4242|1700000000|$1|dev-1\n', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('list-panes')) {
          return { stdout: '%99 claude\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async () => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    (harness.manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => probingRunner;

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
    const failingProbeRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('list-panes')) {
          return { stdout: '', stderr: 'session not found', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async () => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    (harness.manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => failingProbeRunner;

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
    const probingRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('list-panes')) {
          return { stdout: '%old claude\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async () => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    (harness.manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => probingRunner;

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
      const t = await harness.seedTask({ status: 'review', qaAgentId: 'qa-1', prNumber: 12, signalToken: 'pass-t1' });
      await harness.seedAgent({
        id: 'qa-1', taskId: t.id, paneId: '%1',
        status: 'awaiting_human', awaitingPhase: phase,
        awaitingReason: 'repl not ready', awaitingSince: NOW,
      });
      await harness.acquireAgentLock('qa-1', t.id);
      const dispatchSpy = vi.spyOn(harness.manager, 'dispatchReviewToQa').mockResolvedValue({} as never);

      const result = await harness.manager.resumeAgent('qa-1');

      expect(result).toEqual({ resumed: true, releasedBinding: false });
      expect(dispatchSpy).toHaveBeenCalledWith(t.id, {
        bumpRound: false,
        fromStatus: ['review'],
        expectPhase: undefined,
        expectSignalToken: 'pass-t1',
        expectedTask: {
          status: t.status,
          phase: t.phase,
          signalToken: t.signalToken,
          agentId: t.agentId,
          reviewRound: t.reviewRound,
          specReviewRound: t.specReviewRound,
        },
        qaPhase: 'review',
        onQaAcquired: expect.any(Function),
      });
      const qa = await harness.agentStore.get('qa-1');
      expect(qa?.taskId).toBe(t.id);
      expect(qa?.status).toBeUndefined();
      expect(qa?.awaitingPhase).toBeUndefined();
    },
  );

  it('Resume treats a later spec review round as recheck even when code reviewRound is zero', async () => {
    const t = await harness.seedTask({
      status: 'review',
      phase: 'spec',
      specReviewRound: 2,
      reviewRound: 0,
      qaAgentId: 'qa-1',
      prNumber: 12,
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
    const dispatchSpy = vi.spyOn(harness.manager, 'dispatchReviewToQa').mockResolvedValue({} as never);

    await harness.manager.resumeAgent('qa-1');

    const options = dispatchSpy.mock.calls[0]?.[1];
    expect(options).not.toHaveProperty('qaPhase');
  });

  it('Resume 首评 hold 携带持久化未计轮 intent：bumpRound=true + qaPhase=review', async () => {
    const t = await harness.seedTask({
      status: 'review', qaAgentId: 'qa-1', prNumber: 12,
      signalToken: 'pass-t2', reviewRound: 0, reviewRoundPending: true,
    });
    await harness.seedAgent({
      id: 'qa-1', taskId: t.id, paneId: '%1',
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW,
    });
    await harness.acquireAgentLock('qa-1', t.id);
    const dispatchSpy = vi.spyOn(harness.manager, 'dispatchReviewToQa').mockResolvedValue({} as never);

    await harness.manager.resumeAgent('qa-1');

    expect(dispatchSpy).toHaveBeenCalledWith(t.id, expect.objectContaining({
      bumpRound: true,
      qaPhase: 'review',
      expectSignalToken: 'pass-t2',
    }));
  });

  it('releases the held QA binding instead of redispatching when the task has left review', async () => {
    const t = await harness.seedTask({ status: 'fixing', qaAgentId: 'qa-1', prNumber: 12, signalToken: 'pass-t1' });
    await harness.seedAgent({
      id: 'qa-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW,
    });
    await harness.acquireAgentLock('qa-1', t.id);
    const dispatchSpy = vi.spyOn(harness.manager, 'dispatchReviewToQa').mockResolvedValue({} as never);

    const result = await harness.manager.resumeAgent('qa-1');

    expect(result).toEqual({ resumed: true, releasedBinding: true });
    expect(dispatchSpy).not.toHaveBeenCalled();
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
    const dispatchSpy = vi.spyOn(harness.manager, 'dispatchReviewToQa').mockResolvedValue({} as never);

    const result = await harness.manager.resumeAgent('qa-1');

    expect(result).toMatchObject({ resumed: false, releasedBinding: false });
    expect(result.reason).toBeTruthy();
    expect(dispatchSpy).not.toHaveBeenCalled();
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
    const dispatchSpy = vi.spyOn(harness.manager, 'dispatchReviewToQa').mockImplementation(async (_taskId, opts) => {
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
    const dispatchSpy = vi.spyOn(harness.manager, 'dispatchReviewToQa').mockResolvedValue({} as never);

    const result = await harness.manager.resumeAgent('qa-1');

    expect(result).toMatchObject({ resumed: false, releasedBinding: false });
    expect(dispatchSpy).not.toHaveBeenCalled();
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
    const dispatchSpy = vi.spyOn(harness.manager, 'dispatchReviewToQa').mockResolvedValue({} as never);

    const result = await harness.manager.resumeAgent('dev-1');

    expect(result).toMatchObject({ resumed: false, releasedBinding: false });
    expect(result.reason).toContain('cancel');
    expect(dispatchSpy).not.toHaveBeenCalled();
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
    const continueSpy = vi.spyOn(m, 'continueSession').mockResolvedValue(true);

    const result = await m.resumeAgent('dev-1');

    expect(result).toMatchObject({ resumed: true, releasedBinding: false });
    expect(continueSpy).toHaveBeenCalledWith(
      t.id,
      'dev-1',
      'code',
      expect.objectContaining({ signalToken: 'git-code-resume-token' }),
    );
    expect(continueSpy.mock.calls[0]?.[3]).not.toHaveProperty('specDocuments');
  });

  it('re-holds the agent when the code redispatch is not delivered', async () => {
    const m = harness.createManager();
    const t = await seedFailedCodeRedispatch();
    vi.spyOn(m, 'continueSession').mockResolvedValue(false);
    const holdSpy = vi.spyOn(m, 'markAwaitingHuman').mockResolvedValue(true);

    const result = await m.resumeAgent('dev-1');

    expect(result).toMatchObject({
      resumed: false,
      releasedBinding: false,
      reason: expect.stringContaining('not delivered'),
    });
    expect(holdSpy).toHaveBeenCalledWith(
      'dev-1', 'code-dispatch-failed', expect.stringContaining('not delivered'), { expectedTaskId: t.id },
    );
  });

  it('re-holds the agent when the code redispatch throws', async () => {
    const m = harness.createManager();
    const t = await seedFailedCodeRedispatch();
    vi.spyOn(m, 'continueSession').mockRejectedValue(new Error('redispatch boom'));
    const holdSpy = vi.spyOn(m, 'markAwaitingHuman').mockResolvedValue(true);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await m.resumeAgent('dev-1');

    expect(result).toMatchObject({
      resumed: false,
      releasedBinding: false,
      reason: expect.stringContaining('redispatch boom'),
    });
    expect(holdSpy).toHaveBeenCalledWith(
      'dev-1', 'code-dispatch-failed', expect.stringContaining('failed'), { expectedTaskId: t.id },
    );
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
