import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentManager, type DispatchArmContext, DispatchTerminalError } from '../../src/agent/manager.js';
import { AgentStore } from '../../src/state/agent-store.js';
import { TaskStore } from '../../src/state/task-store.js';
import { LockManager } from '../../src/state/lock.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { initStateDir } from '../../src/state/init.js';
import type { BaxianConfig, BaxianEvent, ReviewFindings, ReviewMode, TaskState } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG, taskGenerationGuard } from '../../src/shared/index.js';
import type { ExecResult } from '../../src/agent/runner.js';
import { __setNetExecSleepForTests } from '../../src/agent/net-exec.js';
import { BranchManager } from '../../src/agent/branch.js';
import { ReviewStore, reviewFindingsDigest, serverResponseFailureSignature } from '../../src/state/review-store.js';

let tempDir: string;
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-server-dispatch-'));
  await initStateDir(tempDir);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

function makeConfig(mode: ReviewMode, opts: { omitQa?: boolean; siblingProjects?: boolean } = {}): BaxianConfig {
  const agents = [
    { id: 'dev-1', runtime: 'claude-code' as const, role: 'dev' as const, mode: 'local' as const, workdir: join(tempDir, 'dev-1') },
    ...(opts.omitQa ? [] : [{ id: 'qa-1', runtime: 'codex' as const, role: 'qa' as const, mode: 'local' as const, workdir: join(tempDir, 'qa-1') }]),
  ];
  return {
    review: { rounds: 10, mode },
    server: DEFAULT_SERVER_CONFIG,
    host: [],
    project: [
      { id: 'proj', repo: 'user/repo', merge: null, agent: [agents] },
      ...(opts.siblingProjects
        ? [
          { id: 'proj-same-repo', repo: 'User/Repo', merge: null, agent: [] },
          { id: 'proj-other-repo', repo: 'user/elsewhere', merge: null, agent: [] },
        ]
        : []),
    ],
  } as BaxianConfig;
}

async function makeFixture(mode: ReviewMode, opts: { omitQa?: boolean; siblingProjects?: boolean } = {}) {
  const runner = {
    exec: vi.fn(async (): Promise<ExecResult> =>
      ({ stdout: '', stderr: '', exitCode: 0 })),
    writeFile: vi.fn(async () => undefined),
    execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
  };
  const taskStore = new TaskStore(join(tempDir, 'state', 'tasks'));
  const agentStore = new AgentStore(join(tempDir, 'state', 'agents'));
  const lockManager = new LockManager(join(tempDir, 'locks'));
  const updateAgent = agentStore.update.bind(agentStore);
  vi.spyOn(agentStore, 'update').mockImplementation(async (id, update) => {
    const commit = await updateAgent(id, update);
    const state = await agentStore.get(id);
    if (!state?.taskId || await lockManager.isLocked(id)) return commit;
    const token = await lockManager.acquire(id, state.taskId);
    if (!token) return commit;
    await updateAgent(id, latest => latest?.taskId === state.taskId
      ? { ...latest, lockToken: token, updatedAt: new Date().toISOString() }
      : latest);
    return commit;
  });
  const eventBus = new EventBus(new EventLog(join(tempDir, 'events')));
  const events: BaxianEvent[] = [];
  eventBus.on('*', (e) => { events.push(e); });
  const watcher = {
    start: vi.fn(async () => true),
    stop: vi.fn(),
    stopAgentIfToken: vi.fn(),
    stopIfToken: vi.fn(),
    has: vi.fn(() => false),
    isSettling: vi.fn(() => false),
    settlePermitMatches: vi.fn(() => false),
    exclusiveOwnerMatches: vi.fn(() => false),
    awaitSettled: vi.fn(async () => undefined),
    runExclusive: vi.fn(async (_taskId: string, fn: (owner: symbol) => Promise<unknown>) => fn(Symbol('owner-test'))),
  };
  const reviewStore = new ReviewStore();
  const manager = new AgentManager({
    config: makeConfig(mode, opts),
    agentStore,
    taskStore,
    lockManager,
    eventBus,
    runnerFactory: () => runner,
    platformRunner: runner,
    phaseSignalWatcher: watcher as never,
    reviewStore,
  });
  return { manager, taskStore, agentStore, lockManager, reviewStore, events, watcher, runner };
}

function taskFixture(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'task-1', projectId: 'proj', title: 'T', description: 'D',
    preferredAgentId: 'dev-1', agentId: 'dev-1', devAgentId: 'dev-1', qaAgentId: 'qa-1',
    phase: 'code',
    reviewMode: 'server',
    reviewRound: 0, branch: 'bx/task-1', status: 'in_progress',
    createdAt: '2026-06-12T00:00:00.000Z', updatedAt: '2026-06-12T00:00:00.000Z',
    ...overrides,
  } as TaskState;
}

const RECOVERY_FINDINGS: ReviewFindings = {
  round: 1,
  verdict: 'request-changes',
  findings: [{ id: 'f-1', severity: 'major', message: 'broken' }],
};

function recoveryTask(mode: 'classify-response' | 'correct-response' | 'hold'): TaskState {
  const findingsDigest = reviewFindingsDigest(RECOVERY_FINDINGS);
  return taskFixture({
    reviewMode: 'server',
    phase: 'code',
    status: 'fixing',
    reviewRound: 1,
    signalToken: '222222222222',
    serverSignalRecovery: {
      mode,
      signalKind: 'code-fixed',
      phase: 'code',
      round: 1,
      sourceToken: '111111111111',
      findingsDigest,
      failureSignature: serverResponseFailureSignature({
        phase: 'code', round: 1, findingsDigest, reason: 'coverage-gap', missingFindingIds: ['f-1'],
      }),
      responseDigest: 'c'.repeat(64),
      reason: 'coverage-gap',
      failurePhase: 'server-code-response-coverage-gap',
      missingFindingIds: ['f-1'],
      unknownFindingIds: [],
      schemaViolationCodes: [],
      createdAt: '2026-06-12T00:01:00.000Z',
    },
  });
}

async function seedRecoveryRound(fixture: Awaited<ReturnType<typeof makeFixture>>): Promise<void> {
  await fixture.reviewStore.putRound('task-1', 'code', {
    round: 1,
    phase: 'code',
    content: 'diff',
    findings: RECOVERY_FINDINGS,
    startedAt: '2026-06-12T00:00:00.000Z',
  });
}

describe('server signal generation recovery', () => {
  it('allows only one status+phase+round+source-token correction claim', async () => {
    const f = await makeFixture('server');
    const task = taskFixture({
      reviewMode: 'server', phase: 'code', status: 'fixing', reviewRound: 1, signalToken: '111111111111',
    });
    await f.taskStore.set(task);
    const findingsDigest = reviewFindingsDigest(RECOVERY_FINDINGS);
    const input = {
      mode: 'classify-response' as const,
      phase: 'code' as const,
      round: 1,
      findingsDigest,
      failureSignature: serverResponseFailureSignature({
        phase: 'code', round: 1, findingsDigest, reason: 'coverage-gap', missingFindingIds: ['f-1'],
      }),
      responseDigest: 'c'.repeat(64),
      reason: 'coverage-gap' as const,
      missingFindingIds: ['f-1'],
      unknownFindingIds: [],
      schemaViolationCodes: [],
    };

    const [first, second] = await Promise.all([
      f.manager.claimServerSignalRecovery(task, 'dev-1', 'code-fixed', input),
      f.manager.claimServerSignalRecovery(task, 'dev-1', 'code-fixed', input),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    const stored = await f.taskStore.get(task.id);
    expect(stored?.signalToken).not.toBe('111111111111');
    expect(stored?.serverSignalRecovery?.sourceToken).toBe('111111111111');
    expect(f.watcher.stopAgentIfToken).toHaveBeenCalledTimes(1);
  });

  it('fences a legacy spec entry whose phase and spec round are not materialized yet', async () => {
    const f = await makeFixture('server');
    const task = taskFixture({
      reviewMode: 'server', phase: undefined, status: 'in_progress',
      specReviewRound: undefined, signalToken: '111111111111',
    });
    await f.taskStore.set(task);
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: '2026-06-12T00:00:00.000Z',
    }));

    const claimed = await f.manager.holdConsumedServerSignal(task, 'dev-1', 'spec-done', {
      phase: 'spec',
      round: 0,
      reason: 'handler-failed',
      failurePhase: 'server-spec-content-read-failed',
    });

    expect(claimed?.signalToken).not.toBe('111111111111');
    expect(claimed?.serverSignalRecovery).toMatchObject({ phase: 'spec', round: 0, mode: 'hold' });
    await expect(f.manager.setServerSignalRecoveryMode(
      'task-1', claimed!.signalToken!, 'hold',
    )).resolves.not.toBeNull();
  });

  it('arms the successor watcher before correction injection and clears the guarded intent after delivery', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(recoveryTask('correct-response'));
    await seedRecoveryRound(f);
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: '2026-06-12T00:00:00.000Z',
    }));
    const order: string[] = [];
    f.watcher.start.mockImplementation(async () => {
      order.push('arm');
      return true;
    });
    vi.spyOn(f.manager, 'continueSession').mockImplementation(async (_taskId, _agentId, _phase, opts) => {
      expect(await opts.armBeforeInject?.({})).toBe(true);
      expect(await opts.guardBeforeInject?.()).toBe(true);
      order.push('inject');
      return true;
    });

    await expect(f.manager.dispatchServerFeedbackCorrection(
      'task-1', JSON.stringify(RECOVERY_FINDINGS),
    )).resolves.toBe(true);

    expect(order).toEqual(['arm', 'inject']);
    expect(f.watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      token: '222222222222',
      replaceFromToken: '111111111111',
      onlyReplaceOwnToken: true,
      skipSnapshot: true,
    }));
    expect((await f.taskStore.get('task-1'))?.serverSignalRecovery).toBeUndefined();
  });

  it('finishes a classify-response crash intent idempotently on startup', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(recoveryTask('classify-response'));
    await seedRecoveryRound(f);
    const deleteResponse = vi.fn(async () => undefined);
    vi.spyOn(f.manager, 'getReviewTransport').mockReturnValue({
      readResponseWithRaw: vi.fn(async () => ({
        kind: 'invalid' as const,
        raw: '{}',
        responseDigest: 'c'.repeat(64),
        error: new Error('invalid'),
        schemaViolationCodes: ['response-not-object'],
      })),
      deleteResponse,
    } as never);
    const guardedDelete = vi.spyOn(f.manager, 'deleteReviewExchangeIfCurrent');
    const correction = vi.spyOn(f.manager, 'dispatchServerFeedbackCorrection').mockResolvedValue(true);

    await f.manager.setupRecoveredSpecSignals();
    await f.manager.setupRecoveredSpecSignals();

    const stored = await f.reviewStore.getRound('task-1', 'code', 1);
    expect(stored?.serverResponseFailures).toHaveLength(1);
    expect(stored?.serverResponseFailures?.[0]).toMatchObject({
      sourceToken: '111111111111', disposition: 'auto-correct', reason: 'coverage-gap',
    });
    expect(correction).toHaveBeenCalledTimes(2);
    expect(deleteResponse).toHaveBeenCalledTimes(2);
    expect(guardedDelete).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ id: 'dev-1' }),
      'response',
      expect.objectContaining({ signalToken: '222222222222' }),
      expect.objectContaining({
        mode: 'correct-response',
        signalKind: 'code-fixed',
        sourceToken: '111111111111',
      }),
    );
    expect(f.watcher.start).not.toHaveBeenCalled();
  });

  it('preserves a changed live response and holds instead of deleting it during recovery', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(recoveryTask('correct-response'));
    await seedRecoveryRound(f);
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: '2026-06-12T00:00:00.000Z',
    }));
    const deleteResponse = vi.fn(async () => undefined);
    vi.spyOn(f.manager, 'getReviewTransport').mockReturnValue({
      readResponseWithRaw: vi.fn(async () => ({
        kind: 'invalid' as const,
        raw: '{"changed":true}',
        responseDigest: 'd'.repeat(64),
        error: new Error('invalid'),
        schemaViolationCodes: ['unknown-schema-error'],
      })),
      deleteResponse,
    } as never);
    const correction = vi.spyOn(f.manager, 'dispatchServerFeedbackCorrection').mockResolvedValue(true);

    await f.manager.setupRecoveredSpecSignals();

    expect(deleteResponse).not.toHaveBeenCalled();
    expect(correction).not.toHaveBeenCalled();
    expect((await f.taskStore.get('task-1'))?.serverSignalRecovery?.mode).toBe('hold');
    expect(f.events.some(event =>
      event.data?.phase === 'server-code-feedback-recovery-response-changed')).toBe(true);
  });

  it('startup preserves a hold without arming an ordinary watcher', async () => {
    const f = await makeFixture('server');
    const task = recoveryTask('hold');
    await f.taskStore.set(task);
    const hold = vi.spyOn(f.manager, 'holdServerSignalRecovery').mockResolvedValue(task);

    await f.manager.setupRecoveredSpecSignals();

    expect(hold).toHaveBeenCalledWith(
      'task-1', 'dev-1', '222222222222',
      'server-code-response-coverage-gap',
      expect.stringContaining('held for coverage-gap'),
    );
    expect(f.watcher.start).not.toHaveBeenCalled();
  });

  it('an explicit REPL Restart consumes a hold and replays feedback with a fresh token and digest', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(recoveryTask('hold'));
    await seedRecoveryRound(f);
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: '2026-06-12T00:01:00.000Z',
      status: 'awaiting_human', awaitingPhase: 'server-feedback-response-repeated',
      awaitingReason: 'manual review required', awaitingSince: '2026-06-12T00:01:00.000Z',
    }));
    (f.manager as unknown as { phaseSignalWatcher?: unknown }).phaseSignalWatcher = undefined;
    const continuation = vi.spyOn(f.manager, 'continueSession').mockResolvedValue(true);

    await expect(f.manager.redispatchTaskPromptAfterReplRestart('dev-1', 'task-1')).resolves.toBe(true);

    const stored = await f.taskStore.get('task-1');
    expect(stored?.serverSignalRecovery).toBeUndefined();
    expect(stored?.signalToken).not.toBe('222222222222');
    expect(continuation).toHaveBeenCalledWith('task-1', 'dev-1', 'server-feedback', expect.objectContaining({
      signalToken: stored?.signalToken,
      serverFindingsDigest: reviewFindingsDigest(RECOVERY_FINDINGS),
      serverPriorFindings: JSON.stringify(RECOVERY_FINDINGS),
    }));
  });
});

describe('server dispatch guards (spec unification)', () => {
  it('dispatchServerReviewToQa rejects a git task for code phase', async () => {
    const f = await makeFixture('git');
    await f.taskStore.set(taskFixture({ reviewMode: 'git', phase: 'code', signalToken: 't' }));
    await expect(
      f.manager.dispatchServerReviewToQa('task-1', { phase: 'code', content: 'diff' }),
    ).rejects.toThrow(/not in server review mode/);
  });

  it('dispatchServerReviewToQa accepts a git task for spec phase (proceeds past guard)', async () => {
    const f = await makeFixture('git', { omitQa: true });
    await f.taskStore.set(taskFixture({ reviewMode: 'git', phase: 'spec', qaAgentId: undefined, signalToken: 't' }));
    const result = await f.manager.dispatchServerReviewToQa('task-1', { phase: 'spec', content: 'spec text' });
    expect(result).toBeNull();
    expect(f.events.some(e => e.type === 'human.intervention'
      && e.data?.phase === 'server-review-no-qa-partner')).toBe(true);
  });

  it('dispatchServerFixToDev rejects a git task outside spec phase', async () => {
    const f = await makeFixture('git');
    await f.taskStore.set(taskFixture({ reviewMode: 'git', phase: 'code', status: 'review', signalToken: 't' }));
    await expect(
      f.manager.dispatchServerFixToDev('task-1', '{}'),
    ).rejects.toThrow(/not in server review mode/);
  });
});

describe('dispatchServerReviewToQa arms the read-file watcher in startSession\'s pre-inject hook', () => {
  it('defers the spec-reviewed read-file watcher arm into startSession (not eagerly before the session exists)', async () => {
    const f = await makeFixture('git');
    const NOW = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'git', phase: 'spec', status: 'in_progress',
      signalToken: 'orig-token', specReviewRound: 0,
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW,
    }));

    const armedSpecReviewed = () => f.watcher.start.mock.calls.some(
      (c) => (c[0] as { expectedKinds?: unknown }).expectedKinds === 'spec-reviewed',
    );
    let capturedOpts: { armBeforeInject?: (ctx: DispatchArmContext) => Promise<boolean> } | undefined;
    let armedBeforeStart = false;
    const startSpy = vi.spyOn(f.manager, 'startSession').mockImplementation(async (_t, _a, _p, opts) => {
      capturedOpts = opts as { armBeforeInject?: (ctx: DispatchArmContext) => Promise<boolean> };
      armedBeforeStart = armedSpecReviewed();
      await capturedOpts.armBeforeInject?.({});
      return true;
    });

    await f.manager.dispatchServerReviewToQa('task-1', { phase: 'spec', content: 'spec text' });

    expect(startSpy).toHaveBeenCalled();
    expect(armedBeforeStart).toBe(false);
    expect(capturedOpts?.armBeforeInject).toBeTypeOf('function');
    expect(f.watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      expectedKinds: 'spec-reviewed',
      onReadFile: expect.any(Function),
      skipSnapshot: false,
    }));
  });

  it('does not arm read-file for code review when the QA checkout holds the reviewed head', async () => {
    const f = await makeFixture('server');
    const NOW = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'in_progress',
      signalToken: 'orig-token', reviewRound: 0,
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW,
    }));
    let capturedOpts: { armBeforeInject?: (ctx: DispatchArmContext) => Promise<boolean> } | undefined;
    vi.spyOn(f.manager, 'startSession').mockImplementation(async (_t, _a, _p, opts) => {
      capturedOpts = opts as { armBeforeInject?: (ctx: DispatchArmContext) => Promise<boolean> };
      await capturedOpts.armBeforeInject?.({ serverReviewCheckout: 'head' });
      return true;
    });

    await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', content: 'diff text', reviewHeadAnchorSha: 'head123', headTree: 'tree123',
    });

    expect(f.watcher.start).toHaveBeenCalledWith(expect.not.objectContaining({
      onReadFile: expect.any(Function),
    }));
    expect(f.watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      expectedKinds: 'code-reviewed',
      skipSnapshot: false,
    }));
  });

  it('arms read-file for a base-mode review checkout', async () => {
    const f = await makeFixture('server');
    const NOW = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'in_progress',
      signalToken: 'orig-token', reviewRound: 0,
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW,
    }));
    let capturedOpts: { armBeforeInject?: (ctx: DispatchArmContext) => Promise<boolean> } | undefined;
    vi.spyOn(f.manager, 'startSession').mockImplementation(async (_t, _a, _p, opts) => {
      capturedOpts = opts as { armBeforeInject?: (ctx: DispatchArmContext) => Promise<boolean> };
      await capturedOpts.armBeforeInject?.({ serverReviewCheckout: 'base' });
      return true;
    });

    await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', content: 'diff text', reviewHeadAnchorSha: 'head123', headTree: 'tree123',
    });

    expect(f.watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      expectedKinds: 'code-reviewed',
      onReadFile: expect.any(Function),
      skipSnapshot: false,
    }));
  });

  it.each(['base', 'head'] as const)(
    'persists reviewCheckoutMode=%s from the materialized checkout so recovery can re-arm read-file',
    async (mode) => {
      const f = await makeFixture('server');
      const NOW = new Date().toISOString();
      await f.taskStore.set(taskFixture({
        reviewMode: 'server', phase: 'code', status: 'in_progress',
        signalToken: 'orig-token', reviewRound: 0,
      }));
      await f.agentStore.update('dev-1', () => ({
        id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW,
      }));
      vi.spyOn(f.manager, 'startSession').mockImplementation(async (_t, _a, _p, opts) => {
        await (opts as { armBeforeInject?: (ctx: DispatchArmContext) => Promise<boolean> })
          .armBeforeInject?.({ serverReviewCheckout: mode });
        return true;
      });

      await f.manager.dispatchServerReviewToQa('task-1', {
        phase: 'code', content: 'diff text', reviewHeadAnchorSha: 'head123', headTree: 'tree123',
      });

      const task = await f.taskStore.get('task-1');
      expect(task?.reviewCheckoutMode).toBe(mode);
    },
  );

  it('emits an intervention when checkout-mode persistence fails after prompt delivery', async () => {
    const f = await makeFixture('server');
    const now = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'in_progress',
      signalToken: 'orig-token', reviewRound: 0,
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: now,
    }));
    vi.spyOn(f.manager, 'startSession').mockImplementation(async (_t, _a, _p, opts) => {
      await (opts as { armBeforeInject?: (ctx: DispatchArmContext) => Promise<boolean> })
        .armBeforeInject?.({ serverReviewCheckout: 'head' });
      return true;
    });
    vi.spyOn(f.manager, 'updateTaskIfStatus').mockRejectedValueOnce(new Error('state disk full'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', content: 'diff text', reviewHeadAnchorSha: 'head123', headTree: 'tree123',
    })).resolves.not.toBeNull();

    expect(f.events.some(event => event.type === 'human.intervention'
      && event.data?.phase === 'review-checkout-mode-persist-failed')).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to persist review checkout mode'),
    );
  });
});

describe('dispatchServerReviewToQa rollback restores originalPhase', () => {
  it('first spec dispatch failure restores the explicit spec phase', async () => {
    const f = await makeFixture('git');
    const NOW = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'git', phase: 'spec', status: 'in_progress',
      signalToken: 'orig-token', specReviewRound: 0,
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW,
    }));
    await f.manager.dispatchServerReviewToQa('task-1', { phase: 'spec', content: 'spec text' })
      .catch(() => undefined);
    const after = await f.taskStore.get('task-1');
    expect(after?.status).toBe('in_progress');
    expect(after?.phase).toBe('spec');
    expect(after?.signalToken).toBe('orig-token');
    expect(after?.specReviewRound).toBe(0);
  });
});

function interventionPhases(events: BaxianEvent[]): string[] {
  return events
    .filter(e => e.type === 'human.intervention')
    .map(e => (e.data as { phase?: string }).phase ?? '');
}

describe('dispatchServerReviewToQa failure & success paths', () => {
  it('no QA partner while fixing re-arms the *-fixed entry signal', async () => {
    const f = await makeFixture('git', { omitQa: true });
    await f.taskStore.set(taskFixture({
      reviewMode: 'git', phase: 'spec', status: 'fixing',
      qaAgentId: undefined, signalToken: 't', specReviewRound: 1,
    }));

    const result = await f.manager.dispatchServerReviewToQa('task-1', { phase: 'spec', content: 'spec' });

    expect(result).toBeNull();
    expect(interventionPhases(f.events)).toContain('server-review-no-qa-partner');
    expect(f.watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'dev-1', expectedKinds: 'spec-fixed', skipSnapshot: true,
    }));
  });

  it('does not replace the task QA when its snapshotted participant is unavailable', async () => {
    const f = await makeFixture('server');
    const NOW = new Date().toISOString();
    await f.taskStore.set(taskFixture({ reviewMode: 'server', phase: 'code', status: 'in_progress', signalToken: 't', qaAgentId: 'ghost' }));
    await f.agentStore.update('dev-1', () => ({ id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW }));
    const startSpy = vi.spyOn(f.manager, 'startSession').mockResolvedValue(true);

    const result = await f.manager.dispatchServerReviewToQa('task-1', { phase: 'code', content: 'diff' });

    expect(result).toBeNull();
    expect((await f.taskStore.get('task-1'))?.qaAgentId).toBe('ghost');
    expect((await f.agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(interventionPhases(f.events)).toContain('server-review-qa-unavailable');
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('releases a QA still bound to the same task before re-acquiring (manual redispatch from review)', async () => {
    const f = await makeFixture('server');
    const NOW = new Date().toISOString();
    const task = taskFixture({
      reviewMode: 'server', phase: 'code', status: 'review', signalToken: 't', reviewRound: 1,
    });
    const expectedTask = {
      status: task.status,
      phase: task.phase,
      signalToken: task.signalToken,
      agentId: task.agentId,
      reviewRound: task.reviewRound,
      specReviewRound: task.specReviewRound,
    };
    await f.taskStore.set(task);
    await f.agentStore.update('qa-1', () => ({ id: 'qa-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW }));
    await f.agentStore.update('dev-1', () => ({ id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW }));
    const releaseSpy = vi.spyOn(f.manager, 'releaseAgentForTask');
    vi.spyOn(f.manager, 'startSession').mockResolvedValue(true);

    const result = await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', content: 'diff', recheck: true, expectedTask,
    });

    expect(releaseSpy).toHaveBeenCalledWith(
      'qa-1',
      'task-1',
      'idle',
      expect.objectContaining({
        expectedTask,
        expectedLockToken: expect.any(String),
      }),
    );
    expect(result?.status).toBe('review');
    expect(result?.reviewRound).toBe(2);
    expect((await f.agentStore.get('qa-1'))?.taskId).toBe('task-1');
  });

  it('releases a recoverable held QA before a server review redispatch', async () => {
    const f = await makeFixture('server');
    const now = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'review', signalToken: 't', reviewRound: 1,
    }));
    await f.agentStore.update('qa-1', () => ({
      id: 'qa-1', projectId: 'proj', taskId: 'task-1', updatedAt: now,
      status: 'awaiting_human', awaitingPhase: 'dirty-workdir',
      awaitingReason: 'checkout is dirty', awaitingSince: now, awaitingNonce: 'held-generation',
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: now,
    }));
    const releaseSpy = vi.spyOn(f.manager, 'releaseAgentForTask');
    vi.spyOn(f.manager, 'startSession').mockResolvedValue(true);

    const result = await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', content: 'persisted diff',
    });

    expect(releaseSpy).toHaveBeenCalledWith(
      'qa-1',
      'task-1',
      'idle',
      expect.objectContaining({
        allowAwaitingHuman: true,
        expectedHold: { phase: 'dirty-workdir', since: now, nonce: 'held-generation' },
      }),
    );
    expect(result).toMatchObject({ status: 'review', reviewRound: 1 });
    expect((await f.agentStore.get('qa-1'))?.taskId).toBe('task-1');
  });

  it('preserves a non-recoverable held QA during a server review redispatch', async () => {
    const f = await makeFixture('server');
    const now = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'review', signalToken: 't', reviewRound: 1,
    }));
    await f.agentStore.update('qa-1', () => ({
      id: 'qa-1', projectId: 'proj', taskId: 'task-1', updatedAt: now,
      status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown',
      awaitingReason: 'delivery may have happened', awaitingSince: now, awaitingNonce: 'uncertain-generation',
    }));
    const releaseSpy = vi.spyOn(f.manager, 'releaseAgentForTask');

    await expect(f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', content: 'persisted diff', bumpRound: false,
    })).rejects.toMatchObject({
      status: 409,
      code: 'dispatch-unsupported',
      message: expect.stringContaining('dispatch-failed:ack_unknown'),
    });

    expect(releaseSpy).not.toHaveBeenCalled();
    expect(await f.agentStore.get('qa-1')).toMatchObject({
      taskId: 'task-1', status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown',
      awaitingNonce: 'uncertain-generation',
    });
  });

  it('honors an explicit round bump while resuming a recoverable held QA', async () => {
    const f = await makeFixture('server');
    const now = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'review', signalToken: 't', reviewRound: 1,
    }));
    await f.agentStore.update('qa-1', () => ({
      id: 'qa-1', projectId: 'proj', taskId: 'task-1', updatedAt: now,
      status: 'awaiting_human', awaitingPhase: 'dirty-workdir',
      awaitingReason: 'checkout is dirty', awaitingSince: now, awaitingNonce: 'held-generation',
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: now,
    }));
    vi.spyOn(f.manager, 'startSession').mockResolvedValue(true);

    const result = await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', content: 'persisted diff', bumpRound: true,
    });

    expect(result).toMatchObject({ status: 'review', reviewRound: 2 });
  });

  it('reports a side effect after releasing the prior QA even when re-acquisition fails', async () => {
    const f = await makeFixture('server');
    const now = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'review', signalToken: 't', reviewRound: 1,
    }));
    await f.agentStore.update('qa-1', () => ({
      id: 'qa-1', projectId: 'proj', taskId: 'task-1', updatedAt: now,
    }));
    const onSideEffect = vi.fn();
    vi.spyOn(f.manager, 'acquireAgentForTask').mockResolvedValue(false);

    const result = await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', content: 'persisted diff', bumpRound: false, onSideEffect,
    });

    expect(result).toBeNull();
    expect(onSideEffect).toHaveBeenCalledOnce();
    expect((await f.agentStore.get('qa-1'))?.taskId).toBeUndefined();
  });

  it('restarts a failed spec dispatch while preserving the current round', async () => {
    const f = await makeFixture('git');
    const now = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'git', phase: 'spec', status: 'review',
      signalToken: 't', specReviewRound: 10,
    }));
    await f.agentStore.update('qa-1', () => ({
      id: 'qa-1', projectId: 'proj', taskId: 'task-1', updatedAt: now,
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: now,
    }));
    vi.spyOn(f.manager, 'startSession').mockResolvedValue(true);

    const result = await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'spec',
      content: 'persisted cap spec',
      bumpRound: false,
    });

    expect(result).toMatchObject({ status: 'review', specReviewRound: 10 });
  });

  it('refuses to redispatch when there is no current review round', async () => {
    const f = await makeFixture('git');
    await f.taskStore.set(taskFixture({
      reviewMode: 'git', phase: 'spec', status: 'review',
      signalToken: 't', specReviewRound: 0,
    }));

    await expect(f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'spec',
      content: 'missing persisted spec',
      bumpRound: false,
    })).rejects.toThrow('no current spec review round to redispatch');
  });

  it('a failed redispatch from review does not re-arm the dev entry signal (long consumed)', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({ reviewMode: 'server', phase: 'code', status: 'review', signalToken: 't', reviewRound: 1 }));
    await f.agentStore.update('qa-1', () => ({
      id: 'qa-1', projectId: 'proj', taskId: 'someone-else', updatedAt: new Date().toISOString(),
    }));

    const result = await f.manager.dispatchServerReviewToQa('task-1', { phase: 'code', content: 'diff', recheck: true });

    expect(result).toBeNull();
    expect(interventionPhases(f.events)).toContain('server-review-qa-acquire-failed');
    expect(f.watcher.start).not.toHaveBeenCalled();
  });

  it('QA acquire failure re-arms code-fixed and emits qa-acquire-failed', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'fixing', signalToken: 't',
    }));
    await f.agentStore.update('qa-1', () => ({
      id: 'qa-1', projectId: 'proj', taskId: 'someone-else', updatedAt: new Date().toISOString(),
    }));

    const result = await f.manager.dispatchServerReviewToQa('task-1', { phase: 'code', content: 'diff' });

    expect(result).toBeNull();
    expect(interventionPhases(f.events)).toContain('server-review-qa-acquire-failed');
    expect(f.watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'dev-1', expectedKinds: 'code-fixed',
    }));
    expect((await f.taskStore.get('task-1'))?.status).toBe('fixing');
  });

  it('leaves a consumed review-dispatch failure to the handler without same-token re-arm or duplicate alert', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'fixing', signalToken: 't',
    }));
    await f.agentStore.update('qa-1', () => ({
      id: 'qa-1', projectId: 'proj', taskId: 'someone-else', updatedAt: new Date().toISOString(),
    }));

    const result = await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code',
      content: 'diff',
      callerOwnsConsumedSignalFailure: true,
    });

    expect(result).toBeNull();
    expect(f.watcher.start).not.toHaveBeenCalled();
    expect(interventionPhases(f.events)).not.toContain('server-review-qa-acquire-failed');
  });

  it('dev park failure releases the QA, re-arms code-done and emits dev-park-failed', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'in_progress', signalToken: 't',
    }));

    const result = await f.manager.dispatchServerReviewToQa('task-1', { phase: 'code', content: 'diff' });

    expect(result).toBeNull();
    expect(interventionPhases(f.events)).toContain('server-review-dev-park-failed');
    expect((await f.agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(f.watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'dev-1', expectedKinds: 'code-done',
    }));
  });

  it('a lost review transition releases the QA and emits transition-failed', async () => {
    const f = await makeFixture('server');
    const NOW = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'in_progress', signalToken: 't',
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW,
    }));
    vi.spyOn(f.manager, 'transitionTaskStatus').mockResolvedValue(undefined);

    const result = await f.manager.dispatchServerReviewToQa('task-1', { phase: 'code', content: 'diff' });

    expect(result).toBeNull();
    expect(interventionPhases(f.events)).toContain('server-review-transition-failed');
    expect((await f.agentStore.get('qa-1'))?.taskId).toBeUndefined();
  });

  it('fresh dispatch fences the complete missing-value entry tuple before installing review', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', status: 'in_progress', phase: undefined, signalToken: undefined,
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: new Date().toISOString(),
    }));
    const realTransition = f.manager.transitionTaskStatus.bind(f.manager);
    let capturedGuard: Record<string, unknown> | undefined;
    vi.spyOn(f.manager, 'transitionTaskStatus').mockImplementation(async (id, status, guard, patch) => {
      if (status === 'review') {
        capturedGuard = guard;
        const current = await f.taskStore.get(id);
        await f.taskStore.set({
          ...current!, phase: 'code', signalToken: 'successor-pass', updatedAt: new Date().toISOString(),
        });
      }
      return realTransition(id, status, guard, patch);
    });
    const startSpy = vi.spyOn(f.manager, 'startSession').mockResolvedValue(true);

    const result = await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', content: 'diff',
    });

    expect(result).toBeNull();
    expect(Object.hasOwn(capturedGuard ?? {}, 'expectPhase')).toBe(true);
    expect(Object.hasOwn(capturedGuard ?? {}, 'expectSignalToken')).toBe(true);
    expect(capturedGuard).toMatchObject({ fromStatus: ['in_progress'] });
    expect(await f.taskStore.get('task-1')).toMatchObject({
      status: 'in_progress', phase: 'code', signalToken: 'successor-pass',
    });
    expect((await f.agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(f.watcher.start).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('continuation fences the complete missing-value entry tuple before rebuilding review', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', status: 'review', phase: undefined, signalToken: undefined, reviewRound: 1,
    }));
    await f.agentStore.update('qa-1', () => ({
      id: 'qa-1', projectId: 'proj', taskId: 'task-1', updatedAt: new Date().toISOString(),
    }));
    const realTransition = f.manager.transitionTaskStatus.bind(f.manager);
    let capturedGuard: Record<string, unknown> | undefined;
    vi.spyOn(f.manager, 'transitionTaskStatus').mockImplementation(async (id, status, guard, patch) => {
      if (status === 'review') {
        capturedGuard = guard;
        const current = await f.taskStore.get(id);
        await f.taskStore.set({
          ...current!, phase: 'code', signalToken: 'continuation-successor', updatedAt: new Date().toISOString(),
        });
      }
      return realTransition(id, status, guard, patch);
    });
    const continueSpy = vi.spyOn(f.manager, 'continueSession').mockResolvedValue(true);

    const result = await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', content: 'next batch', continuation: true,
    });

    expect(result).toBeNull();
    expect(Object.hasOwn(capturedGuard ?? {}, 'expectPhase')).toBe(true);
    expect(Object.hasOwn(capturedGuard ?? {}, 'expectSignalToken')).toBe(true);
    expect(capturedGuard).toMatchObject({ fromStatus: ['review'] });
    expect(await f.taskStore.get('task-1')).toMatchObject({
      status: 'review', phase: 'code', signalToken: 'continuation-successor',
    });
    expect((await f.agentStore.get('qa-1'))?.taskId).toBe('task-1');
    expect(f.watcher.start).not.toHaveBeenCalled();
    expect(continueSpy).not.toHaveBeenCalled();
  });

  it('reports the continuation pass transition as a side effect before session continuation', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', status: 'review', phase: 'code', signalToken: 'entry-pass', reviewRound: 1,
    }));
    await f.agentStore.update('qa-1', () => ({
      id: 'qa-1', projectId: 'proj', taskId: 'task-1', updatedAt: new Date().toISOString(),
    }));
    const order: string[] = [];
    const onSideEffect = vi.fn(() => { order.push('side-effect'); });
    const continueSpy = vi.spyOn(f.manager, 'continueSession').mockImplementation(async () => {
      order.push('continue');
      return true;
    });

    const result = await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', content: 'next batch', continuation: true, onSideEffect,
    });

    expect(result?.status).toBe('review');
    expect(onSideEffect).toHaveBeenCalledOnce();
    expect(continueSpy).toHaveBeenCalledOnce();
    expect(order).toEqual(['side-effect', 'continue']);
  });

  it('reports the installed continuation pass before a failed session continuation', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', status: 'review', phase: 'code', signalToken: 'entry-pass', reviewRound: 1,
    }));
    await f.agentStore.update('qa-1', () => ({
      id: 'qa-1', projectId: 'proj', taskId: 'task-1', updatedAt: new Date().toISOString(),
    }));
    const order: string[] = [];
    const onSideEffect = vi.fn(() => { order.push('side-effect'); });
    vi.spyOn(f.manager, 'continueSession').mockImplementation(async () => {
      order.push('continue');
      throw new Error('continuation failed');
    });

    await expect(f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', content: 'next batch', continuation: true, onSideEffect,
    })).rejects.toThrow('continuation failed');

    expect(onSideEffect).toHaveBeenCalledOnce();
    expect(order).toEqual(['side-effect', 'continue']);
  });

  it('passes the installed review token to the final fresh-session paste fence', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server',
      status: 'in_progress',
      phase: 'code',
      signalToken: 'entry-pass',
      reviewRound: 0,
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1',
      projectId: 'proj',
      taskId: 'task-1',
      updatedAt: new Date().toISOString(),
    }));
    vi.spyOn(f.manager, 'startSession').mockImplementation(async (_taskId, _agentId, _phase, opts) => {
      const installed = await f.taskStore.get('task-1');
      expect(opts.dispatchPassToken).toBe(installed?.signalToken);
      await f.taskStore.set({
        ...installed!,
        signalToken: 'successor-review-pass',
        reviewRound: 2,
        updatedAt: new Date().toISOString(),
      });
      expect(await opts.armBeforeInject?.({ serverReviewCheckout: 'base' })).toBe(false);
      return false;
    });

    const result = await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code',
      content: 'stale diff',
    });

    expect(result).toBeNull();
    expect(await f.taskStore.get('task-1')).toMatchObject({
      status: 'review',
      signalToken: 'successor-review-pass',
      reviewRound: 2,
    });
    expect(await f.agentStore.get('qa-1')).toMatchObject({ taskId: 'task-1' });
    expect(f.watcher.start).not.toHaveBeenCalled();
    expect(f.events.some(event =>
      event.type === 'human.intervention'
      && event.data?.phase === 'server-review-start-failed',
    )).toBe(false);
  });

  it('stops an armed continuation before paste when the review generation advances', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server',
      status: 'review',
      phase: 'code',
      signalToken: 'entry-pass',
      reviewRound: 1,
    }));
    await f.agentStore.update('qa-1', () => ({
      id: 'qa-1',
      projectId: 'proj',
      taskId: 'task-1',
      updatedAt: new Date().toISOString(),
    }));
    let installedToken: string | undefined;
    vi.spyOn(f.manager, 'continueSession').mockImplementation(async (_taskId, _agentId, _phase, opts) => {
      const installed = await f.taskStore.get('task-1');
      installedToken = installed?.signalToken;
      expect(await opts.armBeforeInject?.({})).toBe(true);
      await f.taskStore.set({
        ...installed!,
        signalToken: 'successor-continuation',
        reviewRound: 3,
        updatedAt: new Date().toISOString(),
      });
      expect(await opts.guardBeforeInject?.()).toBe(false);
      return false;
    });

    const result = await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code',
      content: 'stale continuation',
      continuation: true,
      callerOwnsConsumedSignalFailure: true,
    });

    expect(result).toBeNull();
    expect(await f.taskStore.get('task-1')).toMatchObject({
      status: 'review',
      signalToken: 'successor-continuation',
      reviewRound: 3,
    });
    expect(f.watcher.stopAgentIfToken).toHaveBeenCalledWith(
      'task-1',
      'qa-1',
      installedToken,
    );
  });

  it('failed server dispatch cannot roll an installed pass over a review successor', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', status: 'in_progress', phase: undefined, signalToken: undefined,
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: new Date().toISOString(),
    }));
    vi.spyOn(f.manager, 'startSession').mockImplementation(async () => {
      const installed = await f.taskStore.get('task-1');
      expect(installed?.status).toBe('review');
      await f.taskStore.set({
        ...installed!, phase: 'code', signalToken: 'later-review-pass', reviewRound: 7,
        updatedAt: new Date().toISOString(),
      });
      return false;
    });

    const result = await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', content: 'diff',
    });

    expect(result).toBeNull();
    expect(await f.taskStore.get('task-1')).toMatchObject({
      status: 'review', phase: 'code', signalToken: 'later-review-pass', reviewRound: 7,
    });
    expect(f.watcher.start).not.toHaveBeenCalled();
  });

  it('session cleanup uses the fresh QA acquire generation and preserves a successor rebind', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', status: 'in_progress', phase: 'code', signalToken: 'entry-pass',
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: new Date().toISOString(),
    }));
    let successorLockToken: string | undefined;
    vi.spyOn(f.manager, 'startSession').mockImplementation(async () => {
      const acquired = await f.agentStore.get('qa-1');
      expect(acquired?.lockToken).toEqual(expect.any(String));
      expect(await f.lockManager.releaseIfOwner('qa-1', 'task-1', acquired!.lockToken!)).toBe(true);
      await f.agentStore.update('qa-1', existing => existing && ({
        id: existing.id, projectId: existing.projectId, updatedAt: new Date().toISOString(),
      }));
      expect(await f.manager.acquireAgentForTask('qa-1', 'task-1', 'review', {
        onAcquired: token => { successorLockToken = token; },
      })).toBe(true);
      return false;
    });

    const result = await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', content: 'diff',
    });

    expect(result).toBeNull();
    expect(successorLockToken).toEqual(expect.any(String));
    expect(await f.agentStore.get('qa-1')).toMatchObject({
      taskId: 'task-1', lockToken: successorLockToken,
    });
    expect(await f.lockManager.isOwner('qa-1', 'task-1', successorLockToken!)).toBe(true);
  });

  it('manual redispatch pre-release is fenced to the snapshotted QA generation', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', status: 'review', phase: 'code', signalToken: 'entry-pass', reviewRound: 1,
    }));
    await f.agentStore.update('qa-1', () => ({
      id: 'qa-1', projectId: 'proj', taskId: 'task-1', updatedAt: new Date().toISOString(),
    }));
    const entryLockToken = (await f.agentStore.get('qa-1'))!.lockToken!;
    const realRelease = f.manager.releaseAgentForTask.bind(f.manager);
    let successorLockToken: string | undefined;
    vi.spyOn(f.manager, 'releaseAgentForTask').mockImplementationOnce(async (agentId, taskId, mode, opts) => {
      expect(opts).toMatchObject({ expectedLockToken: entryLockToken });
      expect(await f.lockManager.releaseIfOwner(agentId, taskId, entryLockToken)).toBe(true);
      await f.agentStore.update(agentId, existing => existing && ({
        id: existing.id, projectId: existing.projectId, updatedAt: new Date().toISOString(),
      }));
      expect(await f.manager.acquireAgentForTask(agentId, taskId, 'review', {
        onAcquired: token => { successorLockToken = token; },
      })).toBe(true);
      return realRelease(agentId, taskId, mode, opts);
    });
    const startSpy = vi.spyOn(f.manager, 'startSession').mockResolvedValue(true);

    const result = await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', content: 'diff', recheck: true,
    });

    expect(result).toBeNull();
    expect(successorLockToken).not.toBe(entryLockToken);
    expect(await f.agentStore.get('qa-1')).toMatchObject({
      taskId: 'task-1', lockToken: successorLockToken,
    });
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('preserves the successor task QA when its generation advances before redispatch release', async () => {
    const f = await makeFixture('server');
    const original = taskFixture({
      reviewMode: 'server', status: 'review', phase: 'code',
      signalToken: 'entry-pass', reviewRound: 1,
    });
    const expectedTask = {
      status: original.status,
      phase: original.phase,
      signalToken: original.signalToken,
      agentId: original.agentId,
      reviewRound: original.reviewRound,
      specReviewRound: original.specReviewRound,
    };
    await f.taskStore.set(original);
    await f.agentStore.update('qa-1', () => ({
      id: 'qa-1', projectId: 'proj', taskId: 'task-1', updatedAt: new Date().toISOString(),
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: new Date().toISOString(),
    }));
    const qaLockToken = (await f.agentStore.get('qa-1'))!.lockToken!;
    const realRelease = f.manager.releaseAgentForTask.bind(f.manager);
    let advanced = false;
    vi.spyOn(f.manager, 'releaseAgentForTask').mockImplementation(async (...args) => {
      if (!advanced && args[0] === 'qa-1') {
        advanced = true;
        await f.taskStore.set({
          ...original,
          signalToken: 'successor-pass',
          reviewRound: 2,
          updatedAt: new Date().toISOString(),
        });
      }
      return realRelease(...args);
    });
    const startSpy = vi.spyOn(f.manager, 'startSession').mockResolvedValue(true);

    const result = await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code',
      content: 'stale redispatch',
      recheck: true,
      callerOwnsConsumedSignalFailure: true,
      expectedTask,
    });

    expect(result).toBeNull();
    expect(advanced).toBe(true);
    expect(await f.taskStore.get('task-1')).toMatchObject({
      signalToken: 'successor-pass',
      reviewRound: 2,
    });
    expect(await f.agentStore.get('qa-1')).toMatchObject({
      taskId: 'task-1',
      lockToken: qaLockToken,
    });
    expect(await f.lockManager.isOwner('qa-1', 'task-1', qaLockToken)).toBe(true);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('does not park the successor Dev after the review dispatch claim becomes stale', async () => {
    const f = await makeFixture('server');
    const original = taskFixture({
      reviewMode: 'server', status: 'in_progress', phase: 'code',
      signalToken: 'entry-pass', reviewRound: 1,
    });
    const expectedTask = {
      status: original.status,
      phase: original.phase,
      signalToken: original.signalToken,
      agentId: original.agentId,
      reviewRound: original.reviewRound,
      specReviewRound: original.specReviewRound,
    };
    await f.taskStore.set(original);
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1',
      projectId: 'proj',
      taskId: 'task-1',
      needInput: { epoch: 1 },
      updatedAt: new Date().toISOString(),
    }));
    const realAcquire = f.manager.acquireAgentForTask.bind(f.manager);
    let advanced = false;
    vi.spyOn(f.manager, 'acquireAgentForTask').mockImplementation(async (...args) => {
      const acquired = await realAcquire(...args);
      if (acquired && !advanced && args[0] === 'qa-1') {
        advanced = true;
        await f.taskStore.set({
          ...original,
          signalToken: 'successor-pass',
          reviewRound: 2,
          updatedAt: new Date().toISOString(),
        });
        await f.agentStore.update('dev-1', existing => existing && ({
          ...existing,
          needInput: { epoch: 41 },
          updatedAt: new Date().toISOString(),
        }));
      }
      return acquired;
    });
    const startSpy = vi.spyOn(f.manager, 'startSession').mockResolvedValue(true);

    const result = await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code',
      content: 'stale dispatch',
      callerOwnsConsumedSignalFailure: true,
      expectedTask,
    });

    expect(result).toBeNull();
    expect(advanced).toBe(true);
    expect((await f.agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 41 });
    expect((await f.agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('a DispatchTerminalError from the QA session fails the task via failTaskForDispatchError', async () => {
    const f = await makeFixture('server');
    const NOW = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'in_progress', signalToken: 't',
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW,
    }));
    vi.spyOn(f.manager, 'startSession').mockRejectedValue(
      new DispatchTerminalError('prompt_too_large', 'diff too big'),
    );
    const failSpy = vi.spyOn(f.manager, 'failTaskForDispatchError').mockResolvedValue();

    await expect(
      f.manager.dispatchServerReviewToQa('task-1', { phase: 'code', content: 'diff' }),
    ).rejects.toMatchObject({ reason: 'prompt_too_large' });

    expect(failSpy).toHaveBeenCalledWith(
      'task-1',
      'server-review',
      'qa-1',
      expect.anything(),
      expect.objectContaining({
        expectedLockToken: expect.any(String),
        expectedTask: expect.objectContaining({
          status: 'review',
          phase: 'code',
          signalToken: expect.any(String),
        }),
      }),
    );
    expect(f.watcher.stopAgentIfToken).toHaveBeenCalledWith(
      'task-1',
      'qa-1',
      expect.any(String),
    );
  });

  it('terminal server dispatch cleanup preserves a successor QA lock generation', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'in_progress', signalToken: 'entry-pass',
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: new Date().toISOString(),
    }));
    let successorLockToken: string | undefined;
    vi.spyOn(f.manager, 'startSession').mockImplementation(async () => {
      const acquired = await f.agentStore.get('qa-1');
      expect(await f.lockManager.releaseIfOwner('qa-1', 'task-1', acquired!.lockToken!)).toBe(true);
      await f.agentStore.update('qa-1', existing => existing && ({
        id: existing.id, projectId: existing.projectId, updatedAt: new Date().toISOString(),
      }));
      expect(await f.manager.acquireAgentForTask('qa-1', 'task-1', 'review', {
        onAcquired: token => { successorLockToken = token; },
      })).toBe(true);
      throw new DispatchTerminalError('prompt_too_large', 'diff too big');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', content: 'diff',
    })).rejects.toMatchObject({ reason: 'prompt_too_large' });

    expect((await f.taskStore.get('task-1'))?.status).toBe('review');
    expect(await f.agentStore.get('qa-1')).toMatchObject({
      taskId: 'task-1', lockToken: successorLockToken,
    });
    expect(await f.lockManager.isOwner('qa-1', 'task-1', successorLockToken!)).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(
      'dispatch generation for task-1 was superseded',
    ));
    expect(f.events.some(event =>
      event.type === 'human.intervention'
      && String(event.data?.phase).startsWith('dispatch-failed:'),
    )).toBe(false);
  });

  it('a delivered QA session leaves the task in review with the bumped round', async () => {
    const f = await makeFixture('server');
    const NOW = new Date().toISOString();
    const task = taskFixture({
      reviewMode: 'server', phase: 'code', status: 'in_progress', signalToken: 't', reviewRound: 1,
    });
    const expectedTask = {
      status: task.status,
      phase: task.phase,
      signalToken: task.signalToken,
      agentId: task.agentId,
      reviewRound: task.reviewRound,
      specReviewRound: task.specReviewRound,
    };
    await f.taskStore.set(task);
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW,
    }));
    const parkSpy = vi.spyOn(f.manager, 'markAgentWaiting');
    vi.spyOn(f.manager, 'startSession').mockResolvedValue(true);

    const result = await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', content: 'diff', expectedTask,
    });

    expect(result).toMatchObject({ status: 'review', reviewRound: 2, qaAgentId: 'qa-1' });
    expect(parkSpy).toHaveBeenCalledWith('dev-1', 'task-1', { expectedTask });
  });

  it('threads the recheck interdiff payload into startSession as serverInterdiff', async () => {
    const f = await makeFixture('server');
    const NOW = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'in_progress', signalToken: 't', reviewRound: 1,
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW,
    }));
    let captured: Record<string, unknown> | undefined;
    vi.spyOn(f.manager, 'startSession').mockImplementation(async (_t, _a, _p, opts) => {
      captured = opts as Record<string, unknown>;
      return true;
    });

    await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', content: 'full diff', recheck: true, interdiff: 'round-2 delta',
    });

    expect(captured?.serverContent).toBe('full diff');
    expect(captured?.serverInterdiff).toBe('round-2 delta');
  });

  it('threads captured review head metadata into startSession for QA worktree materialization', async () => {
    const f = await makeFixture('server');
    const NOW = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'in_progress', signalToken: 't', reviewRound: 0,
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW,
    }));
    let captured: Record<string, unknown> | undefined;
    vi.spyOn(f.manager, 'startSession').mockImplementation(async (_t, _a, _p, opts) => {
      captured = opts as Record<string, unknown>;
      return true;
    });

    await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code',
      content: 'full diff',
      diffstat: 'stat',
      baseSha: 'base123',
      reviewHeadAnchorSha: 'head123',
      headTree: 'tree123',
    });

    expect(captured?.serverContent).toBe('full diff');
    expect(captured?.serverDiffstat).toBe('stat');
    expect(captured?.serverBaseSha).toBe('base123');
    expect(captured?.serverHeadSha).toBe('head123');
    expect(captured?.serverHeadTree).toBe('tree123');
  });
});

describe('dispatchServerFixToDev failure & success paths', () => {
  it('rejects a fix dispatch after the reviewed task generation changes', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'review', signalToken: 'current-token',
    }));

    await expect(f.manager.dispatchServerFixToDev('task-1', '[]', {
      expectedTask: {
        status: 'review',
        phase: 'code',
        signalToken: 'superseded-token',
        agentId: 'dev-1',
        reviewRound: 0,
        specReviewRound: undefined,
      },
    })).rejects.toMatchObject({
      status: 409,
      code: 'dispatch-superseded',
    });

    expect((await f.taskStore.get('task-1'))?.status).toBe('review');
    expect((await f.agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('does not overwrite a signal token that rotates after the fix-dispatch claim', async () => {
    const f = await makeFixture('server', { omitQa: true });
    await f.taskStore.set(taskFixture({
      reviewMode: 'server',
      phase: 'code',
      status: 'review',
      signalToken: 'review-token',
      qaAgentId: undefined,
    }));
    const acquire = f.manager.acquireAgentForTask.bind(f.manager);
    vi.spyOn(f.manager, 'acquireAgentForTask').mockImplementation(async (...args) => {
      const acquired = await acquire(...args);
      if (acquired && args[0] === 'dev-1') {
        const current = await f.taskStore.get('task-1');
        await f.taskStore.set({
          ...current!,
          signalToken: 'concurrent-token',
          updatedAt: new Date().toISOString(),
        });
      }
      return acquired;
    });
    const continueSession = vi.spyOn(f.manager, 'continueSession');

    const result = await f.manager.dispatchServerFixToDev('task-1', '[]');

    expect(result).toBeNull();
    expect(await f.taskStore.get('task-1')).toMatchObject({
      status: 'review',
      signalToken: 'concurrent-token',
    });
    expect(continueSession).not.toHaveBeenCalled();
  });

  it('does not enter fixing after the Dev lock is reacquired by a successor', async () => {
    const f = await makeFixture('server', { omitQa: true });
    await f.taskStore.set(taskFixture({
      reviewMode: 'server',
      phase: 'code',
      status: 'review',
      signalToken: 'review-token',
      qaAgentId: undefined,
    }));
    const acquire = f.manager.acquireAgentForTask.bind(f.manager);
    let successorLockToken: string | undefined;
    let swapped = false;
    vi.spyOn(f.manager, 'acquireAgentForTask').mockImplementation(async (...args) => {
      const acquired = await acquire(...args);
      if (acquired && args[0] === 'dev-1' && !swapped) {
        swapped = true;
        const stale = await f.agentStore.get('dev-1');
        expect(await f.lockManager.releaseIfOwner(
          'dev-1',
          'task-1',
          stale!.lockToken!,
        )).toBe(true);
        await f.agentStore.update('dev-1', existing => existing && ({
          id: existing.id,
          projectId: existing.projectId,
          updatedAt: new Date().toISOString(),
        }));
        expect(await acquire('dev-1', 'task-1', 'server-feedback', {
          onAcquired: token => { successorLockToken = token; },
        })).toBe(true);
      }
      return acquired;
    });
    const continueSession = vi.spyOn(f.manager, 'continueSession');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await f.manager.dispatchServerFixToDev('task-1', '[]', {
      callerOwnsConsumedSignalFailure: true,
    });

    expect(result).toBeNull();
    expect(await f.taskStore.get('task-1')).toMatchObject({
      status: 'review',
      signalToken: 'review-token',
    });
    expect(await f.agentStore.get('dev-1')).toMatchObject({
      taskId: 'task-1',
      lockToken: successorLockToken,
    });
    expect(await f.lockManager.isOwner('dev-1', 'task-1', successorLockToken!)).toBe(true);
    expect(continueSession).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(
      'releasing freshly acquired dev dev-1 for task-1 was refused',
    ));
  });

  it('keeps a same-task successor binding when it reuses the freshly acquired Dev lock', async () => {
    const f = await makeFixture('server');
    const original = taskFixture({
      reviewMode: 'server',
      phase: 'code',
      status: 'review',
      signalToken: 'review-token',
    });
    await f.taskStore.set(original);
    await f.agentStore.update('qa-1', () => ({
      id: 'qa-1',
      projectId: 'proj',
      taskId: 'task-1',
      updatedAt: original.updatedAt,
    }));
    const acquire = f.manager.acquireAgentForTask.bind(f.manager);
    let originalLockToken: string | undefined;
    let successorLockToken: string | undefined;
    vi.spyOn(f.manager, 'acquireAgentForTask').mockImplementation(async (...args) => {
      const acquired = await acquire(...args);
      if (acquired && args[0] === 'dev-1' && originalLockToken === undefined) {
        originalLockToken = (await f.agentStore.get('dev-1'))?.lockToken;
        await f.taskStore.set({
          ...original,
          signalToken: 'successor-token',
          updatedAt: new Date().toISOString(),
        });
        expect(await acquire('dev-1', 'task-1', 'server-feedback', {
          onAcquired: token => { successorLockToken = token; },
        })).toBe(true);
      }
      return acquired;
    });
    const continueSession = vi.spyOn(f.manager, 'continueSession');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await f.manager.dispatchServerFixToDev('task-1', '[]', {
      callerOwnsConsumedSignalFailure: true,
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
    expect(await f.taskStore.get('task-1')).toMatchObject({
      status: 'review',
      signalToken: 'successor-token',
    });
    expect(await f.agentStore.get('qa-1')).toMatchObject({ taskId: 'task-1' });
    expect(await f.agentStore.get('dev-1')).toMatchObject({
      taskId: 'task-1',
      lockToken: successorLockToken,
    });
    expect(successorLockToken).toBe(originalLockToken);
    expect(await f.lockManager.isOwner('dev-1', 'task-1', successorLockToken!)).toBe(true);
    expect(continueSession).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(
      'releasing freshly acquired dev dev-1 for task-1 was refused',
    ));
  });

  it('QA release failure re-arms code-reviewed and emits qa-release-failed', async () => {
    const f = await makeFixture('server');
    const now = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'review', signalToken: 't',
    }));
    await f.agentStore.update('qa-1', () => ({
      id: 'qa-1',
      projectId: 'proj',
      taskId: 'task-1',
      status: 'awaiting_human',
      awaitingPhase: 'dispatch-failed:ack_unknown',
      awaitingReason: 'review delivery is uncertain',
      awaitingSince: now,
      updatedAt: now,
    }));

    const result = await f.manager.dispatchServerFixToDev('task-1', '[]');

    expect(result).toBeNull();
    expect(interventionPhases(f.events)).toContain('server-fix-qa-release-failed');
    expect(f.watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'qa-1', expectedKinds: 'code-reviewed',
    }));
  });

  it('dev acquire failure re-arms code-reviewed and emits dev-acquire-failed', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'review', signalToken: 't',
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'someone-else', updatedAt: new Date().toISOString(),
    }));

    const result = await f.manager.dispatchServerFixToDev('task-1', '[]');

    expect(result).toBeNull();
    expect(interventionPhases(f.events)).toContain('server-fix-dev-acquire-failed');
  });

  it('leaves a consumed fix-dispatch failure to the handler without same-token re-arm or duplicate alert', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'review', signalToken: 't',
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'someone-else', updatedAt: new Date().toISOString(),
    }));

    const result = await f.manager.dispatchServerFixToDev(
      'task-1', '[]', { callerOwnsConsumedSignalFailure: true },
    );

    expect(result).toBeNull();
    expect(f.watcher.start).not.toHaveBeenCalled();
    expect(interventionPhases(f.events)).not.toContain('server-fix-dev-acquire-failed');
  });

  it('spec continuation passes currentSpecRound and arms spec-fixed after delivery', async () => {
    const f = await makeFixture('git');
    const findings = { ...RECOVERY_FINDINGS, round: 2 };
    await f.reviewStore.putRound('task-1', 'spec', {
      round: 2,
      phase: 'spec',
      content: '# spec',
      documents: [{ relPath: '.baxian/spec.md', content: '# spec' }],
      findings,
      startedAt: '2026-06-12T00:00:00.000Z',
    });
    await f.taskStore.set(taskFixture({
      reviewMode: 'git', phase: 'spec', status: 'review', signalToken: 't',
      qaAgentId: undefined, specReviewRound: 2,
    }));
    let seenOpts: Record<string, unknown> | undefined;
    vi.spyOn(f.manager, 'continueSession').mockImplementation(async (_t, _a, _p, opts) => {
      seenOpts = opts as Record<string, unknown>;
      expect(await opts.armBeforeInject?.({})).toBe(true);
      expect(await opts.guardBeforeInject?.()).toBe(true);
      return true;
    });

    const result = await f.manager.dispatchServerFixToDev('task-1', '[{"note":"fix me"}]');

    expect(result).not.toBeNull();
    expect(seenOpts).toMatchObject({
      currentSpecRound: 2,
      serverPriorFindings: JSON.stringify(findings),
      serverFindingsDigest: reviewFindingsDigest(findings),
      bypassTaskStatusGate: true,
    });
    expect(f.watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'dev-1', expectedKinds: 'spec-fixed',
    }));
    expect((await f.taskStore.get('task-1'))?.status).toBe('fixing');
  });

  it('stops an armed fix before paste and preserves the successor task generation', async () => {
    const f = await makeFixture('server', { omitQa: true });
    await seedRecoveryRound(f);
    await f.taskStore.set(taskFixture({
      reviewMode: 'server',
      phase: 'code',
      status: 'review',
      signalToken: 'review-token',
      qaAgentId: undefined,
      reviewRound: 1,
    }));
    let installedToken: string | undefined;
    vi.spyOn(f.manager, 'continueSession').mockImplementation(async (_t, _a, _p, opts) => {
      const installed = await f.taskStore.get('task-1');
      installedToken = installed?.signalToken;
      expect(await opts.armBeforeInject?.({})).toBe(true);
      await f.taskStore.set({
        ...installed!,
        signalToken: 'successor-fix-token',
        reviewRound: 2,
        updatedAt: new Date().toISOString(),
      });
      expect(await opts.guardBeforeInject?.()).toBe(false);
      return false;
    });

    const result = await f.manager.dispatchServerFixToDev('task-1', '[]', {
      callerOwnsConsumedSignalFailure: true,
    });

    expect(result).toBeNull();
    expect(await f.taskStore.get('task-1')).toMatchObject({
      status: 'fixing',
      signalToken: 'successor-fix-token',
      reviewRound: 2,
    });
    expect(await f.agentStore.get('dev-1')).toMatchObject({ taskId: 'task-1' });
    expect(f.watcher.stopAgentIfToken).toHaveBeenCalledWith(
      'task-1',
      'dev-1',
      installedToken,
    );
  });

  it('preserves a successor Dev lock generation during failed fix cleanup', async () => {
    const f = await makeFixture('server', { omitQa: true });
    await seedRecoveryRound(f);
    await f.taskStore.set(taskFixture({
      reviewMode: 'server',
      phase: 'code',
      status: 'review',
      signalToken: 'review-token',
      qaAgentId: undefined,
      reviewRound: 1,
    }));
    let successorLockToken: string | undefined;
    let installedFixToken: string | undefined;
    vi.spyOn(f.manager, 'continueSession').mockImplementation(async (_t, _a, _p, opts) => {
      installedFixToken = (await f.taskStore.get('task-1'))?.signalToken;
      expect(await opts.armBeforeInject?.({})).toBe(true);
      const acquired = await f.agentStore.get('dev-1');
      expect(await f.lockManager.releaseIfOwner('dev-1', 'task-1', acquired!.lockToken!)).toBe(true);
      await f.agentStore.update('dev-1', existing => existing && ({
        id: existing.id,
        projectId: existing.projectId,
        updatedAt: new Date().toISOString(),
      }));
      expect(await f.manager.acquireAgentForTask('dev-1', 'task-1', 'server-feedback', {
        onAcquired: token => { successorLockToken = token; },
      })).toBe(true);
      return false;
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await f.manager.dispatchServerFixToDev('task-1', '[]', {
      callerOwnsConsumedSignalFailure: true,
    });

    expect(result).toBeNull();
    expect(await f.taskStore.get('task-1')).toMatchObject({
      status: 'fixing',
      signalToken: installedFixToken,
    });
    expect(await f.agentStore.get('dev-1')).toMatchObject({
      taskId: 'task-1',
      lockToken: successorLockToken,
    });
    expect(await f.lockManager.isOwner('dev-1', 'task-1', successorLockToken!)).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(
      'rollback for task-1 was superseded',
    ));
    expect(f.watcher.start).toHaveBeenCalledTimes(1);
  });

  it('does not fail a fixing task after the Dev lock is reacquired by a successor', async () => {
    const f = await makeFixture('server', { omitQa: true });
    await seedRecoveryRound(f);
    await f.taskStore.set(taskFixture({
      reviewMode: 'server',
      phase: 'code',
      status: 'review',
      signalToken: 'review-token',
      qaAgentId: undefined,
      reviewRound: 1,
    }));
    let installedFixToken: string | undefined;
    let successorLockToken: string | undefined;
    vi.spyOn(f.manager, 'continueSession').mockImplementation(async () => {
      installedFixToken = (await f.taskStore.get('task-1'))?.signalToken;
      const stale = await f.agentStore.get('dev-1');
      expect(await f.lockManager.releaseIfOwner(
        'dev-1',
        'task-1',
        stale!.lockToken!,
      )).toBe(true);
      await f.agentStore.update('dev-1', existing => existing && ({
        id: existing.id,
        projectId: existing.projectId,
        updatedAt: new Date().toISOString(),
      }));
      expect(await f.manager.acquireAgentForTask('dev-1', 'task-1', 'server-feedback', {
        onAcquired: token => { successorLockToken = token; },
      })).toBe(true);
      throw new DispatchTerminalError('required_skills_missing', 'skills gone');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(f.manager.dispatchServerFixToDev('task-1', '[]'))
      .rejects.toMatchObject({ reason: 'required_skills_missing' });

    expect(await f.taskStore.get('task-1')).toMatchObject({
      status: 'fixing',
      signalToken: installedFixToken,
    });
    expect(await f.agentStore.get('dev-1')).toMatchObject({
      taskId: 'task-1',
      lockToken: successorLockToken,
    });
    expect(await f.lockManager.isOwner('dev-1', 'task-1', successorLockToken!)).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(
      'dispatch generation for task-1 was superseded',
    ));
    expect(f.events.some(event =>
      event.type === 'human.intervention'
      && String(event.data?.phase).startsWith('dispatch-failed:'),
    )).toBe(false);
  });

  it('a generic dispatch error rolls back to review, releases the dev and re-arms code-reviewed', async () => {
    const f = await makeFixture('server');
    await seedRecoveryRound(f);
    const NOW = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'review', signalToken: 'orig-token',
    }));
    await f.agentStore.update('qa-1', () => ({
      id: 'qa-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW,
    }));
    vi.spyOn(f.manager, 'continueSession').mockRejectedValue(new Error('pane vanished'));

    await expect(f.manager.dispatchServerFixToDev('task-1', '[]')).rejects.toThrow('pane vanished');

    const after = await f.taskStore.get('task-1');
    expect(after?.status).toBe('review');
    expect(after?.signalToken).toBe('orig-token');
    expect((await f.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(f.watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'qa-1', expectedKinds: 'code-reviewed',
    }));
  });

  it('a DispatchTerminalError from the fix dispatch fails the task', async () => {
    const f = await makeFixture('server');
    await seedRecoveryRound(f);
    const NOW = new Date().toISOString();
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'review', signalToken: 't',
    }));
    await f.agentStore.update('qa-1', () => ({
      id: 'qa-1', projectId: 'proj', taskId: 'task-1', updatedAt: NOW,
    }));
    vi.spyOn(f.manager, 'continueSession').mockRejectedValue(
      new DispatchTerminalError('required_skills_missing', 'skills gone'),
    );
    const failSpy = vi.spyOn(f.manager, 'failTaskForDispatchError').mockResolvedValue();

    await expect(f.manager.dispatchServerFixToDev('task-1', '[]'))
      .rejects.toMatchObject({ reason: 'required_skills_missing' });
    expect(failSpy).toHaveBeenCalledWith(
      'task-1',
      'server-feedback',
      'dev-1',
      expect.anything(),
      expect.objectContaining({
        expectedLockToken: expect.any(String),
        expectedTask: expect.objectContaining({
          status: 'fixing',
          phase: 'code',
          signalToken: expect.any(String),
        }),
      }),
    );
  });

  it('does not fail or release a successor after a terminal fix dispatch error', async () => {
    const f = await makeFixture('server', { omitQa: true });
    await seedRecoveryRound(f);
    await f.taskStore.set(taskFixture({
      reviewMode: 'server',
      phase: 'code',
      status: 'review',
      signalToken: 'review-token',
      qaAgentId: undefined,
      reviewRound: 1,
    }));
    vi.spyOn(f.manager, 'continueSession').mockImplementation(async () => {
      const installed = await f.taskStore.get('task-1');
      await f.taskStore.set({
        ...installed!,
        signalToken: 'successor-terminal-token',
        reviewRound: 2,
        updatedAt: new Date().toISOString(),
      });
      throw new DispatchTerminalError('required_skills_missing', 'skills gone');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(f.manager.dispatchServerFixToDev('task-1', '[]'))
      .rejects.toMatchObject({ reason: 'required_skills_missing' });

    expect(await f.taskStore.get('task-1')).toMatchObject({
      status: 'fixing',
      signalToken: 'successor-terminal-token',
      reviewRound: 2,
    });
    expect(await f.agentStore.get('dev-1')).toMatchObject({ taskId: 'task-1' });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(
      'dispatch generation for task-1 was superseded',
    ));
    expect(f.events.some(event =>
      event.type === 'human.intervention'
      && String(event.data?.phase).startsWith('dispatch-failed:'),
    )).toBe(false);
  });
});

describe('terminal server verdict generation guards', () => {
  it('serializes a current review round write before the next task generation update', async () => {
    const f = await makeFixture('server');
    const task = taskFixture({
      status: 'in_progress',
      signalToken: 'entry-token',
    });
    await f.taskStore.set(task);
    const realPutRound = f.reviewStore.putRound.bind(f.reviewStore);
    let enteredWrite!: () => void;
    let releaseWrite!: () => void;
    const writeEntered = new Promise<void>(resolve => { enteredWrite = resolve; });
    const writeReleased = new Promise<void>(resolve => { releaseWrite = resolve; });
    vi.spyOn(f.reviewStore, 'putRound').mockImplementation(async (...args) => {
      enteredWrite();
      await writeReleased;
      return realPutRound(...args);
    });
    const round = {
      round: 1,
      phase: 'code' as const,
      content: 'entry diff',
      startedAt: '2026-06-12T00:00:00.000Z',
    };

    const put = f.manager.putReviewRoundIfCurrent(task.id, round, taskGenerationGuard(task));
    await writeEntered;
    let updateSettled = false;
    const update = f.manager.updateTaskIfStatus(
      task.id,
      task.status,
      { signalToken: 'successor-token' },
      taskGenerationGuard(task),
    ).then(result => {
      updateSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(updateSettled).toBe(false);

    releaseWrite();

    await expect(put).resolves.toBe(true);
    await expect(update).resolves.toBe(true);
    expect(await f.reviewStore.getRound(task.id, 'code', 1)).toEqual(round);
    expect(await f.taskStore.get(task.id)).toMatchObject({ signalToken: 'successor-token' });
  });

  it('refuses to overwrite a review round after the task generation changes', async () => {
    const f = await makeFixture('server');
    const task = taskFixture({
      status: 'in_progress',
      signalToken: 'entry-token',
    });
    await f.taskStore.set({
      ...task,
      signalToken: 'successor-token',
      updatedAt: '2026-06-12T00:01:00.000Z',
    });
    await f.reviewStore.putRound(task.id, 'code', {
      round: 1,
      phase: 'code',
      content: 'successor diff',
      startedAt: '2026-06-12T00:01:00.000Z',
    });

    await expect(f.manager.putReviewRoundIfCurrent(task.id, {
      round: 1,
      phase: 'code',
      content: 'stale diff',
      startedAt: '2026-06-12T00:00:00.000Z',
    }, taskGenerationGuard(task))).resolves.toBe(false);

    expect(await f.reviewStore.getRound(task.id, 'code', 1)).toMatchObject({
      content: 'successor diff',
    });
  });

  it('serializes a current exchange deletion before the next task generation update', async () => {
    const f = await makeFixture('server');
    const task = taskFixture({
      status: 'review',
      signalToken: 'entry-token',
      reviewRound: 1,
    });
    await f.taskStore.set(task);
    let enteredDelete!: () => void;
    let releaseDelete!: () => void;
    const deleteEntered = new Promise<void>(resolve => { enteredDelete = resolve; });
    const deleteReleased = new Promise<void>(resolve => { releaseDelete = resolve; });
    const deleteFindings = vi.fn(async () => {
      enteredDelete();
      await deleteReleased;
    });
    vi.spyOn(f.manager, 'getReviewTransport').mockReturnValue({
      deleteFindings,
      deleteResponse: vi.fn(async () => undefined),
    } as never);

    const deletion = f.manager.deleteReviewExchangeIfCurrent(
      task.id,
      f.manager.getAgentConfig('qa-1')!,
      'findings',
      taskGenerationGuard(task),
    );
    await deleteEntered;
    let updateSettled = false;
    const update = f.manager.updateTaskIfStatus(
      task.id,
      task.status,
      { signalToken: 'successor-token' },
      taskGenerationGuard(task),
    ).then(result => {
      updateSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(updateSettled).toBe(false);

    releaseDelete();

    await expect(deletion).resolves.toBe(true);
    await expect(update).resolves.toBe(true);
    expect(deleteFindings).toHaveBeenCalledTimes(1);
    expect(await f.taskStore.get(task.id)).toMatchObject({ signalToken: 'successor-token' });
  });

  it('refuses to delete an exchange artifact after the task generation changes', async () => {
    const f = await makeFixture('server');
    const task = taskFixture({
      status: 'fixing',
      signalToken: 'entry-token',
      reviewRound: 1,
    });
    await f.taskStore.set({
      ...task,
      signalToken: 'successor-token',
      updatedAt: '2026-06-12T00:01:00.000Z',
    });
    const deleteResponse = vi.fn(async () => undefined);
    vi.spyOn(f.manager, 'getReviewTransport').mockReturnValue({
      deleteFindings: vi.fn(async () => undefined),
      deleteResponse,
    } as never);

    await expect(f.manager.deleteReviewExchangeIfCurrent(
      task.id,
      f.manager.getAgentConfig('dev-1')!,
      'response',
      taskGenerationGuard(task),
    )).resolves.toBe(false);

    expect(deleteResponse).not.toHaveBeenCalled();
  });

  it('refuses to delete a rejected response after its recovery intent changes', async () => {
    const f = await makeFixture('server');
    const task = recoveryTask('correct-response');
    const expectedRecovery = task.serverSignalRecovery!;
    await f.taskStore.set({
      ...task,
      serverSignalRecovery: { ...expectedRecovery, mode: 'hold' },
      updatedAt: '2026-06-12T00:02:00.000Z',
    });
    const deleteResponse = vi.fn(async () => undefined);
    vi.spyOn(f.manager, 'getReviewTransport').mockReturnValue({
      deleteFindings: vi.fn(async () => undefined),
      deleteResponse,
    } as never);

    await expect(f.manager.deleteReviewExchangeIfCurrent(
      task.id,
      f.manager.getAgentConfig('dev-1')!,
      'response',
      taskGenerationGuard(task),
      expectedRecovery,
    )).resolves.toBe(false);

    expect(deleteResponse).not.toHaveBeenCalled();
  });

  it('commitServerAfterDone rejects a superseded task without persisting a snapshot', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      status: 'review',
      reviewRound: 1,
      signalToken: 'current-token',
      afterDone: undefined,
    }));

    await expect(f.manager.commitServerAfterDone('task-1', {
      status: 'review',
      phase: 'code',
      signalToken: 'stale-token',
      agentId: 'dev-1',
      reviewRound: 1,
    })).rejects.toMatchObject({
      status: 409,
      code: 'dispatch-superseded',
    });

    expect((await f.taskStore.get('task-1'))?.afterDone).toBeUndefined();
  });

  it('transitionTaskStatus refuses a superseded full task generation', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      status: 'review',
      reviewRound: 1,
      signalToken: 'current-token',
    }));

    const result = await f.manager.transitionTaskStatus('task-1', 'ready', {
      fromStatus: ['review'],
      expectTask: {
        status: 'review',
        phase: 'code',
        signalToken: 'stale-token',
        agentId: 'dev-1',
        reviewRound: 1,
      },
    });

    expect(result).toBeNull();
    expect(await f.taskStore.get('task-1')).toMatchObject({
      status: 'review',
      signalToken: 'current-token',
    });
  });
});

describe('dispatchServerAfterDone failure & success paths', () => {
  it('dev acquire failure restores the signal token and clears the publish marker', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'approved', signalToken: 'orig-token',
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'someone-else', updatedAt: new Date().toISOString(),
    }));

    const result = await f.manager.dispatchServerAfterDone('task-1', 'pr');

    expect(result).toBeNull();
    expect(interventionPhases(f.events)).toContain('server-after-done-dev-acquire-failed');
    const after = await f.taskStore.get('task-1');
    expect(after?.signalToken).toBe('orig-token');
    expect(after?.publishDispatchedAt).toBeUndefined();
  });

  it('a rebound dev reaches dev-acquire-failed, not a lineage verdict computed on the wrong worktree', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'approved', signalToken: 'orig-token',
    }));
    await f.taskStore.set(taskFixture({
      id: 'task-2', branch: 'bx/task-2', agentId: '', qaAgentId: undefined, status: 'in_progress',
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-9', workdir: '/wt/task-9',
      updatedAt: new Date().toISOString(),
    }));
    const SHA = 'c'.repeat(40);
    f.runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('rev-list')) return { stdout: `${SHA}\n`, stderr: '', exitCode: 0 };
      if (cmd.includes('merge-base --is-ancestor')) return { stdout: '', stderr: '', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await f.manager.dispatchServerAfterDone('task-1', 'pr');

    expect(result).toBeNull();
    const phases = interventionPhases(f.events);
    expect(phases).toContain('server-after-done-dev-acquire-failed');
    expect(phases).not.toContain('server-after-done-lineage-violation');
  });

  it('a generic publish dispatch error restores the signal token and rethrows', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'approved', signalToken: 'orig-token',
    }));
    vi.spyOn(f.manager, 'continueSession').mockRejectedValue(new Error('publish paste failed'));

    await expect(f.manager.dispatchServerAfterDone('task-1', 'branch')).rejects.toThrow('publish paste failed');
    const after = await f.taskStore.get('task-1');
    expect(after?.signalToken).toBe('orig-token');
    expect(after?.publishDispatchedAt).toBeUndefined();
  });

  it('a DispatchTerminalError from the publish dispatch fails the task', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'approved', signalToken: 't',
    }));
    vi.spyOn(f.manager, 'continueSession').mockRejectedValue(
      new DispatchTerminalError('prompt_too_large', 'publish prompt too big'),
    );
    const failSpy = vi.spyOn(f.manager, 'failTaskForDispatchError').mockResolvedValue();

    await expect(f.manager.dispatchServerAfterDone('task-1', 'pr'))
      .rejects.toMatchObject({ reason: 'prompt_too_large' });
    expect(failSpy).toHaveBeenCalledWith('task-1', 'server-after-done', 'dev-1', expect.anything());
  });

  it('a delivered publish prompt marks the dispatch and arms code-ready', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'approved', signalToken: 't',
    }));
    let seenOpts: Record<string, unknown> | undefined;
    vi.spyOn(f.manager, 'continueSession').mockImplementation(async (_t, _a, _p, opts) => {
      seenOpts = opts as Record<string, unknown>;
      return true;
    });

    const result = await f.manager.dispatchServerAfterDone('task-1', 'branch');

    expect(result).not.toBeNull();
    expect(result?.publishDispatchedAt).toBeTruthy();
    expect(seenOpts).toMatchObject({ serverAfterDone: { kind: 'branch', branch: 'bx/task-1' } });
    expect(f.watcher.start).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'dev-1', expectedKinds: 'code-ready',
    }));
  });

  it('a lineage check failure blocks the publish dispatch recoverably instead of leaking the error', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'approved', signalToken: 'orig-token',
    }));
    const continueSpy = vi.spyOn(f.manager, 'continueSession').mockResolvedValue(true);
    vi.spyOn(f.manager, 'findLineageViolation').mockRejectedValue(new Error('merge-base exploded'));

    const result = await f.manager.dispatchServerAfterDone('task-1', 'pr');

    expect(result).toBeNull();
    expect(continueSpy).not.toHaveBeenCalled();
    const intervention = f.events.find(e => e.type === 'human.intervention');
    expect(intervention?.data).toMatchObject({ phase: 'server-after-done-lineage-check-failed' });
    const after = await f.taskStore.get('task-1');
    expect(after?.signalToken).toBe('orig-token');
    expect(after?.publishDispatchedAt).toBeUndefined();
  });

  it('refuses the publish dispatch when the branch embeds another active task branch', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'approved', signalToken: 'orig-token',
    }));
    const continueSpy = vi.spyOn(f.manager, 'continueSession').mockResolvedValue(true);
    vi.spyOn(f.manager, 'findLineageViolation').mockResolvedValue({
      taskId: 'task-2', branch: 'bx/task-2', sha: 'a'.repeat(40),
    });

    const result = await f.manager.dispatchServerAfterDone('task-1', 'pr');

    expect(result).toBeNull();
    expect(continueSpy).not.toHaveBeenCalled();
    const intervention = f.events.find(e => e.type === 'human.intervention');
    expect(intervention?.data).toMatchObject({
      phase: 'server-after-done-lineage-violation',
      offendingTaskId: 'task-2',
      offendingBranch: 'bx/task-2',
    });
    const after = await f.taskStore.get('task-1');
    expect(after?.signalToken).toBe('orig-token');
    expect(after?.publishDispatchedAt).toBeUndefined();
  });
});

describe('findLineageViolation', () => {
  const NOW = new Date().toISOString();
  const SHA_A = 'a'.repeat(40);
  const SHA_B = 'b'.repeat(40);

  async function seedLineageFixture(otherTask: Partial<TaskState>) {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({ reviewMode: 'server', phase: 'code', signalToken: 't' }));
    await f.taskStore.set(taskFixture({
      id: 'task-2', branch: 'bx/task-2', agentId: '', qaAgentId: undefined,
      status: 'in_progress', ...otherTask,
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1',
      workdir: '/wt/task-1', updatedAt: NOW,
    }));
    f.runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes("rev-list 'base123..refs/heads/bx/task-2'")) {
        return { stdout: `${SHA_A}\n`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes("rev-list 'base123..HEAD'")) {
        return { stdout: `${SHA_B}\n${SHA_A}\n`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('merge-base --is-ancestor')) return { stdout: '', stderr: '', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    return f;
  }

  it('reports another active task whose branch tip sits inside this branch history', async () => {
    const f = await seedLineageFixture({});
    const violation = await f.manager.findLineageViolation('task-1', 'base123');
    expect(violation).toEqual({ taskId: 'task-2', branch: 'bx/task-2', sha: SHA_A });
  });

  it('ignores terminal tasks when collecting candidates', async () => {
    const f = await seedLineageFixture({ status: 'merged' });
    const violation = await f.manager.findLineageViolation('task-1', 'base123');
    expect(violation).toBeNull();
  });

  it('resolves the merge base itself when no baseSha is provided', async () => {
    const f = await seedLineageFixture({});
    f.runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('merge-base origin/HEAD HEAD')) return { stdout: 'base456\n', stderr: '', exitCode: 0 };
      if (cmd.includes("rev-list 'base456..refs/heads/bx/task-2'")) {
        return { stdout: `${SHA_A}\n`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes("rev-list 'base456..HEAD'")) return { stdout: `${SHA_A}\n`, stderr: '', exitCode: 0 };
      if (cmd.includes('merge-base --is-ancestor')) return { stdout: '', stderr: '', exitCode: 1 };
      if (cmd.includes('rev-list')) return { stdout: '', stderr: 'wrong base', exitCode: 128 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const violation = await f.manager.findLineageViolation('task-1');
    expect(violation).toEqual({ taskId: 'task-2', branch: 'bx/task-2', sha: SHA_A });
    const cmds = f.runner.exec.mock.calls.map(c => c[0] as string);
    const fetchIdx = cmds.findIndex(c => c.includes('fetch origin'));
    const mergeBaseIdx = cmds.findIndex(c => c.includes('merge-base origin/HEAD HEAD'));
    expect(fetchIdx).toBeGreaterThanOrEqual(0);
    expect(fetchIdx).toBeLessThan(mergeBaseIdx);
  });

  it('throws when the freshness fetch fails while self-resolving the base', async () => {
    const f = await seedLineageFixture({});
    f.runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('fetch origin')) return { stdout: '', stderr: 'network down', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    await expect(f.manager.findLineageViolation('task-1')).rejects.toThrow(/fetch/i);
  });

  it('retries a transient freshness fetch before self-resolving the base', async () => {
    __setNetExecSleepForTests(async () => {});
    try {
      const f = await seedLineageFixture({});
      let fetchAttempts = 0;
      f.runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('fetch origin')) {
          fetchAttempts++;
          return fetchAttempts === 1
            ? { stdout: '', stderr: 'fatal: unable to access: Could not resolve host: github.com', exitCode: 128 }
            : { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('merge-base origin/HEAD HEAD')) return { stdout: 'base456\n', stderr: '', exitCode: 0 };
        if (cmd.includes("rev-list 'base456..HEAD'")) return { stdout: '', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      const violation = await f.manager.findLineageViolation('task-1');
      expect(violation).toBeNull();
      expect(fetchAttempts).toBe(2);
    } finally {
      __setNetExecSleepForTests();
    }
  });

  it('returns null when the dev agent has no recorded Workdir', async () => {
    const f = await seedLineageFixture({});
    await f.agentStore.update('dev-1', (s) => {
      const { workdir: _workdir, ...rest } = s!;
      return rest;
    });
    const violation = await f.manager.findLineageViolation('task-1', 'base123');
    expect(violation).toBeNull();
  });

  it('returns null when the dev agent has been rebound to another task — its Workdir belongs to that task', async () => {
    const f = await seedLineageFixture({});
    await f.agentStore.update('dev-1', (s) => ({
      ...s!, taskId: 'task-9', workdir: '/wt/task-9',
    }));
    const violation = await f.manager.findLineageViolation('task-1', 'base123');
    expect(violation).toBeNull();
    const probed = f.runner.exec.mock.calls.map(c => c[0] as string);
    expect(probed.some(c => c.includes('/wt/task-9'))).toBe(false);
  });

  it('collects candidates from sibling projects sharing the same repo (shared branch namespace)', async () => {
    const f = await makeFixture('server', { siblingProjects: true });
    await f.taskStore.set(taskFixture({ reviewMode: 'server', phase: 'code', signalToken: 't' }));
    await f.taskStore.set(taskFixture({
      id: 'task-5', projectId: 'proj-same-repo', branch: 'bx/task-5',
      agentId: '', qaAgentId: undefined, status: 'in_progress',
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1',
      workdir: '/wt/task-1', updatedAt: NOW,
    }));
    f.runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes("rev-list 'base123..refs/heads/bx/task-5'")) {
        return { stdout: `${SHA_A}\n`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes("rev-list 'base123..HEAD'")) {
        return { stdout: `${SHA_B}\n${SHA_A}\n`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('merge-base --is-ancestor')) return { stdout: '', stderr: '', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const violation = await f.manager.findLineageViolation('task-1', 'base123');
    expect(violation).toEqual({ taskId: 'task-5', branch: 'bx/task-5', sha: SHA_A });
  });

  it('excludes tasks whose project points at a different repo', async () => {
    const f = await makeFixture('server', { siblingProjects: true });
    await f.taskStore.set(taskFixture({ reviewMode: 'server', phase: 'code', signalToken: 't' }));
    await f.taskStore.set(taskFixture({
      id: 'task-6', projectId: 'proj-other-repo', branch: 'bx/task-6',
      agentId: '', qaAgentId: undefined, status: 'in_progress',
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1',
      workdir: '/wt/task-1', updatedAt: NOW,
    }));
    f.runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes("rev-list 'base123..HEAD'")) {
        return { stdout: `${SHA_B}\n${SHA_A}\n`, stderr: '', exitCode: 0 };
      }
      return { stdout: `${SHA_A}\n`, stderr: '', exitCode: 0 };
    });

    const violation = await f.manager.findLineageViolation('task-1', 'base123');
    expect(violation).toBeNull();
    const probed = f.runner.exec.mock.calls.map(c => c[0] as string);
    expect(probed.some(c => c.includes('refs/heads/bx/task-6'))).toBe(false);
  });
});

describe('dispatchServerReviewToQa forwards full content to startSession (split happens later)', () => {
  it('passes oversized spec content through untruncated', async () => {
    const f = await makeFixture('git');
    await f.taskStore.set(taskFixture({
      reviewMode: 'git', phase: 'spec', status: 'in_progress',
      signalToken: 'orig-token', specReviewRound: 0,
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: new Date().toISOString(),
    }));
    const huge = '哈'.repeat(30000);
    let captured: { serverContent?: string; contentTruncated?: boolean } | undefined;
    vi.spyOn(f.manager, 'startSession').mockImplementation(async (_t, _a, _p, opts) => {
      captured = opts as typeof captured;
      return true;
    });
    await f.manager.dispatchServerReviewToQa('task-1', { phase: 'spec', content: huge });
    expect(captured?.serverContent).toBe(huge);
    expect(captured && 'contentTruncated' in captured).toBe(false);
  });
});

describe('startSession/continueSession resolve server payloads before prompt build', () => {
  type Fixture = Awaited<ReturnType<typeof makeFixture>>;

  async function stubSessionEnv(
    f: Fixture,
    agentId: 'dev-1' | 'qa-1',
    checkoutMode: 'head' | 'base' = 'base',
  ) {
    const current = await f.agentStore.get(agentId);
    const workdir = current?.workdir ?? join(tempDir, agentId);
    if (!current?.taskId) {
      await f.agentStore.update(agentId, () => ({
        id: agentId,
        projectId: 'proj',
        taskId: 'task-1',
        workdir,
        updatedAt: new Date().toISOString(),
      }));
    }
    vi.spyOn(f.manager, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: false, freshRuntime: true, paneId: '%1', workdir,
    });
    vi.spyOn(
      f.manager as never as { waitForReplPromptReady: (...args: unknown[]) => Promise<void> },
      'waitForReplPromptReady',
    ).mockResolvedValue(undefined);
    vi.spyOn(BranchManager.prototype, 'materializeReviewHead').mockResolvedValue({ mode: checkoutMode });
    vi.spyOn(BranchManager.prototype, 'switchToDefaultDetached').mockResolvedValue(undefined);
    vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue(undefined);
    vi.spyOn(BranchManager.prototype, 'currentRef').mockResolvedValue('refs/heads/bx/task-1');
  }

  function stubTransport(f: Fixture) {
    const deliverToInbox = vi.fn(async (_agent: unknown, _wt: string, filename: string, content: string) => ({
      path: `.baxian/review/inbox/${filename}`,
      bytes: Buffer.byteLength(content, 'utf8'),
    }));
    vi.spyOn(f.manager, 'getReviewTransport').mockReturnValue({
      clearDispatchOutputs: vi.fn(async () => undefined),
      deliverToInbox,
    } as never);
    return deliverToInbox;
  }

  it('startSession delivers oversized review content to the consumer inbox with round-derived naming', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'review', signalToken: 'tok', reviewRound: 1,
    }));
    await stubSessionEnv(f, 'qa-1');
    const deliver = stubTransport(f);
    const huge = 'd'.repeat(10 * 1024 + 1);

    await expect(f.manager.startSession('task-1', 'qa-1', 'server-review', {
      bypassTaskStatusGate: true, signalToken: 'tok', serverContent: huge,
    })).rejects.toMatchObject({ reason: 'required_skills_missing' });

    expect(deliver).toHaveBeenCalledTimes(1);
    const [agentArg, worktreeArg, filename, content] = deliver.mock.calls[0]!;
    expect((agentArg as { id: string }).id).toBe('qa-1');
    expect(worktreeArg).toBe(join(tempDir, 'qa-1'));
    expect(filename).toBe('diff-round-1.patch');
    expect(content).toBe(huge);
  });

  it('continueSession delivers oversized prior findings to the dev inbox for server-feedback', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'fixing', signalToken: 'tok', reviewRound: 2,
    }));
    const devWorktree = join(tempDir, 'wt-dev');
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1',
      workdir: devWorktree, updatedAt: new Date().toISOString(),
    }));
    await stubSessionEnv(f, 'dev-1');
    const deliver = stubTransport(f);
    const findings = JSON.stringify({ pad: 'f'.repeat(10 * 1024 + 1) });

    await expect(f.manager.continueSession('task-1', 'dev-1', 'server-feedback', {
      signalToken: 'tok', serverPriorFindings: findings,
    })).rejects.toMatchObject({ reason: 'required_skills_missing' });

    expect(deliver).toHaveBeenCalledTimes(1);
    const [agentArg, worktreeArg, filename, content] = deliver.mock.calls[0]!;
    expect((agentArg as { id: string }).id).toBe('dev-1');
    expect(worktreeArg).toBe(devWorktree);
    expect(filename).toBe('findings-round-2.json');
    expect(content).toBe(findings);
  });

  it('startSession forces a small review diff into diff-file when the QA worktree materializes the head tree', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'review', signalToken: 'tok', reviewRound: 1,
    }));
    await stubSessionEnv(f, 'qa-1', 'head');
    f.runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('git rev-parse HEAD^{tree}')) return { stdout: 'tree123\n', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const deliver = stubTransport(f);

    await expect(f.manager.startSession('task-1', 'qa-1', 'server-review', {
      bypassTaskStatusGate: true,
      signalToken: 'tok',
      serverContent: 'small diff',
      serverBaseSha: 'base123',
      serverHeadSha: 'head123',
      serverHeadTree: 'tree123',
    })).rejects.toMatchObject({ reason: 'required_skills_missing' });

    expect(deliver).toHaveBeenCalledTimes(1);
    const [, , filename, content] = deliver.mock.calls[0]!;
    expect(filename).toBe('diff-round-1.patch');
    expect(content).toBe('small diff');
  });

  it('a within-threshold payload stays inline: prompt build is reached with zero inbox deliveries', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'review', signalToken: 'tok', reviewRound: 1,
    }));
    await stubSessionEnv(f, 'qa-1');
    const deliver = stubTransport(f);

    await expect(f.manager.startSession('task-1', 'qa-1', 'server-review', {
      bypassTaskStatusGate: true, signalToken: 'tok', serverContent: 'small diff',
    })).rejects.toMatchObject({ reason: 'required_skills_missing' });

    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('continueSession Workdir generation guard', () => {
  it('holds the binding and lock before branch, artifact, or prompt work when ensure changes Workdir', async () => {
    const f = await makeFixture('server');
    const oldWorkdir = join(tempDir, 'dev-1');
    const newWorkdir = join(tempDir, 'dev-1-new');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', phase: 'code', status: 'fixing', signalToken: 'tok',
    }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1',
      projectId: 'proj',
      taskId: 'task-1',
      workdir: oldWorkdir,
      updatedAt: new Date().toISOString(),
    }));
    const before = (await f.agentStore.get('dev-1'))!;
    vi.spyOn(f.manager, 'ensureSession').mockImplementation(async () => {
      await f.agentStore.update('dev-1', latest => ({
        ...latest!,
        workdir: newWorkdir,
        updatedAt: new Date().toISOString(),
      }));
      return {
        ok: true,
        createdSession: false,
        freshRuntime: true,
        paneId: '%9',
        workdir: newWorkdir,
      };
    });
    const branchSpy = vi.spyOn(BranchManager.prototype, 'assertClean').mockResolvedValue(undefined);
    const transportSpy = vi.spyOn(f.manager, 'getReviewTransport');
    const injectSpy = vi.spyOn(
      f.manager as never as { injectAndAwaitAck: (...args: unknown[]) => Promise<unknown> },
      'injectAndAwaitAck',
    );

    await expect(f.manager.continueSession('task-1', 'dev-1', 'server-feedback', {
      signalToken: 'tok',
    })).resolves.toBe(false);

    const after = await f.agentStore.get('dev-1');
    expect(after).toMatchObject({
      taskId: 'task-1',
      lockToken: before.lockToken,
      workdir: newWorkdir,
      status: 'awaiting_human',
      awaitingPhase: 'workdir-changed-during-dispatch',
    });
    expect(await f.lockManager.isOwner('dev-1', 'task-1', before.lockToken!)).toBe(true);
    expect(branchSpy).not.toHaveBeenCalled();
    expect(transportSpy).not.toHaveBeenCalled();
    expect(injectSpy).not.toHaveBeenCalled();
  });
});

describe('settling barrier gates (spec C4)', () => {
  it('legacy batch continuation always re-states review-checkout: base into continueSession', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      reviewMode: 'server', status: 'review', phase: 'code', signalToken: 'tok-old',
      reviewRound: 1, batchIndex: 0, batchTotal: 2,
    }));
    await f.agentStore.update('qa-1', () => ({
      id: 'qa-1', projectId: 'proj', taskId: 'task-1', updatedAt: new Date().toISOString(),
    }));
    const continueSpy = vi.spyOn(f.manager, 'continueSession').mockResolvedValue(true);

    await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', content: 'next batch', continuation: true,
    });

    expect(continueSpy).toHaveBeenCalledWith(
      'task-1', 'qa-1', 'server-review',
      expect.objectContaining({ serverReviewCheckout: 'base' }),
    );
  });

  it('fresh dispatch threads no serverReviewCheckout into startSession opts', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({ status: 'in_progress', phase: 'code', signalToken: 'tok-entry', reviewRound: 1 }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: new Date().toISOString(),
    }));
    const startSpy = vi.spyOn(f.manager, 'startSession').mockResolvedValue(true);

    await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', content: 'diff', reviewHeadAnchorSha: 'h'.repeat(40), headTree: 't'.repeat(40),
    });

    expect(startSpy).toHaveBeenCalled();
    const opts = startSpy.mock.calls[0]![3] as Record<string, unknown>;
    expect('serverReviewCheckout' in opts).toBe(false);
  });

  it('final gate: settling without a matching permit 409s before any token rotation or session start', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({ status: 'in_progress', phase: 'code', signalToken: 'tok-hold' }));
    f.watcher.isSettling.mockReturnValue(true);
    f.watcher.settlePermitMatches.mockReturnValue(false);
    const startSpy = vi.spyOn(f.manager, 'startSession').mockResolvedValue(true);

    await expect(f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', content: 'diff', reviewHeadAnchorSha: 'h'.repeat(40), headTree: 't'.repeat(40),
    })).rejects.toMatchObject({ status: 409, code: 'review-settling' });

    expect((await f.taskStore.get('task-1'))?.signalToken).toBe('tok-hold');
    expect((await f.taskStore.get('task-1'))?.status).toBe('in_progress');
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('final gate admits the settling handler chain via its permit', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({ status: 'in_progress', phase: 'code', signalToken: 'tok-entry', reviewRound: 1 }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: new Date().toISOString(),
    }));
    const permit = Symbol('settle:task-1');
    f.watcher.isSettling.mockReturnValue(true);
    f.watcher.settlePermitMatches.mockImplementation(((_task: string, candidate: unknown) => candidate === permit) as never);
    const startSpy = vi.spyOn(f.manager, 'startSession').mockResolvedValue(true);

    const result = await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', content: 'diff', reviewHeadAnchorSha: 'h'.repeat(40), headTree: 't'.repeat(40),
      settlePermit: permit,
    });

    expect(result).not.toBeNull();
    expect(startSpy).toHaveBeenCalled();
  });

  it('early gate: manual dispatchReviewToQa 409s while settling with zero side effects', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({ status: 'review', phase: 'code', signalToken: 'tok-review', reviewRound: 1 }));
    f.watcher.isSettling.mockReturnValue(true);
    const driver = {
      dispatchCodeReview: vi.fn(async () => true),
      dispatchSpecReview: vi.fn(async () => true),
    };
    f.manager.setServerReviewDriver(driver as never);
    const reviewSpy = vi.spyOn(f.manager, 'dispatchServerReviewToQa');

    await expect(f.manager.dispatchReviewToQa('task-1')).rejects.toMatchObject({
      status: 409, code: 'review-settling',
    });

    expect(driver.dispatchCodeReview).not.toHaveBeenCalled();
    expect(driver.dispatchSpecReview).not.toHaveBeenCalled();
    expect(reviewSpy).not.toHaveBeenCalled();
    expect((await f.taskStore.get('task-1'))?.signalToken).toBe('tok-review');
    f.watcher.isSettling.mockReturnValue(false);
    driver.dispatchCodeReview.mockResolvedValue(true);
    await expect(f.manager.dispatchReviewToQa('task-1')).resolves.toBeTruthy();
    expect(driver.dispatchCodeReview).toHaveBeenCalledTimes(1);
  });
});

describe('manual review vs settlement interleaving (early-gate TOCTOU fence)', () => {
  function manualFixtureTask() {
    return taskFixture({ status: 'review', phase: 'code', signalToken: 'tok-review', reviewRound: 1 });
  }

  it('a completion landing after the manual chain acquired the mutex lets the manual owner run to completion', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(manualFixtureTask());
    let ownerSeen: unknown;
    const driver = {
      dispatchCodeReview: vi.fn(async (_task: unknown, opts?: { settlePermit?: unknown }) => {
        ownerSeen = opts?.settlePermit;
        return true;
      }),
      dispatchSpecReview: vi.fn(async () => true),
    };
    f.manager.setServerReviewDriver(driver as never);
    let mintedOwner: symbol | undefined;
    f.watcher.runExclusive.mockImplementation(async (_taskId: string, fn: (owner: symbol) => Promise<unknown>) => {
      // 信号在手工链持锁后命中：settling 置位，但 FIFO owner 凭 permit 跑完
      f.watcher.isSettling.mockReturnValue(true);
      mintedOwner = Symbol('owner-live');
      f.watcher.exclusiveOwnerMatches.mockImplementation(((_t: string, candidate: unknown) => candidate === mintedOwner) as never);
      return fn(mintedOwner);
    });

    await expect(f.manager.dispatchReviewToQa('task-1')).resolves.toBeTruthy();

    expect(driver.dispatchCodeReview).toHaveBeenCalledTimes(1);
    expect(ownerSeen).toBe(mintedOwner);
  });

  it('final gate admits the current exclusive owner while settling', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({ status: 'in_progress', phase: 'code', signalToken: 'tok-entry', reviewRound: 1 }));
    await f.agentStore.update('dev-1', () => ({
      id: 'dev-1', projectId: 'proj', taskId: 'task-1', updatedAt: new Date().toISOString(),
    }));
    const owner = Symbol('owner-gate');
    f.watcher.isSettling.mockReturnValue(true);
    f.watcher.settlePermitMatches.mockReturnValue(false);
    f.watcher.exclusiveOwnerMatches.mockImplementation(((_t: string, candidate: unknown) => candidate === owner) as never);
    const startSpy = vi.spyOn(f.manager, 'startSession').mockResolvedValue(true);

    const result = await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', content: 'diff', reviewHeadAnchorSha: 'h'.repeat(40), headTree: 't'.repeat(40),
      settlePermit: owner,
    });

    expect(result).not.toBeNull();
    expect(startSpy).toHaveBeenCalled();
  });

  it('rollback of a failed manual redispatch restores the persisted base checkout mode', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(taskFixture({
      status: 'review', phase: 'code', signalToken: 'tok-base', reviewRound: 1,
      reviewCheckoutMode: 'base',
    }));
    vi.spyOn(f.manager, 'startSession').mockResolvedValue(false);

    await f.manager.dispatchServerReviewToQa('task-1', {
      phase: 'code', content: 'diff', reviewHeadAnchorSha: 'h'.repeat(40), headTree: 't'.repeat(40),
    });

    const task = await f.taskStore.get('task-1');
    expect(task?.signalToken).toBe('tok-base');
    expect(task?.reviewCheckoutMode).toBe('base');
  });

  it('409s via the generation CAS when the settled pass advanced the task while waiting for the mutex', async () => {
    const f = await makeFixture('server');
    await f.taskStore.set(manualFixtureTask());
    const driver = {
      dispatchCodeReview: vi.fn(async () => true),
      dispatchSpecReview: vi.fn(async () => true),
    };
    f.manager.setServerReviewDriver(driver as never);
    f.watcher.runExclusive.mockImplementation(async (_taskId: string, fn: () => Promise<unknown>) => {
      const current = await f.taskStore.get('task-1');
      await f.taskStore.set({ ...current!, signalToken: 'tok-rotated', updatedAt: new Date().toISOString() });
      return fn();
    });

    await expect(f.manager.dispatchReviewToQa('task-1')).rejects.toMatchObject({ status: 409 });

    expect(driver.dispatchCodeReview).not.toHaveBeenCalled();
    expect(driver.dispatchSpecReview).not.toHaveBeenCalled();
  });
});
