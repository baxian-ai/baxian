import { describe, it, expect, vi } from 'vitest';
import { EnsureSessionError } from '../../src/agent/manager.js';
import type { CommandRunner } from '../../src/agent/runner.js';
import { BranchManager } from '../../src/agent/branch.js';
import { useManagerSuiteHarness } from '../helpers/manager-harness.js';
import { fakeRunner } from '../helpers/fake-runner.js';

const NOW = '2026-05-14T05:00:00.000Z';

function recordingRunner(
  execs: string[],
  onExec?: (cmd: string) => void | Promise<void>,
): CommandRunner {
  return fakeRunner({
    defaultResult: {},
    onExec: async cmd => {
      execs.push(cmd);
      if (onExec) await onExec(cmd);
    },
  });
}

function idlePaneRunner(
  execs: string[],
  onExec?: (cmd: string) => void | Promise<void>,
): CommandRunner {
  return fakeRunner({
    agents: { 'dev-1': { paneId: '%5' } },
    onExec: async cmd => {
      execs.push(cmd);
      if (onExec) await onExec(cmd);
    },
    rules: [{
      match: 'capture-pane',
      reply: async cmd => {
        const header = cmd.includes('history_size') ? 'BX_PANE_OK|0' : 'BX_PANE_OK';
        return { stdout: `${header}\n⏵⏵ bypass permissions on /tmp/repo\n\n>` };
      },
    }],
  });
}

function captureInjection(into: string[]): (cmd: string) => void {
  return (cmd: string) => {
    const m = cmd.match(/printf '%s' '([^']+)'/);
    if (m && cmd.includes('load-buffer')) into.push(Buffer.from(m[1], 'base64').toString('utf8'));
  };
}

const harness = useManagerSuiteHarness();

describe('AgentManager post-merge release', () => {
  it('keeps the binding and lock when no runtime pane is available for safe release', async () => {
    const execs: string[] = [];
    harness.manager = harness.createManager({ runnerFactory: () => recordingRunner(execs) });
    await harness.seedTask({ id: 'task-x', agentId: 'dev-1', branch: 'bx/task-x', status: 'merged' });
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-x' });

    await harness.manager.cleanupAfterMerge('task-x');

    await vi.waitFor(async () => {
      expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBe('branch-cleanup-pending');
    });
    expect(await harness.agentStore.get('dev-1')).toMatchObject({
      taskId: 'task-x',
      status: 'awaiting_human',
      awaitingPhase: 'branch-cleanup-pending',
    });
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });

  it('releases the dev agent without any pane dialogue: no /clear, no prompt injection', async () => {
    const execs: string[] = [];
    const promptInjections: string[] = [];
    harness.manager = harness.createManager({ runnerFactory: () => idlePaneRunner(execs, captureInjection(promptInjections)) });
    harness.setCompactTiming(harness.manager);
    await harness.seedTask({ id: 'merged-task', agentId: 'dev-1', branch: 'bx/merged-task', status: 'merged' });
    await harness.seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', workdir: '/repo/main' });

    await harness.manager.cleanupAfterMerge('merged-task');

    await vi.waitFor(async () => {
      expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    });
    const joined = execs.join('\n');
    expect(promptInjections).toEqual([]);
    expect(joined).not.toMatch(/tmux (load|paste)-buffer/);
    expect(joined).not.toContain('/clear');
    expect(joined).not.toContain('/compact');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
  });

  it('treats a runtime that exited to a shell as absent: releases and drops the pane binding', async () => {
    const execs: string[] = [];
    harness.manager = harness.createManager({
      runnerFactory: () => fakeRunner({
        agents: { 'dev-1': { paneId: '%5', process: 'zsh' } },
        onExec: async cmd => { execs.push(cmd); },
      }),
    });
    await harness.seedTask({ id: 'merged-task', agentId: 'dev-1', branch: 'bx/merged-task', status: 'merged' });
    await harness.seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', workdir: '/repo/main' });

    await harness.manager.cleanupAfterMerge('merged-task');

    await vi.waitFor(async () => {
      expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    });
    const binding = await harness.agentStore.get('dev-1');
    expect(binding?.status).not.toBe('awaiting_human');
    expect(binding?.paneId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
    expect(execs.join('\n')).not.toContain('send-keys');
  });

  it('holds instead of releasing when a non-runtime, non-shell process owns the pane', async () => {
    const execs: string[] = [];
    harness.manager = harness.createManager({
      runnerFactory: () => fakeRunner({
        agents: { 'dev-1': { paneId: '%5', process: 'vim' } },
        onExec: async cmd => { execs.push(cmd); },
      }),
    });
    await harness.seedTask({ id: 'merged-task', agentId: 'dev-1', branch: 'bx/merged-task', status: 'merged' });
    await harness.seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', workdir: '/repo/main' });
    const cleanupSpy = vi.mocked(BranchManager.prototype.cleanupTaskBranch);
    const parkSpy = vi.mocked(BranchManager.prototype.parkOnDefaultDetached);

    await harness.manager.cleanupAfterMerge('merged-task');

    await vi.waitFor(async () => {
      expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBe('branch-cleanup-pending');
    });
    const binding = await harness.agentStore.get('dev-1');
    expect(binding).toMatchObject({
      taskId: 'merged-task',
      status: 'awaiting_human',
      awaitingPhase: 'branch-cleanup-pending',
    });
    expect(binding?.awaitingReason).toContain('non-runtime foreground process (vim)');
    expect(binding?.paneId).toBe('%5');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
    expect(cleanupSpy).not.toHaveBeenCalled();
    expect(parkSpy).not.toHaveBeenCalled();
    expect(execs.join('\n')).not.toContain('send-keys');
  });

  it('waits for the pane mutex before probing and releasing', async () => {
    const execs: string[] = [];
    harness.manager = harness.createManager({ runnerFactory: () => idlePaneRunner(execs) });
    harness.setCompactTiming(harness.manager);
    await harness.seedTask({ id: 'merged-task', agentId: 'dev-1', branch: 'bx/merged-task', status: 'merged' });
    await harness.seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', workdir: '/repo/main' });
    const guard = (harness.manager as unknown as { compactInFlight: Set<string> }).compactInFlight;
    guard.add('dev-1');

    await harness.manager.cleanupAfterMerge('merged-task');
    await new Promise(r => setTimeout(r, 50));
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBe('merged-task');

    guard.delete('dev-1');
    await vi.waitFor(async () => {
      expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    });
    expect(guard.has('dev-1')).toBe(false);
  });

  it('never force-deletes a local branch during post-merge release', async () => {
    const execs: string[] = [];
    harness.manager = harness.createManager({ runnerFactory: () => idlePaneRunner(execs) });
    harness.setCompactTiming(harness.manager);
    await harness.seedTask({ id: 'merged-task', agentId: 'dev-1', branch: 'bx/task-merge', status: 'merged' });
    await harness.seedAgent({ id: 'dev-1', paneId: '%5', workdir: '/repo/main-clone', taskId: 'merged-task' });

    await harness.manager.cleanupAfterMerge('merged-task');

    await vi.waitFor(async () => {
      expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    });
    expect(execs.join('\n')).not.toContain('git branch -D');
  });

  it('holds taskId on the binding during local branch cleanup and releases after', async () => {
    const execs: string[] = [];
    let taskIdDuringCheckoutCleanup: string | undefined;
    harness.manager = harness.createManager({ runnerFactory: () => idlePaneRunner(execs) });
    harness.setCompactTiming(harness.manager);
    await harness.seedTask({ id: 'merged-task', branch: 'bx/merged-task', status: 'merged', agentId: 'dev-1' });
    await harness.seedAgent({ id: 'dev-1', paneId: '%5', workdir: '/repo/main', taskId: 'merged-task' });
    vi.spyOn(BranchManager.prototype, 'cleanupTaskBranch').mockImplementation(async () => {
      taskIdDuringCheckoutCleanup = (await harness.agentStore.get('dev-1'))?.taskId;
      return { status: 'deleted' };
    });

    await harness.manager.cleanupAfterMerge('merged-task');

    await vi.waitFor(async () => {
      expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    });
    expect(taskIdDuringCheckoutCleanup).toBe('merged-task');
  });

  it('bails without touching the agent when its binding has moved to a different task', async () => {
    const execs: string[] = [];
    harness.manager = harness.createManager({ runnerFactory: () => recordingRunner(execs) });
    await harness.seedTask({ id: 'merged-task', agentId: 'dev-1', branch: 'bx/task-merge', status: 'merged' });
    await harness.seedAgent({ id: 'dev-1', paneId: '%5', workdir: '/repo/main', taskId: 'next-task' });

    await harness.manager.cleanupAfterMerge('merged-task');
    await new Promise(r => setTimeout(r, 50));

    const joined = execs.join('\n');
    expect(joined).not.toContain('git fetch --prune origin');
    expect(joined).not.toContain('send-keys');
    const binding = await harness.agentStore.get('dev-1');
    expect(binding?.taskId).toBe('next-task');
  });

  it('regreetHeldAgent aborts without injecting when a DELETE→recreate bumps the generation', async () => {
    const execs: string[] = [];
    harness.manager = harness.createManager({ runnerFactory: () => recordingRunner(execs) });
    await harness.seedAgent({ id: 'dev-1', paneId: '%0', status: 'awaiting_human', awaitingPhase: 'greeting_failed', awaitingSince: NOW });

    let bumped = false;
    const realGet = harness.agentStore.get.bind(harness.agentStore);
    vi.spyOn(harness.agentStore, 'get').mockImplementation(async (id: string) => {
      const s = await realGet(id);
      if (id === 'dev-1' && !bumped) { bumped = true; harness.manager.bumpDeletionGeneration('dev-1'); }
      return s;
    });

    expect(await harness.manager.regreetHeldAgent('dev-1')).toBe(false);
    expect(execs.join('\n')).not.toMatch(/paste-buffer|send-keys/);
  });

  it('attachImageToRunningAgent aborts when a DELETE→recreate bumps the generation mid-upload', async () => {
    const execs: string[] = [];
    harness.manager = harness.createManager({ runnerFactory: () => recordingRunner(execs) });
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });

    let bumped = false;
    const realGet = harness.agentStore.get.bind(harness.agentStore);
    vi.spyOn(harness.agentStore, 'get').mockImplementation(async (id: string) => {
      const s = await realGet(id);
      if (id === 'dev-1' && !bumped) { bumped = true; harness.manager.bumpDeletionGeneration('dev-1'); }
      return s;
    });

    await expect(harness.manager.attachImageToRunningAgent('dev-1', Buffer.from('x'), 'png'))
      .rejects.toThrow(/deleted or recreated/);
  });

  it('handleDialogPendingFromRuntime refuses when the caller generation no longer matches (DELETE→recreate)', async () => {
    await harness.seedAgent({ id: 'dev-1', paneId: '%0', taskId: 'task-x' });
    const gen = harness.manager.deletionGenerationOf('dev-1');
    harness.manager.bumpDeletionGeneration('dev-1');
    const err = new EnsureSessionError({ createdSession: false, agentId: 'dev-1', dialogPending: true }, 'dialog');

    const handled = await harness.manager.handleDialogPendingFromRuntime('dev-1', err, { expectedGeneration: gen });

    expect(handled).toBe(false);
    expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBeUndefined();
  });

  it('dispatchPendingTask refuses an agent still bound to a just-merged task (post-merge release in flight → Start disabled)', async () => {
    await harness.seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task' });
    await harness.seedTask({ id: 'next-task', status: 'pending', agentId: 'dev-1', preferredAgentId: 'dev-1' });

    const result = await harness.manager.dispatchPendingTask('next-task', 'dev-1');

    expect(result.errorCode).toBe(409);
    expect((await harness.taskStore.get('next-task'))?.status).toBe('pending');
  });

  it('dispatchPendingTask rejects the binding when a DELETE→recreate bumps the generation after entry', async () => {
    await harness.seedAgent({ id: 'dev-1' });
    await harness.seedTask({ id: 'pend-task', status: 'pending', agentId: 'dev-1', preferredAgentId: 'dev-1' });
    let bumped = false;
    const realGet = harness.agentStore.get.bind(harness.agentStore);
    vi.spyOn(harness.agentStore, 'get').mockImplementation(async (id: string) => {
      const state = await realGet(id);
      if (id === 'dev-1' && !bumped) {
        bumped = true;
        harness.manager.bumpDeletionGeneration('dev-1');
      }
      return state;
    });

    const result = await harness.manager.dispatchPendingTask('pend-task', 'dev-1');

    expect(result.errorCode).toBe(409);
    expect((await realGet('dev-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
    expect((await harness.taskStore.get('pend-task'))?.status).toBe('pending');
  });

  it('a pending task reference prevents deletion from tombstoning its participant', async () => {
    await harness.seedAgent({ id: 'dev-1' });
    await harness.seedTask({ id: 'pend-ser', status: 'pending', agentId: 'dev-1', preferredAgentId: 'dev-1' });

    const claim = await harness.manager.scanOpenThenClaimDeletion(['dev-1']);

    expect(claim).toEqual({ ok: false, code: 'referencing', taskId: 'pend-ser' });
    expect((await harness.taskStore.get('pend-ser'))?.status).toBe('pending');
    expect(harness.manager.isDeletionInFlight('dev-1')).toBe(false);
  });

  it('dispatchPendingTask rejects when a non-dispatched participant (QA) is deleted+recreated before the active write', async () => {
    await harness.seedAgent({ id: 'dev-1' });
    await harness.seedTask({ id: 'pend-qa', status: 'pending', preferredAgentId: '', agentId: '' });
    const realUpdate = harness.agentStore.update.bind(harness.agentStore);
    let bumped = false;
    vi.spyOn(harness.agentStore, 'update').mockImplementation(async (id: string, cb) => {
      const result = await realUpdate(id, cb);
      if (id === 'dev-1' && !bumped) { bumped = true; harness.manager.bumpDeletionGeneration('qa-1'); }
      return result;
    });

    const result = await harness.manager.dispatchPendingTask('pend-qa', 'dev-1');

    expect(result.errorCode).toBe(409);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
    expect((await harness.taskStore.get('pend-qa'))?.status).toBe('pending');
  });
});
