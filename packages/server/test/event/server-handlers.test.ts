import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/event/bus.js';
import { registerServerEventHandlers } from '../../src/event/server-handlers.js';
import { ReviewStore } from '../../src/state/review-store.js';
import type { AgentManager } from '../../src/agent/manager.js';
import type { EventLog } from '../../src/event/log.js';
import type {
  BaxianEvent,
  ReviewFindings,
  ReviewResponse,
  ReviewRound,
  TaskState,
} from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';

const DEV = { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local', projectId: 'proj' };
const QA = { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local', projectId: 'proj' };

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 't1',
    projectId: 'proj',
    title: 'T',
    description: 'D',
    preferredAgentId: 'dev-1',
    agentId: 'dev-1',
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

interface Fixture {
  bus: EventBus;
  store: ReviewStore;
  task: TaskState;
  calls: Record<string, unknown[][]>;
  transport: {
    readContent: ReturnType<typeof vi.fn>;
    readFindings: ReturnType<typeof vi.fn>;
    readResponse: ReturnType<typeof vi.fn>;
    deleteFindings: ReturnType<typeof vi.fn>;
    deleteResponse: ReturnType<typeof vi.fn>;
    readFileRange: ReturnType<typeof vi.fn>;
    readHeadSha: ReturnType<typeof vi.fn>;
  };
  releaseAgentForTask: ReturnType<typeof vi.fn>;
  getAgentState: ReturnType<typeof vi.fn>;
  transitionTaskStatus: ReturnType<typeof vi.fn>;
  transitionToCodePhase: ReturnType<typeof vi.fn>;
  updateTask: ReturnType<typeof vi.fn>;
  emitted: BaxianEvent[];
  emit: (type: string, data: Record<string, unknown>) => Promise<void>;
}

function makeFixture(taskOverrides: Partial<TaskState> = {}, config: { rounds?: number; afterDone?: 'pr' | 'branch' | null; verifyPr?: boolean; specApproval?: 'human' | null } = {}): Fixture {
  const emitted: BaxianEvent[] = [];
  const bus = new EventBus({ append: async (e: BaxianEvent) => { emitted.push(e); } } as unknown as EventLog);
  const store = new ReviewStore();
  const task = makeTask(taskOverrides);
  const calls: Record<string, unknown[][]> = {
    dispatchServerReviewToQa: [],
    dispatchServerFixToDev: [],
    dispatchServerAfterDone: [],
    transitionTaskStatus: [],
    updateTask: [],
    transitionToCodePhase: [],
    parkTaskAtSpecReady: [],
    setupPhaseSignal: [],
    holdAgentForUnarmedSignal: [],
    releaseAgentForTask: [],
  };
  const transport = {
    readContent: vi.fn(async () => ({ content: 'diff --git a/a.ts b/a.ts\n+x', diffstat: ' a.ts | 1 +', baseSha: 'base123', defaultBranch: 'main' })),
    readFindings: vi.fn(async (): Promise<ReviewFindings | null> => null),
    readResponse: vi.fn(async (): Promise<ReviewResponse | null> => null),
    deleteFindings: vi.fn(async () => undefined),
    deleteResponse: vi.fn(async () => undefined),
    readFileRange: vi.fn(async () => ''),
    readHeadSha: vi.fn(async () => 'head123'),
  };
  const transitionTaskStatus = vi.fn(async (id: string, to: TaskState['status'], _guard?: unknown, patch?: unknown) => {
    calls.transitionTaskStatus.push([id, to]);
    task.status = to;
    if (patch && typeof patch === 'object') Object.assign(task, patch);
    return { task, previousStatus: task.status };
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
  const transitionToCodePhase = vi.fn(async (id: string) => {
    calls.transitionToCodePhase.push([id]);
    return task;
  });
  const parkTaskAtSpecReady = vi.fn(async (id: string, opts?: { specReviewRound?: number }) => {
    calls.parkTaskAtSpecReady.push(opts === undefined ? [id] : [id, opts]);
    task.status = 'spec-ready';
    task.qaAgentId = undefined;
    if (opts?.specReviewRound !== undefined) task.specReviewRound = opts.specReviewRound;
    return task;
  });
  const projectConfig = {
    id: 'proj', repo: 'u/r', merge: null,
    ...(config.specApproval !== undefined ? { specApproval: config.specApproval } : {}),
    agent: [],
  };
  const manager = {
    getReviewStore: () => store,
    getProjectConfig: (id: string) => (id === 'proj' ? projectConfig : undefined),
    parkTaskAtSpecReady,
    getReviewTransport: () => transport,
    getTask: async () => task,
    getAgentConfig: (id: string) => (id === DEV.id ? DEV : id === QA.id ? QA : undefined),
    findQaPartner: (devId: string) => (devId === DEV.id && task.qaAgentId ? QA : undefined),
    getConfig: () => ({
      review: { rounds: config.rounds ?? 10, mode: 'server', afterDone: config.afterDone ?? null },
      server: DEFAULT_SERVER_CONFIG,
      host: [],
      project: [projectConfig],
    }),
    refreshWorktreeCacheFor: async () => '/wt',
    transitionTaskStatus,
    releaseAgentForTask,
    getAgentState,
    updateTask,
    dispatchServerReviewToQa: vi.fn(async (id: string, opts: unknown) => {
      calls.dispatchServerReviewToQa.push([id, opts]);
      task.status = 'review';
      return task;
    }),
    dispatchServerFixToDev: vi.fn(async (id: string, findings: string) => {
      calls.dispatchServerFixToDev.push([id, findings]);
      task.status = 'fixing';
      return task;
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
      (config.verifyPr ?? true) ? { headRefName: 'bx/t1', headSha: 'h'.repeat(40) } : undefined),
    resolveAfterDone: (t: TaskState) =>
      t.afterDone !== undefined ? t.afterDone : (config.afterDone ?? null),
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
  return { bus, store, task, calls, transport, releaseAgentForTask, getAgentState, transitionTaskStatus, transitionToCodePhase, updateTask, emitted, emit };
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
  const content = phase === 'spec' ? 's' : 'd';
  return store.putRound('t1', phase, { round, phase, content, startedAt: 'now', ...extra });
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

function bigFile(path: string): string {
  return `diff --git a/${path} b/${path}\n${Array.from({ length: 1500 }, (_, i) => `+l${i}`).join('\n')}`;
}

const TWO_BATCH_DIFF = [
  `diff --git a/src/a.ts b/src/a.ts\n${Array.from({ length: 2100 }, () => '+x').join('\n')}`,
  'diff --git a/lib/b.ts b/lib/b.ts\n+y',
].join('\n');

describe('server.code.ready', () => {
  it('reads diff, persists round with baseSha, dispatches review', async () => {
    const fx = makeFixture();
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    const round = await fx.store.getRound('t1', 'code', 1);
    expect(round?.baseSha).toBe('base123');
    expect(round?.content).toContain('diff --git');
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { content: string; recheck: boolean }];
    expect(opts.recheck).toBe(false);
    expect(opts.content).toContain('diff --git');
  });

  it('token mismatch → no dispatch', async () => {
    const fx = makeFixture();
    await fx.emit('server.code.ready', { token: 'WRONG', kind: 'code-done' });
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });

  it('round cap → max_rounds', async () => {
    const fx = makeFixture({ reviewRound: 3 }, { rounds: 3 });
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expect(fx.calls.transitionTaskStatus).toContainEqual(['t1', 'max_rounds']);
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });

  it('large diff → first batch dispatched with batch meta', async () => {
    const fx = makeFixture();
    fx.transport.readContent.mockResolvedValue({
      content: [bigFile('src/a.ts'), bigFile('lib/b.ts')].join('\n'),
      diffstat: 'stat',
      baseSha: 'base123',
    });
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { batch?: { index: number; total: number } }];
    expect(opts.batch).toEqual({ index: 0, total: 2 });
    const round = await fx.store.getRound('t1', 'code', 1);
    expect(round?.batchFindings).toEqual([]);
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

  it('code-done without QA partner → head capture failure re-arms code-done', async () => {
    const fx = makeFixture({ qaAgentId: undefined }, { afterDone: 'branch' });
    fx.transport.readHeadSha.mockRejectedValueOnce(new Error('git failed'));
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expect(fx.calls.transitionTaskStatus).toHaveLength(0);
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'dev-1', 'code-done']);
    expect(fx.emitted.some(e => e.type === 'human.intervention'
      && (e.data as Record<string, unknown>)?.phase === 'server-code-auto-approve-head-capture-failed')).toBe(true);
  });

  it('spec-done without QA partner → auto-approve spec, transition to code phase', async () => {
    const fx = makeFixture({ qaAgentId: undefined, phase: undefined });
    await fx.emit('server.spec.ready', { token: 'tok123', kind: 'spec-done' });
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
    expect(fx.calls.transitionToCodePhase).toContainEqual(['t1']);
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
    const [, json] = fx.calls.dispatchServerFixToDev[0] as [string, string];
    expect(JSON.parse(json).findings[0].id).toBe('f-1');
  });

  it('batched: stashes slice, dispatches next batch as continuation with diffstat', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 1, batchIndex: 0, batchTotal: 2 });
    await putRound(fx.store, 'code', 1, { content: TWO_BATCH_DIFF, diffstat: 'FULL-SCOPE-STAT', batchFindings: [] });
    fx.transport.readFindings.mockResolvedValue(FINDINGS_RC);
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    const round = await fx.store.getRound('t1', 'code', 1);
    expect(round?.batchFindings?.[0]?.findings[0].id).toBe('f-1');
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { continuation?: boolean; batch?: { index: number }; diffstat?: string }];
    expect(opts.continuation).toBe(true);
    expect(opts.batch?.index).toBe(1);
    expect(opts.diffstat).toBe('FULL-SCOPE-STAT');
  });

  it('last batch aggregates with namespaced ids and routes verdict', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 1, batchIndex: 1, batchTotal: 2 });
    await putRound(fx.store, 'code', 1, {
      batchFindings: [{ round: 1, verdict: 'approve', findings: [{ id: 'f-1', severity: 'minor', message: 'nit' }] }],
    });
    fx.transport.readFindings.mockResolvedValue(FINDINGS_RC);
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    const round = await fx.store.getRound('t1', 'code', 1);
    expect(round?.findings?.verdict).toBe('request-changes');
    expect(round?.findings?.findings.map(f => f.id)).toEqual(['b0-f-1', 'b1-f-1']);
    expect(fx.calls.updateTask).toContainEqual(['t1', { batchIndex: undefined, batchTotal: undefined }]);
    expect(fx.calls.dispatchServerFixToDev).toHaveLength(1);
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
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'dev-1', 'code-fixed']);
  });

  it('unknown findingId → intervention with unknownFindingIds, response not stored, re-armed', async () => {
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
    expect(fx.transport.deleteResponse).not.toHaveBeenCalled();
    const round = await fx.store.getRound('t1', 'code', 1);
    expect(round?.response).toBeUndefined();
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'dev-1', 'code-fixed']);
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
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { recheck: boolean; priorFindingsJson?: string }];
    expect(opts.recheck).toBe(true);
    expect(opts.priorFindingsJson).toContain('f-1');
  });
});

describe('server.code.published', () => {
  it('records prNumber and transitions to ready', async () => {
    const fx = makeFixture({ status: 'approved', reviewHeadAnchorSha: 'head123' });
    await fx.emit('server.code.published', { token: 'tok123', kind: 'code-ready', prNumber: 42 });
    expect(fx.calls.updateTask).toContainEqual(['t1', { prNumber: 42 }]);
    expect(fx.calls.transitionTaskStatus).toContainEqual(['t1', 'ready']);
  });
});

describe('server.spec flow', () => {
  it('spec-done → spec content dispatched for review', async () => {
    const fx = makeFixture({ phase: undefined, status: 'in_progress' });
    fx.transport.readContent.mockResolvedValue({ content: '# Spec' });
    await fx.emit('server.spec.ready', { token: 'tok123', kind: 'spec-done' });
    const round = await fx.store.getRound('t1', 'spec', 1);
    expect(round?.content).toBe('# Spec');
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { phase: string; content: string }];
    expect(opts.phase).toBe('spec');
    expect(opts.content).toBe('# Spec');
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

  it('spec-done without QA partner + specApproval human → stores the spec round then parks', async () => {
    const fx = makeFixture({ phase: undefined, status: 'in_progress', qaAgentId: undefined }, { specApproval: 'human' });
    fx.transport.readContent.mockResolvedValue({ content: '# Spec no-QA' });
    await fx.emit('server.spec.ready', { token: 'tok123', kind: 'spec-done' });
    const round = await fx.store.getRound('t1', 'spec', 1);
    expect(round?.content).toBe('# Spec no-QA');
    expect(fx.calls.parkTaskAtSpecReady).toContainEqual(['t1', { specReviewRound: 1 }]);
    expect(fx.calls.transitionToCodePhase).toHaveLength(0);
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
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
    fx.transport.readContent.mockResolvedValue({ content: '# Spec v2' });
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
    fx.transport.readContent.mockResolvedValue({ content: '# Spec v2' });
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
    fx.transport.readContent.mockResolvedValue({ content: '# Spec v2' });
    await fx.emit('server.spec.fix.submitted', { token: 'tok123', kind: 'spec-fixed' });
    const round2 = await fx.store.getRound('t1', 'spec', 2);
    expect(round2?.content).toBe('# Spec v2');
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
  });

  it('spec-fixed unknown findingId → intervention with unknownFindingIds, response not stored, re-armed', async () => {
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
    expect(fx.transport.deleteResponse).not.toHaveBeenCalled();
    const round = await fx.store.getRound('t1', 'spec', 1);
    expect(round?.response).toBeUndefined();
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'dev-1', 'spec-fixed']);
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

  it('code-reviewed replay mid-batch resumes next batch dispatch', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 1, batchIndex: 0, batchTotal: 2 });
    await putRound(fx.store, 'code', 1, { content: TWO_BATCH_DIFF, batchFindings: [FINDINGS_RC] });
    fx.transport.readFindings.mockResolvedValue(null);
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { batch?: { index: number }; continuation?: boolean }];
    expect(opts.batch?.index).toBe(1);
    expect(opts.continuation).toBe(true);
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
    fx.transport.readContent.mockResolvedValue({ content: '# Spec v2' });
    await fx.emit('server.spec.fix.submitted', { token: 'tok123', kind: 'spec-fixed' });
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
  });

  it('batch continuation derives recheck from round number', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 2, batchIndex: 0, batchTotal: 2 });
    await putRound(fx.store, 'code', 2, { content: TWO_BATCH_DIFF, batchFindings: [] });
    fx.transport.readFindings.mockResolvedValue({ ...FINDINGS_RC, round: 2 });
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { recheck?: boolean }];
    expect(opts.recheck).toBe(true);
  });
});

describe('batched recheck id stability', () => {
  it('aggregation keeps already-namespaced ids unprefixed', async () => {
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

describe('invalid exchange file re-arms the watcher', () => {
  it('malformed findings.json → intervention + same-token code-reviewed re-arm', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 1 });
    await putRound(fx.store, 'code', 1);
    fx.transport.readFindings.mockRejectedValue(new Error('schema violation'));
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'qa-1', 'code-reviewed']);
    expect(fx.calls.dispatchServerFixToDev).toHaveLength(0);
  });

  it('malformed response.json → same-token code-fixed re-arm', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponse.mockRejectedValue(new Error('schema violation'));
    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'dev-1', 'code-fixed']);
  });
});

describe('Codex resilience', () => {
  it('findings missing (not stored) → intervention + re-arm code-reviewed', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 1 });
    await putRound(fx.store, 'code', 1);
    fx.transport.readFindings.mockResolvedValue(null);
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'qa-1', 'code-reviewed']);
    expect(fx.calls.dispatchServerFixToDev).toHaveLength(0);
  });

  it('stale round payload → deleted + re-arm, never routed', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 2 });
    await putRound(fx.store, 'code', 2);
    fx.transport.readFindings.mockResolvedValue({ ...FINDINGS_RC, round: 1 });
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    expect(fx.transport.deleteFindings).toHaveBeenCalled();
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'qa-1', 'code-reviewed']);
    expect(fx.calls.dispatchServerFixToDev).toHaveLength(0);
    const round = await fx.store.getRound('t1', 'code', 2);
    expect(round?.findings).toBeUndefined();
  });

  it('afterDone:pr publish without PR number → re-arm code-ready, no ready transition', async () => {
    const fx = makeFixture({ status: 'approved' }, { afterDone: 'pr' });
    await fx.emit('server.code.published', { token: 'tok123', kind: 'code-ready' });
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'dev-1', 'code-ready']);
    expect(fx.calls.transitionTaskStatus).not.toContainEqual(['t1', 'ready']);
  });

  it('maxRoundsContinues extends the cap by the granted rounds', async () => {
    const fx = makeFixture({ reviewRound: 3, maxRoundsContinues: 1 }, { rounds: 3 });
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
    expect(fx.calls.transitionTaskStatus).not.toContainEqual(['t1', 'max_rounds']);
  });
});

describe('content read failure re-arms the entry signal', () => {
  it('code-done entry → re-arm code-done', async () => {
    const fx = makeFixture();
    fx.transport.readContent.mockRejectedValue(new Error('fetch failed'));
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'dev-1', 'code-done']);
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });

  it('code-fixed recheck entry → re-arm code-fixed', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponse.mockResolvedValue({
      round: 1,
      responses: [{ findingId: 'f-1', action: 'fix', rationale: 'ok' }],
    });
    fx.transport.readContent.mockRejectedValue(new Error('fetch failed'));
    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'dev-1', 'code-fixed']);
  });
});

describe('afterDone snapshot', () => {
  it('approve verdict snapshots afterDone onto the task', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 1 }, { afterDone: 'pr' });
    await putRound(fx.store, 'code', 1);
    fx.transport.readFindings.mockResolvedValue(APPROVE_R1);
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    expect(fx.calls.updateTask).toContainEqual(['t1', { afterDone: 'pr' }]);
  });

  it('publish gate reads the task snapshot, not live config', async () => {
    const fx = makeFixture({ status: 'approved', afterDone: 'pr' }, { afterDone: null });
    await fx.emit('server.code.published', { token: 'tok123', kind: 'code-ready' });
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'dev-1', 'code-ready']);
    expect(fx.calls.transitionTaskStatus).not.toContainEqual(['t1', 'ready']);
  });
});

describe('published head guard', () => {
  it('publish with PR number captures the reviewed head sha', async () => {
    const fx = makeFixture({ status: 'approved', afterDone: 'pr', reviewHeadAnchorSha: 'head123' });
    await fx.emit('server.code.published', { token: 'tok123', kind: 'code-ready', prNumber: 42 });
    expect(fx.calls.updateTask).toContainEqual(['t1', { prNumber: 42 }]);
    expect(fx.calls.updateTask).toContainEqual(['t1', { latestHeadSha: 'head123' }]);
    expect(fx.calls.transitionTaskStatus).toContainEqual(['t1', 'ready']);
  });
});

describe('Codex: reviewed-head anchor', () => {
  it('code review dispatch pins the dev HEAD as reviewHeadAnchorSha', async () => {
    const fx = makeFixture();
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { reviewHeadAnchorSha?: string }];
    expect(opts.reviewHeadAnchorSha).toBe('head123');
  });

  it('batched dispatch pins the anchor on the round-opening slice', async () => {
    const fx = makeFixture();
    fx.transport.readContent.mockResolvedValue({
      content: [bigFile('src/a.ts'), bigFile('lib/b.ts')].join('\n'),
      diffstat: 'stat',
    });
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { batch?: { index: number }; reviewHeadAnchorSha?: string }];
    expect(opts.batch?.index).toBe(0);
    expect(opts.reviewHeadAnchorSha).toBe('head123');
  });

  it('anchor read failure re-arms the entry signal and dispatches nothing (fail-closed)', async () => {
    const fx = makeFixture();
    fx.transport.readHeadSha.mockRejectedValueOnce(new Error('git down'));
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'dev-1', 'code-done']);
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

  it('publish with NO recorded anchor refuses ready (fail-closed)', async () => {
    const fx = makeFixture({ status: 'approved', afterDone: 'pr' });
    await fx.emit('server.code.published', { token: 'tok123', kind: 'code-ready', prNumber: 42 });
    expect(fx.calls.transitionTaskStatus).not.toContainEqual(['t1', 'ready']);
  });
});

describe('guard exits re-arm the consumed signal', () => {
  type ReArmRow = [string, Partial<TaskState>, string, string, string, boolean, SeedRound?];

  const reArmCases: ReArmRow[] = [
    ['code review dispatch with missing dev config re-arms code-done and holds on arm failure',
      { agentId: 'ghost' }, 'server.code.ready', 'code-done', 'ghost', true],
    ['code recheck entry (fixing) with missing dev config re-arms code-fixed and holds on arm failure',
      { status: 'fixing', agentId: 'ghost', reviewRound: 1 }, 'server.code.fix.submitted', 'code-fixed', 'ghost', true],
    ['code verdict with missing qa config re-arms code-reviewed and holds on arm failure',
      { status: 'review', reviewRound: 1, qaAgentId: 'ghost' }, 'server.code.review.submitted', 'code-reviewed', 'ghost', true],
    ['code verdict with missing round data re-arms code-reviewed without holding (arm succeeds)',
      { status: 'review', reviewRound: 1 }, 'server.code.review.submitted', 'code-reviewed', 'qa-1', false],
    ['code fix-submitted with missing stored findings re-arms code-fixed without holding (arm succeeds)',
      { status: 'fixing', reviewRound: 1 }, 'server.code.fix.submitted', 'code-fixed', 'dev-1', false, { phase: 'code', round: 1 }],
    ['spec review dispatch with missing dev config re-arms spec-done and holds on arm failure',
      { phase: 'spec', status: 'in_progress', agentId: 'ghost' }, 'server.spec.ready', 'spec-done', 'ghost', true],
    ['spec verdict with missing qa config re-arms spec-reviewed and holds on arm failure',
      { phase: 'spec', status: 'review', specReviewRound: 1, qaAgentId: 'ghost' }, 'server.spec.review.submitted', 'spec-reviewed', 'ghost', true],
    ['spec verdict with missing round data re-arms spec-reviewed without holding (arm succeeds)',
      { phase: 'spec', status: 'review', specReviewRound: 1 }, 'server.spec.review.submitted', 'spec-reviewed', 'qa-1', false],
    ['spec fix-submitted with missing dev config re-arms spec-fixed and holds on arm failure',
      { phase: 'spec', status: 'fixing', specReviewRound: 1, agentId: 'ghost' }, 'server.spec.fix.submitted', 'spec-fixed', 'ghost', true],
    ['spec fix-submitted with missing stored findings re-arms spec-fixed without holding (arm succeeds)',
      { phase: 'spec', status: 'fixing', specReviewRound: 1 }, 'server.spec.fix.submitted', 'spec-fixed', 'dev-1', false, { phase: 'spec', round: 1 }],
  ];

  it.each(reArmCases)('%s', async (_name, task, type, kind, agent, holds, seed) => {
    const fx = await runScenario({ task, seed, emit: [type, kind] });
    const armed = ['t1', agent, kind];
    expect(fx.calls.setupPhaseSignal).toContainEqual(armed);
    if (holds) expect(fx.calls.holdAgentForUnarmedSignal).toContainEqual(armed);
    else expect(fx.calls.holdAgentForUnarmedSignal).toHaveLength(0);
    if (type.endsWith('.ready')) expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });

  it('code review dispatch with a legacy undefined agentId intervenes without arming an undefined watcher', async () => {
    const fx = makeFixture({ agentId: undefined as unknown as string });
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expect(fx.calls.setupPhaseSignal).toHaveLength(0);
    expect(fx.calls.holdAgentForUnarmedSignal).toHaveLength(0);
    expect(fx.emitted.some(
      e => e.type === 'human.intervention'
        && (e.data as { phase?: string }).phase === 'server-code-review-no-dev-agent',
    )).toBe(true);
  });
});

describe('aggregation id disambiguation', () => {
  it('a restated namespaced id and a colliding new id stay one-to-one', async () => {
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
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('b0-f-1');
    expect(ids).toContain('b0-r2-f-1');
  });
});

describe('publish robustness: unverified PR number and putRound failure re-arm the entry signal', () => {
  it('unverified PR number → intervention + code-ready re-arm, never recorded', async () => {
    const fx = makeFixture({ status: 'approved', afterDone: 'pr' }, { verifyPr: false });
    await fx.emit('server.code.published', { token: 'tok123', kind: 'code-ready', prNumber: 999 });
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'dev-1', 'code-ready']);
    expect(fx.calls.updateTask).not.toContainEqual(['t1', { prNumber: 999 }]);
    expect(fx.calls.transitionTaskStatus).not.toContainEqual(['t1', 'ready']);
  });

  it('putRound failure on code-done re-arms the entry signal', async () => {
    const fx = makeFixture();
    const failingStore = fx.store as unknown as { putRound: (...a: unknown[]) => Promise<void> };
    const original = failingStore.putRound.bind(fx.store);
    let failed = false;
    failingStore.putRound = async (...a: unknown[]) => {
      if (!failed) { failed = true; throw new Error('disk full'); }
      return original(...(a as Parameters<typeof original>));
    };
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'dev-1', 'code-done']);
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });
});

describe('verdict-save failure re-arm', () => {
  it('findings save failure re-arms code-reviewed; file is NOT deleted', async () => {
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
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'qa-1', 'code-reviewed']);
    expect(fx.transport.deleteFindings).not.toHaveBeenCalled();
    expect(fx.calls.dispatchServerFixToDev).toHaveLength(0);
  });

  it('response save failure re-arms code-fixed; file is NOT deleted', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponse.mockResolvedValue({
      round: 1, responses: [{ findingId: 'f-1', action: 'fix', rationale: 'ok' }],
    });
    const failing = fx.store as unknown as { putRound: (...a: unknown[]) => Promise<void> };
    failing.putRound = async () => { throw new Error('disk full'); };
    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'dev-1', 'code-fixed']);
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

describe('max_rounds releases agents and clears references', () => {
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

  it('code dispatch cap clears the lingering QA reference even when release is refused', async () => {
    const fx = makeFixture({ reviewRound: 3 }, { rounds: 3 });
    fx.releaseAgentForTask.mockResolvedValue(false);
    fx.getAgentState.mockResolvedValue({ id: 'qa-1', projectId: 'proj', updatedAt: 'now' });
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });
    expect(fx.calls.transitionTaskStatus).toContainEqual(['t1', 'max_rounds']);
    expect(clearedFields(fx)).toContain('qaAgentId');
    expect(clearedFields(fx)).not.toContain('agentId');
  });

  it('code verdict cap releases QA with allowAwaitingHuman and retains dev', async () => {
    const fx = makeFixture({ status: 'review', reviewRound: 3 }, { rounds: 3 });
    await putRound(fx.store, 'code', 3);
    fx.transport.readFindings.mockResolvedValue({ ...FINDINGS_RC, round: 3 });
    await fx.emit('server.code.review.submitted', { token: 'tok123', kind: 'code-reviewed' });
    expect(fx.calls.releaseAgentForTask).toContainEqual(['qa-1', 't1', 'idle', { allowAwaitingHuman: true }]);
    expect(clearedFields(fx)).toContain('qaAgentId');
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

  it('spec dispatch cap releases and clears BOTH dev and QA references', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'in_progress', specReviewRound: 3 }, { rounds: 3 });
    await fx.emit('server.spec.ready', { token: 'tok123', kind: 'spec-done' });
    expect(fx.calls.transitionTaskStatus).toContainEqual(['t1', 'max_rounds']);
    expect(fx.calls.releaseAgentForTask).toContainEqual(['qa-1', 't1', 'idle', {}]);
    expect(fx.calls.releaseAgentForTask).toContainEqual(['dev-1', 't1', 'idle', {}]);
    expect(clearedFields(fx)).toContain('qaAgentId');
    expect(clearedFields(fx)).toContain('agentId');
  });

  it('spec verdict cap on request-changes releases and clears BOTH dev and QA references', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'review', specReviewRound: 3 }, { rounds: 3 });
    await putRound(fx.store, 'spec', 3);
    fx.transport.readFindings.mockResolvedValue(SPEC_FINDINGS_RC);
    await fx.emit('server.spec.review.submitted', { token: 'tok123', kind: 'spec-reviewed' });
    expect(fx.calls.transitionTaskStatus).toContainEqual(['t1', 'max_rounds']);
    expect(clearedFields(fx)).toContain('qaAgentId');
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

describe('gate relaxation: github tasks through server spec chain', () => {
  it('server.spec.ready dispatches QA spec review for a github task', async () => {
    const f = makeFixture({ reviewMode: 'github', phase: undefined, status: 'in_progress', specReviewRound: 0 });
    await f.emit('server.spec.ready', { token: 'tok123' });
    expect(f.calls.dispatchServerReviewToQa).toHaveLength(1);
    expect((f.calls.dispatchServerReviewToQa[0][1] as { phase: string }).phase).toBe('spec');
  });

  it('server.spec.review.submitted routes approve verdict for a github task', async () => {
    const f = makeFixture({ reviewMode: 'github', phase: 'spec', status: 'review', specReviewRound: 1 });
    await putRound(f.store, 'spec', 1, { content: 'spec text' });
    f.transport.readFindings.mockResolvedValueOnce(APPROVE_R1);
    await f.emit('server.spec.review.submitted', { token: 'tok123' });
    expect(f.calls.transitionToCodePhase).toHaveLength(1);
  });

  it('server.spec.fix.submitted processes a github task response', async () => {
    const f = makeFixture({ reviewMode: 'github', phase: 'spec', status: 'fixing', specReviewRound: 1 });
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

  it('github task spec verdict at cap pauses to max_rounds and releases both agents', async () => {
    const f = makeFixture(
      { reviewMode: 'github', phase: 'spec', status: 'review', specReviewRound: 1 },
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

  it('server.code.ready still ignores github tasks', async () => {
    const f = makeFixture({ reviewMode: 'github', phase: 'code', status: 'in_progress' });
    await f.emit('server.code.ready', { token: 'tok123' });
    expect(f.calls.dispatchServerReviewToQa).toHaveLength(0);
  });

  it('server.code.review.submitted still ignores github tasks', async () => {
    const f = makeFixture({ reviewMode: 'github', phase: 'code', status: 'review', reviewRound: 1 });
    await f.emit('server.code.review.submitted', { token: 'tok123' });
    expect(f.calls.dispatchServerFixToDev).toHaveLength(0);
    expect(f.calls.transitionTaskStatus).toHaveLength(0);
  });

  it('spec gate still enforces token freshness for github tasks', async () => {
    const f = makeFixture({ reviewMode: 'github', phase: undefined, status: 'in_progress' });
    await f.emit('server.spec.ready', { token: 'WRONG' });
    expect(f.calls.dispatchServerReviewToQa).toHaveLength(0);
    expect(f.emitted.some(e => e.type === 'human.intervention')).toBe(true);
  });
});

function interventionPhases(fx: Fixture): string[] {
  return fx.emitted
    .filter(e => e.type === 'human.intervention')
    .map(e => String((e.data as { phase?: string }).phase ?? ''));
}

describe('registration guard', () => {
  it('no ReviewStore configured → warns once and registers no handlers', async () => {
    const bus = new EventBus({ append: async () => undefined } as unknown as EventLog);
    const getTask = vi.fn();
    const manager = { getReviewStore: () => undefined, getTask } as unknown as AgentManager;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      registerServerEventHandlers(bus, manager);
      expect(warnSpy).toHaveBeenCalledWith(
        '[ServerEventHandler] no ReviewStore configured; server review mode disabled',
      );
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
      await fx.emit('server.code.ready', { token: 'WRONG', kind: 'code-done' });
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

describe('prompt content truncation', () => {
  it('oversized single-batch diff is truncated at a utf8 boundary and flagged, stored round keeps the full diff', async () => {
    const fx = makeFixture();
    const hugeDiff = `diff --git a/a.ts b/a.ts\n+${'哈'.repeat(30000)}`;
    fx.transport.readContent.mockResolvedValue({ content: hugeDiff, baseSha: 'base123' });
    await fx.emit('server.code.ready', { token: 'tok123', kind: 'code-done' });

    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(1);
    const [, opts] = fx.calls.dispatchServerReviewToQa[0] as [string, { content: string; contentTruncated?: boolean }];
    expect(opts.contentTruncated).toBe(true);
    const bytes = Buffer.byteLength(opts.content, 'utf8');
    expect(bytes).toBeLessThanOrEqual(56 * 1024);
    expect(bytes).toBeGreaterThan(56 * 1024 - 4);
    expect(opts.content.at(-1)).toBe('哈');

    const round = await fx.store.getRound('t1', 'code', 1);
    expect(round?.content).toBe(hugeDiff);
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
});

describe('code fix response guards', () => {
  it('response file missing with no stored response → intervention + code-fixed re-arm', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponse.mockResolvedValue(null);
    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });
    expect(interventionPhases(fx)).toContain('server-code-response-missing');
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'dev-1', 'code-fixed']);
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });

  it('stale response round → deleted + re-arm, response never stored', async () => {
    const fx = makeFixture({ status: 'fixing', reviewRound: 1 });
    await putRound(fx.store, 'code', 1, { findings: FINDINGS_RC });
    fx.transport.readResponse.mockResolvedValue({
      round: 2,
      responses: [{ findingId: 'f-1', action: 'fix', rationale: 'late' }],
    });
    await fx.emit('server.code.fix.submitted', { token: 'tok123', kind: 'code-fixed' });
    expect(interventionPhases(fx)).toContain('server-code-response-round-mismatch');
    expect(fx.transport.deleteResponse).toHaveBeenCalled();
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'dev-1', 'code-fixed']);
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

  it('published head read failure → intervention + code-ready re-arm', async () => {
    const fx = makeFixture({ status: 'approved', reviewHeadAnchorSha: 'head123' });
    fx.transport.readHeadSha.mockRejectedValueOnce(new Error('git down'));
    await fx.emit('server.code.published', { token: 'tok123', kind: 'code-ready' });
    expect(interventionPhases(fx)).toContain('server-code-published-head-capture-failed');
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'dev-1', 'code-ready']);
    expect(fx.calls.transitionTaskStatus).not.toContainEqual(['t1', 'ready']);
  });

  it('latestHeadSha persist failure → intervention + code-ready re-arm, no ready transition', async () => {
    const fx = makeFixture({ status: 'approved', reviewHeadAnchorSha: 'head123' });
    fx.updateTask.mockRejectedValueOnce(new Error('disk full'));
    await fx.emit('server.code.published', { token: 'tok123', kind: 'code-ready' });
    expect(interventionPhases(fx)).toContain('server-code-published-head-capture-failed');
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'dev-1', 'code-ready']);
    expect(fx.calls.transitionTaskStatus).not.toContainEqual(['t1', 'ready']);
  });
});

describe('spec review failure paths', () => {
  it('spec content read failure → intervention + spec-done re-arm', async () => {
    const fx = makeFixture({ phase: undefined, status: 'in_progress' });
    fx.transport.readContent.mockRejectedValue(new Error('read fail'));
    await fx.emit('server.spec.ready', { token: 'tok123', kind: 'spec-done' });
    expect(interventionPhases(fx)).toContain('server-spec-content-read-failed');
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'dev-1', 'spec-done']);
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });

  it('spec round store failure → intervention + spec-done re-arm', async () => {
    const fx = makeFixture({ phase: undefined, status: 'in_progress' });
    fx.transport.readContent.mockResolvedValue({ content: '# Spec' });
    const failing = fx.store as unknown as { putRound: (...a: unknown[]) => Promise<void> };
    failing.putRound = async () => { throw new Error('disk full'); };
    await fx.emit('server.spec.ready', { token: 'tok123', kind: 'spec-done' });
    expect(interventionPhases(fx)).toContain('server-spec-round-store-failed');
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'dev-1', 'spec-done']);
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });

  it('spec findings read failure → intervention + spec-reviewed re-arm', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'review', specReviewRound: 1 });
    await putRound(fx.store, 'spec', 1);
    fx.transport.readFindings.mockRejectedValue(new Error('bad json'));
    await fx.emit('server.spec.review.submitted', { token: 'tok123', kind: 'spec-reviewed' });
    expect(interventionPhases(fx)).toContain('server-spec-findings-invalid');
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'qa-1', 'spec-reviewed']);
    expect(fx.calls.transitionToCodePhase).toHaveLength(0);
  });

  it('spec findings missing (never stored) → intervention + spec-reviewed re-arm', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'review', specReviewRound: 1 });
    await putRound(fx.store, 'spec', 1);
    fx.transport.readFindings.mockResolvedValue(null);
    await fx.emit('server.spec.review.submitted', { token: 'tok123', kind: 'spec-reviewed' });
    expect(interventionPhases(fx)).toContain('server-spec-findings-missing');
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'qa-1', 'spec-reviewed']);
  });

  it('stale spec findings round → deleted + re-arm, verdict never stored or routed', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'review', specReviewRound: 1 });
    await putRound(fx.store, 'spec', 1);
    fx.transport.readFindings.mockResolvedValue({ ...APPROVE_R1, round: 2 });
    await fx.emit('server.spec.review.submitted', { token: 'tok123', kind: 'spec-reviewed' });
    expect(interventionPhases(fx)).toContain('server-spec-findings-round-mismatch');
    expect(fx.transport.deleteFindings).toHaveBeenCalled();
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'qa-1', 'spec-reviewed']);
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
    const [, json] = fx.calls.dispatchServerFixToDev[0] as [string, string];
    expect(JSON.parse(json).findings[0].id).toBe('f-1');
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

  it('spec response read failure → intervention + spec-fixed re-arm', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'fixing', specReviewRound: 1 });
    await putRound(fx.store, 'spec', 1, SPEC_ROUND_FINDINGS);
    fx.transport.readResponse.mockRejectedValue(new Error('corrupt'));
    await fx.emit('server.spec.fix.submitted', { token: 'tok123', kind: 'spec-fixed' });
    expect(interventionPhases(fx)).toContain('server-spec-response-invalid');
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'dev-1', 'spec-fixed']);
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });

  it('spec response missing with none stored → intervention + spec-fixed re-arm', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'fixing', specReviewRound: 1 });
    await putRound(fx.store, 'spec', 1, SPEC_ROUND_FINDINGS);
    fx.transport.readResponse.mockResolvedValue(null);
    await fx.emit('server.spec.fix.submitted', { token: 'tok123', kind: 'spec-fixed' });
    expect(interventionPhases(fx)).toContain('server-spec-response-missing');
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'dev-1', 'spec-fixed']);
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });

  it('stale spec response round → deleted + re-arm, no re-dispatch', async () => {
    const fx = makeFixture({ phase: 'spec', status: 'fixing', specReviewRound: 1 });
    await putRound(fx.store, 'spec', 1, SPEC_ROUND_FINDINGS);
    fx.transport.readResponse.mockResolvedValue({
      round: 2,
      responses: [{ findingId: 'f-1', action: 'fix', rationale: 'late' }],
    });
    await fx.emit('server.spec.fix.submitted', { token: 'tok123', kind: 'spec-fixed' });
    expect(interventionPhases(fx)).toContain('server-spec-response-round-mismatch');
    expect(fx.transport.deleteResponse).toHaveBeenCalled();
    expect(fx.calls.setupPhaseSignal).toContainEqual(['t1', 'dev-1', 'spec-fixed']);
    const round = await fx.store.getRound('t1', 'spec', 1);
    expect(round?.response).toBeUndefined();
    expect(fx.calls.dispatchServerReviewToQa).toHaveLength(0);
  });
});
