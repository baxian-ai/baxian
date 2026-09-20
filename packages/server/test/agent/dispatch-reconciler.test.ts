import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AgentBindingFacts, BaxianEvent, TaskState } from '../../src/shared/index.js';
import { REVIEW_VERDICT_TIMEOUT_MS, taskAttentionGeneration } from '../../src/shared/index.js';
import type { AgentManager, AgentManagerDeps } from '../../src/agent/manager.js';
import { DispatchReconciler } from '../../src/agent/dispatch-reconciler.js';
import { PhaseSignalWatcher } from '../../src/agent/phase-signal-watcher.js';
import type { PaneStreamerManager } from '../../src/agent/pane-streamer-manager.js';
import type { SubscriberCallbacks } from '../../src/agent/pane-streamer.js';
import { TmuxSessionStatusStore, type TmuxSessionObservation } from '../../src/agent/tmux-probe-poller.js';
import { BranchManager } from '../../src/agent/branch.js';
import type { FakeRunnerOptions } from '../helpers/fake-runner.js';
import { createManagerSuiteRunner, useManagerSuiteHarness, workdirsOf } from '../helpers/manager-harness.js';

const NOW = '2026-07-19T00:00:00Z';
const SHA = 'a'.repeat(40);
const QA_PANE = '%1';
const DEV_PANE = '%0';
const CODEX_WORKING = '• Working (3s • esc to interrupt)\n';

const harness = useManagerSuiteHarness();
let statusStore: TmuxSessionStatusStore;

beforeEach(() => {
  statusStore = new TmuxSessionStatusStore();
});

// 平台/gh 边界替身(E3),与 suite harness 对 harness.manager 的注入等价;自建 manager 才需要重新装上
function useManager(overrides: Partial<AgentManagerDeps> = {}): AgentManager {
  const manager = harness.createManager(overrides);
  vi.spyOn(manager, 'platformVerifyPrBinding').mockResolvedValue({
    ok: true, prUrl: 'https://github.com/user/repo/pull/42', headSha: SHA, branch: 'bx/task-1', targetBranch: 'main',
  });
  harness.manager = manager;
  return manager;
}

// 带交错钩子的 live runner:装回 harness 后 pastedPrompts/exec 轨迹仍从同一处读
function useRunner(options: FakeRunnerOptions = {}) {
  const workdirs = workdirsOf(harness.config);
  harness.runner = createManagerSuiteRunner({ workdirs, ...options });
  return harness.runner;
}

function mkReconciler(over: { busyWaitBudgetMs?: number; maxAttempts?: number } = {}): DispatchReconciler {
  return new DispatchReconciler({
    manager: harness.manager,
    taskStore: harness.taskStore,
    agentStore: harness.agentStore,
    statusStore,
    eventBus: harness.eventBus,
    intervalMs: 1000,
    busyWaitBudgetMs: over.busyWaitBudgetMs ?? 30 * 60 * 1000,
    maxAttempts: over.maxAttempts ?? 3,
  });
}

async function seedTask(over: Partial<TaskState> = {}): Promise<TaskState> {
  const phase = Object.hasOwn(over, 'phase') ? over.phase : 'code';
  return harness.seedTask({
    id: 'task-1',
    prNumber: 7,
    status: 'review',
    phase,
    reviewRound: 2,
    signalToken: 'tok-current1',
    reviewHeadAnchorSha: SHA,
    latestHeadSha: SHA,
    reviewDispatchedAt: new Date().toISOString(),
    fixDispatchedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...(phase === undefined ? {} : { deliveryConfirmation: { phase, source: 'signal', at: NOW } }),
    ...over,
  });
}

// 已经有 pending lease 的 review 任务:补派不再轮换令牌,失败让权后 lease 原样退回
async function seedTaskWithPendingLease(over: Partial<TaskState> = {}): Promise<TaskState> {
  const task = await seedTask({
    signalToken: 'ffff00001111', passToken: 'abcdef123456', failToken: '123456abcdef', ...over,
  });
  const withLease: TaskState = {
    ...task,
    reviewDispatch: {
      generation: 'decafdecaf12', phase: 'pending', qaPhase: 'recheck', signalToken: task.signalToken!,
      headSha: SHA, passToken: 'abcdef123456', failToken: '123456abcdef', effectiveRound: 2, updatedAt: NOW,
    },
  };
  await harness.taskStore.set(withLease);
  return withLease;
}

const seedQa = (over: Partial<AgentBindingFacts> = {}): Promise<void> =>
  harness.seedAgent({ id: 'qa-1', taskId: 'task-1', paneId: QA_PANE, startedAt: NOW, ...over });

// 绑定在,但没有任务锁:释放与派发都会在锁复核处真实拒绝
const seedQaWithoutTaskLock = (over: Partial<AgentBindingFacts> = {}): Promise<void> =>
  harness.agentStore.set({
    id: 'qa-1', projectId: 'proj', taskId: 'task-1', workdir: '/tmp/qa-repo', paneId: QA_PANE,
    startedAt: NOW, updatedAt: NOW, ...over,
  } as AgentBindingFacts);

const seedDev = (over: Partial<AgentBindingFacts> = {}): Promise<void> =>
  harness.seedAgent({ id: 'dev-1', taskId: 'task-1', paneId: DEV_PANE, startedAt: NOW, ...over });

function freshObservedAt(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

function obs(over: Partial<TmuxSessionObservation> = {}): void {
  statusStore.set('qa-1', { tmuxSessionStatus: 'present', observedAt: freshObservedAt(), ...over });
}

function devObs(over: Partial<TmuxSessionObservation> = {}): void {
  statusStore.set('dev-1', { tmuxSessionStatus: 'present', observedAt: freshObservedAt(), ...over });
}

const cmds = (): string[] => harness.runner.exec.mock.calls.map(call => call[0] as string);
const paneCmds = (pane: string): string[] => cmds().filter(command => command.includes(pane));
const pastesTo = (pane: string) => harness.runner.pastedPrompts.filter(prompt => prompt.pane === pane);
const qaPastes = () => pastesTo(QA_PANE);
const devPastes = () => pastesTo(DEV_PANE);

function interventions(): BaxianEvent[] {
  return harness.events.filter(e => e.type === 'human.intervention');
}

function phasesOf(events: BaxianEvent[]): unknown[] {
  return events.map(e => (e.data as { phase?: unknown }).phase);
}

function audits(): BaxianEvent[] {
  return harness.events.filter(e => e.type === 'agent.recovered'
    && (e.data as { reason?: string }).reason === 'dispatch-reconciled');
}

const taskNow = (id = 'task-1') => harness.taskStore.get(id);
const qaNow = () => harness.agentStore.get('qa-1');

describe('DispatchReconciler attention and manual reset', () => {
  it('retries a durable code-verdict outbox on every reconciliation cycle', async () => {
    await seedTask({
      passToken: '111111111111',
      failToken: '222222222222',
      outbox: [{
        key: '111111111111',
        type: 'git.code-verdict',
        data: { prNumber: 7, kind: 'pass', anchorSha: SHA, token: '111111111111', comments: '' },
      }],
    });
    await seedQa();
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    const deliver = vi.spyOn(harness.manager, 'deliverTaskOutbox').mockResolvedValue();
    const reconciler = mkReconciler();

    await reconciler.pollOnce();
    await reconciler.pollOnce();

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenNthCalledWith(1, 'task-1');
    expect(deliver).toHaveBeenNthCalledWith(2, 'task-1');
    expect(qaPastes()).toEqual([]);
    expect((await taskNow())?.signalToken).toBe('tok-current1');
  });

  it('does not replace a human verdict generation while its QA binding is absent', async () => {
    await seedTask({
      passToken: '111111111111',
      failToken: '222222222222',
      outbox: [{
        key: '111111111111',
        type: 'git.code-verdict',
        data: {
          prNumber: 7, kind: 'pass', anchorSha: SHA, token: '111111111111', comments: '', writeAttemptedAt: NOW,
        },
      }],
    });
    await seedQa({ taskId: undefined });
    const deliver = vi.spyOn(harness.manager, 'deliverTaskOutbox').mockResolvedValue();
    const reconciler = mkReconciler();

    await reconciler.pollOnce();
    await reconciler.pollOnce();

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(qaPastes()).toEqual([]);
    expect((await taskNow())?.signalToken).toBe('tok-current1');
  });

  it('emits a persistent-attention source event when a review verdict is overdue', async () => {
    await seedTask({
      reviewDispatchedAt: new Date(Date.now() - REVIEW_VERDICT_TIMEOUT_MS - 60_000).toISOString(),
    });
    await seedQa();

    await mkReconciler().pollOnce();

    expect(interventions()).toContainEqual(expect.objectContaining({
      taskId: 'task-1',
      data: expect.objectContaining({
        phase: 'review-verdict-overdue',
        note: expect.stringContaining('Advance to re-dispatch QA'),
      }),
    }));
  });

  it('does not overwrite an existing attention with a recurring overdue alert', async () => {
    const task = await seedTask({
      reviewDispatchedAt: new Date(Date.now() - REVIEW_VERDICT_TIMEOUT_MS - 60_000).toISOString(),
    });
    await harness.taskStore.set({
      ...task,
      attention: {
        reason: 'platform-binding-mismatch',
        runbook: 'Restore the configured repository binding.',
        occurredAt: new Date().toISOString(),
        recommendedActions: ['cancel'],
        generation: taskAttentionGeneration(task),
      },
    });
    await seedQa();

    await mkReconciler().pollOnce();

    expect(interventions()).toEqual([]);
  });

  it('does not recommend an unavailable human verdict while spec QA is overdue', async () => {
    await seedTask({
      phase: 'spec',
      reviewDispatchedAt: new Date(Date.now() - REVIEW_VERDICT_TIMEOUT_MS - 60_000).toISOString(),
    });
    await seedQa();

    await mkReconciler().pollOnce();

    const alert = interventions().find(event => event.data.phase === 'review-verdict-overdue');
    expect(alert?.data.note).toContain('Advance to re-dispatch QA');
    expect(alert?.data.note).not.toContain('human verdict');
  });

  it('surfaces an idle in_progress delivery as an actionable intervention', async () => {
    await seedTask({
      status: 'in_progress',
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await seedDev();
    devObs({ paneState: 'live-runtime', runtimeStatusHint: 'pending', reason: 'PENDING_IDLE', observedAt: new Date().toISOString() });

    await mkReconciler().pollOnce();

    expect(interventions()).toContainEqual(expect.objectContaining({
      data: expect.objectContaining({
        phase: 'initial-dispatch-stalled',
        note: expect.stringContaining('Advance with Dev'),
      }),
    }));
  });

  it('manual reset clears trackers and restarts the pending busy budget', async () => {
    const task = await seedTask();
    harness.manager.registerPendingDispatchRetry(task.id, {
      kind: 'qa-recheck',
      agentId: 'qa-1',
      signalToken: task.signalToken!,
    }, { since: 1, budgetAlerted: true });
    const reconciler = mkReconciler();

    reconciler.resetTask(task.id);

    expect(harness.manager.getPendingDispatchRetry(task.id)).toMatchObject({
      budgetAlerted: undefined,
      since: expect.any(Number),
    });
    expect(harness.manager.getPendingDispatchRetry(task.id)!.since).toBeGreaterThan(1);
  });
});

describe('DispatchReconciler review 侧补派', () => {
  it('review 任务缺少 QA 时明确报告不变量破坏', async () => {
    const task = await seedTask();
    vi.spyOn(harness.taskStore, 'list').mockResolvedValue([{ ...task, qaAgentId: undefined }]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await mkReconciler().pollOnce();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('reconcile failed'),
      expect.objectContaining({ message: expect.stringContaining('no QA participant') }),
    );
  });

  it('pending qa-recheck + 探测非忙 → 按当前 pass 令牌补派（bumpRound:false）并留审计', async () => {
    const t = await seedTask();
    await seedQa();
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    obs();

    await mkReconciler().pollOnce();

    const after = (await taskNow())!;
    expect(after.signalToken).not.toBe('tok-current1');
    expect(after.reviewRound).toBe(2);
    expect(after.reviewRoundPending).toBeUndefined();
    expect(qaPastes()).toEqual([{ pane: QA_PANE, body: expect.stringContaining(`token: ${after.signalToken}`) }]);
    expect(qaPastes()[0]!.body).toContain('phase: recheck');
    expect((await qaNow())?.taskId).toBe(t.id);
    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeUndefined();
    expect(audits()).toHaveLength(1);
    expect(interventions()).toHaveLength(0);
  });

  it('pending qa-recheck 补派时释放阶段 QA 仍忙（同代重排、lease 退回 pending）→ 保留登记与预算，不写 recovered 审计', async () => {
    useManager({ cleanComposerWaitMs: 20 });
    const t = await seedTaskWithPendingLease();
    await seedQa();
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken!, qaPhase: 'recheck' });
    const before = harness.manager.getPendingDispatchRetry(t.id)!;
    obs();
    harness.runner.sessions.markWorking('qa-1', CODEX_WORKING);

    await mkReconciler().pollOnce();

    expect(qaPastes()).toEqual([]);
    expect((await taskNow())?.reviewDispatch?.phase).toBe('pending');
    expect(harness.manager.getPendingDispatchRetry(t.id)).toMatchObject({
      kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken, since: before.since,
    });
    const qa = await qaNow();
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.status).toBeUndefined();
    expect(audits()).toHaveLength(0);
    expect(interventions()).toHaveLength(0);
  });

  it('让权回 pending 后被外部新 pass 接管 → 旧 pass 的失败次数不挂到 successor', async () => {
    useManager({ cleanComposerWaitMs: 20 });
    const t = await seedTaskWithPendingLease();
    await seedQa();
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken!, qaPhase: 'recheck' });
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    harness.runner.sessions.markWorking('qa-1', CODEX_WORKING);
    const rec = mkReconciler({ maxAttempts: 2 });

    await rec.pollOnce();
    expect((await taskNow())?.reviewDispatch?.phase).toBe('pending');

    const successor = await harness.manager.beginGitReviewPass(t.id, {
      fromStatus: ['review'], headSha: 'b'.repeat(40), bumpRound: false, patch: { latestHeadSha: 'b'.repeat(40) },
    });
    expect(successor?.task.signalToken).not.toBe(t.signalToken);

    await rec.pollOnce();
    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeUndefined();

    harness.runner.sessions.markWorking('qa-1', CODEX_WORKING);
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    await rec.pollOnce();
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    await rec.pollOnce();

    expect(qaPastes()).toEqual([]);
    expect(phasesOf(interventions())).not.toContain('dispatch-reconcile-attempts-exhausted');
  });

  it('缺相位与令牌的任务不被自动补派——标准入口要求显式 stage 才能重建交付', async () => {
    await seedTask({ phase: undefined, signalToken: undefined });
    await seedQa();
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });

    await mkReconciler().pollOnce();

    expect(qaPastes()).toEqual([]);
    const after = (await taskNow())!;
    expect(after.signalToken).toBeUndefined();
    expect(after.phase).toBeUndefined();
    expect(after.reviewDispatch).toBeUndefined();
  });

  it('pending + 探测忙碌 → 不补派；忙碌超预算发一次性 intervention，不重复', async () => {
    const t = await seedTask();
    await seedQa();
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    obs({ runtimeStatusHint: 'working' });
    const rec = mkReconciler({ busyWaitBudgetMs: 0 });

    await new Promise(r => setTimeout(r, 5));
    await rec.pollOnce();
    await rec.pollOnce();

    expect(qaPastes()).toEqual([]);
    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeTruthy();
    const alerts = interventions();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.data).toMatchObject({ phase: 'dispatch-busy-budget-exhausted', kind: 'qa-recheck' });
  });

  it('pending 令牌与任务当前 pass 不符 → 丢弃登记且不补派', async () => {
    const t = await seedTask({ signalToken: 'tok-successor' });
    await seedQa();
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'tok-stale1' });
    obs();

    await mkReconciler().pollOnce();

    expect(qaPastes()).toEqual([]);
    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeUndefined();
  });

  it.each(['checkout-preparation-failed', 'checkout-cleanup-failed'])(
    'git QA hold（%s）让位 durable sweep，不由 reconciler 重投',
    async (awaitingPhase) => {
      await seedTask();
      await seedQa({ status: 'awaiting_human', awaitingPhase, awaitingSince: NOW });
      obs();

      await mkReconciler().pollOnce();

      expect(qaPastes()).toEqual([]);
      expect(paneCmds(QA_PANE)).toEqual([]);
    },
  );

  it('无 pending 登记（如进程重启后）+ PENDING_IDLE 观察 → 兜底补派；次数达上限后停手并发一次性 intervention', async () => {
    await seedTask();
    await seedQa();
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    const rec = mkReconciler({ maxAttempts: 2 });

    await rec.pollOnce();
    await rec.pollOnce();
    await rec.pollOnce();
    await rec.pollOnce();

    expect(qaPastes()).toHaveLength(2);
    const alerts = interventions();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.data).toMatchObject({ phase: 'dispatch-reconcile-attempts-exhausted' });
  });

  it('带 dispatch-superseded/in-flight code 的 409（并发接管/入口互斥）→ 不计入次数上限', async () => {
    const t = await seedTask({ signalToken: 'ffff00001111', passToken: 'abcdef123456', failToken: '123456abcdef' });
    // 陈旧的 claimed lease:每轮 claimGitReviewDispatch 都以 dispatch-superseded 拒绝
    await harness.taskStore.set({
      ...t,
      reviewDispatch: {
        generation: 'decafdecaf12', phase: 'claimed', claimId: 'c0ffeec0ffee', claimedAt: NOW,
        qaPhase: 'recheck', signalToken: t.signalToken!, headSha: SHA,
        passToken: 'abcdef123456', failToken: '123456abcdef', effectiveRound: 2, updatedAt: NOW,
      },
    });
    await seedQa();
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    const rec = mkReconciler({ maxAttempts: 2 });

    await rec.pollOnce();
    await rec.pollOnce();
    await rec.pollOnce();

    expect(qaPastes()).toEqual([]);
    expect(interventions()).toHaveLength(0);

    // 让权恢复后仍愿意补派:说明前三轮没有消耗次数
    const stale = (await taskNow())!;
    const { claimId: _claimId, claimedAt: _claimedAt, ...lease } = stale.reviewDispatch!;
    await harness.taskStore.set({ ...stale, reviewDispatch: { ...lease, phase: 'pending' } });
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    await rec.pollOnce();

    expect(qaPastes()).toHaveLength(1);
  });

  it('无 code 的持久性 409（跨任务占用/release 失败等）→ 计次并在耗尽后升级 intervention', async () => {
    const t = await seedTask();
    await seedQaWithoutTaskLock();
    await harness.lockManager.acquire('qa-1', 'other-task');
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    const rec = mkReconciler({ maxAttempts: 2 });

    await rec.pollOnce();
    await rec.pollOnce();
    await rec.pollOnce();
    await rec.pollOnce();

    expect(qaPastes()).toEqual([]);
    expect((await taskNow())?.id).toBe(t.id);
    const alerts = interventions();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.data).toMatchObject({ phase: 'dispatch-reconcile-attempts-exhausted' });
  });

  it('spec 阶段复用同一对账入口', async () => {
    await seedTask({ id: 'task-spec', phase: 'spec', specReviewRound: 0 });
    await harness.seedAgent({ id: 'qa-1', taskId: 'task-spec', paneId: QA_PANE, startedAt: NOW });
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });

    await mkReconciler().pollOnce();

    const after = (await taskNow('task-spec'))!;
    expect(after.phase).toBe('spec');
    expect(after.specReviewRound).toBe(0);
    expect(qaPastes()).toEqual([{ pane: QA_PANE, body: expect.stringContaining(`token: ${after.signalToken}`) }]);
    expect(qaPastes()[0]!.body).toContain('phase: review');
  });
});

describe('DispatchReconciler 补派世系与安全门禁', () => {
  it('pending 记录首评相位 + 任务持久化未计轮 intent → 补派携带 qaPhase=review 与 bumpRound=true', async () => {
    const t = await seedTask({ reviewRound: 0, reviewRoundPending: true });
    await seedQa();
    harness.manager.registerPendingDispatchRetry(t.id, {
      kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken!, qaPhase: 'review',
    });
    obs();

    await mkReconciler().pollOnce();

    const after = (await taskNow())!;
    expect(after.reviewRound).toBe(1);
    expect(after.reviewRoundPending).toBeUndefined();
    expect(after.signalToken).not.toBe(t.signalToken);
    expect(qaPastes()).toHaveLength(1);
    expect(qaPastes()[0]!.body).toContain('phase: review');
  });

  it('外部换代重置尝试计数：新 pass 拿全新预算，reconciler 自身补派延续世系', async () => {
    const t = await seedTask();
    await seedQa();
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    const rec = mkReconciler({ maxAttempts: 2 });

    await rec.pollOnce();
    await rec.pollOnce();
    await rec.pollOnce();
    expect(qaPastes()).toHaveLength(2);
    expect(interventions()).toHaveLength(1);

    const fresh = (await taskNow())!;
    await harness.taskStore.set({ ...fresh, signalToken: 'external-rot1', updatedAt: new Date().toISOString() });
    await rec.pollOnce();
    expect(qaPastes()).toHaveLength(3);
    expect((await taskNow())?.id).toBe(t.id);
  });

  it('PENDING_HUMAN（交互式菜单）阻断补派并计入预算告警通道', async () => {
    const t = await seedTask();
    await seedQa();
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_HUMAN' });
    const rec = mkReconciler({ busyWaitBudgetMs: 0 });

    await new Promise(r => setTimeout(r, 5));
    await rec.pollOnce();

    expect(qaPastes()).toEqual([]);
    expect(interventions()).toHaveLength(1);
    expect(interventions()[0]!.data).toMatchObject({ observationReason: 'PENDING_HUMAN' });
  });

  it('观测早于 pending 登记（陈旧 idle）→ 不补派', async () => {
    const t = await seedTask();
    await seedQa();
    obs({ observedAt: new Date(Date.now() - 60_000).toISOString() });
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });

    await mkReconciler().pollOnce();

    expect(qaPastes()).toEqual([]);
    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeTruthy();
  });

  it('intervention 首次落盘失败不锁存告警标志，下一周期重试', async () => {
    const t = await seedTask();
    await seedQa();
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    obs({ runtimeStatusHint: 'working' });
    const emitSpy = vi.spyOn(harness.eventBus, 'emit').mockRejectedValueOnce(new Error('event log write failed'));
    const rec = mkReconciler({ busyWaitBudgetMs: 0 });

    await new Promise(r => setTimeout(r, 5));
    await rec.pollOnce();
    expect(harness.manager.getPendingDispatchRetry(t.id)?.budgetAlerted).toBeUndefined();
    await rec.pollOnce();
    await rec.pollOnce();

    expect(harness.manager.getPendingDispatchRetry(t.id)?.budgetAlerted).toBe(true);
    expect(emitSpy).toHaveBeenCalledTimes(2);
    expect(interventions()).toHaveLength(1);
  });

  it.each([
    ['anchor 缺失', { reviewHeadAnchorSha: undefined }],
    ['anchor 与 head 都缺失', { reviewHeadAnchorSha: undefined, latestHeadSha: undefined }],
  ] as const)('git pending + %s：不经 gh 刷新，由标准派发入口重新锚定', async (_label, over) => {
    const t = await seedTask(over);
    await seedQa();
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    obs();

    await mkReconciler().pollOnce();

    const after = (await taskNow())!;
    expect(qaPastes()).toHaveLength(1);
    expect(after.reviewHeadAnchorSha).toBe(SHA);
    expect(after.latestHeadSha).toBe(SHA);
    expect(qaPastes()[0]!.body).toContain(`anchor-sha: ${SHA}`);
  });

  it('明确 anchor≠head 仍让位 push 事件路径', async () => {
    const t = await seedTask({ latestHeadSha: 'b'.repeat(40) });
    await seedQa();
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    obs();

    await mkReconciler().pollOnce();

    expect(qaPastes()).toEqual([]);
    expect(paneCmds(QA_PANE)).toEqual([]);
    expect((await taskNow())?.signalToken).toBe(t.signalToken);
  });
});

describe('DispatchReconciler 持久化补派的世系与故障恢复', () => {
  it.each([
    ['PANE_PROBE_FAILED', { runtimeStatusHint: 'error' as const, reason: 'PANE_PROBE_FAILED' }],
    ['UNSUPPORTED_FOREGROUND_PROCESS', { runtimeStatusHint: 'error' as const, reason: 'UNSUPPORTED_FOREGROUND_PROCESS', paneState: 'other' as const }],
  ])('%s 观测不可注入 → 不补派，进入预算告警通道', async (_name, over) => {
    const t = await seedTask();
    await seedQa();
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    obs(over);
    const rec = mkReconciler({ busyWaitBudgetMs: 0 });

    await new Promise(r => setTimeout(r, 5));
    await rec.pollOnce();

    expect(qaPastes()).toEqual([]);
    expect(interventions()).toHaveLength(1);
    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeTruthy();
  });

  it('stalled-idle 兜底要求观测晚于本 pass 的 reviewDispatchedAt（换绑残留旧空闲不触发）', async () => {
    await seedTask({ reviewDispatchedAt: new Date(Date.now() + 120_000).toISOString() });
    await seedQa();
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });

    await mkReconciler().pollOnce();

    expect(qaPastes()).toEqual([]);
    expect(paneCmds(QA_PANE)).toEqual([]);
  });

  it('内部重排的预算随 armedToken fence 在登记时注入，since/alerted 延续且不计次', async () => {
    useManager({ cleanComposerWaitMs: 20 });
    const t = await seedTask();
    await seedQa();
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    harness.manager.markPendingDispatchRetryBudgetAlerted(t.id, { agentId: 'qa-1', signalToken: t.signalToken! });
    const original = harness.manager.getPendingDispatchRetry(t.id)!;
    obs();
    harness.runner.sessions.markWorking('qa-1', CODEX_WORKING);
    const rec = mkReconciler({ maxAttempts: 1 });

    await rec.pollOnce();

    const after = harness.manager.getPendingDispatchRetry(t.id)!;
    expect(after.signalToken).not.toBe(t.signalToken);
    expect(after.signalToken).toBe((await taskNow())?.signalToken);
    expect(after.since).toBe(original.since);
    expect(after.budgetAlerted).toBe(true);
    expect(qaPastes()).toEqual([]);
    expect(interventions()).toHaveLength(0);

    harness.runner.sessions.markWorking('qa-1');
    harness.runner.sessions.setProcess('qa-1', 'codex');
    obs();
    await rec.pollOnce();

    expect(qaPastes()).toHaveLength(1);
  });

  it('await 窗口内的外部 successor 登记不被内部重排污染（保留新鲜预算与告警位）', async () => {
    const t = await seedTask();
    let injected = false;
    const runner = useRunner({
      onExec: async (command) => {
        if (injected || !command.includes('paste-buffer')) return;
        injected = true;
        harness.manager.registerPendingDispatchRetry(t.id, {
          kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'external-succ1',
        });
      },
    });
    useManager({ runnerFactory: () => runner });
    await seedQa();
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    harness.manager.markPendingDispatchRetryBudgetAlerted(t.id, { agentId: 'qa-1', signalToken: t.signalToken! });
    const original = harness.manager.getPendingDispatchRetry(t.id)!;
    obs();

    await mkReconciler().pollOnce();

    expect(injected).toBe(true);
    const after = harness.manager.getPendingDispatchRetry(t.id)!;
    expect(after.signalToken).toBe('external-succ1');
    expect(after.since).toBeGreaterThan(original.since);
    expect(after.budgetAlerted).toBeUndefined();
  });

  it('进程重启（无内存登记）+ anchor 缺失 + PENDING_IDLE → 按持久化 intent 补派', async () => {
    await seedTask({
      reviewRound: 0, reviewRoundPending: true,
      reviewHeadAnchorSha: undefined, latestHeadSha: undefined,
    });
    await seedQa();
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });

    await mkReconciler().pollOnce();

    const after = (await taskNow())!;
    expect(after.reviewRound).toBe(1);
    expect(after.reviewRoundPending).toBeUndefined();
    expect(after.reviewHeadAnchorSha).toBe(SHA);
    expect(qaPastes()).toHaveLength(1);
    expect(qaPastes()[0]!.body).toContain('phase: review');
  });

  it('预算告警落盘窗口内换代 → 标记只落在原登记代，successor 不受污染', async () => {
    const t = await seedTask();
    await seedQa();
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    obs({ runtimeStatusHint: 'working' });
    vi.spyOn(harness.eventBus, 'emit').mockImplementationOnce(async () => {
      harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'succ-gen1' });
    });
    const rec = mkReconciler({ busyWaitBudgetMs: 0 });

    await new Promise(r => setTimeout(r, 5));
    await rec.pollOnce();

    expect(harness.manager.getPendingDispatchRetry(t.id)).toMatchObject({ signalToken: 'succ-gen1' });
    expect(harness.manager.getPendingDispatchRetry(t.id)?.budgetAlerted).toBeUndefined();
  });

  it('taskStore.list 缺行（返回空）时 pending/计数不得被当孤儿清掉', async () => {
    const t = await seedTask();
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    vi.spyOn(harness.taskStore, 'list').mockResolvedValue([]);

    await mkReconciler().pollOnce();

    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeTruthy();
  });

  it('prune 单读失败 fail closed 保留登记', async () => {
    const t = await seedTask({ status: 'merged' });
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    vi.spyOn(harness.taskStore, 'list').mockResolvedValue([]);
    vi.spyOn(harness.taskStore, 'get').mockRejectedValue(new Error('EIO'));

    await mkReconciler().pollOnce();

    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeTruthy();
  });

  it('无 token 世代耗尽后，真实 pass 建立即重置计数恢复补派', async () => {
    const t = await seedTask({ signalToken: undefined });
    await seedQaWithoutTaskLock();
    const foreign = (await harness.lockManager.acquire('qa-1', 'other-task'))!;
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    const rec = mkReconciler({ maxAttempts: 1 });

    await rec.pollOnce();
    await rec.pollOnce();
    expect(qaPastes()).toEqual([]);
    expect(interventions()).toHaveLength(1);

    await harness.lockManager.releaseIfOwner('qa-1', 'other-task', foreign);
    await harness.acquireAgentLock('qa-1', t.id);
    const stalled = (await taskNow())!;
    delete stalled.reviewDispatch;
    await harness.taskStore.set({ ...stalled, signalToken: 'real-token01', updatedAt: new Date().toISOString() });
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    await rec.pollOnce();

    expect(qaPastes()).toHaveLength(1);
  });

  it('fixing 任务的 dev-fix pending 不被清掉且由对账补投', async () => {
    const t = await seedTask({ status: 'fixing' });
    await seedDev();
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'dev-fix', agentId: 'dev-1', signalToken: t.signalToken! });
    devObs();

    await mkReconciler().pollOnce();

    expect(devPastes()).toEqual([{ pane: DEV_PANE, body: expect.stringContaining(`token: ${t.signalToken}`) }]);
    expect(devPastes()[0]!.body).toContain('phase: fix');
  });

  it('busy pending 由对账的观测门消费（sweep 让位），hold/绑定丢失仍归平台机制', async () => {
    const t = await seedTask();
    await seedQa();
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    obs();

    await mkReconciler().pollOnce();
    expect(qaPastes()).toHaveLength(1);

    const t2 = await seedTask({ id: 'task-git-hold' });
    await harness.agentStore.set({
      id: 'qa-1', projectId: 'proj', taskId: t2.id, workdir: '/tmp/qa-repo', paneId: QA_PANE,
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed', awaitingSince: NOW,
      startedAt: NOW, updatedAt: NOW,
    } as AgentBindingFacts);
    await harness.taskStore.set({ ...(await taskNow())!, status: 'merged', updatedAt: new Date().toISOString() });
    await mkReconciler().pollOnce();
    expect(qaPastes()).toHaveLength(1);
  });

  it('任务确认删除（get 返回 null）时按代清理登记与计数', async () => {
    const t = await seedTask();
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    vi.spyOn(harness.taskStore, 'list').mockResolvedValue([]);
    vi.spyOn(harness.taskStore, 'get').mockResolvedValue(null);

    await mkReconciler().pollOnce();

    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeUndefined();
  });

  it('QA 绑定丢失 + anchor 缺失 → 驻留后由标准入口重建派发', async () => {
    await seedTask({ reviewHeadAnchorSha: undefined, latestHeadSha: undefined });
    await seedQa({ taskId: undefined });
    obs();
    const rec = mkReconciler();

    await rec.pollOnce();
    expect(qaPastes()).toEqual([]);
    await rec.pollOnce();
    expect(qaPastes()).toHaveLength(1);
    expect((await qaNow())?.taskId).toBe('task-1');
  });

  it('git QA hold 不消费 reconciler 内存中的旧 pass 登记', async () => {
    const t = await seedTask({ signalToken: 'new-pass-tok1' });
    await seedQa({ status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed', awaitingSince: NOW });
    harness.manager.registerPendingDispatchRetry(t.id, {
      kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'old-pass-tok1', qaPhase: 'review',
    });
    obs();

    await mkReconciler().pollOnce();

    expect(harness.manager.getPendingDispatchRetry(t.id)?.signalToken).toBe('old-pass-tok1');
    expect(qaPastes()).toEqual([]);
  });
});

describe('DispatchReconciler 端到端补派', () => {
  it('pending + QA 空闲 → 真实 dispatchReviewToQa 补派：token 轮换、round 不加、watcher 重装、QA 重新绑定', async () => {
    const listeners = new Map<string, Array<SubscriberCallbacks['onVisible']>>();
    const paneOf = (agentId: string) => listeners.get(agentId) ?? listeners.set(agentId, []).get(agentId)!;
    const paneStreamerManager = {
      ensure: (agent: { id: string }) => ({
        subscribeAtomic: async (cbs: SubscriberCallbacks) => {
          paneOf(agent.id).push(cbs.onVisible);
          return {
            snapshot: { data: '', cols: 80, rows: 24 },
            snapshotSeq: 0,
            unsubscribe: () => { listeners.set(agent.id, paneOf(agent.id).filter(cb => cb !== cbs.onVisible)); },
          };
        },
      }),
    } as unknown as PaneStreamerManager;
    const owner: { manager?: AgentManager } = {};
    const watcher = new PhaseSignalWatcher({
      paneStreamerManager,
      eventBus: harness.eventBus,
      resolveAgent: id => owner.manager!.getAgentConfig(id),
      commitNeedInputWatermark: intent => owner.manager!.commitNeedInputWatermark(intent),
      spawnTask: intent => owner.manager!.spawnTaskFromSignal(intent),
    });
    owner.manager = useManager({ paneStreamerManager, phaseSignalWatcher: watcher });
    const post = (agentId: string, frame: string): void => {
      for (const onVisible of [...paneOf(agentId)]) onVisible?.(`${frame}\n`, 1);
    };

    const t = await seedTask({ reviewRound: 2, signalToken: 'tok-current1' });
    await seedQa({ workdir: undefined });
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'tok-current1' });
    obs();

    await mkReconciler().pollOnce();

    const after = (await taskNow())!;
    expect(after.status).toBe('review');
    expect(after.signalToken).not.toBe('tok-current1');
    expect(after.reviewRound).toBe(2);
    expect(after.reviewHeadAnchorSha).toBe(SHA);
    expect(qaPastes()).toEqual([{ pane: QA_PANE, body: expect.stringContaining(`token: ${after.signalToken}`) }]);
    const qa = await qaNow();
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.status).toBeUndefined();
    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeUndefined();
    expect(audits()).toHaveLength(1);
    expect(interventions()).toHaveLength(0);

    // 重装只认轮换后的令牌:旧令牌的问句不落水位线,新令牌的才落
    post('qa-1', '[bx:need-input:tok-current1:1]');
    await new Promise(r => setTimeout(r, 20));
    expect((await qaNow())?.needInput?.at).toBeUndefined();
    post('qa-1', `[bx:need-input:${after.signalToken}:1]`);
    await vi.waitFor(async () => expect((await qaNow())?.needInput).toMatchObject({ askSeq: 1, answeredSeq: 0 }));
  });
});

describe('DispatchReconciler fixing 侧 re-continue', () => {
  it('pending dev-fix + 探测非忙 → continueSession(fix) 补投；成功清除登记并留审计', async () => {
    const t = await seedTask({ status: 'fixing' });
    await seedDev();
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'dev-fix', agentId: 'dev-1', signalToken: t.signalToken! });
    devObs();

    await mkReconciler().pollOnce();

    expect(devPastes()).toEqual([{ pane: DEV_PANE, body: expect.stringContaining(`token: ${t.signalToken}`) }]);
    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeUndefined();
    expect(audits()).toHaveLength(1);
  });

  it('无登记兜底：fixing + dev 绑定 + PENDING_IDLE → re-continue', async () => {
    const t = await seedTask({ status: 'fixing' });
    await seedDev();
    devObs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });

    await mkReconciler().pollOnce();

    expect(devPastes()).toEqual([{ pane: DEV_PANE, body: expect.stringContaining(`token: ${t.signalToken}`) }]);
  });

  it('dev 正在等用户输入（needInput.at）→ 兜底不得覆盖问题，不 re-continue', async () => {
    await seedTask({ status: 'fixing' });
    await seedDev({ needInput: { epoch: 1, askSeq: 1, answeredSeq: 0, at: NOW } });
    devObs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });

    await mkReconciler().pollOnce();

    expect(devPastes()).toEqual([]);
    expect(paneCmds(DEV_PANE)).toEqual([]);
  });

  it('pending dev-fix + 探测忙碌 → 等待，不补投', async () => {
    const t = await seedTask({ status: 'fixing' });
    await seedDev();
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'dev-fix', agentId: 'dev-1', signalToken: t.signalToken! });
    devObs({ runtimeStatusHint: 'working' });

    await mkReconciler().pollOnce();

    expect(devPastes()).toEqual([]);
    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeTruthy();
  });

  it('门禁在投递前拒绝（补投未送达）也消费重试额度，耗尽后升级且指引不指向 QA 接口', async () => {
    let rejectOnce = true;
    const runner = useRunner({
      onExec: async (command) => {
        if (!rejectOnce || !command.includes('list-sessions')) return;
        rejectOnce = false;
        // 补投已经上路(会话探测)时任务离开 fixing:guardBeforeInject 在粘贴前拒绝
        await harness.taskStore.set({ ...(await taskNow())!, status: 'review', updatedAt: new Date().toISOString() });
      },
    });
    useManager({ runnerFactory: () => runner });
    const t = await seedTask({ status: 'fixing' });
    await seedDev();
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'dev-fix', agentId: 'dev-1', signalToken: t.signalToken! });
    devObs();
    const rec = mkReconciler({ maxAttempts: 1 });

    await rec.pollOnce();
    expect(devPastes()).toEqual([]);

    await harness.taskStore.set({ ...(await taskNow())!, status: 'fixing', updatedAt: new Date().toISOString() });
    devObs();
    await rec.pollOnce();

    expect(devPastes()).toEqual([]);
    const alerts = interventions();
    expect(alerts).toHaveLength(1);
    expect(String(alerts[0]!.data.note)).toContain('Advance with Dev');
    expect(String(alerts[0]!.data.note)).toContain('Do not advance to QA');
    expect(String(alerts[0]!.data.note)).not.toContain('POST /tasks/:id/review');
  });

  it('pending dev-fix 但 dev 已进入 awaiting_human → 不得覆盖 hold，pane 不投递', async () => {
    const t = await seedTask({ status: 'fixing' });
    await seedDev({ status: 'awaiting_human', awaitingPhase: 'runtime-missing', awaitingSince: NOW });
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'dev-fix', agentId: 'dev-1', signalToken: t.signalToken! });
    devObs();

    await mkReconciler().pollOnce();

    expect(devPastes()).toEqual([]);
    expect(paneCmds(DEV_PANE)).toEqual([]);
    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeTruthy();
  });

  it('任务离开活跃补派状态后清理登记与计数', async () => {
    const t = await seedTask({ status: 'merged' });
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });

    await mkReconciler().pollOnce();

    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeUndefined();
  });
});

describe('DispatchReconciler 补派恢复与有界升级', () => {
  it('QA 绑定丢失（durable pending 已清、sweep 无凭据）→ 驻留两周期后由对账补派', async () => {
    await seedTask();
    await seedQa({ taskId: undefined });
    obs();
    const rec = mkReconciler();

    await rec.pollOnce();
    expect(qaPastes()).toEqual([]);
    await rec.pollOnce();
    expect(qaPastes()).toHaveLength(1);
  });

  it('git pending 登记 + QA 解绑 → 不再双让位（对账驻留后补派并消费登记）', async () => {
    const t = await seedTask();
    await seedQa({ taskId: undefined });
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    obs();
    const rec = mkReconciler();

    await rec.pollOnce();
    await rec.pollOnce();

    expect(qaPastes()).toHaveLength(1);
    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeUndefined();
  });

  it('pending + 探测 unreachable 超预算 → 一次性 dispatch-busy-budget-exhausted，不注入', async () => {
    const t = await seedTask();
    await seedQa();
    harness.manager.registerPendingDispatchRetry(
      t.id,
      { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! },
      { since: Date.now() - 60_000 },
    );
    statusStore.set('qa-1', { tmuxSessionStatus: 'unreachable' });
    const rec = mkReconciler({ busyWaitBudgetMs: 0 });

    await rec.pollOnce();
    await rec.pollOnce();

    expect(qaPastes()).toEqual([]);
    const alerts = interventions().filter(e => (e.data as { phase?: string }).phase === 'dispatch-busy-budget-exhausted');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.data).toMatchObject({ observationStatus: 'unreachable' });
  });

  it('dev-fix pending + 探测 unreachable 超预算 → 同样进入预算告警通道', async () => {
    const t = await seedTask({ status: 'fixing' });
    await seedDev();
    harness.manager.registerPendingDispatchRetry(
      t.id,
      { kind: 'dev-fix', agentId: 'dev-1', signalToken: t.signalToken! },
      { since: Date.now() - 60_000 },
    );
    statusStore.set('dev-1', { tmuxSessionStatus: 'unreachable' });

    await mkReconciler({ busyWaitBudgetMs: 0 }).pollOnce();

    expect(devPastes()).toEqual([]);
    const alerts = interventions().filter(e => (e.data as { phase?: string }).phase === 'dispatch-busy-budget-exhausted');
    expect(alerts).toHaveLength(1);
  });

  it('dev-fix pending 但 dev 绑定丢失 → 有界升级为 intervention，不静默留着无人可送的 fix', async () => {
    const t = await seedTask({ status: 'fixing' });
    await seedDev({ taskId: undefined });
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'dev-fix', agentId: 'dev-1', signalToken: t.signalToken! });
    devObs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    const rec = mkReconciler({ maxAttempts: 2 });

    await rec.pollOnce();
    await rec.pollOnce();
    await rec.pollOnce();
    await rec.pollOnce();

    expect(devPastes()).toEqual([]);
    const alerts = interventions().filter(e => (e.data as { phase?: string }).phase === 'dispatch-reconcile-attempts-exhausted');
    expect(alerts).toHaveLength(1);
    expect(String((alerts[0]!.data as { note?: string }).note)).toMatch(/no longer bound/i);
  });

  it('verdict 在 await 窗口内接管 → 不把 successor 的 token 记成本次补派的世系', async () => {
    const t = await seedTask();
    let takenOver = false;
    const runner = useRunner({
      onExec: async (command) => {
        if (takenOver || !command.includes('capture-pane') || !command.includes(QA_PANE)) return;
        // 提示词已经提交给 QA pane,这是等 ack 的窗口:verdict 在此接管任务
        if (!harness.runner.sentKeys.some(keys => keys.includes(QA_PANE) && keys.includes('Enter'))) return;
        takenOver = true;
        const inFlight = (await taskNow())!;
        delete inFlight.reviewDispatch;
        await harness.taskStore.set({
          ...inFlight, status: 'fixing', signalToken: 'fix-tok-1', updatedAt: new Date().toISOString(),
        });
        harness.manager.registerPendingDispatchRetry(t.id, { kind: 'dev-fix', agentId: 'dev-1', signalToken: 'fix-tok-1' });
      },
    });
    useManager({ runnerFactory: () => runner });
    await seedQa();
    await seedDev({ taskId: undefined });
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    const rec = mkReconciler({ maxAttempts: 1 });

    await rec.pollOnce();
    expect(takenOver).toBe(true);

    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: DEV_PANE, startedAt: NOW });
    devObs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    await rec.pollOnce();

    expect(devPastes()).toHaveLength(1);
    expect(interventions().filter(e => (e.data as { phase?: string }).phase === 'dispatch-reconcile-attempts-exhausted'))
      .toHaveLength(0);
  });

  it('同一份观测只驱动一次补派——内部重排后不再每周期空转 release/acquire/轮换', async () => {
    useManager({ cleanComposerWaitMs: 20 });
    const t = await seedTaskWithPendingLease();
    await seedQa();
    harness.manager.registerPendingDispatchRetry(
      t.id,
      { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! },
      { since: Date.now() - 10_000 },
    );
    statusStore.set('qa-1', {
      tmuxSessionStatus: 'present', observedAt: new Date(Date.now() - 5_000).toISOString(),
    });
    harness.runner.sessions.markWorking('qa-1', CODEX_WORKING);
    const rec = mkReconciler({ busyWaitBudgetMs: 1 });

    await rec.pollOnce();
    const afterFirst = paneCmds(QA_PANE).length;
    expect(afterFirst).toBeGreaterThan(0);

    await rec.pollOnce();
    await rec.pollOnce();

    expect(paneCmds(QA_PANE)).toHaveLength(afterFirst);
    expect(qaPastes()).toEqual([]);
  });

  it('内部重排后等待预算照常到期——发一次性 intervention，不静默 churn', async () => {
    useManager({ cleanComposerWaitMs: 20 });
    const t = await seedTaskWithPendingLease();
    await seedQa();
    harness.manager.registerPendingDispatchRetry(
      t.id,
      { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! },
      { since: Date.now() - 10_000 },
    );
    statusStore.set('qa-1', {
      tmuxSessionStatus: 'present', observedAt: new Date(Date.now() - 5_000).toISOString(),
    });
    harness.runner.sessions.markWorking('qa-1', CODEX_WORKING);
    const rec = mkReconciler({ busyWaitBudgetMs: 1 });

    await rec.pollOnce();
    await rec.pollOnce();
    await rec.pollOnce();

    const alerts = interventions().filter(e => (e.data as { phase?: string }).phase === 'dispatch-busy-budget-exhausted');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.data).toMatchObject({ kind: 'qa-recheck' });
  });

  it('等到真正新鲜的空闲观测后恢复补派（水位线不是永久闸门）', async () => {
    useManager({ cleanComposerWaitMs: 20 });
    const t = await seedTask();
    await seedQa();
    harness.manager.registerPendingDispatchRetry(
      t.id,
      { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! },
      { since: Date.now() - 10_000 },
    );
    statusStore.set('qa-1', {
      tmuxSessionStatus: 'present', observedAt: new Date(Date.now() - 5_000).toISOString(),
    });
    harness.runner.sessions.markWorking('qa-1', CODEX_WORKING);
    const rec = mkReconciler();

    await rec.pollOnce();
    await rec.pollOnce();
    expect(qaPastes()).toEqual([]);

    harness.runner.sessions.markWorking('qa-1');
    harness.runner.sessions.setProcess('qa-1', 'codex');
    obs();
    await rec.pollOnce();

    expect(qaPastes()).toHaveLength(1);
  });

  it('pending 补派前复核 needInput.at——QA 正等人回答时不得覆盖问题（与兜底同门禁）', async () => {
    const t = await seedTask();
    await seedQa({ needInput: { epoch: 1, askSeq: 1, answeredSeq: 0, at: new Date().toISOString() } });
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });

    await mkReconciler().pollOnce();

    expect(qaPastes()).toEqual([]);
    expect(paneCmds(QA_PANE)).toEqual([]);
    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeTruthy();
  });

  it('等人回答的阻塞同样有界升级（超预算一次性告警，标注 blockedBy）', async () => {
    const t = await seedTask();
    await seedQa({ needInput: { epoch: 1, askSeq: 1, answeredSeq: 0, at: new Date().toISOString() } });
    harness.manager.registerPendingDispatchRetry(
      t.id,
      { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! },
      { since: Date.now() - 60_000 },
    );
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });

    const rec = mkReconciler({ busyWaitBudgetMs: 0 });
    await rec.pollOnce();
    await rec.pollOnce();

    const alerts = interventions().filter(e => (e.data as { phase?: string }).phase === 'dispatch-busy-budget-exhausted');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.data).toMatchObject({ blockedBy: 'need-input' });
  });

  it('dev-fix pending 补派前同样复核 needInput.at', async () => {
    const t = await seedTask({ status: 'fixing' });
    await seedDev({ needInput: { epoch: 1, askSeq: 1, answeredSeq: 0, at: new Date().toISOString() } });
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'dev-fix', agentId: 'dev-1', signalToken: t.signalToken! });
    devObs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });

    await mkReconciler().pollOnce();

    expect(devPastes()).toEqual([]);
    expect(paneCmds(DEV_PANE)).toEqual([]);
    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeTruthy();
  });

  it('丢绑驻留计数按 pass 世系归零（外部换代后不得继承旧 pass 的驻留）', async () => {
    const t = await seedTask();
    await seedQa({ taskId: undefined });
    obs();
    const rec = mkReconciler();

    await rec.pollOnce();
    expect(qaPastes()).toEqual([]);

    const fresh = (await taskNow())!;
    await harness.taskStore.set({ ...fresh, signalToken: 'tok-ext-rot1', updatedAt: new Date().toISOString() });

    await rec.pollOnce();
    expect(qaPastes()).toEqual([]);
    await rec.pollOnce();
    expect(qaPastes()).toHaveLength(1);
    expect((await taskNow())?.id).toBe(t.id);
  });
});

describe('reconcileFix: QA release deferred while its REPL was busy', () => {
  async function seedDevWithPendingFix(task: TaskState): Promise<void> {
    await seedDev();
    harness.manager.registerPendingDispatchRetry(task.id, { kind: 'dev-fix', agentId: 'dev-1', signalToken: task.signalToken! });
    devObs();
  }

  it('fixing 阶段 QA 仍绑定且无 hold、探测非忙 → 每轮对账重试延后释放', async () => {
    const t = await seedTask({ status: 'fixing' });
    await seedQa();
    obs();

    await mkReconciler().pollOnce();

    expect((await qaNow())?.taskId).toBeUndefined();
    expect(await harness.lockManager.claimOf('qa-1')).toBeNull();
    expect((await taskNow())?.status).toBe(t.status);
  });

  it('探测判 QA 仍在工作 → 本轮不进入释放（不占全局任务锁等待）', async () => {
    const t = await seedTask({ status: 'fixing' });
    await seedQa();
    obs({ runtimeStatusHint: 'working' });

    await mkReconciler().pollOnce();

    expect((await qaNow())?.taskId).toBe(t.id);
    expect(paneCmds(QA_PANE)).toEqual([]);
  });

  it('QA 已落 hold 或已解绑 → 不重试释放', async () => {
    const t = await seedTask({ status: 'fixing' });
    obs();

    await seedQa({ status: 'awaiting_human', awaitingPhase: 'branch-cleanup-pending', awaitingSince: NOW });
    await mkReconciler().pollOnce();
    expect((await qaNow())).toMatchObject({ taskId: t.id, status: 'awaiting_human' });

    await harness.agentStore.set({
      id: 'qa-1', projectId: 'proj', workdir: '/tmp/qa-repo', paneId: QA_PANE, startedAt: NOW, updatedAt: NOW,
    } as AgentBindingFacts);
    await mkReconciler().pollOnce();

    expect(paneCmds(QA_PANE)).toEqual([]);
    expect((await taskNow())?.status).toBe('fixing');
  });

  it('QA 仍忙（REPL 未就绪）→ 静默延后，同轮 dev-fix 补投照常', async () => {
    useManager({ cleanComposerWaitMs: 20 });
    const t = await seedTask({ status: 'fixing' });
    await seedQa();
    obs();
    await seedDevWithPendingFix(t);
    harness.runner.sessions.markWorking('qa-1', CODEX_WORKING);

    await mkReconciler().pollOnce();

    expect(devPastes()).toHaveLength(1);
    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeUndefined();
    expect((await qaNow())?.taskId).toBe(t.id);
    expect(interventions()).toHaveLength(0);
  });

  it('QA 释放在 checkout 清理处失败 → 落 hold 并告警，同轮 dev-fix 补投不受阻断', async () => {
    const t = await seedTask({ status: 'fixing' });
    await seedQa();
    obs();
    await seedDevWithPendingFix(t);
    vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached')
      .mockRejectedValue(new Error('ssh exit 255'));

    await mkReconciler().pollOnce();

    expect(devPastes()).toHaveLength(1);
    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeUndefined();
    expect(await qaNow()).toMatchObject({
      taskId: t.id, status: 'awaiting_human', awaitingPhase: 'branch-cleanup-pending',
    });
    expect(phasesOf(interventions())).toEqual(['branch-cleanup-pending']);
  });

  it('QA 释放返回 false（绑定仍在但已不持任务锁）→ 发一次 qa-release-failed-but-dev-dispatched，同轮 dev-fix 照常', async () => {
    const t = await seedTask({ status: 'fixing' });
    await seedQaWithoutTaskLock();
    obs();
    await seedDevWithPendingFix(t);

    await mkReconciler().pollOnce();

    expect(devPastes()).toHaveLength(1);
    expect((await qaNow())?.taskId).toBe(t.id);
    expect(interventions()).toHaveLength(1);
    expect(interventions()[0]).toMatchObject({
      agentId: 'dev-1',
      taskId: t.id,
      data: { phase: 'qa-release-failed-but-dev-dispatched', qaAgentId: 'qa-1' },
    });
  });

  it('任务已有 attention → 释放被拒不重复告警，仍每轮重试', async () => {
    const t = await seedTask({ status: 'fixing' });
    await harness.taskStore.set({
      ...t,
      attention: {
        reason: 'qa-release-failed-but-dev-dispatched', runbook: 'r', occurredAt: NOW,
        recommendedActions: ['cancel'], generation: taskAttentionGeneration(t),
      },
    });
    await seedQaWithoutTaskLock();
    obs();
    const rec = mkReconciler();

    await rec.pollOnce();
    await rec.pollOnce();

    expect((await qaNow())?.taskId).toBe(t.id);
    expect(interventions()).toHaveLength(0);
  });

  it('QA 绑定预读持续失败 → 本轮跳过辅助释放，同轮 dev-fix 补投照常', async () => {
    const t = await seedTask({ status: 'fixing' });
    await seedQa();
    obs();
    await seedDevWithPendingFix(t);
    const readBinding = harness.agentStore.get.bind(harness.agentStore);
    vi.spyOn(harness.agentStore, 'get').mockImplementation(async (id) => {
      if (id === 'qa-1') throw new Error('EIO');
      return readBinding(id);
    });

    await mkReconciler().pollOnce();

    expect(paneCmds(QA_PANE)).toEqual([]);
    expect(devPastes()).toHaveLength(1);
    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeUndefined();
    expect(interventions()).toHaveLength(0);
  });

  it('释放被拒后的告警复核读取失败 → 本轮不告警，同轮 dev-fix 补投照常', async () => {
    const t = await seedTask({ status: 'fixing' });
    await seedQaWithoutTaskLock();
    obs();
    await seedDevWithPendingFix(t);
    const readBinding = harness.agentStore.get.bind(harness.agentStore);
    let qaReads = 0;
    vi.spyOn(harness.agentStore, 'get').mockImplementation(async (id) => {
      // 1 预检查读、2 释放内复核读、3 告警复核读
      if (id === 'qa-1' && ++qaReads === 3) throw new Error('EIO');
      return readBinding(id);
    });

    await mkReconciler().pollOnce();

    expect(qaReads).toBeGreaterThanOrEqual(3);
    expect(devPastes()).toHaveLength(1);
    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeUndefined();
    expect(interventions()).toHaveLength(0);
  });
});

describe('reconcile: spec-ready 任务上延后释放的 QA', () => {
  it('spec-ready 任务 QA 仍绑定且无 hold、探测非忙 → 每轮对账重试延后释放', async () => {
    await seedTask({ status: 'spec-ready', phase: 'spec' });
    await seedQa();
    obs();

    await mkReconciler().pollOnce();

    expect((await qaNow())?.taskId).toBeUndefined();
    expect(await harness.lockManager.claimOf('qa-1')).toBeNull();
    expect((await taskNow())?.status).toBe('spec-ready');
  });

  it('探测判 QA 仍在工作、或 QA 已落 hold → 本轮不释放', async () => {
    const t = await seedTask({ status: 'spec-ready', phase: 'spec' });

    await seedQa();
    obs({ runtimeStatusHint: 'working' });
    await mkReconciler().pollOnce();
    expect((await qaNow())?.taskId).toBe(t.id);

    await seedQa({ status: 'awaiting_human', awaitingPhase: 'branch-cleanup-pending', awaitingSince: NOW });
    obs();
    await mkReconciler().pollOnce();

    expect(paneCmds(QA_PANE)).toEqual([]);
    expect((await qaNow())?.taskId).toBe(t.id);
    expect((await taskNow())?.status).toBe('spec-ready');
  });

  it('预检查通过后、release 加锁前 QA 刚落 hold → 锁内复核拒绝释放：hold、绑定、任务锁均保留，不告警', async () => {
    const t = await seedTask({ status: 'spec-ready', phase: 'spec' });
    await seedQa();
    const lockToken = (await harness.agentStore.get('qa-1'))!.lockToken!;
    obs();
    const readBinding = harness.agentStore.get.bind(harness.agentStore);
    let held = false;
    vi.spyOn(harness.agentStore, 'get').mockImplementation(async (id) => {
      const state = await readBinding(id);
      if (id === 'qa-1' && !held) {
        held = true;
        await harness.manager.markAwaitingHuman('qa-1', 'branch-cleanup-pending', 'checkout cleanup failed: ssh exit 255', {
          expectedTaskId: t.id,
        });
      }
      return state;
    });

    await mkReconciler().pollOnce();

    expect(await qaNow()).toMatchObject({
      taskId: t.id, lockToken, status: 'awaiting_human', awaitingPhase: 'branch-cleanup-pending',
    });
    expect(await harness.lockManager.isOwner('qa-1', t.id, lockToken)).toBe(true);
    expect(phasesOf(interventions())).toEqual(['branch-cleanup-pending']);
  });

  it('spec-ready 写入后、park 释放 QA 前对账器先完成释放 → park 视已解绑为成功，不发 spec-ready-qa-release-failed', async () => {
    const t = await seedTask({ status: 'review', phase: 'spec', specReviewRound: 1 });
    await seedQa();
    await seedDev();
    obs();
    const rec = mkReconciler();
    const readBinding = harness.agentStore.get.bind(harness.agentStore);
    let interleaved = false;
    // park 写入 spec-ready 后还要停泊 dev,对账器在这个窗口里先一步释放 QA
    vi.spyOn(harness.agentStore, 'get').mockImplementation(async (id) => {
      if (!interleaved && id === 'dev-1' && (await harness.taskStore.get(t.id))?.status === 'spec-ready') {
        interleaved = true;
        await rec.pollOnce();
      }
      return readBinding(id);
    });

    const parked = await harness.manager.parkTaskAtSpecReady(t.id);

    expect(interleaved).toBe(true);
    expect(parked?.status).toBe('spec-ready');
    expect((await qaNow())?.taskId).toBeUndefined();
    expect(interventions()).toEqual([]);
  });

  it('QA 仍忙（REPL 未就绪）→ 静默延后，不告警', async () => {
    useManager({ cleanComposerWaitMs: 20 });
    const t = await seedTask({ status: 'spec-ready', phase: 'spec' });
    await seedQa();
    obs();
    harness.runner.sessions.markWorking('qa-1', CODEX_WORKING);

    await mkReconciler().pollOnce();

    expect((await qaNow())?.taskId).toBe(t.id);
    expect(interventions()).toHaveLength(0);
  });

  it('QA 释放返回 false（绑定仍在但已不持任务锁）→ 发一次 spec-ready-qa-release-failed，已有 attention 不重复', async () => {
    const t = await seedTask({ status: 'spec-ready', phase: 'spec' });
    await seedQaWithoutTaskLock();
    obs();
    const rec = mkReconciler();

    await rec.pollOnce();
    await harness.taskStore.set({
      ...(await taskNow())!,
      attention: {
        reason: 'spec-ready-qa-release-failed', runbook: 'r', occurredAt: NOW,
        recommendedActions: ['cancel'], generation: taskAttentionGeneration(t),
      },
    });
    await rec.pollOnce();

    expect(interventions()).toHaveLength(1);
    expect(interventions()[0]).toMatchObject({
      agentId: 'qa-1',
      taskId: t.id,
      data: { phase: 'spec-ready-qa-release-failed', qaAgentId: 'qa-1' },
    });
  });
});
