import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentManager, DispatchTerminalError, EnsureSessionError } from '../../src/agent/manager.js';
import { AgentStore } from '../../src/state/agent-store.js';
import { TaskStore } from '../../src/state/task-store.js';
import { LockManager } from '../../src/state/lock.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { SkillRegistry } from '../../src/skill/registry.js';
import { initStateDir } from '../../src/state/init.js';
import { registerEventHandlers } from '../../src/event/handlers.js';
import type { BaxianConfig, BaxianEvent, TaskState, TaskStatus } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';

const BASE_CONFIG: BaxianConfig = {
  review: { rounds: 3 },
  server: DEFAULT_SERVER_CONFIG,
  project: [
    {
      id: 'proj',
      repo: 'user/repo',
      merge: 'auto',
      agent: [
        [
          { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '' },
          { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local', workdir: '' },
        ],
      ],
    },
  ],
};

let tempDir: string;
let agentStore: AgentStore;
let taskStore: TaskStore;
let lockManager: LockManager;
let eventBus: EventBus;
let manager: AgentManager;
let mockRunner: CommandRunner;
let emittedEvents: BaxianEvent[];
let CONFIG: BaxianConfig;
const HEAD_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEXT_HEAD_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-handlers-test-'));
  await initStateDir(tempDir);

  const skillsDir = join(tempDir, 'skills');
  for (const s of ['baxian-rules', 'task-check', 'pr-review', 'pr-feedback', 'pr-recheck']) {
    await mkdir(join(skillsDir, s), { recursive: true });
    await writeFile(join(skillsDir, s, 'SKILL.md'), `# ${s}`);
  }
  const skillRegistry = new SkillRegistry(skillsDir);
  await skillRegistry.scan();

  agentStore = new AgentStore(join(tempDir, 'state', 'agents'));
  taskStore = new TaskStore(join(tempDir, 'state', 'tasks'));
  lockManager = new LockManager(join(tempDir, 'locks'));
  const eventLog = new EventLog(join(tempDir, 'events'));
  eventBus = new EventBus(eventLog);

  emittedEvents = [];
  eventBus.on('*', (evt) => { emittedEvents.push(evt); });

  mockRunner = {
    exec: vi.fn<(cmd: string) => Promise<ExecResult>>().mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }),
    writeFile: vi.fn<(p: string, c: Buffer | string) => Promise<void>>().mockResolvedValue(undefined),
  };

  CONFIG = {
    ...BASE_CONFIG,
    project: BASE_CONFIG.project.map(p => ({
      ...p,
      agent: p.agent.map(pair => pair.map(a => ({ ...a, workdir: tempDir }))),
    })),
  };

  manager = new AgentManager({
    config: CONFIG,
    agentStore,
    taskStore,
    lockManager,
    eventBus,
    runnerFactory: () => mockRunner,
    platformRunner: mockRunner,
  });

  registerEventHandlers(eventBus, manager);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true });
});

async function seedTask(overrides: Partial<TaskState> & { id: string }): Promise<TaskState> {
  const now = new Date().toISOString();
  const task: TaskState = {
    id: overrides.id,
    projectId: 'proj',
    title: `Task ${overrides.id}`,
    description: 'seeded task',
    preferredAgentId: 'dev-1',
    agentId: 'dev-1',
    prNumber: 58,
    branch: `bx/${overrides.id}`,
    reviewRound: 0,
    status: 'in_progress',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  await taskStore.set(task);
  return task;
}

async function seedDevAgent(taskId: string, agentId = 'dev-1'): Promise<void> {
  await agentStore.set({
    id: agentId,
    projectId: 'proj',
    status: 'running',
    taskId,
    worktreePath: join(tempDir, 'worktrees', `${taskId}-dev`),
    updatedAt: new Date().toISOString(),
  });
  await mkdir(join(tempDir, 'worktrees', `${taskId}-dev`), { recursive: true });
}

async function emitAndWait(event: Omit<BaxianEvent, 'id'>): Promise<void> {
  await eventBus.emit({ id: '', ...event } as BaxianEvent);
}

type EventData = Record<string, unknown>;

function emitPrCreated(taskId: string, data: EventData): Promise<void> {
  return emitAndWait({
    type: 'pr.created', timestamp: new Date().toISOString(),
    projectId: 'proj', agentId: 'dev-1', taskId, data,
  });
}

function emitPrUpdated(taskId: string, data: EventData): Promise<void> {
  return emitAndWait({
    type: 'pr.updated', timestamp: new Date().toISOString(),
    projectId: 'proj', agentId: 'dev-1', taskId, data,
  });
}

function emitPrFixSubmitted(taskId: string, data: EventData): Promise<void> {
  return emitAndWait({
    type: 'pr.fix.submitted', timestamp: new Date().toISOString(),
    projectId: 'proj', agentId: 'dev-1', taskId, data,
  });
}

function emitPrMerged(taskId: string, data: EventData): Promise<void> {
  return emitAndWait({
    type: 'pr.merged', timestamp: new Date().toISOString(),
    projectId: 'proj', taskId, data,
  });
}

function emitReview(taskId: string, data: EventData, agentId = 'qa-1'): Promise<void> {
  return emitAndWait({
    type: 'review.submitted', timestamp: new Date().toISOString(),
    projectId: 'proj', agentId, taskId, data,
  });
}

type ManagerMethod = {
  [K in keyof AgentManager]: AgentManager[K] extends (...args: never[]) => Promise<unknown> ? K : never;
}[keyof AgentManager];

type StubSpec = Partial<Record<ManagerMethod, unknown>>;
type StubSpies = Record<string, ReturnType<typeof vi.spyOn>>;

// Spy each listed manager method and resolve it to the given value (undefined → resolves void).
function stubManager(spec: StubSpec, target: AgentManager = manager): StubSpies {
  const spies: StubSpies = {};
  for (const [method, value] of Object.entries(spec)) {
    const spy = vi.spyOn(target as never, method as never) as ReturnType<typeof vi.spyOn>;
    spy.mockResolvedValue(value as never);
    spies[method] = spy;
  }
  return spies;
}

type InterventionData = Record<string, unknown> & { phase?: string };

function findIntervention(taskId: string, phase?: string): BaxianEvent | undefined {
  return emittedEvents.find(e =>
    e.type === 'human.intervention'
    && e.taskId === taskId
    && (phase === undefined || (e.data as InterventionData).phase === phase),
  );
}

function findInterventionByPhase(phase: string): BaxianEvent | undefined {
  return emittedEvents.find(e =>
    e.type === 'human.intervention' && (e.data as InterventionData).phase === phase,
  );
}

// A QA review pass mid-flight: status=review, round 1, PR #214, head anchored at HEAD_SHA.
// The head/time/token gate tests share this exact shape and vary only by id + one extra field.
function seedReviewPass(id: string, extra: Partial<TaskState> = {}): Promise<TaskState> {
  return seedTask({
    id, status: 'review', reviewRound: 1, prNumber: 214,
    latestHeadSha: HEAD_SHA, reviewHeadAnchorSha: HEAD_SHA, qaAgentId: 'qa-1',
    ...extra,
  });
}

// The accept-path stub: QA released, dev acquired + resumed, merge stubbed, authoritative head = HEAD_SHA.
function stubApproveFlow(): StubSpies {
  return stubManager({
    releaseAgentForTask: true, acquireAgentForTask: true, continueSession: true,
    mergePr: undefined, fetchPrHeadSha: HEAD_SHA,
  });
}

// A self-contained manager + bus + handlers on its own EventLog dir, for tests that need a
// non-default config (no-QA pairing, manual merge) without disturbing the shared `manager`.
async function makeLocalHandlers(
  config: BaxianConfig,
  eventsDirName: string,
): Promise<{ manager: AgentManager; bus: EventBus; events: BaxianEvent[] }> {
  const eventsDir = join(tempDir, eventsDirName);
  await mkdir(eventsDir, { recursive: true });
  const bus = new EventBus(new EventLog(eventsDir));
  const localManager = new AgentManager({
    config, agentStore, taskStore, lockManager, eventBus: bus,
    runnerFactory: () => mockRunner, platformRunner: mockRunner,
  });
  registerEventHandlers(bus, localManager);
  const events: BaxianEvent[] = [];
  bus.on('*', evt => { events.push(evt); });
  return { manager: localManager, bus, events };
}

describe('pr.created handler', () => {
  it('transitions in_progress → review and starts QA review session', async () => {
    await seedTask({ id: 'task-001', status: 'in_progress', reviewRound: 0 });
    await seedDevAgent('task-001');
    const { startSession: startSpy, markAgentWaiting: markWaitSpy, updateTask: updateSpy } = stubManager({ startSession: true, markAgentWaiting: true, updateTask: undefined });

    await emitPrCreated('task-001', { prNumber: 58, prUrl: 'https://github.com/user/repo/pull/58' });

    const task = await taskStore.get('task-001');
    expect(task!.status).toBe('review');
    expect(task!.prNumber).toBe(58);
    expect(task!.prUrl).toBe('https://github.com/user/repo/pull/58');
    expect(startSpy).toHaveBeenCalledWith('task-001', 'qa-1', 'review');
    expect(markWaitSpy).toHaveBeenCalledWith('dev-1', 'task-001');
    expect(updateSpy).toHaveBeenCalledWith('task-001', { qaAgentId: 'qa-1' });
  });

  it('verdict watcher fails to arm → atomically rolls back to in_progress (status+token+anchor), releases QA + intervention', async () => {
    await seedTask({ id: 'task-noarm', status: 'in_progress', reviewRound: 0, signalToken: 'dev-token', reviewHeadAnchorSha: undefined });
    await seedDevAgent('task-noarm');
    const { startSession: startSpy, releaseAgentForTask: releaseSpy } = stubManager({ startSession: true, rotateAndSetupPhaseSignal: { token: 'tok', armed: false }, releaseAgentForTask: true });

    await emitPrCreated('task-noarm', { prNumber: 58, prUrl: 'https://github.com/user/repo/pull/58' });

    expect(startSpy).not.toHaveBeenCalled();
    expect(releaseSpy).toHaveBeenCalledWith('qa-1', 'task-noarm', 'idle');
    const task = await taskStore.get('task-noarm');
    // Full rollback: status restored to in_progress, the rotated token reverted to the dev token,
    // qaAgentId cleared — not left stranded in 'review' with no QA.
    expect(task!.status).toBe('in_progress');
    expect(task!.signalToken).toBe('dev-token');
    expect(task!.qaAgentId).toBeUndefined();
    expect(findInterventionByPhase('qa-review-arm-failed')).toBeDefined();
  });

  it('pane-signal pr.created (no event.data.headSha) verifies prNumber via gh + pins latestHeadSha + reviewHeadAnchorSha', async () => {
    // pane-signal pr.created carries prNumber but no headSha; agent-emitted
    // prNumber must be verified to belong to task.branch (Codex P1 #3323644756)
    // and the resolved headSha is then pinned as both latestHeadSha and the
    // immutable reviewHeadAnchorSha for the upcoming QA review.
    await seedTask({ id: 'task-pane-create', status: 'in_progress', reviewRound: 0 });
    await seedDevAgent('task-pane-create');
    stubManager({ startSession: true, markAgentWaiting: true, updateTask: undefined });
    const verifySpy = vi.spyOn(manager, 'verifyPaneSignalPrNumber')
      .mockResolvedValue({ headRefName: 'bx/task-pane-create', headSha: HEAD_SHA });

    await emitPrCreated('task-pane-create', {
      kind: 'pr-created',
      prNumber: 199,
      source: 'pane-signal',
      // intentionally no headSha — pane signal does not carry it
    });

    expect(verifySpy).toHaveBeenCalledWith('task-pane-create', 199);
    const task = await taskStore.get('task-pane-create');
    expect(task!.latestHeadSha).toBe(HEAD_SHA);
    expect(task!.reviewHeadAnchorSha).toBe(HEAD_SHA);
  });

  it('pane-signal pr.created REJECTS when verify returns undefined (no transition, intervention emitted)', async () => {
    await seedTask({ id: 'task-pane-bad', status: 'in_progress', reviewRound: 0 });
    const { startSession: startSpy } = stubManager({ startSession: true, verifyPaneSignalPrNumber: undefined, setupPhaseSignal: true });

    await emitPrCreated('task-pane-bad', { prNumber: 9999, source: 'pane-signal' });

    const task = await taskStore.get('task-pane-bad');
    expect(task!.status).toBe('in_progress');
    expect(task!.prNumber).toBe(58);
    expect(startSpy).not.toHaveBeenCalled();
    const intervention = findIntervention('task-pane-bad');
    expect(intervention!.data.phase).toBe('pane-pr-created-branch-mismatch');
    expect(intervention!.data.claimedPrNumber).toBe(9999);
  });

  it('pane-signal pr.created reconciles task.branch atomically via transition patch', async () => {
    await seedTask({ id: 'task-pane-recon', status: 'in_progress', reviewRound: 0 });
    await seedDevAgent('task-pane-recon');
    stubManager({ startSession: true, markAgentWaiting: true, verifyPaneSignalPrNumber: undefined });
    vi.spyOn(manager, 'fetchPrHeadRef')
      .mockResolvedValue({ headRefName: 'fix/custom-branch', headSha: HEAD_SHA, body: '<!-- baxian:managed -->\nsome description' });
    vi.spyOn(manager, 'findTaskByBranch').mockResolvedValue(undefined);

    await emitPrCreated('task-pane-recon', { prNumber: 200, source: 'pane-signal' });

    const task = await taskStore.get('task-pane-recon');
    expect(task!.status).toBe('review');
    expect(task!.branch).toBe('fix/custom-branch');
    expect(task!.latestHeadSha).toBe(HEAD_SHA);
  });

  it('pane-signal pr.created REJECTS when PR branch is bound to another task', async () => {
    await seedTask({ id: 'task-pane-bound', status: 'in_progress', reviewRound: 0 });
    stubManager({ startSession: true, verifyPaneSignalPrNumber: undefined });
    vi.spyOn(manager, 'fetchPrHeadRef')
      .mockResolvedValue({ headRefName: 'bx/task-other', headSha: HEAD_SHA, body: '<!-- baxian:managed -->' });
    vi.spyOn(manager, 'findTaskByBranch')
      .mockResolvedValue({ id: 'task-other', branch: 'bx/task-other' } as TaskState);
    vi.spyOn(manager, 'setupPhaseSignal').mockResolvedValue(true);

    await emitPrCreated('task-pane-bound', { prNumber: 9999, source: 'pane-signal' });

    const task = await taskStore.get('task-pane-bound');
    expect(task!.status).toBe('in_progress');
    const intervention = findIntervention('task-pane-bound');
    expect(intervention!.data.phase).toBe('pane-pr-created-branch-mismatch');
  });

  it.each([
    ['foreign bx/ prefix', 'task-pane-bx', { headRefName: 'bx/task-other', headSha: HEAD_SHA, body: '<!-- baxian:managed -->' }],
    ['PR body lacks managed marker', 'task-pane-nomark', { headRefName: 'fix/unmanaged', headSha: HEAD_SHA, body: 'just a plain PR' }],
  ])('pane-signal pr.created REJECTS when %s', async (_label, id, headRef) => {
    await seedTask({ id, status: 'in_progress', reviewRound: 0 });
    vi.spyOn(manager, 'verifyPaneSignalPrNumber').mockResolvedValue(undefined);
    vi.spyOn(manager, 'fetchPrHeadRef').mockResolvedValue(headRef);
    stubManager({ findTaskByBranch: undefined, setupPhaseSignal: true });

    await emitPrCreated(id, { prNumber: 9999, source: 'pane-signal' });

    const task = await taskStore.get(id);
    expect(task!.status).toBe('in_progress');
    expect(task!.branch).toBe(`bx/${id}`);
  });

  it('pane-signal pr.created reject re-sets up develop watcher so a corrected emit can be consumed', async () => {
    // The watcher fires + deletes its entry on the rejected signal; without
    // re-arm, dev's corrected `[bx:pr-created:<right-num>:token]` would be
    // unconsumed until a server restart.
    await seedTask({ id: 'task-pane-rearm', status: 'in_progress', reviewRound: 0 });
    const { setupPhaseSignal: armSpy } = stubManager({ verifyPaneSignalPrNumber: undefined, setupPhaseSignal: true });

    await emitPrCreated('task-pane-rearm', { prNumber: 9999, source: 'pane-signal' });

    expect(armSpy).toHaveBeenCalledWith(
      'task-pane-rearm', 'dev-1', ['spec-done', 'pr-created'], { skipSnapshot: true },
    );
  });

  it('pane-signal pr.created re-sets up with [pr-created] only when task.phase=code', async () => {
    await seedTask({ id: 'task-pane-rearm-code', status: 'in_progress', phase: 'code', reviewRound: 0 });
    const { setupPhaseSignal: armSpy } = stubManager({ verifyPaneSignalPrNumber: undefined, setupPhaseSignal: true });

    await emitPrCreated('task-pane-rearm-code', { prNumber: 9999, source: 'pane-signal' });

    expect(armSpy).toHaveBeenCalledWith('task-pane-rearm-code', 'dev-1', ['pr-created'], { skipSnapshot: true });
  });

  it('pane-signal pr.created re-sets up WITHOUT skipSnapshot on verify error so snapshot retry can land', async () => {
    await seedTask({ id: 'task-pane-rearm-err', status: 'in_progress', reviewRound: 0 });
    vi.spyOn(manager, 'verifyPaneSignalPrNumber').mockRejectedValue(new Error('gh transient'));
    const armSpy = vi.spyOn(manager, 'setupPhaseSignal').mockResolvedValue(true);

    await emitPrCreated('task-pane-rearm-err', { prNumber: 100, source: 'pane-signal' });

    expect(armSpy).toHaveBeenCalledWith(
      'task-pane-rearm-err', 'dev-1', ['spec-done', 'pr-created'], { skipSnapshot: false },
    );
    const intervention = findIntervention('task-pane-rearm-err');
    expect(intervention).toBeDefined();
    expect(intervention!.data.phase).toBe('pane-pr-created-verify-error');
  });

  it('pane-signal pr.created reArms watcher when transition fails with task still active', async () => {
    await seedTask({ id: 'task-pane-txfail', status: 'in_progress', reviewRound: 0 });
    vi.spyOn(manager, 'verifyPaneSignalPrNumber').mockResolvedValue(undefined);
    vi.spyOn(manager, 'fetchPrHeadRef')
      .mockResolvedValue({ headRefName: 'fix/conflict-branch', headSha: HEAD_SHA, body: '<!-- baxian:managed -->' });
    const { setupPhaseSignal: armSpy } = stubManager({ findTaskByBranch: undefined, transitionTaskStatus: null, setupPhaseSignal: true });

    await emitPrCreated('task-pane-txfail', { prNumber: 200, source: 'pane-signal' });

    expect(armSpy).toHaveBeenCalledWith(
      'task-pane-txfail', 'dev-1', ['spec-done', 'pr-created'], { skipSnapshot: true },
    );
    const task = await taskStore.get('task-pane-txfail');
    expect(task!.status).toBe('in_progress');
    const intervention = findIntervention('task-pane-txfail');
    expect(intervention).toBeDefined();
    expect(intervention!.data.phase).toBe('pane-pr-created-transition-failed');
  });

  it('writes task.latestHeadSha from pr.created event headSha', async () => {
    await seedTask({ id: 'task-seed-head', status: 'in_progress', reviewRound: 0 });
    await seedDevAgent('task-seed-head');
    stubManager({ startSession: true, markAgentWaiting: true, updateTask: undefined });

    await emitPrCreated('task-seed-head', { prNumber: 70, headSha: HEAD_SHA });

    const task = await taskStore.get('task-seed-head');
    expect(task!.latestHeadSha).toBe(HEAD_SHA);
  });

  it('pins task.reviewDispatchedAt when dispatching the QA review pass (freshness anchor)', async () => {
    await seedTask({ id: 'task-dispatched-at', status: 'in_progress', reviewRound: 0 });
    await seedDevAgent('task-dispatched-at');
    stubManager({ startSession: true, markAgentWaiting: true });

    const before = Date.now();
    await emitPrCreated('task-dispatched-at', { prNumber: 70, headSha: HEAD_SHA });

    const task = await taskStore.get('task-dispatched-at');
    expect(task!.reviewDispatchedAt).toBeTruthy();
    expect(Date.parse(task!.reviewDispatchedAt!)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('pr.created rotates signalToken in the transition so a failed QA dispatch invalidates the old pass token', async () => {
    await seedTask({ id: 'task-cr-tokrot', status: 'fixing', reviewRound: 1, prNumber: 70, signalToken: 'old-pass-token-1' });
    await seedDevAgent('task-cr-tokrot');
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(false); // QA dispatch fails here

    await emitPrCreated('task-cr-tokrot', { prNumber: 70, headSha: HEAD_SHA });

    const task = await taskStore.get('task-cr-tokrot');
    expect(task!.signalToken).toBeTruthy();
    expect(task!.signalToken).not.toBe('old-pass-token-1'); // rotated despite the failed acquire
    const intervention = findIntervention('task-cr-tokrot', 'qa-acquire-failed');
    expect(intervention).toBeTruthy();
  });

  it('transitions fixing → review (re-push of fix branch keeps PR)', async () => {
    await seedTask({ id: 'task-001b', status: 'fixing', reviewRound: 1 });
    await seedDevAgent('task-001b');
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await emitPrCreated('task-001b', { prNumber: 60 });

    const task = await taskStore.get('task-001b');
    expect(task!.status).toBe('review');
    expect(startSpy).toHaveBeenCalledWith('task-001b', 'qa-1', 'review');
  });

  it('cancelled task → no-op (terminal guard)', async () => {
    await seedTask({ id: 'task-cancel', status: 'cancelled', reviewRound: 0 });
    const { startSession: startSpy, markAgentWaiting: markWaitSpy, updateTask: updateSpy } = stubManager({ startSession: true, markAgentWaiting: true, updateTask: undefined });

    await emitPrCreated('task-cancel', { prNumber: 1 });

    const task = await taskStore.get('task-cancel');
    expect(task!.status).toBe('cancelled');
    expect(startSpy).not.toHaveBeenCalled();
    expect(markWaitSpy).not.toHaveBeenCalled();
    // rotateAndSetupPhaseSignal updates signalToken before dispatch — that's the
    // one allowed side effect. No other field changes.
    const nonSignalUpdates = updateSpy.mock.calls.filter(([_id, patch]) =>
      !patch || Object.keys(patch).some(k => k !== 'signalToken'),
    );
    expect(nonSignalUpdates).toHaveLength(0);
  });

  it('review-state task → no-op (invalid from-state guard)', async () => {
    await seedTask({ id: 'task-rv', status: 'review', reviewRound: 1, prNumber: 99 });
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await emitPrCreated('task-rv', { prNumber: 99 });

    expect(startSpy).not.toHaveBeenCalled();
  });

  it('no QA partner → markAgentWaiting only (skip startSession + qaAgentId persist)', async () => {
    const noQaConfig: BaxianConfig = {
      ...CONFIG,
      project: [{
        ...CONFIG.project[0],
        agent: [[CONFIG.project[0].agent[0][0]]], // dev only
      }],
    };
    const { manager: lonelyManager, bus: localBus } = await makeLocalHandlers(noQaConfig, 'events-lonely');

    await seedTask({ id: 'task-noqa', status: 'in_progress', reviewRound: 0 });
    const startSpy = vi.spyOn(lonelyManager, 'startSession').mockResolvedValue(true);
    const markWaitSpy = vi.spyOn(lonelyManager, 'markAgentWaiting').mockResolvedValue(true);
    const updateSpy = vi.spyOn(lonelyManager, 'updateTask').mockResolvedValue();

    await localBus.emit({
      id: '',
      type: 'pr.created',
      timestamp: new Date().toISOString(),
      projectId: 'proj',
      agentId: 'dev-1',
      taskId: 'task-noqa',
      data: { prNumber: 7 },
    });

    expect(startSpy).not.toHaveBeenCalled();
    expect(markWaitSpy).toHaveBeenCalledWith('dev-1', 'task-noqa');
    // No QA partner → no qaAgentId persist.
    const qaPersists = updateSpy.mock.calls.filter(([_id, patch]) =>
      patch != null && Object.prototype.hasOwnProperty.call(patch, 'qaAgentId'),
    );
    expect(qaPersists).toHaveLength(0);
    const task = await taskStore.get('task-noqa');
    expect(task!.status).toBe('review');
    // No QA pass actually started (no partner) → round NOT consumed; stays 0 so a later
    // dispatchReviewToQa counts the real first review as Round 1.
    expect(task!.reviewRound).toBe(0);
  });

  it('startSession resolve(false) from in_progress → stay in review + emit human.intervention (qaAgentId pre-arm rolled back)', async () => {
    await seedTask({ id: 'task-rb1', status: 'in_progress', reviewRound: 0 });
    const { markAgentWaiting: markWaitSpy, updateTask: updateSpy } = stubManager({ startSession: false, markAgentWaiting: true, updateTask: undefined });

    await emitPrCreated('task-rb1', { prNumber: 22 });

    const task = await taskStore.get('task-rb1');
    expect(task!.status).toBe('review');
    expect(task!.prNumber).toBe(22);
    expect(markWaitSpy).not.toHaveBeenCalled();
    // qaAgentId is persisted BEFORE arming the verdict watcher so a fast pane
    // verdict can find the QA via task.qaAgentId; on startSession failure it's
    // rolled back to undefined. Net effect: pre-arm set then rollback unset.
    const qaWrites = updateSpy.mock.calls.filter(([_id, patch]) =>
      patch && 'qaAgentId' in patch,
    );
    expect(qaWrites).toEqual([
      ['task-rb1', { qaAgentId: 'qa-1' }],
      ['task-rb1', { qaAgentId: undefined }],
    ]);
    const intervention = findIntervention('task-rb1');
    expect(intervention).toBeTruthy();
    expect(intervention!.data.phase).toBe('qa-review-start-failed');
  });

  it('startSession throws EnsureSessionError(handled=true) → caller SKIPS releaseAgentForTask (dialog pane stays locked)', async () => {
    // handled=true tells the caller to skip release; otherwise terminal boundTask would unlock the stuck dialog pane.
    await seedTask({ id: 'task-dialog-handled', status: 'in_progress', reviewRound: 0 });
    const dialogErr = new EnsureSessionError(
      { createdSession: true, agentId: 'qa-1', dialogPending: true, handled: true },
      'runtime dialog (already handled)',
    );
    vi.spyOn(manager, 'startSession').mockRejectedValue(dialogErr);
    const { releaseAgentForTask: releaseSpy } = stubManager({ releaseAgentForTask: true, markAgentWaiting: true });

    await emitPrCreated('task-dialog-handled', { prNumber: 81 });

    expect(releaseSpy).not.toHaveBeenCalled();
    const startFailedIntervention = findInterventionByPhase('qa-review-start-failed');
    expect(startFailedIntervention).toBeUndefined();
  });

  it('startSession returns false → QA acquire is rolled back via releaseAgentForTask("idle")', async () => {
    await seedTask({ id: 'task-rb-rollback', status: 'in_progress', reviewRound: 0 });
    const { releaseAgentForTask: releaseSpy } = stubManager({ startSession: false, releaseAgentForTask: true, markAgentWaiting: true });

    await emitPrCreated('task-rb-rollback', { prNumber: 80 });

    expect(releaseSpy).toHaveBeenCalledWith('qa-1', 'task-rb-rollback', 'idle');
    const intervention = findIntervention('task-rb-rollback');
    expect(intervention!.data.phase).toBe('qa-review-start-failed');
  });

  it('startSession hard error from fixing → stay in review + emit human.intervention (qaAgentId pre-arm rolled back)', async () => {
    await seedTask({ id: 'task-rb2', status: 'fixing', reviewRound: 1, prNumber: 30 });
    vi.spyOn(manager, 'startSession').mockRejectedValue(new Error('boom'));
    const { markAgentWaiting: markWaitSpy, updateTask: updateSpy } = stubManager({ markAgentWaiting: true, updateTask: undefined });

    await emitPrCreated('task-rb2', { prNumber: 30 });

    const task = await taskStore.get('task-rb2');
    expect(task!.status).toBe('review');
    expect(markWaitSpy).not.toHaveBeenCalled();
    const qaWrites = updateSpy.mock.calls.filter(([_id, patch]) =>
      patch && 'qaAgentId' in patch,
    );
    expect(qaWrites).toEqual([
      ['task-rb2', { qaAgentId: 'qa-1' }],
      ['task-rb2', { qaAgentId: undefined }],
    ]);
    const intervention = findIntervention('task-rb2');
    expect(intervention).toBeTruthy();
    expect(intervention!.data.phase).toBe('qa-review-start-failed');
  });

  it('task already cancelled mid-flight: stays cancelled (no resurrection by intervention emit)', async () => {
    await seedTask({ id: 'task-rb3', status: 'in_progress', reviewRound: 0 });
    vi.spyOn(manager, 'startSession').mockImplementation(async () => {
      const t = await taskStore.get('task-rb3');
      if (t) await taskStore.set({ ...t, status: 'cancelled' });
      return false;
    });

    await emitPrCreated('task-rb3', { prNumber: 31 });

    const task = await taskStore.get('task-rb3');
    expect(task!.status).toBe('cancelled');
  });

  it('dev-wait-gate-failed-no-qa: no paired QA + markAgentWaiting returns false → emit intervention', async () => {
    const noQaConfig: BaxianConfig = {
      ...BASE_CONFIG,
      project: [{
        ...BASE_CONFIG.project[0],
        agent: [[{ id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local' }]],
      }],
    };
    const { manager: lonelyManager, bus: localBus, events: localEvents } = await makeLocalHandlers(
      noQaConfig, `events-lonely-${Date.now()}`,
    );

    await seedTask({ id: 'task-no-qa-fail', status: 'in_progress', reviewRound: 0 });
    vi.spyOn(lonelyManager, 'markAgentWaiting').mockResolvedValue(false);

    await localBus.emit({
      id: '',
      type: 'pr.created',
      timestamp: new Date().toISOString(),
      projectId: 'proj',
      agentId: 'dev-1',
      taskId: 'task-no-qa-fail',
      data: { prNumber: 50 },
    });

    const intervention = localEvents.find(
      e => e.type === 'human.intervention' && e.taskId === 'task-no-qa-fail',
    );
    expect(intervention).toBeTruthy();
    expect(intervention!.data.phase).toBe('dev-wait-gate-failed-no-qa');
  });

  it('dev-wait-gate-failed-after-qa-started: paired QA started + markAgentWaiting false → markAwaitingHuman on QA (do NOT release; review prompt may still be running)', async () => {
    await seedTask({ id: 'task-mk-fail', status: 'in_progress', reviewRound: 0 });
    const { releaseAgentForTask: releaseSpy, markAwaitingHuman: awaitingSpy } = stubManager({ startSession: true, updateTask: undefined, markAgentWaiting: false, releaseAgentForTask: true, markAwaitingHuman: undefined });

    await emitPrCreated('task-mk-fail', { prNumber: 51 });

    // 关键差异：不再裸 release QA pane（review prompt 可能仍在跑），改为 markAwaitingHuman
    expect(releaseSpy).not.toHaveBeenCalledWith('qa-1', 'task-mk-fail', 'idle');
    expect(awaitingSpy).toHaveBeenCalledWith(
      'qa-1',
      'dev-wait-gate-failed-after-qa-started',
      expect.stringContaining('QA review'),
      expect.objectContaining({ expectedTaskId: expect.any(String) }),
    );
  });

  it('order: updateTask(qaAgentId) BEFORE startSession, markAgentWaiting after startSession resolves true', async () => {
    // qaAgentId must be persisted before startSession so the poller verdict's
    // review.submitted release path can read task.qaAgentId. Without this, a
    // verdict that lands right after dispatch finds qaAgentId=undefined, the
    // release is skipped, and the QA stays locked on a task past review.
    await seedTask({ id: 'task-order', status: 'in_progress', reviewRound: 0 });
    const calls: string[] = [];
    vi.spyOn(manager, 'startSession').mockImplementation(async () => {
      calls.push('startSession');
      return true;
    });
    vi.spyOn(manager, 'markAgentWaiting').mockImplementation(async () => {
      calls.push('markAgentWaiting');
      return true;
    });
    vi.spyOn(manager, 'updateTask').mockImplementation(async (_id, patch) => {
      if (patch && 'qaAgentId' in patch) calls.push('updateTask(qaAgentId)');
    });

    await emitPrCreated('task-order', { prNumber: 1 });

    expect(calls).toEqual(['updateTask(qaAgentId)', 'startSession', 'markAgentWaiting']);
  });

  it('spec phase: pr.created early-exits — no transition, no QA dispatch', async () => {
    await seedTask({ id: 'task-spec-pr-created', status: 'review', phase: 'spec', reviewRound: 0, specReviewRound: 1, signalToken: 'spec-tok-a' });
    const transitionSpy = vi.spyOn(manager, 'transitionTaskStatus');
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await emitPrCreated('task-spec-pr-created', { prNumber: 99 });

    expect(transitionSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });
});

describe('reviewRound 1-based bump (first review pass → Round 1)', () => {
  // Only the FIRST review pass (from in_progress, round 0) bumps to round 1; a re-push from
  // fixing (round 2) is a recheck and keeps the round.
  it.each([
    ['in_progress' as TaskStatus, 0, 'task-rr-created', 58, 1],
    ['fixing' as TaskStatus, 2, 'task-rr-created-fixing', 60, 2],
  ])('pr.created from %s (reviewRound %i) → status review, reviewRound %i', async (status, roundIn, id, prNumber, roundOut) => {
    await seedTask({ id, status, reviewRound: roundIn, prNumber });
    await seedDevAgent(id);
    stubManager({ startSession: true, markAgentWaiting: true });

    await emitPrCreated(id, { prNumber });

    const task = await taskStore.get(id);
    expect(task!.status).toBe('review');
    expect(task!.reviewRound).toBe(roundOut);
  });

  it.each([
    ['in_progress' as TaskStatus, 0, 'task-rr-push', 50, 1],
    ['fixing' as TaskStatus, 2, 'task-rr-push-fixing', 62, 2],
  ])('pr.updated push from %s (reviewRound %i) → status review, reviewRound %i', async (status, roundIn, id, prNumber, roundOut) => {
    await seedTask({ id, status, reviewRound: roundIn, prNumber });
    stubManager({ startSession: true, markAgentWaiting: true });

    await emitPrUpdated(id, { prNumber, kind: 'push' });

    const task = await taskStore.get(id);
    expect(task!.status).toBe('review');
    expect(task!.reviewRound).toBe(roundOut);
  });

  it('review.submitted catch-up from in_progress (reviewRound 0) + APPROVE → reviewRound 1, status approved', async () => {
    await seedTask({ id: 'task-rr-catchup-approve', status: 'in_progress', reviewRound: 0, prNumber: undefined });
    await seedDevAgent('task-rr-catchup-approve');
    stubManager({ markAgentWaiting: true, releaseAgentForTask: true, acquireAgentForTask: true, continueSession: true, mergePr: undefined });

    await emitReview('task-rr-catchup-approve', { action: 'APPROVE', prNumber: 99, headSha: HEAD_SHA });

    const task = await taskStore.get('task-rr-catchup-approve');
    expect(task!.status).toBe('approved');
    expect(task!.reviewRound).toBe(1);
  });

  it('review.submitted catch-up from in_progress (reviewRound 0) + REQUEST_CHANGES → reviewRound 2, status fixing (catch-up bump feeds REQUEST_CHANGES pre-increment)', async () => {
    await seedTask({ id: 'task-rr-catchup-rc', status: 'in_progress', reviewRound: 0, prNumber: 50 });
    await seedDevAgent('task-rr-catchup-rc');
    stubManager({ markAgentWaiting: true, releaseAgentForTask: true, acquireAgentForTask: true, continueSession: true });

    await emitReview('task-rr-catchup-rc', { action: 'REQUEST_CHANGES', prNumber: 50 });

    const task = await taskStore.get('task-rr-catchup-rc');
    expect(task!.status).toBe('fixing');
    expect(task!.reviewRound).toBe(2);
  });

  it('REQUEST_CHANGES pr-fixed watcher fails to arm → does NOT dispatch fix; holds dev awaiting_human (recoverable), not silent waiting', async () => {
    await seedTask({ id: 'task-prfix-noarm', status: 'review', reviewRound: 1, prNumber: 50, qaAgentId: 'qa-1' });
    await seedDevAgent('task-prfix-noarm');
    const { continueSession: continueSpy, markAgentWaiting: markWaitSpy } = stubManager({ acquireAgentForTask: true, releaseAgentForTask: true, rotateAndSetupPhaseSignal: { token: 'tok', armed: false }, continueSession: true, markAgentWaiting: true });
    const holdSpy = vi.spyOn(manager, 'markAwaitingHuman');

    await emitReview('task-prfix-noarm', { action: 'REQUEST_CHANGES', prNumber: 50 });

    expect(continueSpy).not.toHaveBeenCalled();
    // Explicit recoverable hold (resumeAgent refuses signal-arm-failed) instead of a silent
    // 'waiting' state that mislabels the dev as working with no fix prompt running.
    expect(markWaitSpy).not.toHaveBeenCalled();
    expect(holdSpy).toHaveBeenCalledWith(
      'dev-1',
      'signal-arm-failed:pr-fixed',
      expect.any(String),
      expect.objectContaining({ expectedTaskId: 'task-prfix-noarm' }),
    );
  });

  // 1-based cap with rounds=2: round 2 + REQUEST_CHANGES overflows (3 > 2) → max_rounds;
  // round 1 is still allowed to advance to fixing round 2.
  it.each([
    ['2 + REQUEST_CHANGES → max_rounds (3 > 2)', 'task-rr-cap-over', 2, 32, 'max_rounds' as TaskStatus, undefined],
    ['1 + REQUEST_CHANGES → fixing reviewRound 2 (allowed)', 'task-rr-cap-allow', 1, 33, 'fixing' as TaskStatus, 2],
  ])('cap (1-based meaning): rounds=2, review reviewRound %s', async (_label, id, roundIn, prNumber, expectStatus, expectRound) => {
    await seedTask({ id, status: 'review', reviewRound: roundIn, prNumber, qaAgentId: 'qa-1' });
    stubManager({ releaseAgentForTask: true, continueSession: true });
    manager.replaceConfig({ ...CONFIG, review: { rounds: 2 } });

    await emitReview(id, { action: 'REQUEST_CHANGES', prNumber });

    const task = await taskStore.get(id);
    expect(task!.status).toBe(expectStatus);
    if (expectRound !== undefined) expect(task!.reviewRound).toBe(expectRound);
  });

  it('pr.updated push after approval (approved → review re-review) bumps reviewRound (new QA pass)', async () => {
    await seedTask({ id: 'task-rr-approved-push', status: 'approved', reviewRound: 1, prNumber: 73, qaAgentId: 'qa-1' });
    stubManager({ startSession: true, releaseAgentForTask: true, markAgentWaiting: true, acquireAgentForTask: true });

    await emitPrUpdated('task-rr-approved-push', { prNumber: 73, kind: 'push' });

    const task = await taskStore.get('task-rr-approved-push');
    expect(task!.status).toBe('review');
    expect(task!.reviewRound).toBe(2);
  });

  it('pr.updated first review (in_progress) + startSession fails → reviewRound restored to 0 (rollback)', async () => {
    await seedTask({ id: 'task-rr-rollback', status: 'in_progress', reviewRound: 0, prNumber: 75 });
    stubManager({ releaseAgentForTask: true, markAgentWaiting: true, acquireAgentForTask: true, startSession: false });

    await emitPrUpdated('task-rr-rollback', { prNumber: 75, kind: 'push' });

    const task = await taskStore.get('task-rr-rollback');
    expect(task!.status).toBe('in_progress');
    expect(task!.reviewRound).toBe(0);
  });

  it('review.submitted catch-up (in_progress) + STALE APPROVE → reviewRound NOT consumed (stays 0)', async () => {
    await seedTask({ id: 'task-rr-stale', status: 'in_progress', reviewRound: 0, prNumber: 80, latestHeadSha: NEXT_HEAD_SHA });
    await seedDevAgent('task-rr-stale');
    vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);
    vi.spyOn(manager, 'fetchPrHeadSha').mockRejectedValue(new Error('gh offline'));

    await emitReview('task-rr-stale', { action: 'APPROVE', prNumber: 80, headSha: HEAD_SHA, currentHeadSha: NEXT_HEAD_SHA });

    const task = await taskStore.get('task-rr-stale');
    expect(task!.reviewRound).toBe(0);
  });

  it('stale catch-up THEN a valid verdict still counts Round 1 (no lost first review)', async () => {
    // Regression: a stale verdict catches the task up to review (round still 0) and is
    // rejected. The NEXT valid verdict no longer re-enters catch-up, yet must still
    // count the first review — reviewRound 0 in the APPROVE branch ⇒ Round 1.
    await seedTask({ id: 'task-rr-stale-then-valid', status: 'in_progress', reviewRound: 0, prNumber: 81, latestHeadSha: NEXT_HEAD_SHA });
    await seedDevAgent('task-rr-stale-then-valid');
    stubManager({ markAgentWaiting: true, releaseAgentForTask: true, acquireAgentForTask: true, continueSession: true, mergePr: undefined });
    vi.spyOn(manager, 'fetchPrHeadSha').mockRejectedValue(new Error('gh offline'));

    // 1) stale APPROVE (reviewed an old head; authoritative head = NEXT_HEAD_SHA) → rejected.
    await emitReview('task-rr-stale-then-valid', { action: 'APPROVE', prNumber: 81, headSha: HEAD_SHA, currentHeadSha: NEXT_HEAD_SHA });
    const afterStale = await taskStore.get('task-rr-stale-then-valid');
    expect(afterStale!.status).toBe('review');
    expect(afterStale!.reviewRound).toBe(0);

    // 2) valid APPROVE on the current head → approved, first review finally counted as Round 1.
    await emitReview('task-rr-stale-then-valid', { action: 'APPROVE', prNumber: 81, headSha: NEXT_HEAD_SHA, currentHeadSha: NEXT_HEAD_SHA });
    const afterValid = await taskStore.get('task-rr-stale-then-valid');
    expect(afterValid!.status).toBe('approved');
    expect(afterValid!.reviewRound).toBe(1);
  });

  it('pr.created: same-identity verdict races in during startSession → no double count (count-once token no-ops)', async () => {
    // Codex P1: a same-identity QA can emit its verdict between startSession and the
    // post-success count. Simulate that by having the verdict's effect land during
    // startSession (task → approved, first review already counted 0→1). The count-once
    // token (expectedRound=0) sees reviewRound moved to 1 and no-ops → stays 1 (not 2).
    await seedTask({ id: 'task-rr-race', status: 'in_progress', reviewRound: 0 });
    await seedDevAgent('task-rr-race');
    vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);
    vi.spyOn(manager, 'startSession').mockImplementation(async () => {
      const t = await taskStore.get('task-rr-race');
      await taskStore.set({ ...t!, status: 'approved', reviewRound: 1 });
      return true;
    });

    await emitPrCreated('task-rr-race', { prNumber: 90 });

    const task = await taskStore.get('task-rr-race');
    expect(task!.reviewRound).toBe(1);
  });

  it('pr.updated approved re-review: same-identity verdict races in (does NOT catch-count) → pass still counted once (round 2)', async () => {
    // Codex P2 #3330096838: on an approved→review re-review reviewRound is already ≥1, so
    // the verdict's APPROVE handler does NOT catch-count (that only fires at reviewRound 0).
    // Simulate the verdict winning the race by moving the task back to approved WITHOUT
    // counting (reviewRound stays 1). The count-once token (expectedRound=1) must still
    // count this genuinely-started pass → round 2 (the old status==='review' guard wrongly
    // no-opped here, leaving round 1).
    await seedTask({ id: 'task-rr-appr-race', status: 'approved', reviewRound: 1, prNumber: 91, qaAgentId: 'qa-1' });
    await seedDevAgent('task-rr-appr-race');
    stubManager({ releaseAgentForTask: true, markAgentWaiting: true, acquireAgentForTask: true });
    vi.spyOn(manager, 'startSession').mockImplementation(async () => {
      const t = await taskStore.get('task-rr-appr-race');
      await taskStore.set({ ...t!, status: 'approved', reviewRound: 1 });
      return true;
    });

    await emitPrUpdated('task-rr-appr-race', { prNumber: 91, kind: 'push' });

    const task = await taskStore.get('task-rr-appr-race');
    expect(task!.reviewRound).toBe(2);
  });
});

describe('pr.updated handler', () => {
  it('catch-up: in_progress → review with phase=review', async () => {
    await seedTask({ id: 'task-up1', status: 'in_progress', reviewRound: 0, prNumber: 50 });
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await emitPrUpdated('task-up1', { prNumber: 50 });

    const task = await taskStore.get('task-up1');
    expect(task!.status).toBe('review');
    expect(startSpy).toHaveBeenCalledWith('task-up1', 'qa-1', 'review');
  });

  it('spec phase: pr.updated push early-exits — no transition, no recheck dispatch', async () => {
    await seedTask({ id: 'task-spec-pr-push', status: 'review', phase: 'spec', reviewRound: 0, specReviewRound: 1, signalToken: 'spec-tok-b', prNumber: 70 });
    const transitionSpy = vi.spyOn(manager, 'transitionTaskStatus');
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await emitPrUpdated('task-spec-pr-push', { prNumber: 70, kind: 'push', headSha: HEAD_SHA });

    expect(transitionSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
    const task = await taskStore.get('task-spec-pr-push');
    expect(task!.phase).toBe('spec');
    expect(task!.status).toBe('review');
  });

  it('spec phase: pr.updated comment/review-comment also early-exits', async () => {
    await seedTask({ id: 'task-spec-pr-comment', status: 'review', phase: 'spec', reviewRound: 0, specReviewRound: 1, signalToken: 'spec-tok-c', prNumber: 71 });
    const transitionSpy = vi.spyOn(manager, 'transitionTaskStatus');

    await emitPrUpdated('task-spec-pr-comment', { prNumber: 71, kind: 'review-comment' });

    expect(transitionSpy).not.toHaveBeenCalled();
  });

  it('comment-only kind=comment: fixing 不被推到 review，dev 不被中断', async () => {
    await seedTask({ id: 'task-up-c', status: 'fixing', reviewRound: 1, prNumber: 60 });
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);
    const transitionSpy = vi.spyOn(manager, 'transitionTaskStatus');

    await emitPrUpdated('task-up-c', { prNumber: 60, prUrl: 'https://github.com/u/r/pull/60', kind: 'comment' });

    expect(startSpy).not.toHaveBeenCalled();
    expect(transitionSpy).not.toHaveBeenCalled();
    const task = await taskStore.get('task-up-c');
    expect(task!.status).toBe('fixing');
    expect(task!.prUrl).toBe('https://github.com/u/r/pull/60');
  });

  it('review-comment kind: 同样不触发 fixing→review', async () => {
    await seedTask({ id: 'task-up-rc', status: 'fixing', reviewRound: 1, prNumber: 61, prUrl: 'https://x/61' });
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await emitPrUpdated('task-up-rc', { prNumber: 61, kind: 'review-comment' });

    expect(startSpy).not.toHaveBeenCalled();
    const task = await taskStore.get('task-up-rc');
    expect(task!.status).toBe('fixing');
  });

  it('comment-only kind=comment after approval preserves the approved head and re-dispatches dev check', async () => {
    await seedTask({ id: 'task-up-approved-comment', status: 'approved', reviewRound: 1, prNumber: 63 });
    await manager.setPostApproveCompletion('task-up-approved-comment', { token: 'old-post-token', approvedHeadSha: HEAD_SHA });
    const { releaseAgentForTask: releaseSpy, continueSession: continueSpy } = stubManager({ releaseAgentForTask: true, acquireAgentForTask: true, continueSession: true });

    await emitPrUpdated('task-up-approved-comment', {
      prNumber: 63,
      kind: 'comment',
      headSha: NEXT_HEAD_SHA,
    });

    const task = await taskStore.get('task-up-approved-comment');
    expect(task!.status).toBe('approved');
    const completion = await manager.getPostApproveCompletion('task-up-approved-comment');
    expect(completion?.token).not.toBe('old-post-token');
    expect(completion?.approvedHeadSha).toBe(HEAD_SHA);
    expect(releaseSpy).toHaveBeenCalledWith(
      'dev-1',
      'task-up-approved-comment',
      'waiting',
    );
    expect(continueSpy).toHaveBeenCalledWith(
      'task-up-approved-comment',
      'dev-1',
      'post-approve',
      { signalToken: completion?.token, postApproveRedispatchCount: 1 },
    );
  });

  it('approved-window review-comment during RUNNING post-approve coalesces into pendingRedispatch (no interrupt, no dispatch, no count bump, token preserved)', async () => {
    await seedTask({ id: 'task-up-running-skip', status: 'approved', reviewRound: 1, prNumber: 99 });
    await seedDevAgent('task-up-running-skip', 'dev-1');
    await manager.setPostApproveCompletion('task-up-running-skip', { token: 'active-token-skip', approvedHeadSha: HEAD_SHA, redispatchCount: 3 });
    const { releaseAgentForTask: releaseSpy, acquireAgentForTask: acquireSpy, continueSession: continueSpy } = stubManager({ releaseAgentForTask: true, acquireAgentForTask: true, continueSession: true });
    const clearSpy = vi.spyOn(manager, 'clearPostApproveCompletion');

    await emitPrUpdated('task-up-running-skip', { prNumber: 99, kind: 'review-comment', reviewCommentReply: true });

    expect(releaseSpy).not.toHaveBeenCalled();
    expect(acquireSpy).not.toHaveBeenCalled();
    expect(continueSpy).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
    const completion = await manager.getPostApproveCompletion('task-up-running-skip');
    expect(completion?.token).toBe('active-token-skip');
    expect(completion?.redispatchCount).toBe(3);
    expect(completion?.pendingRedispatch).toBe(true);
  });

  it('pr-merge-ready with pendingRedispatch=true triggers redispatch instead of mergePr', async () => {
    await seedTask({ id: 'task-up-pending-redispatch', status: 'approved', reviewRound: 1, prNumber: 101 });
    await seedDevAgent('task-up-pending-redispatch', 'dev-1');
    await manager.setPostApproveCompletion('task-up-pending-redispatch', { token: 'token-with-pending', approvedHeadSha: HEAD_SHA, redispatchCount: 2, pendingRedispatch: true });
    const { markAgentWaiting: markWaitSpy, continueSession: continueSpy, mergePr: mergeSpy } = stubManager({ releaseAgentForTask: true, acquireAgentForTask: true, markAgentWaiting: true, continueSession: true, mergePr: undefined });

    await emitPrUpdated('task-up-pending-redispatch', {
      prNumber: 101,
      kind: 'pr-merge-ready',
      verdictAgentId: 'dev-1',
      token: 'token-with-pending',
      source: 'pane-signal',
    });

    expect(markWaitSpy).toHaveBeenCalledWith('dev-1', 'task-up-pending-redispatch');
    expect(mergeSpy).not.toHaveBeenCalled();
    expect(continueSpy).toHaveBeenCalledOnce();
    expect(continueSpy).toHaveBeenCalledWith(
      'task-up-pending-redispatch',
      'dev-1',
      'post-approve',
      expect.objectContaining({ postApproveRedispatchCount: 3 }),
    );
    const completion = await manager.getPostApproveCompletion('task-up-pending-redispatch');
    expect(completion?.token).not.toBe('token-with-pending');
    expect(completion?.redispatchCount).toBe(3);
    expect(completion?.pendingRedispatch).toBeUndefined();
  });

  it('pr-merge-ready with pendingRedispatch=true AT cap escalates to intervention (no merge, no dispatch)', async () => {
    await seedTask({ id: 'task-up-pending-cap', status: 'approved', reviewRound: 1, prNumber: 102 });
    await manager.setPostApproveCompletion('task-up-pending-cap', { token: 'token-pending-cap', approvedHeadSha: HEAD_SHA, redispatchCount: 10, pendingRedispatch: true });
    const { continueSession: continueSpy, mergePr: mergeSpy } = stubManager({ markAgentWaiting: true, continueSession: true, mergePr: undefined });

    await emitPrUpdated('task-up-pending-cap', {
      prNumber: 102,
      kind: 'pr-merge-ready',
      verdictAgentId: 'dev-1',
      token: 'token-pending-cap',
      source: 'pane-signal',
    });

    expect(mergeSpy).not.toHaveBeenCalled();
    expect(continueSpy).not.toHaveBeenCalled();
    const intervention = findIntervention('task-up-pending-cap');
    expect(intervention?.data.phase).toBe('post-approve-redispatch-cap-exceeded');
    await expect(
      manager.getPostApproveCompletion('task-up-pending-cap'),
    ).resolves.toBeNull();
  });

  it('approved-window review-comment redispatches when Dev has no active task binding', async () => {
    await seedTask({ id: 'task-up-waiting-redispatch', status: 'approved', reviewRound: 1, prNumber: 100 });
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      worktreePath: join(tempDir, 'worktrees', 'task-up-waiting-redispatch'),
      updatedAt: new Date().toISOString(),
    });
    await mkdir(join(tempDir, 'worktrees', 'task-up-waiting-redispatch'), { recursive: true });
    await manager.setPostApproveCompletion('task-up-waiting-redispatch', { token: 'active-token-waiting', approvedHeadSha: HEAD_SHA });
    const { continueSession: continueSpy } = stubManager({ releaseAgentForTask: true, acquireAgentForTask: true, continueSession: true });

    await emitPrUpdated('task-up-waiting-redispatch', { prNumber: 100, kind: 'review-comment' });

    expect(continueSpy).toHaveBeenCalledOnce();
    const completion = await manager.getPostApproveCompletion('task-up-waiting-redispatch');
    expect(completion?.token).not.toBe('active-token-waiting');
    expect(completion?.redispatchCount).toBe(1);
  });

  it('human review-comment replies after approval invalidate token and re-dispatch dev check', async () => {
    await seedTask({ id: 'task-up-approved-human-reply', status: 'approved', reviewRound: 1, prNumber: 65 });
    await manager.setPostApproveCompletion('task-up-approved-human-reply', { token: 'active-post-token', approvedHeadSha: HEAD_SHA });
    const { continueSession: continueSpy } = stubManager({ releaseAgentForTask: true, acquireAgentForTask: true, continueSession: true });

    await emitPrUpdated('task-up-approved-human-reply', {
      prNumber: 65,
      kind: 'review-comment',
      reviewCommentReply: true,
    });

    const completion = await manager.getPostApproveCompletion('task-up-approved-human-reply');
    expect(completion?.token).not.toBe('active-post-token');
    expect(completion?.approvedHeadSha).toBe(HEAD_SHA);
    expect(completion?.redispatchCount).toBe(1);
    expect(continueSpy).toHaveBeenCalledWith(
      'task-up-approved-human-reply',
      'dev-1',
      'post-approve',
      { signalToken: completion?.token, postApproveRedispatchCount: 1 },
    );
  });

  it('redispatch cap: 11th approved review-comment escalates AND clears completion token', async () => {
    await seedTask({ id: 'task-up-redispatch-cap', status: 'approved', reviewRound: 1, prNumber: 88 });
    await manager.setPostApproveCompletion('task-up-redispatch-cap', { token: 'pre-cap-token', approvedHeadSha: HEAD_SHA, redispatchCount: 10 });
    const { releaseAgentForTask: releaseSpy, continueSession: continueSpy } = stubManager({ releaseAgentForTask: true, continueSession: true });

    await emitPrUpdated('task-up-redispatch-cap', { prNumber: 88, kind: 'review-comment' });

    expect(continueSpy).not.toHaveBeenCalled();
    expect(releaseSpy).not.toHaveBeenCalled();
    const intervention = findIntervention('task-up-redispatch-cap');
    expect(intervention).toBeTruthy();
    expect(intervention!.data.phase).toBe('post-approve-redispatch-cap-exceeded');
    expect(intervention!.data.redispatchCount).toBe(10);
    expect(intervention!.data.cap).toBe(10);
    await expect(
      manager.getPostApproveCompletion('task-up-redispatch-cap'),
    ).resolves.toBeNull();
  });

  it('redispatch cap: signal arriving after cap-exceeded does NOT trigger mergePr', async () => {
    await seedTask({ id: 'task-up-cap-late-marker', status: 'approved', reviewRound: 1, prNumber: 89 });
    await manager.setPostApproveCompletion('task-up-cap-late-marker', { token: 'live-token-pre-cap', approvedHeadSha: HEAD_SHA, redispatchCount: 10 });
    const { markAgentWaiting: markWaitSpy, mergePr: mergeSpy } = stubManager({ releaseAgentForTask: true, markAgentWaiting: true, mergePr: undefined });

    await emitPrUpdated('task-up-cap-late-marker', { prNumber: 89, kind: 'review-comment' });
    await expect(
      manager.getPostApproveCompletion('task-up-cap-late-marker'),
    ).resolves.toBeNull();

    await emitPrUpdated('task-up-cap-late-marker', {
      prNumber: 89,
      kind: 'pr-merge-ready',
      verdictAgentId: 'dev-1',
      token: 'live-token-pre-cap',
      source: 'pane-signal',
    });

    expect(markWaitSpy).not.toHaveBeenCalled();
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  it('new feedback after approval keeps the old token if dev cannot be interrupted for redispatch', async () => {
    await seedTask({ id: 'task-up-approved-redispatch-fail', status: 'approved', reviewRound: 1, prNumber: 66 });
    await manager.setPostApproveCompletion('task-up-approved-redispatch-fail', { token: 'active-post-token', approvedHeadSha: HEAD_SHA });
    const { acquireAgentForTask: acquireSpy, continueSession: continueSpy } = stubManager({ releaseAgentForTask: false, acquireAgentForTask: true, continueSession: true });

    await emitPrUpdated('task-up-approved-redispatch-fail', {
      prNumber: 66,
      kind: 'comment',
    });

    await expect(manager.getPostApproveCompletion('task-up-approved-redispatch-fail')).resolves.toEqual(
      expect.objectContaining({
        token: 'active-post-token',
        approvedHeadSha: HEAD_SHA,
      }),
    );
    expect(acquireSpy).not.toHaveBeenCalled();
    expect(continueSpy).not.toHaveBeenCalled();
    const intervention = findIntervention('task-up-approved-redispatch-fail');
    expect(intervention).toBeTruthy();
    expect(intervention!.data.phase).toBe('post-approve-dev-wait-gate-failed-before-redispatch');
  });

  it('push kind: 正常触发 fixing→review recheck', async () => {
    await seedTask({ id: 'task-up-p', status: 'fixing', reviewRound: 1, prNumber: 62 });
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await emitPrUpdated('task-up-p', { prNumber: 62, kind: 'push' });

    expect(startSpy).toHaveBeenCalledWith('task-up-p', 'qa-1', 'recheck');
    const task = await taskStore.get('task-up-p');
    expect(task!.status).toBe('review');
  });

  it('push kind with headSha persists task.latestHeadSha for later staleness checks', async () => {
    await seedTask({
      id: 'task-up-head-update',
      status: 'review',
      reviewRound: 1,
      prNumber: 71,
      qaAgentId: 'qa-1',
      latestHeadSha: HEAD_SHA, // older
    });
    stubManager({ releaseAgentForTask: true, startSession: true });

    await emitPrUpdated('task-up-head-update', { prNumber: 71, kind: 'push', headSha: NEXT_HEAD_SHA });

    const task = await taskStore.get('task-up-head-update');
    expect(task!.latestHeadSha).toBe(NEXT_HEAD_SHA);
  });

  it('default kind (no kind field) with headSha does NOT overwrite latestHeadSha — regression guard', async () => {
    await seedTask({ id: 'task-up-legacy', status: 'in_progress', reviewRound: 0, prNumber: 90, latestHeadSha: HEAD_SHA });

    await emitPrUpdated('task-up-legacy', { prNumber: 90, headSha: NEXT_HEAD_SHA });

    const task = await taskStore.get('task-up-legacy');
    expect(task!.latestHeadSha).toBe(HEAD_SHA);
  });

  it('push kind in review (dev pushed during QA review): stop old QA + start recheck (neutral prompt, no false premise)', async () => {
    // A mid-review push re-dispatches as 'recheck'. The recheck prompt is phrased
    // neutrally ("re-check the new commits and any prior feedback"), so it does NOT
    // make the false "dev addressed your prior changes-requested" claim even when no
    // verdict was issued yet — and a push during an actual recheck keeps recheck framing.
    await seedTask({ id: 'task-up-rr', status: 'review', reviewRound: 0, prNumber: 70, qaAgentId: 'qa-1' });
    const { releaseAgentForTask: stopSpy, startSession: startSpy } = stubManager({ releaseAgentForTask: true, startSession: true });

    await emitPrUpdated('task-up-rr', { prNumber: 70, kind: 'push' });

    expect(stopSpy).toHaveBeenCalledWith('qa-1', 'task-up-rr', 'idle');
    expect(startSpy).toHaveBeenCalledWith('task-up-rr', 'qa-1', 'recheck');
    expect(stopSpy.mock.invocationCallOrder[0]).toBeLessThan(
      startSpy.mock.invocationCallOrder[0],
    );

    const task = await taskStore.get('task-up-rr');
    expect(task!.status).toBe('review');
  });

  it('qa-release-failed-cannot-recheck: review→review push + QA release returns false → short-circuit, no startSession', async () => {
    await seedTask({ id: 'task-up-rr-rel-fail', status: 'review', reviewRound: 0, prNumber: 72, qaAgentId: 'qa-1' });
    const { startSession: startSpy } = stubManager({ releaseAgentForTask: false, startSession: true });

    await emitPrUpdated('task-up-rr-rel-fail', { prNumber: 72, kind: 'push' });

    expect(startSpy).not.toHaveBeenCalled();
    const intervention = findIntervention('task-up-rr-rel-fail');
    expect(intervention).toBeTruthy();
    expect(intervention!.data.phase).toBe('qa-release-failed-cannot-recheck');
    expect(intervention!.data.qaAgentId).toBe('qa-1');
  });

  it('push redispatch rotates signalToken in the transition so a failed redispatch invalidates the old pass token', async () => {
    // If acquire/startSession of the new QA fails, the token must already have rotated
    // (atomic with the anchors) — otherwise an old QA pass could submit a verdict whose
    // stamp still equals the un-rotated task.signalToken and slip past the token gate.
    await seedTask({ id: 'task-up-tokrot', status: 'review', reviewRound: 1, prNumber: 70, signalToken: 'old-pass-token-1', qaAgentId: 'qa-1' });
    vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(false); // redispatch fails here

    await emitPrUpdated('task-up-tokrot', { prNumber: 70, kind: 'push' });

    const task = await taskStore.get('task-up-tokrot');
    expect(task!.signalToken).toBeTruthy();
    expect(task!.signalToken).not.toBe('old-pass-token-1'); // rotated despite the failed acquire
    const intervention = findIntervention('task-up-tokrot', 'qa-acquire-failed');
    expect(intervention).toBeTruthy();
  });

  it('push kind in review with QA start failure: no rollback + emit human.intervention', async () => {
    await seedTask({ id: 'task-up-rr-fail', status: 'review', reviewRound: 0, prNumber: 71, qaAgentId: 'qa-1' });
    stubManager({ releaseAgentForTask: true, startSession: false });
    const transitionSpy = vi.spyOn(manager, 'transitionTaskStatus');

    await emitPrUpdated('task-up-rr-fail', { prNumber: 71, kind: 'push' });

    const rollbackCalls = transitionSpy.mock.calls.filter(
      args => args[1] === 'review' && Array.isArray((args[2] as { fromStatus?: unknown }).fromStatus)
        && (args[2] as { fromStatus: string[] }).fromStatus.length === 1
        && (args[2] as { fromStatus: string[] }).fromStatus[0] === 'review',
    );
    expect(rollbackCalls).toHaveLength(0);

    const task = await taskStore.get('task-up-rr-fail');
    expect(task!.status).toBe('review');

    const intervention = findIntervention('task-up-rr-fail');
    expect(intervention).toBeTruthy();
    expect(intervention!.data.phase).toBe('qa-recheck-failed-after-stop');
  });

  it('push kind after QA approval transitions approved → review and starts QA recheck', async () => {
    await seedTask({ id: 'task-up-approved', status: 'approved', reviewRound: 1, prNumber: 73, qaAgentId: 'qa-1' });
    const { startSession: startSpy, releaseAgentForTask: releaseSpy, markAgentWaiting: markWaitSpy } = stubManager({ startSession: true, releaseAgentForTask: true, markAgentWaiting: true });

    await emitPrUpdated('task-up-approved', { prNumber: 73, kind: 'push' });

    const task = await taskStore.get('task-up-approved');
    expect(task!.status).toBe('review');
    expect(releaseSpy).toHaveBeenCalledWith(
      'dev-1',
      'task-up-approved',
      'waiting',
    );
    expect(startSpy).toHaveBeenCalledWith('task-up-approved', 'qa-1', 'recheck');
    expect(releaseSpy.mock.invocationCallOrder[0]).toBeLessThan(
      startSpy.mock.invocationCallOrder[0],
    );
    expect(markWaitSpy).not.toHaveBeenCalled();
  });

  it('fixing → review recheck: QA started + markAgentWaiting false → markAwaitingHuman on QA (do NOT release)', async () => {
    // 用 fixing 作为 previousStatus 走 markAgentWaiting 分支（approved 走 early release，
    // 不经过 line 553 的 markAgentWaiting）。
    await seedTask({ id: 'task-up-mk-fail', status: 'fixing', reviewRound: 1, prNumber: 75, qaAgentId: 'qa-1' });
    const { releaseAgentForTask: releaseSpy, markAwaitingHuman: awaitingSpy } = stubManager({ startSession: true, updateTask: undefined, markAgentWaiting: false, releaseAgentForTask: true, markAwaitingHuman: undefined });

    await emitPrUpdated('task-up-mk-fail', { prNumber: 75, kind: 'push' });

    // 不再裸 release QA pane（recheck prompt 可能仍在跑），改为 markAwaitingHuman
    expect(releaseSpy).not.toHaveBeenCalledWith('qa-1', 'task-up-mk-fail', 'idle');
    expect(awaitingSpy).toHaveBeenCalledWith(
      'qa-1',
      'dev-wait-gate-failed-after-qa-started',
      expect.stringContaining('QA review'),
      expect.objectContaining({ expectedTaskId: expect.any(String) }),
    );
  });

  it('push kind after QA approval with QA start failure stays in review and emits intervention', async () => {
    await seedTask({ id: 'task-up-approved-fail', status: 'approved', reviewRound: 1, prNumber: 74, qaAgentId: 'qa-1' });
    stubManager({ startSession: false, releaseAgentForTask: true });

    await emitPrUpdated('task-up-approved-fail', { prNumber: 74, kind: 'push' });

    const task = await taskStore.get('task-up-approved-fail');
    expect(task!.status).toBe('review');
    const intervention = findIntervention('task-up-approved-fail');
    expect(intervention).toBeTruthy();
    expect(intervention!.data.phase).toBe('qa-recheck-failed-after-approved-push');
  });

  it('approved-push recheck verdict arm fails → stays in review (NOT rolled back to approved), releases QA + intervention', async () => {
    // Rolling back to approved would re-mark the task approved while the new push is unreviewed and
    // the post-approve completion was already cleared by the transition. Stay in review instead.
    await seedTask({ id: 'task-up-approved-noarm', status: 'approved', reviewRound: 1, prNumber: 74, qaAgentId: 'qa-1' });
    const { startSession: startSpy } = stubManager({ acquireAgentForTask: true, releaseAgentForTask: true, rotateAndSetupPhaseSignal: { token: 'rotated', armed: false }, startSession: true });

    await emitPrUpdated('task-up-approved-noarm', { prNumber: 74, kind: 'push' });

    expect(startSpy).not.toHaveBeenCalled();
    const task = await taskStore.get('task-up-approved-noarm');
    expect(task!.status).toBe('review');
    expect(task!.qaAgentId).toBeUndefined();
    expect(findInterventionByPhase('qa-recheck-arm-failed-after-approved-push')).toBeDefined();
  });

  // A post-approve complete signal (poller-sourced or pane-signal) reaches the same merge-ready
  // gate: transition to merge-ready, clear the completion, mark dev waiting, never auto-merge.
  it.each([
    ['poller signal', 'task-up-post-approved', 75, 'post-token-75', {}],
    ['pane signal source', 'task-up-post-pane', 76, 'post-token-76', { source: 'pane-signal' }],
  ])('post-approve complete via %s → merge-ready awaiting human confirm (no auto-merge)', async (_label, id, prNumber, token, extra) => {
    await seedTask({ id, status: 'approved', reviewRound: 1, prNumber, qaAgentId: 'qa-1' });
    await manager.setPostApproveCompletion(id, { token, approvedHeadSha: HEAD_SHA });
    const { markAgentWaiting: markWaitSpy, mergePr: mergeSpy } = stubManager({ markAgentWaiting: true, mergePr: undefined });

    await emitPrUpdated(id, { prNumber, kind: 'pr-merge-ready', verdictAgentId: 'dev-1', token, ...extra });

    const task = await taskStore.get(id);
    expect(task!.status).toBe('merge-ready');
    await expect(manager.getPostApproveCompletion(id)).resolves.toBeNull();
    expect(markWaitSpy).toHaveBeenCalledWith('dev-1', id);
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  it('human confirm from merge-ready executes the merge (merge:auto moved to confirm)', async () => {
    await seedTask({ id: 'task-up-post-merge-fail', status: 'approved', reviewRound: 1, prNumber: 80, qaAgentId: 'qa-1' });
    await manager.setPostApproveCompletion('task-up-post-merge-fail', { token: 'post-token-80', approvedHeadSha: HEAD_SHA });
    const { mergePr: mergeSpy } = stubManager({ markAgentWaiting: true, mergePr: undefined });

    await emitPrUpdated('task-up-post-merge-fail', {
      prNumber: 80,
      kind: 'pr-merge-ready',
      verdictAgentId: 'dev-1',
      token: 'post-token-80',
    });
    expect((await taskStore.get('task-up-post-merge-fail'))!.status).toBe('merge-ready');
    expect(mergeSpy).not.toHaveBeenCalled();

    // project.merge defaults to 'auto' in this fixture's config — confirm executes it.
    await manager.markTaskComplete('task-up-post-merge-fail');
    expect(mergeSpy).toHaveBeenCalledWith('task-up-post-merge-fail', { matchHeadSha: HEAD_SHA });
  });

  it('manual-merge post-approve completion → merge-ready (completion cleared, later comment is a no-op)', async () => {
    CONFIG.project[0]!.merge = null;
    manager.replaceConfig(CONFIG);
    await seedTask({ id: 'task-up-post-manual-complete', status: 'approved', reviewRound: 1, prNumber: 81, qaAgentId: 'qa-1' });
    await manager.setPostApproveCompletion('task-up-post-manual-complete', { token: 'post-token-81', approvedHeadSha: HEAD_SHA });
    const { mergePr: mergeSpy, continueSession: continueSpy } = stubManager({ markAgentWaiting: true, mergePr: undefined, continueSession: true });

    await emitPrUpdated('task-up-post-manual-complete', {
      prNumber: 81,
      kind: 'pr-merge-ready',
      verdictAgentId: 'dev-1',
      token: 'post-token-81',
    });

    const readied = await taskStore.get('task-up-post-manual-complete');
    expect(readied!.status).toBe('merge-ready');
    expect(mergeSpy).not.toHaveBeenCalled();
    await expect(
      manager.getPostApproveCompletion('task-up-post-manual-complete'),
    ).resolves.toBeNull();

    // Once merge-ready, baxian hands off to the human: a later plain comment does not
    // re-run the post-approve check (REQUEST_CHANGES / push are the formal re-open paths).
    await emitPrUpdated('task-up-post-manual-complete', { prNumber: 81, kind: 'comment' });

    const afterComment = await taskStore.get('task-up-post-manual-complete');
    expect(afterComment!.status).toBe('merge-ready');
    expect(continueSpy).not.toHaveBeenCalled();
  });

  it('push kind on a merge-ready task re-opens to review and starts QA recheck', async () => {
    await seedTask({ id: 'task-up-mr-push', status: 'merge-ready', reviewRound: 1, prNumber: 82, qaAgentId: 'qa-1' });
    const { startSession: startSpy, releaseAgentForTask: releaseSpy } = stubManager({ startSession: true, releaseAgentForTask: true, markAgentWaiting: true });

    await emitPrUpdated('task-up-mr-push', { prNumber: 82, kind: 'push' });

    const task = await taskStore.get('task-up-mr-push');
    expect(task!.status).toBe('review');
    expect(releaseSpy).toHaveBeenCalledWith('dev-1', 'task-up-mr-push', 'waiting');
    expect(startSpy).toHaveBeenCalledWith('task-up-mr-push', 'qa-1', 'recheck');
  });

  it('post-approve complete signal with dev wait-gate failure does not auto-merge', async () => {
    await seedTask({ id: 'task-up-post-wait-fail', status: 'approved', reviewRound: 1, prNumber: 76 });
    await manager.setPostApproveCompletion('task-up-post-wait-fail', { token: 'post-token-76', approvedHeadSha: HEAD_SHA });
    const { mergePr: mergeSpy } = stubManager({ markAgentWaiting: false, mergePr: undefined });

    await emitPrUpdated('task-up-post-wait-fail', {
      prNumber: 76,
      kind: 'pr-merge-ready',
      verdictAgentId: 'dev-1',
      token: 'post-token-76',
    });

    expect(mergeSpy).not.toHaveBeenCalled();
    const intervention = findIntervention('task-up-post-wait-fail');
    expect(intervention).toBeTruthy();
    expect(intervention!.data.phase).toBe('post-approve-dev-wait-gate-failed');
  });

  it.each([
    ['from a different agent', 'task-up-post-wrong-agent', 'post-token-77', 77, { verdictAgentId: 'other-agent', token: 'post-token-77' }],
    ['with the wrong token', 'task-up-post-wrong-token', 'post-token-78', 78, { verdictAgentId: 'dev-1', token: 'different-token' }],
  ])('post-approve complete signal %s is ignored', async (_label, id, storedToken, prNumber, signal) => {
    await seedTask({ id, status: 'approved', reviewRound: 1, prNumber });
    await manager.setPostApproveCompletion(id, { token: storedToken, approvedHeadSha: HEAD_SHA });
    const { markAgentWaiting: markWaitSpy, mergePr: mergeSpy } = stubManager({ markAgentWaiting: true, mergePr: undefined });

    await emitPrUpdated(id, { prNumber, kind: 'pr-merge-ready', ...signal });

    expect(markWaitSpy).not.toHaveBeenCalled();
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  it('post-approve complete signal rechecks approved state after the dev wait gate before merge', async () => {
    await seedTask({ id: 'task-up-post-stale-before-merge', status: 'approved', reviewRound: 1, prNumber: 79 });
    await manager.setPostApproveCompletion('task-up-post-stale-before-merge', { token: 'post-token-79', approvedHeadSha: HEAD_SHA });
    vi.spyOn(manager, 'markAgentWaiting').mockImplementation(async () => {
      await manager.updateTaskStatus('task-up-post-stale-before-merge', 'review');
      return true;
    });
    const mergeSpy = vi.spyOn(manager, 'mergePr').mockResolvedValue();

    await emitPrUpdated('task-up-post-stale-before-merge', {
      prNumber: 79,
      kind: 'pr-merge-ready',
      verdictAgentId: 'dev-1',
      token: 'post-token-79',
    });

    expect(mergeSpy).not.toHaveBeenCalled();
    const intervention = findIntervention('task-up-post-stale-before-merge');
    expect(intervention).toBeTruthy();
    expect(intervention!.data.phase).toBe('post-approve-merge-skipped-stale-task');
  });

  it('fixing → review with phase=recheck', async () => {
    await seedTask({ id: 'task-up2', status: 'fixing', reviewRound: 1, prNumber: 51 });
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await emitPrUpdated('task-up2', { prNumber: 51 });

    expect(startSpy).toHaveBeenCalledWith('task-up2', 'qa-1', 'recheck');
  });

  it('in_progress without prNumber (task or event) → defer (no transition, no startSession)', async () => {
    await seedTask({ id: 'task-defer', status: 'in_progress', reviewRound: 0, prNumber: undefined });
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await emitPrUpdated('task-defer', {});

    const task = await taskStore.get('task-defer');
    expect(task!.status).toBe('in_progress');
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('in_progress with task.prNumber pre-set → still catch-up (no defer)', async () => {
    await seedTask({ id: 'task-haspr', status: 'in_progress', reviewRound: 0, prNumber: 88 });
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await emitPrUpdated('task-haspr', {});

    const task = await taskStore.get('task-haspr');
    expect(task!.status).toBe('review');
    expect(startSpy).toHaveBeenCalledWith('task-haspr', 'qa-1', 'review');
  });

  it('fixing without event prNumber → still catch-up (fixing implies prior review/PR)', async () => {
    await seedTask({ id: 'task-fix-no-pr', status: 'fixing', reviewRound: 1, prNumber: 12 });
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await emitPrUpdated('task-fix-no-pr', {});

    expect(startSpy).toHaveBeenCalledWith('task-fix-no-pr', 'qa-1', 'recheck');
  });

  it('startSession success → markAgentWaiting + updateTask qaAgentId', async () => {
    await seedTask({ id: 'task-up-ok', status: 'fixing', reviewRound: 1, prNumber: 70 });
    const { markAgentWaiting: markWaitSpy, updateTask: updateSpy } = stubManager({ startSession: true, markAgentWaiting: true, updateTask: undefined });

    await emitPrUpdated('task-up-ok', { prNumber: 70, prUrl: 'https://github.com/user/repo/pull/70' });

    expect(markWaitSpy).toHaveBeenCalledWith('dev-1', 'task-up-ok');
    expect(updateSpy).toHaveBeenCalledWith('task-up-ok', { qaAgentId: 'qa-1' });
    const task = await taskStore.get('task-up-ok');
    expect(task!.prUrl).toBe('https://github.com/user/repo/pull/70');
  });

  it('startSession resolve(false) from fixing → rollback to fixing, qaAgentId pre-arm rolled back, no other side effects', async () => {
    await seedTask({ id: 'task-up-rb', status: 'fixing', reviewRound: 1, prNumber: 71 });
    const { markAgentWaiting: markWaitSpy, updateTask: updateSpy } = stubManager({ startSession: false, markAgentWaiting: true, updateTask: undefined });

    await emitPrUpdated('task-up-rb', { prNumber: 71 });

    const task = await taskStore.get('task-up-rb');
    expect(task!.status).toBe('fixing');
    expect(markWaitSpy).not.toHaveBeenCalled();
    const qaWrites = updateSpy.mock.calls.filter(([_id, patch]) =>
      patch && 'qaAgentId' in patch,
    );
    expect(qaWrites).toEqual([
      ['task-up-rb', { qaAgentId: 'qa-1' }],
      ['task-up-rb', { qaAgentId: undefined }],
    ]);
  });

  it('recheck verdict watcher fails to arm → rolls back to fixing + restores token, releases QA + intervention', async () => {
    await seedTask({ id: 'task-up-noarm', status: 'fixing', reviewRound: 1, prNumber: 71, signalToken: 'fixing-token' });
    await seedDevAgent('task-up-noarm');
    const { releaseAgentForTask: releaseSpy, startSession: startSpy } = stubManager({ acquireAgentForTask: true, releaseAgentForTask: true, rotateAndSetupPhaseSignal: { token: 'rotated', armed: false }, startSession: true });

    await emitPrUpdated('task-up-noarm', { prNumber: 71 });

    expect(startSpy).not.toHaveBeenCalled();
    expect(releaseSpy).toHaveBeenCalledWith('qa-1', 'task-up-noarm', 'idle');
    const task = await taskStore.get('task-up-noarm');
    // Rolled back to fixing AND the rotated token reverted, so the dev's prior pr-fixed prompt
    // signal isn't stranded by a token mismatch.
    expect(task!.status).toBe('fixing');
    expect(task!.signalToken).toBe('fixing-token');
    expect(task!.qaAgentId).toBeUndefined();
    expect(findInterventionByPhase('qa-recheck-arm-failed')).toBeDefined();
  });

  it('startSession hard error from in_progress → rollback to in_progress', async () => {
    await seedTask({ id: 'task-up-rb2', status: 'in_progress', reviewRound: 0, prNumber: 72 });
    vi.spyOn(manager, 'startSession').mockRejectedValue(new Error('boom'));

    await emitPrUpdated('task-up-rb2', { prNumber: 72 });

    const task = await taskStore.get('task-up-rb2');
    expect(task!.status).toBe('in_progress');
  });

  it('cancelled task → no-op', async () => {
    await seedTask({ id: 'task-up-cx', status: 'cancelled' });
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await emitPrUpdated('task-up-cx', { prNumber: 1 });

    expect(startSpy).not.toHaveBeenCalled();
  });

  it('persists prNumber/prUrl patch on transition', async () => {
    await seedTask({ id: 'task-up-patch', status: 'fixing', reviewRound: 1, prNumber: 1 });
    vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await emitPrUpdated('task-up-patch', { prNumber: 99, prUrl: 'https://github.com/user/repo/pull/99' });

    const task = await taskStore.get('task-up-patch');
    expect(task!.prNumber).toBe(99);
    expect(task!.prUrl).toBe('https://github.com/user/repo/pull/99');
  });
});

describe('pr.fix.submitted handler (dev pr-fixed completion)', () => {
  // A dev fix in flight: status=fixing, phase=code, head anchored at HEAD_SHA, dispatched now.
  function seedFixingPass(id: string, extra: Partial<TaskState> = {}): Promise<TaskState> {
    return seedTask({
      id, status: 'fixing', phase: 'code', reviewRound: 1,
      reviewHeadAnchorSha: HEAD_SHA, latestHeadSha: HEAD_SHA,
      reviewDispatchedAt: new Date().toISOString(),
      ...extra,
    });
  }

  it('no new commit + dev replied → advances fixing→review (option C)', async () => {
    await seedFixingPass('task-pf-adv', { prNumber: 70, signalToken: 'tok-pf', qaAgentId: 'qa-1' });
    stubManager({ fetchPrHeadSha: HEAD_SHA, prHasDevReplySince: true, acquireAgentForTask: true, startSession: true, rotateAndSetupPhaseSignal: { token: 'tok2', armed: true } });

    await emitPrFixSubmitted('task-pf-adv', { kind: 'pr-fixed', token: 'tok-pf', verdictAgentId: 'dev-1', source: 'pane-signal' });

    const task = await taskStore.get('task-pf-adv');
    expect(task!.status).toBe('review');
  });

  it('no new commit + no reply → stays fixing + emits no-op intervention', async () => {
    await seedFixingPass('task-pf-noop', { prNumber: 71, signalToken: 'tok-pf2' });
    stubManager({ fetchPrHeadSha: HEAD_SHA, prHasDevReplySince: false });

    await emitPrFixSubmitted('task-pf-noop', { kind: 'pr-fixed', token: 'tok-pf2', verdictAgentId: 'dev-1', source: 'pane-signal' });

    const task = await taskStore.get('task-pf-noop');
    expect(task!.status).toBe('fixing');
    expect(findInterventionByPhase('fix-no-op-no-commit-no-reply')).toBeDefined();
  });

  it('new commit → defers to the poller push event (handler no-op, no double dispatch)', async () => {
    await seedFixingPass('task-pf-commit', { prNumber: 72, signalToken: 'tok-pf3' });
    const { prHasDevReplySince: replySpy } = stubManager({ fetchPrHeadSha: NEXT_HEAD_SHA, prHasDevReplySince: true });

    await emitPrFixSubmitted('task-pf-commit', { kind: 'pr-fixed', token: 'tok-pf3', verdictAgentId: 'dev-1', source: 'pane-signal' });

    const task = await taskStore.get('task-pf-commit');
    expect(task!.status).toBe('fixing');
    expect(replySpy).not.toHaveBeenCalled();
  });

  it('stale token → rejected before any GitHub fetch, stays fixing', async () => {
    await seedFixingPass('task-pf-stale', { prNumber: 73, signalToken: 'current-tok' });
    const fetchSpy = vi.spyOn(manager, 'fetchPrHeadSha');

    await emitPrFixSubmitted('task-pf-stale', { kind: 'pr-fixed', token: 'stale-tok', verdictAgentId: 'dev-1', source: 'pane-signal' });

    const task = await taskStore.get('task-pf-stale');
    expect(task!.status).toBe('fixing');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(findInterventionByPhase('stale-pr-fixed-wrong-pass')).toBeDefined();
  });

  it('missing token → rejected (fail-closed), stays fixing', async () => {
    await seedFixingPass('task-pf-notok', { prNumber: 74, signalToken: 'armed-tok' });
    const fetchSpy = vi.spyOn(manager, 'fetchPrHeadSha');

    await emitPrFixSubmitted('task-pf-notok', { kind: 'pr-fixed', verdictAgentId: 'dev-1', source: 'pane-signal' });

    const task = await taskStore.get('task-pf-notok');
    expect(task!.status).toBe('fixing');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(findInterventionByPhase('stale-pr-fixed-wrong-pass')).toBeDefined();
  });

  it('head fetch fails → fail-closed escalation, no no-op verdict', async () => {
    await seedFixingPass('task-pf-headfail', { prNumber: 75, signalToken: 'tok-hf' });
    vi.spyOn(manager, 'fetchPrHeadSha').mockRejectedValue(new Error('gh api offline'));
    const replySpy = vi.spyOn(manager, 'prHasDevReplySince').mockResolvedValue(false);

    await emitPrFixSubmitted('task-pf-headfail', { kind: 'pr-fixed', token: 'tok-hf', verdictAgentId: 'dev-1', source: 'pane-signal' });

    const task = await taskStore.get('task-pf-headfail');
    expect(task!.status).toBe('fixing');
    expect(replySpy).not.toHaveBeenCalled(); // never reaches reply/no-op path
    expect(findInterventionByPhase('fix-verify-head-fetch-failed')).toBeDefined();
    expect(findInterventionByPhase('fix-no-op-no-commit-no-reply')).toBeUndefined();
  });

  it('reply fetch fails → fail-closed escalation, not treated as no-op', async () => {
    await seedFixingPass('task-pf-replyfail', { prNumber: 76, signalToken: 'tok-rf' });
    vi.spyOn(manager, 'fetchPrHeadSha').mockResolvedValue(HEAD_SHA); // no new commit
    vi.spyOn(manager, 'prHasDevReplySince').mockRejectedValue(new Error('gh api offline'));

    await emitPrFixSubmitted('task-pf-replyfail', { kind: 'pr-fixed', token: 'tok-rf', verdictAgentId: 'dev-1', source: 'pane-signal' });

    const task = await taskStore.get('task-pf-replyfail');
    expect(task!.status).toBe('fixing');
    expect(findInterventionByPhase('fix-verify-replies-fetch-failed')).toBeDefined();
    expect(findInterventionByPhase('fix-no-op-no-commit-no-reply')).toBeUndefined();
  });

  it('uses fixDispatchedAt (not reviewDispatchedAt) as the activity lower bound', async () => {
    await seedFixingPass('task-pf-bound', {
      reviewRound: 2, prNumber: 80, signalToken: 'tok-bd',
      reviewDispatchedAt: '2026-06-01T00:00:00.000Z',
      fixDispatchedAt: '2026-06-01T00:05:00.000Z',
    });
    const { prHasDevReplySince: replySpy } = stubManager({ fetchPrHeadSha: HEAD_SHA, prHasDevReplySince: false, setupPhaseSignal: true });

    await emitPrFixSubmitted('task-pf-bound', { kind: 'pr-fixed', token: 'tok-bd', verdictAgentId: 'dev-1', source: 'pane-signal' });

    // QA/human comments left during the prior review (after reviewDispatchedAt,
    // before fixing) must NOT count — bound is fixDispatchedAt.
    expect(replySpy).toHaveBeenCalledWith('task-pf-bound', '2026-06-01T00:05:00.000Z');
  });

  it('re-sets up the pr-fixed watcher with skipSnapshot when it leaves the task in fixing', async () => {
    await seedFixingPass('task-pf-rearm', {
      prNumber: 81, signalToken: 'tok-ra', fixDispatchedAt: new Date().toISOString(),
    });
    vi.spyOn(manager, 'fetchPrHeadSha').mockResolvedValue(HEAD_SHA);
    vi.spyOn(manager, 'prHasDevReplySince').mockResolvedValue(false); // no-op
    const armSpy = vi.spyOn(manager, 'setupPhaseSignal').mockResolvedValue(true);

    await emitPrFixSubmitted('task-pf-rearm', { kind: 'pr-fixed', token: 'tok-ra', verdictAgentId: 'dev-1', source: 'pane-signal' });

    expect(armSpy).toHaveBeenCalledWith('task-pf-rearm', 'dev-1', 'pr-fixed', { skipSnapshot: true });
  });

  it('missing reviewHeadAnchorSha fails closed with escalation instead of no-op', async () => {
    await seedFixingPass('task-pf-noanchor', {
      prNumber: 82, signalToken: 'tok-na', fixDispatchedAt: new Date().toISOString(),
      reviewHeadAnchorSha: undefined, // bail at no-anchor before the reply check
    });
    const { prHasDevReplySince: replySpy } = stubManager({ fetchPrHeadSha: NEXT_HEAD_SHA, prHasDevReplySince: false, setupPhaseSignal: true });

    await emitPrFixSubmitted('task-pf-noanchor', { kind: 'pr-fixed', token: 'tok-na', verdictAgentId: 'dev-1', source: 'pane-signal' });

    const task = await taskStore.get('task-pf-noanchor');
    expect(task!.status).toBe('fixing');
    expect(replySpy).not.toHaveBeenCalled(); // bailed at no-anchor before the reply check
    expect(findInterventionByPhase('fix-verify-no-anchor')).toBeDefined();
  });

  it('synthetic advance rolls back to fixing and escalates when QA dispatch fails', async () => {
    await seedFixingPass('task-pf-rollback', {
      prNumber: 83, signalToken: 'tok-rb', qaAgentId: 'qa-1', fixDispatchedAt: new Date().toISOString(),
    });
    vi.spyOn(manager, 'fetchPrHeadSha').mockResolvedValue(HEAD_SHA); // no new commit
    vi.spyOn(manager, 'prHasDevReplySince').mockResolvedValue(true); // has replies → advance
    stubManager({ acquireAgentForTask: true, releaseAgentForTask: true, rotateAndSetupPhaseSignal: { token: 'tok2', armed: true }, setupPhaseSignal: true });
    // QA dispatch fails → pr.updated push handler rolls review back to fixing.
    vi.spyOn(manager, 'startSession').mockResolvedValue(false);

    await emitPrFixSubmitted('task-pf-rollback', { kind: 'pr-fixed', token: 'tok-rb', verdictAgentId: 'dev-1', source: 'pane-signal' });

    const task = await taskStore.get('task-pf-rollback');
    expect(task!.status).toBe('fixing'); // rolled back by the push handler
    expect(findInterventionByPhase('fix-advance-rolled-back')).toBeDefined();
  });
});

describe('pr.merged handler', () => {
  // max_rounds is non-terminal (paused awaiting a human decision), so a merge of its PR —
  // manual mark-complete or an externally-merged PR the poller detects — must still transition
  // to merged and run the normal post-merge cleanup, like the active statuses.
  it.each([
    ['in_progress' as TaskStatus, 'task-m1', 10, { reviewRound: 0 }],
    ['merge-ready' as TaskStatus, 'task-mr-merged', 18, { reviewRound: 1 }],
    ['fixing' as TaskStatus, 'task-m2', 11, { reviewRound: 1 }],
    ['max_rounds' as TaskStatus, 'task-m-max', 19, { branch: 'bx/task-m-max' }],
  ])('%s → merged + cleanupAfterMerge', async (status, id, prNumber, extra) => {
    await seedTask({ id, status, prNumber, ...extra });
    const cleanupSpy = vi.spyOn(manager, 'cleanupAfterMerge').mockResolvedValue();

    await emitPrMerged(id, { prNumber });

    const task = await taskStore.get(id);
    expect(task!.status).toBe('merged');
    expect(cleanupSpy).toHaveBeenCalledWith(id);
  });

  // review → merged dispatches post-merge cleanup to QA WITHOUT an up-front release. The cleanup
  // flow keeps QA bound (non-dispatchable / Start disabled) and releases only after /clear, so the
  // next task can't start before QA cleaned its branch + cleared context.
  it.each([
    ['task-m3', 12],
    ['task-m3-cleanup', 77],
  ])('review → merged → dispatchPostMergeCleanup(QA), not an up-front release (%s)', async (id, prNumber) => {
    await seedTask({ id, status: 'review', reviewRound: 1, prNumber, qaAgentId: 'qa-1', branch: `bx/${id}` });
    const { dispatchPostMergeCleanup: dispatchSpy, releaseAgentForTask: stopSpy } = stubManager({ cleanupAfterMerge: undefined, dispatchPostMergeCleanup: undefined, releaseAgentForTask: true });

    await emitPrMerged(id, { prNumber });

    expect(dispatchSpy).toHaveBeenCalledWith('qa-1', { prNumber, taskId: id, branch: `bx/${id}` });
    expect(stopSpy).not.toHaveBeenCalledWith('qa-1', id, 'idle');
  });

  it('approved → merged → dispatchPostMergeCleanup(QA) (idempotent even if APPROVE already released QA)', async () => {
    await seedTask({ id: 'task-m4', status: 'approved', reviewRound: 1, prNumber: 13, qaAgentId: 'qa-1' });
    const { dispatchPostMergeCleanup: dispatchSpy } = stubManager({ cleanupAfterMerge: undefined, dispatchPostMergeCleanup: undefined });

    await emitPrMerged('task-m4', { prNumber: 13 });

    expect(dispatchSpy).toHaveBeenCalledWith('qa-1', {
      prNumber: 13,
      taskId: 'task-m4',
      branch: 'bx/task-m4',
    });
    const task = await taskStore.get('task-m4');
    expect(task!.status).toBe('merged');
  });

  it('approved external merge routes the post-approve dev through post-merge cleanup', async () => {
    await seedTask({ id: 'task-m4-post-approve', status: 'approved', reviewRound: 1, prNumber: 130 });
    // cleanupAfterMerge runs for real and must delegate dev cleanup to dispatchPostMergeCleanup,
    // which keeps the dev bound until branch delete + /clear finish.
    const dispatchSpy = vi.spyOn(manager, 'dispatchPostMergeCleanup').mockResolvedValue();

    await emitPrMerged('task-m4-post-approve', { prNumber: 130 });

    const task = await taskStore.get('task-m4-post-approve');
    expect(task!.status).toBe('merged');
    expect(dispatchSpy).toHaveBeenCalledWith('dev-1', {
      prNumber: 130,
      taskId: 'task-m4-post-approve',
      branch: 'bx/task-m4-post-approve',
    });
  });

  it('qaAgentId missing → skip releaseAgentForTask', async () => {
    await seedTask({ id: 'task-m5', status: 'review', reviewRound: 1, prNumber: 14 });
    const { releaseAgentForTask: stopSpy } = stubManager({ cleanupAfterMerge: undefined, releaseAgentForTask: true });

    await emitPrMerged('task-m5', { prNumber: 14 });

    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('releaseAgentForTask returns false (taskId mismatch) → safe no-op, rest of flow continues', async () => {
    await seedTask({ id: 'task-m6', status: 'review', reviewRound: 1, prNumber: 15, qaAgentId: 'qa-1' });
    const { cleanupAfterMerge: cleanupSpy } = stubManager({ cleanupAfterMerge: undefined, releaseAgentForTask: false });

    await emitPrMerged('task-m6', { prNumber: 15 });

    expect(cleanupSpy).toHaveBeenCalledWith('task-m6');
  });

  it('persists prNumber/prUrl from event payload', async () => {
    await seedTask({ id: 'task-m7', status: 'in_progress', reviewRound: 0, prNumber: undefined });
    vi.spyOn(manager, 'cleanupAfterMerge').mockResolvedValue();

    await emitPrMerged('task-m7', { prNumber: 16, prUrl: 'https://github.com/user/repo/pull/16' });

    const task = await taskStore.get('task-m7');
    expect(task!.prNumber).toBe(16);
    expect(task!.prUrl).toBe('https://github.com/user/repo/pull/16');
  });

  it('already-merged task → no-op (terminal)', async () => {
    await seedTask({ id: 'task-m8', status: 'merged', prNumber: 17 });
    const cleanupSpy = vi.spyOn(manager, 'cleanupAfterMerge').mockResolvedValue();

    await emitPrMerged('task-m8', { prNumber: 17 });

    expect(cleanupSpy).not.toHaveBeenCalled();
  });

  it('cancelled / failed → no-op', async () => {
    for (const status of ['cancelled', 'failed'] as const) {
      const id = `task-m-${status}`;
      await seedTask({ id, status, prNumber: 18 });
    }
    const cleanupSpy = vi.spyOn(manager, 'cleanupAfterMerge').mockResolvedValue();

    for (const status of ['cancelled', 'failed'] as const) {
      await emitPrMerged(`task-m-${status}`, { prNumber: 18 });
    }

    expect(cleanupSpy).not.toHaveBeenCalled();
  });

});

describe('review.submitted (manual review terminal-task escape)', () => {
  async function seedQaBound(taskId: string, qaAgentId = 'qa-1'): Promise<void> {
    await agentStore.set({
      id: qaAgentId,
      projectId: 'proj',
      status: 'running',
      taskId,
      sessionStatus: 'ready',
      updatedAt: new Date().toISOString(),
    });
  }

  // max_rounds is intentionally absent: it is non-terminal now, so the terminal escape
  // does not apply to it (and in the real flow its QA is already released at the pause).
  it.each([
    ['merged' as TaskStatus, 'APPROVE'],
    ['cancelled' as TaskStatus, 'REQUEST_CHANGES'],
    ['failed' as TaskStatus, 'APPROVE'],
  ])('terminal task (%s) + QA still bound to task → release QA + emit intervention + no transition', async (status, action) => {
    await seedTask({ id: `task-tm-${status}`, status, reviewRound: 2, prNumber: 99, qaAgentId: 'qa-1' });
    await seedQaBound(`task-tm-${status}`);
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    const transitionSpy = vi.spyOn(manager, 'transitionTaskStatus');

    await emitReview(`task-tm-${status}`, { action, prNumber: 99, headSha: HEAD_SHA }, 'dev-1');

    expect(releaseSpy).toHaveBeenCalledWith('qa-1', `task-tm-${status}`, 'idle');
    expect(transitionSpy).not.toHaveBeenCalled();

    const task = await taskStore.get(`task-tm-${status}`);
    expect(task!.status).toBe(status);

    const intervention = findIntervention(`task-tm-${status}`);
    expect(intervention).toBeTruthy();
    expect(intervention!.data.phase).toBe('manual-review-on-terminal-task-completed');
    expect(intervention!.data.qaAgentId).toBe('qa-1');
    expect(intervention!.data.taskStatus).toBe(status);
  });

  it('terminal task with no qaAgentId → no escape', async () => {
    await seedTask({ id: 'task-tm-no-qa', status: 'merged', reviewRound: 2, prNumber: 100, qaAgentId: undefined });
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);

    await emitReview('task-tm-no-qa', { action: 'APPROVE', prNumber: 100, headSha: HEAD_SHA }, 'dev-1');

    expect(releaseSpy).not.toHaveBeenCalled();
  });

  it('terminal task + QA already released (taskId mismatch) → escape NOT triggered (idempotent on replayed events)', async () => {
    await seedTask({ id: 'task-tm-replay', status: 'merged', reviewRound: 2, prNumber: 101, qaAgentId: 'qa-1' });
    await agentStore.set({
      id: 'qa-1', projectId: 'proj', status: 'idle',
      sessionStatus: 'ready', updatedAt: new Date().toISOString(),
    });
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);

    await emitReview('task-tm-replay', { action: 'APPROVE', prNumber: 101, headSha: HEAD_SHA }, 'dev-1');

    expect(releaseSpy).not.toHaveBeenCalled();
    expect(findInterventionByPhase('manual-review-on-terminal-task-completed')).toBeUndefined();
  });

  // max_rounds is non-terminal now, so a spec-phase max_rounds review.submitted no longer
  // hits the terminal escape; the spec gate early-returns and the event is inert (the code
  // protocol must never mutate a spec-phase task's status).
  it('spec phase + max_rounds → no terminal escape, spec gate early-returns (inert)', async () => {
    await seedTask({
      id: 'task-spec-max-rounds',
      status: 'max_rounds',
      phase: 'spec',
      reviewRound: 3,
      specReviewRound: 3,
      signalToken: 'spec-tok-mr',
      prNumber: 110,
      qaAgentId: 'qa-1',
    });
    await agentStore.set({
      id: 'qa-1', projectId: 'proj', status: 'running',
      taskId: 'task-spec-max-rounds', sessionStatus: 'ready',
      updatedAt: new Date().toISOString(),
    });
    const transitionSpy = vi.spyOn(manager, 'transitionTaskStatus');

    await emitReview('task-spec-max-rounds', { action: 'REQUEST_CHANGES', prNumber: 110, headSha: HEAD_SHA }, 'dev-1');

    // 状态不被改（spec gate 早退），且未触发 terminal escape 的 intervention。
    expect(transitionSpy).not.toHaveBeenCalled();
    const task = await taskStore.get('task-spec-max-rounds');
    expect(task!.status).toBe('max_rounds');
    expect(task!.phase).toBe('spec');
    const intervention = findInterventionByPhase('manual-review-on-terminal-task-completed');
    expect(intervention).toBeUndefined();
  });
});

describe('review.submitted spec-phase gate', () => {
  it('spec phase: APPROVE early-exits — no status transition, no post-approve dispatch', async () => {
    await seedTask({
      id: 'task-spec-approve',
      status: 'review',
      phase: 'spec',
      reviewRound: 1,
      specReviewRound: 1,
      signalToken: 'spec-tok-d',
      prNumber: 80,
      qaAgentId: 'qa-1',
    });
    const transitionSpy = vi.spyOn(manager, 'transitionTaskStatus');
    const { acquireAgentForTask: acquireSpy, continueSession: continueSpy } = stubManager({ acquireAgentForTask: true, continueSession: true });

    await emitReview('task-spec-approve', { action: 'APPROVE', prNumber: 80, headSha: HEAD_SHA });

    expect(transitionSpy).not.toHaveBeenCalled();
    expect(acquireSpy).not.toHaveBeenCalled();
    expect(continueSpy).not.toHaveBeenCalled();
    const task = await taskStore.get('task-spec-approve');
    expect(task!.status).toBe('review');
    expect(task!.phase).toBe('spec');
  });

  it('spec phase: REQUEST_CHANGES also early-exits', async () => {
    await seedTask({
      id: 'task-spec-changes',
      status: 'review',
      phase: 'spec',
      reviewRound: 1,
      specReviewRound: 1,
      signalToken: 'spec-tok-e',
      prNumber: 81,
      qaAgentId: 'qa-1',
    });
    const transitionSpy = vi.spyOn(manager, 'transitionTaskStatus');

    await emitReview('task-spec-changes', { action: 'REQUEST_CHANGES', prNumber: 81, headSha: HEAD_SHA });

    expect(transitionSpy).not.toHaveBeenCalled();
  });
});

describe('review.submitted APPROVE', () => {
  it('pane-fallback APPROVE (same-identity 422, no event.data.headSha) uses task.reviewHeadAnchorSha and reaches the approve branch', async () => {
    // Same-identity (422) fallback: QA echoes pr-approved as a pane signal (no
    // headSha — the agent doesn't observe SHAs). Handler must pin reviewedHeadSha
    // to task.reviewHeadAnchorSha (snapshotted at dispatch), NOT task.latestHeadSha
    // (which can be re-anchored by a mid-review push).
    await seedReviewPass('task-pane-approve', { prNumber: 200 });
    stubManager({ releaseAgentForTask: true, acquireAgentForTask: true, continueSession: true, mergePr: undefined });

    await emitReview('task-pane-approve', {
      kind: 'pr-approved',
      action: 'APPROVE',
      verdictAgentId: 'qa-1',
      source: 'pane-signal',
      // intentionally no headSha — that's the fallback case under test.
    });

    const task = await taskStore.get('task-pane-approve');
    expect(task!.status).toBe('approved');
    const completion = await manager.getPostApproveCompletion('task-pane-approve');
    expect(completion?.approvedHeadSha).toBe(HEAD_SHA);
    const stranded = findInterventionByPhase('approval-reviewed-head-unavailable');
    expect(stranded).toBeUndefined();
  });

  it('pane-fallback APPROVE under push-during-review rejects as stale (head-race protection via anchor)', async () => {
    // QA dispatched at head A → reviewHeadAnchorSha=A (immutable). Dev pushes head
    // B mid-review → latestHeadSha=B. QA pane-approves (no headSha). reviewedHeadSha
    // = anchor A, GitHub authoritative head = B, A != B → stale-approval-head-mismatch.
    const HEAD_B = NEXT_HEAD_SHA;
    // anchor pinned at A (dispatch head); latestHeadSha moved to B by a mid-review push.
    await seedReviewPass('task-race', { prNumber: 300, latestHeadSha: HEAD_B });
    stubManager({ releaseAgentForTask: true, acquireAgentForTask: true, continueSession: true, mergePr: undefined, fetchPrHeadSha: HEAD_B });

    await emitReview('task-race', {
      kind: 'pr-approved',
      action: 'APPROVE',
      verdictAgentId: 'qa-1',
      source: 'pane-signal',
    });

    const completion = await manager.getPostApproveCompletion('task-race');
    expect(completion).toBeNull();
    const stale = findInterventionByPhase('stale-approval-head-mismatch');
    expect(stale).toBeDefined();
  });

  it('poller verdict tears down the fallback verdict watcher (distinct-identity: armed but never fired)', async () => {
    // Distinct identity: QA approves via `gh pr review`, never emits a pane signal.
    // The fallback verdict watcher stays armed; the poller verdict must tear it
    // down so it neither leaks the subscription nor raises a spurious session-gone.
    await seedReviewPass('task-teardown', { prNumber: 210 });
    stubApproveFlow();
    const stopSpy = vi.spyOn(manager, 'stopPhaseSignalWatcher');

    await emitReview('task-teardown', {
      action: 'APPROVE',
      prNumber: 210,
      headSha: HEAD_SHA,       // poller-sourced commit_id
      currentHeadSha: HEAD_SHA,
    });

    expect(stopSpy).toHaveBeenCalledWith('task-teardown');
    const task = await taskStore.get('task-teardown');
    expect(task!.status).toBe('approved');
  });

  it('head-stale APPROVE does NOT tear down the watcher (rejected before any transition)', async () => {
    // bx-cx review: teardown must run only after the verdict is actually consumed.
    // A head-stale verdict is rejected (stale-approval-head-mismatch) before the
    // approved transition — tearing the watcher down there would strand a same-identity
    // 422 fallback (no watcher to catch a corrected emit) or clobber pr-merge-ready.
    await seedReviewPass('task-stale-noteardown', { prNumber: 220, latestHeadSha: NEXT_HEAD_SHA });
    vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'fetchPrHeadSha').mockResolvedValue(NEXT_HEAD_SHA); // current head moved on
    const stopSpy = vi.spyOn(manager, 'stopPhaseSignalWatcher');

    await emitReview('task-stale-noteardown', {
      action: 'APPROVE',
      prNumber: 220,
      headSha: HEAD_SHA,          // verdict reviewed the OLD head
      currentHeadSha: NEXT_HEAD_SHA,
    });

    const stale = findInterventionByPhase('stale-approval-head-mismatch');
    expect(stale).toBeDefined();
    expect(stopSpy).not.toHaveBeenCalled();
    const task = await taskStore.get('task-stale-noteardown');
    expect(task!.status).toBe('review'); // unchanged
  });

  it('review → approved + release QA + dispatch dev post-approve feedback check', async () => {
    await seedTask({ id: 'task-a1', status: 'review', reviewRound: 1, prNumber: 20, qaAgentId: 'qa-1' });
    const { releaseAgentForTask: stopSpy, acquireAgentForTask: acquireSpy, continueSession: continueSpy } = stubManager({ releaseAgentForTask: true, acquireAgentForTask: true, continueSession: true, mergePr: undefined });

    await emitReview('task-a1', { action: 'APPROVE', prNumber: 20, headSha: HEAD_SHA });

    const task = await taskStore.get('task-a1');
    expect(task!.status).toBe('approved');
    expect((task as Record<string, unknown>).signalToken).toBeUndefined();
    const completion = await manager.getPostApproveCompletion('task-a1');
    expect(completion?.token).toMatch(/^[0-9a-f]{12}$/);
    expect(completion?.approvedHeadSha).toBe(HEAD_SHA);
    expect(stopSpy).toHaveBeenCalledWith('qa-1', 'task-a1', 'idle', { allowAwaitingHuman: true });
    expect(acquireSpy).toHaveBeenCalledWith('dev-1', 'task-a1', 'post-approve');
    expect(continueSpy).toHaveBeenCalledWith(
      'task-a1',
      'dev-1',
      'post-approve',
      { signalToken: completion?.token },
    );
  });

  it('auto-merge waits for dev post-approve feedback check instead of merging immediately', async () => {
    await seedTask({ id: 'task-a2', status: 'review', reviewRound: 1, prNumber: 21, qaAgentId: 'qa-1' });
    const { continueSession: continueSpy, mergePr: mergeSpy } = stubManager({ releaseAgentForTask: true, acquireAgentForTask: true, continueSession: true, mergePr: undefined });

    await emitReview('task-a2', { action: 'APPROVE', prNumber: 21, headSha: HEAD_SHA });

    expect(mergeSpy).not.toHaveBeenCalled();
    expect(continueSpy).toHaveBeenCalledWith(
      'task-a2',
      'dev-1',
      'post-approve',
      { signalToken: expect.stringMatching(/^[0-9a-f]{12}$/) },
    );
  });

  it('post-approve dev acquire failure → emits human.intervention', async () => {
    await seedTask({ id: 'task-a3', status: 'review', reviewRound: 1, prNumber: 22, qaAgentId: 'qa-1' });
    const { continueSession: continueSpy } = stubManager({ releaseAgentForTask: true, acquireAgentForTask: false, continueSession: true });

    await emitReview('task-a3', { action: 'APPROVE', prNumber: 22, headSha: HEAD_SHA });

    const intervention = findInterventionByPhase('post-approve-dev-acquire-failed');
    expect(intervention).toBeTruthy();
    expect(intervention!.taskId).toBe('task-a3');
    expect(intervention!.data.devAgentId).toBe('dev-1');
    expect(continueSpy).not.toHaveBeenCalled();
  });

  it('post-approve dispatch fail + emit fail → handler swallows emit error (no rethrow)', async () => {
    await seedTask({ id: 'task-a4', status: 'review', reviewRound: 1, prNumber: 23, qaAgentId: 'qa-1' });
    stubManager({ releaseAgentForTask: true, acquireAgentForTask: true });
    vi.spyOn(manager, 'continueSession').mockRejectedValue(new Error('boom'));
    vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);
    const realEmit = eventBus.emit.bind(eventBus);
    vi.spyOn(eventBus, 'emit').mockImplementation(async (evt) => {
      if (evt.type === 'human.intervention') throw new Error('emit failed');
      return realEmit(evt);
    });

    await expect(emitReview('task-a4', { action: 'APPROVE', prNumber: 23, headSha: HEAD_SHA })).resolves.not.toThrow();
  });

  it('post-approve terminal dispatch error fails the task and releases dev', async () => {
    await seedTask({ id: 'task-a-terminal', status: 'review', reviewRound: 1, prNumber: 26, qaAgentId: 'qa-1' });
    stubManager({ releaseAgentForTask: true, acquireAgentForTask: true });
    vi.spyOn(manager, 'continueSession').mockRejectedValue(
      new DispatchTerminalError('prompt_too_large', 'prompt too large'),
    );
    const { failTaskForDispatchError: failSpy, markAgentWaiting: markWaitSpy } = stubManager({ failTaskForDispatchError: undefined, markAgentWaiting: true });

    await emitReview('task-a-terminal', { action: 'APPROVE', prNumber: 26, headSha: HEAD_SHA });

    expect(failSpy).toHaveBeenCalledWith(
      'task-a-terminal',
      'post-approve',
      'dev-1',
      expect.any(DispatchTerminalError),
    );
    expect(markWaitSpy).not.toHaveBeenCalled();
  });

  it('auto-merge off (project.merge=null) → no mergePr call', async () => {
    const manualConfig: BaxianConfig = {
      ...CONFIG,
      project: [{ ...CONFIG.project[0], merge: null }],
    };
    const { manager: localManager, bus: localBus } = await makeLocalHandlers(manualConfig, 'events-manual');

    await seedTask({ id: 'task-a-manual', status: 'review', reviewRound: 1, prNumber: 24, qaAgentId: 'qa-1' });
    vi.spyOn(localManager, 'releaseAgentForTask').mockResolvedValue(true);
    vi.spyOn(localManager, 'acquireAgentForTask').mockResolvedValue(true);
    const continueSpy = vi.spyOn(localManager, 'continueSession').mockResolvedValue(true);
    const mergeSpy = vi.spyOn(localManager, 'mergePr').mockResolvedValue();

    await localBus.emit({
      id: '',
      type: 'review.submitted',
      timestamp: new Date().toISOString(),
      projectId: 'proj',
      agentId: 'qa-1',
      taskId: 'task-a-manual',
      data: { action: 'APPROVE', prNumber: 24, headSha: HEAD_SHA },
    });

    expect(mergeSpy).not.toHaveBeenCalled();
    expect(continueSpy).toHaveBeenCalledWith(
      'task-a-manual',
      'dev-1',
      'post-approve',
      { signalToken: expect.stringMatching(/^[0-9a-f]{12}$/) },
    );
    const task = await taskStore.get('task-a-manual');
    expect(task!.status).toBe('approved');
  });

  it('cancelled task → no-op', async () => {
    await seedTask({ id: 'task-a-cx', status: 'cancelled', prNumber: 25 });
    const { releaseAgentForTask: stopSpy, mergePr: mergeSpy } = stubManager({ releaseAgentForTask: true, mergePr: undefined });

    await emitReview('task-a-cx', { action: 'APPROVE', prNumber: 25, headSha: HEAD_SHA });

    expect(stopSpy).not.toHaveBeenCalled();
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  it('stale approval for an older reviewed commit stays in review and does not dispatch post-approve', async () => {
    await seedTask({ id: 'task-a-stale', status: 'review', reviewRound: 1, prNumber: 27, qaAgentId: 'qa-1' });
    const { releaseAgentForTask: stopSpy, acquireAgentForTask: acquireSpy, continueSession: continueSpy } = stubManager({ releaseAgentForTask: true, acquireAgentForTask: true, continueSession: true });

    await emitReview('task-a-stale', {
      action: 'APPROVE',
      prNumber: 27,
      headSha: HEAD_SHA,
      currentHeadSha: NEXT_HEAD_SHA,
    });

    const task = await taskStore.get('task-a-stale');
    expect(task!.status).toBe('review');
    await expect(manager.getPostApproveCompletion('task-a-stale')).resolves.toBeNull();
    expect(stopSpy).not.toHaveBeenCalled();
    expect(acquireSpy).not.toHaveBeenCalled();
    expect(continueSpy).not.toHaveBeenCalled();
    const intervention = findIntervention('task-a-stale');
    expect(intervention).toBeTruthy();
    expect(intervention!.data.phase).toBe('stale-approval-head-mismatch');
  });

  it('stale approval for an older reviewed commit does not clear an active approved post-approve token', async () => {
    await seedTask({ id: 'task-a-stale-approved', status: 'approved', reviewRound: 1, prNumber: 28, qaAgentId: 'qa-1' });
    await manager.setPostApproveCompletion('task-a-stale-approved', { token: 'active-post-token', approvedHeadSha: NEXT_HEAD_SHA });
    const { acquireAgentForTask: acquireSpy, continueSession: continueSpy } = stubManager({ acquireAgentForTask: true, continueSession: true });

    await emitReview('task-a-stale-approved', {
      action: 'APPROVE',
      prNumber: 28,
      headSha: HEAD_SHA,
      currentHeadSha: NEXT_HEAD_SHA,
    });

    const task = await taskStore.get('task-a-stale-approved');
    expect(task!.status).toBe('approved');
    await expect(manager.getPostApproveCompletion('task-a-stale-approved')).resolves.toEqual(
      expect.objectContaining({
        token: 'active-post-token',
        approvedHeadSha: NEXT_HEAD_SHA,
      }),
    );
    expect(acquireSpy).not.toHaveBeenCalled();
    expect(continueSpy).not.toHaveBeenCalled();
    const intervention = findIntervention('task-a-stale-approved');
    expect(intervention).toBeTruthy();
    expect(intervention!.data.phase).toBe('stale-approval-head-mismatch');
  });

  it('authoritative fetch returns fresh head matching reviewedHeadSha → APPROVE proceeds + latestHeadSha refreshed', async () => {
    await seedTask({ id: 'task-fetch-fresh', status: 'review', reviewRound: 1, prNumber: 300, qaAgentId: 'qa-1', latestHeadSha: HEAD_SHA });
    const { fetchPrHeadSha: fetchSpy, continueSession: continueSpy } = stubManager({ fetchPrHeadSha: NEXT_HEAD_SHA, releaseAgentForTask: true, acquireAgentForTask: true, continueSession: true });
    const updateSpy = vi.spyOn(manager, 'updateTask');

    await emitReview('task-fetch-fresh', { action: 'APPROVE', prNumber: 300, headSha: NEXT_HEAD_SHA });

    expect(fetchSpy).toHaveBeenCalledWith('task-fetch-fresh');
    expect(continueSpy).toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledWith('task-fetch-fresh', { latestHeadSha: NEXT_HEAD_SHA });
  });

  it('authoritative fetch returns head different from reviewedHeadSha → APPROVE rejected even when store agrees with reviewed (replay-after-store-lag)', async () => {
    await seedTask({ id: 'task-fetch-stale-replay', status: 'review', reviewRound: 1, prNumber: 301, qaAgentId: 'qa-1', latestHeadSha: HEAD_SHA });
    const { fetchPrHeadSha: fetchSpy, continueSession: continueSpy } = stubManager({ fetchPrHeadSha: NEXT_HEAD_SHA, continueSession: true });

    await emitReview('task-fetch-stale-replay', { action: 'APPROVE', prNumber: 301, headSha: HEAD_SHA, currentHeadSha: HEAD_SHA });

    expect(fetchSpy).toHaveBeenCalled();
    expect(continueSpy).not.toHaveBeenCalled();
    const task = await taskStore.get('task-fetch-stale-replay');
    expect(task!.status).toBe('review');
    const intervention = findIntervention('task-fetch-stale-replay');
    expect(intervention?.data.phase).toBe('stale-approval-head-mismatch');
    expect(intervention?.data.currentHeadSha).toBe(NEXT_HEAD_SHA);
    expect(intervention?.data.source).toBe('fetch');
    expect(task!.latestHeadSha).toBe(NEXT_HEAD_SHA);
  });

  it('stale APPROVE rejected once via fetch; replay during fetch failure cannot bypass via the (now-refreshed) store fallback', async () => {
    await seedTask({ id: 'task-fetch-then-fail', status: 'review', reviewRound: 1, prNumber: 305, qaAgentId: 'qa-1', latestHeadSha: HEAD_SHA });
    const fetchSpy = vi.spyOn(manager, 'fetchPrHeadSha')
      .mockResolvedValueOnce(NEXT_HEAD_SHA)
      .mockRejectedValueOnce(new Error('gh api offline'));
    const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);

    await emitReview('task-fetch-then-fail', { action: 'APPROVE', prNumber: 305, headSha: HEAD_SHA, currentHeadSha: HEAD_SHA });
    const taskAfterStep1 = await taskStore.get('task-fetch-then-fail');
    expect(taskAfterStep1!.latestHeadSha).toBe(NEXT_HEAD_SHA);

    emittedEvents.length = 0;
    await emitReview('task-fetch-then-fail', { action: 'APPROVE', prNumber: 305, headSha: HEAD_SHA, currentHeadSha: HEAD_SHA });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(continueSpy).not.toHaveBeenCalled();
    const intervention2 = findIntervention('task-fetch-then-fail');
    expect(intervention2?.data.phase).toBe('stale-approval-head-mismatch');
    expect(intervention2?.data.currentHeadSha).toBe(NEXT_HEAD_SHA);
    expect(intervention2?.data.source).toBe('task-store');
    expect(intervention2?.data.fetchError).toContain('gh api offline');
  });

  // On fetch failure the staleness check falls back: to task.latestHeadSha when present
  // (source=task-store, surfacing the fetchError), else to the verdict's own currentHeadSha
  // (source=payload-self). Either way the stale APPROVE is rejected.
  it.each([
    ['task.latestHeadSha (source=task-store)', 'task-fetch-fallback-store', 302, 'gh api offline', { latestHeadSha: NEXT_HEAD_SHA }, HEAD_SHA, 'task-store', 'gh api offline'],
    ['payload-self (source=payload-self)', 'task-fetch-fallback-payload', 303, 'gh pr view: 404', {}, NEXT_HEAD_SHA, 'payload-self', undefined],
  ])('fetch failure → falls back to %s; stale APPROVE rejected', async (_label, id, prNumber, fetchErr, seedExtra, currentHeadSha, source, fetchError) => {
    await seedTask({ id, status: 'review', reviewRound: 1, prNumber, qaAgentId: 'qa-1', ...seedExtra });
    vi.spyOn(manager, 'fetchPrHeadSha').mockRejectedValue(new Error(fetchErr));
    const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);

    await emitReview(id, { action: 'APPROVE', prNumber, headSha: HEAD_SHA, currentHeadSha });

    expect(continueSpy).not.toHaveBeenCalled();
    const intervention = findIntervention(id);
    expect(intervention?.data.phase).toBe('stale-approval-head-mismatch');
    expect(intervention?.data.source).toBe(source);
    if (fetchError !== undefined) expect(intervention?.data.fetchError).toContain(fetchError);
  });

  it('fetch failure + no store + no payload → proceeds (cannot prove staleness, behaviour matches pre-PR)', async () => {
    await seedTask({ id: 'task-fetch-no-anchor', status: 'review', reviewRound: 1, prNumber: 304, qaAgentId: 'qa-1' });
    vi.spyOn(manager, 'fetchPrHeadSha').mockRejectedValue(new Error('boom'));
    const { continueSession: continueSpy } = stubManager({ releaseAgentForTask: true, acquireAgentForTask: true, continueSession: true });

    await emitReview('task-fetch-no-anchor', { action: 'APPROVE', prNumber: 304, headSha: HEAD_SHA });

    expect(continueSpy).toHaveBeenCalled();
  });

  it('approval without reviewed head stays in review and does not bind the current PR head', async () => {
    await seedTask({ id: 'task-a-missing-head', status: 'review', reviewRound: 1, prNumber: 29, qaAgentId: 'qa-1' });
    const { fetchPrHeadSha: fetchHeadSpy, acquireAgentForTask: acquireSpy, continueSession: continueSpy } = stubManager({ fetchPrHeadSha: NEXT_HEAD_SHA, acquireAgentForTask: true, continueSession: true });

    await emitReview('task-a-missing-head', { action: 'APPROVE', prNumber: 29 });

    const task = await taskStore.get('task-a-missing-head');
    expect(task!.status).toBe('review');
    await expect(manager.getPostApproveCompletion('task-a-missing-head')).resolves.toBeNull();
    expect(fetchHeadSpy).not.toHaveBeenCalled();
    expect(acquireSpy).not.toHaveBeenCalled();
    expect(continueSpy).not.toHaveBeenCalled();
    const intervention = findIntervention('task-a-missing-head');
    expect(intervention).toBeTruthy();
    expect(intervention!.data.phase).toBe('approval-reviewed-head-unavailable');
  });
});

describe('review.submitted freshness (superseded-pass guard)', () => {
  it('rejects a poller verdict submitted before the current review pass was dispatched', async () => {
    // Race: an earlier QA pass reviewed the old head and posted CHANGES_REQUESTED,
    // but a recheck was dispatched (reviewDispatchedAt) BEFORE that late
    // verdict arrived. The verdict belongs to the superseded pass — must not apply.
    await seedReviewPass('task-stale-pass', { reviewDispatchedAt: '2026-05-30T04:02:59.000Z' });
    const transitionSpy = vi.spyOn(manager, 'transitionTaskStatus');
    vi.spyOn(manager, 'fetchPrHeadSha').mockResolvedValue(HEAD_SHA);

    await emitReview('task-stale-pass', {
      action: 'REQUEST_CHANGES',
      prNumber: 214,
      headSha: HEAD_SHA,
      currentHeadSha: HEAD_SHA,
      submittedAt: '2026-05-30T04:02:50Z', // before reviewDispatchedAt → stale
    });

    const task = await taskStore.get('task-stale-pass');
    expect(task!.status).toBe('review'); // unchanged — not driven into fixing
    expect(task!.reviewRound).toBe(1); // not bumped
    expect(transitionSpy).not.toHaveBeenCalled();
    const stale = findInterventionByPhase('stale-verdict-superseded-pass');
    expect(stale).toBeDefined();
  });

  it('accepts a poller verdict submitted after the current review pass was dispatched', async () => {
    // The fresh recheck verdict (submitted after pass #2 dispatch) must pass the gate.
    await seedReviewPass('task-fresh-pass', { reviewDispatchedAt: '2026-05-30T04:02:59.000Z' });
    stubApproveFlow();

    await emitReview('task-fresh-pass', {
      action: 'APPROVE',
      prNumber: 214,
      headSha: HEAD_SHA,
      currentHeadSha: HEAD_SHA,
      submittedAt: '2026-05-30T04:06:01Z', // after reviewDispatchedAt → fresh
    });

    const task = await taskStore.get('task-fresh-pass');
    expect(task!.status).toBe('approved');
    const stale = findInterventionByPhase('stale-verdict-superseded-pass');
    expect(stale).toBeUndefined();
  });

  it('does NOT reject a fresh verdict whose second-granular submitted_at is within the clock-skew budget', async () => {
    // GitHub submitted_at is second-granular; baxian reviewDispatchedAt is ms. A
    // verdict submitted in (or just before) the same wall-clock second as dispatch
    // must NOT be killed by sub-second rounding / minor clock drift.
    await seedReviewPass('task-skew', { reviewDispatchedAt: '2026-05-30T04:03:00.500Z' });
    stubApproveFlow();

    await emitReview('task-skew', {
      action: 'APPROVE',
      prNumber: 214,
      headSha: HEAD_SHA,
      currentHeadSha: HEAD_SHA,
      submittedAt: '2026-05-30T04:03:00Z', // 0.5s before dispatch, within skew budget
    });

    const task = await taskStore.get('task-skew');
    expect(task!.status).toBe('approved');
    const stale = findInterventionByPhase('stale-verdict-superseded-pass');
    expect(stale).toBeUndefined();
  });
});

describe('review.submitted per-pass token gate (binds verdict to the dispatched pass)', () => {
  it('rejects a verdict whose review-pass token does not match the current signalToken', async () => {
    // Old QA pass reviewed the prior code, finished and submitted AFTER a mid-review
    // push re-dispatched (signalToken rotated). Its review body stamps the OLD token;
    // GitHub attributes the verdict to the new head, so the head/time gates miss it —
    // only the stamp catches it.
    await seedReviewPass('task-wrongpass', { signalToken: 'current-token-22' });
    const transitionSpy = vi.spyOn(manager, 'transitionTaskStatus');
    vi.spyOn(manager, 'fetchPrHeadSha').mockResolvedValue(HEAD_SHA);

    await emitReview('task-wrongpass', {
      action: 'APPROVE',
      prNumber: 214,
      headSha: HEAD_SHA,
      currentHeadSha: HEAD_SHA,
      reviewPassToken: 'stale-token-11', // != current signalToken → superseded pass
    });

    const task = await taskStore.get('task-wrongpass');
    expect(task!.status).toBe('review'); // unchanged
    expect(transitionSpy).not.toHaveBeenCalled();
    const wrong = findInterventionByPhase('stale-verdict-wrong-pass');
    expect(wrong).toBeDefined();
  });

  it('accepts a verdict whose review-pass token matches the current signalToken', async () => {
    await seedReviewPass('task-rightpass', { signalToken: 'current-token-22' });
    stubApproveFlow();

    await emitReview('task-rightpass', {
      action: 'APPROVE',
      prNumber: 214,
      headSha: HEAD_SHA,
      currentHeadSha: HEAD_SHA,
      reviewPassToken: 'current-token-22', // matches → fresh
    });

    const task = await taskStore.get('task-rightpass');
    expect(task!.status).toBe('approved');
  });

  it('accepts a verdict with NO review-pass token (e.g. a human review) — verify-if-present', async () => {
    await seedReviewPass('task-notoken', { signalToken: 'current-token-22' });
    stubApproveFlow();

    await emitReview('task-notoken', {
      action: 'APPROVE',
      prNumber: 214,
      headSha: HEAD_SHA,
      currentHeadSha: HEAD_SHA,
      // no reviewPassToken
    });

    const task = await taskStore.get('task-notoken');
    expect(task!.status).toBe('approved');
    const wrong = findInterventionByPhase('stale-verdict-wrong-pass');
    expect(wrong).toBeUndefined();
  });

  it('rejects a stale PANE-fallback verdict whose data.token no longer matches the rotated signalToken', async () => {
    // After a redispatch rotated task.signalToken, an old QA's not-yet-replaced watcher
    // can still fire [bx:pr-approved:<old-token>]. The gate must reject it via data.token,
    // not bind a headSha-less pane verdict to the new reviewHeadAnchorSha.
    await seedReviewPass('task-stale-pane', { signalToken: 'current-token-22' }); // already rotated by the redispatch
    const transitionSpy = vi.spyOn(manager, 'transitionTaskStatus');
    vi.spyOn(manager, 'fetchPrHeadSha').mockResolvedValue(HEAD_SHA);

    await emitReview('task-stale-pane', {
      kind: 'pr-approved',
      action: 'APPROVE',
      verdictAgentId: 'qa-1',
      source: 'pane-signal',
      token: 'stale-token-11', // old watcher's token != current signalToken
    });

    const task = await taskStore.get('task-stale-pane');
    expect(task!.status).toBe('review'); // not approved
    expect(transitionSpy).not.toHaveBeenCalled();
    const wrong = findInterventionByPhase('stale-verdict-wrong-pass');
    expect(wrong).toBeDefined();
    expect(wrong!.data.source).toBe('pane-signal');
  });

  it('accepts a PANE-fallback verdict whose data.token matches the current signalToken (legit same-identity)', async () => {
    await seedReviewPass('task-legit-pane', { signalToken: 'current-token-22' });
    stubApproveFlow();

    await emitReview('task-legit-pane', {
      kind: 'pr-approved',
      action: 'APPROVE',
      verdictAgentId: 'qa-1',
      source: 'pane-signal',
      token: 'current-token-22', // matches current pass → accept
    });

    const task = await taskStore.get('task-legit-pane');
    expect(task!.status).toBe('approved');
  });
});

describe('review.submitted REQUEST_CHANGES', () => {
  it('merge-ready → fixing on REQUEST_CHANGES (formal re-open after ready)', async () => {
    await seedTask({ id: 'task-mr-rc', status: 'merge-ready', reviewRound: 1, prNumber: 31, qaAgentId: 'qa-1' });
    const { continueSession: continueSpy } = stubManager({ releaseAgentForTask: true, acquireAgentForTask: true, continueSession: true });

    await emitReview('task-mr-rc', { action: 'REQUEST_CHANGES', prNumber: 31 });

    const task = await taskStore.get('task-mr-rc');
    expect(task!.status).toBe('fixing');
    expect(task!.reviewRound).toBe(2);
    expect(continueSpy).toHaveBeenCalledWith('task-mr-rc', 'dev-1', 'fix');
  });

  it('within rounds → fixing + reviewRound++ + continueSession + releaseAgentForTask QA', async () => {
    await seedTask({ id: 'task-r1', status: 'review', reviewRound: 1, prNumber: 30, qaAgentId: 'qa-1' });
    const { releaseAgentForTask: stopSpy, continueSession: continueSpy } = stubManager({ releaseAgentForTask: true, continueSession: true });

    await emitReview('task-r1', { action: 'REQUEST_CHANGES', prNumber: 30 });

    const task = await taskStore.get('task-r1');
    expect(task!.status).toBe('fixing');
    expect(task!.reviewRound).toBe(2);
    expect(stopSpy).toHaveBeenCalledWith('qa-1', 'task-r1', 'idle', { allowAwaitingHuman: true });
    expect(continueSpy).toHaveBeenCalledWith('task-r1', 'dev-1', 'fix');
  });

  it('approved + REQUEST_CHANGES clears post-approve token and dispatches dev fix', async () => {
    await seedTask({ id: 'task-r-approved', status: 'approved', reviewRound: 1, prNumber: 35, qaAgentId: 'qa-1' });
    await manager.setPostApproveCompletion('task-r-approved', { token: 'stale-post-token', approvedHeadSha: HEAD_SHA });
    const { releaseAgentForTask: releaseSpy, acquireAgentForTask: acquireSpy, continueSession: continueSpy } = stubManager({ releaseAgentForTask: true, acquireAgentForTask: true, continueSession: true });

    await emitReview('task-r-approved', { action: 'REQUEST_CHANGES', prNumber: 35 });

    const task = await taskStore.get('task-r-approved');
    expect(task!.status).toBe('fixing');
    expect(task!.reviewRound).toBe(2);
    await expect(manager.getPostApproveCompletion('task-r-approved')).resolves.toBeNull();
    expect(releaseSpy).toHaveBeenCalledWith(
      'dev-1',
      'task-r-approved',
      'waiting',
    );
    expect(acquireSpy).toHaveBeenCalledWith('dev-1', 'task-r-approved', 'fix');
    expect(continueSpy).toHaveBeenCalledWith('task-r-approved', 'dev-1', 'fix');
  });

  it('approved + REQUEST_CHANGES leaves task approved when dev cannot be interrupted for fix', async () => {
    await seedTask({ id: 'task-r-approved-gate-fail', status: 'approved', reviewRound: 1, prNumber: 36, qaAgentId: 'qa-1' });
    await manager.setPostApproveCompletion('task-r-approved-gate-fail', { token: 'stale-post-token', approvedHeadSha: HEAD_SHA });
    const { acquireAgentForTask: acquireSpy, continueSession: continueSpy } = stubManager({ releaseAgentForTask: false, acquireAgentForTask: true, continueSession: true });

    await emitReview('task-r-approved-gate-fail', { action: 'REQUEST_CHANGES', prNumber: 36 });

    const task = await taskStore.get('task-r-approved-gate-fail');
    expect(task!.status).toBe('approved');
    expect(task!.reviewRound).toBe(1);
    await expect(manager.getPostApproveCompletion('task-r-approved-gate-fail')).resolves.toEqual(
      expect.objectContaining({
        token: 'stale-post-token',
        approvedHeadSha: HEAD_SHA,
      }),
    );
    expect(acquireSpy).not.toHaveBeenCalled();
    expect(continueSpy).not.toHaveBeenCalled();
    const intervention = findIntervention('task-r-approved-gate-fail');
    expect(intervention).toBeTruthy();
    expect(intervention!.data.phase).toBe('post-approve-dev-wait-gate-failed-before-fix');
  });

  // A stale REQUEST_CHANGES (verdict reviewed an older head) on an approved task is rejected:
  // approval + round + active token preserved, no dev/QA dispatch, and it can never push an
  // approved newer head into max_rounds even at the round cap.
  it.each([
    ['for an older head preserves approval and active token', 'task-r-approved-stale', 1, 37, false],
    ['cannot move an approved newer head to max_rounds', 'task-r-approved-stale-max', 3, 38, true],
  ])('stale approved REQUEST_CHANGES %s', async (_label, id, reviewRound, prNumber, atCap) => {
    await seedTask({ id, status: 'approved', reviewRound, prNumber, qaAgentId: 'qa-1' });
    await manager.setPostApproveCompletion(id, { token: 'active-post-token', approvedHeadSha: NEXT_HEAD_SHA });
    const { releaseAgentForTask: releaseSpy, acquireAgentForTask: acquireSpy, continueSession: continueSpy } = stubManager({ releaseAgentForTask: true, acquireAgentForTask: true, continueSession: true });

    await emitReview(id, { action: 'REQUEST_CHANGES', prNumber, headSha: HEAD_SHA, currentHeadSha: NEXT_HEAD_SHA });

    const task = await taskStore.get(id);
    expect(task!.status).toBe('approved');
    expect(task!.reviewRound).toBe(reviewRound);
    await expect(manager.getPostApproveCompletion(id)).resolves.toEqual(
      expect.objectContaining({ token: 'active-post-token', approvedHeadSha: NEXT_HEAD_SHA }),
    );
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(acquireSpy).not.toHaveBeenCalled();
    expect(continueSpy).not.toHaveBeenCalled();
    if (atCap) expect(emittedEvents.some(e => e.type === 'review.max_rounds')).toBe(false);
    const intervention = findIntervention(id);
    expect(intervention).toBeTruthy();
    expect(intervention!.data.phase).toBe('stale-request-changes-head-mismatch');
  });

  it('qa-release-failed-but-dev-dispatched: QA release returns false → still dispatch dev fix + emit intervention', async () => {
    await seedTask({ id: 'task-r-rel-fail', status: 'review', reviewRound: 1, prNumber: 33, qaAgentId: 'qa-1' });
    const { continueSession: continueSpy } = stubManager({ releaseAgentForTask: false, continueSession: true });

    await emitReview('task-r-rel-fail', { action: 'REQUEST_CHANGES', prNumber: 33 });

    expect(continueSpy).toHaveBeenCalledWith('task-r-rel-fail', 'dev-1', 'fix');
    const intervention = findIntervention('task-r-rel-fail');
    expect(intervention).toBeTruthy();
    expect(intervention!.data.phase).toBe('qa-release-failed-but-dev-dispatched');
    expect(intervention!.data.qaAgentId).toBe('qa-1');
  });

  it('continueSession failure does NOT roll back fixing status', async () => {
    await seedTask({ id: 'task-r2', status: 'review', reviewRound: 1, prNumber: 31, qaAgentId: 'qa-1' });
    vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    vi.spyOn(manager, 'continueSession').mockRejectedValue(new Error('dev tmux dead'));

    await emitReview('task-r2', { action: 'REQUEST_CHANGES', prNumber: 31 });

    const task = await taskStore.get('task-r2');
    expect(task!.status).toBe('fixing');
    expect(task!.reviewRound).toBe(2);
  });

  it('continueSession returns false (dev unresumable) → emit human.intervention + markAgentWaiting rollback', async () => {
    await seedTask({ id: 'task-r2b', status: 'review', reviewRound: 1, prNumber: 311, qaAgentId: 'qa-1' });
    const { markAgentWaiting: markWaitSpy } = stubManager({ releaseAgentForTask: true, continueSession: false, markAgentWaiting: true });

    await emitReview('task-r2b', { action: 'REQUEST_CHANGES', prNumber: 311 });

    const task = await taskStore.get('task-r2b');
    expect(task!.status).toBe('fixing');
    const intervention = findIntervention('task-r2b');
    expect(intervention).toBeTruthy();
    expect(intervention!.data.phase).toBe('fix-resume-failed');
    expect(markWaitSpy).toHaveBeenCalledWith('dev-1', 'task-r2b');
  });

  it('honors live config: manager.replaceConfig lowering rounds takes effect on the very next REQUEST_CHANGES', async () => {
    // PATCH /config rounds=10 → 1 must NOT require a server restart. Issue #167 regression:
    // handlers used to close over the initial config at boot time; if they still do, this
    // test fails because the captured rounds=3 would let round-2 continue instead of capping.
    await seedTask({ id: 'task-rounds-live', status: 'review', reviewRound: 1, prNumber: 77, qaAgentId: 'qa-1' });
    stubManager({ releaseAgentForTask: true, continueSession: true });

    manager.replaceConfig({ ...CONFIG, review: { rounds: 1 } });

    await emitReview('task-rounds-live', { action: 'REQUEST_CHANGES', prNumber: 77 });

    const task = await taskStore.get('task-rounds-live');
    expect(task!.status).toBe('max_rounds');
  });

  it('exceeds rounds → max_rounds + emit review.max_rounds', async () => {
    await seedTask({ id: 'task-r3', status: 'review', reviewRound: 3, prNumber: 32, qaAgentId: 'qa-1' });
    // QA bound to the task (it was reviewing) → release path runs.
    await agentStore.set({ id: 'qa-1', projectId: 'proj', status: 'running', taskId: 'task-r3', paneId: '%2', updatedAt: new Date().toISOString() });
    const { releaseAgentForTask: stopSpy, continueSession: continueSpy } = stubManager({ releaseAgentForTask: true, continueSession: true });

    await emitReview('task-r3', { action: 'REQUEST_CHANGES', prNumber: 32 });

    const task = await taskStore.get('task-r3');
    expect(task!.status).toBe('max_rounds');
    // QA released via the outcome path (allowAwaitingHuman, so a Held QA whose verdict arrived is releasable).
    expect(stopSpy).toHaveBeenCalledWith('qa-1', 'task-r3', 'idle', { allowAwaitingHuman: true });
    expect(continueSpy).not.toHaveBeenCalled();
    // code-phase pause: dev is RETAINED (reserved with its worktree), only QA is released.
    expect(stopSpy).not.toHaveBeenCalledWith('dev-1', 'task-r3', 'idle');
    expect(stopSpy).not.toHaveBeenCalledWith('dev-1', 'task-r3', 'idle', { allowAwaitingHuman: true });
    // F4: the released QA's stale id is cleared so a later QA failure can't false-fail this paused task.
    expect(task!.qaAgentId).toBeUndefined();

    const maxEvent = emittedEvents.find(e => e.type === 'review.max_rounds');
    expect(maxEvent).toBeTruthy();
    expect(maxEvent!.taskId).toBe('task-r3');
  });

  // G1: if the QA release is REFUSED (e.g. still bound/held and the gate declines), the stale
  // qaAgentId must NOT be cleared — keep the reference so a later Cancel/Complete can reclaim it.
  it('exceeds rounds → does NOT clear qaAgentId when the QA release is refused', async () => {
    await seedTask({ id: 'task-r3b', status: 'review', reviewRound: 3, prNumber: 33, qaAgentId: 'qa-1' });
    // QA still bound (held) → release path runs but is refused → keep the reference.
    await agentStore.set({ id: 'qa-1', projectId: 'proj', status: 'awaiting_human', taskId: 'task-r3b', paneId: '%2', updatedAt: new Date().toISOString() });
    stubManager({ releaseAgentForTask: false, continueSession: true });

    await emitReview('task-r3b', { action: 'REQUEST_CHANGES', prNumber: 33 });

    const task = await taskStore.get('task-r3b');
    expect(task!.status).toBe('max_rounds');
    expect(task!.qaAgentId).toBe('qa-1');
  });

  // I1: REQUEST_CHANGES can hit the cap from merge-ready/approved, where the APPROVE path already
  // released the QA WITHOUT clearing qaAgentId. The stale id must still be cleared at max_rounds so
  // the released QA's later failure can't false-fail this paused (active) task.
  it('merge-ready → max_rounds clears the stale qaAgentId of an already-released QA', async () => {
    await seedTask({ id: 'task-mr-cap', status: 'merge-ready', reviewRound: 3, prNumber: 34, qaAgentId: 'qa-1' });
    // QA already released by the approve path: unbound (no taskId).
    await agentStore.set({ id: 'qa-1', projectId: 'proj', status: 'idle', paneId: '%2', updatedAt: new Date().toISOString() });

    await emitReview('task-mr-cap', { action: 'REQUEST_CHANGES', prNumber: 34 });

    const task = await taskStore.get('task-mr-cap');
    expect(task!.status).toBe('max_rounds');
    expect(task!.qaAgentId).toBeUndefined();
  });

  it('max_rounds emit failure → handler swallows emit error', async () => {
    await seedTask({ id: 'task-r4', status: 'review', reviewRound: 3, prNumber: 33, qaAgentId: 'qa-1' });
    vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    const realEmit = eventBus.emit.bind(eventBus);
    vi.spyOn(eventBus, 'emit').mockImplementation(async (evt) => {
      if (evt.type === 'review.max_rounds') throw new Error('emit failed');
      return realEmit(evt);
    });

    await expect(emitReview('task-r4', { action: 'REQUEST_CHANGES', prNumber: 33 })).resolves.not.toThrow();

    const task = await taskStore.get('task-r4');
    expect(task!.status).toBe('max_rounds');
  });

  it('cancelled task → no-op', async () => {
    await seedTask({ id: 'task-r-cx', status: 'cancelled', prNumber: 34 });
    const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);

    await emitReview('task-r-cx', { action: 'REQUEST_CHANGES', prNumber: 34 });

    expect(continueSpy).not.toHaveBeenCalled();
  });
});

describe('review.submitted late-review catch-up', () => {
  it('in_progress + event prNumber → catch-up to review then APPROVE → approved', async () => {
    await seedTask({ id: 'task-late1', status: 'in_progress', reviewRound: 0, prNumber: undefined });
    await seedDevAgent('task-late1');
    const { markAgentWaiting: markWaitSpy } = stubManager({ markAgentWaiting: true, releaseAgentForTask: true, acquireAgentForTask: true, continueSession: true, mergePr: undefined });

    await emitReview('task-late1', { action: 'APPROVE', prNumber: 99, headSha: HEAD_SHA });

    const task = await taskStore.get('task-late1');
    expect(task!.status).toBe('approved');
    expect(task!.prNumber).toBe(99);
    expect(markWaitSpy).toHaveBeenCalledWith('dev-1', 'task-late1');
  });

  it('fixing + event prNumber + REQUEST_CHANGES → catch-up to review then fixing again', async () => {
    await seedTask({ id: 'task-late2', status: 'fixing', reviewRound: 1, prNumber: 50, qaAgentId: 'qa-1' });
    await seedDevAgent('task-late2');
    const { continueSession: continueSpy } = stubManager({ markAgentWaiting: true, releaseAgentForTask: true, continueSession: true });

    await emitReview('task-late2', { action: 'REQUEST_CHANGES', prNumber: 50 });

    const task = await taskStore.get('task-late2');
    expect(task!.status).toBe('fixing');
    expect(task!.reviewRound).toBe(2);
    expect(continueSpy).toHaveBeenCalledWith('task-late2', 'dev-1', 'fix');
  });

  it('in_progress + event has NO prNumber → no catch-up, no transition', async () => {
    await seedTask({ id: 'task-late3', status: 'in_progress', reviewRound: 0, prNumber: undefined });
    const stopSpy = vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);

    await emitReview('task-late3', { action: 'APPROVE', headSha: HEAD_SHA });

    const task = await taskStore.get('task-late3');
    expect(task!.status).toBe('in_progress');
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('catch-up sees terminal task → return early (no APPROVE/REQUEST_CHANGES path)', async () => {
    await seedTask({ id: 'task-late4', status: 'cancelled' });
    const { releaseAgentForTask: stopSpy, mergePr: mergeSpy } = stubManager({ releaseAgentForTask: true, mergePr: undefined });

    await emitReview('task-late4', { action: 'APPROVE', prNumber: 60, headSha: HEAD_SHA });

    expect(stopSpy).not.toHaveBeenCalled();
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  it('event prNumber overrides task.prNumber when both present', async () => {
    await seedTask({ id: 'task-late5', status: 'review', reviewRound: 1, prNumber: 10 });
    stubManager({ releaseAgentForTask: true, acquireAgentForTask: true, continueSession: true, mergePr: undefined });

    await emitReview('task-late5', { action: 'APPROVE', prNumber: 11, headSha: NEXT_HEAD_SHA });

    const task = await taskStore.get('task-late5');
    expect(task!.prNumber).toBe(11);
  });
});

describe('event-driven release does not interrupt agent mid-action', () => {
  // Regression: PR webhook → release path must not send C-c to a busy dev pane.
  it('review.submitted REQUEST_CHANGES on approved task with busy dev pane: no C-c, dev binding preserved through waiting release', async () => {
    await seedTask({ id: 'task-busy-redispatch', status: 'approved', reviewRound: 1, prNumber: 113, latestHeadSha: HEAD_SHA, qaAgentId: 'qa-1' });
    await seedDevAgent('task-busy-redispatch');
    await lockManager.acquire('dev-1');

    const sentCommands: string[] = [];
    (mockRunner.exec as ReturnType<typeof vi.fn>).mockImplementation(
      async (cmd: string): Promise<ExecResult> => {
        sentCommands.push(cmd);
        if (cmd.includes('send-keys')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('gh pr view') && cmd.includes('--json headRefOid')) {
          return { stdout: `${HEAD_SHA}\n`, stderr: '', exitCode: 0 };
        }
        if (cmd.includes('display-message') && cmd.includes('pane_current_command')) {
          return { stdout: 'claude\n', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          return {
            stdout: 'Tool use: Bash\nRunning gh pr comment on PR #113...\n',
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    );

    const { acquireAgentForTask: acquireSpy, continueSession: continueSpy } = stubManager({ acquireAgentForTask: true, continueSession: true });

    await emitReview('task-busy-redispatch', { action: 'REQUEST_CHANGES', prNumber: 113, headSha: HEAD_SHA });

    const cCancelKeys = sentCommands.filter(
      cmd => cmd.includes('send-keys') && cmd.includes('C-c'),
    );
    expect(cCancelKeys).toHaveLength(0);

    const task = await taskStore.get('task-busy-redispatch');
    expect(task!.status).toBe('fixing');
    expect(task!.reviewRound).toBe(2);

    const devState = await agentStore.get('dev-1');
    expect(devState?.taskId).toBe('task-busy-redispatch');
    expect(await lockManager.isLocked('dev-1')).toBe(true);

    const interrupts = emittedEvents.filter(
      e => e.type === 'human.intervention'
        && typeof (e.data as { phase?: string }).phase === 'string'
        && /interrupt|cancel|ctrl-c/i.test((e.data as { phase: string }).phase),
    );
    expect(interrupts).toHaveLength(0);

    expect(acquireSpy).toHaveBeenCalledWith('dev-1', 'task-busy-redispatch', 'fix');
    expect(continueSpy).toHaveBeenCalledWith('task-busy-redispatch', 'dev-1', 'fix');
  });

  it('REQUEST_CHANGES on approved + post-approve completion still active: emits intervention + skips fix dispatch (avoid prompt collision)', async () => {
    // Dev still running post-approve check; release(waiting) just bumps updatedAt → fix prompt would land in the busy pane.
    await seedTask({ id: 'task-postapprove-busy', status: 'approved', reviewRound: 1, prNumber: 200, latestHeadSha: HEAD_SHA, qaAgentId: 'qa-1' });
    await seedDevAgent('task-postapprove-busy');
    await lockManager.acquire('dev-1');
    await manager.setPostApproveCompletion('task-postapprove-busy', { token: 'tok-pa', approvedHeadSha: HEAD_SHA });

    const { acquireAgentForTask: acquireSpy, continueSession: continueSpy, releaseAgentForTask: releaseSpy } = stubManager({ acquireAgentForTask: true, continueSession: true, releaseAgentForTask: true });

    await emitReview('task-postapprove-busy', { action: 'REQUEST_CHANGES', prNumber: 200, headSha: HEAD_SHA });

    // fix dispatch 必须跳过——既不 release(waiting) 也不 acquire(fix) 也不 continueSession(fix)
    expect(releaseSpy).not.toHaveBeenCalledWith('dev-1', 'task-postapprove-busy', 'waiting');
    expect(acquireSpy).not.toHaveBeenCalled();
    expect(continueSpy).not.toHaveBeenCalled();

    // task 保持 approved (transition 没发生)
    const task = await taskStore.get('task-postapprove-busy');
    expect(task!.status).toBe('approved');

    // intervention 已 emit
    const intervention = findInterventionByPhase('request-changes-during-post-approve');
    expect(intervention).toBeTruthy();

    // PostApproveCompletion must clear, else signal completion + pendingRedispatch=false would auto-merge despite the REQUEST_CHANGES.
    const completionAfter = await manager.getPostApproveCompletion('task-postapprove-busy');
    expect(completionAfter).toBeNull();
  });
});
