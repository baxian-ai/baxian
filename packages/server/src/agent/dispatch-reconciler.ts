import type { BaxianConfig, TaskState } from '../shared/index.js';
import { REVIEW_VERDICT_TIMEOUT_MS, taskReviewRound } from '../shared/index.js';
import type { EventBus } from '../event/bus.js';
import type { AgentStore } from '../state/agent-store.js';
import type { TaskStore } from '../state/task-store.js';
import { PeriodicTaskRunner } from '../timing/periodic-task-runner.js';
import type { TmuxSessionStatusStore, TmuxSessionObservation } from './tmux-probe-poller.js';
import { ReplNotReadyError } from './tmux.js';
import {
  type AgentManager,
  type PendingDispatchRetry,
  isBenignDispatchConflict,
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

const UNBOUND_DWELL_CYCLES = 2;

export class DispatchReconciler {
  private readonly periodicRunner: PeriodicTaskRunner;
  private opts: DispatchReconcilerOptions;
  private attempts = new Map<string, AttemptRecord>();
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

  resetTask(taskId: string): void {
    this.attempts.delete(taskId);
    this.unboundSeen.delete(taskId);
    this.opts.manager.resetPendingDispatchRetryBudget(taskId);
  }

  private async reconcile(): Promise<void> {
    await this.opts.manager.flushTaskOutboxes();
    const tasks = await this.opts.taskStore.list({});
    const protectedIds = new Set<string>();
    for (const task of tasks) {
      if (task.status === 'review' || task.status === 'fixing') protectedIds.add(task.id);
    }
    await this.pruneTrackers(protectedIds);
    for (const task of tasks) {
      try {
        if (task.status === 'review') {
          await this.reconcileReview(task);
        } else if (task.status === 'fixing') {
          await this.reconcileFix(task);
        } else if (task.status === 'in_progress') {
          await this.reconcileInitialDispatch(task);
        }
      } catch (err) {
        console.warn(`[dispatch-reconciler] task ${task.id} reconcile failed:`, err);
      }
    }
  }

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
    if (!task.qaAgentId) {
      throw new Error(`review task ${task.id} has no QA participant`);
    }
    if (task.outbox?.some(entry => entry.type === 'git.code-verdict')) return;
    const qaId = task.qaAgentId;
    const reviewStartedAt = task.reviewDispatchedAt ? Date.parse(task.reviewDispatchedAt) : Number.NaN;
    if (Number.isFinite(reviewStartedAt)
      && Date.now() - reviewStartedAt >= REVIEW_VERDICT_TIMEOUT_MS
      && task.attention === undefined) {
      const recovery = task.phase === 'spec'
        ? `QA has not completed the spec review for task ${task.id} within the review deadline. Advance to re-dispatch QA, or cancel the task.`
        : `QA has not submitted a verdict for task ${task.id} within the review deadline. Advance to re-dispatch QA, or submit a human verdict after inspecting the PR.`;
      await this.emitIntervention(task, qaId, {
        phase: 'review-verdict-overdue',
        reviewDispatchedAt: task.reviewDispatchedAt,
        note: recovery,
      });
    }
    if (!task.prNumber) return;
    const anchor = task.reviewHeadAnchorSha?.toLowerCase();
    const head = task.latestHeadSha?.toLowerCase();
    if (anchor !== undefined && head !== undefined && anchor !== head) return;
    const qaState = await this.opts.agentStore.get(qaId);
    const entry = this.opts.manager.getPendingDispatchRetry(task.id);
    const observation = this.opts.statusStore.get(qaId);

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

  private async reconcileInitialDispatch(task: TaskState): Promise<void> {
    const devId = task.agentId;
    if (!devId || task.attention !== undefined) return;
    const [devState, observation] = await Promise.all([
      this.opts.agentStore.get(devId),
      Promise.resolve(this.opts.statusStore.get(devId)),
    ]);
    if (devState?.taskId !== task.id
      || devState.status === 'awaiting_human'
      || devState.needInput?.at !== undefined
      || observation.reason !== 'PENDING_IDLE'
      || !canInjectObservation(observation)
      || !observedAfter(observation, task.updatedAt)) return;
    await this.emitIntervention(task, devId, {
      phase: 'initial-dispatch-stalled',
      note: `The dev agent is idle while task ${task.id} is still in progress. Advance with Dev to replay the persisted instruction, or choose QA to confirm an already completed delivery.`,
    });
  }

  private async reconcileFix(task: TaskState): Promise<void> {
    // QA housekeeping must never block the dev fix: a failed store read here is logged and retried next cycle
    await this.releaseQaDeferredWhileBusy(task).catch(err => {
      console.warn(`[dispatch-reconciler] deferred QA release for ${task.id} skipped this cycle:`, err);
    });
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
      const devState = await this.opts.agentStore.get(devId);
      if (devState?.taskId !== task.id) {
        if (await this.consumeAttempt(task, devId, 'dev-fix-unbound')) this.recordAttempt(task, task.signalToken);
        return;
      }
      if (devState.status === 'awaiting_human') return;
      const awaitingAnswer = devState.needInput?.at !== undefined;
      if (awaitingAnswer || !canInjectObservation(observation) || !this.observationDrivesRetry(task, observation, entry.since)) {
        await this.alertIfBudgetExhausted(task, entry, observation, devId, awaitingAnswer);
        return;
      }
      await this.recontinueFix(task, devId, 'dev-fix-pending', entry.signalToken);
      return;
    }

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
          ? `the dev agent is no longer bound to this task, so the queued fix has no deliverable target; restore the Dev binding, then use Advance with Dev (or cancel the task). Do not advance to QA because that would skip the requested changes.`
          : action.startsWith('dev-fix')
            ? 'use Advance with Dev to replay the persisted fix prompt, or cancel the task. Do not advance to QA because that would skip the requested changes.'
            : 'inspect the QA agent, then use Advance with QA to re-dispatch the review.';
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

  private observationDrivesRetry(task: TaskState, observation: TmuxSessionObservation, sinceMs: number): boolean {
    if (!freshObservation(observation, sinceMs)) return false;
    const lastDispatchAtMs = this.attemptsFor(task).lastDispatchAtMs;
    return lastDispatchAtMs === undefined || freshObservation(observation, lastDispatchAtMs);
  }

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
    const qaPhase = entryAtDecision?.qaPhase ?? (taskReviewRound(task) === 0 ? 'review' : undefined);
    let result: TaskState;
    let armedToken: string | undefined;
    try {
      result = await this.opts.manager.dispatchReviewToQa(task.id, {
        bumpRound: task.reviewRoundPending === true,
        fromStatus: ['review'],
        expectPhase: task.phase,
        expectSignalToken: tokenAtDecision,
        expectedTask: {
          status: task.status,
          phase: task.phase,
          signalToken: task.signalToken,
          agentId: task.agentId,
          reviewRound: task.reviewRound,
          specReviewRound: task.specReviewRound,
        },
        ...(qaPhase !== undefined ? { qaPhase } : {}),
        ...(pendingBudget !== undefined ? { pendingBudget } : {}),
        onPassArmed: (armed) => { armedToken = armed; },
      });
    } catch (err) {
      if (isBenignDispatchConflict(err)) {
        console.warn(`[dispatch-reconciler] redispatch ${task.id} (${action}) superseded by a concurrent pass: ${err.message}`);
        return;
      }
      this.recordAttempt(task, await this.livePassToken(task.id, tokenAtDecision));
      console.warn(`[dispatch-reconciler] redispatch ${task.id} (${action}) failed:`, err);
      return;
    }
    // a lease handed back as pending means nothing was delivered: same token → the QA was busy and this pass is queued again;
    // another token → an external pass took over inside the requeue window and must not inherit this lineage
    if (result.reviewDispatch?.phase === 'pending') {
      if (result.signalToken === tokenAtDecision) {
        console.warn(`[dispatch-reconciler] redispatch ${task.id} (${action}) queued again (QA busy)`);
      } else {
        console.warn(`[dispatch-reconciler] redispatch ${task.id} (${action}) superseded by an external pass while re-queued; dropping this lineage`);
        this.attempts.delete(task.id);
      }
      return;
    }
    const after = this.opts.manager.getPendingDispatchRetry(task.id);
    if (after?.kind === 'qa-recheck' && after.signalToken === tokenAtDecision) {
      this.opts.manager.clearPendingDispatchRetryIfMatches(task.id, {
        agentId: after.agentId,
        signalToken: after.signalToken,
      });
    } else if (after?.kind === 'qa-recheck') {
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

  private async releaseQaDeferredWhileBusy(task: TaskState): Promise<void> {
    const qaId = task.qaAgentId;
    // the probe is a free pre-check: a pane still printing would only burn the release's 5s wait inside the task lock
    if (!qaId || this.opts.statusStore.get(qaId).runtimeStatusHint === 'working') return;
    const qa = await this.opts.agentStore.get(qaId);
    if (qa?.taskId !== task.id || qa.status === 'awaiting_human') return;
    let released = false;
    try {
      released = await this.opts.manager.releaseAgentForTask(qaId, task.id, 'idle', {
        deferWhenBusy: true,
        expectedTask: { status: 'fixing' },
      });
    } catch (err) {
      if (err instanceof ReplNotReadyError) return;
      console.warn(`[dispatch-reconciler] deferred QA release for ${task.id} failed:`, err);
    }
    if (!released) await this.alertQaReleaseRefused(task.id, qaId);
  }

  private async alertQaReleaseRefused(taskId: string, qaId: string): Promise<void> {
    const [fresh, qa] = await Promise.all([this.opts.taskStore.get(taskId), this.opts.agentStore.get(qaId)]);
    if (fresh?.status !== 'fixing' || fresh.attention !== undefined
      || qa?.taskId !== taskId || qa.status === 'awaiting_human') return;
    await this.emitIntervention(fresh, fresh.agentId, {
      phase: 'qa-release-failed-but-dev-dispatched',
      qaAgentId: qaId,
      note: `QA agent ${qaId} stayed bound to task ${taskId} after its verdict but could not be released (the server log names the refusal). The dev fix is unaffected; inspect the QA binding and its task lock, then Resume or Delete the QA agent.`,
    });
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
