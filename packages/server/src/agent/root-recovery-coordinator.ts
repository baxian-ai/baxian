import { createHash } from 'node:crypto';
import type { AgentStore } from '../state/agent-store.js';
import type { TaskStore } from '../state/task-store.js';
import type { EventBus, EventHandler } from '../event/bus.js';
import type { TmuxSessionStatusStore } from './tmux-probe-poller.js';
import { RECOVERABLE_QA_DISPATCH_HOLD_PHASES, type AgentManager } from './manager.js';
import {
  ROOT_OUTBOX_DIR,
  RootAgentTerminationError,
  RootAgentResponseInvalidError,
  RootPromptNotSubmittedError,
  type RootAgentRuntimePort,
} from './root-agent-runtime.js';
import { ExecOutcomeUnknownError } from './net-exec.js';
import {
  ROOT_RECOVERY_ACTION_SET,
  ROOT_RECOVERY_MAX_REASON_BYTES,
  RootRecoveryStore,
  type RootRecoveryDecision,
  type RootRecoveryGuard,
  type RootRecoveryOutcome,
  type RootRecoveryRecord,
  type RootRecoveryTrigger,
} from '../state/root-recovery-store.js';
import {
  isRecord,
  taskMatchesGeneration,
  TERMINAL_INTERVENTION_PHASE_SET,
  type AgentBindingFacts,
  type BaxianEvent,
  type RootAgentConfig,
  type TaskState,
} from '../shared/index.js';
import { PeriodicTaskRunner } from '../timing/periodic-task-runner.js';
import { stripSignalAnsi } from './phase-signal.js';

interface RootRecoveryCoordinatorDeps {
  config: RootAgentConfig;
  eventBus: EventBus;
  manager: AgentManager;
  taskStore: TaskStore;
  agentStore: AgentStore;
  statusStore: TmuxSessionStatusStore;
  runtime: RootAgentRuntimePort;
  store: RootRecoveryStore;
  capturePane?: (agentId: string) => Promise<string | undefined>;
  now?: () => Date;
  pollIntervalMs?: number;
  runtimeRetryIntervalMs?: number;
}

const RECOVERABLE_TASK_STATUSES = new Set<TaskState['status']>([
  'pending', 'in_progress', 'review', 'fixing', 'approved',
]);
const STALL_REASONS = new Set(['STUCK_BUSY', 'PENDING_IDLE']);
const MAX_CONTEXT_STRING_BYTES = 8 * 1024;
const MAX_EVENT_DATA_BYTES = 2 * 1024;
const MAX_PANE_BYTES = 12 * 1024;
const MAX_CONTEXT_ERROR_BYTES = 512;
const MAX_FIELD_NAME_CHARS = 256;
const MAX_SECRET_SCAN_NODES = 4_096;
const MIN_GLOBAL_SECRET_CHARS = 8;
const RECENT_EVENT_LIMIT = 20;
const SENSITIVE_FIELD_RE = /(?:token|password|secret|authorization|credential|nonce)/i;
const KEY_CREDENTIAL_QUALIFIERS = new Set(['api', 'access', 'private', 'ssh']);
const KEY_CREDENTIAL_FIELDS = new Set(['apikey', 'accesskey', 'privatekey', 'sshkey']);
const AUTHORIZATION_FIELDS = new Set(['authorization', 'proxyauthorization']);
const BARE_AUTH_CREDENTIAL_RE = /^(?:Basic|Bearer)[\t ]+([A-Za-z0-9._~+\/-]{8,}=*)[\t ]*$/i;
const LABELED_FIELD_RE = /(^|[^A-Za-z0-9_.-])(["']?)([A-Za-z0-9_.-]+)\2([^\S\r\n]*[:=][^\S\r\n]*)/gim;
const RECOVERY_RETENTION_MS = 30 * 24 * 60 * 60_000;
const RECOVERY_PRUNE_INTERVAL_MS = 24 * 60 * 60_000;

export type RootRecoveryControlStatus =
  | 'disabled'
  | 'active'
  | 'stopping'
  | 'stop-incomplete'
  | 'stopped-until-restart';

export class RootRuntimeStopIncompleteError extends Error {
  constructor(detail: string) {
    super(`Root recovery shutdown is incomplete; retry stopping root-agent: ${detail}`);
    this.name = 'RootRuntimeStopIncompleteError';
  }
}

export class RootRecoveryCoordinator {
  private readonly config: RootAgentConfig;
  private readonly eventBus: EventBus;
  private readonly manager: AgentManager;
  private readonly taskStore: TaskStore;
  private readonly agentStore: AgentStore;
  private readonly statusStore: TmuxSessionStatusStore;
  private readonly runtime: RootAgentRuntimePort;
  private readonly store: RootRecoveryStore;
  private readonly capturePane?: (agentId: string) => Promise<string | undefined>;
  private readonly now: () => Date;
  private readonly periodicRunner: PeriodicTaskRunner;
  private readonly runtimeRetryIntervalMs: number;
  private readonly processing = new Map<string, Promise<void>>();
  private readonly delivering = new Set<string>();
  private readonly polling = new Set<Promise<void>>();
  private readonly reconciling = new Set<Promise<void>>();
  private readonly reconciliationFailures: unknown[] = [];
  private readonly runtimeRechecks = new Set<string>();
  private readonly triggerRecoveryRechecks = new Map<string, RootRecoveryRecord>();
  private intakeChain: Promise<void> = Promise.resolve();
  private kickChain: Promise<void> = Promise.resolve();
  private runtimeStart: Promise<boolean> | null = null;
  private runtimeStop: Promise<void> | null = null;
  private runtimeReady = false;
  private lastRuntimeAttemptAt = 0;
  private lastRuntimeError = '';
  private readonly runtimeAlerts = new Map<string, string>();
  private readonly deliveryAlerts = new Set<string>();
  private lastPruneAt = 0;
  private offTaskChange?: () => void;
  private offAgentChange?: () => void;
  private offStatusChange?: () => void;
  private started = false;
  private runtimeControlStatus: RootRecoveryControlStatus = 'active';
  private runtimeStopWarning = '';
  private runtimeStopHostRepairable = false;

  private readonly onIntervention: EventHandler = async event => {
    try {
      await this.handleIntervention(event);
    } catch (err) {
      console.warn('[root-agent] intervention intake failed:', err);
    }
  };

  constructor(deps: RootRecoveryCoordinatorDeps) {
    this.config = deps.config;
    this.eventBus = deps.eventBus;
    this.manager = deps.manager;
    this.taskStore = deps.taskStore;
    this.agentStore = deps.agentStore;
    this.statusStore = deps.statusStore;
    this.runtime = deps.runtime;
    this.store = deps.store;
    this.capturePane = deps.capturePane;
    this.now = deps.now ?? (() => new Date());
    this.runtimeRetryIntervalMs = deps.runtimeRetryIntervalMs ?? 60_000;
    this.periodicRunner = new PeriodicTaskRunner({
      name: 'root-recovery',
      intervalMs: deps.pollIntervalMs ?? 2_000,
      run: () => this.pollOnce(),
      onError: err => console.warn('[root-agent] recovery poll failed:', err),
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.runtimeControlStatus = 'active';
    this.eventBus.on('human.intervention', this.onIntervention);
    this.offTaskChange = this.taskStore.onChange((_kind, taskId) => {
      void this.finishIfStale(taskId).catch(err => {
        console.warn(`[root-agent] stale-request reconciliation failed for ${taskId}:`, err);
      });
    });
    this.offAgentChange = this.agentStore.onChange((_kind, agentId) => {
      void this.handleRuntimeObservation(agentId).catch(err => {
        console.warn(`[root-agent] agent-state reconciliation failed for ${agentId}:`, err);
      });
    });
    this.offStatusChange = this.statusStore.onChange((_kind, agentId) => {
      void this.handleRuntimeObservation(agentId).catch(err => {
        console.warn(`[root-agent] runtime-stall intake failed for ${agentId}:`, err);
      });
    });
    try {
      await this.recoverInterruptedExecutions();
      await this.recoverHeldAgents();
      this.periodicRunner.start({ runImmediately: true });
    } catch (err) {
      try {
        await this.deactivate();
      } catch (cleanupErr) {
        console.warn('[root-agent] startup rollback could not stop the runtime cleanly:', cleanupErr);
      }
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.deactivate();
  }

  private async deactivate(): Promise<void> {
    this.started = false;
    this.periodicRunner.stop();
    this.eventBus.off('human.intervention', this.onIntervention);
    this.offTaskChange?.();
    this.offAgentChange?.();
    this.offStatusChange?.();
    this.offTaskChange = undefined;
    this.offAgentChange = undefined;
    this.offStatusChange = undefined;
    this.runtimeRechecks.clear();
    let drainFailure: unknown;
    try {
      await this.waitForCoordinatorWork();
    } catch (err) {
      drainFailure = err;
    }
    this.runtimeAlerts.clear();
    this.deliveryAlerts.clear();
    this.runtimeReady = false;
    try {
      await this.runtime.stop();
    } catch (err) {
      if (drainFailure !== undefined) {
        throw new AggregateError([drainFailure, err], 'Root recovery coordinator shutdown failed');
      }
      throw err;
    }
    if (drainFailure !== undefined) throw drainFailure;
  }

  async isRuntimeLive(): Promise<boolean> {
    return this.runtime.isLive();
  }

  isRuntimeExplicitlyStopped(): boolean {
    return this.getRuntimeControlStatus() === 'stopped-until-restart';
  }

  getRuntimeControlStatus(): RootRecoveryControlStatus {
    if (this.started || this.runtimeControlStatus !== 'active') return this.runtimeControlStatus;
    return 'disabled';
  }

  getRuntimeStopWarning(): string | undefined {
    return this.runtimeStopWarning || undefined;
  }

  canRepairHostAfterIncompleteStop(): boolean {
    return this.runtimeControlStatus === 'stop-incomplete' && this.runtimeStopHostRepairable;
  }

  private isRuntimeDispatchDisabled(): boolean {
    return !this.started || this.runtimeControlStatus !== 'active';
  }

  usesHost(hostId: string): boolean {
    return this.config.mode === 'remote' && this.config.host === hostId;
  }

  async invalidateRuntimeStreamer(): Promise<void> {
    this.runtimeReady = false;
    this.lastRuntimeAttemptAt = 0;
    await this.runtime.invalidateStreamer();
  }

  stopRuntime(): Promise<void> {
    if (this.runtimeStop) return this.runtimeStop;
    this.runtimeControlStatus = 'stopping';
    this.runtimeStopHostRepairable = false;
    this.runtimeReady = false;
    const priorKicks = this.kickChain;
    const run = this.stopRuntimeNow(priorKicks);
    this.runtimeStop = run;
    this.kickChain = run.catch(() => undefined);
    void run.finally(() => {
      if (this.runtimeStop === run) this.runtimeStop = null;
    }).catch(() => undefined);
    return run;
  }

  private async stopRuntimeNow(priorKicks: Promise<void>): Promise<void> {
    const stopFailures: unknown[] = [];
    const ledgerFailures: unknown[] = [];
    this.runtimeStopWarning = '';
    try {
      await priorKicks;
      await this.waitForReconciliation();
    } catch (err) {
      stopFailures.push(err);
    }
    try {
      await this.runtime.terminate();
    } catch (err) {
      stopFailures.push(err);
    }
    try {
      await this.intakeChain;
      await this.waitForResponseProcessing();
    } catch (err) {
      stopFailures.push(err);
    }
    try {
      for (const record of await this.store.listActive()) {
        await this.finishRecoveryAfterRuntimeStop(record);
      }
    } catch (err) {
      ledgerFailures.push(err);
    }
    this.lastRuntimeAttemptAt = this.now().getTime();
    this.lastRuntimeError = '';
    this.runtimeAlerts.clear();
    this.deliveryAlerts.clear();
    if (stopFailures.length > 0) {
      this.runtimeControlStatus = 'stop-incomplete';
      this.runtimeStopHostRepairable = ledgerFailures.length === 0
        && stopFailures.length === 1
        && stopFailures[0] instanceof RootAgentTerminationError
        && stopFailures[0].hostConnectionUnknown;
      const detail = [...stopFailures, ...ledgerFailures]
        .map(err => err instanceof Error ? err.message : String(err))
        .join('; ');
      throw new RootRuntimeStopIncompleteError(detail);
    }
    this.runtimeControlStatus = 'stopped-until-restart';
    if (ledgerFailures.length > 0) {
      const detail = ledgerFailures
        .map(err => err instanceof Error ? err.message : String(err))
        .join('; ');
      this.runtimeStopWarning =
        `Root session termination was confirmed, but recovery ledger reconciliation failed: ${detail}`;
      console.warn(`[root-agent] ${this.runtimeStopWarning}`);
    }
  }

  private async waitForResponseProcessing(): Promise<void> {
    const results = await Promise.allSettled(this.processing.values());
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Multiple root decisions failed while stopping');
  }

  private async waitForCoordinatorWork(): Promise<void> {
    while (true) {
      const intake = this.intakeChain;
      const kicks = this.kickChain;
      const polling = [...this.polling];
      const processing = [...this.processing.values()];
      const reconciling = [...this.reconciling];
      const results = await Promise.allSettled([
        intake,
        kicks,
        ...polling,
        ...processing,
        ...reconciling,
      ]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason)
        .concat(this.takeReconciliationFailures());
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Root recovery work failed while stopping');
      if (
        intake === this.intakeChain
        && kicks === this.kickChain
        && this.polling.size === 0
        && this.processing.size === 0
        && this.reconciling.size === 0
      ) return;
    }
  }

  private async waitForReconciliation(): Promise<void> {
    while (this.reconciling.size > 0) {
      const results = await Promise.allSettled(this.reconciling);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason)
        .concat(this.takeReconciliationFailures());
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, 'Multiple root recovery reconciliations failed while stopping');
      }
    }
    const failures = this.takeReconciliationFailures();
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Multiple root recovery reconciliations failed while stopping');
    }
  }

  pollOnce(): Promise<void> {
    const run = this.pollOnceNow().finally(() => {
      this.polling.delete(run);
    });
    this.polling.add(run);
    return run;
  }

  private async pollOnceNow(): Promise<void> {
    if (this.runtimeControlStatus !== 'active') return;
    if (!this.started) {
      await this.pruneCompleted();
      return;
    }
    for (const agentId of [...this.runtimeRechecks]) {
      try {
        await this.handleRuntimeObservation(agentId);
      } catch (err) {
        this.runtimeRechecks.add(agentId);
        console.warn(`[root-agent] runtime recheck failed for ${agentId}; will retry:`, err);
      }
    }
    for (const [taskId, record] of [...this.triggerRecoveryRechecks]) {
      try {
        await this.recoverCurrentTaskTriggers(record);
        if (this.triggerRecoveryRechecks.get(taskId)?.id === record.id) {
          this.triggerRecoveryRechecks.delete(taskId);
        }
      } catch (err) {
        console.warn(`[root-agent] follow-up trigger recovery retry failed for ${taskId}:`, err);
      }
    }
    const active = await this.store.listActive();
    for (const record of active) {
      if (
        record.status !== 'inflight'
        || this.processing.has(record.id)
        || this.delivering.has(record.id)
      ) continue;
      if (record.decision) {
        if (await this.complete(record, 'unknown', 'Server restarted or lost execution state after persisting the root decision; action was not retried.')) {
          await this.emitRootIntervention(record, 'root-action-outcome-unknown', record.decision.reason);
        }
        continue;
      }
      await this.processResponse(record);
      const fresh = await this.store.get(record.id);
      if (fresh?.status === 'inflight') await this.finishTimedOutResponse(fresh);
    }
    await this.kick();
    await this.pruneCompleted();
  }

  private async handleIntervention(event: BaxianEvent): Promise<void> {
    if (event.data.source === 'root-agent' || !event.taskId) return;
    const phase = typeof event.data.phase === 'string' ? event.data.phase : undefined;
    if (!phase
      || phase === 'resumed'
      || phase === 'git-review-dispatch-hold-cleared'
      || TERMINAL_INTERVENTION_PHASE_SET.has(phase)) return;
    const hold = event.agentId
      ? await this.currentHold(event.agentId, event.taskId, phase)
      : undefined;
    await this.createRequest(event.taskId, {
      kind: 'intervention',
      observedAt: event.timestamp,
      eventId: event.id,
      ...(event.agentId ? { agentId: event.agentId } : {}),
      ...(phase ? { phase: truncateUtf8(phase, 256) } : {}),
      ...(typeof event.data.reason === 'string'
        ? { reason: truncateUtf8(event.data.reason, ROOT_RECOVERY_MAX_REASON_BYTES) }
        : {}),
      ...(typeof event.data.message === 'string'
        ? { message: truncateUtf8(event.data.message, ROOT_RECOVERY_MAX_REASON_BYTES) }
        : {}),
      ...hold,
    });
  }

  private async handleRuntimeObservation(agentId: string): Promise<void> {
    await this.finishIfTriggerStale(agentId);
    const observation = this.statusStore.get(agentId);
    if (!observation.reason || !STALL_REASONS.has(observation.reason)) {
      this.runtimeRechecks.delete(agentId);
      return;
    }
    const binding = await this.agentStore.get(agentId);
    if (
      !binding?.taskId
      || binding.status === 'awaiting_human'
      || binding.needInput?.at !== undefined
    ) {
      this.runtimeRechecks.delete(agentId);
      return;
    }
    const task = await this.taskStore.get(binding.taskId);
    const observedAt = observation.observedAt ? Date.parse(observation.observedAt) : Number.NaN;
    const latestContextWrite = Math.max(
      Date.parse(binding.updatedAt),
      task ? Date.parse(task.updatedAt) : Number.NaN,
    );
    if (Number.isFinite(observedAt)
      && Number.isFinite(latestContextWrite)
      && observedAt < latestContextWrite) {
      this.runtimeRechecks.add(agentId);
      return;
    }
    this.runtimeRechecks.delete(agentId);
    const triggerObservedAt = observation.stateChangedAt
      ?? observation.observedAt
      ?? this.now().toISOString();
    await this.createRequest(binding.taskId, {
      kind: 'runtime-stall',
      observedAt: triggerObservedAt,
      agentId,
      reason: observation.reason,
      ...(observation.message ? { message: truncateUtf8(observation.message, ROOT_RECOVERY_MAX_REASON_BYTES) } : {}),
    });
  }

  private createRequest(taskId: string, trigger: RootRecoveryTrigger): Promise<void> {
    if (this.isRuntimeDispatchDisabled()) return Promise.resolve();
    const run = this.intakeChain.then(() => this.createRequestNow(taskId, trigger));
    this.intakeChain = run.catch(() => undefined);
    return run;
  }

  private async createRequestNow(taskId: string, trigger: RootRecoveryTrigger): Promise<void> {
    if (this.isRuntimeDispatchDisabled()) return;
    const task = await this.taskStore.get(taskId);
    if (this.isRuntimeDispatchDisabled()) return;
    if (!task || !this.projectEnabled(task.projectId) || !RECOVERABLE_TASK_STATUSES.has(task.status)) return;
    const guard = guardFor(task);
    const redispatchLimitReached = triggerCanRedispatch(trigger)
      && await this.redispatchLimitReached(task.id, guard);
    const result = await this.store.createIfIdle({
      taskId: task.id,
      projectId: task.projectId,
      trigger: redispatchLimitReached
        ? { ...trigger, eventId: redispatchLimitEventId(task.id, guard) }
        : trigger,
      guard,
    });
    if (result.created) {
      if (redispatchLimitReached) {
        const attempts = this.manager.getConfig().server.dispatchReconcileMaxAttempts;
        const detail =
          `Automatic root redispatch reached the configured limit (${attempts}) for this task phase; ` +
          'the task remains stopped for human recovery.';
        const completed = await this.store.complete(result.record.id, {
          kind: 'escalated',
          detail,
          at: this.now().toISOString(),
        }, result.record);
        if (completed.completed) {
          console.log(`[root-agent] recovery ${result.record.id} finished: escalated`);
          await this.emitRootIntervention(result.record, 'root-redispatch-attempts-exhausted', detail);
        } else {
          console.warn(
            `[root-agent] redispatch-limit completion lost its state race for ${result.record.id}; ` +
            'the current recovery record was preserved',
          );
        }
        return;
      }
      console.log(`[root-agent] queued recovery ${result.record.id} for task ${task.id} (${trigger.kind})`);
      this.scheduleKick();
    }
  }

  private async redispatchLimitReached(
    taskId: string,
    guard: RootRecoveryGuard,
  ): Promise<boolean> {
    const limit = this.manager.getConfig().server.dispatchReconcileMaxAttempts;
    let attempts = 0;
    for (const record of await this.store.list()) {
      if (
        record.taskId === taskId
        && record.status === 'done'
        && record.decision?.action === 'redispatch-current-phase'
        && (record.outcome?.kind === 'executed' || record.outcome?.kind === 'unknown')
        && sameRedispatchLineage(record.guard, guard)
      ) attempts++;
    }
    return attempts >= limit;
  }

  private scheduleKick(): void {
    void this.kick().catch(err => console.warn('[root-agent] recovery dispatch failed:', err));
  }

  private kick(): Promise<void> {
    const run = this.kickChain.then(() => this.dispatchNext());
    this.kickChain = run.catch(() => undefined);
    return run;
  }

  private async dispatchNext(): Promise<void> {
    if (!this.started || this.isRuntimeDispatchDisabled()) return;
    const active = await this.store.listActive();
    if (active.some(record => record.status === 'inflight')) return;
    let record = active.find(item => item.status === 'pending');
    if (!record) return;
    if (!this.projectEnabled(record.projectId)) {
      await this.complete(record, 'stale', 'The project is no longer in the configured root-agent scope.');
      return;
    }
    const task = await this.taskStore.get(record.taskId);
    if (this.isRuntimeDispatchDisabled()) return;
    if (
      !task
      || task.projectId !== record.projectId
      || !taskMatchesGeneration(task, record.guard)
      || !(await this.triggerStillActive(record))
    ) {
      await this.complete(record, 'stale', 'Task generation changed before root dispatch.');
      return;
    }
    const mailboxMayExist = record.dispatchedAt !== undefined;
    const dispatchStarted = await this.store.markDispatchStarted(record.id);
    if (this.isRuntimeDispatchDisabled()) return;
    if (!dispatchStarted || dispatchStarted.status !== 'pending') return;
    record = dispatchStarted;
    if (await this.finishTimedOutDelivery(record)) {
      this.scheduleKick();
      return;
    }
    if (await this.runtimeObservationLagsBinding(record)) return;
    if (!(await this.ensureRuntime(record)) || this.isRuntimeDispatchDisabled()) return;
    if (mailboxMayExist) {
      try {
        await this.runtime.cleanup(record);
        console.log(`[root-agent] removed residual pending mailbox for ${record.id}`);
      } catch (err) {
        console.warn(`[root-agent] residual pending mailbox cleanup failed for ${record.id}:`, err);
        return;
      }
    }
    let body: string;
    try {
      body = await this.buildRequest(record, task);
      if (this.isRuntimeDispatchDisabled()) return;
      await this.runtime.writeRequest(record, body);
      this.deliveryAlerts.delete(record.id);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (err instanceof ExecOutcomeUnknownError) {
        this.runtimeReady = false;
        console.warn(
          `[root-agent] request delivery probe failed for ${record.id}; ` +
          `kept pending for deadline-bounded reconciliation: ${detail}`,
        );
        if (!this.deliveryAlerts.has(record.id)) {
          this.deliveryAlerts.add(record.id);
          await this.emitRootIntervention(record, 'root-request-delivery-retrying', detail);
        }
        return;
      }
      if (await this.complete(record, 'failed', `Failed to deliver root request file: ${detail}`)) {
        await this.emitRootIntervention(record, 'root-request-delivery-failed', detail);
      }
      return;
    }
    const inflight = await this.store.markDispatched(record.id);
    if (!inflight || inflight.status !== 'inflight') {
      try {
        await this.runtime.cleanup(inflight ?? record);
        console.log(`[root-agent] removed stale request mailbox for ${record.id}`);
      } catch (err) {
        console.warn(`[root-agent] stale request mailbox cleanup failed for ${record.id}:`, err);
      }
      return;
    }
    if (this.isRuntimeDispatchDisabled()) {
      const retry = await this.store.requeueUndelivered(inflight.id, inflight.attemptToken);
      if (!retry.requeued) {
        console.warn(
          `[root-agent] stopped request ${record.id} could not be returned to pending; ` +
          'its mailbox was preserved for reconciliation',
        );
        return;
      }
      try {
        await this.runtime.cleanup(inflight);
        console.log(`[root-agent] removed stopped undelivered request mailbox for ${record.id}`);
      } catch (err) {
        console.warn(`[root-agent] stopped request mailbox cleanup failed for ${record.id}:`, err);
      }
      return;
    }
    this.delivering.add(inflight.id);
    try {
      await this.runtime.notify(inflight);
      await this.store.markDelivered(inflight.id, inflight.attemptToken);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.runtimeReady = false;
      if (err instanceof RootPromptNotSubmittedError) {
        const retry = await this.store.requeueUndelivered(inflight.id, inflight.attemptToken);
        if (retry.requeued) {
          console.warn(`[root-agent] prompt for ${inflight.id} was not submitted; returned to pending: ${detail}`);
          try {
            await this.runtime.cleanup(inflight);
            console.log(`[root-agent] removed unsubmitted request mailbox for ${inflight.id}`);
          } catch (cleanupError) {
            console.warn(`[root-agent] unsubmitted request mailbox cleanup failed for ${inflight.id}:`, cleanupError);
          }
        }
        return;
      }
      const completed = await this.complete(
        inflight,
        'unknown',
        `Root prompt delivery outcome is unknown and was not retried: ${detail}`,
      );
      if (completed) await this.emitRootIntervention(inflight, 'root-prompt-delivery-unknown', detail);
    } finally {
      this.delivering.delete(inflight.id);
      this.trackReconciliation(inflight);
    }
  }

  private trackReconciliation(record: RootRecoveryRecord): void {
    const run = this.reconcileAfterDelivery(record)
      .catch(err => {
        console.warn(`[root-agent] post-delivery reconciliation failed for ${record.id}:`, err);
        if (!this.started || this.runtimeControlStatus !== 'active') {
          this.reconciliationFailures.push(err);
        }
      })
      .finally(() => {
        this.reconciling.delete(run);
      });
    this.reconciling.add(run);
  }

  private takeReconciliationFailures(): unknown[] {
    return this.reconciliationFailures.splice(0);
  }

  private async reconcileAfterDelivery(record: RootRecoveryRecord): Promise<void> {
    await this.finishIfStale(record.taskId);
    if (record.trigger.agentId) await this.finishIfTriggerStale(record.trigger.agentId);
  }

  private processResponse(record: RootRecoveryRecord): Promise<void> {
    if (this.isRuntimeDispatchDisabled()) return Promise.resolve();
    if (this.delivering.has(record.id)) return Promise.resolve();
    const existing = this.processing.get(record.id);
    if (existing) return existing;
    const run = this.processResponseNow(record).finally(() => {
      if (this.processing.get(record.id) === run) this.processing.delete(record.id);
      this.scheduleKick();
    });
    this.processing.set(record.id, run);
    return run;
  }

  private async processResponseNow(record: RootRecoveryRecord): Promise<void> {
    if (!this.projectEnabled(record.projectId)) {
      await this.complete(record, 'stale', 'The project is no longer in the configured root-agent scope.');
      return;
    }
    if (await this.finishTimedOutDelivery(record)) return;
    if (await this.finishTimedOutResponse(record)) return;
    if (await this.runtimeObservationLagsBinding(record)) return;
    let raw: unknown | null;
    try {
      raw = await this.runtime.readResponse(record);
    } catch (err) {
      if (err instanceof RootAgentResponseInvalidError) {
        const detail = err.message;
        if (await this.complete(record, 'failed', detail)) {
          await this.emitRootIntervention(record, 'root-response-invalid', detail);
        }
        return;
      }
      console.warn(`[root-agent] response read failed for ${record.id}; will reconcile again:`, err);
      return;
    }
    if (raw === null) return;
    let decision: RootRecoveryDecision;
    try {
      decision = parseResponse(raw, record);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (await this.complete(record, 'failed', detail)) {
        await this.emitRootIntervention(record, 'root-response-invalid', detail);
      }
      return;
    }
    const taskBeforeClaim = await this.taskStore.get(record.taskId);
    if (await this.runtimeObservationLagsBinding(record)) return;
    if (
      !taskBeforeClaim
      || !this.projectEnabled(record.projectId)
      || taskBeforeClaim.projectId !== record.projectId
      || !taskMatchesGeneration(taskBeforeClaim, record.guard)
      || !(await this.triggerStillActive(record))
    ) {
      await this.complete(record, 'stale', 'The original task stall or hold no longer exists.');
      return;
    }
    if (await this.finishTimedOutResponse(record)) return;
    const claim = await this.store.claimDecision(record.id, record.attemptToken, decision);
    if (!claim.claimed || !claim.record) return;
    const claimed = claim.record;
    const task = await this.taskStore.get(record.taskId);
    if (await this.runtimeObservationLagsBinding(claimed)) {
      await this.complete(
        claimed,
        'stale',
        'The agent binding advanced before the root decision could be executed.',
      );
      return;
    }
    if (
      !task
      || !this.projectEnabled(record.projectId)
      || task.projectId !== record.projectId
      || !taskMatchesGeneration(task, record.guard)
      || !(await this.triggerStillActive(claimed))
    ) {
      await this.complete(claimed, 'stale', 'Task generation changed before root decision execution.');
      return;
    }
    if (this.isRuntimeDispatchDisabled()) return;
    if (decision.action === 'no-op') {
      await this.complete(claimed, 'ignored', decision.reason);
      return;
    }
    if (decision.action === 'escalate') {
      if (await this.complete(claimed, 'escalated', decision.reason)) {
        await this.emitRootIntervention(claimed, 'root-escalated', decision.reason);
      }
      return;
    }
    try {
      const result = await this.manager.redispatchCurrentTaskPhase(record.taskId, record.guard);
      if (result === 'dispatched') {
        await this.complete(claimed, 'executed', decision.reason);
      } else if (result === 'stale') {
        await this.complete(claimed, 'stale', 'Task generation changed while redispatching.');
      } else {
        if (await this.complete(claimed, 'failed', 'Current task phase has no safe redispatch path.')) {
          await this.emitRootIntervention(
            claimed,
            'root-action-unsupported',
            `Root requested redispatch, but task status=${task.status} phase=${task.phase ?? 'none'} has no safe replay path.`,
          );
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const completed = await this.complete(
        claimed,
        'unknown',
        `Redispatch may have produced a side effect; it was not retried: ${detail}`,
      );
      if (completed) await this.emitRootIntervention(claimed, 'root-action-outcome-unknown', detail);
    }
  }

  private async finishIfStale(taskId: string): Promise<void> {
    while (true) {
      const active = (await this.store.listActive()).find(record => record.taskId === taskId);
      if (!active || this.processing.has(active.id) || this.delivering.has(active.id)) return;
      const task = await this.taskStore.get(taskId);
      if (
        task
        && task.projectId === active.projectId
        && this.projectEnabled(active.projectId)
        && taskMatchesGeneration(task, active.guard)
      ) return;
      if (await this.complete(
        active,
        'stale',
        'Server advanced the task before the root decision was applied.',
      )) {
        this.scheduleKick();
        return;
      }
    }
  }

  private async finishIfTriggerStale(agentId: string): Promise<void> {
    while (true) {
      const active = (await this.store.listActive()).find(record => record.trigger.agentId === agentId);
      if (
        !active
        || this.processing.has(active.id)
        || this.delivering.has(active.id)
        || await this.triggerStillActive(active)
      ) return;
      if (await this.complete(active, 'stale', 'The original agent stall or hold no longer exists.')) {
        this.scheduleKick();
        return;
      }
    }
  }

  private async triggerStillActive(record: RootRecoveryRecord): Promise<boolean> {
    const { trigger } = record;
    if (!trigger.agentId) return true;
    if (trigger.kind === 'runtime-stall') {
      const observation = this.statusStore.get(trigger.agentId);
      const binding = await this.agentStore.get(trigger.agentId);
      if (
        binding?.taskId !== record.taskId
        || binding.status === 'awaiting_human'
        || binding.needInput?.at !== undefined
        || observation.reason !== trigger.reason
      ) return false;
      const stateChangedAt = observation.stateChangedAt ?? observation.observedAt;
      return stateChangedAt === undefined || stateChangedAt === trigger.observedAt;
    }
    if (trigger.holdPhase === undefined) return true;
    const binding = await this.agentStore.get(trigger.agentId);
    return binding?.taskId === record.taskId
      && binding.status === 'awaiting_human'
      && (binding.awaitingPhase ?? '') === trigger.holdPhase
      && (binding.awaitingSince ?? '') === trigger.holdSince
      && (binding.awaitingNonce ?? '') === trigger.holdNonce;
  }

  private async runtimeObservationLagsBinding(record: RootRecoveryRecord): Promise<boolean> {
    const { trigger } = record;
    if (trigger.kind !== 'runtime-stall' || !trigger.agentId) return false;
    const binding = await this.agentStore.get(trigger.agentId);
    if (binding?.taskId !== record.taskId) return false;
    const observation = this.statusStore.get(trigger.agentId);
    const observedAt = observation.observedAt ? Date.parse(observation.observedAt) : Number.NaN;
    const bindingUpdatedAt = Date.parse(binding.updatedAt);
    if (!Number.isFinite(observedAt)
      || !Number.isFinite(bindingUpdatedAt)
      || observedAt >= bindingUpdatedAt) return false;
    this.runtimeRechecks.add(trigger.agentId);
    return true;
  }

  private async currentHold(
    agentId: string,
    taskId: string,
    phase: string,
  ): Promise<Pick<
    RootRecoveryTrigger,
    'eventId' | 'holdPhase' | 'holdSince' | 'holdNonce'
  > | undefined> {
    const binding = await this.agentStore.get(agentId);
    if (
      binding?.taskId !== taskId
      || binding.status !== 'awaiting_human'
      || binding.awaitingPhase !== phase
    ) return undefined;
    return {
      eventId: holdEventId(binding),
      holdPhase: binding.awaitingPhase,
      holdSince: binding.awaitingSince ?? '',
      holdNonce: binding.awaitingNonce ?? '',
    };
  }

  private async recoverInterruptedExecutions(): Promise<void> {
    for (const record of await this.store.listActive()) {
      if (record.status !== 'inflight') continue;
      if (record.decision) {
        if (await this.complete(
          record,
          'unknown',
          'Server restarted after persisting the root decision; action was not blindly retried.',
        )) {
          await this.emitRootIntervention(record, 'root-action-outcome-unknown', record.decision.reason);
        }
      } else if (!record.deliveredAt && await this.complete(
        record,
        'unknown',
        'Server restarted while root prompt delivery was in progress; delivery was not retried.',
      )) {
        await this.emitRootIntervention(
          record,
          'root-prompt-delivery-unknown',
          'Server restarted before prompt delivery could be confirmed.',
        );
      }
    }
  }

  private async recoverHeldAgents(taskId?: string): Promise<void> {
    for (const binding of await this.agentStore.list()) {
      if (
        binding.status !== 'awaiting_human'
        || !binding.taskId
        || (taskId !== undefined && binding.taskId !== taskId)
      ) continue;
      await this.recoverHeldAgent(binding);
    }
  }

  private recoverHeldAgent(binding: AgentBindingFacts): Promise<void> {
    if (!binding.taskId) return Promise.resolve();
    return this.createRequest(binding.taskId, {
      kind: 'intervention',
      observedAt: binding.awaitingSince ?? binding.updatedAt,
      agentId: binding.id,
      eventId: holdEventId(binding),
      ...(binding.awaitingPhase ? { phase: truncateUtf8(binding.awaitingPhase, 256) } : {}),
      reason: 'agent-awaiting-human',
      ...(binding.awaitingReason
        ? { message: truncateUtf8(binding.awaitingReason, ROOT_RECOVERY_MAX_REASON_BYTES) }
        : {}),
      holdPhase: binding.awaitingPhase ?? '',
      holdSince: binding.awaitingSince ?? '',
      holdNonce: binding.awaitingNonce ?? '',
    });
  }

  private async recoverCurrentTaskTriggers(completed: RootRecoveryRecord): Promise<void> {
    const task = await this.taskStore.get(completed.taskId);
    const sameTaskGeneration = task !== null && taskMatchesGeneration(task, completed.guard);
    const bindings = (await this.agentStore.list()).filter(binding => binding.taskId === completed.taskId);
    for (const binding of bindings) {
      if (binding.status === 'awaiting_human') {
        const prior = completed.trigger;
        if (
          prior.kind === 'intervention'
          && prior.agentId === binding.id
          && prior.holdPhase === (binding.awaitingPhase ?? '')
          && prior.holdSince === (binding.awaitingSince ?? '')
          && prior.holdNonce === (binding.awaitingNonce ?? '')
        ) continue;
        await this.recoverHeldAgent(binding);
        continue;
      }
      const observation = this.statusStore.get(binding.id);
      if (!observation.reason || !STALL_REASONS.has(observation.reason)) continue;
      const prior = completed.trigger;
      const stateChangedAt = observation.stateChangedAt ?? observation.observedAt;
      if (
        prior.kind === 'runtime-stall'
        && prior.agentId === binding.id
        && prior.reason === observation.reason
        && sameTaskGeneration
        && !isLaterObservation(stateChangedAt, prior.observedAt)
      ) continue;
      await this.handleRuntimeObservation(binding.id);
    }
  }

  private async pruneCompleted(): Promise<void> {
    if (this.runtimeControlStatus !== 'active') return;
    const now = this.now().getTime();
    if (now - this.lastPruneAt < RECOVERY_PRUNE_INTERVAL_MS) return;
    this.lastPruneAt = now;
    const cutoff = new Date(now - RECOVERY_RETENTION_MS).toISOString();
    for (const record of await this.store.listDoneBefore(cutoff)) {
      try {
        if (this.runtimeControlStatus !== 'active') return;
        if (
          record.trigger.agentId !== undefined
          && record.trigger.holdPhase !== undefined
          && await this.triggerStillActive(record)
        ) continue;
        if (this.runtimeControlStatus !== 'active') return;
        await this.runtime.cleanup(record);
        if (await this.store.removeDone(record.id, record.updatedAt)) {
          console.log(`[root-agent] pruned retained recovery ${record.id}`);
        }
      } catch (err) {
        console.warn(`[root-agent] retained recovery cleanup failed for ${record.id}:`, err);
      }
    }
  }

  private ensureRuntime(record: RootRecoveryRecord): Promise<boolean> {
    if (this.isRuntimeDispatchDisabled()) return Promise.resolve(false);
    if (this.runtimeReady) return Promise.resolve(true);
    if (this.runtimeStart) return this.runtimeStart;
    const now = this.now().getTime();
    if (now - this.lastRuntimeAttemptAt < this.runtimeRetryIntervalMs) {
      return Promise.resolve(false);
    }
    this.lastRuntimeAttemptAt = now;
    const pending = this.startRuntime(record);
    this.runtimeStart = pending;
    void pending.finally(() => {
      if (this.runtimeStart === pending) this.runtimeStart = null;
    }).catch(() => undefined);
    return pending;
  }

  private async startRuntime(record: RootRecoveryRecord): Promise<boolean> {
    try {
      await this.runtime.start(token => {
        void this.processSignal(token).catch(err => {
          console.warn(`[root-agent] signal processing failed for token ${token}:`, err);
        });
      });
      if (this.lastRuntimeError) console.log('[root-agent] runtime recovered');
      this.lastRuntimeError = '';
      this.runtimeAlerts.clear();
      this.runtimeReady = true;
      return true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.runtimeReady = false;
      if (detail !== this.lastRuntimeError) {
        this.lastRuntimeError = detail;
        console.warn(`[root-agent] runtime unavailable: ${detail}`);
      }
      if (this.runtimeAlerts.get(record.id) !== detail) {
        this.runtimeAlerts.set(record.id, detail);
        await this.emitRootIntervention(record, 'root-runtime-unavailable', detail);
      }
      return false;
    }
  }

  private async processSignal(attemptToken: string): Promise<void> {
    const record = (await this.store.listActive()).find(item =>
      item.status === 'inflight' && item.attemptToken === attemptToken,
    );
    if (record) await this.processResponse(record);
  }

  private async buildRequest(record: RootRecoveryRecord, task: TaskState): Promise<string> {
    const contextErrors: string[] = [];
    const ids = new Set([
      record.trigger.agentId,
      task.agentId,
      task.devAgentId,
      task.qaAgentId,
      task.researchAgentId,
    ].filter((id): id is string => typeof id === 'string' && id !== ''));
    const secrets = collectSecretValues(this.manager.getConfig());
    collectSecretValues(task, secrets);
    collectSecretValues(record.trigger, secrets);
    const agentContexts = [];
    for (const id of ids) {
      const config = this.manager.getAgentConfig(id);
      if (!config) continue;
      const binding = await this.agentStore.get(id);
      collectSecretValues(binding, secrets);
      agentContexts.push({ id, config, binding });
    }
    const recentEvents = await this.recentEvents(task.id, contextErrors, secrets);
    for (const event of recentEvents) collectSecretValues(event.data, secrets);
    const agents = [];
    for (const { id, config, binding } of agentContexts) {
      let pane: string | undefined;
      if (this.capturePane) {
        try {
          const captured = await this.capturePane(id);
          if (captured) pane = truncateUtf8(redactContext(captured, secrets), MAX_PANE_BYTES);
        } catch (err) {
          const detail = `pane ${id}: ${err instanceof Error ? err.message : String(err)}`;
          const sanitizedDetail = sanitizeContextError(detail, secrets);
          contextErrors.push(sanitizedDetail);
          console.warn(`[root-agent] ${sanitizedDetail}`);
        }
      }
      const observation = this.statusStore.get(id);
      agents.push({
        id,
        role: config.role,
        runtime: config.runtime,
        binding: binding ? {
          taskId: binding.taskId,
          status: binding.status,
          awaitingPhase: binding.awaitingPhase,
          awaitingReason: binding.awaitingReason
            ? redactContext(binding.awaitingReason, secrets)
            : undefined,
          awaitingSince: binding.awaitingSince,
          updatedAt: binding.updatedAt,
        } : null,
        observation: {
          tmuxSessionStatus: observation.tmuxSessionStatus,
          runtimeStatusHint: observation.runtimeStatusHint,
          reason: observation.reason,
          message: observation.message ? redactContext(observation.message, secrets) : undefined,
          observedAt: observation.observedAt,
        },
        ...(pane ? { pane } : {}),
      });
    }

    const events = recentEvents.map(event => ({
      id: event.id,
      type: event.type,
      timestamp: event.timestamp,
      agentId: event.agentId,
      data: sanitizeEventData(event.data, secrets),
    }));
    const artifacts = await this.artifactSummary(task, contextErrors, secrets);
    const request = {
      version: 1,
      requestId: record.id,
      attemptToken: record.attemptToken,
      createdAt: record.createdAt,
      trigger: sanitizeValue(record.trigger, ROOT_RECOVERY_MAX_REASON_BYTES, 0, secrets),
      task: {
        id: task.id,
        projectId: task.projectId,
        title: truncateUtf8(redactContext(task.title, secrets), MAX_CONTEXT_STRING_BYTES),
        description: truncateUtf8(redactContext(task.description, secrets), MAX_CONTEXT_STRING_BYTES),
        status: task.status,
        phase: task.phase,
        agentId: task.agentId,
        devAgentId: task.devAgentId,
        qaAgentId: task.qaAgentId,
        researchAgentId: task.researchAgentId,
        prNumber: task.prNumber,
        prUrl: task.prUrl,
        branch: task.branch,
        reviewMode: task.reviewMode,
        reviewRound: task.reviewRound,
        specReviewRound: task.specReviewRound,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
      agents,
      recentEvents: events,
      artifacts,
      contextErrors: contextErrors.map(value => redactContext(value, secrets)),
      allowedDecisions: [
        ...(canRedispatch(record) ? [{
          action: 'redispatch-current-phase',
          meaning: 'Replay the current persisted phase through the existing Server recovery primitive.',
        }] : []),
        { action: 'escalate', meaning: 'Keep the task stopped and report why a human must decide.' },
        { action: 'no-op', meaning: 'The task should remain untouched; explain why.' },
      ],
      response: {
        relativePath: `${ROOT_OUTBOX_DIR}/${record.id}.json`,
        signalKind: 'root-done',
      },
    };
    return JSON.stringify(request, null, 2) + '\n';
  }

  private async recentEvents(
    taskId: string,
    contextErrors: string[],
    secrets: ReadonlySet<string>,
  ): Promise<BaxianEvent[]> {
    const to = this.now();
    const from = new Date(to.getTime() - 24 * 60 * 60_000);
    try {
      const events = await this.eventBus.readRange(day(from), day(to));
      return events
        .filter(event => event.taskId === taskId)
        .slice(-RECENT_EVENT_LIMIT);
    } catch (err) {
      const detail = `recent events: ${err instanceof Error ? err.message : String(err)}`;
      const sanitizedDetail = sanitizeContextError(detail, secrets);
      contextErrors.push(sanitizedDetail);
      console.warn(`[root-agent] ${sanitizedDetail}`);
      return [];
    }
  }

  private async artifactSummary(
    task: TaskState,
    contextErrors: string[],
    secrets: ReadonlySet<string>,
  ): Promise<Record<string, unknown>> {
    if (task.reviewMode !== 'server' && task.phase !== 'spec') return {};
    const summary: Record<string, unknown> = {};
    const transport = this.manager.getReviewTransport();
    const dev = this.manager.getAgentConfig(task.devAgentId || task.agentId);
    if (dev) {
      try {
        await this.manager.refreshWorkdirCacheFor(dev.id);
        const response = await transport.readResponse(task, dev);
        summary.response = response ? {
          round: response.round,
          responseCount: response.responses.length,
          actions: countBy(response.responses.map(item => item.action)),
        } : null;
      } catch (err) {
        const detail = `response artifact: ${err instanceof Error ? err.message : String(err)}`;
        const sanitizedDetail = sanitizeContextError(detail, secrets);
        contextErrors.push(sanitizedDetail);
        console.warn(`[root-agent] ${sanitizedDetail}`);
      }
    }
    const qa = task.qaAgentId ? this.manager.getAgentConfig(task.qaAgentId) : undefined;
    if (qa) {
      try {
        await this.manager.refreshWorkdirCacheFor(qa.id);
        const findings = await transport.readFindings(task, qa);
        summary.findings = findings ? {
          round: findings.round,
          verdict: findings.verdict,
          findingCount: findings.findings.length,
          severities: countBy(findings.findings.map(item => item.severity)),
        } : null;
      } catch (err) {
        const detail = `findings artifact: ${err instanceof Error ? err.message : String(err)}`;
        const sanitizedDetail = sanitizeContextError(detail, secrets);
        contextErrors.push(sanitizedDetail);
        console.warn(`[root-agent] ${sanitizedDetail}`);
      }
    }
    return summary;
  }

  private projectEnabled(projectId: string): boolean {
    return this.config.projects === undefined || this.config.projects.includes(projectId);
  }

  private isTimedOut(record: RootRecoveryRecord): boolean {
    if (!record.deliveredAt) return false;
    return this.timeoutReached(record.deliveredAt);
  }

  private async finishTimedOutResponse(record: RootRecoveryRecord): Promise<boolean> {
    if (!this.isTimedOut(record)) return false;
    if (await this.complete(record, 'timeout', 'Root agent did not return a valid response before the deadline.')) {
      await this.emitRootIntervention(record, 'root-response-timeout', 'Root agent response timed out.');
    }
    return true;
  }

  private async finishTimedOutDelivery(record: RootRecoveryRecord): Promise<boolean> {
    if (!this.isDeliveryTimedOut(record)) return false;
    const detail = 'Root prompt could not be submitted before the configured recovery deadline.';
    if (await this.complete(record, 'timeout', detail)) {
      await this.emitRootIntervention(record, 'root-prompt-delivery-timeout', detail);
    }
    return true;
  }

  private isDeliveryTimedOut(record: RootRecoveryRecord): boolean {
    return record.deliveredAt === undefined
      && record.dispatchedAt !== undefined
      && this.timeoutReached(record.dispatchedAt);
  }

  private timeoutReached(since: string): boolean {
    const timestamp = Date.parse(since);
    return Number.isFinite(timestamp)
      && this.now().getTime() - timestamp >= this.config.responseTimeoutMinutes * 60_000;
  }

  private async complete(
    record: RootRecoveryRecord,
    kind: RootRecoveryOutcome['kind'],
    detail: string,
  ): Promise<boolean> {
    const outcome: RootRecoveryOutcome = {
      kind,
      detail: truncateUtf8(detail, ROOT_RECOVERY_MAX_REASON_BYTES),
      at: this.now().toISOString(),
    };
    const result = await this.store.complete(record.id, outcome, record);
    if (!result.completed) return false;
    console.log(`[root-agent] recovery ${record.id} finished: ${kind}`);
    this.runtimeAlerts.delete(record.id);
    this.deliveryAlerts.delete(record.id);
    try {
      await this.runtime.cleanup(result.record!);
    } catch (err) {
      console.warn('[root-agent] mailbox cleanup failed for ' + record.id + ':', err);
    }
    if (!this.isRuntimeDispatchDisabled()) {
      try {
        await this.recoverCurrentTaskTriggers(result.record!);
        if (this.triggerRecoveryRechecks.get(record.taskId)?.id === result.record!.id) {
          this.triggerRecoveryRechecks.delete(record.taskId);
        }
      } catch (err) {
        this.triggerRecoveryRechecks.set(record.taskId, result.record!);
        console.warn(`[root-agent] follow-up trigger recovery failed for ${record.taskId}:`, err);
      }
    }
    return true;
  }

  private async finishRecoveryAfterRuntimeStop(initial: RootRecoveryRecord): Promise<void> {
    let record: RootRecoveryRecord | null = initial;
    while (record && record.status !== 'done') {
      const inflight = record.status === 'inflight';
      const detail = inflight
        ? 'Root runtime was explicitly stopped after dispatch; the recovery outcome is unknown and was not retried.'
        : 'Root runtime was explicitly stopped before delivery; the recovery was escalated to a human.';
      if (await this.complete(record, inflight ? 'unknown' : 'escalated', detail)) {
        await this.emitRootIntervention(
          record,
          inflight ? 'root-recovery-stopped-unknown' : 'root-recovery-stopped',
          detail,
        );
        return;
      }
      record = await this.store.get(initial.id);
    }
  }

  private async emitRootIntervention(
    record: RootRecoveryRecord,
    phase: string,
    detail: string,
  ): Promise<void> {
    await this.safeEmit({
      id: '',
      type: 'human.intervention',
      timestamp: this.now().toISOString(),
      projectId: record.projectId,
      taskId: record.taskId,
      ...(record.trigger.agentId ? { agentId: record.trigger.agentId } : {}),
      data: {
        source: 'root-agent',
        phase,
        rootRecoveryId: record.id,
        note: truncateUtf8(detail, ROOT_RECOVERY_MAX_REASON_BYTES),
      },
    });
  }

  private async safeEmit(event: BaxianEvent): Promise<void> {
    try {
      await this.eventBus.emit(event);
    } catch (err) {
      console.warn(`[root-agent] failed to emit ${event.type}/${String(event.data.phase)}:`, err);
    }
  }
}

function guardFor(task: TaskState): RootRecoveryGuard {
  return {
    status: task.status,
    ...(task.phase !== undefined ? { phase: task.phase } : {}),
    ...(task.signalToken !== undefined ? { signalToken: task.signalToken } : {}),
    agentId: task.agentId,
    reviewRound: task.reviewRound,
    ...(task.specReviewRound !== undefined ? { specReviewRound: task.specReviewRound } : {}),
  };
}

function parseResponse(raw: unknown, record: RootRecoveryRecord): RootRecoveryDecision {
  if (!isRecord(raw) || raw.version !== 1) throw new Error('root response.version must be 1');
  if (raw.requestId !== record.id) throw new Error('root response requestId does not match');
  if (raw.attemptToken !== record.attemptToken) throw new Error('root response attemptToken does not match');
  if (!isRecord(raw.decision)) throw new Error('root response decision must be an object');
  if (!ROOT_RECOVERY_ACTION_SET.has(raw.decision.action as string)) {
    throw new Error('root response decision.action is not allowed');
  }
  if (raw.decision.action === 'redispatch-current-phase' && !canRedispatch(record)) {
    throw new Error('root response requested redispatch for a non-replayable intervention');
  }
  if (typeof raw.decision.reason !== 'string' || raw.decision.reason.trim() === '') {
    throw new Error('root response decision.reason must be a non-empty string');
  }
  if (Buffer.byteLength(raw.decision.reason, 'utf8') > ROOT_RECOVERY_MAX_REASON_BYTES) {
    throw new Error(`root response decision.reason exceeds ${ROOT_RECOVERY_MAX_REASON_BYTES} bytes`);
  }
  const topKeys = Object.keys(raw).sort().join(',');
  const decisionKeys = Object.keys(raw.decision).sort().join(',');
  if (topKeys !== 'attemptToken,decision,requestId,version' || decisionKeys !== 'action,reason') {
    throw new Error('root response contains unsupported fields');
  }
  return {
    action: raw.decision.action as RootRecoveryDecision['action'],
    reason: raw.decision.reason,
  };
}

function canRedispatch(record: RootRecoveryRecord): boolean {
  return triggerCanRedispatch(record.trigger);
}

function triggerCanRedispatch(trigger: RootRecoveryTrigger): boolean {
  if (trigger.kind === 'runtime-stall') return trigger.reason === 'PENDING_IDLE';
  return trigger.phase !== undefined
    && trigger.holdPhase === trigger.phase
    && RECOVERABLE_QA_DISPATCH_HOLD_PHASES.has(trigger.phase);
}

function sameRedispatchLineage(left: RootRecoveryGuard, right: RootRecoveryGuard): boolean {
  return left.status === right.status
    && left.phase === right.phase
    && left.agentId === right.agentId
    && left.reviewRound === right.reviewRound
    && left.specReviewRound === right.specReviewRound;
}

function redispatchLimitEventId(taskId: string, guard: RootRecoveryGuard): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([
      taskId,
      guard.status,
      guard.phase,
      guard.agentId,
      guard.reviewRound,
      guard.specReviewRound,
    ]))
    .digest('hex')
    .slice(0, 24);
  return `root-redispatch-limit-${digest}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

function sanitizeValue(
  value: unknown,
  maxBytes: number,
  depth = 0,
  secrets: ReadonlySet<string> = new Set(),
): unknown {
  if (depth > 4) return '[truncated]';
  if (typeof value === 'string') return truncateUtf8(redactContext(value, secrets), maxBytes);
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(item => sanitizeValue(item, maxBytes, depth + 1, secrets));
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    if (isSensitiveField(key)) {
      output[key] = '[redacted]';
    } else {
      output[key] = sanitizeValue(item, maxBytes, depth + 1, secrets);
    }
  }
  return output;
}

function sanitizeEventData(value: unknown, secrets: ReadonlySet<string>): unknown {
  const sanitized = sanitizeValue(value, 512, 0, secrets);
  const serialized = JSON.stringify(sanitized);
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_EVENT_DATA_BYTES) return sanitized;
  return {
    truncated: true,
    preview: truncateUtf8(serialized, MAX_EVENT_DATA_BYTES - 64),
  };
}

function collectSecretValues(
  value: unknown,
  output: Set<string> = new Set(),
): Set<string> {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  let scanned = 0;
  while (pending.length > 0 && scanned < MAX_SECRET_SCAN_NODES) {
    const current = pending.pop();
    if (typeof current !== 'object' || current === null || seen.has(current)) continue;
    seen.add(current);
    scanned++;
    if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
      continue;
    }
    for (const [key, item] of Object.entries(current)) {
      if (
        isSensitiveField(key)
        && typeof item === 'string'
        && item.length >= MIN_GLOBAL_SECRET_CHARS
      ) {
        output.add(item);
        if (isBareCredentialField(key)) {
          const credential = BARE_AUTH_CREDENTIAL_RE.exec(item)?.[1];
          if (credential) output.add(credential);
        }
      }
      pending.push(item);
    }
  }
  return output;
}

function fieldWords(field: string): string[] {
  if (field.length > MAX_FIELD_NAME_CHARS) return [];
  return field
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isSensitiveField(field: string): boolean {
  if (field.length > MAX_FIELD_NAME_CHARS) return true;
  if (SENSITIVE_FIELD_RE.test(field)) return true;
  const normalized = field.replace(/[^a-z0-9]/gi, '').toLowerCase();
  for (const credential of KEY_CREDENTIAL_FIELDS) {
    if (normalized.endsWith(credential)) return true;
  }
  const words = fieldWords(field);
  return words.at(-1) === 'key'
    && KEY_CREDENTIAL_QUALIFIERS.has(words.at(-2) ?? '');
}

function isBareCredentialField(field: string): boolean {
  if (field.length > MAX_FIELD_NAME_CHARS) return true;
  const normalized = field.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (AUTHORIZATION_FIELDS.has(normalized)) return true;
  return /credentials?$/.test(normalized);
}

function sanitizeContextError(value: string, secrets: ReadonlySet<string>): string {
  return truncateUtf8(redactContext(value, secrets), MAX_CONTEXT_ERROR_BYTES);
}

function redactContext(value: string, secrets: ReadonlySet<string>): string {
  let redacted = stripSignalAnsi(value)
    .replace(/\[bx:[^\]]{0,2048}\]/g, '[bx:redacted]');
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(secret).join('[redacted]');
  }
  return redactLabeledValues(redacted);
}

function redactLabeledValues(value: string): string {
  const matcher = new RegExp(LABELED_FIELD_RE.source, LABELED_FIELD_RE.flags);
  let cursor = 0;
  let output = '';
  for (let match = matcher.exec(value); match; match = matcher.exec(value)) {
    const valueStart = matcher.lastIndex;
    if (!isSensitiveField(match[3])) {
      matcher.lastIndex = Math.max(match.index + 1, valueStart - 1);
      continue;
    }
    const valueEnd = labeledValueEnd(value, valueStart);
    if (valueEnd === valueStart) continue;
    output += value.slice(cursor, valueStart) + '[redacted]';
    cursor = valueEnd;
    matcher.lastIndex = Math.max(match.index + 1, valueEnd - 1);
  }
  return cursor === 0 ? value : output + value.slice(cursor);
}

function labeledValueEnd(value: string, start: number): number {
  const quote = value[start];
  if (quote === '"' || quote === "'") {
    for (let index = start + 1; index < value.length; index++) {
      if (value[index] === '\n' || value[index] === '\r') {
        return index;
      } else if (value[index] === '\\') {
        if (value[index + 1] === '\n' || value[index + 1] === '\r') return index + 1;
        index++;
      } else if (value[index] === quote) {
        return index + 1;
      }
    }
    return value.length;
  }
  const authorization = /^(?:Basic|Bearer)[\t ]+/i.exec(value.slice(start));
  if (authorization) {
    let end = start + authorization[0].length;
    while (end < value.length && !/[\s,;]/.test(value[end])) end++;
    return end;
  }
  let end = start;
  while (end < value.length && !/[\s,;]/.test(value[end])) end++;
  return end;
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function isLaterObservation(current: string | undefined, previous: string): boolean {
  if (current === undefined || current === previous) return false;
  const currentAt = Date.parse(current);
  const previousAt = Date.parse(previous);
  if (!Number.isFinite(currentAt) || !Number.isFinite(previousAt)) return true;
  return currentAt > previousAt;
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function holdEventId(binding: {
  id: string;
  taskId?: string;
  awaitingPhase?: string;
  awaitingSince?: string;
  awaitingNonce?: string;
}): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([
      binding.id,
      binding.taskId,
      binding.awaitingPhase,
      binding.awaitingSince,
      binding.awaitingNonce,
    ]))
    .digest('hex')
    .slice(0, 24);
  return `root-hold-${digest}`;
}
