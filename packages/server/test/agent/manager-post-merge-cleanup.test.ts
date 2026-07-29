import { describe, it, expect, vi } from 'vitest';
import { EnsureSessionError } from '../../src/agent/manager.js';
import type { CommandRunner } from '../../src/agent/runner.js';
import { BranchManager } from '../../src/agent/branch.js';
import { useManagerSuiteHarness } from '../helpers/manager-harness.js';
import { fakeRunner } from '../helpers/fake-runner.js';

const NOW = '2026-05-14T05:00:00.000Z';

function compactRunner(
  execs: string[],
  onExec?: (cmd: string) => void | Promise<void>,
  busyCaptures = 3,
  frames = {
    busy: '⏵⏵ bypass permissions on /tmp/repo\n\n· Compacting… (3s)\n  esc to interrupt\n',
    idle: '⏵⏵ bypass permissions on /tmp/repo\n\n>',
  },
): CommandRunner {
  let busyLeft = 0;
  return paneRunner(execs, () => {
    if (busyLeft > 0) {
      busyLeft--;
      return frames.busy;
    }
    return frames.idle;
  }, async cmd => {
    if (cmd.includes('send-keys') && cmd.includes("'Enter'")) busyLeft = busyCaptures;
    if (onExec) await onExec(cmd);
  });
}

function smallPaneClaudeCompactRunner(execs: string[]): CommandRunner {
  return compactRunner(execs, undefined, 2, {
    busy: '✽ Grooving… (5m 21s · thinking)\n',
    idle: '✻ Worked for 31s\n\n❯ \n',
  });
}

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

function paneRunner(
  execs: string[],
  capture: () => string | Promise<string>,
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
        return { stdout: `${header}\n${await capture()}` };
      },
    }],
  });
}

const capturePaneRunner = paneRunner;

function captureInjection(into: string[]): (cmd: string) => void {
  return (cmd: string) => {
    const m = cmd.match(/printf '%s' '([^']+)'/);
    if (m && cmd.includes('load-buffer')) into.push(Buffer.from(m[1], 'base64').toString('utf8'));
  };
}

async function waitUntilAsync(predicate: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('waitUntilAsync: predicate never became true');
}
const harness = useManagerSuiteHarness();

describe('AgentManager dispatchPostMergeCleanup', () => {
  it('keeps the binding and lock when no runtime pane is available for safe release', async () => {
    const execs: string[] = [];
    harness.manager = harness.createManager({ runnerFactory: () => recordingRunner(execs) });
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-x' });

    await harness.manager.dispatchPostMergeCleanup('dev-1', { taskId: 'task-x', branch: 'bx/task-x' });

    expect(await harness.agentStore.get('dev-1')).toMatchObject({
      taskId: 'task-x',
      status: 'awaiting_human',
      awaitingPhase: 'branch-cleanup-pending',
    });
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });

  it('runs the full cycle: idle → /clear → release, with NO agent dialogue', async () => {
    const execs: string[] = [];
    const promptInjections: string[] = [];
    harness.manager = harness.createManager({ runnerFactory: () => compactRunner(execs, captureInjection(promptInjections)) });
    harness.setCompactTiming(harness.manager);
    await harness.seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', workdir: '/repo/main' });

    await harness.manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => !(await harness.agentStore.get('dev-1'))?.taskId);

    const joined = execs.join('\n');
    expect(promptInjections).toEqual([]);
    expect(joined).not.toMatch(/tmux (load|paste)-buffer/);
    expect(joined).toMatch(/send-keys -l -t %5 '\\''\/clear'\\''/);
    expect(joined).not.toMatch(/\/compact/);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('skips the pane /clear when a DELETE→recreate bumps the generation mid-flight (ABA: reused pane id)', async () => {
    const execs: string[] = [];
    harness.manager = harness.createManager({ runnerFactory: () => compactRunner(execs) });
    harness.setCompactTiming(harness.manager);
    await harness.seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', workdir: '/repo/main' });

    let bumped = false;
    const realGet = harness.agentStore.get.bind(harness.agentStore);
    vi.spyOn(harness.agentStore, 'get').mockImplementation(async (id: string) => {
      const s = await realGet(id);
      if (id === 'dev-1' && !bumped) { bumped = true; harness.manager.bumpDeletionGeneration('dev-1'); }
      return s;
    });

    await harness.manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await new Promise(r => setTimeout(r, 50));

    expect(execs.join('\n')).not.toMatch(/send-keys.*\/clear/);
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

  it('temporarily claims an exact lock before cleaning an unbound idle agent', async () => {
    const execs: string[] = [];
    harness.manager = harness.createManager({ runnerFactory: () => compactRunner(execs) });
    harness.setCompactTiming(harness.manager);
    await harness.seedAgent({ id: 'dev-1', paneId: '%5', workdir: '/repo/main' });

    await harness.manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () =>
      !(await harness.agentStore.get('dev-1'))?.taskId && !(await harness.lockManager.isLocked('dev-1')),
    );

    expect(execs.join('\n')).toMatch(/send-keys -l -t %5 '\\''\/clear'\\''/);
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
  });

  it('releases after post-merge clear when a small claude pane hides the footer ready anchor', async () => {
    const execs: string[] = [];
    harness.manager = harness.createManager({ runnerFactory: () => smallPaneClaudeCompactRunner(execs) });
    harness.setCompactTiming(harness.manager);
    await harness.seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', workdir: '/repo/main' });

    await harness.manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => !(await harness.agentStore.get('dev-1'))?.taskId);

    expect(execs.join('\n')).toMatch(/send-keys -l -t %5 '\\''\/clear'\\''/);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('never force-deletes a local branch during post-merge cleanup', async () => {
    const execs: string[] = [];
    harness.manager = harness.createManager({ runnerFactory: () => compactRunner(execs) });
    harness.setCompactTiming(harness.manager);
    await harness.seedAgent({ id: 'dev-1', paneId: '%5', workdir: '/repo/main-clone', taskId: 'merged-task' });

    await harness.manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/task-merge' });
    await waitUntilAsync(async () => !(await harness.agentStore.get('dev-1'))?.taskId);

    expect(execs.join('\n')).not.toContain('git branch -D');
    expect(execs.join('\n')).toMatch(/send-keys -l -t %5 '\\''\/clear'\\''/);
  });

  it('holds taskId on the binding during local branch cleanup and releases after', async () => {
    const execs: string[] = [];
    let taskIdDuringCheckoutCleanup: string | undefined;
    harness.manager = harness.createManager({ runnerFactory: () => compactRunner(execs) });
    harness.setCompactTiming(harness.manager);
    await harness.seedTask({ id: 'merged-task', branch: 'bx/merged-task', status: 'merged' });
    await harness.seedAgent({ id: 'dev-1', paneId: '%5', workdir: '/repo/main', taskId: 'merged-task' });
    vi.spyOn(BranchManager.prototype, 'cleanupTaskBranch').mockImplementation(async () => {
      taskIdDuringCheckoutCleanup = (await harness.agentStore.get('dev-1'))?.taskId;
      return { status: 'deleted' };
    });

    await harness.manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => !(await harness.agentStore.get('dev-1'))?.taskId);

    expect(taskIdDuringCheckoutCleanup).toBe('merged-task');
    expect(execs.join('\n')).toMatch(/send-keys -l -t %5 '\\''\/clear'\\''/);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('post-merge wrap-up never invokes the retired force-delete path', async () => {
    const execs: string[] = [];
    harness.manager = harness.createManager({ runnerFactory: () => compactRunner(execs) });
    harness.setCompactTiming(harness.manager);
    await harness.seedAgent({ id: 'dev-1', paneId: '%5', workdir: '/repo/main', taskId: 'merged-task' });

    await harness.manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => !(await harness.agentStore.get('dev-1'))?.taskId);

    const joined = execs.join('\n');
    expect(joined).not.toContain('git branch -D');
    expect(joined).toMatch(/send-keys -l -t %5 '\\''\/clear'\\''/);
    expect(joined).not.toMatch(/\/compact/);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('releases a binding without workdir because branch deletion is centralized elsewhere', async () => {
    const execs: string[] = [];
    harness.manager = harness.createManager({ runnerFactory: () => compactRunner(execs) });
    harness.setCompactTiming(harness.manager);
    await harness.seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task' });

    await harness.manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => !(await harness.agentStore.get('dev-1'))?.taskId);

    const joined = execs.join('\n');
    expect(joined).not.toContain('git branch -D');
    expect(joined).toMatch(/send-keys -l -t %5 '\\''\/clear'\\''/);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('treats a fast /clear (busy seen only briefly) as success, not a failed start', async () => {
    const execs: string[] = [];
    harness.manager = harness.createManager({ runnerFactory: () => compactRunner(execs, undefined, 1) });
    harness.setCompactTiming(harness.manager);
    await harness.seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', workdir: '/repo/main' });

    await harness.manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => !(await harness.agentStore.get('dev-1'))?.taskId);

    const binding = await harness.agentStore.get('dev-1');
    expect(execs.join('\n')).toMatch(/send-keys -l -t %5 '\\''\/clear'\\''/);
    expect(binding?.taskId).toBeUndefined();
    expect(binding?.status).not.toBe('awaiting_human');
  });

  it('bails without touching the agent when its binding has moved to a different task', async () => {
    const execs: string[] = [];
    harness.manager = harness.createManager({ runnerFactory: () => compactRunner(execs) });
    harness.setCompactTiming(harness.manager, 50, 5);
    await harness.seedAgent({ id: 'dev-1', paneId: '%5', workdir: '/repo/main', taskId: 'next-task' });

    await harness.manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/task-merge' });
    await new Promise(r => setTimeout(r, 60));

    const joined = execs.join('\n');
    expect(joined).not.toContain('git fetch --prune origin');
    expect(joined).not.toContain("send-keys -l -t %5 '\\''/clear'\\''");
    const binding = await harness.agentStore.get('dev-1');
    expect(binding?.taskId).toBe('next-task');
  });

  it('dispatchPendingTask refuses an agent still bound to a just-merged task (post-merge cleanup in flight → Start disabled)', async () => {
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

  it('keeps the binding and exact lock when runtime idleness cannot be proven', async () => {
    const execs: string[] = [];
    const alwaysBusy = '⏵⏵ bypass permissions on /tmp/repo\n\n· Compacting… (3s)\n  esc to interrupt\n';
    harness.manager = harness.createManager({ runnerFactory: () => capturePaneRunner(execs, () => alwaysBusy) });
    harness.setCompactTiming(harness.manager, 50, 5);
    await harness.seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', workdir: '/repo/main' });

    await harness.manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => (await harness.agentStore.get('dev-1'))?.awaitingPhase === 'post-merge-cleanup-not-idle', 5000);

    const binding = await harness.agentStore.get('dev-1');
    expect(binding).toMatchObject({
      taskId: 'merged-task',
      status: 'awaiting_human',
      awaitingPhase: 'post-merge-cleanup-not-idle',
    });
    expect(await harness.lockManager.isOwner('dev-1', 'merged-task', binding!.lockToken!)).toBe(true);
  });

  it('does not write taskId when paneId changes between initial read and update (race with retry/restart)', async () => {
    const execs: string[] = [];
    harness.manager = harness.createManager({ runnerFactory: () => compactRunner(execs) });
    harness.setCompactTiming(harness.manager);
    await harness.seedAgent({ id: 'dev-1', paneId: '%5' });

    const origUpdate = harness.agentStore.update.bind(harness.agentStore);
    vi.spyOn(harness.agentStore, 'update').mockImplementationOnce(async (id, cb) => {
      const cur = await harness.agentStore.get(id);
      if (cur) await harness.agentStore.set({ ...cur, paneId: '%99' });
      return origUpdate(id, cb);
    });

    await harness.manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await new Promise(r => setTimeout(r, 60));

    const binding = await harness.agentStore.get('dev-1');
    expect(binding?.taskId).toBeUndefined();
    expect(binding?.paneId).toBe('%99');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
    expect(execs.join('\n')).not.toContain('git fetch');
    expect(execs.join('\n')).not.toContain('/clear');
  });

  it('stops touching the pane on retry when binding is released/rebound between attempts', async () => {
    const execs: string[] = [];
    const BUSY = '⏵⏵ bypass permissions on /tmp/repo\n\n· Compacting… (3s)\n  esc to interrupt\n';
    let captureCount = 0;
    let rebindExecIdx = -1;
    harness.manager = harness.createManager({
      runnerFactory: () => capturePaneRunner(execs, async () => {
        captureCount++;
        if (captureCount === 3) {
          const cur = await harness.agentStore.get('dev-1');
          if (cur) await harness.agentStore.set({ ...cur, taskId: 'new-review-task', updatedAt: new Date().toISOString() });
          rebindExecIdx = execs.length;
        }
        return BUSY;
      }),
    });
    harness.setCompactTiming(harness.manager, 50, 5);
    await harness.seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', workdir: '/repo/main' });

    await harness.manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await new Promise(r => setTimeout(r, 500));

    expect(execs.filter(c => c.includes('send-keys') && c.includes('C-c'))).toHaveLength(1);
    expect(rebindExecIdx).toBeGreaterThanOrEqual(0);
    expect(execs.slice(rebindExecIdx).filter(c => c.includes('send-keys'))).toHaveLength(0);
    const binding = await harness.agentStore.get('dev-1');
    expect(binding?.taskId).toBe('new-review-task');
  });

  it('stops touching the pane when the same task acquires a newer lock generation', async () => {
    const execs: string[] = [];
    const busy = '⏵⏵ bypass permissions on /tmp/repo\n\n· Compacting… (3s)\n  esc to interrupt\n';
    let captureCount = 0;
    let generationChangedAt = -1;
    harness.manager = harness.createManager({
      runnerFactory: () => capturePaneRunner(execs, async () => {
        captureCount++;
        if (captureCount === 3) {
          const current = (await harness.agentStore.get('dev-1'))!;
          await harness.lockManager.releaseIfOwner('dev-1', 'merged-task', current.lockToken!);
          const newToken = await harness.lockManager.acquire('dev-1', 'merged-task');
          expect(newToken).toBeTruthy();
          await harness.agentStore.update('dev-1', state => ({
            ...state!,
            lockToken: newToken!,
            updatedAt: new Date().toISOString(),
          }));
          generationChangedAt = execs.length;
        }
        return busy;
      }),
    });
    harness.setCompactTiming(harness.manager, 50, 5);
    await harness.seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', workdir: '/repo/main' });

    await harness.manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await new Promise(r => setTimeout(r, 500));

    expect(generationChangedAt).toBeGreaterThanOrEqual(0);
    expect(execs.slice(generationChangedAt).filter(c => c.includes('send-keys'))).toHaveLength(0);
    const binding = await harness.agentStore.get('dev-1');
    expect(binding?.taskId).toBe('merged-task');
    expect(await harness.lockManager.isOwner('dev-1', 'merged-task', binding!.lockToken!)).toBe(true);
  });
});
