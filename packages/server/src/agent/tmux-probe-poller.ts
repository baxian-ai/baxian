import { createHash } from 'node:crypto';
import type {
  AgentConfig,
  AgentErrorSummary,
  AgentRuntimeStatus,
  BaxianConfig,
  TmuxSessionStatus,
} from '../shared/index.js';
import type { AgentManager } from './manager.js';
import type { CommandRunner } from './runner.js';
import { createRunner, hostGroupKey, resolveAgentHost } from './runner.js';
import { TmuxManager, type AdoptPaneState, type AgentRuntimeKind } from './tmux.js';
import type { DetectedState } from './detect/manifest.js';
import { classifyScreen } from './detect/classify.js';
import { WorkingToIdleDebounce } from './detect/debounce.js';
import { PeriodicTaskRunner } from '../timing/periodic-task-runner.js';
import type { AgentStore } from '../state/agent-store.js';
import type { ErrorRecordStore } from '../state/error-record-store.js';

export interface TmuxSessionObservation {
  tmuxSessionStatus: TmuxSessionStatus;
  observedAt?: string;
  stateChangedAt?: string;
  lastPresentAt?: string;
  error?: string;
  latestError?: AgentErrorSummary;
  runtimeStatusHint?: AgentRuntimeStatus;
  reason?: string;
  message?: string;
  paneState?: AdoptPaneState['kind'];
}

export type TmuxSessionStatusStoreChangeKind = 'set' | 'delete';
export type TmuxSessionStatusStoreListener = (
  kind: TmuxSessionStatusStoreChangeKind,
  agentId: string,
) => void;

export class TmuxSessionStatusStore {
  private entries = new Map<string, TmuxSessionObservation>();
  private listeners = new Set<TmuxSessionStatusStoreListener>();

  onChange(fn: TmuxSessionStatusStoreListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get(agentId: string): TmuxSessionObservation {
    return this.entries.get(agentId) ?? { tmuxSessionStatus: 'unknown' };
  }

  set(agentId: string, entry: TmuxSessionObservation): void {
    const prev = this.entries.get(agentId);
    const changed = !prev
      || prev.tmuxSessionStatus !== entry.tmuxSessionStatus
      || prev.error !== entry.error
      || prev.runtimeStatusHint !== entry.runtimeStatusHint
      || prev.reason !== entry.reason
      || prev.message !== entry.message
      || prev.paneState !== entry.paneState
      || prev.latestError?.id !== entry.latestError?.id;
    const stateChangedAt = changed
      ? (entry.observedAt ?? new Date().toISOString())
      : (prev.stateChangedAt ?? prev.observedAt ?? entry.observedAt);
    this.entries.set(agentId, {
      ...entry,
      ...(stateChangedAt !== undefined ? { stateChangedAt } : {}),
    });
    if (!changed) return;
    this.fire('set', agentId);
  }

  keys(): IterableIterator<string> {
    return this.entries.keys();
  }

  delete(agentId: string): void {
    if (!this.entries.has(agentId)) return;
    this.entries.delete(agentId);
    this.fire('delete', agentId);
  }

  private fire(kind: TmuxSessionStatusStoreChangeKind, agentId: string): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(kind, agentId);
      } catch (err) {
        console.error(`[TmuxSessionStatusStore] listener threw on ${kind} ${agentId}:`, err);
      }
    }
  }
}

export interface TmuxProbePollerOptions {
  config: BaxianConfig;
  store: TmuxSessionStatusStore;
  agentManager: AgentManager;
  agentStore?: AgentStore;
  errorRecordStore?: ErrorRecordStore;
  runnerFactory?: (agent: AgentConfig) => CommandRunner;
  intervalMs?: number;
  probeTimeoutMs?: number;
  concurrency?: number;
  failureThreshold?: number;
  now?: () => number;
}

const DEFAULT_FAILURE_THRESHOLD = 2;
const PENDING_IDLE_AFTER_MS = 5 * 60 * 1000;
// 探测间隔可低至 1s,只按次数计会把 runtime 冷启动/远程慢 shell 的正常窗口记成退出:还要求 shell 持续满这段时间
const RUNTIME_EXIT_GRACE_MS = 20 * 1000;

export class TmuxProbePoller {
  private readonly periodicRunner: PeriodicTaskRunner;
  private failureCounts = new Map<string, number>();
  private config: BaxianConfig;
  private store: TmuxSessionStatusStore;
  private agentManager: AgentManager;
  private agentStore?: AgentStore;
  private errorRecordStore?: ErrorRecordStore;
  private runnerFactory?: (agent: AgentConfig) => CommandRunner;
  private pollIntervalMs: number;
  private probeTimeoutMs: number;
  private concurrency: number;
  private failureThreshold: number;
  private lastRecordedIssue = new Map<string, { key: string; summary?: AgentErrorSummary }>();
  private shellSightings = new Map<string, { count: number; since: number }>();
  private paneProbeFailures = new Map<string, number>();
  private lastScreen = new Map<string, { hash: string; changedAt: number; taskId: string | null; idle: boolean; width: number }>();
  private instances = new Map<string, ProbeInstance>();
  private generations = 0;
  private inFlight = new Map<string, Promise<void>>();
  private debouncers = new Map<string, WorkingToIdleDebounce>();
  private lastPublishedState = new Map<string, DetectedState>();
  private now: () => number;

  constructor(options: TmuxProbePollerOptions) {
    this.config = options.config;
    this.store = options.store;
    this.agentManager = options.agentManager;
    this.agentStore = options.agentStore;
    this.errorRecordStore = options.errorRecordStore;
    this.runnerFactory = options.runnerFactory;
    this.now = options.now ?? Date.now;
    this.pollIntervalMs = options.intervalMs ?? options.config.server.tmuxProbePollIntervalMs;
    this.probeTimeoutMs = options.probeTimeoutMs ?? options.config.server.tmuxProbeTimeoutMs;
    this.concurrency = options.concurrency ?? options.config.server.tmuxProbeConcurrency;
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.instances = this.indexInstances(options.config);
    this.periodicRunner = new PeriodicTaskRunner({
      name: 'tmux-probe-poller',
      intervalMs: this.pollIntervalMs,
      run: () => this.probeConfiguredAgents(),
      onError: err => console.error('[tmux-probe] poll failed:', err),
    });
  }

  replaceConfig(validated: BaxianConfig): void {
    this.config = validated;
    const previous = this.instances;
    this.instances = this.indexInstances(validated);
    for (const [id, instance] of this.instances) {
      const before = previous.get(id);
      // 换代即另一个实例:失败计数、连击、去重键、检测基线与旧观测都不得跨代延续
      if (before && before.generation !== instance.generation) this.purgeAgent(id);
      // 连续失败计数属于连接:凭据或端点换了从零数起,旧连接的失败不给新连接垫底;pane 侧状态照旧保留
      else if (before && before.connection !== instance.connection) this.failureCounts.delete(id);
    }
    const allKnownIds = new Set([
      ...this.failureCounts.keys(),
      ...this.paneProbeFailures.keys(),
      ...this.lastRecordedIssue.keys(),
      ...this.lastScreen.keys(),
      ...this.store.keys(),
    ]);
    for (const id of allKnownIds) {
      if (!this.instances.has(id)) this.purgeAgent(id);
    }
    this.probeTimeoutMs = validated.server.tmuxProbeTimeoutMs;
    this.concurrency = validated.server.tmuxProbeConcurrency;
    const nextIntervalMs = validated.server.tmuxProbePollIntervalMs;
    if (nextIntervalMs !== this.pollIntervalMs) {
      this.pollIntervalMs = nextIntervalMs;
      this.periodicRunner.reschedule(nextIntervalMs);
    }
  }

  // purge 也让在途探测作废:已拿到 absent、正卡在 reconcile 等锁的旧探测不能再对重建后的 agent 生效,换代是它们唯一认的栅栏
  purgeAgent(id: string): void {
    const instance = this.instances.get(id);
    if (instance) this.instances.set(id, { ...instance, generation: ++this.generations });
    this.failureCounts.delete(id);
    this.resetPaneIssueState(id);
    this.store.delete(id);
  }

  private resetPaneIssueState(id: string): void {
    this.lastRecordedIssue.delete(id);
    this.shellSightings.delete(id);
    this.paneProbeFailures.delete(id);
    this.resetDetectionBaseline(id);
  }

  private resetDetectionBaseline(id: string): void {
    this.lastScreen.delete(id);
    this.debouncers.delete(id);
    this.lastPublishedState.delete(id);
  }

  // 热重载会重建整棵配置对象树,实例身份只能按内容认:同 ID 且被探测的 pane 与解读方式没变才是同一代
  private indexInstances(config: BaxianConfig): Map<string, ProbeInstance> {
    const next = new Map<string, ProbeInstance>();
    for (const [id, agent] of buildInstanceIndex(config)) {
      const signature = probeSignature(config, agent);
      const previous = this.instances.get(id);
      const generation = previous?.signature === signature ? previous.generation : ++this.generations;
      next.set(id, { agent, signature, connection: connectionSignature(config, agent), generation });
    }
    return next;
  }

  // 换代/换连接只发生在 await 期间:每个 await 之后先 fencing 再碰按实例累计的状态;过期探测直接放弃,不清当前代的状态
  private isCurrentInstance({ agent, generation, connection }: ProbeInstance): boolean {
    const current = this.instances.get(agent.id);
    return current?.generation === generation && current.connection === connection;
  }

  private detectViaManifest(
    agentId: string,
    runtime: AgentRuntimeKind,
    runtimeScreen: string,
    oscTitle: string,
  ): { published: DetectedState; visibleWorking: boolean } | 'skip' {
    const detection = classifyScreen(runtime, runtimeScreen, oscTitle);

    if (detection.skipStateUpdate) return 'skip';

    let debouncer = this.debouncers.get(agentId);
    if (!debouncer) {
      debouncer = new WorkingToIdleDebounce();
      this.debouncers.set(agentId, debouncer);
    }
    const previousPublished = this.lastPublishedState.get(agentId) ?? 'unknown';
    const published = debouncer.apply(detection.state, previousPublished, detection.visibleIdle);
    this.lastPublishedState.set(agentId, published);

    return { published, visibleWorking: detection.visibleWorking };
  }

  start(): void {
    this.periodicRunner.start({ runImmediately: true });
  }

  stop(): void {
    this.periodicRunner.stop();
  }

  async pollOnce(): Promise<void> {
    await this.periodicRunner.runOnce();
  }

  // 维护路径(restart-repl / retry)刚亲眼确认 REPL 就绪:作废旧结论后先按这一事实落 present,再立即重看;重看瞬时失败(未到阈值不落库)时留下的是已确认的 present 而不是 unknown
  async confirmReplReady(agentId: string): Promise<void> {
    this.purgeAgent(agentId);
    if (!this.instances.has(agentId)) return;
    const now = new Date().toISOString();
    this.store.set(agentId, { tmuxSessionStatus: 'present', observedAt: now, lastPresentAt: now, paneState: 'live-runtime' });
    await this.probeAgent(agentId);
  }

  async probeAgent(agentId: string): Promise<void> {
    if (this.instances.has(agentId)) await this.probe(agentId);
  }

  private async probeConfiguredAgents(): Promise<void> {
    const ids = [...this.instances.keys()];
    await runWithConcurrency(ids, Math.max(1, this.concurrency), id => this.probe(id));
  }

  // 同一 agent 的探测串行:即时探测排在进行中的定时探测之后,最后落库的一定是最新的观测
  // 排队的是 agent id 而不是实例:轮到执行才取当前实例,排队期间热重载换掉的 host 引用不会拿去查新配置树
  private probe(id: string): Promise<void> {
    const run = (this.inFlight.get(id) ?? Promise.resolve()).then(() => {
      const instance = this.instances.get(id);
      return instance ? this.probeInstance(instance) : undefined;
    });
    const settled = run.catch(() => undefined);
    this.inFlight.set(id, settled);
    void settled.then(() => {
      if (this.inFlight.get(id) === settled) this.inFlight.delete(id);
    });
    return run;
  }

  private async probeInstance(instance: ProbeInstance): Promise<void> {
    const { agent } = instance;
    let tmux: TmuxManager | undefined;
    let result: { tmuxSessionStatus: TmuxSessionStatus; error?: string };
    try {
      const runner = this.runnerFactory
        ? this.runnerFactory(agent)
        : createRunner(agent.mode, resolveAgentHost(this.config.host, agent.host));
      tmux = new TmuxManager(runner);
      result = await this.runProbe(agent, tmux);
    } catch (err) {
      result = {
        tmuxSessionStatus: 'unreachable',
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (!this.isCurrentInstance(instance)) return;
    // 只有确实看到 pane 的探测才能延续 shell 候选连击;已发布的 RUNTIME_EXITED 不因一次瞬时探测失败而"假恢复"
    if (result.tmuxSessionStatus !== 'present') this.breakUnconfirmedShellStreak(agent.id);
    const now = new Date().toISOString();
    const previousEntry = this.store.get(agent.id);
    const previous = previousEntry.tmuxSessionStatus;

    if (result.tmuxSessionStatus === 'unreachable') {
      const failures = (this.failureCounts.get(agent.id) ?? 0) + 1;
      if (failures < this.failureThreshold) {
        this.failureCounts.set(agent.id, failures);
        return;
      }
      const latestError = await this.recordProbeError(agent, now, result.error);
      // 计数、pane 结论作废与发布都落在落盘之后的 fence 后面:落盘期间连接换了,这次旧凭据失败对新连接什么都不留
      if (!this.isCurrentInstance(instance)) return;
      this.failureCounts.set(agent.id, failures);
      // 发布 unreachable 即失去对 pane 的确认:pane 级结论、连击与去重键一并作废,恢复后重新确认并落新记录
      this.resetPaneIssueState(agent.id);
      this.store.set(agent.id, {
        tmuxSessionStatus: 'unreachable',
        observedAt: now,
        ...(previousEntry.lastPresentAt ? { lastPresentAt: previousEntry.lastPresentAt } : {}),
        error: result.error,
        ...(latestError ? { latestError } : {}),
      });
      this.logTransition(agent.id, previous, 'unreachable', result.error);
      return;
    }

    this.failureCounts.delete(agent.id);
    const presentProbe = result.tmuxSessionStatus === 'present' && tmux
      ? await this.observePresentSession(instance, tmux, now)
      : {};
    if (presentProbe === 'stale' || !this.isCurrentInstance(instance)) return;
    const effectiveStatus: TmuxSessionStatus =
      result.tmuxSessionStatus === 'present' && presentProbe === undefined
        ? 'absent'
        : result.tmuxSessionStatus;
    const presentDetails = presentProbe === undefined ? {} : presentProbe;

    if (effectiveStatus !== 'present') this.resetPaneIssueState(agent.id);
    this.store.set(agent.id, {
      tmuxSessionStatus: effectiveStatus,
      observedAt: now,
      ...(effectiveStatus === 'present' ? { lastPresentAt: now } : {}),
      ...presentDetails,
    });
    this.logTransition(agent.id, previous, effectiveStatus);

    if (effectiveStatus === 'absent') {
      try {
        await this.agentManager.reconcileFailedAgent(agent.id, { stillCurrent: () => this.isCurrentInstance(instance) });
      } catch (err) {
        console.error(`[tmux-probe] reconcileFailedAgent ${agent.id} threw:`, err);
      }
    }
  }

  private async observePresentSession(
    instance: ProbeInstance,
    tmux: TmuxManager,
    occurredAt: string,
  ): Promise<Partial<TmuxSessionObservation> | undefined | 'stale'> {
    const { agent } = instance;
    let paneState: AdoptPaneState | undefined;
    try {
      const snapshot = await tmux.getSessionSnapshot(agent.id, { timeout: this.probeTimeoutMs });
      if (!snapshot || snapshot.claim !== agent.id) return undefined;
      const pane = await tmux.getSinglePaneByRef(snapshot.ref, agent.id, { timeout: this.probeTimeoutMs });
      paneState = await tmux.classifyPaneForAdopt(pane, agent.runtime, { timeout: this.probeTimeoutMs });
      if (!this.isCurrentInstance(instance)) return 'stale';
      this.paneProbeFailures.delete(agent.id);
      const runtimeExited = this.trackShellSightings(agent.id, paneState);
      const liveRuntime = paneState.kind === 'live-runtime';
      const [runtimeScreen, currentTaskId, oscTitle, paneWidth] = liveRuntime
        ? await Promise.all([
            tmux.capturePaneById(pane, {
              ansi: false,
              scrollback: 0,
              timeoutMs: this.probeTimeoutMs,
              runtime: agent.runtime,
            }),
            this.agentStore
              ? this.agentStore.get(agent.id).then((binding) => binding?.taskId ?? null)
              : Promise.resolve(null),
            tmux.readPaneTitle(pane, { timeout: this.probeTimeoutMs }).catch(() => ''),
            tmux.displayMessage(pane, '#{pane_width}', { timeout: this.probeTimeoutMs })
              .then((raw) => parseInt(raw, 10) || 0)
              .catch(() => 0),
          ])
        : ['', null, '', 0] as const;
      if (!this.isCurrentInstance(instance)) return 'stale';
      const manifestResult = liveRuntime
        ? this.detectViaManifest(agent.id, agent.runtime, runtimeScreen, oscTitle)
        : undefined;
      // 去抖后的发布态才是状态源:herdr 的 weak_blocker/legacy blocker 是 pending 但不带 visible 证据
      const detected = manifestResult === 'skip' ? undefined : manifestResult;

      if (liveRuntime) {
        const hash = createHash('sha1').update(runtimeScreen).update(oscTitle).digest('hex');
        const idleNow = detected?.published === 'idle';
        const prev = this.lastScreen.get(agent.id);
        if (!prev || prev.taskId !== currentTaskId) {
          this.lastScreen.set(agent.id, { hash, changedAt: this.now(), taskId: currentTaskId, idle: idleNow, width: paneWidth });
        } else if (prev.hash !== hash) {
          const cosmeticIdleReflow = idleNow && prev.idle && prev.width > 0 && paneWidth > 0 && prev.width !== paneWidth;
          this.lastScreen.set(agent.id, { hash, changedAt: cosmeticIdleReflow ? prev.changedAt : this.now(), taskId: currentTaskId, idle: idleNow, width: paneWidth });
        } else if (prev.width !== paneWidth || prev.idle !== idleNow) {
          this.lastScreen.set(agent.id, { ...prev, width: paneWidth, idle: idleNow });
        }
      } else {
        this.resetDetectionBaseline(agent.id);
      }

      if (manifestResult === 'skip') {
        // skip 只说明屏幕不可读,能继承的只有同样来自 live-runtime 的上一轮观察;RUNTIME_EXITED 这类 pane 级结论已被 live-runtime 推翻
        const last = this.store.get(agent.id);
        const inherit = last.paneState === 'live-runtime';
        // 不继承即视为该问题已解除:去重键一并清掉,否则下一次同类问题会命中旧键而不再落 error record
        if (!inherit) this.lastRecordedIssue.delete(agent.id);
        return {
          ...(inherit ? paneConclusionOf(last) : {}),
          paneState: paneState.kind,
        };
      }

      const pending = detected?.published === 'pending';
      const busy = detected?.published === 'working';
      const screenStatic = !pending && this.screenStaticForGrace(agent.id, paneState);
      const stuckBusy = busy && screenStatic && (detected?.visibleWorking ?? false);
      const pendingIdle = !busy && screenStatic;
      const issue = this.issueForPaneState(paneState, pending, pendingIdle, stuckBusy, runtimeExited);
      if (!issue) {
        this.lastRecordedIssue.delete(agent.id);
        return {
          paneState: paneState.kind,
          ...(busy ? { runtimeStatusHint: 'working' as const } : {}),
        };
      }
      const latestError = await this.recordRuntimeIssue(agent, occurredAt, issue);
      return {
        paneState: paneState.kind,
        runtimeStatusHint: issue.runtimeStatusHint,
        reason: issue.reason,
        message: issue.message,
        ...(latestError ? { latestError } : {}),
      };
    } catch (err) {
      if (!this.isCurrentInstance(instance)) return 'stale';
      const failures = (this.paneProbeFailures.get(agent.id) ?? 0) + 1;
      this.paneProbeFailures.set(agent.id, failures);
      const last = this.store.get(agent.id);
      // 一次看不到 pane 推翻不了已确认的 RUNTIME_EXITED(与 unreachable 同一阈值);但前台已确认不是 shell 就是直接反证,不延续
      const foregroundStillShell = paneState === undefined || paneState.kind === 'shell';
      if (foregroundStillShell && last.reason === 'RUNTIME_EXITED' && failures < this.failureThreshold) {
        console.warn(`[tmux-probe] ${agent.id} pane probe failed (${failures}/${this.failureThreshold}); keeping RUNTIME_EXITED:`, err);
        return paneConclusionOf(last);
      }
      this.resetDetectionBaseline(agent.id);
      this.shellSightings.delete(agent.id);
      const message = err instanceof Error ? err.message : String(err);
      const issue = {
        runtimeStatusHint: 'error' as const,
        reason: 'PANE_PROBE_FAILED',
        message,
      };
      const latestError = await this.recordRuntimeIssue(agent, occurredAt, issue);
      return {
        runtimeStatusHint: 'error',
        reason: issue.reason,
        message,
        ...(latestError ? { latestError } : {}),
      };
    }
  }

  private screenStaticForGrace(agentId: string, paneState: AdoptPaneState): boolean {
    if (paneState.kind !== 'live-runtime') return false;
    const entry = this.lastScreen.get(agentId);
    if (!entry || !entry.taskId) return false;
    return this.now() - entry.changedAt > PENDING_IDLE_AFTER_MS;
  }

  // 启动与 Restart REPL 都会让 pane 短暂停在 shell:连续多次且持续够久才算 runtime 真的退出
  private trackShellSightings(agentId: string, paneState: AdoptPaneState): boolean {
    if (paneState.kind !== 'shell') {
      this.shellSightings.delete(agentId);
      return false;
    }
    const now = this.now();
    const streak = this.shellSightings.get(agentId) ?? { count: 0, since: now };
    streak.count += 1;
    this.shellSightings.set(agentId, streak);
    return streak.count >= this.failureThreshold && now - streak.since >= RUNTIME_EXIT_GRACE_MS;
  }

  private breakUnconfirmedShellStreak(agentId: string): void {
    if (this.store.get(agentId).reason !== 'RUNTIME_EXITED') this.shellSightings.delete(agentId);
  }

  private issueForPaneState(
    paneState: AdoptPaneState,
    pendingRuntimeMenu: boolean,
    pendingIdle: boolean,
    stuckBusy: boolean,
    runtimeExited: boolean,
  ): { runtimeStatusHint: AgentRuntimeStatus; reason: string; message: string; recommendation?: string } | undefined {
    if (runtimeExited) {
      return {
        runtimeStatusHint: 'error',
        reason: 'RUNTIME_EXITED',
        message: 'Agent runtime is no longer running — the pane sits at a shell prompt, so prompts sent to it would land in the shell.',
        recommendation: 'Use Restart REPL on the agent card to relaunch the runtime, then inspect why it exited.',
      };
    }
    if (pendingRuntimeMenu) {
      return {
        runtimeStatusHint: 'pending',
        reason: 'PENDING_HUMAN',
        message: 'Agent runtime is waiting on an interactive menu.',
      };
    }
    if (stuckBusy) {
      return {
        runtimeStatusHint: 'error',
        reason: 'STUCK_BUSY',
        message: 'Agent runtime shows a busy indicator but the pane has not changed for over 5 minutes — the runtime is likely stuck. Inspect or interrupt via the web terminal.',
      };
    }
    if (pendingIdle) {
      return {
        runtimeStatusHint: 'pending',
        reason: 'PENDING_IDLE',
        message: 'Agent runtime has been idle while a task is active — likely waiting on user input.',
      };
    }
    if (paneState.kind === 'startup-dialog' || paneState.kind === 'trust-dialog') {
      return {
        runtimeStatusHint: 'pending',
        reason: 'PENDING_HUMAN',
        message: 'Agent runtime is waiting on a startup dialog.',
      };
    }
    if (paneState.kind === 'other') {
      return {
        runtimeStatusHint: 'error',
        reason: 'UNSUPPORTED_FOREGROUND_PROCESS',
        message: `Pane foreground "${paneState.paneCurrentCommand}" is not a supported runtime or shell.`,
      };
    }
    return undefined;
  }

  private async recordRuntimeIssue(
    agent: AgentConfig,
    occurredAt: string,
    issue: { reason: string; message: string; runtimeStatusHint: AgentRuntimeStatus; recommendation?: string },
  ): Promise<AgentErrorSummary | undefined> {
    if (!this.errorRecordStore) return undefined;
    const key = `${issue.reason}:${issue.message}`;
    const recorded = this.lastRecordedIssue.get(agent.id);
    // 去重命中要返回这个键自己的记录:store 里的 latestError 可能已被中途发布的 unreachable 记录顶掉
    if (recorded?.key === key) return recorded.summary;
    const entry: { key: string; summary?: AgentErrorSummary } = { key };
    this.lastRecordedIssue.set(agent.id, entry);
    const projectId = projectIdForAgent(this.config, agent.id) ?? '';
    try {
      const record = await this.errorRecordStore.append({
        agentId: agent.id,
        projectId,
        operation: 'tmux-probe',
        reason: issue.reason,
        message: issue.message,
        occurredAt,
        observation: {
          tmuxSessionStatus: 'present',
          runtimeStatusHint: issue.runtimeStatusHint,
        },
        recommendation: issue.recommendation ?? (issue.runtimeStatusHint === 'pending'
          ? 'Open the web terminal and complete the pending prompt.'
          : 'Inspect the pane before assigning more work to this agent.'),
      });
      entry.summary = this.errorRecordStore.toSummary(record);
      return entry.summary;
    } catch (err) {
      console.warn(`[tmux-probe] record runtime issue for ${agent.id} failed:`, err);
      return undefined;
    }
  }

  private async recordProbeError(
    agent: AgentConfig,
    occurredAt: string,
    message: string | undefined,
  ): Promise<AgentErrorSummary | undefined> {
    if (!this.errorRecordStore) return undefined;
    const projectId = projectIdForAgent(this.config, agent.id) ?? '';
    const record = await this.errorRecordStore.append({
      agentId: agent.id,
      projectId,
      operation: 'tmux-probe',
      reason: 'TMUX_UNREACHABLE',
      message: message ?? 'tmux probe failed',
      occurredAt,
      observation: { tmuxSessionStatus: 'unreachable' },
      recommendation: 'Check host connectivity and tmux availability, then retry the agent.',
    });
    return this.errorRecordStore.toSummary(record);
  }

  private logTransition(
    agentId: string,
    from: TmuxSessionStatus,
    to: TmuxSessionStatus,
    error?: string,
  ): void {
    if (from === to) return;
    const suffix = error ? `: ${error}` : '';
    console.log(`[tmux-session] ${agentId} ${from} -> ${to}${suffix}`);
  }

  private async runProbe(
    agent: AgentConfig,
    tmux: TmuxManager,
  ): Promise<{ tmuxSessionStatus: TmuxSessionStatus; error?: string }> {
    try {
      const isPresent = await tmux.hasSession(agent.id, { timeout: this.probeTimeoutMs });
      return { tmuxSessionStatus: isPresent ? 'present' : 'absent' };
    } catch (err) {
      return {
        tmuxSessionStatus: 'unreachable',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

interface ProbeInstance {
  agent: AgentConfig;
  signature: string;
  connection: string;
  generation: number;
}

// alias / 密码 / 模型 / workdir 这类展示与启动参数改了,正在运行的 pane 与它的屏幕解读都不变,不算换代
function probeSignature(config: BaxianConfig, agent: AgentConfig): string {
  return JSON.stringify({
    runtime: agent.runtime,
    mode: agent.mode,
    host: hostGroupKey(agent.mode, resolveAgentHost(config.host, agent.host)),
  });
}

// 凭据只影响那一次连接:密码轮换不换代(pane 状态保留),但持旧凭据建立的在途探测结果一律作废,失败不能记到新配置头上
function connectionSignature(config: BaxianConfig, agent: AgentConfig): string {
  const host = resolveAgentHost(config.host, agent.host);
  return JSON.stringify({
    mode: agent.mode,
    hostname: host?.hostname,
    port: host?.port,
    user: host?.user,
    password: host?.password,
  });
}

function paneConclusionOf(last: TmuxSessionObservation): Partial<TmuxSessionObservation> {
  return {
    ...(last.paneState ? { paneState: last.paneState } : {}),
    ...(last.runtimeStatusHint ? { runtimeStatusHint: last.runtimeStatusHint } : {}),
    ...(last.reason ? { reason: last.reason } : {}),
    ...(last.message ? { message: last.message } : {}),
    ...(last.latestError ? { latestError: last.latestError } : {}),
  };
}

function buildInstanceIndex(config: BaxianConfig): Map<string, AgentConfig> {
  const byId = new Map<string, AgentConfig>();
  for (const project of config.project) {
    for (const team of project.agent) {
      for (const agent of team) {
        byId.set(agent.id, agent);
      }
    }
  }
  return byId;
}

function projectIdForAgent(config: BaxianConfig, agentId: string): string | undefined {
  for (const project of config.project) {
    for (const team of project.agent) {
      if (team.some(agent => agent.id === agentId)) return project.id;
    }
  }
  return undefined;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}
