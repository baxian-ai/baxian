import { describe, it, expect, vi } from 'vitest';
import { AgentManager } from '../../src/agent/manager.js';
import { useManagerSuiteHarness } from '../helpers/manager-harness.js';

const NOW = '2026-05-14T05:00:00.000Z';
const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

const harness = useManagerSuiteHarness();

describe('AgentManager.redispatchTaskPromptAfterReplRestart', () => {
  function restartManager(): AgentManager {
    return harness.createManager({ config: harness.config });
  }

  function spyDispatch(m: AgentManager): {
    clearSpy: ReturnType<typeof vi.spyOn>;
    continueSpy: ReturnType<typeof vi.spyOn>;
    holdSpy: ReturnType<typeof vi.spyOn>;
    armedWith: () => Promise<unknown[][]>;
  } {
    const clearSpy = vi.spyOn(m, 'clearAwaitingHuman').mockResolvedValue(true);
    const continueSpy = vi.spyOn(m, 'continueSession').mockImplementation(async (...args) => {
      const opts = args[3] as { armBeforeInject?: (ctx: object) => Promise<boolean> };
      return opts.armBeforeInject ? opts.armBeforeInject({}) : true;
    });
    const holdSpy = vi.spyOn(m, 'markAwaitingHuman').mockResolvedValue(true);
    const watcherSpy = vi.spyOn(
      m as unknown as { setupPhaseSignalWatcher: (...args: unknown[]) => Promise<boolean> },
      'setupPhaseSignalWatcher',
    ).mockResolvedValue(true);
    const armedWith = async (): Promise<unknown[][]> => watcherSpy.mock.calls;
    return { clearSpy, continueSpy, holdSpy, armedWith };
  }

  async function rotatedTaskToken(taskId: string, oldToken: string): Promise<string> {
    const token = (await harness.taskStore.get(taskId))?.signalToken;
    expect(token).toEqual(expect.any(String));
    expect(token).not.toBe(oldToken);
    return token!;
  }

  function expectReplayArm(
    calls: unknown[][],
    taskId: string,
    agentId: string,
    expectedKinds: readonly string[],
    oldToken: string,
    newToken: string,
  ): void {
    expect(calls).toEqual([[
      taskId,
      agentId,
      expectedKinds,
      newToken,
      expect.objectContaining({
        skipSnapshot: true,
        onlyReplaceOwnToken: true,
        replaceFromToken: oldToken,
        replaceScope: 'agent',
        preparedReplay: expect.any(Object),
      }),
    ]]);
  }

  it('replays the initial develop prompt for a dev holder with in-flight-safe options', async () => {
    const m = restartManager();
    await harness.seedTask({
      id: 'task-dev-restart',
      status: 'in_progress',
      signalToken: 'dev-token-1',
    });
    const { continueSpy, armedWith } = spyDispatch(m);

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-dev-restart')).toBe(true);
    const newToken = await rotatedTaskToken('task-dev-restart', 'dev-token-1');
    expect(continueSpy).toHaveBeenCalledWith(
      'task-dev-restart',
      'dev-1',
      'develop',
      expect.objectContaining({
        signalToken: newToken,
        allowDirtyWorkdir: true,
        armBeforeInject: expect.any(Function),
      }),
    );
    expect((continueSpy.mock.calls[0]![3] as { bypassTaskStatusGate?: boolean }).bypassTaskStatusGate)
      .toBeUndefined();
    expectReplayArm(await armedWith(), 'task-dev-restart', 'dev-1', ['spec-done', 'pr-created'], 'dev-token-1', newToken);
  });

  it('replays a git code phase without server Spec documents', async () => {
    const m = restartManager();
    await harness.seedTask({
      id: 'task-git-code-restart',
      status: 'in_progress',
      phase: 'code',
      specReviewRound: 2,
      signalToken: 'git-code-token',
    });
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-git-code-restart' });
    const { continueSpy, holdSpy, armedWith } = spyDispatch(m);

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-git-code-restart')).toBe(true);
    const newToken = await rotatedTaskToken('task-git-code-restart', 'git-code-token');
    expect(holdSpy).not.toHaveBeenCalled();
    expect(continueSpy).toHaveBeenCalledWith(
      'task-git-code-restart',
      'dev-1',
      'code',
      expect.objectContaining({
        signalToken: newToken,
        allowDirtyWorkdir: true,
      }),
    );
    expect(continueSpy.mock.calls[0]?.[3]).not.toHaveProperty('specDocuments');
    expectReplayArm(
      await armedWith(),
      'task-git-code-restart',
      'dev-1',
      ['pr-created'],
      'git-code-token',
      newToken,
    );
  });

  it('finalizes an interrupted git code bootstrap after replay', async () => {
    const m = restartManager();
    await harness.seedTask({
      id: 'task-git-code-boot-restart',
      status: 'in_progress',
      phase: 'code',
      specReviewRound: 1,
      signalToken: 'git-code-boot-token',
    });
    await harness.seedAgent({
      id: 'dev-1',
      taskId: 'task-git-code-boot-restart',
      bootstrappingTaskId: 'task-git-code-boot-restart',
    });
    const { continueSpy, holdSpy } = spyDispatch(m);

    expect(await m.redispatchTaskPromptAfterReplRestart(
      'dev-1',
      'task-git-code-boot-restart',
    )).toBe(true);
    expect(continueSpy).toHaveBeenCalledOnce();
    expect(holdSpy).not.toHaveBeenCalled();
    expect((await harness.agentStore.get('dev-1'))?.bootstrappingTaskId).toBeUndefined();
  });

  it('replays spec fixing from PR feedback', async () => {
    const m = restartManager();
    await harness.seedTask({
      id: 'task-git-spec-fix-restart',
      status: 'fixing',
      phase: 'spec',
      specReviewRound: 2,
      signalToken: 'git-spec-fix-token',
    });
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-git-spec-fix-restart' });
    const { continueSpy, holdSpy } = spyDispatch(m);

    expect(await m.redispatchTaskPromptAfterReplRestart(
      'dev-1',
      'task-git-spec-fix-restart',
    )).toBe(true);
    expect(holdSpy).not.toHaveBeenCalled();
    expect(continueSpy).toHaveBeenCalledWith(
      'task-git-spec-fix-restart',
      'dev-1',
      'fix',
      expect.objectContaining({
        allowDirtyWorkdir: true,
      }),
    );
    expect(continueSpy.mock.calls[0]?.[3]).not.toHaveProperty('serverPriorFindings');
  });

  it('replays the PR-feedback fix prompt for a github fixing pass', async () => {
    const m = restartManager();
    await harness.seedTask({
      id: 'task-dev-fix-restart',
      status: 'fixing',
      phase: 'code',
      reviewRound: 1,
      signalToken: 'dev-fix-token',
    });
    const { continueSpy, armedWith } = spyDispatch(m);

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-dev-fix-restart')).toBe(true);
    const newToken = await rotatedTaskToken('task-dev-fix-restart', 'dev-fix-token');
    expect(continueSpy).toHaveBeenCalledWith(
      'task-dev-fix-restart',
      'dev-1',
      'fix',
      expect.objectContaining({
        signalToken: newToken,
        allowDirtyWorkdir: true,
      }),
    );
    expect((continueSpy.mock.calls[0]![3] as { serverPriorFindings?: string }).serverPriorFindings)
      .toBeUndefined();
    expectReplayArm(await armedWith(), 'task-dev-fix-restart', 'dev-1', ['pr-fixed'], 'dev-fix-token', newToken);
  });

  it('replays the PR-feedback fix prompt when the fixing pass never persisted a phase', async () => {
    const m = restartManager();
    await harness.seedTask({
      id: 'task-dev-fix-nophase-restart',
      status: 'fixing',
      reviewRound: 1,
      signalToken: 'dev-fix-nophase-token',
    });
    const { continueSpy, armedWith } = spyDispatch(m);

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-dev-fix-nophase-restart')).toBe(true);
    const newToken = await rotatedTaskToken('task-dev-fix-nophase-restart', 'dev-fix-nophase-token');
    expect(continueSpy).toHaveBeenCalledWith(
      'task-dev-fix-nophase-restart',
      'dev-1',
      'fix',
      expect.objectContaining({
        signalToken: newToken,
        allowDirtyWorkdir: true,
      }),
    );
    expectReplayArm(await armedWith(), 'task-dev-fix-nophase-restart', 'dev-1', ['pr-fixed'], 'dev-fix-nophase-token', newToken);
  });

  it('arms replay watchers without consuming the stale pane snapshot', async () => {
    const m = restartManager();
    await harness.seedTask({
      id: 'task-snap-restart',
      status: 'in_progress',
      signalToken: 'snap-token-1',
    });
    const { armedWith } = spyDispatch(m);

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-snap-restart')).toBe(true);
    const newToken = await rotatedTaskToken('task-snap-restart', 'snap-token-1');
    expectReplayArm(await armedWith(), 'task-snap-restart', 'dev-1', ['spec-done', 'pr-created'], 'snap-token-1', newToken);
  });

  it('persists the same rotated token that is rendered into the replay prompt', async () => {
    const m = harness.manager;
    const oldToken = 'prompt-old-token';
    await harness.seedTask({ id: 'task-prompt-token', status: 'in_progress', signalToken: oldToken });
    await harness.seedAgent({
      id: 'dev-1', taskId: 'task-prompt-token', paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    harness.stubEnsureSession(m);
    const injected: string[] = [];
    harness.stubInject(m, async (_tmux, _paneId, prompt) => {
      injected.push(prompt);
      return { acked: true, composerDelivered: true };
    });

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-prompt-token')).toBe(true);

    const newToken = await rotatedTaskToken('task-prompt-token', oldToken);
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain(`token: ${newToken}`);
    expect(injected[0]).not.toContain(`token: ${oldToken}`);
  });

  it('tears down the replay arm and aborts the paste when the pass advances during arming', async () => {
    const m = harness.manager;
    await harness.seedTask({
      id: 'task-arm-drift',
      status: 'in_progress',
      signalToken: 'arm-stale-1',
    });
    await harness.seedAgent({
      id: 'dev-1', taskId: 'task-arm-drift', paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    harness.stubEnsureSession(m);
    const watcherSpy = vi.spyOn(
      m as unknown as { setupPhaseSignalWatcher: (...args: unknown[]) => Promise<boolean> },
      'setupPhaseSignalWatcher',
    ).mockImplementation(async () => {
      const fresh = await harness.taskStore.get('task-arm-drift');
      await harness.taskStore.set({ ...fresh!, phase: 'code', signalToken: 'arm-rotated-2' });
      return true;
    });
    const injected: string[] = [];
    harness.stubInject(m, async (_tmux, _paneId, prompt) => {
      injected.push(prompt);
      return { acked: true, composerDelivered: true };
    });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-arm-drift'))
      .resolves.toBe(false);
    expect(watcherSpy).toHaveBeenCalledTimes(1);
    expect(injected).toEqual([]);
  });

  it('aborts the paste when the pass rotates after arming but before inject', async () => {
    const m = harness.manager;
    await harness.seedTask({
      id: 'task-paste-drift',
      status: 'in_progress',
      signalToken: 'paste-stale-1',
    });
    await harness.seedAgent({
      id: 'dev-1', taskId: 'task-paste-drift', paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    harness.stubEnsureSession(m);
    let armed = false;
    const watcherSpy = vi.spyOn(
      m as unknown as { setupPhaseSignalWatcher: (...args: unknown[]) => Promise<boolean> },
      'setupPhaseSignalWatcher',
    ).mockImplementation(async () => {
      armed = true;
      return true;
    });
    let drifted = false;
    const realUpdate = harness.agentStore.update.bind(harness.agentStore);
    vi.spyOn(harness.agentStore, 'update').mockImplementation(async (id, updater) => {
      if (armed && !drifted) {
        drifted = true;
        const fresh = await harness.taskStore.get('task-paste-drift');
        await harness.taskStore.set({ ...fresh!, phase: 'code', signalToken: 'paste-rotated-2' });
      }
      return realUpdate(id, updater);
    });
    const injected: string[] = [];
    harness.stubInject(m, async (_tmux, _paneId, prompt) => {
      injected.push(prompt);
      return { acked: true, composerDelivered: true };
    });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-paste-drift'))
      .resolves.toBe(false);
    expect(watcherSpy).toHaveBeenCalledTimes(1);
    expect(injected).toEqual([]);
  });

  it('finalizes the bootstrap marker and delivery evidence after replaying an interrupted initial develop', async () => {
    const m = harness.manager;
    await harness.seedTask({
      id: 'task-boot-replay',
      status: 'in_progress',
      signalToken: 'boot-token-1',
    });
    await harness.seedAgent({
      id: 'dev-1', taskId: 'task-boot-replay', paneId: '%0',
      workdir: '/tmp/repo', bootstrappingTaskId: 'task-boot-replay',
    });
    vi.spyOn(m, 'clearAwaitingHuman').mockResolvedValue(true);
    const continueSpy = vi.spyOn(m, 'continueSession').mockResolvedValue(true);

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-boot-replay')).toBe(true);
    expect(continueSpy).toHaveBeenCalled();
    expect((continueSpy.mock.calls[0]![3] as { allowDirtyWorkdir?: boolean }).allowDirtyWorkdir)
      .toBeUndefined();
    expect((await harness.agentStore.get('dev-1'))?.bootstrappingTaskId).toBeUndefined();
    expect(harness.events.some(e =>
      e.type === 'session.started' && e.taskId === 'task-boot-replay' && e.data.phase === 'develop',
    )).toBe(true);
  });

  it('keeps the bootstrap marker and holds the rotated pass when the replay is not delivered', async () => {
    const m = harness.manager;
    await harness.seedTask({
      id: 'task-boot-keep',
      status: 'in_progress',
      signalToken: 'boot-token-2',
    });
    await harness.seedAgent({
      id: 'dev-1', taskId: 'task-boot-keep', paneId: '%0',
      workdir: '/tmp/repo', bootstrappingTaskId: 'task-boot-keep',
    });
    vi.spyOn(m, 'clearAwaitingHuman').mockResolvedValue(true);
    vi.spyOn(m, 'continueSession').mockResolvedValue(false);

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-boot-keep')).toBe(true);
    expect(await rotatedTaskToken('task-boot-keep', 'boot-token-2')).toEqual(expect.any(String));
    expect((await harness.agentStore.get('dev-1'))?.bootstrappingTaskId).toBe('task-boot-keep');
    expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBe('restart-redispatch-failed');
    expect(harness.events.some(e => e.type === 'session.started' && e.taskId === 'task-boot-keep')).toBe(false);
  });

  it('hold CAS distinguishes generations rewritten within the same millisecond', async () => {
    const m = harness.manager;
    await harness.seedTask({ id: 'task-aba-hold', status: 'in_progress' });
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-aba-hold', paneId: '%0' });
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-07-01T00:00:00.000Z') });
    try {
      await m.markAwaitingHuman('dev-1', 'hold-x', 'first generation');
      const gen1 = await harness.agentStore.get('dev-1');
      const entry = {
        phase: gen1?.awaitingPhase,
        since: gen1?.awaitingSince,
        nonce: gen1?.awaitingNonce,
      };

      await m.clearAwaitingHuman('dev-1');
      await m.markAwaitingHuman('dev-1', 'hold-x', 'second generation');
      const gen2 = await harness.agentStore.get('dev-1');
      expect(gen2?.awaitingSince).toBe(gen1?.awaitingSince);
      expect(gen2?.awaitingNonce).not.toBe(gen1?.awaitingNonce);

      expect(await m.clearAwaitingHuman('dev-1', { expectedHold: entry })).toBe(false);
      expect((await harness.agentStore.get('dev-1'))?.status).toBe('awaiting_human');
      expect((await harness.agentStore.get('dev-1'))?.awaitingReason).toBe('second generation');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not replay a delivered bootstrap held on a failed marker clear', async () => {
    const m = harness.manager;
    await harness.seedTask({
      id: 'task-boot-delivered',
      status: 'in_progress',
      signalToken: 'boot-token-3',
    });
    await harness.seedAgent({
      id: 'dev-1', taskId: 'task-boot-delivered', paneId: '%0',
      workdir: '/tmp/repo', bootstrappingTaskId: 'task-boot-delivered',
      status: 'awaiting_human',
      awaitingPhase: 'bootstrap-marker-clear-failed',
      awaitingReason: 'marker clear failed after delivery',
      awaitingSince: NOW,
    });
    const continueSpy = vi.spyOn(m, 'continueSession').mockResolvedValue(true);

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-boot-delivered')).toBe(true);
    expect(continueSpy).not.toHaveBeenCalled();
    const state = await harness.agentStore.get('dev-1');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('restart-redispatch-failed');
    expect(state?.awaitingReason).toMatch(/already delivered/);
  });

  it('aborts the replay before arming when the pass moved on mid-dispatch', async () => {
    const m = harness.manager;
    await harness.seedTask({
      id: 'task-drift-restart',
      status: 'in_progress',
      signalToken: 'stale-token-1',
    });
    await harness.seedAgent({
      id: 'dev-1', taskId: 'task-drift-restart', paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    harness.stubEnsureSession(m);
    vi.spyOn(m, 'ensureSession').mockImplementation(async (agentId) => {
      const fresh = await harness.taskStore.get('task-drift-restart');
      await harness.taskStore.set({ ...fresh!, phase: 'code', signalToken: 'rotated-token-2' });
      return {
        ok: true, createdSession: false, freshRuntime: false, paneId: '%0',
        workdir: (await harness.agentStore.get(agentId))?.workdir ?? '/tmp/repo',
      };
    });
    const watcherSpy = vi.spyOn(
      m as unknown as { setupPhaseSignalWatcher: (...args: unknown[]) => Promise<boolean> },
      'setupPhaseSignalWatcher',
    ).mockResolvedValue(true);
    const injected: string[] = [];
    harness.stubInject(m, async (_tmux, _paneId, prompt) => {
      injected.push(prompt);
      return { acked: true, composerDelivered: true };
    });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-drift-restart'))
      .resolves.toBe(false);
    expect(watcherSpy).not.toHaveBeenCalled();
    expect(injected).toEqual([]);
  });

  it('rotates an embedded git post-approve token without losing episode metadata', async () => {
    const m = restartManager();
    await harness.seedTask({
      id: 'task-postapprove-git-restart',
      status: 'approved',
      signalToken: 'task-token-git',
      postApproveGeneration: 'feedfeedfeed',
      postApproveHeadSha: 'a'.repeat(40),
      postApproveToken: 'git-pa-token-1',
      postApprovePhase: 'installed',
      redispatchCount: 4,
      pendingRedispatch: true,
      consumedFeedback: { review_1: 17 },
    });
    const confirm = vi.spyOn(m, 'confirmPostApprovePromptDelivered').mockResolvedValue();
    const { continueSpy } = spyDispatch(m);

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-postapprove-git-restart')).toBe(true);

    const task = await harness.taskStore.get('task-postapprove-git-restart');
    expect(task?.postApproveToken).not.toBe('git-pa-token-1');
    expect(task).toMatchObject({
      postApproveGeneration: 'feedfeedfeed',
      postApproveHeadSha: 'a'.repeat(40),
      postApprovePhase: 'installed',
      redispatchCount: 4,
      pendingRedispatch: true,
      consumedFeedback: { review_1: 17 },
    });
    expect(continueSpy).toHaveBeenCalledWith(
      'task-postapprove-git-restart',
      'dev-1',
      'post-approve',
      expect.objectContaining({ signalToken: task!.postApproveToken }),
    );
    expect(confirm).toHaveBeenCalledWith('task-postapprove-git-restart', {
      generation: 'feedfeedfeed',
      headSha: 'a'.repeat(40),
      token: task!.postApproveToken,
    });
  });

  it('holds the post-approve replay when neither completion nor approved head survive', async () => {
    const m = restartManager();
    await harness.seedTask({
      id: 'task-postapprove-lost',
      status: 'approved',
      signalToken: 'tok-x',
    });
    const { continueSpy, holdSpy } = spyDispatch(m);

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-postapprove-lost')).toBe(true);
    expect(continueSpy).not.toHaveBeenCalled();
    expect(await m.getPostApproveCompletion('task-postapprove-lost')).toBeNull();
    expect(holdSpy).toHaveBeenCalledWith(
      'dev-1',
      'restart-redispatch-failed',
      expect.any(String),
      expect.objectContaining({ expectedTaskId: 'task-postapprove-lost' }),
    );
  });

  it('holds the rebuild when only a drifted latestHeadSha is persisted', async () => {
    const m = restartManager();
    await harness.seedTask({
      id: 'task-postapprove-drifted',
      status: 'approved',
      latestHeadSha: 'unreviewed-sha-B',
    });
    const { continueSpy, holdSpy } = spyDispatch(m);

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-postapprove-drifted')).toBe(true);
    expect(continueSpy).not.toHaveBeenCalled();
    expect(await m.getPostApproveCompletion('task-postapprove-drifted')).toBeNull();
    expect(holdSpy).toHaveBeenCalledWith(
      'dev-1',
      'restart-redispatch-failed',
      expect.any(String),
      expect.objectContaining({ expectedTaskId: 'task-postapprove-drifted' }),
    );
  });

  it('markAwaitingHuman reports whether the hold generation write landed', async () => {
    const m = restartManager();
    await harness.seedTask({ id: 'task-mark-cas', status: 'in_progress', signalToken: 'mc-T1' });
    await harness.seedAgent({
      id: 'dev-1', taskId: 'task-mark-cas',
      status: 'awaiting_human', awaitingPhase: 'phase-a', awaitingReason: 'r', awaitingSince: NOW,
    });

    expect(await m.markAwaitingHuman('dev-1', 'phase-b', 'r2', {
      expectedTaskId: 'task-mark-cas',
      expectedHold: { phase: 'phase-x', since: NOW },
    })).toBe(false);
    expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBe('phase-a');

    expect(await m.markAwaitingHuman('dev-1', 'phase-b', 'r2', {
      expectedTaskId: 'task-mark-cas',
      expectedHold: { phase: 'phase-a', since: NOW },
    })).toBe(true);
    expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBe('phase-b');
  });

  it('aborts the replay when the entry hold vanished before the clear', async () => {
    const m = restartManager();
    await harness.seedTask({ id: 'task-entry-clear', status: 'in_progress', signalToken: 'ec-T1' });
    await harness.seedAgent({
      id: 'dev-1', taskId: 'task-entry-clear', paneId: '%0',
      status: 'awaiting_human',
      awaitingPhase: 'restart-redispatch-failed',
      awaitingReason: 'pre-restart hold',
      awaitingSince: NOW,
    });
    const continueSpy = vi.spyOn(m, 'continueSession').mockResolvedValue(true);
    const realGet = harness.taskStore.get.bind(harness.taskStore);
    let reads = 0;
    vi.spyOn(harness.taskStore, 'get').mockImplementation(async (id) => {
      const value = await realGet(id);
      if (id === 'task-entry-clear') {
        reads += 1;
        if (reads === 2) await m.clearAwaitingHuman('dev-1');
      }
      return value;
    });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-entry-clear')).resolves.toBe(false);
    expect(continueSpy).not.toHaveBeenCalled();
  });

  it('a successor hold landing after the currentness read still survives the clear', async () => {
    const m = harness.manager;
    await harness.seedTask({ id: 'task-hold-cas', status: 'in_progress', signalToken: 'hc-T1' });
    await harness.seedAgent({
      id: 'dev-1', taskId: 'task-hold-cas', paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    const realGet = harness.taskStore.get.bind(harness.taskStore);
    let reads = 0;
    vi.spyOn(harness.taskStore, 'get').mockImplementation(async (id) => {
      const value = await realGet(id);
      if (id === 'task-hold-cas') {
        reads += 1;
        if (reads === 2 && value) {
          await m.markAwaitingHuman(
            'dev-1',
            'code-dispatch-failed',
            'successor hold after currentness read',
            expect.objectContaining({ expectedTaskId: 'task-hold-cas' }),
          );
          await harness.taskStore.set({ ...value, phase: 'code', signalToken: 'hc-T2' });
        }
      }
      return value;
    });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-hold-cas')).resolves.toBe(false);
    const binding = await harness.agentStore.get('dev-1');
    expect(binding?.status).toBe('awaiting_human');
    expect(binding?.awaitingPhase).toBe('code-dispatch-failed');
    expect(binding?.awaitingReason).toBe('successor hold after currentness read');
  });

  it('a stale replay never clears a hold written by the successor pass', async () => {
    const m = harness.manager;
    await harness.seedTask({ id: 'task-hold-race', status: 'in_progress', signalToken: 'hr-T1' });
    await harness.seedAgent({
      id: 'dev-1', taskId: 'task-hold-race', paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    const clearSpy = vi.spyOn(m, 'clearAwaitingHuman');
    const realGet = harness.taskStore.get.bind(harness.taskStore);
    let hooked = false;
    vi.spyOn(harness.taskStore, 'get').mockImplementation(async (id) => {
      const value = await realGet(id);
      if (id === 'task-hold-race' && !hooked && value) {
        hooked = true;
        await m.markAwaitingHuman(
          'dev-1',
          'code-dispatch-failed',
          'successor hold',
          expect.objectContaining({ expectedTaskId: 'task-hold-race' }),
        );
        await harness.taskStore.set({ ...value, phase: 'code', signalToken: 'hr-T2' });
      }
      return value;
    });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-hold-race')).resolves.toBe(false);
    expect(clearSpy).not.toHaveBeenCalled();
    const binding = await harness.agentStore.get('dev-1');
    expect(binding?.status).toBe('awaiting_human');
    expect(binding?.awaitingPhase).toBe('code-dispatch-failed');
  });

  it('escalates an own-generation arm failure into the recoverable hold path', async () => {
    const m = harness.manager;
    await harness.seedTask({
      id: 'task-arm-fail',
      status: 'in_progress',
      signalToken: 'arm-fail-1',
    });
    await harness.seedAgent({
      id: 'dev-1', taskId: 'task-arm-fail', paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    harness.stubEnsureSession(m);
    vi.spyOn(
      m as unknown as { setupPhaseSignalWatcher: (...args: unknown[]) => Promise<boolean> },
      'setupPhaseSignalWatcher',
    ).mockResolvedValue(false);
    const injected: string[] = [];
    harness.stubInject(m, async (_tmux, _paneId, prompt) => {
      injected.push(prompt);
      return { acked: true, composerDelivered: true };
    });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-arm-fail'))
      .resolves.toBe(true);
    expect(injected).toEqual([]);
    const held = await harness.agentStore.get('dev-1');
    expect(held?.status).toBe('awaiting_human');
    expect(held?.awaitingPhase).toBe('restart-redispatch-failed');
    expect(held?.awaitingReason).toMatch(/failed to arm/);
  });

  it('a post-clear replay throw is held on the live generation, not the stale entry hold', async () => {
    const m = harness.manager;
    await harness.seedTask({
      id: 'task-throw-held',
      status: 'in_progress',
      signalToken: 'throw-held-1',
    });
    await harness.seedAgent({
      id: 'dev-1', taskId: 'task-throw-held', paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
      status: 'awaiting_human', awaitingPhase: 'restart-redispatch-failed', awaitingSince: NOW,
    });
    harness.stubEnsureSession(m);
    vi.spyOn(
      m as unknown as { setupPhaseSignalWatcher: (...args: unknown[]) => Promise<boolean> },
      'setupPhaseSignalWatcher',
    ).mockResolvedValue(true);
    harness.stubInject(m, async () => {
      throw new Error('enter scrub failed mid-delivery');
    });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-throw-held'))
      .resolves.toBe(true);
    const held = await harness.agentStore.get('dev-1');
    expect(held?.status).toBe('awaiting_human');
    expect(held?.awaitingPhase).toBe('restart-redispatch-failed');
    expect(held?.awaitingReason).toMatch(/enter scrub failed mid-delivery/);
    expect(held?.awaitingSince).not.toBe(NOW);
  });

  it('a replay throw after a successor rotation exits without holding the successor', async () => {
    const m = harness.manager;
    await harness.seedTask({
      id: 'task-throw-rotated',
      status: 'in_progress',
      signalToken: 'throw-rot-1',
    });
    await harness.seedAgent({
      id: 'dev-1', taskId: 'task-throw-rotated', paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    harness.stubEnsureSession(m);
    vi.spyOn(
      m as unknown as { setupPhaseSignalWatcher: (...args: unknown[]) => Promise<boolean> },
      'setupPhaseSignalWatcher',
    ).mockResolvedValue(true);
    harness.stubInject(m, async () => {
      const fresh = await harness.taskStore.get('task-throw-rotated');
      await harness.taskStore.set({ ...fresh!, signalToken: 'throw-rot-2' });
      throw new Error('paste transport died');
    });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-throw-rotated'))
      .resolves.toBe(false);
    const after = await harness.agentStore.get('dev-1');
    expect(after?.status).not.toBe('awaiting_human');
  });

  it('exits quietly when the arm failed because the pass already moved on', async () => {
    const m = harness.manager;
    await harness.seedTask({
      id: 'task-arm-fail-drift',
      status: 'in_progress',
      signalToken: 'arm-fail-2',
    });
    await harness.seedAgent({
      id: 'dev-1', taskId: 'task-arm-fail-drift', paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    harness.stubEnsureSession(m);
    vi.spyOn(
      m as unknown as { setupPhaseSignalWatcher: (...args: unknown[]) => Promise<boolean> },
      'setupPhaseSignalWatcher',
    ).mockImplementation(async () => {
      const fresh = await harness.taskStore.get('task-arm-fail-drift');
      await harness.taskStore.set({ ...fresh!, phase: 'code', signalToken: 'arm-fail-rotated' });
      return false;
    });
    const injected: string[] = [];
    harness.stubInject(m, async (_tmux, _paneId, prompt) => {
      injected.push(prompt);
      return { acked: true, composerDelivered: true };
    });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-arm-fail-drift'))
      .resolves.toBe(false);
    expect(injected).toEqual([]);
  });

  it('aborts the paste when the pass rotates while waiting for the pane mutex', async () => {
    const m = harness.manager;
    await harness.seedTask({
      id: 'task-mutex-drift',
      status: 'in_progress',
      signalToken: 'mutex-stale-1',
    });
    await harness.seedAgent({
      id: 'dev-1', taskId: 'task-mutex-drift', paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    harness.stubEnsureSession(m);
    vi.spyOn(
      m as unknown as { setupPhaseSignalWatcher: (...args: unknown[]) => Promise<boolean> },
      'setupPhaseSignalWatcher',
    ).mockResolvedValue(true);
    vi.spyOn(
      m as unknown as { acquireCompactGuard: (agentId: string) => Promise<void> },
      'acquireCompactGuard',
    ).mockImplementation(async () => {
      const fresh = await harness.taskStore.get('task-mutex-drift');
      await harness.taskStore.set({ ...fresh!, phase: 'code', signalToken: 'mutex-rotated-2' });
    });
    const stepsSpy = vi.spyOn(
      m as unknown as { injectAndAwaitAckSteps: (...args: unknown[]) => Promise<unknown> },
      'injectAndAwaitAckSteps',
    ).mockResolvedValue({ acked: true, composerDelivered: true });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-mutex-drift'))
      .resolves.toBe(false);
    expect(stepsSpy).not.toHaveBeenCalled();
  });

  it('holds an in-flight holder whose signal token is missing', async () => {
    const m = restartManager();
    await harness.seedTask({
      id: 'task-no-token',
      status: 'in_progress',
    });
    const { continueSpy, holdSpy } = spyDispatch(m);

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-no-token')).toBe(true);
    expect(continueSpy).not.toHaveBeenCalled();
    expect(holdSpy).toHaveBeenCalledWith(
      'dev-1',
      'restart-redispatch-failed',
      expect.any(String),
      expect.objectContaining({ expectedTaskId: 'task-no-token' }),
    );
  });

  it('leaves non-working statuses to the waiting transition', async () => {
    const m = restartManager();
    await harness.seedTask({
      id: 'task-in-review',
      status: 'review',
      phase: 'code',
      qaAgentId: 'qa-1',
      signalToken: 'tok-b',
    });
    await harness.seedTask({
      id: 'task-spec-ready',
      status: 'spec-ready',
      phase: 'spec',
      signalToken: 'tok-c',
    });
    const { continueSpy, holdSpy } = spyDispatch(m);

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-in-review')).toBe(false);
    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-spec-ready')).toBe(false);
    expect(continueSpy).not.toHaveBeenCalled();
    expect(holdSpy).not.toHaveBeenCalled();
  });
});

describe('AgentManager.advanceTask', () => {
  async function seedRevokedTask(id: string): Promise<void> {
    await harness.seedTask({
      id,
      status: 'approved',
      phase: 'code',
      prNumber: 42,
      latestHeadSha: SHA1,
      passProvenance: {
        sourceKey: 'issue-comments',
        id: 'pass-1',
        bodyDigest: 'digest',
        token: 'abcdef123456',
        failToken: '123456abcdef',
        anchorSha: SHA1,
      },
      postApproveRevoked: {
        generation: 'feedfeedfeed',
        reason: 'redispatch-cap',
        at: NOW,
      },
    });
  }

  it('replays the persisted Dev instruction for an in-progress task', async () => {
    const m = harness.manager;
    await harness.seedTask({
      id: 'task-advance-dev',
      status: 'in_progress',
      phase: 'code',
      signalToken: 'advance-token',
    });
    const replay = vi.spyOn(m, 'redispatchTaskPromptAfterReplRestart').mockResolvedValue(true);

    const result = await m.advanceTask('task-advance-dev', { executor: 'dev', note: 'manual replay' });

    expect(result.status).toBe('in_progress');
    expect(replay).toHaveBeenCalledWith('dev-1', 'task-advance-dev');
    expect(harness.events.at(-1)).toMatchObject({
      type: 'task.updated',
      taskId: 'task-advance-dev',
      data: {
        operation: 'advance',
        action: 'dev',
        actor: 'human',
        provenance: 'human',
        note: 'manual replay',
      },
    });
  });

  it('routes a QA advance through the existing delivery and review guard', async () => {
    const m = harness.manager;
    const task = await harness.seedTask({
      id: 'task-advance-qa',
      status: 'fixing',
      phase: 'code',
      signalToken: 'advance-qa-token',
    });
    const dispatch = vi.spyOn(m, 'dispatchReviewToQa').mockResolvedValue({
      ...task,
      status: 'review',
    });

    await m.advanceTask(task.id, {
      executor: 'qa',
      stage: 'code',
      prNumber: 42,
    });

    expect(dispatch).toHaveBeenCalledWith(task.id, {
      fromStatus: ['fixing'],
      confirmUncertainNotDelivered: true,
      stage: 'code',
      prNumber: 42,
    });
    expect(harness.events.at(-1)).toMatchObject({
      type: 'task.updated',
      taskId: task.id,
      data: {
        operation: 'advance',
        action: 'qa',
        actor: 'human',
        provenance: 'human',
        note: 'advance:qa',
      },
    });
  });

  it('rejects Review to Dev because only a request-changes verdict may start fixing', async () => {
    const m = harness.manager;
    await harness.seedTask({
      id: 'task-review-to-dev',
      status: 'review',
      phase: 'code',
      signalToken: 'review-token',
    });
    const replay = vi.spyOn(m, 'redispatchTaskPromptAfterReplRestart');

    await expect(m.advanceTask('task-review-to-dev', { executor: 'dev' }))
      .rejects.toMatchObject({ status: 409 });
    expect(replay).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation before restoring a revoked post-approve episode', async () => {
    const m = harness.manager;
    await seedRevokedTask('task-revoked-advance');

    await expect(m.advanceTask('task-revoked-advance', { executor: 'dev' }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('revalidates the accepted head before restoring a revoked post-approve episode', async () => {
    const m = harness.manager;
    await seedRevokedTask('task-restore-revoked');
    vi.spyOn(m, 'platformVerifyPrBinding').mockResolvedValue({
      ok: true,
      prUrl: 'https://github.com/user/repo/pull/42',
      headSha: SHA1,
      branch: 'bx/task-restore-revoked',
      targetBranch: 'main',
    });
    vi.spyOn(m, 'platformVerifyAcceptedPass').mockResolvedValue({
      kind: 'valid',
      pendingCount: 0,
    });
    const replay = vi.spyOn(m, 'redispatchTaskPromptAfterReplRestart').mockResolvedValue(true);

    const result = await m.advanceTask('task-restore-revoked', {
      executor: 'dev',
      confirmRevoked: true,
    });

    expect(result.postApproveRevoked).toBeUndefined();
    expect(result.postApproveGeneration).toMatch(/^[0-9a-f]{12}$/);
    expect(result.postApproveToken).toMatch(/^[0-9a-f]{12}$/);
    expect(replay).toHaveBeenCalledWith('dev-1', 'task-restore-revoked');
  });

  it('refuses restoration when accepted-pass provenance changes during remote verification', async () => {
    const m = harness.manager;
    await seedRevokedTask('task-racing-revoked');
    vi.spyOn(m, 'platformVerifyPrBinding').mockResolvedValue({
      ok: true,
      prUrl: 'https://github.com/user/repo/pull/42',
      headSha: SHA1,
      branch: 'bx/task-racing-revoked',
      targetBranch: 'main',
    });
    vi.spyOn(m, 'platformVerifyAcceptedPass').mockImplementation(async () => {
      const fresh = (await harness.taskStore.get('task-racing-revoked'))!;
      await harness.taskStore.set({
        ...fresh,
        passProvenance: { ...fresh.passProvenance!, bodyDigest: `changed-${SHA2}` },
        updatedAt: new Date().toISOString(),
      });
      return { kind: 'valid', pendingCount: 0 };
    });
    const replay = vi.spyOn(m, 'redispatchTaskPromptAfterReplRestart');

    await expect(m.advanceTask('task-racing-revoked', {
      executor: 'dev',
      confirmRevoked: true,
    })).rejects.toMatchObject({ status: 409 });

    expect(replay).not.toHaveBeenCalled();
    expect((await harness.taskStore.get('task-racing-revoked'))?.postApproveRevoked)
      .toBeDefined();
  });
});
