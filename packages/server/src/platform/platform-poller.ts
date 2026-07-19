import { PeriodicTaskRunner } from '../timing/periodic-task-runner.js';
import { computeBackoffMs } from '../timing/backoff.js';
import type { MappedEvent } from '../github/mapper.js';
import { computePollerHealth } from '../github/poller.js';
import type { PollerSnapshot } from '../shared/types.js';
import { BRANCH_PREFIX } from '../shared/constants.js';
import { repoIdentityKey } from '../shared/git-url.js';
import type { CommentSourceOp } from './types.js';
import { DriverOpError, type OpVars } from './git-driver.js';
import type { NormalizedRow } from './row-schema.js';
import { versionTimeOf } from './row-schema.js';
import { CommentCursorStore } from './comment-cursor.js';
import { VerdictEngine, type VerdictSourceScan } from './verdict-engine.js';
import {
  ackCarrierKey, ackRevisionKey, classifyCommentSource, collectValidAcks, projectCommentRow,
  rowAcks, rowBodyDigest, rowHasBody, rowTokens, type AckCarrierRow,
} from './markers.js';

export interface PlatformTaskView {
  taskId: string;
  terminal: boolean;
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
}

export type PlatformTasksProvider = (projectId: string) => Promise<PlatformTaskView[]>;

// GitDriver 的结构子集：poller 只依赖执行面，测试可注入可编程 fake。
export interface PlatformDriver {
  readonly visibilityLagMs: number;
  readonly commentSources: CommentSourceOp[];
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
  now?: () => number;
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

interface InternalEntry extends PlatformPollerEntryInit {
  repoKey: string;
  cursor?: CommentCursorStore;
  status: EntryStatus;
  defaultBranch?: string;
  defaultBranchStale: number;
  // 观察缓存按 (taskId, prNumber) 隔离：同一 PR 号可被先后不同任务收编（自定义分支复用/reopen），
  // 只按 PR 号会让新任务继承旧任务的 merged/push 观察、事件被永久抑制（与 cursor 代际同理）。
  observedPr: Map<string, ObservedPr>;
  deliveredVerdicts: Map<string, string>;
  loggedUndated: Set<string>;
  baseMismatch: Map<number, string>;
  rateLimit?: { until: number; attempt: number };
}

interface CycleFailure {
  message: string;
  errorClass?: string;
}

type BindingCheck = { kind: 'mismatch'; mismatch: string } | { kind: 'unverifiable' };

// 限流后必须停止请求并退避（GitHub 平台要求，持续触发 secondary limit 会招致封禁）：
// 命中即短路该 entry 本周期剩余工作，退避窗口内整周期跳过，成功周期重置。
// abort 携带此前已入列的全部失败：混合周期（如 ACCESS_DENIED → RATE_LIMIT）的真实
// 凭据故障不得被限流短路洗白成 healthy。
class RateLimitAbort extends Error {
  constructor(readonly failure: CycleFailure, readonly failures: CycleFailure[]) {
    super(failure.message);
    this.name = 'RateLimitAbort';
  }
}

// 周期失败已在抛出前记入健康度——typed 标记让 catch 兜底不二次记账（不能用消息前缀嗅探）。
class CycleFailuresError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CycleFailuresError';
  }
}

const RATE_LIMIT_BACKOFF_MIN_MS = 60_000;
const RATE_LIMIT_BACKOFF_MAX_MS = 900_000;
// 与 spec §8 base 快照同一时效纪律：projectView 连续失败 ≥3 周期后缓存默认分支视为缺失。
const DEFAULT_BRANCH_STALE_CYCLES = 3;

export class PlatformPoller {
  private readonly entries: InternalEntry[] = [];
  private readonly engine = new VerdictEngine();
  private periodicRunner?: PeriodicTaskRunner;
  private isPolling = false;
  private intervalMs?: number;
  private readonly now: () => number;

  constructor(private readonly opts: PlatformPollerOptions) {
    this.now = opts.now ?? Date.now;
  }

  add(init: PlatformPollerEntryInit): void {
    this.entries.push({
      ...init,
      repoKey: repoIdentityKey(init.repoUrl),
      status: { isPolling: false, consecutiveFailures: 0 },
      defaultBranchStale: 0,
      observedPr: new Map(),
      deliveredVerdicts: new Map(),
      loggedUndated: new Set(),
      baseMismatch: new Map(),
    });
  }

  remove(projectId: string): boolean {
    const i = this.entries.findIndex(e => e.projectId === projectId);
    if (i === -1) return false;
    this.entries.splice(i, 1);
    return true;
  }

  snapshots(): Array<PollerSnapshot & { lastErrorClass?: string; rateLimitedUntil?: string }> {
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

  stop(): void {
    this.periodicRunner?.stop();
  }

  // 防重入设在唯一公开入口：定时 tick、手动触发与测试直调共用同一互斥，
  // 并发周期会对同一 entry/cursor 双写（重复事件 + 状态文件竞争）。
  async poll(): Promise<void> {
    if (this.isPolling) {
      console.warn('[PlatformPoller] poll skipped: previous cycle still in flight');
      return;
    }
    this.isPolling = true;
    try {
      for (const entry of this.entries) {
        try {
          await this.pollOne(entry);
        } catch (e) {
          console.warn(`[PlatformPoller] entry ${entry.repoKey} failed:`, e instanceof Error ? e.message : e);
        }
      }
    } finally {
      this.isPolling = false;
    }
  }

  private async pollOne(entry: InternalEntry): Promise<void> {
    if (entry.rateLimit !== undefined && this.now() < entry.rateLimit.until) return;
    const startedAt = this.now();
    entry.status.isPolling = true;
    entry.status.lastPollStartedAt = new Date(startedAt).toISOString();
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
      if (e instanceof RateLimitAbort) {
        // 不计凭据健康度（spec §5.3 要点）：退避顺延重试并在状态里如实标注 rate-limited。
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
      const endedAt = this.now();
      entry.status.lastPollEndedAt = new Date(endedAt).toISOString();
      entry.status.lastPollDurationMs = endedAt - startedAt;
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
      const failure: CycleFailure = {
        message: `${context}: ${e instanceof Error ? e.message : String(e)}`,
        errorClass: e instanceof DriverOpError ? e.info.errorClass : undefined,
      };
      failures.push(failure);
      if (failure.errorClass === 'RATE_LIMIT') throw new RateLimitAbort(failure, failures);
    };
    try {
      await entry.cursor!.flushIfDirty();
    } catch (e) {
      fail('cursor flush', e);
    }
    const tasks = await this.opts.tasks(entry.projectId);
    const byId = new Map(tasks.map(t => [t.taskId, t]));

    for (const gen of entry.cursor!.generations()) {
      const t = byId.get(gen);
      if (t === undefined || t.terminal) {
        try {
          await entry.cursor!.dropGeneration(gen);
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
    for (const key of entry.loggedUndated) {
      if (!activePrs.has(Number(key.split(':')[0]))) entry.loggedUndated.delete(key);
    }

    let defaultBranch: string | undefined;
    try {
      const [row] = await entry.driver.runOp('projectView');
      if (row !== undefined && typeof row.defaultBranch === 'string') {
        entry.defaultBranch = row.defaultBranch;
        entry.defaultBranchStale = 0;
        defaultBranch = row.defaultBranch;
      }
    } catch (e) {
      entry.defaultBranchStale += 1;
      fail('projectView', e);
    }
    // 收编快照必须用当周期值（写 durable base）；子轮询绑定校验是纯守卫谓词，可用
    // 有界陈旧的缓存跨过瞬时 projectView 故障，超龄即视为缺失（fail closed 停子轮询）。
    const usableDefault = defaultBranch
      ?? (entry.defaultBranch !== undefined && entry.defaultBranchStale < DEFAULT_BRANCH_STALE_CYCLES
        ? entry.defaultBranch
        : undefined);

    await this.pollListPrs(entry, tasks, byId, defaultBranch, fail, failures);

    for (const task of tasks) {
      if (task.terminal || task.prNumber === undefined) continue;
      // closed-unmerged 锚在场即停子轮询：恢复只经主轮询 reopen 事件 → handler durable
      // 解锚 → 下一周期任务视图锚已清（spec §6 reopen 显式 durable 观察协议）。
      if (task.closedUnmergedAnchor === true) continue;
      await this.subPoll(entry, task, usableDefault, fail);
    }
    return failures;
  }

  // PR 收编后仍可被 retarget/改写：生命周期与裁决事件产出前对 fresh prView 复核绑定三元
  // （branch/fork/target，spec §7 fresh prView 完整谓词核验），失配转 intervention 并停子轮询。
  // 期望值缺失即无法核验：预设「无法核验 = 匹配」会给 retarget 后的 PR 继续发 push/merged/裁决
  // ——task.branch 缺失按失配交人工（任务视图结构异常），base 期望双缺失按不可核验静默停
  // （projectView 故障已在健康度，恢复即自愈）。
  private bindingCheck(
    task: PlatformTaskView,
    prRow: NormalizedRow,
    defaultBranch: string | undefined,
  ): BindingCheck | undefined {
    if (task.branch === undefined || String(prRow.branch) !== task.branch) {
      return { kind: 'mismatch', mismatch: 'branch' };
    }
    if (prRow.sourceProjectId === null || prRow.sourceProjectId === undefined
      || prRow.sourceProjectId !== prRow.targetProjectId) {
      return { kind: 'mismatch', mismatch: 'fork' };
    }
    const expected = task.expectedBase ?? defaultBranch;
    if (expected === undefined) return { kind: 'unverifiable' };
    if (String(prRow.targetBranch) !== expected) return { kind: 'mismatch', mismatch: 'target' };
    return undefined;
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
        // 停止条件 = 观察到严格早于水位的行：desc 序下这证明 ≥ 水位的行（含水位同秒整桶）
        // 已全部翻过；「整页都是已知水位行」证明不了同秒桶已扫完——同秒无稳定次序，
        // 第二页可能还有同秒新 PR（spec v1 §6 停止条件）。
        return pageRows.some(r => {
          const vt = versionTimeOf(r);
          return vt !== undefined && vt < prsCursor.watermarkTime!;
        });
      });
    } catch (e) {
      fail('listPrs', e);
      return;
    }

    const boundByPr = new Map<number, PlatformTaskView>();
    for (const t of tasks) {
      if (!t.terminal && t.prNumber !== undefined) boundByPr.set(t.prNumber, t);
    }
    const failuresBefore = failures.length;
    let deferredAdoptions = 0;
    const seenPrs = new Set<number>();
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
        // reopen 是显式 durable 观察：closed-unmerged 锚在 TaskState，主轮询见重开即合成（spec §6）。
        if (boundTask.closedUnmergedAnchor === true && row.state === 'open') {
          try {
            await this.emit(entry, 'pr.updated', { ...base, kind: 'reopened' });
            entry.observedPr.delete(`${boundTask.taskId}:${prNumber}`);
          } catch (e) {
            fail(`reopen pr#${prNumber}`, e);
          }
        }
        continue;
      }
      if (row.state !== 'open' || row.draft === true) continue;
      if (!base.branch.startsWith(BRANCH_PREFIX)) continue;
      const task = byId.get(base.branch.slice(BRANCH_PREFIX.length));
      if (task === undefined || task.terminal || task.prNumber !== undefined) continue;
      // 统一谓词 branch === task.branch：branch 缺失的任务视图无从核验绑定，收编一并 fail closed
      // （与子轮询 bindingCheck 对称——「无法核验」不是「匹配」）。
      if (task.branch !== base.branch) continue;
      if (row.sourceProjectId === null || row.sourceProjectId === undefined
        || row.sourceProjectId !== row.targetProjectId) continue;
      const target = String(row.targetBranch);
      try {
        if (task.expectedBase !== undefined) {
          if (target !== task.expectedBase) continue;
        } else {
          if (defaultBranch === undefined) {
            // 收编推迟必须同时冻结水位：否则该 PR 被水位判「已处理」，projectView 恢复后
            // 它已落在停止页之外、永不再被扫描。
            deferredAdoptions += 1;
            continue;
          }
          if (target !== defaultBranch) {
            // 无快照档的失配交人工：PR 已存在、同 head 重试 create 必失败，静默拒收会永久卡死（spec §6）。
            // 条件未变时跨周期去重（成功投递才记指纹，emit 失败下轮重试）；恢复/收编成功即清。
            const fp = [task.taskId, target, defaultBranch].join('\0');
            if (entry.baseMismatch.get(prNumber) !== fp) {
              await this.emit(entry, 'human.intervention', {
                ...base, reason: 'base-mismatch', targetBranch: target, expectedBase: defaultBranch, taskId: task.taskId,
              });
              entry.baseMismatch.set(prNumber, fp);
            }
            continue;
          }
        }
        await this.emit(entry, 'pr.created', { ...base, headSha: String(row.headSha), targetBranch: target });
        entry.baseMismatch.delete(prNumber);
      } catch (e) {
        fail(`adopt pr#${prNumber}`, e);
      }
    }
    for (const pr of entry.baseMismatch.keys()) {
      if (!seenPrs.has(pr)) entry.baseMismatch.delete(pr);
    }

    if (failures.length > failuresBefore || deferredAdoptions > 0) return;
    try {
      await entry.cursor!.commitListPrs(prRows, scanStartedAt - entry.driver.visibilityLagMs);
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
          });
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
            await this.emit(entry, 'pr.merged', base);
            observed.merged = true;
          } catch (e) {
            fail(`merged pr#${prNumber}`, e);
          }
        }
      } else if (observed.closedUnmerged !== true) {
        try {
          await this.emit(entry, 'pr.updated', { ...base, kind: 'closed-unmerged' });
          observed.closedUnmerged = true;
        } catch (e) {
          fail(`closed pr#${prNumber}`, e);
        }
      }
      // 未合并关闭停子轮询，reopen 经主轮询恢复（spec §6）。
      return;
    }

    observed.closedUnmerged = false;
    const headSha = String(prRow.headSha);
    if (task.latestHeadSha !== undefined && headSha !== task.latestHeadSha.toLowerCase() && observed.pushSha !== headSha) {
      try {
        await this.emit(entry, 'pr.updated', { ...base, kind: 'push', headSha });
        observed.pushSha = headSha;
      } catch (e) {
        fail(`push pr#${prNumber}`, e);
      }
    }

    const scans = await this.scanCommentSources(entry, task, base, fail);

    const anchorSha = task.anchorSha?.toLowerCase();
    // 裁决资格门：head 偏离锚点只能走 push/recheck，旧锚令牌不得批准新 head；signalToken
    // 缺失**或空白**的事件会绕过既有 handler 的令牌比对（guard 是 truthy 双与，两个空值照样
    // 通过）——缺任一资格即清候选，跨不可裁决状态存活的候选会把恢复后首个扫描当成第二个
    // 确认周期（spec §6 verdict ③）。
    const verdictEligible = prRow.draft === false
      && task.passToken !== undefined && task.failToken !== undefined
      && anchorSha !== undefined
      && task.signalToken !== undefined && task.signalToken.trim() !== ''
      && headSha === anchorSha;
    if (!verdictEligible) {
      this.engine.dropCandidate(task.taskId, prNumber);
      return;
    }
    // 源扫描失败的完整性门由 engine 单点持有（spec §6 verdict ①，含候选保留语义），此处不复检。
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
      // 评论源扫描最长可达分钟级，扫描期间 head/状态可被平台改写（TOCTOU）：emit 前以
      // 权威 prView 复核 open/!draft/绑定/锚点，失配清候选走 push/recheck，查询失败按瞬态重试。
      const [freshRow] = await entry.driver.runOp('prView', { prNumber });
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
        action: decision.kind === 'pass' ? 'APPROVE' : 'REQUEST_CHANGES',
        headSha: decision.anchorSha,
        currentHeadSha: String(freshRow.headSha),
        submittedAt: decision.submittedAt,
        reviewPassToken: task.signalToken,
        verdictConflict: decision.conflict,
        verdictCarrier: decision.carrier,
      });
      entry.deliveredVerdicts.set(obsKey, fp);
    } catch (e) {
      fail(`verdict pr#${prNumber}`, e);
    }
  }

  private async scanCommentSources(
    entry: InternalEntry,
    task: PlatformTaskView,
    base: { prNumber: number; prUrl: string; branch: string },
    fail: (context: string, e: unknown) => void,
  ): Promise<VerdictSourceScan[]> {
    const scans: VerdictSourceScan[] = [];
    for (const source of entry.driver.commentSources) {
      const sourceClass = classifyCommentSource(source);
      const scanStartedAt = this.now();
      let rows: NormalizedRow[];
      try {
        rows = await entry.driver.runCommentSource(source, { prNumber: base.prNumber }, pageRows => {
          for (const row of pageRows) projectCommentRow(row);
          return pageRows;
        });
      } catch (e) {
        fail(`listComments[${source.key}] pr#${base.prNumber}`, e);
        scans.push({ key: source.key, sourceClass, ok: false, scanStartedAt, rows: [] });
        continue;
      }
      // system note（GitLab push/label/state 类）不入裁决/ack/反馈任何通道（spec §6 过滤矩阵）；
      // github 三源恒无该字段。fake driver 可能不走投影钩子，过滤统一收在此处。
      scans.push({ key: source.key, sourceClass, ok: true, scanStartedAt, rows: rows.filter(r => r.system !== true) });
    }

    // ack 完成集跨源计算一次：issue 类顶层 ack 可指向任意源的 revision，threaded 隶属
    // 也要全源行集解析；已 ack 的 revision 即 dev 已处置——cursor 重置/源删重加后再变 fresh
    // 也不得重发反馈事件（ack 是 durable 处置证据，ledger 只是投递优化）。
    const ackRows: AckCarrierRow[] = scans.flatMap(scan => scan.rows.map(row => ({
      sourceKey: scan.key,
      sourceClass: scan.sourceClass,
      id: String(row.id),
      authorId: typeof row.authorId === 'string' ? row.authorId : undefined,
      discussionId: row.discussionId === null || row.discussionId === undefined ? null : String(row.discussionId),
      acks: rowAcks(row),
      carriesToken: rowTokens(row).length > 0,
    })));
    const ackCollection = collectValidAcks(ackRows, {
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
        if (!rowHasBody(row)) continue;
        // 携任何 verdict 令牌行走裁决通道；有效 ack 载体行是 dev 回复——两类都不合成反馈事件（spec §6 矩阵）。
        if (rowTokens(row).length > 0) continue;
        const id = String(row.id);
        if (ackCollection.carrierRowKeys.has(ackCarrierKey(scan.key, id))) continue;
        const digest = rowBodyDigest(row);
        if (ackCollection.acks.has(ackRevisionKey(scan.key, id, digest))) continue;
        if (entry.cursor!.isDelivered(view, id, digest)) continue;
        try {
          await this.emit(entry, 'pr.updated', {
            ...base,
            kind: scan.sourceClass === 'threaded' ? 'review-comment' : 'comment',
            commentId: row.id,
            revision: { sourceKey: scan.key, id, bodyDigest: digest },
            ...(scan.sourceClass === 'threaded' && row.discussionId !== null && row.discussionId !== undefined
              ? { reviewCommentReply: true }
              : {}),
          });
          await entry.cursor!.markDelivered(task.taskId, base.prNumber, scan.key, id, digest);
        } catch (e) {
          delivered = false;
          fail(`comment ${scan.key}#${id} pr#${base.prNumber}`, e);
        }
      }
      if (delivered) {
        try {
          await entry.cursor!.commitSource(task.taskId, base.prNumber, scan.key, scan.rows, cutoff);
        } catch (e) {
          fail(`listComments[${scan.key}] cursor commit pr#${base.prNumber}`, e);
        }
      }
    }
    return scans;
  }

  private async emit(entry: InternalEntry, type: MappedEvent['type'], data: Record<string, unknown>): Promise<void> {
    await this.opts.onEvent(entry.projectId, { type, repo: entry.repoKey, data });
  }
}
