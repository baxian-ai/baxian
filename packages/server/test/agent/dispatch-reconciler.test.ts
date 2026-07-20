import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BaxianConfig, BaxianEvent, TaskState, AgentBindingFacts } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
import { AgentManager } from '../../src/agent/manager.js';
import { DispatchReconciler } from '../../src/agent/dispatch-reconciler.js';
import { TmuxSessionStatusStore, type TmuxSessionObservation } from '../../src/agent/tmux-probe-poller.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';
import { AgentStore } from '../../src/state/agent-store.js';
import { TaskStore } from '../../src/state/task-store.js';
import { LockManager } from '../../src/state/lock.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { SkillRegistry } from '../../src/skill/registry.js';
import { initStateDir } from '../../src/state/init.js';
import { ApiError } from '../../src/errors.js';

const NOW = '2026-07-19T00:00:00Z';
const SHA = 'a'.repeat(40);

const CONFIG: BaxianConfig = {
  review: { rounds: 10 },
  server: DEFAULT_SERVER_CONFIG,
  project: [{
    id: 'proj',
    repo: 'user/repo',
    merge: null,
    agent: [[
      { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp/repo' },
      { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local', workdir: '/tmp/repo-qa' },
    ]],
  }],
};

let tempDir: string;
let agentStore: AgentStore;
let taskStore: TaskStore;
let lockManager: LockManager;
let eventBus: EventBus;
let manager: AgentManager;
let statusStore: TmuxSessionStatusStore;
const events: BaxianEvent[] = [];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-dreconcile-'));
  await initStateDir(tempDir);
  agentStore = new AgentStore(join(tempDir, 'state', 'agents'));
  taskStore = new TaskStore(join(tempDir, 'state', 'tasks'));
  lockManager = new LockManager(join(tempDir, 'locks'));
  eventBus = new EventBus(new EventLog(join(tempDir, 'events')));
  statusStore = new TmuxSessionStatusStore();
  events.length = 0;
  eventBus.on('*', (e) => { events.push(e); });
  const noopRunner: CommandRunner = {
    exec: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    writeFile: vi.fn(async (): Promise<void> => undefined),
  };
  manager = new AgentManager({
    config: CONFIG,
    agentStore,
    taskStore,
    lockManager,
    eventBus,
    skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
    runnerFactory: () => noopRunner,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

function mkReconciler(over: { busyWaitBudgetMs?: number; maxAttempts?: number } = {}): DispatchReconciler {
  return new DispatchReconciler({
    manager,
    taskStore,
    agentStore,
    statusStore,
    eventBus,
    intervalMs: 1000,
    busyWaitBudgetMs: over.busyWaitBudgetMs ?? 30 * 60 * 1000,
    maxAttempts: over.maxAttempts ?? 3,
  });
}

async function seedTask(over: Partial<TaskState> = {}): Promise<TaskState> {
  const t: TaskState = {
    id: 'task-1',
    projectId: 'proj',
    title: 'T',
    description: 'D',
    preferredAgentId: 'dev-1',
    agentId: 'dev-1',
    devAgentId: 'dev-1',
    qaAgentId: 'qa-1',
    branch: 'bx/task-1',
    prNumber: 7,
    status: 'review',
    reviewRound: 2,
    signalToken: 'tok-current1',
    reviewHeadAnchorSha: SHA,
    latestHeadSha: SHA,
    reviewDispatchedAt: NOW,
    fixDispatchedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as TaskState;
  await taskStore.set(t);
  return t;
}

async function seedQa(over: Partial<AgentBindingFacts> = {}): Promise<void> {
  await agentStore.set({
    id: 'qa-1',
    projectId: 'proj',
    taskId: 'task-1',
    workdir: '/tmp/repo-qa',
    paneId: '%0',
    startedAt: NOW,
    updatedAt: NOW,
    ...over,
  } as AgentBindingFacts);
}

function freshObservedAt(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

function obs(over: Partial<TmuxSessionObservation> = {}): void {
  statusStore.set('qa-1', { tmuxSessionStatus: 'present', observedAt: freshObservedAt(), ...over });
}

function interventions(): BaxianEvent[] {
  return events.filter(e => e.type === 'human.intervention');
}

function audits(): BaxianEvent[] {
  return events.filter(e => e.type === 'agent.recovered'
    && (e.data as { reason?: string }).reason === 'dispatch-reconciled');
}

describe('DispatchReconciler review 侧补派', () => {
  it('pending qa-recheck + 探测非忙 → 按当前 pass 令牌补派（bumpRound:false）并留审计', async () => {
    const t = await seedTask();
    await seedQa();
    manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken });
    obs();
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa')
      .mockResolvedValue({ ...t, signalToken: 'tok-rotated1' });

    await mkReconciler().pollOnce();

    expect(dispatchSpy).toHaveBeenCalledWith(t.id, {
      bumpRound: false,
      fromStatus: ['review'],
      expectSignalToken: 'tok-current1',
      pendingBudget: expect.objectContaining({ since: expect.any(Number) }),
      onPassArmed: expect.any(Function),
    });
    expect(manager.getPendingDispatchRetry(t.id)).toBeUndefined();
    expect(audits()).toHaveLength(1);
    expect(interventions()).toHaveLength(0);
  });

  it('pending + 探测忙碌 → 不补派；忙碌超预算发一次性 intervention，不重复', async () => {
    const t = await seedTask();
    await seedQa();
    manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken });
    obs({ runtimeStatusHint: 'working' });
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa');
    const rec = mkReconciler({ busyWaitBudgetMs: 0 });

    await new Promise(r => setTimeout(r, 5));
    await rec.pollOnce();
    await rec.pollOnce();

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(manager.getPendingDispatchRetry(t.id)).toBeTruthy();
    const alerts = interventions();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].data).toMatchObject({ phase: 'dispatch-busy-budget-exhausted', kind: 'qa-recheck' });
  });

  it('pending 令牌与任务当前 pass 不符 → 丢弃登记且不补派', async () => {
    const t = await seedTask({ signalToken: 'tok-successor' });
    await seedQa();
    manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'tok-stale1' });
    obs();
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa');

    await mkReconciler().pollOnce();

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(manager.getPendingDispatchRetry(t.id)).toBeUndefined();
  });

  it('可恢复 hold（checkout-preparation-failed）→ 自动补派（事故双 QA 卡死回归）', async () => {
    const t = await seedTask();
    await seedQa({
      status: 'awaiting_human',
      awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready (paneId=%0, runtime=codex) within timeout',
      awaitingSince: NOW,
    });
    obs();
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa')
      .mockResolvedValue({ ...t, signalToken: 'tok-rotated2' });

    await mkReconciler().pollOnce();

    expect(dispatchSpy).toHaveBeenCalledWith(t.id, expect.objectContaining({ bumpRound: false }));
    expect(audits()).toHaveLength(1);
  });

  it('非可恢复 hold（checkout-cleanup-failed）→ 不动，交人工', async () => {
    await seedTask();
    await seedQa({
      status: 'awaiting_human',
      awaitingPhase: 'checkout-cleanup-failed',
      awaitingSince: NOW,
    });
    obs();
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa');

    await mkReconciler().pollOnce();

    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('无 pending 登记（如进程重启后）+ PENDING_IDLE 观察 → 兜底补派；次数达上限后停手并发一次性 intervention', async () => {
    await seedTask();
    await seedQa();
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    let armed = 0;
    // mock 须实现 onPassArmed 契约（真实实现在 claim2 后回调），否则返回值不可证明属本次 pass
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa').mockImplementation(async (taskId, opts) => {
      armed += 1;
      const token = `tok-armed-fb${armed}`;
      opts?.onPassArmed?.(token);
      const rotated = { ...(await taskStore.get(taskId))!, signalToken: token, updatedAt: new Date().toISOString() };
      await taskStore.set(rotated);
      return rotated;
    });
    const rec = mkReconciler({ maxAttempts: 2 });

    await rec.pollOnce();
    await rec.pollOnce();
    await rec.pollOnce();
    await rec.pollOnce();

    expect(dispatchSpy).toHaveBeenCalledTimes(2);
    const alerts = interventions();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].data).toMatchObject({ phase: 'dispatch-reconcile-attempts-exhausted' });
  });

  it('锚点落后于最新 head（push 事件路径职责）→ 不补派', async () => {
    const t = await seedTask({ latestHeadSha: 'b'.repeat(40) });
    await seedQa();
    manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken });
    obs();
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa');

    await mkReconciler().pollOnce();

    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('review 任务 QA 绑定丢失 → 驻留两周期确认后补派', async () => {
    const t = await seedTask();
    await seedQa({ taskId: undefined });
    obs();
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa')
      .mockResolvedValue({ ...t, signalToken: 'tok-rotated3' });
    const rec = mkReconciler();

    await rec.pollOnce();
    expect(dispatchSpy).not.toHaveBeenCalled();
    await rec.pollOnce();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it('带 dispatch-superseded/in-flight code 的 409（并发接管/入口互斥）→ 不计入次数上限', async () => {
    await seedTask();
    await seedQa();
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa')
      .mockRejectedValue(new ApiError(409, 'superseded', 'dispatch-superseded'));
    const rec = mkReconciler({ maxAttempts: 2 });

    await rec.pollOnce();
    await rec.pollOnce();
    await rec.pollOnce();

    expect(dispatchSpy).toHaveBeenCalledTimes(3);
    expect(interventions()).toHaveLength(0);
  });

  it('无 code 的持久性 409（跨任务占用/release 失败等）→ 计次并在耗尽后升级 intervention', async () => {
    await seedTask();
    await seedQa();
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa')
      .mockRejectedValue(new ApiError(409, 'QA agent qa-1 is busy or unavailable'));
    const rec = mkReconciler({ maxAttempts: 2 });

    await rec.pollOnce();
    await rec.pollOnce();
    await rec.pollOnce();
    await rec.pollOnce();

    expect(dispatchSpy).toHaveBeenCalledTimes(2);
    const alerts = interventions();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].data).toMatchObject({ phase: 'dispatch-reconcile-attempts-exhausted' });
  });

  it('server 评审模式与 spec 阶段任务不在对账范围', async () => {
    await seedTask({ id: 'task-srv', reviewMode: 'server' });
    await seedTask({ id: 'task-spec', phase: 'spec' });
    await seedQa({ taskId: 'task-srv' });
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa');

    const rec = mkReconciler();
    await rec.pollOnce();
    await rec.pollOnce();

    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});

describe('DispatchReconciler 评审加固（#563 R1/R6/R8/C1/C2/C4/C5/R7/R11）', () => {
  it('pending 记录首评相位 + 任务持久化未计轮 intent → 补派携带 qaPhase=review 与 bumpRound=true（C2/R7/R17）', async () => {
    const t = await seedTask({ reviewRound: 0, reviewRoundPending: true });
    await seedQa();
    manager.registerPendingDispatchRetry(t.id, {
      kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken!,
      qaPhase: 'review',
    });
    obs();
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa')
      .mockResolvedValue({ ...t, signalToken: 'tok-rotated9' });

    await mkReconciler().pollOnce();

    expect(dispatchSpy).toHaveBeenCalledWith(t.id, expect.objectContaining({
      qaPhase: 'review',
      bumpRound: true,
      expectSignalToken: t.signalToken,
    }));
  });

  it('外部换代重置尝试计数：新 pass 拿全新预算，reconciler 自身补派延续世系（C1）', async () => {
    const t = await seedTask();
    await seedQa();
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    let tok = 0;
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa').mockImplementation(async (_taskId, opts) => {
      tok += 1;
      const fresh = (await taskStore.get(t.id))!;
      const rotated = { ...fresh, signalToken: `tok-lineage-${tok}`, updatedAt: new Date().toISOString() };
      opts?.onPassArmed?.(rotated.signalToken!);
      await taskStore.set(rotated);
      return rotated;
    });
    const rec = mkReconciler({ maxAttempts: 2 });

    await rec.pollOnce();
    await rec.pollOnce();
    await rec.pollOnce();
    expect(dispatchSpy).toHaveBeenCalledTimes(2);
    expect(interventions()).toHaveLength(1);

    const fresh = (await taskStore.get(t.id))!;
    await taskStore.set({ ...fresh, signalToken: 'external-rotation', updatedAt: new Date().toISOString() });
    await rec.pollOnce();
    expect(dispatchSpy).toHaveBeenCalledTimes(3);
  });

  it('PENDING_HUMAN（交互式菜单）阻断补派并计入预算告警通道（C4）', async () => {
    const t = await seedTask();
    await seedQa();
    manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_HUMAN' });
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa');
    const rec = mkReconciler({ busyWaitBudgetMs: 0 });

    await new Promise(r => setTimeout(r, 5));
    await rec.pollOnce();

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(interventions()).toHaveLength(1);
    expect(interventions()[0].data).toMatchObject({ observationReason: 'PENDING_HUMAN' });
  });

  it('观测早于 pending 登记（陈旧 idle）→ 不补派（C4）', async () => {
    const t = await seedTask();
    await seedQa();
    obs({ observedAt: new Date(Date.now() - 60_000).toISOString() });
    manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa');

    await mkReconciler().pollOnce();

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(manager.getPendingDispatchRetry(t.id)).toBeTruthy();
  });

  it('intervention 首次落盘失败不锁存告警标志，下一周期重试（R6）', async () => {
    const t = await seedTask();
    await seedQa();
    manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    obs({ runtimeStatusHint: 'working' });
    const emitSpy = vi.spyOn(eventBus, 'emit').mockRejectedValueOnce(new Error('event log write failed'));
    const rec = mkReconciler({ busyWaitBudgetMs: 0 });

    await new Promise(r => setTimeout(r, 5));
    await rec.pollOnce();
    expect(manager.getPendingDispatchRetry(t.id)?.budgetAlerted).toBeUndefined();
    await rec.pollOnce();
    await rec.pollOnce();

    expect(manager.getPendingDispatchRetry(t.id)?.budgetAlerted).toBe(true);
    expect(emitSpy).toHaveBeenCalledTimes(2);
    expect(interventions()).toHaveLength(1);
  });

  it('anchor 缺失 + pending：有界刷新 head 后放行补派（R8）', async () => {
    const t = await seedTask({ reviewHeadAnchorSha: undefined });
    await seedQa();
    manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    obs();
    vi.spyOn(manager, 'fetchPrHeadSha').mockResolvedValue(SHA);
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa')
      .mockResolvedValue({ ...t, signalToken: 'tok-rotated8' });

    await mkReconciler().pollOnce();

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it('anchor 缺失且 head 刷新持续失败 → 计次并升级 intervention，不永久静默（R8）', async () => {
    const t = await seedTask({ reviewHeadAnchorSha: undefined, latestHeadSha: undefined });
    await seedQa();
    manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    obs();
    vi.spyOn(manager, 'fetchPrHeadSha').mockRejectedValue(new Error('gh transient'));
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa');
    const rec = mkReconciler({ maxAttempts: 2 });

    await rec.pollOnce();
    await rec.pollOnce();
    await rec.pollOnce();

    expect(dispatchSpy).not.toHaveBeenCalled();
    const alerts = interventions();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].data).toMatchObject({ phase: 'dispatch-reconcile-attempts-exhausted', action: 'anchor-refresh' });
  });

  it('明确 anchor≠head 仍让位 push 事件路径（R8 边界不回退）', async () => {
    const t = await seedTask({ latestHeadSha: 'b'.repeat(40) });
    await seedQa();
    manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    obs();
    const fetchSpy = vi.spyOn(manager, 'fetchPrHeadSha');
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa');

    await mkReconciler().pollOnce();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});

describe('DispatchReconciler 第 8 轮加固（R14/R15/R16/R17/R18/R19/CX1/CX3）', () => {
  it.each([
    ['PANE_PROBE_FAILED', { runtimeStatusHint: 'error' as const, reason: 'PANE_PROBE_FAILED' }],
    ['UNSUPPORTED_FOREGROUND_PROCESS', { runtimeStatusHint: 'error' as const, reason: 'UNSUPPORTED_FOREGROUND_PROCESS', paneState: 'other' as const }],
  ])('R14：%s 观测不可注入 → 不补派，进入预算告警通道', async (_name, over) => {
    const t = await seedTask();
    await seedQa();
    manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    obs(over);
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa');
    const rec = mkReconciler({ busyWaitBudgetMs: 0 });

    await new Promise(r => setTimeout(r, 5));
    await rec.pollOnce();

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(interventions()).toHaveLength(1);
    expect(manager.getPendingDispatchRetry(t.id)).toBeTruthy();
  });

  it('CX3：stalled-idle 兜底要求观测晚于本 pass 的 reviewDispatchedAt（换绑残留旧空闲不触发）', async () => {
    await seedTask({ reviewDispatchedAt: new Date(Date.now() + 120_000).toISOString() });
    await seedQa();
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa');

    await mkReconciler().pollOnce();

    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('R15/R20：内部重排的预算随 armedToken fence 在登记时注入，since/alerted 延续且不计次', async () => {
    const t = await seedTask();
    await seedQa();
    manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    manager.markPendingDispatchRetryBudgetAlerted(t.id, { agentId: 'qa-1', signalToken: t.signalToken! });
    const original = manager.getPendingDispatchRetry(t.id)!;
    obs();
    vi.spyOn(manager, 'dispatchReviewToQa').mockImplementation(async (taskId, opts) => {
      const fresh = (await taskStore.get(taskId))!;
      const rotated = { ...fresh, signalToken: 'tok-requeue1', updatedAt: new Date().toISOString() };
      await taskStore.set(rotated);
      // 模拟 startSession 的 fence 注入：内部重排的登记携带 pendingBudget override
      manager.registerPendingDispatchRetry(
        taskId,
        { kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'tok-requeue1' },
        opts?.pendingBudget,
      );
      return rotated;
    });
    const rec = mkReconciler({ maxAttempts: 1 });

    await rec.pollOnce();

    const after = manager.getPendingDispatchRetry(t.id)!;
    expect(after.signalToken).toBe('tok-requeue1');
    expect(after.since).toBe(original.since);
    expect(after.budgetAlerted).toBe(true);
    expect(interventions()).toHaveLength(0);

    obs();
    const dispatchSpy2 = vi.spyOn(manager, 'dispatchReviewToQa').mockResolvedValue({
      ...(await taskStore.get(t.id))!, signalToken: 'tok-final1',
    });
    await rec.pollOnce();
    expect(dispatchSpy2).toHaveBeenCalledTimes(1);
  });

  it('R20：await 窗口内的外部 successor 登记不被内部重排污染（保留新鲜预算与告警位）', async () => {
    const t = await seedTask();
    await seedQa();
    manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    manager.markPendingDispatchRetryBudgetAlerted(t.id, { agentId: 'qa-1', signalToken: t.signalToken! });
    const original = manager.getPendingDispatchRetry(t.id)!;
    obs();
    vi.spyOn(manager, 'dispatchReviewToQa').mockImplementation(async (taskId) => {
      const fresh = (await taskStore.get(taskId))!;
      const rotated = { ...fresh, signalToken: 'internal-res1', updatedAt: new Date().toISOString() };
      await taskStore.set(rotated);
      // 生产中原登记至少早一个对账周期；测试里隔开毫秒钟面避免同毫秒巧合
      await new Promise(r => setTimeout(r, 3));
      // 外部 successor（push/手工重派）在 await 窗口内登记：不带 budget override
      manager.registerPendingDispatchRetry(
        taskId,
        { kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'external-succ1' },
      );
      return rotated;
    });

    await mkReconciler().pollOnce();

    const after = manager.getPendingDispatchRetry(t.id)!;
    expect(after.signalToken).toBe('external-succ1');
    expect(after.since).toBeGreaterThan(original.since);
    expect(after.budgetAlerted).toBeUndefined();
  });

  it('R16：可恢复 hold 补派读取持久化的未计轮 intent（首评起点 bumpRound:true + qaPhase:review）', async () => {
    const t = await seedTask({ reviewRound: 0, reviewRoundPending: true });
    await seedQa({
      status: 'awaiting_human',
      awaitingPhase: 'checkout-preparation-failed',
      awaitingSince: NOW,
    });
    obs();
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa')
      .mockResolvedValue({ ...t, signalToken: 'tok-hold1' });

    await mkReconciler().pollOnce();

    expect(dispatchSpy).toHaveBeenCalledWith(t.id, expect.objectContaining({
      bumpRound: true,
      qaPhase: 'review',
    }));
  });

  it('R17：进程重启（无内存登记）+ anchor 缺失 + PENDING_IDLE → 有界刷新后按持久化 intent 补派', async () => {
    const t = await seedTask({
      reviewRound: 0, reviewRoundPending: true,
      reviewHeadAnchorSha: undefined, latestHeadSha: undefined,
    });
    await seedQa();
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    vi.spyOn(manager, 'fetchPrHeadSha').mockResolvedValue(SHA);
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa')
      .mockResolvedValue({ ...t, signalToken: 'tok-restart1' });

    await mkReconciler().pollOnce();

    expect(dispatchSpy).toHaveBeenCalledWith(t.id, expect.objectContaining({
      bumpRound: true,
      qaPhase: 'review',
    }));
  });

  it('R18：预算告警落盘窗口内换代 → 标记只落在原登记代，successor 不受污染', async () => {
    const t = await seedTask();
    await seedQa();
    manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    obs({ runtimeStatusHint: 'working' });
    vi.spyOn(eventBus, 'emit').mockImplementationOnce(async () => {
      manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'succ-gen1' });
    });
    const rec = mkReconciler({ busyWaitBudgetMs: 0 });

    await new Promise(r => setTimeout(r, 5));
    await rec.pollOnce();

    expect(manager.getPendingDispatchRetry(t.id)).toMatchObject({ signalToken: 'succ-gen1' });
    expect(manager.getPendingDispatchRetry(t.id)?.budgetAlerted).toBeUndefined();
  });

  it('R18：taskStore.list 缺行（返回空）时 pending/计数不得被当孤儿清掉', async () => {
    const t = await seedTask();
    manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    vi.spyOn(taskStore, 'list').mockResolvedValue([]);

    await mkReconciler().pollOnce();

    expect(manager.getPendingDispatchRetry(t.id)).toBeTruthy();
  });

  it('R18：prune 单读失败 fail closed 保留登记', async () => {
    const t = await seedTask({ status: 'merged' });
    manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    vi.spyOn(taskStore, 'list').mockResolvedValue([]);
    vi.spyOn(taskStore, 'get').mockRejectedValue(new Error('EIO'));

    await mkReconciler().pollOnce();

    expect(manager.getPendingDispatchRetry(t.id)).toBeTruthy();
  });

  it('R19：无 token 世代耗尽后，真实 pass 建立即重置计数恢复补派', async () => {
    const t = await seedTask({ signalToken: undefined });
    await seedQa();
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa')
      .mockRejectedValue(new ApiError(409, 'QA agent qa-1 is busy or unavailable'));
    const rec = mkReconciler({ maxAttempts: 1 });

    await rec.pollOnce();
    await rec.pollOnce();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(interventions()).toHaveLength(1);

    await taskStore.set({ ...(await taskStore.get(t.id))!, signalToken: 'real-token01', updatedAt: new Date().toISOString() });
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    await rec.pollOnce();
    expect(dispatchSpy).toHaveBeenCalledTimes(2);
  });

  it('CX1：git 模式 fixing 任务的 dev-fix pending 不被清掉且由对账补投', async () => {
    const t = await seedTask({ status: 'fixing', reviewMode: 'git' });
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: t.id, workdir: '/tmp/repo',
      paneId: '%1', startedAt: NOW, updatedAt: NOW,
    } as AgentBindingFacts);
    manager.registerPendingDispatchRetry(t.id, { kind: 'dev-fix', agentId: 'dev-1', signalToken: t.signalToken! });
    statusStore.set('dev-1', { tmuxSessionStatus: 'present', observedAt: freshObservedAt() });
    const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);

    await mkReconciler().pollOnce();

    expect(continueSpy).toHaveBeenCalledWith(t.id, 'dev-1', 'fix', expect.objectContaining({
      signalToken: t.signalToken,
    }));
  });

  it('git 模式 busy pending 由对账的观测门消费（sweep 让位），hold/绑定丢失仍归 git 机制（R21/CX-3.2）', async () => {
    const t = await seedTask({ reviewMode: 'git' });
    await seedQa();
    manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    obs();
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa')
      .mockResolvedValue({ ...t, signalToken: 'tok-git-1' });

    await mkReconciler().pollOnce();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);

    dispatchSpy.mockClear();
    const t2 = await seedTask({ id: 'task-git-hold', reviewMode: 'git' });
    await agentStore.set({
      id: 'qa-1', projectId: 'proj', taskId: t2.id, workdir: '/tmp/repo-qa', paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed', awaitingSince: NOW,
      startedAt: NOW, updatedAt: NOW,
    } as AgentBindingFacts);
    await taskStore.set({ ...t, status: 'merged', updatedAt: new Date().toISOString() });
    await mkReconciler().pollOnce();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('R22：任务确认删除（get 返回 null）时按代清理登记与计数', async () => {
    const t = await seedTask();
    manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    vi.spyOn(taskStore, 'list').mockResolvedValue([]);
    vi.spyOn(taskStore, 'get').mockResolvedValue(null);

    await mkReconciler().pollOnce();

    expect(manager.getPendingDispatchRetry(t.id)).toBeUndefined();
  });

  it('CX-3.3：QA 绑定丢失 + anchor 缺失 → 驻留后有界刷新 head 再重建派发', async () => {
    const t = await seedTask({ reviewHeadAnchorSha: undefined, latestHeadSha: undefined });
    await seedQa({ taskId: undefined });
    obs();
    vi.spyOn(manager, 'fetchPrHeadSha').mockResolvedValue(SHA);
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa')
      .mockResolvedValue({ ...t, signalToken: 'tok-unbound1' });
    const rec = mkReconciler();

    await rec.pollOnce();
    expect(dispatchSpy).not.toHaveBeenCalled();
    await rec.pollOnce();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it('CX-3.5：hold 重放不沿用旧 pass 残留的 pending（先按代清掉，不传 stale 相位）', async () => {
    const t = await seedTask({ signalToken: 'new-pass-tok1' });
    await seedQa({
      status: 'awaiting_human',
      awaitingPhase: 'checkout-preparation-failed',
      awaitingSince: NOW,
    });
    manager.registerPendingDispatchRetry(t.id, {
      kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'old-pass-tok1', qaPhase: 'review',
    });
    obs();
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa')
      .mockResolvedValue({ ...t, signalToken: 'tok-hold2' });

    await mkReconciler().pollOnce();

    expect(manager.getPendingDispatchRetry(t.id)).toBeUndefined();
    const opts = dispatchSpy.mock.calls[0][1]!;
    expect(opts.qaPhase).toBeUndefined();
    expect(opts.expectSignalToken).toBe('new-pass-tok1');
  });
});

describe('DispatchReconciler 端到端补派（验收 #1 后半）', () => {
  it('pending + QA 空闲 → 真实 dispatchReviewToQa 补派：token 轮换、round 不加、watcher 重装、QA 重新绑定', async () => {
    const t = await seedTask({ reviewRound: 2, signalToken: 'tok-current1' });
    await seedQa({ workdir: undefined });
    await lockManager.acquire('qa-1', t.id).then(async (tok) => {
      await agentStore.update('qa-1', (s) => ({ ...s!, lockToken: tok! }));
    });
    manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'tok-current1' });
    obs();
    vi.spyOn(manager, 'fetchPrHeadSha').mockResolvedValue(SHA);
    const armSpy = vi.spyOn(
      manager as unknown as { setupPhaseSignalWatcher: (...a: unknown[]) => Promise<boolean> },
      'setupPhaseSignalWatcher',
    ).mockResolvedValue(true);
    vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    await mkReconciler().pollOnce();

    const after = (await taskStore.get(t.id))!;
    expect(after.status).toBe('review');
    expect(after.signalToken).not.toBe('tok-current1');
    expect(after.reviewRound).toBe(2);
    expect(after.reviewHeadAnchorSha).toBe(SHA);
    expect(armSpy).toHaveBeenCalledWith(
      t.id, 'qa-1', ['pr-approved', 'pr-changes-requested'], after.signalToken, expect.any(Object),
    );
    const qa = await agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.status).toBeUndefined();
    expect(manager.getPendingDispatchRetry(t.id)).toBeUndefined();
    expect(audits()).toHaveLength(1);
    expect(interventions()).toHaveLength(0);
  });
});

describe('DispatchReconciler fixing 侧 re-continue', () => {
  async function seedDev(over: Partial<AgentBindingFacts> = {}): Promise<void> {
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: 'task-1',
      workdir: '/tmp/repo',
      paneId: '%1',
      startedAt: NOW,
      updatedAt: NOW,
      ...over,
    } as AgentBindingFacts);
  }

  function devObs(over: Partial<TmuxSessionObservation> = {}): void {
    statusStore.set('dev-1', { tmuxSessionStatus: 'present', observedAt: freshObservedAt(), ...over });
  }

  it('pending dev-fix + 探测非忙 → continueSession(fix) 补投；成功清除登记并留审计', async () => {
    const t = await seedTask({ status: 'fixing' });
    await seedDev();
    manager.registerPendingDispatchRetry(t.id, { kind: 'dev-fix', agentId: 'dev-1', signalToken: t.signalToken });
    devObs();
    const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);

    await mkReconciler().pollOnce();

    expect(continueSpy).toHaveBeenCalledWith(t.id, 'dev-1', 'fix', expect.objectContaining({
      signalToken: t.signalToken,
      guardBeforeInject: expect.any(Function),
    }));
    expect(manager.getPendingDispatchRetry(t.id)).toBeUndefined();
    expect(audits()).toHaveLength(1);
  });

  it('无登记兜底：fixing + dev 绑定 + PENDING_IDLE → re-continue', async () => {
    const t = await seedTask({ status: 'fixing' });
    await seedDev();
    devObs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);

    await mkReconciler().pollOnce();

    expect(continueSpy).toHaveBeenCalledWith(t.id, 'dev-1', 'fix', expect.objectContaining({
      signalToken: t.signalToken,
    }));
  });

  it('dev 正在等用户输入（needInputAt）→ 兜底不得覆盖问题，不 re-continue', async () => {
    await seedTask({ status: 'fixing' });
    await seedDev({ needInputAt: NOW });
    devObs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    const continueSpy = vi.spyOn(manager, 'continueSession');

    await mkReconciler().pollOnce();

    expect(continueSpy).not.toHaveBeenCalled();
  });

  it('pending dev-fix + 探测忙碌 → 等待，不补投', async () => {
    const t = await seedTask({ status: 'fixing' });
    await seedDev();
    manager.registerPendingDispatchRetry(t.id, { kind: 'dev-fix', agentId: 'dev-1', signalToken: t.signalToken });
    devObs({ runtimeStatusHint: 'working' });
    const continueSpy = vi.spyOn(manager, 'continueSession');

    await mkReconciler().pollOnce();

    expect(continueSpy).not.toHaveBeenCalled();
    expect(manager.getPendingDispatchRetry(t.id)).toBeTruthy();
  });

  it('continueSession 返回 false（门禁拒绝）也消费重试额度，耗尽后升级且指引不指向 QA 接口（R1/R11）', async () => {
    const t = await seedTask({ status: 'fixing' });
    await seedDev();
    manager.registerPendingDispatchRetry(t.id, { kind: 'dev-fix', agentId: 'dev-1', signalToken: t.signalToken! });
    devObs();
    const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(false);
    const rec = mkReconciler({ maxAttempts: 2 });

    await rec.pollOnce();
    await rec.pollOnce();
    await rec.pollOnce();
    await rec.pollOnce();

    expect(continueSpy).toHaveBeenCalledTimes(2);
    const alerts = interventions();
    expect(alerts).toHaveLength(1);
    expect(String(alerts[0].data.note)).toContain('Restart REPL');
    expect(String(alerts[0].data.note)).toContain('do NOT use POST /tasks/:id/review');
    expect(String(alerts[0].data.note)).not.toContain('Resume the agent or POST /tasks/:id/review');
  });

  it('pending dev-fix 但 dev 已进入 awaiting_human → 不得覆盖 hold，pane 不投递（C5）', async () => {
    const t = await seedTask({ status: 'fixing' });
    await seedDev({ status: 'awaiting_human', awaitingPhase: 'runtime-missing', awaitingSince: NOW });
    manager.registerPendingDispatchRetry(t.id, { kind: 'dev-fix', agentId: 'dev-1', signalToken: t.signalToken! });
    devObs();
    const continueSpy = vi.spyOn(manager, 'continueSession');

    await mkReconciler().pollOnce();

    expect(continueSpy).not.toHaveBeenCalled();
    expect(manager.getPendingDispatchRetry(t.id)).toBeTruthy();
  });

  it('任务离开活跃补派状态后清理登记与计数', async () => {
    const t = await seedTask({ status: 'merged' });
    manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken });

    await mkReconciler().pollOnce();

    expect(manager.getPendingDispatchRetry(t.id)).toBeUndefined();
  });
});

describe('DispatchReconciler 第 11 轮加固（R28/R29/R30/CX-5.x）', () => {
  it('CX-5.2：补派自轮换 pass 后失败，世系按失败后的实际 pass 延续，预算不被重置', async () => {
    await seedTask();
    await seedQa({
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed', awaitingSince: NOW,
    });
    obs();
    let gen = 0;
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa').mockImplementation(async (taskId) => {
      gen += 1;
      const fresh = (await taskStore.get(taskId))!;
      await taskStore.set({ ...fresh, signalToken: `tok-armed-${gen}`, updatedAt: new Date().toISOString() });
      throw new Error('checkout preparation failed again (handled hold)');
    });
    const rec = mkReconciler({ maxAttempts: 2 });

    await rec.pollOnce();
    await rec.pollOnce();
    await rec.pollOnce();
    await rec.pollOnce();

    expect(dispatchSpy).toHaveBeenCalledTimes(2);
    const alerts = interventions();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].data).toMatchObject({ phase: 'dispatch-reconcile-attempts-exhausted' });
  });

  it('R29：git 模式 pending + anchor 缺失 → 不经 gh 刷新（平台 driver 在补派内重新锚定）', async () => {
    const t = await seedTask({ reviewMode: 'git', reviewHeadAnchorSha: undefined, latestHeadSha: undefined });
    await seedQa();
    manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    obs();
    const fetchSpy = vi.spyOn(manager, 'fetchPrHeadSha')
      .mockRejectedValue(new Error('gh unavailable for gitCli platform'));
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa')
      .mockResolvedValue({ ...t, signalToken: 'tok-git-re1' });

    await mkReconciler().pollOnce();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it('R30：git 模式 QA 绑定丢失（durable pending 已清、sweep 无凭据）→ 驻留两周期后由对账补派', async () => {
    const t = await seedTask({ reviewMode: 'git' });
    await seedQa({ taskId: undefined });
    obs();
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa')
      .mockResolvedValue({ ...t, signalToken: 'tok-git-ub1' });
    const rec = mkReconciler();

    await rec.pollOnce();
    expect(dispatchSpy).not.toHaveBeenCalled();
    await rec.pollOnce();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it('R30：git 模式送达后静默失联（PENDING_IDLE 无 verdict）→ 无登记兜底补派', async () => {
    const t = await seedTask({ reviewMode: 'git' });
    await seedQa();
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa')
      .mockResolvedValue({ ...t, signalToken: 'tok-git-si1' });

    await mkReconciler().pollOnce();

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it('CX-5.1：git pending 登记 + QA 解绑 → 不再双让位（对账驻留后补派并消费登记）', async () => {
    const t = await seedTask({ reviewMode: 'git' });
    await seedQa({ taskId: undefined });
    manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    obs();
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa')
      .mockResolvedValue({ ...t, signalToken: 'tok-git-ub2' });
    const rec = mkReconciler();

    await rec.pollOnce();
    await rec.pollOnce();

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(manager.getPendingDispatchRetry(t.id)).toBeUndefined();
  });

  it('R28：pending + 探测 unreachable 超预算 → 一次性 dispatch-busy-budget-exhausted，不注入', async () => {
    const t = await seedTask();
    await seedQa();
    manager.registerPendingDispatchRetry(
      t.id,
      { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! },
      { since: Date.now() - 60_000 },
    );
    statusStore.set('qa-1', { tmuxSessionStatus: 'unreachable' });
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa');
    const rec = mkReconciler({ busyWaitBudgetMs: 0 });

    await rec.pollOnce();
    await rec.pollOnce();

    expect(dispatchSpy).not.toHaveBeenCalled();
    const alerts = interventions().filter(e => (e.data as { phase?: string }).phase === 'dispatch-busy-budget-exhausted');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].data).toMatchObject({ observationStatus: 'unreachable' });
  });

  it('R28：dev-fix pending + 探测 unreachable 超预算 → 同样进入预算告警通道', async () => {
    const t = await seedTask({ status: 'fixing' });
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: t.id, workdir: '/tmp/repo',
      paneId: '%1', startedAt: NOW, updatedAt: NOW,
    } as AgentBindingFacts);
    manager.registerPendingDispatchRetry(
      t.id,
      { kind: 'dev-fix', agentId: 'dev-1', signalToken: t.signalToken! },
      { since: Date.now() - 60_000 },
    );
    statusStore.set('dev-1', { tmuxSessionStatus: 'unreachable' });
    const continueSpy = vi.spyOn(manager, 'continueSession');

    await mkReconciler({ busyWaitBudgetMs: 0 }).pollOnce();

    expect(continueSpy).not.toHaveBeenCalled();
    const alerts = interventions().filter(e => (e.data as { phase?: string }).phase === 'dispatch-busy-budget-exhausted');
    expect(alerts).toHaveLength(1);
  });

  it('R42：dev-fix pending 但 dev 绑定丢失 → 有界升级为 intervention，不静默留着无人可送的 fix', async () => {
    const t = await seedTask({ status: 'fixing' });
    // dev 绑定已丢失/改派：continueSession 无从投递
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', workdir: '/tmp/repo', paneId: '%1',
      startedAt: NOW, updatedAt: NOW,
    } as AgentBindingFacts);
    manager.registerPendingDispatchRetry(t.id, { kind: 'dev-fix', agentId: 'dev-1', signalToken: t.signalToken! });
    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present', observedAt: freshObservedAt(),
      runtimeStatusHint: 'pending', reason: 'PENDING_IDLE',
    });
    const continueSpy = vi.spyOn(manager, 'continueSession');
    const rec = mkReconciler({ maxAttempts: 2 });

    await rec.pollOnce();
    await rec.pollOnce();
    await rec.pollOnce();
    await rec.pollOnce();

    expect(continueSpy).not.toHaveBeenCalled();
    const alerts = interventions().filter(e => (e.data as { phase?: string }).phase === 'dispatch-reconcile-attempts-exhausted');
    expect(alerts).toHaveLength(1);
    expect(String((alerts[0].data as { note?: string }).note)).toMatch(/no longer bound/i);
  });

  it('R37：verdict 在 await 窗口内接管 → 不把 successor 的 token 记成本次补派的世系', async () => {
    const t = await seedTask();
    await seedQa();
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: t.id, workdir: '/tmp/repo', paneId: '%1',
      startedAt: NOW, updatedAt: NOW,
    } as AgentBindingFacts);
    manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    vi.spyOn(manager, 'dispatchReviewToQa').mockImplementation(async (taskId, opts) => {
      opts?.onPassArmed?.('armed-review-tok');
      // await 窗口内 REQUEST_CHANGES 接管：切 fixing、轮换 token 并登记 dev-fix pending
      const fresh = (await taskStore.get(taskId))!;
      const takenOver = {
        ...fresh, status: 'fixing' as const, signalToken: 'fix-tok-1', updatedAt: new Date().toISOString(),
      };
      await taskStore.set(takenOver);
      manager.registerPendingDispatchRetry(taskId, { kind: 'dev-fix', agentId: 'dev-1', signalToken: 'fix-tok-1' });
      return takenOver;
    });
    const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);
    const rec = mkReconciler({ maxAttempts: 1 });

    await rec.pollOnce();

    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present', observedAt: freshObservedAt(),
      runtimeStatusHint: 'pending', reason: 'PENDING_IDLE',
    });
    await rec.pollOnce();

    expect(continueSpy).toHaveBeenCalledTimes(1);
    expect(interventions().filter(e => (e.data as { phase?: string }).phase === 'dispatch-reconcile-attempts-exhausted'))
      .toHaveLength(0);
  });

  it('R36：同一份观测只驱动一次补派——内部重排后不再每周期空转 release/acquire/轮换', async () => {
    const t = await seedTask();
    await seedQa();
    manager.registerPendingDispatchRetry(
      t.id,
      { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! },
      { since: Date.now() - 10_000 },
    );
    // 生产中的观测时刻为真实过去时；粗粒度探测说 idle，而 stable-idle 判定仍会判忙 → 内部重排
    statusStore.set('qa-1', {
      tmuxSessionStatus: 'present', observedAt: new Date(Date.now() - 5_000).toISOString(),
    });
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa').mockImplementation(async (taskId, opts) => {
      const fresh = (await taskStore.get(taskId))!;
      const rotated = { ...fresh, signalToken: `tok-req-${dispatchSpy.mock.calls.length}`, updatedAt: new Date().toISOString() };
      await taskStore.set(rotated);
      manager.registerPendingDispatchRetry(
        taskId,
        { kind: 'qa-recheck', agentId: 'qa-1', signalToken: rotated.signalToken! },
        opts?.pendingBudget,
      );
      return rotated;
    });
    const rec = mkReconciler({ busyWaitBudgetMs: 1 });

    await rec.pollOnce();
    await rec.pollOnce();
    await rec.pollOnce();

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it('R36：内部重排后等待预算照常到期——发一次性 intervention，不静默 churn', async () => {
    const t = await seedTask();
    await seedQa();
    manager.registerPendingDispatchRetry(
      t.id,
      { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! },
      { since: Date.now() - 10_000 },
    );
    statusStore.set('qa-1', {
      tmuxSessionStatus: 'present', observedAt: new Date(Date.now() - 5_000).toISOString(),
    });
    vi.spyOn(manager, 'dispatchReviewToQa').mockImplementation(async (taskId, opts) => {
      const fresh = (await taskStore.get(taskId))!;
      const rotated = { ...fresh, signalToken: 'tok-req-b1', updatedAt: new Date().toISOString() };
      await taskStore.set(rotated);
      manager.registerPendingDispatchRetry(
        taskId,
        { kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'tok-req-b1' },
        opts?.pendingBudget,
      );
      return rotated;
    });
    const rec = mkReconciler({ busyWaitBudgetMs: 1 });

    await rec.pollOnce();
    await rec.pollOnce();
    await rec.pollOnce();

    const alerts = interventions().filter(e => (e.data as { phase?: string }).phase === 'dispatch-busy-budget-exhausted');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].data).toMatchObject({ kind: 'qa-recheck' });
  });

  it('R36：等到真正新鲜的空闲观测后恢复补派（水位线不是永久闸门）', async () => {
    const t = await seedTask();
    await seedQa();
    manager.registerPendingDispatchRetry(
      t.id,
      { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! },
      { since: Date.now() - 10_000 },
    );
    statusStore.set('qa-1', {
      tmuxSessionStatus: 'present', observedAt: new Date(Date.now() - 5_000).toISOString(),
    });
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa').mockImplementation(async (taskId, opts) => {
      const fresh = (await taskStore.get(taskId))!;
      const rotated = { ...fresh, signalToken: `tok-req2-${dispatchSpy.mock.calls.length}`, updatedAt: new Date().toISOString() };
      await taskStore.set(rotated);
      manager.registerPendingDispatchRetry(
        taskId,
        { kind: 'qa-recheck', agentId: 'qa-1', signalToken: rotated.signalToken! },
        opts?.pendingBudget,
      );
      return rotated;
    });
    const rec = mkReconciler();

    await rec.pollOnce();
    await rec.pollOnce();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);

    obs();
    await rec.pollOnce();
    expect(dispatchSpy).toHaveBeenCalledTimes(2);
  });

  it('R32：pending 补派前复核 needInputAt——QA 正等人回答时不得覆盖问题（与兜底同门禁）', async () => {
    const t = await seedTask();
    await seedQa({ needInputAt: new Date().toISOString() });
    manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: t.signalToken! });
    obs({ runtimeStatusHint: 'pending', reason: 'PENDING_IDLE' });
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa');

    await mkReconciler().pollOnce();

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(manager.getPendingDispatchRetry(t.id)).toBeTruthy();
  });

  it('R32：等人回答的阻塞同样有界升级（超预算一次性告警，标注 blockedBy）', async () => {
    const t = await seedTask();
    await seedQa({ needInputAt: new Date().toISOString() });
    manager.registerPendingDispatchRetry(
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
    expect(alerts[0].data).toMatchObject({ blockedBy: 'need-input' });
  });

  it('R32：dev-fix pending 补派前同样复核 needInputAt', async () => {
    const t = await seedTask({ status: 'fixing' });
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: t.id, workdir: '/tmp/repo', paneId: '%1',
      needInputAt: new Date().toISOString(), startedAt: NOW, updatedAt: NOW,
    } as AgentBindingFacts);
    manager.registerPendingDispatchRetry(t.id, { kind: 'dev-fix', agentId: 'dev-1', signalToken: t.signalToken! });
    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present', observedAt: freshObservedAt(),
      runtimeStatusHint: 'pending', reason: 'PENDING_IDLE',
    });
    const continueSpy = vi.spyOn(manager, 'continueSession');

    await mkReconciler().pollOnce();

    expect(continueSpy).not.toHaveBeenCalled();
    expect(manager.getPendingDispatchRetry(t.id)).toBeTruthy();
  });

  it('CX-5.3：丢绑驻留计数按 pass 世系归零（外部换代后不得继承旧 pass 的驻留）', async () => {
    const t = await seedTask();
    await seedQa({ taskId: undefined });
    obs();
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa')
      .mockResolvedValue({ ...t, signalToken: 'tok-after' });
    const rec = mkReconciler();

    await rec.pollOnce();
    expect(dispatchSpy).not.toHaveBeenCalled();

    const fresh = (await taskStore.get(t.id))!;
    await taskStore.set({ ...fresh, signalToken: 'tok-ext-rotated', updatedAt: new Date().toISOString() });

    await rec.pollOnce();
    expect(dispatchSpy).not.toHaveBeenCalled();
    await rec.pollOnce();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });
});
