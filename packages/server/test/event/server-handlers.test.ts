import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/event/bus.js';
import { registerServerEventHandlers } from '../../src/event/server-handlers.js';
import { SETTLE_PERMIT } from '../../src/agent/phase-signal-watcher.js';
import { ReviewExchangeError } from '../../src/agent/review-transport.js';
import {
  ReviewStore,
  reviewFindingsDigest,
  sha256Hex,
} from '../../src/state/review-store.js';
import type { AgentManager, ServerReviewDriver } from '../../src/agent/manager.js';
import type { EventLog } from '../../src/event/log.js';
import type {
  BaxianEvent,
  ReviewFindings,
  ReviewResponse,
  ReviewRound,
  TaskGenerationGuard,
  TaskState,
} from '../../src/shared/index.js';
import {
  DEFAULT_SERVER_CONFIG,
  renderSpecDocuments,
  taskMatchesGeneration,
} from '../../src/shared/index.js';

const DEV = { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local', projectId: 'proj' };
const QA = { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local', projectId: 'proj' };
const RESEARCH = { id: 'research-1', runtime: 'claude-code', role: 'research', mode: 'local', projectId: 'proj' };

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 't1',
    projectId: 'proj',
    title: 'T',
    description: 'D',
    preferredAgentId: 'dev-1',
    agentId: 'dev-1',
    devAgentId: 'dev-1',
    qaAgentId: 'qa-1',
    reviewRound: 0,
    reviewMode: 'server',
    phase: 'code',
    signalToken: 'tok123',
    branch: 'bx/t1',
    status: 'in_progress',
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    ...overrides,
  };
}

function generationOf(task: TaskState): TaskGenerationGuard {
  return {
    status: task.status,
    phase: task.phase,
    signalToken: task.signalToken,
    agentId: task.agentId,
    reviewRound: task.reviewRound,
    specReviewRound: task.specReviewRound,
  };
}

interface Fixture {
  bus: EventBus;
  store: ReviewStore;
  task: TaskState;
  calls: Record<string, unknown[][]>;
  transport: {
    readContent: ReturnType<typeof vi.fn>;
    readFindings: ReturnType<typeof vi.fn>;
    readResponse: ReturnType<typeof vi.fn>;
    readResponseWithRaw: ReturnType<typeof vi.fn>;
    deleteFindings: ReturnType<typeof vi.fn>;
    deleteResponse: ReturnType<typeof vi.fn>;
    readFileRange: ReturnType<typeof vi.fn>;
    readHeadSha: ReturnType<typeof vi.fn>;
  };
  releaseAgentForTask: ReturnType<typeof vi.fn>;
  getAgentState: ReturnType<typeof vi.fn>;
  transitionTaskStatus: ReturnType<typeof vi.fn>;
  transitionToCodePhase: ReturnType<typeof vi.fn>;
  parkTaskAtSpecReady: ReturnType<typeof vi.fn>;
  updateTask: ReturnType<typeof vi.fn>;
  dispatchServerReviewToQa: ReturnType<typeof vi.fn>;
  deleteReviewExchangeIfCurrent: ReturnType<typeof vi.fn>;
  holdConsumedServerSignal: ReturnType<typeof vi.fn>;
  claimServerSignalRecovery: ReturnType<typeof vi.fn>;
  commitServerAfterDone: ReturnType<typeof vi.fn>;
  driver: { current?: ServerReviewDriver };
  findLineageViolation: ReturnType<typeof vi.fn>;
  emitted: BaxianEvent[];
  emit: (type: string, data: Record<string, unknown>) => Promise<void>;
}

function makeFixture(
  taskOverrides: Partial<TaskState> = {},
  config: {
    rounds?: number;
    afterDone?: 'pr' | 'branch' | null;
    verifyPr?: boolean;
    verifiedHeadSha?: string;
    specApproval?: 'human' | null;
    hasQaPartner?: boolean;
    interdiff?: { ok: true; diff: string } | { ok: false; reason: string };
    interdiffThrows?: boolean;
  } = {},
): Fixture {
  const emitted: BaxianEvent[] = [];
  const bus = new EventBus({ append: async (e: BaxianEvent) => { emitted.push(e); } } as unknown as EventLog);
  const store = new ReviewStore();
  const driverRef: { current?: ServerReviewDriver } = {};
  const task = makeTask(taskOverrides);
  const hasQaPartner = config.hasQaPartner ?? task.qaAgentId === QA.id;
  const calls: Record<string, unknown[][]> = {
    dispatchServerReviewToQa: [],
    computeCodeInterdiff: [],
    dispatchServerFixToDev: [],
    dispatchServerAfterDone: [],
    dispatchServerFeedbackCorrection: [],
    transitionTaskStatus: [],
    updateTask: [],
    updateTaskIfStatus: [],
    transitionToCodePhase: [],
    parkTaskAtSpecReady: [],
    setupPhaseSignal: [],
    holdAgentForUnarmedSignal: [],
    claimServerSignalRecovery: [],
    holdConsumedServerSignal: [],
    setServerSignalRecoveryMode: [],
    holdServerSignalRecovery: [],
    releaseAgentForTask: [],
  };
  let successor = 0;
  const nextToken = (): string => (++successor).toString(16).padStart(12, '0');
  const transport = {
    readContent: vi.fn(async (_task: TaskState, _agent: typeof DEV, phase: 'code' | 'spec') => {
      const content = 'diff --git a/a.ts b/a.ts\n+x';
      const documents = [{ relPath: '.baxian/spec.md', content }];
      return {
        content: phase === 'spec' ? renderSpecDocuments(documents) : content,
        documents,
        diffstat: ' a.ts | 1 +',
        baseSha: 'base123',
        headSha: 'head123',
        headTree: 'tree123',
        defaultBranch: 'main',
      };
    }),
    readFindings: vi.fn(async (): Promise<ReviewFindings | null> => null),
    readResponse: vi.fn(async (): Promise<ReviewResponse | null> => null),
    readResponseWithRaw: vi.fn(async (snapshot: TaskState) => {
      try {
        const response = await transport.readResponse(snapshot, DEV);
        if (!response) return { kind: 'absent' as const };
        const phase = snapshot.phase === 'spec' ? 'spec' : 'code';
        const round = phase === 'spec' ? Math.max(snapshot.specReviewRound ?? 1, 1) : Math.max(snapshot.reviewRound, 1);
        const stored = await store.getRound(snapshot.id, phase, round);
        const normalized = {
          ...response,
          token: response.token ?? snapshot.signalToken,
          findingsDigest: response.findingsDigest
            ?? (stored?.findings ? reviewFindingsDigest(stored.findings) : '0'.repeat(64)),
        };
        const raw = JSON.stringify(normalized);
        return { kind: 'ok' as const, raw, responseDigest: sha256Hex(raw), response: normalized };
      } catch (error) {
        return { kind: 'unknown' as const, error };
      }
    }),
    deleteFindings: vi.fn(async () => undefined),
    deleteResponse: vi.fn(async () => undefined),
    readFileRange: vi.fn(async () => ''),
    readHeadSha: vi.fn(async () => 'head123'),
  };
  const transitionTaskStatus = vi.fn(async (
    id: string,
    to: TaskState['status'],
    guard?: { expectTask?: TaskGenerationGuard },
    patch?: unknown,
  ) => {
    calls.transitionTaskStatus.push([id, to]);
    if (guard?.expectTask && !taskMatchesGeneration(task, guard.expectTask)) return null;
    const previousStatus = task.status;
    task.status = to;
    if (patch && typeof patch === 'object') Object.assign(task, patch);
    return { task, previousStatus };
  });
  const releaseAgentForTask = vi.fn(async (agentId: string, taskId: string, mode: string, opts?: unknown) => {
    calls.releaseAgentForTask.push([agentId, taskId, mode, opts]);
    return true;
  });
  const getAgentState = vi.fn(async (agentId: string) => ({
    id: agentId, projectId: 'proj', taskId: task.id, updatedAt: 'now',
  }));
  const updateTask = vi.fn(async (id: string, patch: Partial<TaskState>) => {
    calls.updateTask.push([id, patch]);
    Object.assign(task, patch);
  });
  const transitionToCodePhase = vi.fn(async (
    id: string,
    expectedTask?: TaskGenerationGuard,
  ) => {
    calls.transitionToCodePhase.push([id]);
    if (expectedTask && !taskMatchesGeneration(task, expectedTask)) return null;
    return task;
  });
  const findLineageViolation = vi.fn(async (): Promise<unknown> => null);
  const parkTaskAtSpecReady = vi.fn(async (
    id: string,
    opts?: { specReviewRound?: number; expectedTask?: TaskGenerationGuard },
  ) => {
    const recorded = opts?.specReviewRound === undefined
      ? undefined
      : { specReviewRound: opts.specReviewRound };
    calls.parkTaskAtSpecReady.push(recorded === undefined ? [id] : [id, recorded]);
    if (opts?.expectedTask && !taskMatchesGeneration(task, opts.expectedTask)) return null;
    task.status = 'spec-ready';
    if (opts?.specReviewRound !== undefined) task.specReviewRound = opts.specReviewRound;
    return task;
  });
  const projectConfig = {
    id: 'proj', repo: 'u/r', merge: null,
    ...(config.specApproval !== undefined ? { specApproval: config.specApproval } : {}),
    agent: [],
  };
  const updateTaskIfStatus = vi.fn(async (
    id: string,
    expectedStatus: TaskState['status'],
    patch: Partial<TaskState>,
    alsoExpect: Partial<Pick<
      TaskState,
      'signalToken' | 'phase' | 'agentId' | 'reviewRound' | 'specReviewRound'
    >> = {},
  ) => {
    calls.updateTaskIfStatus.push([id, expectedStatus, patch, alsoExpect]);
    if (id !== task.id || task.status !== expectedStatus) return false;
    for (const [field, expected] of Object.entries(alsoExpect)) {
      if (task[field as keyof TaskState] !== expected) return false;
    }
    Object.assign(task, patch);
    return true;
  });
  const claimServerSignalRecovery = vi.fn(async (
    entry: TaskState,
    agentId: string,
    signalKind: NonNullable<TaskState['serverSignalRecovery']>['signalKind'],
    input: Omit<NonNullable<TaskState['serverSignalRecovery']>, 'signalKind' | 'sourceToken' | 'createdAt'>,
  ) => {
    calls.claimServerSignalRecovery.push([entry, agentId, signalKind, input]);
    if (!entry.signalToken) return null;
    const token = nextToken();
    const recovery = {
      ...input,
      signalKind,
      sourceToken: entry.signalToken,
      missingFindingIds: [...(input.missingFindingIds ?? [])].sort(),
      unknownFindingIds: [...(input.unknownFindingIds ?? [])].sort(),
      schemaViolationCodes: [...(input.schemaViolationCodes ?? [])].sort(),
      createdAt: '2026-06-10T00:01:00.000Z',
    };
    const guarded = await updateTaskIfStatus(entry.id, entry.status, {
      signalToken: token,
      serverSignalRecovery: recovery,
    }, {
      signalToken: entry.signalToken,
      phase: entry.phase,
      ...(input.phase === 'spec'
        ? { specReviewRound: entry.specReviewRound }
        : { reviewRound: entry.reviewRound }),
    });
    return guarded ? { ...task } : null;
  });
  const setServerSignalRecoveryMode = vi.fn(async (
    id: string,
    token: string,
    mode: 'correct-response' | 'hold',
  ) => {
    calls.setServerSignalRecoveryMode.push([id, token, mode]);
    if (id !== task.id || task.signalToken !== token || !task.serverSignalRecovery) return null;
    task.serverSignalRecovery = { ...task.serverSignalRecovery, mode };
    return { ...task };
  });
  const holdServerSignalRecovery = vi.fn(async (
    id: string,
    agentId: string,
    token: string,
    phase: string,
    reason: string,
  ) => {
    calls.holdServerSignalRecovery.push([id, agentId, token, phase, reason]);
    return setServerSignalRecoveryMode(id, token, 'hold');
  });
  const holdConsumedServerSignal = vi.fn(async (
    entry: TaskState,
    agentId: string,
    signalKind: NonNullable<TaskState['serverSignalRecovery']>['signalKind'],
    input: {
      phase: 'spec' | 'code';
      round: number;
      reason: NonNullable<TaskState['serverSignalRecovery']>['reason'];
      failurePhase: string;
    },
  ) => {
    calls.holdConsumedServerSignal.push([entry, agentId, signalKind, input]);
    return claimServerSignalRecovery(entry, agentId, signalKind, { mode: 'hold', ...input });
  });
  const dispatchServerReviewToQa = vi.fn(async (id: string, opts: unknown): Promise<TaskState | null> => {
    calls.dispatchServerReviewToQa.push([id, opts]);
    task.status = 'review';
    return task;
  });
  const commitServerAfterDone = vi.fn(async (
    _id: string,
    expectedTask?: TaskGenerationGuard,
  ) => {
    if (expectedTask && !taskMatchesGeneration(task, expectedTask)) {
      throw new Error('dispatch-superseded');
    }
    const afterDone = task.afterDone !== undefined ? task.afterDone : (config.afterDone ?? null);
    task.afterDone = afterDone;
    return afterDone;
  });
  const deleteReviewExchangeIfCurrent = vi.fn(async (
    id: string,
    agent: typeof DEV | typeof QA,
    artifact: 'findings' | 'response',
    expectedTask: TaskGenerationGuard,
    expectedRecovery?: Pick<
      NonNullable<TaskState['serverSignalRecovery']>,
      'mode' | 'signalKind' | 'phase' | 'round' | 'sourceToken' | 'failureSignature' | 'createdAt'
    >,
  ) => {
    if (id !== task.id || !taskMatchesGeneration(task, expectedTask)) return false;
    const recovery = task.serverSignalRecovery;
    if (expectedRecovery && (
      !recovery
      || recovery.mode !== expectedRecovery.mode
      || recovery.signalKind !== expectedRecovery.signalKind
      || recovery.phase !== expectedRecovery.phase
      || recovery.round !== expectedRecovery.round
      || recovery.sourceToken !== expectedRecovery.sourceToken
      || recovery.failureSignature !== expectedRecovery.failureSignature
      || recovery.createdAt !== expectedRecovery.createdAt
    )) return false;
    if (artifact === 'findings') {
      await transport.deleteFindings(agent);
    } else {
      await transport.deleteResponse(agent);
    }
    return true;
  });
  const manager = {
    getReviewStore: () => store,
    putReviewRoundIfCurrent: vi.fn(async (
      id: string,
      data: ReviewRound,
      expectedTask: TaskGenerationGuard,
    ) => {
      if (id !== task.id || !taskMatchesGeneration(task, expectedTask)) return false;
      await store.putRound(id, data.phase, data);
      return true;
    }),
    deleteReviewExchangeIfCurrent,
    getProjectConfig: (id: string) => (id === 'proj' ? projectConfig : undefined),
    parkTaskAtSpecReady,
    getReviewTransport: () => transport,
    getTask: async () => ({ ...task }),
    getAgentConfig: (id: string) => (
      id === DEV.id ? DEV
      : id === RESEARCH.id ? RESEARCH
      : id === QA.id && hasQaPartner ? QA
      : undefined
    ),
    findQaPartner: (devId: string) => (devId === DEV.id && hasQaPartner ? QA : undefined),
    getConfig: () => ({
      review: { rounds: config.rounds ?? 10, mode: 'server', afterDone: config.afterDone ?? null },
      server: DEFAULT_SERVER_CONFIG,
      host: [],
      project: [projectConfig],
    }),
    refreshWorkdirCacheFor: async () => '/wt',
    transitionTaskStatus,
    releaseAgentForTask,
    getAgentState,
    updateTask,
    updateTaskIfStatus,
    claimServerSignalRecovery,
    holdConsumedServerSignal,
    setServerSignalRecoveryMode,
    holdServerSignalRecovery,
    findLineageViolation,
    computeCodeInterdiff: vi.fn(async (id: string, round: number) => {
      calls.computeCodeInterdiff.push([id, round]);
      if (config.interdiffThrows) throw new Error('git diff failed: bad object');
      return config.interdiff ?? { ok: false, reason: 'no-anchor' };
    }),
    dispatchServerReviewToQa,
    dispatchServerFixToDev: vi.fn(async (id: string, findings: string, opts?: unknown) => {
      calls.dispatchServerFixToDev.push([id, findings, opts]);
      task.status = 'fixing';
      return task;
    }),
    dispatchServerFeedbackCorrection: vi.fn(async (id: string, findings: string) => {
      calls.dispatchServerFeedbackCorrection.push([id, findings]);
      if (id !== task.id || task.serverSignalRecovery?.mode !== 'correct-response') return false;
      task.serverSignalRecovery = undefined;
      return true;
    }),
    dispatchServerAfterDone: vi.fn(async (id: string, kind: string) => {
      calls.dispatchServerAfterDone.push([id, kind]);
      return task;
    }),
    transitionToCodePhase,
    setupPhaseSignal: vi.fn(async (id: string, agentId: string, kinds: unknown) => {
      calls.setupPhaseSignal.push([id, agentId, kinds]);
      return agentId === DEV.id || agentId === QA.id;
    }),
    holdAgentForUnarmedSignal: vi.fn(async (id: string, agentId: string, kinds: unknown) => {
      calls.holdAgentForUnarmedSignal.push([id, agentId, kinds]);
    }),
    verifyPaneSignalPrNumber: vi.fn(async () =>
      (config.verifyPr ?? true)
        ? { headRefName: 'bx/t1', headSha: config.verifiedHeadSha ?? 'head123', targetBranch: 'main' }
        : undefined),
    resolveAfterDone: (t: TaskState) =>
      t.afterDone !== undefined ? t.afterDone : (config.afterDone ?? null),
    commitServerAfterDone,
    setServerReviewDriver: (d: ServerReviewDriver) => { driverRef.current = d; },
  } as unknown as AgentManager;

  registerServerEventHandlers(bus, manager);

  const emit = async (type: string, data: Record<string, unknown>) => {
    await bus.emit({
      id: '',
      type: type as BaxianEvent['type'],
      timestamp: new Date().toISOString(),
      projectId: 'proj',
      taskId: task.id,
      data,
    });
  };
  return {
    bus,
    store,
    task,
    calls,
    transport,
    releaseAgentForTask,
    getAgentState,
    transitionTaskStatus,
    transitionToCodePhase,
    parkTaskAtSpecReady,
    updateTask,
    dispatchServerReviewToQa,
    deleteReviewExchangeIfCurrent,
    holdConsumedServerSignal,
    claimServerSignalRecovery,
    commitServerAfterDone,
    driver: driverRef,
    findLineageViolation,
    emitted,
    emit,
  };
}

const FINDINGS_RC: ReviewFindings = {
  round: 1,
  verdict: 'request-changes',
  findings: [{ id: 'f-1', severity: 'major', message: 'broken', file: 'a.ts', line: 1 }],
};

const APPROVE_R1: ReviewFindings = { round: 1, verdict: 'approve', findings: [] };

function putRound(
  store: ReviewStore,
  phase: 'code' | 'spec',
  round: number,
  extra: Partial<ReviewRound> = {},
): Promise<void> {
  const content = extra.content ?? (phase === 'spec' ? 's' : 'd');
  return store.putRound('t1', phase, {
    round,
    phase,
    ...extra,
    content,
    ...(phase === 'spec' ? {
      documents: extra.documents ?? [{ relPath: '.baxian/spec.md', content }],
    } : {}),
    startedAt: extra.startedAt ?? 'now',
  });
}

type SeedRound = { phase: 'code' | 'spec'; round: number; extra?: Partial<ReviewRound> };

interface Scenario {
  task?: Partial<TaskState>;
  config?: Parameters<typeof makeFixture>[1];
  seed?: SeedRound;
  findings?: ReviewFindings | null;
  response?: ReviewResponse | null;
  emit: [string, string, Record<string, unknown>?];
}

async function runScenario(s: Scenario): Promise<Fixture> {
  const fx = makeFixture(s.task, s.config);
  if (s.seed) await putRound(fx.store, s.seed.phase, s.seed.round, s.seed.extra);
  if (s.findings !== undefined) fx.transport.readFindings.mockResolvedValue(s.findings);
  if (s.response !== undefined) fx.transport.readResponse.mockResolvedValue(s.response);
  const [type, kind, extra] = s.emit;
  await fx.emit(type, { token: 'tok123', kind, ...extra });
  return fx;
}

function expectConsumedSignalFenced(fx: Fixture, agentId: string, kind: string): void {
  expect(fx.calls.setupPhaseSignal).toHaveLength(0);
  const claim = fx.calls.claimServerSignalRecovery.find(call => call[1] === agentId && call[2] === kind);
  expect(claim).toBeDefined();
  expect((claim?.[0] as TaskState | undefined)?.signalToken).toBe('tok123');
  expect(fx.task.signalToken).not.toBe('tok123');
}

function bigFile(path: string): string {
  return `diff --git a/${path} b/${path}\n${Array.from({ length: 1500 }, (_, i) => `+l${i}`).join('\n')}`;
}

const TWO_BATCH_DIFF = [
  `diff --git a/src/a.ts b/src/a.ts\n${Array.from({ length: 2100 }, () => '+x').join('\n')}`,
  'diff --git a/lib/b.ts b/lib/b.ts\n+y',
].join('\n');

describe('server.code.ready', () => {
  it('accepts code-done when an unphased Dev-SDD task chose direct implementation', async () => {
    const fx = makeFixture({ phase: undefined });

    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });

    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
  });

  it('rejects code-done while a Research participant still owns the spec stage', async () => {
    const fx = makeFixture({
      preferredAgentId: 'research-1',
      agentId: 'research-1',
      researchAgentId: 'research-1',
      phase: 'research',
    });

    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });

    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
    expect(fx.emitted.some(event => event.type === 'human.intervention'
      && event.data?.phase === 'server.code.ready-stale')).toBe(true);
  });

  it('reads diff, persists round with baseSha, dispatches review', async () => {
    const fx = makeFixture();
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    const round = await fx.store.getRound('t1', 'code', 1);
    expect(round?.baseSha).toBe('base123');
    expect(round?.headSha).toBe('head123');
    expect(round?.headTree).toBe('tree123');
    expect(round?.content).toContain('diff --git');
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, {
      content: string;
      recheck: boolean;
      baseSha?: string;
      headTree?: string;
      expectedTask?: unknown;
    }];
    expect(opts.recheck).toBe(false);
    expect(opts.content).toContain('diff --git');
    expect(opts.baseSha).toBe('base123');
    expect(opts.headTree).toBe('tree123');
    expect(opts.expectedTask).toEqual({
      status: 'in_progress',
      phase: 'code',
      signalToken: 'tok123',
      agentId: 'dev-1',
      reviewRound: 0,
      specReviewRound: undefined,
    });
  });

  it('token mismatch → no dispatch', async () => {
    const fx = makeFixture();
    await fx.emit('server.code.ready', { token: 'WRONG', kind: 'code-done' });
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });

  it('lineage violation blocks dispatch and fences the consumed entry signal', async () => {
    const fx = makeFixture();
    fx.findLineageViolation.mockResolvedValue({ taskId: 't-other', branch: 'bx/t-other', sha: 'a'.repeat(40) });
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expect(fx.findLineageViolation).toHaveBeenCalledWith('t1', 'base123');
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
    const intervention = fx.emitted.find(e => e.type === 'human.intervention');
    expect(intervention?.data).toMatchObject({
      phase: 'server-code-lineage-violation',
      offendingTaskId: 't-other',
      offendingBranch: 'bx/t-other',
    });
    expectConsumedSignalFenced(fx, 'dev-1', 'code-done');
  });

  it('lineage check failure blocks dispatch and fences the consumed entry signal', async () => {
    const fx = makeFixture();
    fx.findLineageViolation.mockRejectedValue(new Error('rev-list exploded'));
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
    const intervention = fx.emitted.find(e => e.type === 'human.intervention');
    expect(intervention?.data).toMatchObject({ phase: 'server-code-lineage-check-failed' });
    expectConsumedSignalFenced(fx, 'dev-1', 'code-done');
  });

  it('round cap → max_rounds', async () => {
    const fx = makeFixture({ reviewRound: 3 }, { rounds: 3 });
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expect(fx.calls.transitionTaskStatus).toContainEqual(['t1', 'max_rounds']);
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });

  it('large diff dispatches once with the full content and review head metadata', async () => {
    const fx = makeFixture();
    const content = [bigFile('src/a.ts'), bigFile('lib/b.ts')].join('\n');
    fx.transport.readContent.mockResolvedValue({
      content,
      diffstat: 'stat',
      baseSha: 'base123',
      headSha: 'head123',
      headTree: 'tree123',
    });
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, {
      batch?: { index: number; total: number };
      content: string;
      baseSha?: string;
      headTree?: string;
    }];
    expect(opts.batch).toBeUndefined();
    expect(opts.content).toBe(content);
    expect(opts.baseSha).toBe('base123');
    expect(opts.headTree).toBe('tree123');
    const round = await fx.store.getRound('t1', 'code', 1);
    expect(round?.batchFindings).toBeUndefined();
    expect(round?.headSha).toBe('head123');
    expect(round?.headTree).toBe('tree123');
  });
});

describe('no-QA auto-approve', () => {
  it('code-done without QA partner → auto-approve to ready (afterDone null)', async () => {
    const fx = makeFixture({ qaAgentId: undefined });
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
    expect(fx.calls.transitionTaskStatus).toContainEqual(['t1', 'ready']);
  });

  it('code-done without QA partner → auto-approve to approved + afterDone with reviewHeadAnchorSha', async () => {
    const fx = makeFixture({ qaAgentId: undefined }, { afterDone: 'branch' });
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
    expect(fx.transport.readHeadSha).toHaveBeenCalled();
    expect(fx.calls.transitionTaskStatus).toContainEqual(['t1', 'approved']);
    const approvedCall = fx.transitionTaskStatus.mock.calls.find(
      (c: unknown[]) => c[1] === 'approved',
    )!;
    expect(approvedCall[3]).toEqual({ reviewHeadAnchorSha: 'head123' });
    expect(fx.calls.dispatchServerAfterDone).toContainEqual(['t1', 'branch']);
  });

  it('does not auto-approve a successor code generation while reading the head sha', async () => {
    const fx = makeFixture({ qaAgentId: undefined }, { afterDone: 'branch' });
    const expectedTask = generationOf(fx.task);
    fx.transport.readHeadSha.mockImplementationOnce(async () => {
      fx.task.signalToken = 'successor-token';
      return 'head123';
    });

    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });

    const approvedCall = fx.transitionTaskStatus.mock.calls.find(call => call[1] === 'approved');
    expect(approvedCall?.[2]).toMatchObject({ expectTask: expectedTask });
    expect(fx.task).toMatchObject({ status: 'in_progress', signalToken: 'successor-token' });
    expect(fx.calls.dispatchServerAfterDone).toHaveLength(0);
  });

  it('code-done without QA partner → head capture failure fences code-done', async () => {
    const fx = makeFixture({ qaAgentId: undefined }, { afterDone: 'branch' });
    fx.transport.readHeadSha.mockRejectedValueOnce(new Error('git failed'));
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expect(fx.calls.transitionTaskStatus).toHaveLength(0);
    expectConsumedSignalFenced(fx, 'dev-1', 'code-done');
    expect(fx.emitted.some(e => e.type === 'human.intervention'
      && (e.data as Record<string, unknown>)?.phase === 'server-code-auto-approve-head-capture-failed')).toBe(true);
  });

  it('spec-done without QA partner → auto-approve spec, transition to code phase', async () => {
    const fx = makeFixture({ qaAgentId: undefined, phase: undefined });
    await fx.emit('server.spec.ready', { token: 'tok123', kind: 'spec-done' });
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
    const round = await fx.store.getRound('t1', 'spec', 1);
    expect(round?.documents).toEqual([
      { relPath: '.baxian/spec.md', content: 'diff --git a/a.ts b/a.ts\n+x' },
    ]);
    expect(round?.content).toBe(renderSpecDocuments(round!.documents!));
    expect(fx.calls.transitionToCodePhase).toContainEqual(['t1']);
  });

  it('does not auto-approve a successor spec generation after content capture', async () => {
    const fx = makeFixture({ qaAgentId: undefined, phase: undefined });
    fx.transport.readContent.mockImplementationOnce(async () => {
      fx.task.signalToken = 'successor-token';
      const documents = [{ relPath: '.baxian/spec.md', content: '# Spec' }];
      return { content: renderSpecDocuments(documents), documents };
    });

    await fx.emit('server.spec.ready', { token: 'tok123', kind: 'spec-done' });

    expect(fx.transitionToCodePhase).not.toHaveBeenCalled();
    expect(fx.task).toMatchObject({ status: 'in_progress', signalToken: 'successor-token' });
  });

  it('no-QA afterDone publish lifecycle: code-done → approved → published → ready', async () => {
    const fx = makeFixture({ qaAgentId: undefined }, { afterDone: 'branch' });
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expect(fx.task.reviewHeadAnchorSha).toBe('head123');
    expect(fx.task.status).toBe('approved');
    fx.task.signalToken = 'pub-tok';
    await fx.emit('server.code.published', { token: 'pub-tok', kind: 'code-ready', prNumber: 42 });
    expect(fx.calls.transitionTaskStatus).toContainEqual(['t1', 'ready']);
  });

  it('code-done WITH QA partner still dispatches review', async () => {
    const fx = makeFixture();
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
  });
});

describe('server.code.review.submitted', () => {
  it('approve + afterDone null → ready', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 1 });
    await putRound(fx.store, 'code', 1);
    fx.transport.readFindings.mockResolvedValue(APPROVE_R1);
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    expect(fx.calls.transitionTaskStatus).toContainEqual(['t1', 'ready']);
    expect(fx.transport.deleteFindings).toHaveBeenCalled();
    const round = await fx.store.getRound('t1', 'code', 1);
    expect(round?.findings?.verdict).toBe('approve');
    expect(round?.completedAt).toBeTruthy();
  });

  it('approve + afterDone pr → approved + dispatchServerAfterDone', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 1 }, { afterDone: 'pr' });
    await putRound(fx.store, 'code', 1);
    fx.transport.readFindings.mockResolvedValue(APPROVE_R1);
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    expect(fx.calls.transitionTaskStatus).toContainEqual(['t1', 'approved']);
    expect(fx.calls.dispatchServerAfterDone).toContainEqual(['t1', 'pr']);
  });

  it('request-changes → dispatchServerFixToDev with findings json', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 1 });
    await putRound(fx.store, 'code', 1);
    fx.transport.readFindings.mockResolvedValue(FINDINGS_RC);
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    expect(fx.calls.dispatchServerFixToDev).toHaveLength(1);
    const [, json, opts] = fx.calls.dispatchServerFixToDev[0] as [string, string, {
      expectedTask?: unknown;
    }];
    expect(JSON.parse(json).findings[0].id).toBe('f-1');
    expect(opts.expectedTask).toEqual({
      status: 'review',
      phase: 'code',
      signalToken: 'tok123',
      agentId: 'dev-1',
      reviewRound: 1,
      specReviewRound: undefined,
    });
  });

  it('legacy batch fields continue to the next batch during the compatibility window', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 1, batchIndex: 0, batchTotal: 2 });
    await putRound(fx.store, 'code', 1, { content: TWO_BATCH_DIFF, diffstat: 'FULL-SCOPE-STAT', batchFindings: [] });
    fx.transport.readFindings.mockResolvedValue(FINDINGS_RC);
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    const round = await fx.store.getRound('t1', 'code', 1);
    expect(round?.findings).toBeUndefined();
    expect(round?.batchFindings?.[0]?.findings[0].id).toBe('f-1');
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, {
      continuation?: boolean;
      batch?: { index: number; total: number };
      content: string;
      diffstat?: string;
      expectedTask?: unknown;
    }];
    expect(opts.continuation).toBe(true);
    expect(opts.batch).toEqual({ index: 1, total: 2 });
    expect(opts.content).toContain('diff --git a/lib/b.ts');
    expect(opts.diffstat).toBe('FULL-SCOPE-STAT');
    expect(opts.expectedTask).toEqual({
      status: 'review',
      phase: 'code',
      signalToken: 'tok123',
      agentId: 'dev-1',
      reviewRound: 1,
      specReviewRound: undefined,
    });
    expect(fx.calls.dispatchServerFixToDev).toHaveLength(0);
  });

  it('legacy final-batch state aggregates namespaced findings and routes the combined verdict', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 1, batchIndex: 1, batchTotal: 2 });
    await putRound(fx.store, 'code', 1, {
      batchFindings: [{ round: 1, verdict: 'approve', findings: [{ id: 'f-1', severity: 'minor', message: 'nit' }] }],
    });
    fx.transport.readFindings.mockResolvedValue(FINDINGS_RC);
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    const round = await fx.store.getRound('t1', 'code', 1);
    expect(round?.findings?.verdict).toBe('request-changes');
    expect(round?.findings?.findings.map(f => f.id)).toEqual(['b0-f-1', 'b1-f-1']);
    expect(fx.calls.updateTaskIfStatus).toContainEqual([
      't1',
      'review',
      { batchIndex: undefined, batchTotal: undefined },
      expect.objectContaining({
        signalToken: 'tok123',
        agentId: 'dev-1',
        reviewRound: 1,
      }),
    ]);
    expect(fx.calls.dispatchServerFixToDev).toHaveLength(1);
  });

  it('does not clear final-batch metadata from a successor review generation', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 1, batchIndex: 1, batchTotal: 2 });
    await putRound(fx.store, 'code', 1, {
      batchFindings: [{ round: 1, verdict: 'approve', findings: [] }],
    });
    fx.transport.readFindings.mockImplementationOnce(async () => {
      fx.task.signalToken = 'successor-token';
      await putRound(fx.store, 'code', 1, {
        content: 'successor diff',
        findings: APPROVE_R1,
      });
      return FINDINGS_RC;
    });

    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });

    expect(fx.calls.updateTaskIfStatus).toHaveLength(0);
    expect(await fx.store.getRound('t1', 'code', 1)).toMatchObject({
      content: 'successor diff',
      findings: APPROVE_R1,
    });
    expect(fx.task).toMatchObject({
      signalToken: 'successor-token',
      batchIndex: 1,
      batchTotal: 2,
    });
    expect(fx.calls.dispatchServerFixToDev).toHaveLength(0);
  });
});

describe('server.code.fix.submitted', () => {
  it('coverage gap → intervention, no recheck dispatch', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponse.mockResolvedValue({ round: 1, responses: [] });
    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });
    expect(fx.emitted.some(e => e.type === 'human.intervention'
      && (e.data as { phase?: string }).phase === 'server-code-response-coverage-gap')).toBe(true);
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
    expectConsumedSignalFenced(fx, 'dev-1', 'code-fixed');
  });

  it('ignores old-marker redraws and stops a rewritten response with the same logical gap', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponse.mockResolvedValue({ round: 1, responses: [] });

    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });
    const correctionToken = fx.task.signalToken!;
    const interventionCount = fx.emitted.filter(event => event.type === 'human.intervention').length;
    for (let index = 0; index < 100; index++) {
      await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });
    }
    expect(fx.calls.claimServerSignalRecovery).toHaveLength(1);
    expect(fx.emitted.filter(event => event.type === 'human.intervention')).toHaveLength(interventionCount);

    const findingsDigest = reviewFindingsDigest(FINDINGS_RC);
    const raw = `{ "round": 1, "token": "${correctionToken}", "findingsDigest": "${findingsDigest}", "responses": [ ] }`;
    fx.transport.readResponseWithRaw.mockResolvedValueOnce({
      kind: 'ok',
      raw,
      responseDigest: sha256Hex(raw),
      response: { round: 1, token: correctionToken, findingsDigest, responses: [] },
    });
    await fx.emit('server.code.fix.submitted', { token: correctionToken, kind: 'code-fixed' });

    const stored = await fx.store.getRound('t1', 'code', 1);
    expect(stored?.serverResponseFailures?.map(entry => entry.disposition)).toEqual([
      'auto-correct',
      'hold-repeated-signature',
    ]);
    expect(fx.calls.dispatchServerFeedbackCorrection).toHaveLength(1);
    expect(fx.transport.deleteResponse).toHaveBeenCalledTimes(1);
    expect(fx.task.serverSignalRecovery?.mode).toBe('hold');
    expect(interventionPhases(fx)).toContain('server-feedback-response-repeated');
  });

  it('stops after three distinct automatic correction generations', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    const findingsDigest = reviewFindingsDigest(FINDINGS_RC);
    const submit = async (response: ReviewResponse): Promise<void> => {
      const raw = JSON.stringify(response);
      fx.transport.readResponseWithRaw.mockResolvedValueOnce({
        kind: 'ok', raw, responseDigest: sha256Hex(raw), response,
      });
      await fx.emit('server.code.fix.submitted', { token: fx.task.signalToken, kind: 'code-fixed' });
    };

    await submit({
      round: 1, token: fx.task.signalToken, findingsDigest, responses: [],
    });
    await submit({
      round: 1, token: 'ffffffffffff', findingsDigest,
      responses: [{ findingId: 'f-1', action: 'fix', rationale: 'fixed' }],
    });
    await submit({
      round: 1, token: fx.task.signalToken, findingsDigest: 'f'.repeat(64),
      responses: [{ findingId: 'f-1', action: 'fix', rationale: 'fixed' }],
    });
    await submit({
      round: 2, token: fx.task.signalToken, findingsDigest,
      responses: [{ findingId: 'f-1', action: 'fix', rationale: 'fixed' }],
    });

    const failures = (await fx.store.getRound('t1', 'code', 1))?.serverResponseFailures ?? [];
    expect(failures.map(entry => entry.disposition)).toEqual([
      'auto-correct', 'auto-correct', 'auto-correct', 'hold-correction-limit',
    ]);
    expect(fx.calls.dispatchServerFeedbackCorrection).toHaveLength(3);
    expect(fx.task.serverSignalRecovery?.mode).toBe('hold');
    expect(interventionPhases(fx)).toContain('server-feedback-correction-limit');
  });

  it('retries an unknown response read in-handler and preserves the source token on recovery', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    const unknown = {
      kind: 'unknown' as const,
      error: new ReviewExchangeError('read-unknown', 'ssh disconnected'),
    };
    const findingsDigest = reviewFindingsDigest(FINDINGS_RC);
    const response: ReviewResponse = {
      round: 1,
      token: 'tok123',
      findingsDigest,
      responses: [{ findingId: 'f-1', action: 'fix', rationale: 'fixed' }],
    };
    const raw = JSON.stringify(response);
    fx.transport.readResponseWithRaw
      .mockResolvedValueOnce(unknown)
      .mockResolvedValueOnce({ kind: 'ok', raw, responseDigest: sha256Hex(raw), response });

    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });

    expect(fx.transport.readResponseWithRaw).toHaveBeenCalledTimes(2);
    expect(fx.calls.claimServerSignalRecovery).toHaveLength(0);
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
  });

  it('fences once and preserves the response after three unknown reads', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponseWithRaw.mockResolvedValue({
      kind: 'unknown',
      error: new ReviewExchangeError('read-unknown', 'ssh disconnected'),
    });

    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });

    expect(fx.transport.readResponseWithRaw).toHaveBeenCalledTimes(3);
    expectConsumedSignalFenced(fx, 'dev-1', 'code-fixed');
    expect(fx.transport.deleteResponse).not.toHaveBeenCalled();
    expect(interventionPhases(fx)).toEqual(['server-code-response-read-failed']);
  });

  it('unknown findingId → intervention, audit, token fence, and correction dispatch', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponse.mockResolvedValue({
      round: 1,
      responses: [
        { findingId: 'f-1', action: 'fix', rationale: 'done', commitSha: 'abc' },
        { findingId: 'f99', action: 'fix', rationale: 'hallucinated', commitSha: 'def' },
      ],
    });
    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });
    const gap = fx.emitted.find(e => e.type === 'human.intervention'
      && (e.data as { phase?: string }).phase === 'server-code-response-coverage-gap');
    expect(gap).toBeDefined();
    expect((gap?.data as { unknownFindingIds?: string[] }).unknownFindingIds).toContain('f99');
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
    expect(fx.transport.deleteResponse).toHaveBeenCalled();
    const round = await fx.store.getRound('t1', 'code', 1);
    expect(round?.response).toBeUndefined();
    expectConsumedSignalFenced(fx, 'dev-1', 'code-fixed');
  });

  it('full coverage → response stored, recheck dispatched with priors', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponse.mockResolvedValue({
      round: 1,
      responses: [{ findingId: 'f-1', action: 'fix', rationale: 'done', commitSha: 'abc' }],
    });
    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });
    const round1 = await fx.store.getRound('t1', 'code', 1);
    expect(round1?.response?.responses[0].action).toBe('fix');
    expect(fx.transport.deleteResponse).toHaveBeenCalled();
    const round2 = await fx.store.getRound('t1', 'code', 2);
    expect(round2?.content).toContain('diff --git');
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, {
      recheck: boolean;
      priorFindingsJson?: string;
      expectedTask?: unknown;
    }];
    expect(opts.recheck).toBe(true);
    expect(opts.priorFindingsJson).toContain('f-1');
    expect(opts.expectedTask).toEqual({
      status: 'fixing',
      phase: 'code',
      signalToken: 'tok123',
      agentId: 'dev-1',
      reviewRound: 1,
      specReviewRound: undefined,
    });
  });

  it('recheck: computes the round interdiff and forwards it to the QA dispatch', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 }, { interdiff: { ok: true, diff: 'ROUND2-DELTA' } });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponse.mockResolvedValue({
      round: 1,
      responses: [{ findingId: 'f-1', action: 'fix', rationale: 'done', commitSha: 'abc' }],
    });
    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });
    expect(fx.calls.computeCodeInterdiff).toContainEqual(['t1', 2]);
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { recheck: boolean; interdiff?: string }];
    expect(opts.recheck).toBe(true);
    expect(opts.interdiff).toBe('ROUND2-DELTA');
  });

  it('recheck: interdiff unavailable degrades gracefully — dispatch proceeds with no interdiff payload', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 }, { interdiff: { ok: false, reason: 'released' } });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponse.mockResolvedValue({
      round: 1,
      responses: [{ findingId: 'f-1', action: 'fix', rationale: 'done', commitSha: 'abc' }],
    });
    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { recheck: boolean; interdiff?: string }];
    expect(opts.recheck).toBe(true);
    expect(opts.interdiff).toBeUndefined();
  });

  it('recheck: an interdiff computation error degrades gracefully — recheck is not blocked', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 }, { interdiffThrows: true });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponse.mockResolvedValue({
      round: 1,
      responses: [{ findingId: 'f-1', action: 'fix', rationale: 'done', commitSha: 'abc' }],
    });
    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { recheck: boolean; interdiff?: string }];
    expect(opts.recheck).toBe(true);
    expect(opts.interdiff).toBeUndefined();
  });

  it('recheck: an empty interdiff is treated as unavailable (no empty payload)', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 }, { interdiff: { ok: true, diff: '   \n' } });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponse.mockResolvedValue({
      round: 1,
      responses: [{ findingId: 'f-1', action: 'fix', rationale: 'done', commitSha: 'abc' }],
    });
    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { interdiff?: string }];
    expect(opts.interdiff).toBeUndefined();
  });

  it('recheck large diff carries interdiff on the single dispatch', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 }, { interdiff: { ok: true, diff: 'ROUND2-DELTA' } });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponse.mockResolvedValue({
      round: 1,
      responses: [{ findingId: 'f-1', action: 'fix', rationale: 'done', commitSha: 'abc' }],
    });
    fx.transport.readContent.mockResolvedValue({
      content: [bigFile('src/a.ts'), bigFile('lib/b.ts')].join('\n'),
      diffstat: 'stat', baseSha: 'base123', headSha: 'head123', headTree: 'tree123',
    });
    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { batch?: { index: number }; interdiff?: string }];
    expect(opts.batch).toBeUndefined();
    expect(opts.interdiff).toBe('ROUND2-DELTA');
  });

  it('initial review (round 1) carries no interdiff and never computes one', async () => {
    const fx = makeFixture();
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expect(fx.calls.computeCodeInterdiff).toHaveLength(0);
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { recheck: boolean; interdiff?: string }];
    expect(opts.recheck).toBe(false);
    expect(opts.interdiff).toBeUndefined();
  });

  it('no QA: full coverage → auto-approve to ready (afterDone null), no QA dispatch', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1, qaAgentId: undefined });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponse.mockResolvedValue({
      round: 1,
      responses: [{ findingId: 'f-1', action: 'fix', rationale: 'done', commitSha: 'abc' }],
    });
    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
    expect(fx.transport.deleteResponse).toHaveBeenCalled();
    expect(fx.calls.transitionTaskStatus).toContainEqual(['t1', 'ready']);
  });

  it('an unavailable snapshotted QA pauses after code-fixed instead of silently auto-approving', async () => {
    const fx = makeFixture(
      { status: 'fixing', reviewRound: 1, qaAgentId: 'ghost-qa' },
      { hasQaPartner: false },
    );
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponse.mockResolvedValue({
      round: 1,
      responses: [{ findingId: 'f-1', action: 'fix', rationale: 'done', commitSha: 'abc' }],
    });
    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
    expect(fx.calls.transitionTaskStatus).not.toContainEqual(['t1', 'ready']);
    expectConsumedSignalFenced(fx, 'dev-1', 'code-fixed');
    expect(fx.emitted.some(event =>
      event.type === 'human.intervention'
      && (event.data as { phase?: string }).phase === 'server-code-qa-unavailable-after-fix'
    )).toBe(true);
  });

  it('no QA: full coverage → approved + dispatchServerAfterDone (afterDone branch)', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1, qaAgentId: undefined }, { afterDone: 'branch' });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponse.mockResolvedValue({
      round: 1,
      responses: [{ findingId: 'f-1', action: 'fix', rationale: 'done', commitSha: 'abc' }],
    });
    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
    expect(fx.transport.readHeadSha).toHaveBeenCalled();
    expect(fx.calls.transitionTaskStatus).toContainEqual(['t1', 'approved']);
    expect(fx.calls.dispatchServerAfterDone).toContainEqual(['t1', 'branch']);
  });

  it('no QA: head capture failure fences code-fixed (not code-done)', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1, qaAgentId: undefined }, { afterDone: 'branch' });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponse.mockResolvedValue({
      round: 1,
      responses: [{ findingId: 'f-1', action: 'fix', rationale: 'done', commitSha: 'abc' }],
    });
    fx.transport.readHeadSha.mockRejectedValueOnce(new Error('git failed'));
    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });
    expectConsumedSignalFenced(fx, 'dev-1', 'code-fixed');
    expect(fx.calls.transitionTaskStatus).toHaveLength(0);
    expect(fx.calls.dispatchServerAfterDone).toHaveLength(0);
  });

  it('no QA recovery: response already stored (readResponse null) → auto-approve, no QA dispatch', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1, qaAgentId: undefined });
    await putRound(fx.store, 'code', 1, {
      findings: FINDINGS_RC,
      response: { round: 1, responses: [{ findingId: 'f-1', action: 'fix', rationale: 'done' }] },
    });
    fx.transport.readResponse.mockResolvedValue(null);
    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
    expect(fx.calls.transitionTaskStatus).toContainEqual(['t1', 'ready']);
  });

  it('dev responses to u- findings (fix/reject/out-of-scope) pass coverage and dispatch recheck', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 });
    await putRound(fx.store, 'code', 1, {
      findings: { round: 1, verdict: 'request-changes', findings: [
        { id: 'f-1', severity: 'major', message: 'broken' },
        { id: 'u-1', severity: 'major', message: '用户意见 1' },
        { id: 'u-2', severity: 'major', message: '用户意见 2' },
      ] },
    });
    fx.transport.readResponse.mockResolvedValue({
      round: 1,
      responses: [
        { findingId: 'f-1', action: 'fix', rationale: 'fixed', commitSha: 'abc' },
        { findingId: 'u-1', action: 'reject', rationale: '不认同' },
        { findingId: 'u-2', action: 'out-of-scope', rationale: '超范围' },
      ],
    });
    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });
    expect(fx.emitted.some(e => e.type === 'human.intervention'
      && (e.data as { phase?: string }).phase === 'server-code-response-coverage-gap')).toBe(false);
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
    // QA 复审的 prior findings 携带用户意见（u-1）
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { priorFindingsJson?: string }];
    expect(opts.priorFindingsJson).toContain('u-1');
  });
});

describe('server.code.published', () => {
  it('records prNumber and transitions to ready', async () => {
    const fx = makeFixture({ status: 'approved', reviewHeadAnchorSha: 'head123' });
    const expectedTask = generationOf(fx.task);
    await fx.emit('server.code.published', { token: 'tok123', kind: 'code-ready', prNumber: 42 });
    expect(fx.transitionTaskStatus).toHaveBeenCalledWith(
      't1',
      'ready',
      { fromStatus: ['approved'], expectTask: expectedTask },
      { prNumber: 42, baseBranch: 'main', latestHeadSha: 'head123' },
    );
    expect(fx.task).toMatchObject({
      status: 'ready',
      prNumber: 42,
      baseBranch: 'main',
      latestHeadSha: 'head123',
    });
  });
});

describe('server.spec flow', () => {
  it('rejects spec-done after the task has entered the code phase', async () => {
    const fx = makeFixture({ phase: 'code', status: 'in_progress' });

    await fx.emit('server.spec.ready', { token: 'tok123', kind: 'spec-done' });

    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
    expect(fx.emitted.some(event => event.type === 'human.intervention'
      && event.data?.phase === 'server.spec.ready-stale')).toBe(true);
  });

  it('spec-done → spec content dispatched for review', async () => {
    const fx = makeFixture({ phase: undefined, status: 'in_progress' });
    fx.transport.readContent.mockResolvedValue({
      content: '# Spec',
      documents: [{ relPath: '.baxian/spec.md', content: '# Spec' }],
    });
    await fx.emit('server.spec.ready', { token: 'tok123', kind: 'spec-done' });
    const round = await fx.store.getRound('t1', 'spec', 1);
    expect(round?.content).toBe('# Spec');
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, {
      phase: string;
      content: string;
      expectedTask?: unknown;
    }];
    expect(opts.phase).toBe('spec');
    expect(opts.content).toBe('# Spec');
    expect(opts.expectedTask).toEqual({
      status: 'in_progress',
      phase: undefined,
      signalToken: 'tok123',
      agentId: 'dev-1',
      reviewRound: 0,
      specReviewRound: undefined,
    });
  });

  it('spec-reviewed approve → transitionToCodePhase', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'review', specReviewRound: 1 });
    await putRound(fx.store, 'spec', 1);
    fx.transport.readFindings.mockResolvedValue(APPROVE_R1);
    await fx.emit('server.spec.review.submitted', { token: 'tok123', kind: 'spec-reviewed' });
    expect(fx.calls.transitionToCodePhase).toContainEqual(['t1']);
  });

  it('spec-reviewed approve + specApproval human → parks at spec-ready, no code phase', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'review', specReviewRound: 1 }, { specApproval: 'human' });
    await putRound(fx.store, 'spec', 1);
    fx.transport.readFindings.mockResolvedValue(APPROVE_R1);
    await fx.emit('server.spec.review.submitted', { token: 'tok123', kind: 'spec-reviewed' });
    expect(fx.calls.parkTaskAtSpecReady).toContainEqual(['t1']);
    expect(fx.calls.transitionToCodePhase).toHaveLength(0);
  });

  it('spec-reviewed approve + specApproval null → code phase as before', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'review', specReviewRound: 1 }, { specApproval: null });
    await putRound(fx.store, 'spec', 1);
    fx.transport.readFindings.mockResolvedValue(APPROVE_R1);
    await fx.emit('server.spec.review.submitted', { token: 'tok123', kind: 'spec-reviewed' });
    expect(fx.calls.transitionToCodePhase).toContainEqual(['t1']);
    expect(fx.calls.parkTaskAtSpecReady).toHaveLength(0);
  });

  it('Research spec approval always parks for a human even when project specApproval is null', async () => {
    const fx = makeFixture({
      preferredAgentId: 'research-1',
      agentId: 'research-1',
      researchAgentId: 'research-1',
      phase: 'spec',
      status: 'review',
      specReviewRound: 1,
    }, { specApproval: null });
    await putRound(fx.store, 'spec', 1);
    fx.transport.readFindings.mockResolvedValue(APPROVE_R1);

    await fx.emit('server.spec.review.submitted', { token: 'tok123', kind: 'spec-reviewed' });

    expect(fx.calls.parkTaskAtSpecReady).toContainEqual(['t1']);
    expect(fx.calls.transitionToCodePhase).toHaveLength(0);
  });

  it('Research without QA persists its documents and parks at the mandatory human gate', async () => {
    const fx = makeFixture({
      preferredAgentId: 'research-1',
      agentId: 'research-1',
      researchAgentId: 'research-1',
      qaAgentId: undefined,
      phase: 'research',
      status: 'in_progress',
    }, { specApproval: null });
    const documents = [
      { relPath: '.baxian/spec.md', content: '# Research Spec' },
      { relPath: '.baxian/research/options.md', content: '# Options' },
    ];
    fx.transport.readContent.mockResolvedValue({ content: renderSpecDocuments(documents), documents });

    await fx.emit('server.spec.ready', { token: 'tok123', kind: 'spec-done' });

    const round = await fx.store.getRound('t1', 'spec', 1);
    expect(round?.documents).toEqual([
      { relPath: '.baxian/spec.md', content: '# Research Spec' },
      { relPath: '.baxian/research/options.md', content: '# Options' },
    ]);
    expect(fx.calls.parkTaskAtSpecReady).toContainEqual(['t1', { specReviewRound: 1 }]);
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
    expect(fx.calls.transitionToCodePhase).toHaveLength(0);
  });

  it('spec-done without QA partner + specApproval human → stores the spec round then parks', async () => {
    const fx = makeFixture({ phase: undefined, status: 'in_progress', qaAgentId: undefined }, { specApproval: 'human' });
    fx.transport.readContent.mockResolvedValue({
      content: '# Spec no-QA',
      documents: [{ relPath: '.baxian/spec.md', content: '# Spec no-QA' }],
    });
    await fx.emit('server.spec.ready', { token: 'tok123', kind: 'spec-done' });
    const round = await fx.store.getRound('t1', 'spec', 1);
    expect(round?.content).toBe('# Spec no-QA');
    expect(fx.calls.parkTaskAtSpecReady).toContainEqual(['t1', { specReviewRound: 1 }]);
    expect(fx.calls.transitionToCodePhase).toHaveLength(0);
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });

  it('does not park a successor spec generation after content capture', async () => {
    const fx = makeFixture(
      { phase: undefined, status: 'in_progress', qaAgentId: undefined },
      { specApproval: 'human' },
    );
    fx.transport.readContent.mockImplementationOnce(async () => {
      fx.task.signalToken = 'successor-token';
      const documents = [{ relPath: '.baxian/spec.md', content: '# Spec' }];
      return { content: renderSpecDocuments(documents), documents };
    });

    await fx.emit('server.spec.ready', { token: 'tok123', kind: 'spec-done' });

    expect(fx.parkTaskAtSpecReady).not.toHaveBeenCalled();
    expect(fx.task).toMatchObject({ status: 'in_progress', signalToken: 'successor-token' });
  });

  it('spec-fixed without QA partner + specApproval human → stores the new round and parks again', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'fixing', specReviewRound: 1, qaAgentId: undefined }, { specApproval: 'human' });
    await putRound(fx.store, 'spec', 1, {
      findings: { round: 1, verdict: 'request-changes', findings: [{ id: 'u-1', severity: 'major', message: '补充回滚方案' }] },
    });
    fx.transport.readResponse.mockResolvedValue({
      round: 1,
      responses: [{ findingId: 'u-1', action: 'fix', rationale: 'added' }],
    });
    fx.transport.readContent.mockResolvedValue({
      content: '# Spec v2',
      documents: [{ relPath: '.baxian/spec.md', content: '# Spec v2' }],
    });
    await fx.emit('server.spec.fix.submitted', { token: 'tok123', kind: 'spec-fixed' });
    const round2 = await fx.store.getRound('t1', 'spec', 2);
    expect(round2?.content).toBe('# Spec v2');
    expect(fx.calls.parkTaskAtSpecReady).toContainEqual(['t1', { specReviewRound: 2 }]);
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });

  it('spec-fixed without QA partner + specApproval turned off mid-loop → auto-approves to code phase', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'fixing', specReviewRound: 1, qaAgentId: undefined }, { specApproval: null });
    await putRound(fx.store, 'spec', 1, {
      findings: { round: 1, verdict: 'request-changes', findings: [{ id: 'u-1', severity: 'major', message: '补充回滚方案' }] },
    });
    fx.transport.readResponse.mockResolvedValue({
      round: 1,
      responses: [{ findingId: 'u-1', action: 'fix', rationale: 'added' }],
    });
    fx.transport.readContent.mockResolvedValue({
      content: '# Spec v2',
      documents: [{ relPath: '.baxian/spec.md', content: '# Spec v2' }],
    });
    await fx.emit('server.spec.fix.submitted', { token: 'tok123', kind: 'spec-fixed' });
    expect(fx.calls.transitionToCodePhase).toContainEqual(['t1']);
    expect(fx.calls.parkTaskAtSpecReady).toHaveLength(0);
  });

  it('spec-fixed with full coverage → new spec review round dispatched', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'fixing', specReviewRound: 1 });
    await putRound(fx.store, 'spec', 1, {
      findings: { round: 1, verdict: 'request-changes', findings: [{ id: 'f-1', severity: 'major', message: 'gap', location: 'S1' }] },
    });
    fx.transport.readResponse.mockResolvedValue({
      round: 1,
      responses: [{ findingId: 'f-1', action: 'fix', rationale: 'added' }],
    });
    fx.transport.readContent.mockResolvedValue({
      content: '# Spec v2',
      documents: [{ relPath: '.baxian/spec.md', content: '# Spec v2' }],
    });
    await fx.emit('server.spec.fix.submitted', { token: 'tok123', kind: 'spec-fixed' });
    const round2 = await fx.store.getRound('t1', 'spec', 2);
    expect(round2?.content).toBe('# Spec v2');
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
    expect(fx.calls.dispatchServerReviewToQa[0]?.[1]).toMatchObject({
      expectedTask: {
        status: 'fixing',
        phase: 'spec',
        signalToken: 'tok123',
        agentId: 'dev-1',
        reviewRound: 0,
        specReviewRound: 1,
      },
    });
  });

  it('spec-fixed unknown findingId → intervention, audit, token fence, and correction dispatch', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'fixing', specReviewRound: 1 });
    await putRound(fx.store, 'spec', 1, {
      findings: { round: 1, verdict: 'request-changes', findings: [{ id: 'f-1', severity: 'major', message: 'gap', location: 'S1' }] },
    });
    fx.transport.readResponse.mockResolvedValue({
      round: 1,
      responses: [
        { findingId: 'f-1', action: 'fix', rationale: 'added' },
        { findingId: 'f99', action: 'fix', rationale: 'hallucinated' },
      ],
    });
    await fx.emit('server.spec.fix.submitted', { token: 'tok123', kind: 'spec-fixed' });
    const gap = fx.emitted.find(e => e.type === 'human.intervention'
      && (e.data as { phase?: string }).phase === 'server-spec-response-coverage-gap');
    expect(gap).toBeDefined();
    expect((gap?.data as { unknownFindingIds?: string[] }).unknownFindingIds).toContain('f99');
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
    expect(fx.transport.deleteResponse).toHaveBeenCalled();
    const round = await fx.store.getRound('t1', 'spec', 1);
    expect(round?.response).toBeUndefined();
    expectConsumedSignalFenced(fx, 'dev-1', 'spec-fixed');
  });
});

describe('crash-replay recovery from stored exchange artifacts', () => {
  it('code-reviewed replay with stored findings resumes verdict routing', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 1 });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC, completedAt: 'now' });
    fx.transport.readFindings.mockResolvedValue(null);
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    expect(fx.calls.dispatchServerFixToDev).toHaveLength(1);
  });

  it('code-reviewed replay with legacy batch fields continues from stored batchFindings', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 1, batchIndex: 0, batchTotal: 2 });
    await putRound(fx.store, 'code', 1, { content: TWO_BATCH_DIFF, findings: FINDINGS_RC, batchFindings: [FINDINGS_RC] });
    fx.transport.readFindings.mockResolvedValue(null);
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
    expect(fx.calls.dispatchServerFixToDev).toHaveLength(0);
  });

  it('code-fixed replay with stored response resumes recheck dispatch', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 });
    await putRound(fx.store, 'code', 1, {
      findings: FINDINGS_RC,
      response: { round: 1, responses: [{ findingId: 'f-1', action: 'fix', rationale: 'ok' }] },
    });
    fx.transport.readResponse.mockResolvedValue(null);
    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { recheck: boolean; priorResponseJson?: string }];
    expect(opts.recheck).toBe(true);
    expect(opts.priorResponseJson).toContain('f-1');
  });

  it('spec-reviewed replay with stored approve resumes code-phase transition', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'review', specReviewRound: 1 });
    await putRound(fx.store, 'spec', 1, {
      findings: APPROVE_R1, completedAt: 'now',
    });
    fx.transport.readFindings.mockResolvedValue(null);
    await fx.emit('server.spec.review.submitted', { token: 'tok123', kind: 'spec-reviewed' });
    expect(fx.calls.transitionToCodePhase).toContainEqual(['t1']);
  });

  it('spec-fixed replay with stored response resumes spec recheck', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'fixing', specReviewRound: 1 });
    await putRound(fx.store, 'spec', 1, {
      findings: { round: 1, verdict: 'request-changes', findings: [{ id: 'f-1', severity: 'major', message: 'g', location: 'S1' }] },
      response: { round: 1, responses: [{ findingId: 'f-1', action: 'fix', rationale: 'done' }] },
    });
    fx.transport.readResponse.mockResolvedValue(null);
    fx.transport.readContent.mockResolvedValue({
      content: '# Spec v2',
      documents: [{ relPath: '.baxian/spec.md', content: '# Spec v2' }],
    });
    await fx.emit('server.spec.fix.submitted', { token: 'tok123', kind: 'spec-fixed' });
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
  });

  it('legacy batch fields derive continuation dispatch on fresh findings', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 2, batchIndex: 0, batchTotal: 2 });
    await putRound(fx.store, 'code', 2, { content: TWO_BATCH_DIFF, batchFindings: [] });
    fx.transport.readFindings.mockResolvedValue({ ...FINDINGS_RC, round: 2 });
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
    expect(fx.calls.dispatchServerFixToDev).toHaveLength(0);
  });
});

describe('legacy batch compatibility', () => {
  it('aggregates existing batchFindings with the current final batch', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 2, batchIndex: 1, batchTotal: 2 });
    await putRound(fx.store, 'code', 2, {
      batchFindings: [{
        round: 2, verdict: 'request-changes',
        findings: [{ id: 'b0-f-1', severity: 'major', message: 'still open' }],
      }],
    });
    fx.transport.readFindings.mockResolvedValue({
      round: 2, verdict: 'approve',
      findings: [{ id: 'f-9', severity: 'minor', message: 'new nit' }],
    });
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    const round = await fx.store.getRound('t1', 'code', 2);
    expect(round?.findings?.findings.map(f => f.id)).toEqual(['b0-f-1', 'b1-f-9']);
  });
});

describe('invalid exchange file fences the consumed generation', () => {
  it('malformed findings.json → intervention + code-reviewed token fence', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 1 });
    await putRound(fx.store, 'code', 1);
    fx.transport.readFindings.mockRejectedValue(new Error('schema violation'));
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    expectConsumedSignalFenced(fx, 'qa-1', 'code-reviewed');
    expect(fx.calls.dispatchServerFixToDev).toHaveLength(0);
  });

  it('malformed response.json → code-fixed token fence', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    const raw = '{"round":';
    fx.transport.readResponseWithRaw.mockResolvedValue({
      kind: 'invalid',
      raw,
      responseDigest: sha256Hex(raw),
      error: new Error('schema violation'),
      schemaViolationCodes: ['malformed-json'],
    });
    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });
    expectConsumedSignalFenced(fx, 'dev-1', 'code-fixed');
  });
});

describe('Codex resilience', () => {
  it('findings missing (not stored) → intervention + code-reviewed token fence', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 1 });
    await putRound(fx.store, 'code', 1);
    fx.transport.readFindings.mockResolvedValue(null);
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    expectConsumedSignalFenced(fx, 'qa-1', 'code-reviewed');
    expect(fx.calls.dispatchServerFixToDev).toHaveLength(0);
  });

  it('stale round payload → preserved + token fence, never routed', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 2 });
    await putRound(fx.store, 'code', 2);
    fx.transport.readFindings.mockResolvedValue({ ...FINDINGS_RC, round: 1 });
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    expect(fx.transport.deleteFindings).not.toHaveBeenCalled();
    expectConsumedSignalFenced(fx, 'qa-1', 'code-reviewed');
    expect(fx.calls.dispatchServerFixToDev).toHaveLength(0);
    const round = await fx.store.getRound('t1', 'code', 2);
    expect(round?.findings).toBeUndefined();
  });

  it('afterDone:pr publish without PR number → fence code-ready, no ready transition', async () => {
    const fx = makeFixture({ status: 'approved' }, { afterDone: 'pr' });
    await fx.emit('server.code.published', { token: 'tok123', kind: 'code-ready' });
    expectConsumedSignalFenced(fx, 'dev-1', 'code-ready');
    expect(fx.calls.transitionTaskStatus).not.toContainEqual(['t1', 'ready']);
  });

  it('maxRoundsContinues extends the cap by the granted rounds', async () => {
    const fx = makeFixture({ reviewRound: 3, maxRoundsContinues: 1 }, { rounds: 3 });
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
    expect(fx.calls.transitionTaskStatus).not.toContainEqual(['t1', 'max_rounds']);
  });
});

describe('content read failure fences the entry signal', () => {
  it('code-done entry → fence code-done', async () => {
    const fx = makeFixture();
    fx.transport.readContent.mockRejectedValue(new Error('fetch failed'));
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expectConsumedSignalFenced(fx, 'dev-1', 'code-done');
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });

  it('code-fixed recheck entry → fence code-fixed', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponse.mockResolvedValue({
      round: 1,
      responses: [{ findingId: 'f-1', action: 'fix', rationale: 'ok' }],
    });
    fx.transport.readContent.mockRejectedValue(new Error('fetch failed'));
    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });
    expectConsumedSignalFenced(fx, 'dev-1', 'code-fixed');
  });
});

describe('afterDone snapshot', () => {
  it('approve verdict snapshots afterDone onto the task', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 1 }, { afterDone: 'pr' });
    await putRound(fx.store, 'code', 1);
    fx.transport.readFindings.mockResolvedValue(APPROVE_R1);
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    expect(fx.calls.dispatchServerAfterDone).toContainEqual(['t1', 'pr']);
  });

  it('publish gate reads the task snapshot, not live config', async () => {
    const fx = makeFixture({ status: 'approved', afterDone: 'pr' }, { afterDone: null });
    await fx.emit('server.code.published', { token: 'tok123', kind: 'code-ready' });
    expectConsumedSignalFenced(fx, 'dev-1', 'code-ready');
    expect(fx.calls.transitionTaskStatus).not.toContainEqual(['t1', 'ready']);
  });
});

describe('published head guard', () => {
  it('publish with PR number captures the reviewed head sha', async () => {
    const fx = makeFixture({ status: 'approved', afterDone: 'pr', reviewHeadAnchorSha: 'head123' });
    const expectedTask = generationOf(fx.task);
    await fx.emit('server.code.published', { token: 'tok123', kind: 'code-ready', prNumber: 42 });
    expect(fx.transitionTaskStatus).toHaveBeenCalledWith(
      't1',
      'ready',
      { fromStatus: ['approved'], expectTask: expectedTask },
      { prNumber: 42, baseBranch: 'main', latestHeadSha: 'head123' },
    );
  });

  it('does not publish metadata or ready status onto a successor generation', async () => {
    const fx = makeFixture({ status: 'approved', afterDone: 'pr', reviewHeadAnchorSha: 'head123' });
    const expectedTask = generationOf(fx.task);
    fx.transport.readHeadSha.mockImplementationOnce(async () => {
      fx.task.signalToken = 'successor-token';
      fx.task.updatedAt = '2026-06-10T00:01:00.000Z';
      return 'head123';
    });

    await fx.emit('server.code.published', { token: 'tok123', kind: 'code-ready', prNumber: 42 });

    expect(fx.transitionTaskStatus).toHaveBeenCalledWith(
      't1',
      'ready',
      { fromStatus: ['approved'], expectTask: expectedTask },
      { prNumber: 42, baseBranch: 'main', latestHeadSha: 'head123' },
    );
    expect(fx.task).toMatchObject({
      status: 'approved',
      signalToken: 'successor-token',
    });
    expect(fx.task.prNumber).toBeUndefined();
    expect(fx.task.baseBranch).toBeUndefined();
    expect(fx.task.latestHeadSha).toBeUndefined();
  });
});

describe('Codex: reviewed-head anchor', () => {
  it('code review dispatch pins the dev HEAD as reviewHeadAnchorSha', async () => {
    const fx = makeFixture();
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { reviewHeadAnchorSha?: string }];
    expect(opts.reviewHeadAnchorSha).toBe('head123');
  });

  it('large diff dispatch pins the anchor without batch metadata', async () => {
    const fx = makeFixture();
    fx.transport.readContent.mockResolvedValue({
      content: [bigFile('src/a.ts'), bigFile('lib/b.ts')].join('\n'),
      diffstat: 'stat',
      baseSha: 'base123',
      headSha: 'head123',
      headTree: 'tree123',
    });
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { batch?: { index: number }; reviewHeadAnchorSha?: string }];
    expect(opts.batch).toBeUndefined();
    expect(opts.reviewHeadAnchorSha).toBe('head123');
  });

  it('captured content missing review head fences the entry signal and dispatches nothing (fail-closed)', async () => {
    const fx = makeFixture();
    fx.transport.readContent.mockResolvedValueOnce({
      content: 'diff --git a/a b/a\n+x',
      diffstat: 'stat',
      baseSha: 'base123',
    });
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expectConsumedSignalFenced(fx, 'dev-1', 'code-done');
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });

  it('published head differing from the reviewed anchor refuses ready', async () => {
    const fx = makeFixture({ status: 'approved', afterDone: 'pr', reviewHeadAnchorSha: 'reviewed-abc' });
    await fx.emit('server.code.published', { token: 'tok123', kind: 'code-ready', prNumber: 42 });
    expect(fx.calls.transitionTaskStatus).not.toContainEqual(['t1', 'ready']);
    expect(fx.calls.updateTask).not.toContainEqual(['t1', { latestHeadSha: 'head123' }]);
    const mismatch = fx.emitted.find(
      e => e.type === 'human.intervention'
        && (e.data as { phase?: string }).phase === 'server-code-published-head-mismatch',
    );
    expect(mismatch).toBeDefined();
    expect((mismatch?.data as { publishedHead?: string }).publishedHead).toBe('head123');
  });

  it('remote PR head differing from the reviewed and published head refuses ready', async () => {
    const remoteHead = 'remote-advanced';
    const fx = makeFixture(
      { status: 'approved', afterDone: 'pr', prNumber: 42, reviewHeadAnchorSha: 'head123' },
      { verifiedHeadSha: remoteHead },
    );
    await fx.emit('server.code.published', { token: 'tok123', kind: 'code-ready' });
    expect(fx.calls.transitionTaskStatus).not.toContainEqual(['t1', 'ready']);
    expect(fx.calls.updateTask).not.toContainEqual(['t1', { latestHeadSha: 'head123' }]);
    const mismatch = fx.emitted.find(
      e => e.type === 'human.intervention'
        && (e.data as { phase?: string }).phase === 'server-code-published-pr-head-mismatch',
    );
    expect(mismatch?.data).toMatchObject({
      prNumber: 42,
      remoteHead,
      publishedHead: 'head123',
      reviewedHead: 'head123',
    });
  });

  it('publish with NO recorded anchor refuses ready (fail-closed)', async () => {
    const fx = makeFixture({ status: 'approved', afterDone: 'pr' });
    await fx.emit('server.code.published', { token: 'tok123', kind: 'code-ready', prNumber: 42 });
    expect(fx.calls.transitionTaskStatus).not.toContainEqual(['t1', 'ready']);
  });
});

describe('guard exits fence the consumed signal', () => {
  type FenceRow = [string, Partial<TaskState>, string, string, string, SeedRound?];

  const fenceCases: FenceRow[] = [
    ['code review dispatch with missing dev config fences code-done',
      { agentId: 'ghost' }, 'server.code.ready', 'code-done', 'ghost'],
    ['code recheck entry with missing dev config fences code-fixed',
      { status: 'fixing', agentId: 'ghost', reviewRound: 1 }, 'server.code.fix.submitted', 'code-fixed', 'ghost'],
    ['code verdict with missing qa config fences code-reviewed',
      { status: 'review', reviewRound: 1, qaAgentId: 'ghost' }, 'server.code.review.submitted', 'code-reviewed', 'ghost'],
    ['code verdict with missing round data fences code-reviewed',
      { status: 'review', reviewRound: 1 }, 'server.code.review.submitted', 'code-reviewed', 'qa-1'],
    ['code fix-submitted with missing stored findings fences code-fixed',
      { status: 'fixing', reviewRound: 1 }, 'server.code.fix.submitted', 'code-fixed', 'dev-1', { phase: 'code', round: 1 }],
    ['spec review dispatch with missing dev config fences spec-done',
      { phase: 'spec', status: 'in_progress', agentId: 'ghost' }, 'server.spec.ready', 'spec-done', 'ghost'],
    ['spec verdict with missing qa config fences spec-reviewed',
      { phase: 'spec', status: 'review', specReviewRound: 1, qaAgentId: 'ghost' }, 'server.spec.review.submitted', 'spec-reviewed', 'ghost'],
    ['spec verdict with missing round data fences spec-reviewed',
      { phase: 'spec', status: 'review', specReviewRound: 1 }, 'server.spec.review.submitted', 'spec-reviewed', 'qa-1'],
    ['spec fix-submitted with missing dev config fences spec-fixed',
      { phase: 'spec', status: 'fixing', specReviewRound: 1, agentId: 'ghost' }, 'server.spec.fix.submitted', 'spec-fixed', 'ghost'],
    ['spec fix-submitted with missing stored findings fences spec-fixed',
      { phase: 'spec', status: 'fixing', specReviewRound: 1 }, 'server.spec.fix.submitted', 'spec-fixed', 'dev-1', { phase: 'spec', round: 1 }],
  ];

  it.each(fenceCases)('%s', async (_name, task, type, kind, agent, seed) => {
    const fx = await runScenario({ task, seed, emit: [type, kind] });
    expectConsumedSignalFenced(fx, agent, kind);
    expect(fx.calls.holdAgentForUnarmedSignal).toHaveLength(0);
    if (type.endsWith('.ready')) expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });

  it('code review dispatch with a legacy undefined agentId intervenes without arming an undefined watcher', async () => {
    const fx = makeFixture({ agentId: undefined as unknown as string });
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expect(fx.calls.setupPhaseSignal).toHaveLength(0);
    expect(fx.calls.holdAgentForUnarmedSignal).toHaveLength(0);
    expect(fx.calls.claimServerSignalRecovery.some(call => call[2] === 'code-done')).toBe(true);
    expect(fx.emitted.some(
      e => e.type === 'human.intervention'
        && (e.data as { phase?: string }).phase === 'server-code-review-no-dev-agent',
    )).toBe(true);
  });
});

describe('legacy batch aggregation data', () => {
  it('keeps legacy batch ids collision-safe during final aggregation', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 2, batchIndex: 1, batchTotal: 2 });
    await putRound(fx.store, 'code', 2, {
      batchFindings: [{
        round: 2, verdict: 'request-changes',
        findings: [
          { id: 'b0-f-1', severity: 'major', message: 'still open' },
          { id: 'f-1', severity: 'minor', message: 'new issue' },
        ],
      }],
    });
    fx.transport.readFindings.mockResolvedValue({ ...FINDINGS_RC, round: 2, verdict: 'approve', findings: [] });
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    const round = await fx.store.getRound('t1', 'code', 2);
    const ids = round?.findings?.findings.map(f => f.id) ?? [];
    expect(ids).toEqual(['b0-f-1', 'b0-r2-f-1']);
  });
});

describe('publish robustness and bounded round-store retry', () => {
  it('unverified PR number → intervention + code-ready fence, never recorded', async () => {
    const fx = makeFixture(
      { status: 'approved', afterDone: 'pr', reviewHeadAnchorSha: 'head123' },
      { verifyPr: false },
    );
    await fx.emit('server.code.published', { token: 'tok123', kind: 'code-ready', prNumber: 999 });
    expectConsumedSignalFenced(fx, 'dev-1', 'code-ready');
    expect(fx.calls.updateTask).not.toContainEqual(['t1', { prNumber: 999 }]);
    expect(fx.calls.transitionTaskStatus).not.toContainEqual(['t1', 'ready']);
    expect(fx.emitted.find(event => event.type === 'human.intervention')?.data).toMatchObject({
      phase: 'server-code-published-pr-number-unverified', prNumber: 999,
    });
  });

  it('a transient putRound failure on code-done retries in-handler and dispatches', async () => {
    const fx = makeFixture();
    const failingStore = fx.store as unknown as { putRound: (...a: unknown[]) => Promise<void> };
    const original = failingStore.putRound.bind(fx.store);
    let failed = false;
    failingStore.putRound = async (...a: unknown[]) => {
      if (!failed) { failed = true; throw new Error('disk full'); }
      return original(...(a as Parameters<typeof original>));
    };
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expect(fx.calls.setupPhaseSignal).toHaveLength(0);
    expect(fx.calls.claimServerSignalRecovery).toHaveLength(0);
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
  });
});

describe('verdict-save bounded retry and fence', () => {
  it('a transient findings save failure retries, deletes the file, and routes the verdict', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 1 });
    await putRound(fx.store, 'code', 1);
    fx.transport.readFindings.mockResolvedValue(FINDINGS_RC);
    const failing = fx.store as unknown as { putRound: (...a: unknown[]) => Promise<void> };
    const original = failing.putRound.bind(fx.store);
    let calls = 0;
    failing.putRound = async (...a: unknown[]) => {
      calls++;
      if (calls === 1) throw new Error('disk full');
      return original(...(a as Parameters<typeof original>));
    };
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    expect(fx.calls.setupPhaseSignal).toHaveLength(0);
    expect(fx.transport.deleteFindings).toHaveBeenCalled();
    expect(fx.calls.dispatchServerFixToDev).toHaveLength(1);
  });

  it('persistent response save failure fences code-fixed and preserves the file', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponse.mockResolvedValue({
      round: 1, responses: [{ findingId: 'f-1', action: 'fix', rationale: 'ok' }],
    });
    const failing = fx.store as unknown as { putRound: (...a: unknown[]) => Promise<void> };
    failing.putRound = async () => { throw new Error('disk full'); };
    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });
    expectConsumedSignalFenced(fx, 'dev-1', 'code-fixed');
    expect(fx.transport.deleteResponse).not.toHaveBeenCalled();
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });
});

describe('Codex: cap at verdict', () => {
  it('request-changes at the cap pauses at max_rounds without dispatching a fix', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 3 }, { rounds: 3 });
    await putRound(fx.store, 'code', 3);
    fx.transport.readFindings.mockResolvedValue({ ...FINDINGS_RC, round: 3 });
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    expect(fx.calls.transitionTaskStatus).toContainEqual(['t1', 'max_rounds']);
    expect(fx.calls.dispatchServerFixToDev).toHaveLength(0);
  });

  it('replayed approve keeps the snapshotted afterDone over hot config', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 1, afterDone: 'pr' }, { afterDone: null });
    await putRound(fx.store, 'code', 1);
    fx.transport.readFindings.mockResolvedValue(APPROVE_R1);
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    expect(fx.calls.dispatchServerAfterDone).toContainEqual(['t1', 'pr']);
    expect(fx.calls.updateTask).not.toContainEqual(['t1', { afterDone: null }]);
  });
});

describe('captured generation guards', () => {
  it('does not overwrite a successor code artifact after content capture advances the generation', async () => {
    const fx = makeFixture();
    fx.transport.readContent.mockImplementationOnce(async () => {
      fx.task.signalToken = 'successor-token';
      await putRound(fx.store, 'code', 1, { content: 'successor diff' });
      return {
        content: 'stale diff',
        diffstat: ' stale.ts | 1 +',
        baseSha: 'stale-base',
        headSha: 'stale-head',
        headTree: 'stale-tree',
        defaultBranch: 'main',
      };
    });

    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });

    expect(await fx.store.getRound('t1', 'code', 1)).toMatchObject({
      content: 'successor diff',
    });
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });

  it('does not overwrite a successor spec artifact after content capture advances the generation', async () => {
    const fx = makeFixture({ phase: 'spec', specReviewRound: 0 });
    fx.transport.readContent.mockImplementationOnce(async () => {
      fx.task.signalToken = 'successor-token';
      await putRound(fx.store, 'spec', 1, {
        content: 'successor spec',
        documents: [{ relPath: '.baxian/spec.md', content: 'successor spec' }],
      });
      return {
        content: 'stale spec',
        documents: [{ relPath: '.baxian/spec.md', content: 'stale spec' }],
        defaultBranch: 'main',
      };
    });

    await fx.emit('server.spec.ready', { token: 'tok123', kind: 'spec-done' });

    expect(await fx.store.getRound('t1', 'spec', 1)).toMatchObject({
      content: 'successor spec',
      documents: [{ relPath: '.baxian/spec.md', content: 'successor spec' }],
    });
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });

  it('does not enter the code dispatch cap for a stale generation', async () => {
    const fx = makeFixture({ reviewRound: 3 }, { rounds: 3 });
    const expectedTask = generationOf(fx.task);
    fx.task.signalToken = 'successor-token';

    const result = await fx.driver.current!.dispatchCodeReview(fx.task, { expectedTask });

    const capCall = fx.transitionTaskStatus.mock.calls.find(call => call[1] === 'max_rounds');
    expect(capCall?.[2]).toMatchObject({ expectTask: expectedTask });
    expect(result).toBe(false);
    expect(fx.task).toMatchObject({ status: 'in_progress', signalToken: 'successor-token' });
  });

  it('does not enter the spec dispatch cap for a stale generation', async () => {
    const fx = makeFixture(
      { phase: 'spec', status: 'in_progress', specReviewRound: 3 },
      { rounds: 3 },
    );
    const expectedTask = generationOf(fx.task);
    fx.task.signalToken = 'successor-token';

    const result = await fx.driver.current!.dispatchSpecReview(fx.task, { expectedTask });

    const capCall = fx.transitionTaskStatus.mock.calls.find(call => call[1] === 'max_rounds');
    expect(capCall?.[2]).toMatchObject({ expectTask: expectedTask });
    expect(result).toBe(false);
    expect(fx.task).toMatchObject({ status: 'in_progress', signalToken: 'successor-token' });
  });

  it('does not apply an approved spec verdict to a successor generation', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'review', specReviewRound: 1 });
    await putRound(fx.store, 'spec', 1);
    fx.transport.readFindings.mockImplementationOnce(async () => {
      fx.task.signalToken = 'successor-token';
      return APPROVE_R1;
    });

    await fx.emit('server.spec.review.submitted', { token: 'tok123', kind: 'spec-reviewed' });

    expect(fx.transitionToCodePhase).not.toHaveBeenCalled();
    expect(fx.task).toMatchObject({ status: 'review', signalToken: 'successor-token' });
  });

  it('does not delete successor findings after the verdict round was stored', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 1 });
    const expectedTask = generationOf(fx.task);
    await putRound(fx.store, 'code', 1);
    fx.transport.readFindings.mockResolvedValue(APPROVE_R1);
    fx.deleteReviewExchangeIfCurrent.mockImplementationOnce(async (
      _id,
      _agent,
      artifact,
      generation,
    ) => {
      expect(artifact).toBe('findings');
      expect(generation).toEqual(expectedTask);
      fx.task.signalToken = 'successor-token';
      return false;
    });

    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });

    expect(fx.transport.deleteFindings).not.toHaveBeenCalled();
    expect(fx.transitionTaskStatus).not.toHaveBeenCalled();
    expect(fx.task).toMatchObject({ status: 'review', signalToken: 'successor-token' });
  });

  it('does not delete a successor response after the response round was stored', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 });
    const expectedTask = generationOf(fx.task);
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponse.mockResolvedValue({
      round: 1,
      responses: [{ findingId: 'f-1', action: 'fix', rationale: 'done' }],
    });
    fx.deleteReviewExchangeIfCurrent.mockImplementationOnce(async (
      _id,
      _agent,
      artifact,
      generation,
    ) => {
      expect(artifact).toBe('response');
      expect(generation).toEqual(expectedTask);
      fx.task.signalToken = 'successor-token';
      return false;
    });

    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });

    expect(fx.transport.deleteResponse).not.toHaveBeenCalled();
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
    expect(fx.task).toMatchObject({ status: 'fixing', signalToken: 'successor-token' });
  });

  it('does not delete a successor response while archiving a rejected response', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponse.mockResolvedValue({ round: 1, responses: [] });
    fx.deleteReviewExchangeIfCurrent.mockImplementationOnce(async (
      _id,
      _agent,
      artifact,
      expectedTask,
      expectedRecovery,
    ) => {
      expect(artifact).toBe('response');
      expect(expectedTask.signalToken).not.toBe('tok123');
      expect(expectedRecovery).toMatchObject({
        mode: 'correct-response',
        signalKind: 'code-fixed',
        sourceToken: 'tok123',
      });
      fx.task.signalToken = 'successor-token';
      return false;
    });

    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });

    expect(fx.transport.deleteResponse).not.toHaveBeenCalled();
    expect(fx.calls.dispatchServerFeedbackCorrection).toHaveLength(0);
    expect(fx.task).toMatchObject({ status: 'fixing', signalToken: 'successor-token' });
  });

  it('does not enter spec max_rounds from a stale verdict generation', async () => {
    const fx = makeFixture(
      { phase: 'spec', status: 'review', specReviewRound: 3 },
      { rounds: 3 },
    );
    await putRound(fx.store, 'spec', 3);
    fx.transport.readFindings.mockImplementationOnce(async () => {
      fx.task.signalToken = 'successor-token';
      return {
        round: 3,
        verdict: 'request-changes',
        findings: [{ id: 'f-1', severity: 'major', message: 'gap', location: 'S1' }],
      };
    });

    await fx.emit('server.spec.review.submitted', { token: 'tok123', kind: 'spec-reviewed' });

    const capCall = fx.transitionTaskStatus.mock.calls.find(call => call[1] === 'max_rounds');
    expect(capCall).toBeUndefined();
    expect(fx.task).toMatchObject({ status: 'review', signalToken: 'successor-token' });
    expect(fx.calls.releaseAgentForTask).toHaveLength(0);
  });
});

describe('max_rounds releases runtime bindings and preserves participants', () => {
  const SPEC_FINDINGS_RC: ReviewFindings = {
    round: 3,
    verdict: 'request-changes',
    findings: [{ id: 'f-1', severity: 'major', message: 'gap', location: 'S1' }],
  };

  function clearedFields(fx: Fixture): string[] {
    return fx.calls.updateTask
      .filter(c => c[0] === 't1')
      .flatMap(c => Object.keys(c[1] as Record<string, unknown>));
  }

  it('code dispatch cap preserves the QA participant even when no runtime binding exists', async () => {
    const fx = makeFixture({ reviewRound: 3 }, { rounds: 3 });
    fx.releaseAgentForTask.mockResolvedValue(false);
    fx.getAgentState.mockResolvedValue({ id: 'qa-1', projectId: 'proj', updatedAt: 'now' });
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expect(fx.calls.transitionTaskStatus).toContainEqual(['t1', 'max_rounds']);
    expect(clearedFields(fx)).not.toContain('qaAgentId');
    expect(clearedFields(fx)).not.toContain('agentId');
  });

  it('code verdict cap releases QA with allowAwaitingHuman and retains both participants', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 3 }, { rounds: 3 });
    await putRound(fx.store, 'code', 3);
    fx.transport.readFindings.mockResolvedValue({ ...FINDINGS_RC, round: 3 });
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    expect(fx.calls.releaseAgentForTask).toContainEqual(['qa-1', 't1', 'idle', { allowAwaitingHuman: true }]);
    expect(clearedFields(fx)).not.toContain('qaAgentId');
    expect(clearedFields(fx)).not.toContain('agentId');
  });

  it('code verdict cap keeps the reference and raises intervention when QA is still bound after a refused release', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 3 }, { rounds: 3 });
    await putRound(fx.store, 'code', 3);
    fx.transport.readFindings.mockResolvedValue({ ...FINDINGS_RC, round: 3 });
    fx.releaseAgentForTask.mockResolvedValue(false);
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    expect(clearedFields(fx)).not.toContain('qaAgentId');
    const intervention = fx.emitted.find(
      e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'server-max-rounds-release-failed',
    );
    expect(intervention).toBeDefined();
  });

  it('spec dispatch cap releases both runtimes, clears active agentId, and retains QA', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'in_progress', specReviewRound: 3 }, { rounds: 3 });
    await fx.emit('server.spec.ready', { token: 'tok123', kind: 'spec-done' });
    expect(fx.calls.transitionTaskStatus).toContainEqual(['t1', 'max_rounds']);
    expect(fx.calls.releaseAgentForTask).toContainEqual(['qa-1', 't1', 'idle', {}]);
    expect(fx.calls.releaseAgentForTask).toContainEqual(['dev-1', 't1', 'idle', {}]);
    expect(clearedFields(fx)).not.toContain('qaAgentId');
    expect(clearedFields(fx)).toContain('agentId');
  });

  it('spec verdict cap releases both runtimes, clears active agentId, and retains QA', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'review', specReviewRound: 3 }, { rounds: 3 });
    await putRound(fx.store, 'spec', 3);
    fx.transport.readFindings.mockResolvedValue(SPEC_FINDINGS_RC);
    await fx.emit('server.spec.review.submitted', { token: 'tok123', kind: 'spec-reviewed' });
    expect(fx.calls.transitionTaskStatus).toContainEqual(['t1', 'max_rounds']);
    expect(clearedFields(fx)).not.toContain('qaAgentId');
    expect(clearedFields(fx)).toContain('agentId');
    expect(fx.calls.dispatchServerFixToDev).toHaveLength(0);
  });

  it('cap transition refused by a concurrent state change → no release, no clear', async () => {
    const fx = makeFixture({ reviewRound: 3 }, { rounds: 3 });
    fx.transitionTaskStatus.mockResolvedValueOnce(null);
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expect(fx.calls.releaseAgentForTask).toHaveLength(0);
    expect(clearedFields(fx)).not.toContain('qaAgentId');
  });
});

describe('gate relaxation: git tasks through server spec chain', () => {
  it('server.spec.ready dispatches QA spec review for a git task', async () => {
    const f = makeFixture({ reviewMode: 'git', phase: undefined, status: 'in_progress', specReviewRound: 0 });
    await f.emit('server.spec.ready', { token: 'tok123' });
    expect(f.calls.dispatchServerReviewToQa).toHaveLength(1);
    expect((f.calls.dispatchServerReviewToQa[0][1] as { phase: string }).phase).toBe('spec');
  });

  it('server.spec.review.submitted routes approve verdict for a git task', async () => {
    const f = makeFixture({ reviewMode: 'git', phase: 'spec', status: 'review', specReviewRound: 1 });
    await putRound(f.store, 'spec', 1, { content: 'spec text' });
    f.transport.readFindings.mockResolvedValueOnce(APPROVE_R1);
    await f.emit('server.spec.review.submitted', { token: 'tok123' });
    expect(f.calls.transitionToCodePhase).toHaveLength(1);
  });

  it('server.spec.fix.submitted processes a git task response', async () => {
    const f = makeFixture({ reviewMode: 'git', phase: 'spec', status: 'fixing', specReviewRound: 1 });
    await putRound(f.store, 'spec', 1, {
      content: 'spec text',
      findings: { round: 1, verdict: 'request-changes', findings: [{ id: 'f-1', severity: 'major', message: 'm' }] },
    });
    f.transport.readResponse.mockResolvedValueOnce({
      round: 1, responses: [{ findingId: 'f-1', action: 'fix', rationale: 'done' }],
    });
    await f.emit('server.spec.fix.submitted', { token: 'tok123' });
    expect(f.calls.dispatchServerReviewToQa).toHaveLength(1);
  });

  it('git task spec verdict at cap pauses to max_rounds and releases both agents', async () => {
    const f = makeFixture(
      { reviewMode: 'git', phase: 'spec', status: 'review', specReviewRound: 1 },
      { rounds: 1 },
    );
    await putRound(f.store, 'spec', 1, { content: 'spec text' });
    f.transport.readFindings.mockResolvedValueOnce({
      round: 1, verdict: 'request-changes',
      findings: [{ id: 'f-1', severity: 'major', message: 'm' }],
    });
    await f.emit('server.spec.review.submitted', { token: 'tok123' });
    expect(f.calls.transitionTaskStatus.some(c => c[1] === 'max_rounds')).toBe(true);
    expect(f.calls.releaseAgentForTask.map(c => c[0])).toEqual(expect.arrayContaining(['qa-1', 'dev-1']));
    expect(f.calls.dispatchServerFixToDev).toHaveLength(0);
  });

  it('server.code.ready still ignores git tasks', async () => {
    const f = makeFixture({ reviewMode: 'git', phase: 'code', status: 'in_progress' });
    await f.emit('server.code.ready', { token: 'tok123' });
    expect(f.calls.dispatchServerReviewToQa).toHaveLength(0);
  });

  it('server.code.review.submitted still ignores git tasks', async () => {
    const f = makeFixture({ reviewMode: 'git', phase: 'code', status: 'review', reviewRound: 1 });
    await f.emit('server.code.review.submitted', { token: 'tok123' });
    expect(f.calls.dispatchServerFixToDev).toHaveLength(0);
    expect(f.calls.transitionTaskStatus).toHaveLength(0);
  });

  it('spec gate silently ignores a stale token for git tasks', async () => {
    const f = makeFixture({ reviewMode: 'git', phase: undefined, status: 'in_progress' });
    await f.emit('server.spec.ready', { token: 'WRONG' });
    expect(f.calls.dispatchServerReviewToQa).toHaveLength(0);
    expect(f.emitted.some(e => e.type === 'human.intervention')).toBe(false);
  });
});

function interventionPhases(fx: Fixture): string[] {
  return fx.emitted
    .filter(e => e.type === 'human.intervention')
    .map(e => String((e.data as { phase?: string }).phase ?? ''));
}

describe('registration guard', () => {
  it('no ReviewStore configured → warns once, registers no handlers, leaves no manual driver', async () => {
    const bus = new EventBus({ append: async () => undefined } as unknown as EventLog);
    const getTask = vi.fn();
    const setServerReviewDriver = vi.fn();
    const manager = { getReviewStore: () => undefined, getTask, setServerReviewDriver } as unknown as AgentManager;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      registerServerEventHandlers(bus, manager);
      expect(warnSpy).toHaveBeenCalledWith(
        '[ServerEventHandler] no ReviewStore configured; server review mode disabled',
      );
      expect(setServerReviewDriver).not.toHaveBeenCalled();
      await bus.emit({
        id: '',
        type: 'server.code.ready',
        timestamp: new Date().toISOString(),
        projectId: 'proj',
        taskId: 't1',
        data: { token: 'tok123' },
      });
      expect(getTask).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('manual server review driver', () => {
  it('registers a driver on the manager when the review store is configured', () => {
    const fx = makeFixture();
    expect(fx.driver.current).toBeDefined();
  });

  it('dispatchCodeReview runs the entry pipeline from review status: stores the round and dispatches QA fresh (no recheck)', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 0 });
    const ok = await fx.driver.current!.dispatchCodeReview(fx.task);

    expect(ok).toBe(true);
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { phase: string; recheck: boolean }];
    expect(opts.phase).toBe('code');
    expect(opts.recheck).toBe(false);
    expect(await fx.store.getRound('t1', 'code', 1)).toMatchObject({ round: 1, phase: 'code' });
  });

  it('dispatchCodeReview reports false when the diff cannot be read', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 0 });
    fx.transport.readContent.mockRejectedValue(new Error('worktree gone'));

    const ok = await fx.driver.current!.dispatchCodeReview(fx.task);

    expect(ok).toBe(false);
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
    expect(interventionPhases(fx)).toContain('server-code-content-read-failed');
  });

  it('reports a real handler-side recovery hold as a redispatch side effect', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 1, signalToken: 'entry-token' });
    fx.dispatchServerReviewToQa.mockResolvedValueOnce(null);
    const onSideEffect = vi.fn();

    const ok = await fx.driver.current!.dispatchCodeReview(fx.task, { onSideEffect });

    expect(ok).toBe(false);
    expect(onSideEffect).toHaveBeenCalledOnce();
    expect(fx.task.signalToken).not.toBe('entry-token');
    expect(fx.calls.holdConsumedServerSignal).toHaveLength(1);
  });

  it('does not report a handler-side side effect when the recovery hold loses its guard', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 1, signalToken: 'entry-token' });
    fx.dispatchServerReviewToQa.mockResolvedValueOnce(null);
    fx.holdConsumedServerSignal.mockResolvedValueOnce(null);
    const onSideEffect = vi.fn();

    const ok = await fx.driver.current!.dispatchCodeReview(fx.task, { onSideEffect });

    expect(ok).toBe(false);
    expect(onSideEffect).not.toHaveBeenCalled();
    expect(fx.task.signalToken).toBe('entry-token');
  });

  it('reports a claimed response-recovery generation before a later audit-store failure', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponseWithRaw.mockResolvedValue({
      kind: 'invalid',
      raw: '{"round":',
      responseDigest: sha256Hex('{"round":'),
      error: new Error('corrupt response'),
      schemaViolationCodes: ['malformed-json'],
    });
    const onSideEffect = vi.fn();
    vi.spyOn(fx.store, 'recordServerResponseFailure').mockImplementationOnce(async () => {
      expect(onSideEffect).toHaveBeenCalledOnce();
      throw new Error('audit store unavailable');
    });

    const ok = await fx.driver.current!.dispatchCodeReview(fx.task, { onSideEffect });

    expect(ok).toBe(false);
    expect(onSideEffect).toHaveBeenCalledOnce();
    expect(fx.calls.claimServerSignalRecovery).toHaveLength(1);
    expect(fx.calls.holdServerSignalRecovery).toHaveLength(1);
    expect(interventionPhases(fx)).toContain('server-code-response-audit-store-failed');
  });

  it('does not report or persist a response-recovery side effect when its claim loses CAS', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1, signalToken: 'entry-token' });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponseWithRaw.mockResolvedValue({
      kind: 'invalid',
      raw: '{"round":',
      responseDigest: sha256Hex('{"round":'),
      error: new Error('corrupt response'),
      schemaViolationCodes: ['malformed-json'],
    });
    fx.claimServerSignalRecovery.mockResolvedValueOnce(null);
    const recordFailure = vi.spyOn(fx.store, 'recordServerResponseFailure');
    const onSideEffect = vi.fn();

    const ok = await fx.driver.current!.dispatchCodeReview(fx.task, { onSideEffect });

    expect(ok).toBe(false);
    expect(onSideEffect).not.toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
    expect(fx.task.signalToken).toBe('entry-token');
    expect(fx.calls.dispatchServerFeedbackCorrection).toHaveLength(0);
  });

  it('forwards the side-effect callback when verdict persistence falls back to a hold', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 0, signalToken: 'entry-token' });
    vi.spyOn(fx.store, 'putRound').mockRejectedValue(new Error('verdict store unavailable'));
    vi.spyOn(fx.store, 'getRound').mockRejectedValue(new Error('verdict readback unavailable'));
    const onSideEffect = vi.fn();

    const ok = await fx.driver.current!.dispatchCodeReview(fx.task, { onSideEffect });

    expect(ok).toBe(false);
    expect(onSideEffect).toHaveBeenCalledOnce();
    expect(fx.calls.holdConsumedServerSignal).toHaveLength(1);
    expect(interventionPhases(fx)).toContain('server-code-verdict-store-failed');
  });

  it('reports the code no-dev recovery hold as a redispatch side effect', async () => {
    const fx = makeFixture({ agentId: 'ghost', status: 'review', reviewRound: 1, signalToken: 'entry-token' });
    const onSideEffect = vi.fn();

    const ok = await fx.driver.current!.dispatchCodeReview(fx.task, { onSideEffect });

    expect(ok).toBe(false);
    expect(onSideEffect).toHaveBeenCalledOnce();
    expect(fx.task.signalToken).not.toBe('entry-token');
    expect(interventionPhases(fx)).toContain('server-code-review-no-dev-agent');
  });

  it('reports the spec no-dev recovery hold as a redispatch side effect', async () => {
    const fx = makeFixture({
      agentId: 'ghost', status: 'review', phase: 'spec', specReviewRound: 1, signalToken: 'entry-token',
    });
    const onSideEffect = vi.fn();

    const ok = await fx.driver.current!.dispatchSpecReview(fx.task, { onSideEffect });

    expect(ok).toBe(false);
    expect(onSideEffect).toHaveBeenCalledOnce();
    expect(fx.task.signalToken).not.toBe('entry-token');
    expect(interventionPhases(fx)).toContain('server-spec-review-no-dev-agent');
  });

  it.each(['refused', 'threw'] as const)(
    'reports a %s spec auto-approve recovery hold as a redispatch side effect',
    async (failure) => {
      const fx = makeFixture({
        qaAgentId: undefined, status: 'review', phase: 'spec', specReviewRound: 1, signalToken: 'entry-token',
      }, { hasQaPartner: false });
      if (failure === 'refused') fx.transitionToCodePhase.mockResolvedValueOnce(null);
      else fx.transitionToCodePhase.mockRejectedValueOnce(new Error('phase locked'));
      const onSideEffect = vi.fn();

      const ok = await fx.driver.current!.dispatchSpecReview(fx.task, { onSideEffect });

      expect(ok).toBe(false);
      expect(onSideEffect).toHaveBeenCalledOnce();
      expect(fx.task.signalToken).not.toBe('entry-token');
      expect(interventionPhases(fx)).toContain('server-spec-auto-approve-transition-failed');
    },
  );

  it('dispatchSpecReview stores the spec round and dispatches the QA spec review', async () => {
    const fx = makeFixture({ status: 'review', phase: 'spec', specReviewRound: 0 });
    const ok = await fx.driver.current!.dispatchSpecReview(fx.task);

    expect(ok).toBe(true);
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { phase: string }];
    expect(opts.phase).toBe('spec');
    expect(await fx.store.getRound('t1', 'spec', 1)).toMatchObject({ round: 1, phase: 'spec' });
  });

  it('dispatchCodeReview sends an oversized diff once with review head metadata', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 0 });
    fx.transport.readContent.mockResolvedValue({
      content: TWO_BATCH_DIFF,
      diffstat: ' 2 files',
      baseSha: 'base123',
      headSha: 'head123',
      headTree: 'tree123',
      defaultBranch: 'main',
    });

    const ok = await fx.driver.current!.dispatchCodeReview(fx.task);

    expect(ok).toBe(true);
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { batch?: { index: number; total: number }; headTree?: string }];
    expect(opts.batch).toBeUndefined();
    expect(opts.headTree).toBe('tree123');
  });

  it('dispatchCodeReview from fixing dispatches a recheck carrying the stored prior findings and response', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 });
    const response: ReviewResponse = { round: 1, responses: [{ findingId: 'f-1', action: 'fix', rationale: 'done' }] };
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC, response });

    const ok = await fx.driver.current!.dispatchCodeReview(fx.task);

    expect(ok).toBe(true);
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { recheck: boolean; priorFindingsJson?: string; priorResponseJson?: string }];
    expect(opts.recheck).toBe(true);
    expect(opts.priorFindingsJson).toBe(JSON.stringify(FINDINGS_RC));
    expect(opts.priorResponseJson).toBe(JSON.stringify(response));
  });

  it('dispatchCodeReview redispatching a hung round reuses the latest verdict round as priors', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 2 });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    await putRound(fx.store, 'code', 2);

    const ok = await fx.driver.current!.dispatchCodeReview(fx.task);

    expect(ok).toBe(true);
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { recheck: boolean; priorFindingsJson?: string; priorResponseJson?: string }];
    expect(opts.recheck).toBe(true);
    expect(opts.priorFindingsJson).toBe(JSON.stringify(FINDINGS_RC));
    expect(opts.priorResponseJson).toBeUndefined();
  });

  it('dispatchSpecReview redispatching a hung spec round forwards stored findings without a response', async () => {
    const fx = makeFixture({ status: 'review', phase: 'spec', specReviewRound: 1 });
    const specFindings = { ...FINDINGS_RC };
    await putRound(fx.store, 'spec', 1, { findings: specFindings });

    const ok = await fx.driver.current!.dispatchSpecReview(fx.task);

    expect(ok).toBe(true);
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { phase: string; priorFindingsJson?: string; priorResponseJson?: string }];
    expect(opts.phase).toBe('spec');
    expect(opts.priorFindingsJson).toBe(JSON.stringify(specFindings));
    expect(opts.priorResponseJson).toBeUndefined();
  });

  it('dispatchSpecReview replays the persisted cap round without rereading or overwriting it', async () => {
    const fx = makeFixture(
      { status: 'review', phase: 'spec', specReviewRound: 3 },
      { rounds: 3 },
    );
    await putRound(fx.store, 'spec', 3, {
      content: 'persisted cap spec',
      documents: [{ relPath: '.baxian/spec.md', content: 'persisted cap spec' }],
      startedAt: 'original-start',
    });
    const expectedTask = {
      status: fx.task.status,
      phase: fx.task.phase,
      signalToken: fx.task.signalToken,
      agentId: fx.task.agentId,
      reviewRound: fx.task.reviewRound,
      specReviewRound: fx.task.specReviewRound,
    };

    const ok = await fx.driver.current!.dispatchSpecReview(fx.task, {
      bumpRound: false,
      expectedTask,
    });

    expect(ok).toBe(true);
    expect(fx.transport.readContent).not.toHaveBeenCalled();
    expect(await fx.store.getRound('t1', 'spec', 3)).toMatchObject({
      round: 3,
      content: 'persisted cap spec',
      startedAt: 'original-start',
    });
    expect(fx.calls.transitionTaskStatus).not.toContainEqual(['t1', 'max_rounds']);
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
    expect(fx.calls.dispatchServerReviewToQa[0]?.[1]).toMatchObject({
      phase: 'spec',
      content: 'persisted cap spec',
      bumpRound: false,
      expectedTask,
    });
  });

  it('dispatchSpecReview preserves an explicit round bump through the QA dispatcher', async () => {
    const fx = makeFixture({ status: 'review', phase: 'spec', specReviewRound: 1 });

    const ok = await fx.driver.current!.dispatchSpecReview(fx.task, { bumpRound: true });

    expect(ok).toBe(true);
    expect(fx.calls.dispatchServerReviewToQa[0]?.[1]).toMatchObject({
      phase: 'spec',
      bumpRound: true,
    });
  });

  it('dispatchCodeReview replays the persisted cap round without rereading or overwriting it', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 3 }, { rounds: 3 });
    await putRound(fx.store, 'code', 3, {
      content: 'persisted cap diff',
      baseSha: 'persisted-base',
      headSha: 'persisted-head',
      headTree: 'persisted-tree',
      diffstat: ' 1 file changed',
      startedAt: 'original-start',
    });
    const expectedTask = {
      status: fx.task.status,
      phase: fx.task.phase,
      signalToken: fx.task.signalToken,
      agentId: fx.task.agentId,
      reviewRound: fx.task.reviewRound,
      specReviewRound: fx.task.specReviewRound,
    };

    const ok = await fx.driver.current!.dispatchCodeReview(fx.task, {
      bumpRound: false,
      expectedTask,
    });

    expect(ok).toBe(true);
    expect(fx.transport.readContent).not.toHaveBeenCalled();
    expect(await fx.store.getRound('t1', 'code', 3)).toMatchObject({
      round: 3,
      content: 'persisted cap diff',
      startedAt: 'original-start',
    });
    expect(fx.calls.transitionTaskStatus).not.toContainEqual(['t1', 'max_rounds']);
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
    expect(fx.calls.dispatchServerReviewToQa[0]?.[1]).toMatchObject({
      phase: 'code',
      content: 'persisted cap diff',
      reviewHeadAnchorSha: 'persisted-head',
      bumpRound: false,
      expectedTask,
    });
  });

  it('dispatchCodeReview preserves an explicit round bump through the QA dispatcher', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 1 });

    const ok = await fx.driver.current!.dispatchCodeReview(fx.task, { bumpRound: true });

    expect(ok).toBe(true);
    expect(fx.calls.dispatchServerReviewToQa[0]?.[1]).toMatchObject({
      phase: 'code',
      bumpRound: true,
    });
  });

  it('dispatchCodeReview from fixing reads and stores the pending response file before the recheck', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    const pending: ReviewResponse = { round: 1, responses: [{ findingId: 'f-1', action: 'fix', rationale: 'done' }] };
    fx.transport.readResponse.mockResolvedValue(pending);
    const expectedTask = {
      status: fx.task.status,
      phase: fx.task.phase,
      signalToken: fx.task.signalToken,
      agentId: fx.task.agentId,
      reviewRound: fx.task.reviewRound,
      specReviewRound: fx.task.specReviewRound,
    };
    const onSideEffect = vi.fn();

    const ok = await fx.driver.current!.dispatchCodeReview(fx.task, { expectedTask, onSideEffect });

    expect(ok).toBe(true);
    const normalized = {
      ...pending,
      token: 'tok123',
      findingsDigest: reviewFindingsDigest(FINDINGS_RC),
    };
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, {
      recheck: boolean;
      priorResponseJson?: string;
      expectedTask?: unknown;
      onSideEffect?: () => void;
    }];
    expect(opts.recheck).toBe(true);
    expect(opts.priorResponseJson).toBe(JSON.stringify(normalized));
    expect(opts.expectedTask).toBe(expectedTask);
    expect(opts.onSideEffect).toBe(onSideEffect);
    expect(onSideEffect).toHaveBeenCalled();
    expect((await fx.store.getRound('t1', 'code', 1))?.response).toEqual(normalized);
    expect(fx.transport.deleteResponse).toHaveBeenCalled();
  });

  it('dispatchCodeReview from fixing refuses to recheck when no dev response exists anywhere', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });

    const ok = await fx.driver.current!.dispatchCodeReview(fx.task);

    expect(ok).toBe(false);
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
    expect(interventionPhases(fx)).toContain('server-code-response-missing');
  });

  it('dispatchCodeReview from fixing enforces response coverage like the fix-submitted path', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponse.mockResolvedValue({ round: 1, responses: [{ findingId: 'f-unknown', action: 'fix', rationale: 'x' }] });

    const ok = await fx.driver.current!.dispatchCodeReview(fx.task);

    expect(ok).toBe(false);
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
    expect(interventionPhases(fx)).toContain('server-code-response-coverage-gap');
  });

  it('dispatchSpecReview from fixing refuses to recheck without a dev response', async () => {
    const fx = makeFixture({ status: 'fixing', phase: 'spec', specReviewRound: 1 });
    await putRound(fx.store, 'spec', 1, { findings: { ...FINDINGS_RC } });

    const ok = await fx.driver.current!.dispatchSpecReview(fx.task);

    expect(ok).toBe(false);
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
    expect(interventionPhases(fx)).toContain('server-spec-response-missing');
  });

  it('dispatchSpecReview from fixing preserves its generation guard and side-effect callback', async () => {
    const fx = makeFixture({ status: 'fixing', phase: 'spec', specReviewRound: 1 });
    await putRound(fx.store, 'spec', 1, { findings: { ...FINDINGS_RC } });
    fx.transport.readResponse.mockResolvedValue({
      round: 1,
      responses: [{ findingId: 'f-1', action: 'fix', rationale: 'done' }],
    });
    const expectedTask = {
      status: fx.task.status,
      phase: fx.task.phase,
      signalToken: fx.task.signalToken,
      agentId: fx.task.agentId,
      reviewRound: fx.task.reviewRound,
      specReviewRound: fx.task.specReviewRound,
    };
    const onSideEffect = vi.fn();

    const ok = await fx.driver.current!.dispatchSpecReview(fx.task, { expectedTask, onSideEffect });

    expect(ok).toBe(true);
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, {
      expectedTask?: unknown;
      onSideEffect?: () => void;
    }];
    expect(opts.expectedTask).toBe(expectedTask);
    expect(opts.onSideEffect).toBe(onSideEffect);
    expect(onSideEffect).toHaveBeenCalled();
  });
});

describe('intervention emit failure containment', () => {
  it('a failing human.intervention emit is warned, the handler itself does not throw', async () => {
    const fx = makeFixture();
    const original = fx.bus.emit.bind(fx.bus);
    vi.spyOn(fx.bus, 'emit').mockImplementation(async (e: BaxianEvent) => {
      if (e.type === 'human.intervention') throw new Error('bus down');
      return original(e);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await fx.emit('server.code.ready', { kind: 'code-done' });
      expect(warnSpy).toHaveBeenCalledWith(
        '[ServerEventHandler] intervention emit failed:',
        expect.any(Error),
      );
      expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('prompt content passthrough', () => {
  it('oversized single-batch diff reaches dispatch untruncated; stored round keeps the full diff', async () => {
    const fx = makeFixture();
    const hugeDiff = `diff --git a/a.ts b/a.ts\n+${'哈'.repeat(30000)}`;
    fx.transport.readContent.mockResolvedValue({
      content: hugeDiff,
      baseSha: 'base123',
      headSha: 'head123',
      headTree: 'tree123',
    });
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });

    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { content: string; contentTruncated?: boolean }];
    expect(opts.content).toBe(hugeDiff);
    expect(opts.contentTruncated).toBeUndefined();

    const round = await fx.store.getRound('t1', 'code', 1);
    expect(round?.content).toBe(hugeDiff);
  });

  it('oversized spec reaches dispatch untruncated', async () => {
    const fx = makeFixture({ phase: undefined, status: 'in_progress', specReviewRound: 0 });
    const hugeSpec = `# spec\n${'内容'.repeat(20000)}`;
    fx.transport.readContent.mockResolvedValue({
      content: hugeSpec,
      documents: [{ relPath: '.baxian/spec.md', content: hugeSpec }],
    });
    await fx.emit('server.spec.ready', { token: 'tok123', kind: 'spec-done' });

    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { content: string; contentTruncated?: boolean }];
    expect(opts.content).toBe(hugeSpec);
    expect(opts.contentTruncated).toBeUndefined();
  });
});

describe('auto-approve failure paths', () => {
  it('code auto-approve with a missing dev agent → intervention, nothing transitions', async () => {
    const fx = makeFixture({ qaAgentId: undefined, agentId: 'ghost' }, { afterDone: 'branch' });
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expect(interventionPhases(fx)).toContain('server-code-auto-approve-no-dev-agent');
    expect(fx.calls.transitionTaskStatus).toHaveLength(0);
    expect(fx.calls.dispatchServerAfterDone).toHaveLength(0);
  });

  it('code auto-approve approved-transition refusal → intervention, afterDone not dispatched', async () => {
    const fx = makeFixture({ qaAgentId: undefined }, { afterDone: 'branch' });
    fx.transitionTaskStatus.mockResolvedValueOnce(null);
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expect(interventionPhases(fx)).toContain('server-code-auto-approve-transition-failed');
    expect(fx.calls.dispatchServerAfterDone).toHaveLength(0);
  });

  it('spec auto-approve transition refusal (null result) → intervention', async () => {
    const fx = makeFixture({ qaAgentId: undefined, phase: undefined });
    fx.transitionToCodePhase.mockResolvedValueOnce(null);
    await fx.emit('server.spec.ready', { token: 'tok123', kind: 'spec-done' });
    expect(interventionPhases(fx)).toContain('server-spec-auto-approve-transition-failed');
  });

  it('spec auto-approve transition throw → intervention carrying the error', async () => {
    const fx = makeFixture({ qaAgentId: undefined, phase: undefined });
    fx.transitionToCodePhase.mockRejectedValueOnce(new Error('phase locked'));
    await fx.emit('server.spec.ready', { token: 'tok123', kind: 'spec-done' });
    const intervention = fx.emitted.find(
      e => e.type === 'human.intervention'
        && (e.data as { phase?: string }).phase === 'server-spec-auto-approve-transition-failed',
    );
    expect(intervention).toBeDefined();
    expect((intervention?.data as { error?: string }).error).toBe('phase locked');
  });
});

describe('code verdict approve transition refusal', () => {
  it('approved transition returning null → intervention, afterDone not dispatched', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 1 }, { afterDone: 'pr' });
    await putRound(fx.store, 'code', 1);
    fx.transport.readFindings.mockResolvedValue(APPROVE_R1);
    fx.transitionTaskStatus.mockResolvedValueOnce(null);
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    expect(interventionPhases(fx)).toContain('server-code-approved-transition-failed');
    expect(fx.calls.dispatchServerAfterDone).toHaveLength(0);
  });

  it('does not commit afterDone or approve a superseded review generation', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 1 }, { afterDone: 'pr' });
    await putRound(fx.store, 'code', 1);
    fx.transport.readFindings.mockImplementationOnce(async () => {
      fx.task.signalToken = 'new-review-generation';
      return APPROVE_R1;
    });

    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });

    expect(fx.commitServerAfterDone).not.toHaveBeenCalled();
    expect(fx.task.afterDone).toBeUndefined();
    expect(fx.task.status).toBe('review');
    expect(fx.calls.dispatchServerAfterDone).toHaveLength(0);
  });

  it('does not enter max_rounds for a superseded review generation', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 3 }, { rounds: 3 });
    await putRound(fx.store, 'code', 3);
    fx.transport.readFindings.mockImplementationOnce(async () => {
      fx.task.signalToken = 'new-review-generation';
      return { ...FINDINGS_RC, round: 3 };
    });

    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });

    const capCall = fx.transitionTaskStatus.mock.calls.find(call => call[1] === 'max_rounds');
    expect(capCall).toBeUndefined();
    expect(fx.task.status).toBe('review');
    expect(fx.calls.releaseAgentForTask).toHaveLength(0);
  });
});

describe('code fix response guards', () => {
  it('response file missing with no stored response → intervention + code-fixed correction generation', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponse.mockResolvedValue(null);
    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });
    expect(interventionPhases(fx)).toContain('server-code-response-missing');
    expectConsumedSignalFenced(fx, 'dev-1', 'code-fixed');
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });

  it('stale response round → archived, deleted, and replaced by a correction generation', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponse.mockResolvedValue({
      round: 2,
      responses: [{ findingId: 'f-1', action: 'fix', rationale: 'late' }],
    });
    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });
    expect(interventionPhases(fx)).toContain('server-code-response-round-mismatch');
    expect(fx.transport.deleteResponse).toHaveBeenCalled();
    expectConsumedSignalFenced(fx, 'dev-1', 'code-fixed');
    const round = await fx.store.getRound('t1', 'code', 1);
    expect(round?.response).toBeUndefined();
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });
});

describe('publish failure paths', () => {
  it('publish with a missing dev config → intervention, no ready transition', async () => {
    const fx = makeFixture({ status: 'approved', agentId: 'ghost' });
    await fx.emit('server.code.published', { token: 'tok123', kind: 'code-ready' });
    expect(interventionPhases(fx)).toContain('server-code-published-no-dev-agent');
    expect(fx.calls.transitionTaskStatus).not.toContainEqual(['t1', 'ready']);
  });

  it('published head read failure → intervention + code-ready fence', async () => {
    const fx = makeFixture({ status: 'approved', reviewHeadAnchorSha: 'head123' });
    fx.transport.readHeadSha.mockRejectedValueOnce(new Error('git down'));
    await fx.emit('server.code.published', { token: 'tok123', kind: 'code-ready' });
    expect(interventionPhases(fx)).toContain('server-code-published-head-capture-failed');
    expectConsumedSignalFenced(fx, 'dev-1', 'code-ready');
    expect(fx.calls.transitionTaskStatus).not.toContainEqual(['t1', 'ready']);
  });

  it('publish metadata persist failure → intervention + code-ready fence, no ready transition', async () => {
    const fx = makeFixture({ status: 'approved', reviewHeadAnchorSha: 'head123' });
    fx.transitionTaskStatus.mockRejectedValueOnce(new Error('disk full'));
    await fx.emit('server.code.published', { token: 'tok123', kind: 'code-ready' });
    expect(interventionPhases(fx)).toContain('server-code-published-head-capture-failed');
    expectConsumedSignalFenced(fx, 'dev-1', 'code-ready');
    expect(fx.calls.transitionTaskStatus).not.toContainEqual(['t1', 'ready']);
  });
});

describe('spec review failure paths', () => {
  it('spec content read failure → intervention + spec-done fence', async () => {
    const fx = makeFixture({ phase: undefined, status: 'in_progress' });
    fx.transport.readContent.mockRejectedValue(new Error('read fail'));
    await fx.emit('server.spec.ready', { token: 'tok123', kind: 'spec-done' });
    expect(interventionPhases(fx)).toContain('server-spec-content-read-failed');
    expectConsumedSignalFenced(fx, 'dev-1', 'spec-done');
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });

  it('spec round store failure → intervention + spec-done fence', async () => {
    const fx = makeFixture({ phase: undefined, status: 'in_progress' });
    fx.transport.readContent.mockResolvedValue({
      content: '# Spec',
      documents: [{ relPath: '.baxian/spec.md', content: '# Spec' }],
    });
    const failing = fx.store as unknown as { putRound: (...a: unknown[]) => Promise<void> };
    failing.putRound = async () => { throw new Error('disk full'); };
    await fx.emit('server.spec.ready', { token: 'tok123', kind: 'spec-done' });
    expect(interventionPhases(fx)).toContain('server-spec-round-store-failed');
    expectConsumedSignalFenced(fx, 'dev-1', 'spec-done');
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });

  it('spec findings read failure → intervention + spec-reviewed fence', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'review', specReviewRound: 1 });
    await putRound(fx.store, 'spec', 1);
    fx.transport.readFindings.mockRejectedValue(new Error('bad json'));
    await fx.emit('server.spec.review.submitted', { token: 'tok123', kind: 'spec-reviewed' });
    expect(interventionPhases(fx)).toContain('server-spec-findings-invalid');
    expectConsumedSignalFenced(fx, 'qa-1', 'spec-reviewed');
    expect(fx.calls.transitionToCodePhase).toHaveLength(0);
  });

  it('spec findings missing (never stored) → intervention + spec-reviewed fence', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'review', specReviewRound: 1 });
    await putRound(fx.store, 'spec', 1);
    fx.transport.readFindings.mockResolvedValue(null);
    await fx.emit('server.spec.review.submitted', { token: 'tok123', kind: 'spec-reviewed' });
    expect(interventionPhases(fx)).toContain('server-spec-findings-missing');
    expectConsumedSignalFenced(fx, 'qa-1', 'spec-reviewed');
  });

  it('stale spec findings round → preserved + fenced, verdict never stored or routed', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'review', specReviewRound: 1 });
    await putRound(fx.store, 'spec', 1);
    fx.transport.readFindings.mockResolvedValue({ ...APPROVE_R1, round: 2 });
    await fx.emit('server.spec.review.submitted', { token: 'tok123', kind: 'spec-reviewed' });
    expect(interventionPhases(fx)).toContain('server-spec-findings-round-mismatch');
    expect(fx.transport.deleteFindings).not.toHaveBeenCalled();
    expectConsumedSignalFenced(fx, 'qa-1', 'spec-reviewed');
    const round = await fx.store.getRound('t1', 'spec', 1);
    expect(round?.findings).toBeUndefined();
    expect(fx.calls.transitionToCodePhase).toHaveLength(0);
  });

  it('spec approve with a throwing code-phase transition → intervention', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'review', specReviewRound: 1 });
    await putRound(fx.store, 'spec', 1);
    fx.transport.readFindings.mockResolvedValue(APPROVE_R1);
    fx.transitionToCodePhase.mockRejectedValueOnce(new Error('locked'));
    await fx.emit('server.spec.review.submitted', { token: 'tok123', kind: 'spec-reviewed' });
    const intervention = fx.emitted.find(
      e => e.type === 'human.intervention'
        && (e.data as { phase?: string }).phase === 'server-spec-approve-transition-failed',
    );
    expect(intervention).toBeDefined();
    expect((intervention?.data as { error?: string }).error).toBe('locked');
  });

  it('spec request-changes below the cap dispatches the fix to dev with findings JSON', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'review', specReviewRound: 1 });
    await putRound(fx.store, 'spec', 1);
    fx.transport.readFindings.mockResolvedValue({
      round: 1,
      verdict: 'request-changes',
      findings: [{ id: 'f-1', severity: 'major', message: 'gap', location: 'S1' }],
    });
    await fx.emit('server.spec.review.submitted', { token: 'tok123', kind: 'spec-reviewed' });
    expect(fx.calls.dispatchServerFixToDev).toHaveLength(1);
    const [, json, opts] = fx.calls.dispatchServerFixToDev[0] as [string, string, {
      expectedTask?: unknown;
    }];
    expect(JSON.parse(json).findings[0].id).toBe('f-1');
    expect(opts.expectedTask).toEqual({
      status: 'review',
      phase: 'spec',
      signalToken: 'tok123',
      agentId: 'dev-1',
      reviewRound: 0,
      specReviewRound: 1,
    });
    const round = await fx.store.getRound('t1', 'spec', 1);
    expect(round?.findings?.verdict).toBe('request-changes');
  });
});

describe('spec fix response guards', () => {
  const SPEC_ROUND_FINDINGS = {
    findings: {
      round: 1,
      verdict: 'request-changes',
      findings: [{ id: 'f-1', severity: 'major', message: 'gap', location: 'S1' }],
    } as ReviewFindings,
  };

  it('invalid spec response → intervention + spec-fixed correction generation', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'fixing', specReviewRound: 1 });
    await putRound(fx.store, 'spec', 1, SPEC_ROUND_FINDINGS);
    const raw = '{"round":';
    fx.transport.readResponseWithRaw.mockResolvedValue({
      kind: 'invalid',
      raw,
      responseDigest: sha256Hex(raw),
      error: new Error('corrupt'),
      schemaViolationCodes: ['malformed-json'],
    });
    await fx.emit('server.spec.fix.submitted', { token: 'tok123', kind: 'spec-fixed' });
    expect(interventionPhases(fx)).toContain('server-spec-response-invalid');
    expectConsumedSignalFenced(fx, 'dev-1', 'spec-fixed');
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });

  it('spec response missing with none stored → intervention + spec-fixed correction generation', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'fixing', specReviewRound: 1 });
    await putRound(fx.store, 'spec', 1, SPEC_ROUND_FINDINGS);
    fx.transport.readResponse.mockResolvedValue(null);
    await fx.emit('server.spec.fix.submitted', { token: 'tok123', kind: 'spec-fixed' });
    expect(interventionPhases(fx)).toContain('server-spec-response-missing');
    expectConsumedSignalFenced(fx, 'dev-1', 'spec-fixed');
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });

  it('stale spec response round → archived, deleted, and replaced by a correction generation', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'fixing', specReviewRound: 1 });
    await putRound(fx.store, 'spec', 1, SPEC_ROUND_FINDINGS);
    fx.transport.readResponse.mockResolvedValue({
      round: 2,
      responses: [{ findingId: 'f-1', action: 'fix', rationale: 'late' }],
    });
    await fx.emit('server.spec.fix.submitted', { token: 'tok123', kind: 'spec-fixed' });
    expect(interventionPhases(fx)).toContain('server-spec-response-round-mismatch');
    expect(fx.transport.deleteResponse).toHaveBeenCalled();
    expectConsumedSignalFenced(fx, 'dev-1', 'spec-fixed');
    const round = await fx.store.getRound('t1', 'spec', 1);
    expect(round?.response).toBeUndefined();
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });
});

describe('completion settle permit threading (spec C4)', () => {
  const emitWithPermit = async (
    fx: Fixture,
    type: string,
    data: Record<string, unknown>,
    permit: symbol,
  ): Promise<void> => {
    const event = {
      id: '',
      type: type as BaxianEvent['type'],
      timestamp: new Date().toISOString(),
      projectId: 'proj',
      taskId: fx.task.id,
      data,
    };
    Object.defineProperty(event, SETTLE_PERMIT, { value: permit, enumerable: false });
    await fx.bus.emit(event as BaxianEvent);
  };
  const dispatchPermits = (fx: Fixture): unknown[] =>
    fx.calls.dispatchServerReviewToQa.map(([, opts]) => (opts as { settlePermit?: unknown }).settlePermit);

  it('code-done threads the event permit into the first review dispatch', async () => {
    const fx = makeFixture();
    const permit = Symbol('settle');
    await emitWithPermit(fx, 'server.code.ready', { token: 'tok123', kind: 'code-done' }, permit);
    expect(dispatchPermits(fx)).toEqual([permit]);
  });

  it('spec-done threads the event permit into the spec review dispatch', async () => {
    const fx = makeFixture({ phase: undefined, status: 'in_progress' });
    fx.transport.readContent.mockResolvedValue({
      content: '# Spec',
      documents: [{ relPath: '.baxian/spec.md', content: '# Spec' }],
    });
    const permit = Symbol('settle');
    await emitWithPermit(fx, 'server.spec.ready', { token: 'tok123', kind: 'spec-done' }, permit);
    expect(dispatchPermits(fx)).toEqual([permit]);
  });

  it('code-fixed threads the event permit into the recheck dispatch', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 });
    await putRound(fx.store, 'code', 1, {
      findings: FINDINGS_RC,
      response: {
        round: 1, token: 'tok123',
        findingsDigest: reviewFindingsDigest(FINDINGS_RC), responses: [],
      },
    });
    const permit = Symbol('settle');
    await emitWithPermit(fx, 'server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' }, permit);
    expect(dispatchPermits(fx)).toEqual([permit]);
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { recheck?: boolean }];
    expect(opts.recheck).toBe(true);
  });

  it('spec-fixed threads the event permit into the spec re-review dispatch', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'fixing', specReviewRound: 1 });
    await putRound(fx.store, 'spec', 1, {
      findings: FINDINGS_RC,
      response: {
        round: 1, token: 'tok123',
        findingsDigest: reviewFindingsDigest(FINDINGS_RC), responses: [],
      },
    });
    const permit = Symbol('settle');
    await emitWithPermit(fx, 'server.spec.fix.submitted', { token: 'tok123', kind: 'spec-fixed' }, permit);
    expect(dispatchPermits(fx)).toEqual([permit]);
  });

  it('legacy batch code-reviewed threads the event permit into the next-batch continuation', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 1, batchIndex: 0, batchTotal: 2 });
    await putRound(fx.store, 'code', 1, { content: TWO_BATCH_DIFF, diffstat: 'stat', batchFindings: [] });
    fx.transport.readFindings.mockResolvedValue(FINDINGS_RC);
    const permit = Symbol('settle');
    await emitWithPermit(fx, 'server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' }, permit);
    expect(dispatchPermits(fx)).toEqual([permit]);
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { continuation?: boolean }];
    expect(opts.continuation).toBe(true);
  });

  it('a permit-less event dispatches without settlePermit (manual pipeline shape)', async () => {
    const fx = makeFixture();
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expect(dispatchPermits(fx)).toEqual([undefined]);
  });
});
