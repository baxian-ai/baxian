import { PeriodicTaskRunner } from '../timing/periodic-task-runner.js';
import { computeBackoffMs } from '../timing/backoff.js';
import { computePollerHealth } from './poller-health.js';
import type { PollerSnapshot } from '../shared/types.js';
import { BRANCH_PREFIX } from '../shared/constants.js';
import { repoIdentityKey } from '../shared/git-url.js';
import { TASK_TERMINAL_STATUS_SET } from '../shared/constants.js';
import type { TaskState } from '../shared/types.js';
import type { CommentSourceOp, MappedEvent } from './types.js';
import { DriverOpError, type OpVars } from './git-driver.js';
import type { NormalizedRow } from './row-schema.js';
import { versionTimeOf } from './row-schema.js';
import { CommentCursorStore } from './comment-cursor.js';
import { VerdictEngine, type VerdictSourceScan } from './verdict-engine.js';
import { collectValidAcks, rowBodyDigest } from './markers.js';
import { createHash } from 'node:crypto';
import { buildAckCarrierRows, feedbackEventTarget, scanCommentSourcesOnce } from './feedback.js';
import { checkPrBinding, type BindingCheck } from './pr-binding.js';
import { TimelineCollector } from './review-timeline.js';
import type { PrConversationPayload } from './pr-conversation-cache.js';

export interface PlatformTaskView {
  taskId: string;
  terminal: boolean;
  status?: TaskState['status'];
  phase?: TaskState['phase'];
  branch?: string;
  prNumber?: number;
  anchorSha?: string;
  passToken?: string;
  failToken?: string;
  signalToken?: string;
  expectedBase?: string;
  latestHeadSha?: string;
  replyActorId?: string;
  replyActorStatus?: 'verified' | 'provisional';
  closedUnmergedAnchor?: boolean;
  inReview?: boolean;
}

type PlatformTasksProvider = (projectId: string) => Promise<PlatformTaskView[]>;

export function platformTaskView(task: TaskState): PlatformTaskView {
  return {
    taskId: task.id,
    terminal: TASK_TERMINAL_STATUS_SET.has(task.status),
    status: task.status,
    inReview: task.status === 'review',
    closedUnmergedAnchor: task.closedUnmergedAnchor !== undefined && task.closedUnmergedAnchor.cleared !== true,
    ...(task.branch !== undefined ? { branch: task.branch } : {}),
    ...(task.phase !== undefined ? { phase: task.phase } : {}),
    ...(task.prNumber !== undefined ? { prNumber: task.prNumber } : {}),
    ...(task.reviewHeadAnchorSha !== undefined ? { anchorSha: task.reviewHeadAnchorSha } : {}),
    ...(task.passToken !== undefined ? { passToken: task.passToken } : {}),
    ...(task.failToken !== undefined ? { failToken: task.failToken } : {}),
    ...(task.signalToken !== undefined ? { signalToken: task.signalToken } : {}),
    ...(task.baseBranch !== undefined ? { expectedBase: task.baseBranch } : {}),
    ...(task.latestHeadSha !== undefined ? { latestHeadSha: task.latestHeadSha } : {}),
    ...(task.replyActorId !== undefined ? { replyActorId: task.replyActorId } : {}),
    ...(task.replyActorStatus !== undefined ? { replyActorStatus: task.replyActorStatus } : {}),
  };
}

export interface PlatformDriver {
  readonly visibilityLagMs: number;
  readonly commentSources: CommentSourceOp[];
  readonly preflightIdentity?: string;
  runPreflightSteps?(): Promise<Array<{ step: string; ok: boolean; message: string }>>;
  runOp(opName: string, vars?: OpVars): Promise<NormalizedRow[]>;
  runListPrs(vars: OpVars, shouldStop?: (pageRows: NormalizedRow[], page: number) => boolean): Promise<NormalizedRow[]>;
  runCommentSource(
    source: CommentSourceOp,
    vars: OpVars,
    projectPage?: (pageRows: NormalizedRow[]) => NormalizedRow[],
  ): Promise<NormalizedRow[]>;
}

export interface PlatformPollerEntryInit {
  projectId: string;
  repoUrl: string;
  driver: PlatformDriver;
  statePath: string;
}

export interface PlatformPollerOptions {
  onEvent: (projectId: string, event: MappedEvent) => void | Promise<void>;
  tasks: PlatformTasksProvider;
  task: (taskId: string) => Promise<PlatformTaskView | null>;
  now?: () => number;
  onCursorCommitted?: (
    taskId: string, prNumber: number, sourceKey: string, watermarkTime: number,
  ) => void | Promise<void>;
  onConversationRevision?: (
    taskId: string,
    conversation?: { prNumber: number; payload: PrConversationPayload },
  ) => void | Promise<void>;
}

interface EntryStatus {
  isPolling: boolean;
  lastPollStartedAt?: string;
  lastPollEndedAt?: string;
  lastPollDurationMs?: number;
  lastErrorAt?: string;
  lastErrorMessage?: string;
  lastErrorClass?: string;
  consecutiveFailures: number;
}

interface ObservedPr {
  pushSha?: string;
  merged?: boolean;
  closedUnmerged?: boolean;
  bindingMismatch?: string;
}

interface AdoptionDeferral {
  fingerprint: string;
  cycles: number;
  interventionDelivered: boolean;
}

interface InternalEntry extends PlatformPollerEntryInit {
  repoKey: string;
  retired: boolean;
  pendingInit?: Pick<PlatformPollerEntryInit, 'projectId' | 'driver'>;
  cursor?: CommentCursorStore;
  status: EntryStatus;
  defaultBranch?: string;
  defaultBranchStale: number;
  observedPr: Map<string, ObservedPr>;
  conversationDigest: Map<string, string>;
  preflightPassed?: boolean;
  deliveredVerdicts: Map<string, string>;
  loggedUndated: Set<string>;
  baseMismatch: Map<number, string>;
  adoptionDeferrals: Map<number, AdoptionDeferral>;
  rateLimit?: { until: number; attempt: number };
}

interface CycleFailure {
  message: string;
  errorClass?: string;
}

class RateLimitAbort extends Error {
  constructor(readonly failure: CycleFailure, readonly failures: CycleFailure[]) {
    super(failure.message);
    this.name = 'RateLimitAbort';
  }
}

class CycleFailuresError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CycleFailuresError';
  }
}

class EntryRetiredError extends Error {
  constructor() {
    super('platform poller entry retired during reconciliation');
    this.name = 'EntryRetiredError';
  }
}

const RATE_LIMIT_BACKOFF_MIN_MS = 60_000;
const RATE_LIMIT_BACKOFF_MAX_MS = 900_000;
const DEFAULT_BRANCH_STALE_CYCLES = 3;
const ADOPTION_DEFERRAL_INTERVENTION_CYCLES = 3;

export class PlatformPoller {
  private readonly entries: InternalEntry[] = [];
  private readonly engine = new VerdictEngine();
  private periodicRunner?: PeriodicTaskRunner;
  private isPolling = false;
  private intervalMs?: number;
  private lifecycleHook?: () => void;
  private readonly now: () => number;

  constructor(private readonly opts: PlatformPollerOptions) {
    this.now = opts.now ?? Date.now;
  }

  add(init: PlatformPollerEntryInit): void {
    this.entries.push({
      ...init,
      repoKey: repoIdentityKey(init.repoUrl),
      retired: false,
      status: { isPolling: false, consecutiveFailures: 0 },
      defaultBranchStale: 0,
      observedPr: new Map(),
      conversationDigest: new Map(),
      deliveredVerdicts: new Map(),
      loggedUndated: new Set(),
      baseMismatch: new Map(),
      adoptionDeferrals: new Map(),
    });
  }

  reconcile(wanted: readonly PlatformPollerEntryInit[]): void {
    const wantedByKey = this.indexWantedEntries(wanted);
    this.retireUnwantedEntries(wantedByKey);
    this.upsertWantedEntries(wantedByKey);
    this.fireLifecycle();
  }

  private indexWantedEntries(
    wanted: readonly PlatformPollerEntryInit[],
  ): Map<string, PlatformPollerEntryInit> {
    const wantedByKey = new Map<string, PlatformPollerEntryInit>();
    for (const init of wanted) {
      const key = repoIdentityKey(init.repoUrl);
      if (!wantedByKey.has(key)) wantedByKey.set(key, init);
    }
    return wantedByKey;
  }

  private retireUnwantedEntries(wantedByKey: ReadonlyMap<string, PlatformPollerEntryInit>): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (!wantedByKey.has(this.entries[i].repoKey)) {
        this.entries[i].retired = true;
        this.entries.splice(i, 1);
      }
    }
  }

  private upsertWantedEntries(wantedByKey: ReadonlyMap<string, PlatformPollerEntryInit>): void {
    const existingByKey = new Map(this.entries.map(e => [e.repoKey, e]));
    for (const [key, init] of wantedByKey) {
      const existing = existingByKey.get(key);
      if (existing) {
        if (existing.status.isPolling) {
          existing.pendingInit = { projectId: init.projectId, driver: init.driver };
        } else {
          this.applyEntryInit(existing, init);
        }
      } else {
        this.add(init);
      }
    }
  }

  private applyEntryInit(
    entry: InternalEntry,
    init: Pick<PlatformPollerEntryInit, 'projectId' | 'driver'>,
  ): void {
    if (entry.retired) return;
    entry.projectId = init.projectId;
    const samePreflight = entry.driver.preflightIdentity !== undefined
      && init.driver.preflightIdentity !== undefined
      ? entry.driver.preflightIdentity === init.driver.preflightIdentity
      : entry.driver === init.driver;
    if (!samePreflight) entry.preflightPassed = undefined;
    entry.driver = init.driver;
  }

  setLifecycleHook(fn: () => void): void {
    this.lifecycleHook = fn;
  }

  private fireLifecycle(): void {
    if (!this.lifecycleHook) return;
    try {
      this.lifecycleHook();
    } catch (err) {
      console.error('[PlatformPoller] lifecycle hook threw:', err);
    }
  }

  defaultBranchSnapshot(repoKey: string): string | undefined {
    const entry = this.entries.find(e => e.repoKey === repoKey);
    if (entry?.defaultBranch === undefined) return undefined;
    return entry.defaultBranchStale < DEFAULT_BRANCH_STALE_CYCLES ? entry.defaultBranch : undefined;
  }

  snapshots(): PollerSnapshot[] {
    return this.entries.map(e => ({
      rateLimitedUntil: e.rateLimit === undefined ? undefined : new Date(e.rateLimit.until).toISOString(),
      repo: e.repoKey,
      projectId: e.projectId,
      intervalMs: this.intervalMs ?? 0,
      isPolling: e.status.isPolling,
      lastPollStartedAt: e.status.lastPollStartedAt,
      lastPollEndedAt: e.status.lastPollEndedAt,
      lastPollDurationMs: e.status.lastPollDurationMs,
      lastErrorAt: e.status.lastErrorAt,
      lastErrorMessage: e.status.lastErrorMessage,
      lastErrorClass: e.status.lastErrorClass,
      consecutiveFailures: e.status.consecutiveFailures,
      health: computePollerHealth(e.status.consecutiveFailures, e.status.lastPollEndedAt),
    }));
  }

  start(intervalMs: number): void {
    this.intervalMs = intervalMs;
    if (this.periodicRunner === undefined) {
      this.periodicRunner = new PeriodicTaskRunner({
        name: 'PlatformPoller',
        intervalMs,
        run: () => this.poll(),
        onError: e => console.warn('[PlatformPoller] poll failed:', e),
      });
    } else {
      this.periodicRunner.reschedule(intervalMs);
    }
    this.periodicRunner.start();
  }

  reschedule(intervalMs: number): void {
    this.intervalMs = intervalMs;
    this.periodicRunner?.reschedule(intervalMs);
  }

  stop(): void {
    this.periodicRunner?.stop();
  }

  async poll(): Promise<void> {
    if (this.isPolling) {
      console.warn('[PlatformPoller] poll skipped: previous cycle still in flight');
      return;
    }
    this.isPolling = true;
    try {
      for (const entry of [...this.entries]) {
        if (entry.retired || !this.entries.includes(entry)) continue;
        try {
          await this.pollOne(entry);
        } catch (e) {
          if (e instanceof EntryRetiredError) continue;
          console.warn(`[PlatformPoller] entry ${entry.repoKey} failed:`, e instanceof Error ? e.message : e);
        }
      }
    } finally {
      this.isPolling = false;
    }
  }

  private async pollOne(entry: InternalEntry): Promise<void> {
    this.assertEntryActive(entry);
    if (entry.rateLimit !== undefined && this.now() < entry.rateLimit.until) {
      entry.defaultBranchStale += 1;
      return;
    }
    const startedAt = this.now();
    entry.status.isPolling = true;
    entry.status.lastPollStartedAt = new Date(startedAt).toISOString();
    this.fireLifecycle();
    try {
      if (entry.cursor === undefined) {
        const cursor = new CommentCursorStore(entry.statePath, entry.repoUrl);
        await cursor.load();
        entry.cursor = cursor;
      }
      const failures = await this.pollCycle(entry);
      entry.rateLimit = undefined;
      if (failures.length > 0) {
        this.recordFailure(entry, failures[0].message, failures.find(f => f.errorClass !== undefined)?.errorClass);
        throw new CycleFailuresError(`platform poll: ${failures.length} failure(s); first: ${failures[0].message}`);
      }
      entry.status.consecutiveFailures = 0;
      entry.status.lastErrorClass = undefined;
    } catch (e) {
      if (e instanceof EntryRetiredError) return;
      if (e instanceof RateLimitAbort) {
        const attempt = (entry.rateLimit?.attempt ?? 0) + 1;
        const backoffMs = computeBackoffMs(attempt, {
          baseMs: RATE_LIMIT_BACKOFF_MIN_MS, maxMs: RATE_LIMIT_BACKOFF_MAX_MS,
        });
        entry.rateLimit = { until: this.now() + backoffMs, attempt };
        const nonRateLimit = e.failures.filter(f => f.errorClass !== 'RATE_LIMIT');
        if (nonRateLimit.length > 0) {
          this.recordFailure(
            entry,
            nonRateLimit[0].message,
            nonRateLimit.find(f => f.errorClass !== undefined)?.errorClass ?? 'RATE_LIMIT',
          );
          throw new CycleFailuresError(
            `platform poll: rate limited (backing off ${backoffMs}ms) after ${nonRateLimit.length} failure(s); first: ${nonRateLimit[0].message}`,
          );
        }
        entry.status.lastErrorAt = new Date(this.now()).toISOString();
        entry.status.lastErrorMessage = e.failure.message;
        entry.status.lastErrorClass = 'RATE_LIMIT';
        throw new CycleFailuresError(`platform poll: rate limited, backing off ${backoffMs}ms`);
      }
      if (!(e instanceof CycleFailuresError)) {
        this.recordFailure(
          entry,
          e instanceof Error ? e.message : String(e),
          e instanceof DriverOpError ? e.info.errorClass : undefined,
        );
      }
      throw e;
    } finally {
      entry.status.isPolling = false;
      if (!entry.retired && entry.pendingInit !== undefined) {
        this.applyEntryInit(entry, entry.pendingInit);
        entry.pendingInit = undefined;
      }
      const endedAt = this.now();
      entry.status.lastPollEndedAt = new Date(endedAt).toISOString();
      entry.status.lastPollDurationMs = endedAt - startedAt;
      this.fireLifecycle();
    }
  }

  private recordFailure(entry: InternalEntry, message: string, errorClass: string | undefined): void {
    entry.status.lastErrorAt = new Date(this.now()).toISOString();
    entry.status.lastErrorMessage = message;
    entry.status.lastErrorClass = errorClass;
    entry.status.consecutiveFailures += 1;
  }

  private async pollCycle(entry: InternalEntry): Promise<CycleFailure[]> {
    const failures: CycleFailure[] = [];
    const fail = (context: string, e: unknown) => {
      if (e instanceof EntryRetiredError) throw e;
      const failure: CycleFailure = {
        message: `${context}: ${e instanceof Error ? e.message : String(e)}`,
        errorClass: e instanceof DriverOpError ? e.info.errorClass : undefined,
      };
      failures.push(failure);
      if (failure.errorClass === 'RATE_LIMIT') throw new RateLimitAbort(failure, failures);
    };
    try {
      await entry.cursor!.flushIfDirty();
      this.assertEntryActive(entry);
    } catch (e) {
      fail('cursor flush', e);
    }
    const tasks = await this.opts.tasks(entry.projectId);
    this.assertEntryActive(entry);
    const byId = new Map(tasks.map(t => [t.taskId, t]));

    for (const gen of entry.cursor!.generations()) {
      let authoritative: PlatformTaskView | null;
      try {
        authoritative = await this.opts.task(gen);
        this.assertEntryActive(entry);
      } catch (e) {
        fail(`read task ${gen}`, e);
        continue;
      }
      if (authoritative === null || authoritative.terminal) {
        try {
          this.assertEntryActive(entry);
          await entry.cursor!.dropGeneration(gen);
          this.assertEntryActive(entry);
        } catch (e) {
          fail(`dropGeneration ${gen}`, e);
        }
      }
    }
    try {
      await entry.cursor!.pruneSources(new Set(entry.driver.commentSources.map(s => s.key)));
    } catch (e) {
      fail('pruneSources', e);
    }
    const activeKeys = new Set<string>();
    const activePrs = new Set<number>();
    for (const t of tasks) {
      if (t.terminal) {
        this.engine.dropTask(t.taskId);
        continue;
      }
      if (t.prNumber !== undefined) {
        activePrs.add(t.prNumber);
        activeKeys.add(`${t.taskId}:${t.prNumber}`);
      }
    }
    for (const key of entry.observedPr.keys()) {
      if (!activeKeys.has(key)) entry.observedPr.delete(key);
    }
    for (const key of entry.deliveredVerdicts.keys()) {
      if (!activeKeys.has(key)) entry.deliveredVerdicts.delete(key);
    }
    for (const key of entry.conversationDigest.keys()) {
      if (!activeKeys.has(key)) entry.conversationDigest.delete(key);
    }
    for (const key of entry.loggedUndated) {
      if (!activePrs.has(Number(key.split(':')[0]))) entry.loggedUndated.delete(key);
    }

    if (entry.preflightPassed !== true && entry.driver.runPreflightSteps !== undefined) {
      let steps: Array<{ step: string; ok: boolean; message: string }>;
      try {
        steps = await entry.driver.runPreflightSteps();
        this.assertEntryActive(entry);
      } catch (e) {
        entry.defaultBranchStale += 1;
        fail('driver-preflight', e);
        return failures;
      }
      const bad = steps.find(s => !s.ok);
      if (bad !== undefined) {
        entry.defaultBranchStale += 1;
        fail(bad.step, new Error(bad.message));
        return failures;
      }
    }

    let defaultBranch: string | undefined;
    try {
      const [row] = await entry.driver.runOp('projectView');
      this.assertEntryActive(entry);
      if (row !== undefined && typeof row.defaultBranch === 'string') {
        entry.defaultBranch = row.defaultBranch;
        entry.defaultBranchStale = 0;
        defaultBranch = row.defaultBranch;
      }
      if (row !== undefined && entry.preflightPassed !== true && entry.driver.runPreflightSteps !== undefined) {
        if (row.pushPermitted === false) {
          fail('preflight-push', new Error(
            `push permission missing for ${entry.repoUrl} — server merge/close requires write access`,
          ));
          return failures;
        } else {
          if (row.pushPermitted === undefined) {
            console.warn(`[PlatformPoller] ${entry.repoKey}: plugin did not report pushPermitted — write access cannot be asserted`);
          }
          entry.preflightPassed = true;
        }
      }
    } catch (e) {
      entry.defaultBranchStale += 1;
      fail('projectView', e);
    }
    const usableDefault = defaultBranch
      ?? (entry.defaultBranch !== undefined && entry.defaultBranchStale < DEFAULT_BRANCH_STALE_CYCLES
        ? entry.defaultBranch
        : undefined);

    await this.pollListPrs(entry, tasks, byId, defaultBranch, fail, failures);
    this.assertEntryActive(entry);

    for (const task of tasks) {
      if (task.terminal || task.prNumber === undefined) continue;
      if (task.closedUnmergedAnchor === true) continue;
      await this.subPoll(entry, task, usableDefault, fail);
      this.assertEntryActive(entry);
    }
    return failures;
  }

  private bindingCheck(
    task: PlatformTaskView,
    prRow: NormalizedRow,
    defaultBranch: string | undefined,
  ): BindingCheck | undefined {
    return checkPrBinding(prRow, {
      branch: task.branch,
      expectedBase: task.expectedBase,
      ...(defaultBranch !== undefined ? { defaultBranch } : {}),
    });
  }

  private async pollListPrs(
    entry: InternalEntry,
    tasks: PlatformTaskView[],
    byId: Map<string, PlatformTaskView>,
    defaultBranch: string | undefined,
    fail: (context: string, e: unknown) => void,
    failures: CycleFailure[],
  ): Promise<void> {
    const prsCursor = entry.cursor!.listPrsCursor();
    const scanStartedAt = this.now();
    let prRows: NormalizedRow[];
    try {
      prRows = await entry.driver.runListPrs({}, pageRows => {
        if (prsCursor.watermarkTime === null) return false;
        return pageRows.some(r => {
          const vt = versionTimeOf(r);
          return vt !== undefined && vt < prsCursor.watermarkTime!;
        });
      });
      this.assertEntryActive(entry);
    } catch (e) {
      fail('listPrs', e);
      return;
    }
    const listedPrRows = [...prRows];

    const pendingByPr = new Map<number, string>();
    const activeDeferrals = new Set<number>();
    for (const pending of entry.cursor!.pendingAdoptions()) {
      let task: PlatformTaskView | null;
      try {
        task = await this.opts.task(pending.taskId);
        this.assertEntryActive(entry);
        if (task === null || task.terminal || (task.prNumber !== undefined && task.prNumber !== pending.prNumber)) {
          await entry.cursor!.clearAdoptionPending(pending.taskId, pending.prNumber);
          continue;
        }
        if (task.prNumber === pending.prNumber) {
          await entry.cursor!.markAdoptionDelivered(pending.taskId, pending.prNumber);
          continue;
        }
        byId.set(task.taskId, task);
        pendingByPr.set(pending.prNumber, pending.taskId);
        if (prRows.some(row => row.prNumber === pending.prNumber)) continue;
        const [row] = await entry.driver.runOp('prView', { prNumber: pending.prNumber });
        this.assertEntryActive(entry);
        if (row !== undefined) prRows.push({ ...row, prNumber: pending.prNumber });
      } catch (e) {
        activeDeferrals.add(pending.prNumber);
        fail(`retry adoption pr#${pending.prNumber}`, e);
      }
    }

    const boundByPr = new Map<number, PlatformTaskView>();
    for (const t of tasks) {
      if (!t.terminal && t.prNumber !== undefined) boundByPr.set(t.prNumber, t);
    }
    const failuresBefore = failures.length;
    const seenPrs = new Set<number>();
    const clearPending = async (prNumber: number): Promise<void> => {
      const taskId = pendingByPr.get(prNumber);
      if (taskId === undefined) return;
      await entry.cursor!.clearAdoptionPending(taskId, prNumber);
      pendingByPr.delete(prNumber);
    };
    for (const row of prRows) {
      const prNumber = row.prNumber as number;
      seenPrs.add(prNumber);
      const base = {
        prNumber,
        prUrl: String(row.prUrl),
        branch: String(row.branch),
      };
      const boundTask = boundByPr.get(prNumber);
      if (boundTask !== undefined) {
        await clearPending(prNumber);
        if (boundTask.closedUnmergedAnchor === true && row.state === 'open') {
          try {
            await this.emit(entry, 'pr.updated', { ...base, kind: 'reopened' }, boundTask.taskId);
            entry.observedPr.delete(`${boundTask.taskId}:${prNumber}`);
          } catch (e) {
            fail(`reopen pr#${prNumber}`, e);
          }
        }
        continue;
      }
      if (row.state !== 'open' || row.draft === true) {
        await clearPending(prNumber);
        continue;
      }
      if (!base.branch.startsWith(BRANCH_PREFIX)) {
        await clearPending(prNumber);
        continue;
      }
      const task = byId.get(base.branch.slice(BRANCH_PREFIX.length));
      if (task === undefined || task.terminal || task.prNumber !== undefined) {
        await clearPending(prNumber);
        continue;
      }
      const pendingTaskId = pendingByPr.get(prNumber);
      if (pendingTaskId !== undefined && pendingTaskId !== task.taskId) await clearPending(prNumber);
      if (task.branch !== base.branch) {
        await clearPending(prNumber);
        continue;
      }
      if (row.sourceProjectId === null || row.sourceProjectId === undefined
        || row.sourceProjectId !== row.targetProjectId) {
        await clearPending(prNumber);
        continue;
      }
      const target = String(row.targetBranch);
      if (entry.cursor!.isAdoptionDelivered(task.taskId, prNumber)) continue;
      try {
        if (task.expectedBase !== undefined) {
          if (target !== task.expectedBase) {
            await clearPending(prNumber);
            continue;
          }
        } else {
          if (defaultBranch === undefined) {
            await entry.cursor!.markAdoptionPending(task.taskId, prNumber);
            pendingByPr.set(prNumber, task.taskId);
            activeDeferrals.add(prNumber);
            continue;
          }
          if (target !== defaultBranch) {
            const fp = [task.taskId, target, defaultBranch].join('\0');
            if (entry.baseMismatch.get(prNumber) !== fp) {
              await this.emit(entry, 'human.intervention', {
                ...base, reason: 'base-mismatch', targetBranch: target, expectedBase: defaultBranch, taskId: task.taskId,
              }, task.taskId);
              entry.baseMismatch.set(prNumber, fp);
            }
            await clearPending(prNumber);
            continue;
          }
        }
        const adoptionFingerprint = [
          task.taskId,
          task.status ?? '',
          task.phase ?? '',
          task.signalToken ?? '',
          base.branch,
          target,
          String(row.headSha),
        ].join('\0');
        const deferred = entry.adoptionDeferrals.get(prNumber);
        if (deferred?.fingerprint === adoptionFingerprint) {
          deferred.cycles += 1;
          activeDeferrals.add(prNumber);
          if (!deferred.interventionDelivered
            && deferred.cycles >= ADOPTION_DEFERRAL_INTERVENTION_CYCLES) {
            await this.emit(entry, 'human.intervention', {
              ...base,
              reason: 'pr-adoption-deferred',
              taskId: task.taskId,
              status: task.status,
              phase: task.phase,
              cycles: deferred.cycles,
            }, task.taskId);
            deferred.interventionDelivered = true;
          }
          continue;
        }
        entry.adoptionDeferrals.delete(prNumber);
        await this.emit(entry, 'pr.created', {
          ...base, headSha: String(row.headSha), targetBranch: target,
          ...(typeof row.prAuthorId === 'string' ? { prAuthorId: row.prAuthorId } : {}),
        }, task.taskId);
        const adoptedTask = await this.opts.task(task.taskId);
        if (adoptedTask?.prNumber !== prNumber) {
          await entry.cursor!.markAdoptionPending(task.taskId, prNumber);
          pendingByPr.set(prNumber, task.taskId);
          entry.adoptionDeferrals.set(prNumber, {
            fingerprint: adoptionFingerprint,
            cycles: 1,
            interventionDelivered: false,
          });
          activeDeferrals.add(prNumber);
          continue;
        }
        await entry.cursor!.markAdoptionDelivered(task.taskId, prNumber);
        entry.baseMismatch.delete(prNumber);
        entry.adoptionDeferrals.delete(prNumber);
      } catch (e) {
        fail(`adopt pr#${prNumber}`, e);
      }
    }
    for (const pr of entry.baseMismatch.keys()) {
      if (!seenPrs.has(pr)) entry.baseMismatch.delete(pr);
    }
    for (const pr of entry.adoptionDeferrals.keys()) {
      if (!activeDeferrals.has(pr)) entry.adoptionDeferrals.delete(pr);
    }

    if (failures.length > failuresBefore) return;
    try {
      this.assertEntryActive(entry);
      await entry.cursor!.commitListPrs(listedPrRows, scanStartedAt - entry.driver.visibilityLagMs);
    } catch (e) {
      fail('listPrs cursor commit', e);
    }
  }

  private async subPoll(
    entry: InternalEntry,
    task: PlatformTaskView,
    defaultBranch: string | undefined,
    fail: (context: string, e: unknown) => void,
  ): Promise<void> {
    const prNumber = task.prNumber!;
    const obsKey = `${task.taskId}:${prNumber}`;
    let prRow: NormalizedRow | undefined;
    try {
      [prRow] = await entry.driver.runOp('prView', { prNumber });
      this.assertEntryActive(entry);
    } catch (e) {
      fail(`prView pr#${prNumber}`, e);
      return;
    }
    if (prRow === undefined) return;
    const observed = entry.observedPr.get(obsKey) ?? {};
    entry.observedPr.set(obsKey, observed);
    const base = { prNumber, prUrl: String(prRow.prUrl), branch: String(prRow.branch) };

    const binding = this.bindingCheck(task, prRow, defaultBranch);
    if (binding !== undefined) {
      this.engine.dropCandidate(task.taskId, prNumber);
      if (binding.kind === 'mismatch' && observed.bindingMismatch !== binding.mismatch) {
        try {
          await this.emit(entry, 'human.intervention', {
            ...base,
            reason: 'binding-mismatch',
            mismatch: binding.mismatch,
            taskId: task.taskId,
            targetBranch: String(prRow.targetBranch),
            ...(task.expectedBase !== undefined ? { expectedBase: task.expectedBase } : {}),
          }, task.taskId);
          observed.bindingMismatch = binding.mismatch;
        } catch (e) {
          fail(`binding-mismatch pr#${prNumber}`, e);
        }
      }
      return;
    }
    observed.bindingMismatch = undefined;

    if (prRow.state === 'closed') {
      this.engine.dropCandidate(task.taskId, prNumber);
      if (typeof prRow.mergedAt === 'string') {
        if (observed.merged !== true) {
          try {
            await this.emit(entry, 'pr.merged', base, task.taskId);
            observed.merged = true;
          } catch (e) {
            fail(`merged pr#${prNumber}`, e);
          }
        }
      } else if (observed.closedUnmerged !== true) {
        try {
          await this.emit(entry, 'pr.updated', { ...base, kind: 'closed-unmerged' }, task.taskId);
          observed.closedUnmerged = true;
        } catch (e) {
          fail(`closed pr#${prNumber}`, e);
        }
      }
      return;
    }

    observed.closedUnmerged = false;
    const headSha = String(prRow.headSha);
    if (task.latestHeadSha !== undefined && headSha !== task.latestHeadSha.toLowerCase() && observed.pushSha !== headSha) {
      try {
        await this.emit(entry, 'pr.updated', { ...base, kind: 'push', headSha }, task.taskId);
        observed.pushSha = headSha;
      } catch (e) {
        fail(`push pr#${prNumber}`, e);
      }
    }

    const { scans, payload } = await this.scanCommentSources(entry, task, base, fail);
    await this.noteConversationProjection(entry, task.taskId, obsKey, scans, { prNumber, payload });

    const anchorSha = task.anchorSha?.toLowerCase();
    const verdictEligible = task.inReview === true
      && prRow.draft === false
      && task.passToken !== undefined && task.failToken !== undefined
      && anchorSha !== undefined
      && task.signalToken !== undefined && task.signalToken.trim() !== ''
      && headSha === anchorSha;
    if (!verdictEligible) {
      this.engine.dropCandidate(task.taskId, prNumber);
      return;
    }
    const decision = this.engine.evaluate({
      taskId: task.taskId,
      prNumber,
      anchorSha: anchorSha,
      pair: { passToken: task.passToken!, failToken: task.failToken! },
      sources: scans,
      visibilityLagMs: entry.driver.visibilityLagMs,
    });
    if (decision === undefined) return;
    const fp = [task.passToken, task.failToken, decision.kind, decision.carrier.sourceKey, decision.carrier.id, decision.carrier.bodyDigest].join(':');
    if (entry.deliveredVerdicts.get(obsKey) === fp) return;
    try {
      const [freshRow] = await entry.driver.runOp('prView', { prNumber });
      this.assertEntryActive(entry);
      const freshEligible = freshRow !== undefined
        && this.bindingCheck(task, freshRow, defaultBranch) === undefined
        && freshRow.state === 'open' && freshRow.draft === false
        && String(freshRow.headSha) === anchorSha;
      if (!freshEligible) {
        this.engine.dropCandidate(task.taskId, prNumber);
        return;
      }
      await this.emit(entry, 'review.submitted', {
        ...base,
        source: 'platform-poller',
        action: decision.kind === 'pass' ? 'APPROVE' : 'REQUEST_CHANGES',
        headSha: decision.anchorSha,
        currentHeadSha: String(freshRow.headSha),
        submittedAt: decision.submittedAt,
        reviewPassToken: task.signalToken,
        verdictToken: decision.token,
        verdictConflict: decision.conflict,
        verdictCarrier: decision.carrier,
      }, task.taskId);
      entry.deliveredVerdicts.set(obsKey, fp);
    } catch (e) {
      fail(`verdict pr#${prNumber}`, e);
    }
  }

  private async noteConversationProjection(
    entry: InternalEntry,
    taskId: string,
    obsKey: string,
    scans: VerdictSourceScan[],
    conversation: { prNumber: number; payload: PrConversationPayload },
  ): Promise<void> {
    const notify = this.opts.onConversationRevision;
    if (notify === undefined) return;
    if (scans.length === 0 || scans.some(s => !s.ok)) return;
    const h = createHash('sha256');
    for (const scan of [...scans].sort((a, b) => a.key.localeCompare(b.key))) {
      const rows = [...scan.rows].sort((a, b) => {
        const ai = String(a.id);
        const bi = String(b.id);
        if (ai !== bi) return ai < bi ? -1 : 1;
        const ad = rowBodyDigest(a);
        const bd = rowBodyDigest(b);
        return ad < bd ? -1 : ad > bd ? 1 : 0;
      });
      for (const row of rows) {
        h.update(`${scan.key}:${String(row.id)}:${rowBodyDigest(row)}:${String(row.reviewState ?? '')}:${String(versionTimeOf(row) ?? '')}\n`);
      }
    }
    const digest = h.digest('hex');
    if (entry.conversationDigest.get(obsKey) === digest) return;
    try {
      await notify(taskId, conversation);
      entry.conversationDigest.set(obsKey, digest);
    } catch (e) {
      console.warn('[PlatformPoller] onConversationRevision failed:', e instanceof Error ? e.message : e);
    }
  }

  private async scanCommentSources(
    entry: InternalEntry,
    task: PlatformTaskView,
    base: { prNumber: number; prUrl: string; branch: string },
    fail: (context: string, e: unknown) => void,
  ): Promise<{ scans: VerdictSourceScan[]; payload: PrConversationPayload }> {
    const collector = new TimelineCollector(entry.driver.commentSources);
    const scans = await scanCommentSourcesOnce(entry.driver, base.prNumber, this.now,
      (key, error) => fail(`listComments[${key}] pr#${base.prNumber}`, error), collector);

    const ackCollection = collectValidAcks(buildAckCarrierRows(scans), {
      replyActorId: task.replyActorId,
      replyActorStatus: task.replyActorStatus,
    });

    for (const scan of scans) {
      if (!scan.ok) continue;
      const view = entry.cursor!.source(task.taskId, base.prNumber, scan.key);
      const cutoff = scan.scanStartedAt - entry.driver.visibilityLagMs;
      const { fresh, undated } = entry.cursor!.classify(view, scan.rows, cutoff);
      if (undated > 0) {
        const undatedKey = `${base.prNumber}:${scan.key}`;
        if (!entry.loggedUndated.has(undatedKey)) {
          entry.loggedUndated.add(undatedKey);
          console.warn(
            `[PlatformPoller] listComments[${scan.key}] pr#${base.prNumber}: skipped ${undated} row(s) without timestamps (undatable for watermark ordering, e.g. pending reviews)`,
          );
        }
      }
      let delivered = true;
      for (const row of fresh) {
        const target = feedbackEventTarget(row, scan.key, ackCollection);
        if (target === undefined) continue;
        const { id, digest } = target;
        if (entry.cursor!.isDelivered(view, id, digest)) continue;
        try {
          await this.emit(entry, 'pr.updated', {
            ...base,
            kind: scan.sourceClass === 'threaded' ? 'review-comment' : 'comment',
            commentId: row.id,
            revision: { sourceKey: scan.key, id, bodyDigest: digest, versionTime: versionTimeOf(row) },
            ...(scan.sourceClass === 'threaded' && row.discussionId !== null && row.discussionId !== undefined
              ? { reviewCommentReply: true }
              : {}),
          }, task.taskId);
          await entry.cursor!.markDelivered(task.taskId, base.prNumber, scan.key, id, digest);
        } catch (e) {
          delivered = false;
          fail(`comment ${scan.key}#${id} pr#${base.prNumber}`, e);
        }
      }
      if (delivered) {
        try {
          this.assertEntryActive(entry);
          await entry.cursor!.commitSource(task.taskId, base.prNumber, scan.key, scan.rows, cutoff);
        } catch (e) {
          fail(`listComments[${scan.key}] cursor commit pr#${base.prNumber}`, e);
          continue;
        }
        const committed = entry.cursor!.source(task.taskId, base.prNumber, scan.key).watermarkTime;
        if (committed !== null) {
          try {
            await this.opts.onCursorCommitted?.(task.taskId, base.prNumber, scan.key, committed);
          } catch (e) {
            console.warn(`[PlatformPoller] onCursorCommitted(${scan.key}) failed:`, e instanceof Error ? e.message : e);
          }
        }
      }
    }
    return { scans, payload: collector.assemble() };
  }

  private async emit(
    entry: InternalEntry, type: MappedEvent['type'], data: Record<string, unknown>, taskId: string,
  ): Promise<void> {
    this.assertEntryActive(entry);
    await this.opts.onEvent(entry.projectId, { type, repo: entry.repoKey, data, taskId });
  }

  private assertEntryActive(entry: InternalEntry): void {
    if (entry.retired || !this.entries.includes(entry)) throw new EntryRetiredError();
  }
}
