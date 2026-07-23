import type { BaxianConfig, TaskState } from '../shared/index.js';
import { isSpecStagePhase } from '../shared/index.js';
import type { EventBus } from '../event/bus.js';
import type { AgentStore } from '../state/agent-store.js';
import type { TaskStore } from '../state/task-store.js';
import { ApiError } from '../errors.js';
import { PeriodicTaskRunner } from '../timing/periodic-task-runner.js';
import type { TmuxSessionStatusStore, TmuxSessionObservation } from './tmux-probe-poller.js';
import {
  type AgentManager,
  type PendingDispatchRetry,
} from './manager.js';

export interface DispatchReconcilerOptions {
  manager: AgentManager;
  taskStore: TaskStore;
  agentStore: AgentStore;
  statusStore: TmuxSessionStatusStore;
  eventBus: EventBus;
  intervalMs: number;
  busyWaitBudgetMs: number;
  maxAttempts: number;
}

type ReconcileAction =
  | 'pending-busy-cleared'
  | 'stalled-idle'
  | 'qa-unbound'
  | 'dev-fix-pending'
  | 'dev-fix-stalled-idle'
  | 'dev-fix-unbound';

interface AttemptRecord {
  count: number;
  alerted: boolean;
  passToken?: string;
  lastDispatchAtMs?: number;
}

// 绑定丢失可能只是一次在途派发的 release→acquire 缝隙，驻留两周期再动手。
const UNBOUND_DWELL_CYCLES = 2;

// 这些 409 由并发接管/入口互斥产生，会随下一周期自然消解，不消耗重试额度；
// 其余 409（跨任务占用、不可恢复 hold、release 失败等）是持久门禁，必须计次直至升级人工。
const NO_COUNT_API_CODES = new Set(['dispatch-superseded', 'dispatch-in-flight']);

// 派发级对账兜底（#558 M2 B3）：消费 TmuxProbePoller 的观察结果 + manager 的 pending 登记，
// 把「QA 忙碌延后的 recheck / dev 忙碌延后的 fix / 可恢复 hold / 静默失联的 review pass」
// 经 M1 加固的标准入口补派。所有动作带次数上限与忙碌预算，超限一次性升级 intervention。
// 计轮意图读取持久化的 task.reviewRoundPending，进程重启后依然精确。
export class DispatchReconciler {
  private readonly periodicRunner: PeriodicTaskRunner;
  private opts: DispatchReconcilerOptions;
  private attempts = new Map<string, AttemptRecord>();
  // 驻留计数绑定 pass 世系：外部换代后新 pass 的 release→acquire 缝隙必须重新驻留，
  // 不得继承旧 pass 的观察周期（同一 pass 内换绑仍是同一次在途派发，token 不变）
  private unboundSeen = new Map<string, { seen: number; passToken?: string }>();

  constructor(options: DispatchReconcilerOptions) {
    this.opts = options;
    this.periodicRunner = new PeriodicTaskRunner({
      name: 'dispatch-reconciler',
      intervalMs: options.intervalMs,
      run: () => this.reconcile(),
      onError: err => console.warn('[dispatch-reconciler] cycle failed:', err),
    });
  }

  replaceConfig(validated: BaxianConfig): void {
    this.opts = {
      ...this.opts,
      busyWaitBudgetMs: validated.server.dispatchBusyWaitBudgetMs,
      maxAttempts: validated.server.dispatchReconcileMaxAttempts,
    };
    this.periodicRunner.reschedule(validated.server.dispatchReconcileIntervalMs);
  }

  start(): void {
    this.periodicRunner.start();
  }

  stop(): void {
    this.periodicRunner.stop();
  }

  async pollOnce(): Promise<void> {
    await this.periodicRunner.runOnce();
  }

  private async reconcile(): Promise<void> {
    const tasks = await this.opts.taskStore.list({});
    // 保护集只按状态划定：git/server 模式的登记不归本 poller 消费（git dev-fix 归本 poller、
    // git QA 归 retryPendingGitReviewDispatches），但都不得被当成孤儿清掉
    const protectedIds = new Set<string>();
    for (const task of tasks) {
      if (task.status === 'review' || task.status === 'fixing') protectedIds.add(task.id);
    }
    await this.pruneTrackers(protectedIds);
    for (const task of tasks) {
      if (isSpecStagePhase(task.phase)) continue;
      try {
        if (task.status === 'review' && task.reviewMode === 'git') {
          await this.reconcileReview(task);
        } else if (task.status === 'fixing' && task.reviewMode === 'git') {
          await this.reconcileFix(task);
        }
      } catch (err) {
        console.warn(`[dispatch-reconciler] task ${task.id} reconcile failed:`, err);
      }
    }
  }

  // 删除跟踪状态前用新鲜单读复核；list() 在 readdir/单文件故障下会缺行，快照缺席不能当不活跃。
  private async pruneTrackers(protectedIds: Set<string>): Promise<void> {
    const tracked = new Set<string>([
      ...this.attempts.keys(),
      ...this.unboundSeen.keys(),
      ...this.opts.manager.listPendingDispatchRetries().keys(),
    ]);
    for (const taskId of tracked) {
      if (protectedIds.has(taskId)) continue;
      const entrySnapshot = this.opts.manager.getPendingDispatchRetry(taskId);
      let fresh: TaskState | null;
      try {
        fresh = await this.opts.taskStore.get(taskId);
      } catch (err) {
        console.warn(`[dispatch-reconciler] prune skipped for ${taskId} (task read failed):`, err);
        continue;
      }
      // get() 的 null 是确定的 ENOENT（任务已删除），按孤儿清理；读取异常才 fail closed 保留
      if (fresh && (fresh.status === 'review' || fresh.status === 'fixing')) continue;
      this.attempts.delete(taskId);
      this.unboundSeen.delete(taskId);
      if (entrySnapshot) {
        this.opts.manager.clearPendingDispatchRetryIfMatches(taskId, {
          agentId: entrySnapshot.agentId,
          signalToken: entrySnapshot.signalToken,
        });
      }
    }
  }

  private async reconcileReview(task: TaskState): Promise<void> {
    const qaId = task.qaAgentId;
    if (!qaId || !task.prNumber) return;
    const anchor = task.reviewHeadAnchorSha?.toLowerCase();
    const head = task.latestHeadSha?.toLowerCase();
    // 明确的 anchor≠head 才让位 push 事件路径；任一缺失时 push 路径可能永不触发（poller 的
    // push 判定要求 latestHeadSha 在场），pending/hold 这类「确定欠一次派发」的分支须自行补齐
    if (anchor !== undefined && head !== undefined && anchor !== head) return;
    const qaState = await this.opts.agentStore.get(qaId);
    const entry = this.opts.manager.getPendingDispatchRetry(task.id);
    const observation = this.opts.statusStore.get(qaId);
    // git 模式的 hold 恢复归 sweep（durable pending 在场，60s 重试）；绑定丢失与送达后
    // 静默失联没有 durable 凭据（成功路径已清 pending），必须由对账兜底，否则永久停在 review。
    // anchor 缺失时补派内的平台 driver 会重新锚定并 fail loud。

    if (qaState?.taskId !== task.id) {
      const prev = this.unboundSeen.get(task.id);
      const seen = prev !== undefined && prev.passToken === task.signalToken ? prev.seen + 1 : 1;
      this.unboundSeen.set(task.id, { seen, passToken: task.signalToken });
      if (seen < UNBOUND_DWELL_CYCLES) return;
      await this.redispatchReview(task, qaId, 'qa-unbound');
      return;
    }
    this.unboundSeen.delete(task.id);

    if (qaState.status === 'awaiting_human') {
      return;
    }

    if (entry?.kind === 'qa-recheck') {
      if (entry.signalToken !== task.signalToken) {
        this.opts.manager.clearPendingDispatchRetryIfMatches(task.id, {
          agentId: entry.agentId,
          signalToken: entry.signalToken,
        });
        return;
      }
      // 一条规则：pending 每周期要么被消费，要么计入等待预算——任何不可消费的原因
      // （不可注入/探测失败/正等人回答/观测未更新）都不得让 dispatchBusyWaitBudgetMs 失去消费点。
      // needInput.at 在场说明该回合正等人回答（不落 awaiting_human 且静止后探测可注入），
      // 重投 review prompt 会覆盖问题——与无登记兜底同一门禁
      const awaitingAnswer = qaState.needInput?.at !== undefined;
      if (awaitingAnswer || !canInjectObservation(observation) || !this.observationDrivesRetry(task, observation, entry.since)) {
        await this.alertIfBudgetExhausted(task, entry, observation, qaId, awaitingAnswer);
        return;
      }
      await this.redispatchReview(task, qaId, 'pending-busy-cleared', entry, {
        since: entry.since,
        ...(entry.budgetAlerted === true ? { budgetAlerted: true } : {}),
      });
      return;
    }

    // 无登记兜底（含进程重启丢内存登记）：PENDING_IDLE 必须晚于本 pass 的派发时刻，
    // 否则 QA 换绑后残留的上一任务空闲观测会把刚启动的 review 当成卡住
    if (
      observation.tmuxSessionStatus === 'present'
      && observation.reason === 'PENDING_IDLE'
      && canInjectObservation(observation)
      && observedAfter(observation, task.reviewDispatchedAt)
      && qaState.needInput?.at === undefined
    ) {
      await this.redispatchReview(task, qaId, 'stalled-idle');
    }
  }

  private async reconcileFix(task: TaskState): Promise<void> {
    const devId = task.agentId;
    if (!devId) return;
    const entry = this.opts.manager.getPendingDispatchRetry(task.id);
    const observation = this.opts.statusStore.get(devId);

    if (entry?.kind === 'dev-fix') {
      if (entry.signalToken !== task.signalToken) {
        this.opts.manager.clearPendingDispatchRetryIfMatches(task.id, {
          agentId: entry.agentId,
          signalToken: entry.signalToken,
        });
        return;
      }
      // 登记后 dev 可能进入 hold/换绑：pending 只证明欠一次投递，投递前仍要确认 pane 可安全承接
      const devState = await this.opts.agentStore.get(devId);
      if (devState?.taskId !== task.id) {
        // 绑定丢失/改派后 continueSession 无从投递，而 fixing 任务受 prune 保护：
        // 不能静默留着一笔无人可送的 fix，按有界升级交人工（重新绑定属操作员决定，不自动改派）
        if (await this.consumeAttempt(task, devId, 'dev-fix-unbound')) this.recordAttempt(task, task.signalToken);
        return;
      }
      // hold 本身在 UI 可见，无需再升级
      if (devState.status === 'awaiting_human') return;
      // 与 review 侧同一条规则：不可消费即计入预算（不注入但有界升级）
      const awaitingAnswer = devState.needInput?.at !== undefined;
      if (awaitingAnswer || !canInjectObservation(observation) || !this.observationDrivesRetry(task, observation, entry.since)) {
        await this.alertIfBudgetExhausted(task, entry, observation, devId, awaitingAnswer);
        return;
      }
      await this.recontinueFix(task, devId, 'dev-fix-pending', entry.signalToken);
      return;
    }

    // 'waiting' 是派生视图态不落盘；兜底以「绑定 + 非 hold + 未在等用户输入 + 观察到持续静止」判定，
    // needInput.at 在场说明 dev 正等人回答，重投 fix prompt 会覆盖问题
    const devState = await this.opts.agentStore.get(devId);
    if (
      devState?.taskId === task.id
      && devState.status !== 'awaiting_human'
      && devState.needInput?.at === undefined
      && observation.tmuxSessionStatus === 'present'
      && observation.reason === 'PENDING_IDLE'
      && canInjectObservation(observation)
      && observedAfter(observation, task.fixDispatchedAt)
      && task.signalToken !== undefined
    ) {
      await this.recontinueFix(task, devId, 'dev-fix-stalled-idle', task.signalToken);
    }
  }

  // 阻塞态（working/STUCK_BUSY/PENDING_HUMAN/error 探测失败/非 runtime 前台）不可注入；
  // 阻塞超预算发一次性 intervention，事件成功落盘才按登记代 CAS 锁存告警标志。
  private async alertIfBudgetExhausted(
    task: TaskState,
    entry: PendingDispatchRetry,
    observation: TmuxSessionObservation,
    agentId: string,
    awaitingAnswer = false,
  ): Promise<void> {
    if (entry.budgetAlerted || Date.now() - entry.since <= this.opts.busyWaitBudgetMs) return;
    const emitted = await this.emitIntervention(task, agentId, {
      phase: 'dispatch-busy-budget-exhausted',
      kind: entry.kind,
      busySinceMs: entry.since,
      observationStatus: observation.tmuxSessionStatus,
      ...(awaitingAnswer ? { blockedBy: 'need-input' } : {}),
      ...(observation.reason !== undefined ? { observationReason: observation.reason } : {}),
      ...(observation.runtimeStatusHint !== undefined ? { observationHint: observation.runtimeStatusHint } : {}),
      note: `Agent ${agentId} has stayed busy/blocked/unreachable past the dispatch wait budget; the pending ${entry.kind} stays queued. ` +
        'Inspect the pane (answer the agent question, resolve the dialog, interrupt the turn, or restore connectivity) ' +
        'to let the reconciler dispatch it.',
    });
    if (emitted) {
      this.opts.manager.markPendingDispatchRetryBudgetAlerted(task.id, {
        agentId: entry.agentId,
        signalToken: entry.signalToken,
      });
    }
  }

  // 尝试计数绑定当前 pass 世系：reconciler 自己的补派把新 token 记入 passToken 延续计数；
  // 任何外部换代（push / 新一轮 fix / 手工重派 / legacy 无 token → 真实 token）都重置预算。
  private attemptsFor(task: TaskState): AttemptRecord {
    const rec = this.attempts.get(task.id);
    if (!rec) return { count: 0, alerted: false };
    if (rec.passToken !== task.signalToken) {
      this.attempts.delete(task.id);
      return { count: 0, alerted: false };
    }
    return rec;
  }

  private async consumeAttempt(task: TaskState, agentId: string, action: ReconcileAction): Promise<boolean> {
    const rec = this.attemptsFor(task);
    if (rec.count >= this.opts.maxAttempts) {
      if (!rec.alerted) {
        const recovery = action === 'dev-fix-unbound'
          ? `the dev agent is no longer bound to this task, so the queued fix has no deliverable target; re-assign the dev to task ${task.id} (or cancel/retry it). Do NOT use POST /tasks/:id/review — that routes to QA and would skip the requested changes.`
          : action.startsWith('dev-fix')
            ? 'the dev is not on an awaiting_human hold, so use Restart REPL on the dev agent (it replays the persisted fix prompt) or cancel/retry the task; do NOT use POST /tasks/:id/review — that routes to QA and would skip the requested changes.'
            : 'inspect the QA agent and redispatch manually (Resume the agent or POST /tasks/:id/review).';
        const emitted = await this.emitIntervention(task, agentId, {
          phase: 'dispatch-reconcile-attempts-exhausted',
          action,
          attempts: rec.count,
          note: `Automatic redispatch for task ${task.id} was attempted ${rec.count} times without the pass completing; ${recovery}`,
        });
        if (emitted) this.attempts.set(task.id, { ...rec, alerted: true });
      }
      return false;
    }
    return true;
  }

  private recordAttempt(task: TaskState, passToken: string | undefined): void {
    const rec = this.attemptsFor(task);
    this.attempts.set(task.id, {
      ...rec,
      count: rec.count + 1,
      alerted: rec.alerted,
      ...(passToken !== undefined ? { passToken } : {}),
    });
  }

  // 同一份空闲观测只驱动一次补派：补派自身的 stable-idle/pre-inject 判定比探测精细，
  // 判忙重排后必须等到更新的观测再动手，否则每周期空转 release/acquire/token 轮换
  private observationDrivesRetry(task: TaskState, observation: TmuxSessionObservation, sinceMs: number): boolean {
    if (!freshObservation(observation, sinceMs)) return false;
    const lastDispatchAtMs = this.attemptsFor(task).lastDispatchAtMs;
    return lastDispatchAtMs === undefined || freshObservation(observation, lastDispatchAtMs);
  }

  // 水位线必须与本次 pass 同代落库：attemptsFor 见 passToken 不符即整条重置，
  // 不带世系的记录会在下一次读取时连同水位线一起被当成外部换代抹掉
  private markDispatchAttempted(task: TaskState): void {
    const rec = this.attemptsFor(task);
    this.attempts.set(task.id, {
      ...rec,
      ...(task.signalToken !== undefined ? { passToken: task.signalToken } : {}),
      lastDispatchAtMs: Date.now(),
    });
  }

  private recordPassLineage(task: TaskState, passToken: string | undefined): void {
    const rec = this.attemptsFor(task);
    this.attempts.set(task.id, { ...rec, ...(passToken !== undefined ? { passToken } : {}) });
  }

  private async livePassToken(taskId: string, fallback: string | undefined): Promise<string | undefined> {
    try {
      const fresh = await this.opts.taskStore.get(taskId);
      return fresh?.signalToken ?? fallback;
    } catch (err) {
      console.warn(`[dispatch-reconciler] live pass read for ${taskId} failed; keeping decision-time lineage:`, err);
      return fallback;
    }
  }

  private async redispatchReview(
    task: TaskState,
    qaId: string,
    action: ReconcileAction,
    entryAtDecision?: PendingDispatchRetry,
    pendingBudget?: { since: number; budgetAlerted?: boolean },
  ): Promise<void> {
    if (!(await this.consumeAttempt(task, qaId, action))) return;
    this.markDispatchAttempted(task);
    const tokenAtDecision = task.signalToken;
    // 相位：登记时记录的原始相位优先；无登记时首轮（round=0）意味着初次 review 从未完成，按 review 重放。
    // 计轮：读持久化的 reviewRoundPending（该轮尚未入账），补派恰好补计一次，重启后依然成立
    const qaPhase = entryAtDecision?.qaPhase ?? (task.reviewRound === 0 ? 'review' : undefined);
    let result: TaskState;
    let armedToken: string | undefined;
    try {
      result = await this.opts.manager.dispatchReviewToQa(task.id, {
        bumpRound: task.reviewRoundPending === true,
        fromStatus: ['review'],
        expectPhase: task.phase,
        expectSignalToken: tokenAtDecision,
        ...(qaPhase !== undefined ? { qaPhase } : {}),
        ...(pendingBudget !== undefined ? { pendingBudget } : {}),
        onPassArmed: (armed) => { armedToken = armed; },
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code !== undefined && NO_COUNT_API_CODES.has(err.code)) {
        console.warn(`[dispatch-reconciler] redispatch ${task.id} (${action}) superseded by a concurrent pass: ${err.message}`);
        return;
      }
      // 失败前 dispatch 可能已自轮换 armed pass（如 handled hold 保持新 pass）：世系必须记到
      // 失败后的实际 token，否则下周期 attemptsFor 会当外部换代重置预算，持久 hold 永不达上限
      this.recordAttempt(task, await this.livePassToken(task.id, tokenAtDecision));
      console.warn(`[dispatch-reconciler] redispatch ${task.id} (${action}) failed:`, err);
      return;
    }
    const after = this.opts.manager.getPendingDispatchRetry(task.id);
    if (after?.kind === 'qa-recheck' && after.signalToken === tokenAtDecision) {
      // 只剩本次决策时的旧登记（未被 startSession 消费/换代），按已消费清理
      this.opts.manager.clearPendingDispatchRetryIfMatches(task.id, {
        agentId: after.agentId,
        signalToken: after.signalToken,
      });
    } else if (after?.kind === 'qa-recheck') {
      // 补派再次遇忙的内部重排：预算已随 armedToken fence 在登记时注入（since 保持原值），
      // 借这一点区分外部 successor——它的登记必然是新鲜 since，绝不等于原登记的旧时刻
      const internalRequeue = pendingBudget !== undefined
        && after.agentId === (entryAtDecision?.agentId ?? after.agentId)
        && after.since === pendingBudget.since;
      if (internalRequeue) {
        this.recordPassLineage(task, after.signalToken);
        console.warn(`[dispatch-reconciler] redispatch ${task.id} (${action}) queued again (QA busy)`);
      } else {
        console.warn(`[dispatch-reconciler] redispatch ${task.id} (${action}) superseded by an external pass; leaving its pending untouched`);
      }
      return;
    }
    // 返回值未必仍属本次 armed pass：await 窗口内 verdict/push 可接管（REQUEST_CHANGES 还会
    // 切 fixing 并登记 dev-fix pending）。世系只延续到可证明是本次铸造的 pass 上，
    // 否则连同预算一并作废——否则 review 补派的次数会挡住 successor（甚至另一 kind）的补投
    if (result.signalToken !== undefined && result.signalToken === armedToken) {
      this.recordAttempt(task, result.signalToken);
    } else {
      console.warn(
        `[dispatch-reconciler] redispatch ${task.id} (${action}) delivered but the pass was taken over ` +
        `(status=${result.status}); dropping this lineage`,
      );
      this.attempts.delete(task.id);
    }
    await this.audit(task, qaId, action);
  }

  private async recontinueFix(
    task: TaskState,
    devId: string,
    action: ReconcileAction,
    expectedToken: string,
  ): Promise<void> {
    if (!(await this.consumeAttempt(task, devId, action))) return;
    this.markDispatchAttempted(task);
    let resumed = false;
    try {
      // fence 延伸到最终 paste：continueSession 的多个 await 之后 pass 仍可能换代，
      // guardBeforeInject 在 composer/paste/Enter 各点复核，漂移即放弃投递
      resumed = await this.opts.manager.continueSession(task.id, devId, 'fix', {
        signalToken: expectedToken,
        guardBeforeInject: async () => {
          const fresh = await this.opts.taskStore.get(task.id);
          return fresh?.status === 'fixing' && fresh.signalToken === expectedToken;
        },
      });
    } catch (err) {
      this.recordAttempt(task, expectedToken);
      console.warn(`[dispatch-reconciler] fix re-continue ${task.id} (${action}) failed:`, err);
      return;
    }
    if (!resumed) {
      // 门禁拒绝（绑定/状态/Workdir/fence）同样消耗额度：持久性拒绝必须走有界升级而非每周期无限重试
      this.recordAttempt(task, expectedToken);
      console.warn(`[dispatch-reconciler] fix re-continue ${task.id} (${action}) skipped by dispatch gates`);
      return;
    }
    this.opts.manager.clearPendingDispatchRetryIfMatches(task.id, { agentId: devId, signalToken: expectedToken });
    this.recordAttempt(task, expectedToken);
    await this.audit(task, devId, action);
  }

  private async audit(task: TaskState, agentId: string, action: ReconcileAction): Promise<void> {
    console.log(`[dispatch-reconciler] task ${task.id}: ${action} redispatched via standard entry (agent=${agentId})`);
    try {
      await this.opts.eventBus.emit({
        id: '',
        type: 'agent.recovered',
        timestamp: new Date().toISOString(),
        projectId: task.projectId,
        agentId,
        taskId: task.id,
        data: { reason: 'dispatch-reconciled', action },
      });
    } catch (err) {
      console.warn(`[dispatch-reconciler] audit emit failed for ${task.id}:`, err);
    }
  }

  private async emitIntervention(task: TaskState, agentId: string, data: Record<string, unknown>): Promise<boolean> {
    try {
      await this.opts.eventBus.emit({
        id: '',
        type: 'human.intervention',
        timestamp: new Date().toISOString(),
        projectId: task.projectId,
        agentId,
        taskId: task.id,
        data,
      });
      return true;
    } catch (err) {
      console.warn(`[dispatch-reconciler] intervention emit failed for ${task.id}:`, err);
      return false;
    }
  }
}

// 只有明确的 live-runtime 空闲观测（含设计认可的 PENDING_IDLE）可以解除欠投递；
// 探测失败（error/PANE_PROBE_FAILED）、非 runtime 前台、菜单/冻结忙碌一律 fail closed。
function canInjectObservation(observation: TmuxSessionObservation): boolean {
  if (observation.tmuxSessionStatus !== 'present') return false;
  if (observation.paneState !== undefined && observation.paneState !== 'live-runtime') return false;
  if (observation.runtimeStatusHint === undefined) return true;
  return observation.runtimeStatusHint === 'pending' && observation.reason === 'PENDING_IDLE';
}

function freshObservation(observation: TmuxSessionObservation, sinceMs: number): boolean {
  if (observation.observedAt === undefined) return false;
  const observedMs = Date.parse(observation.observedAt);
  return Number.isFinite(observedMs) && observedMs > sinceMs;
}

function observedAfter(observation: TmuxSessionObservation, isoAnchor: string | undefined): boolean {
  if (isoAnchor === undefined) return false;
  const anchorMs = Date.parse(isoAnchor);
  if (!Number.isFinite(anchorMs)) return false;
  return freshObservation(observation, anchorMs);
}
