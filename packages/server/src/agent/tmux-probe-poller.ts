import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AgentConfig,
  AgentErrorSummary,
  AgentRuntimeStatus,
  BaxianConfig,
  TmuxSessionStatus,
} from '../shared/index.js';
import type { AgentManager } from './manager.js';
import type { CommandRunner } from './runner.js';
import { createRunner, resolveAgentHost } from './runner.js';
import { TmuxManager, type AdoptPaneState, type AgentRuntimeKind } from './tmux.js';
import { evaluateManifest, type AgentManifest, type DetectedState } from './detect/manifest.js';
import { WorkingToIdleDebounce } from './detect/debounce.js';
import type { DetectionInput } from './detect/region.js';
import { PeriodicTaskRunner } from '../timing/periodic-task-runner.js';
import type { AgentStore } from '../state/agent-store.js';
import type { ErrorRecordStore } from '../state/error-record-store.js';

export interface TmuxSessionObservation {
  tmuxSessionStatus: TmuxSessionStatus;
  observedAt?: string;
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
    this.entries.set(agentId, entry);
    if (
      prev
      && prev.tmuxSessionStatus === entry.tmuxSessionStatus
      && prev.error === entry.error
      && prev.runtimeStatusHint === entry.runtimeStatusHint
      && prev.reason === entry.reason
      && prev.message === entry.message
      && prev.paneState === entry.paneState
      && prev.latestError?.id === entry.latestError?.id
    ) {
      return;
    }
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

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadManifests(): Map<AgentRuntimeKind, AgentManifest> {
  const dir = join(__dirname, 'detect', 'manifests');
  return new Map<AgentRuntimeKind, AgentManifest>([
    ['claude-code', JSON.parse(readFileSync(join(dir, 'claude-code.json'), 'utf-8')) as AgentManifest],
    ['codex', JSON.parse(readFileSync(join(dir, 'codex.json'), 'utf-8')) as AgentManifest],
    ['opencode', JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf-8')) as AgentManifest],
    ['qodercli', JSON.parse(readFileSync(join(dir, 'qodercli.json'), 'utf-8')) as AgentManifest],
  ]);
}

const DEFAULT_FAILURE_THRESHOLD = 2;
const PENDING_IDLE_AFTER_MS = 5 * 60 * 1000;

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
  private lastRecordedIssue = new Map<string, string>();
  private lastScreen = new Map<string, { hash: string; changedAt: number; taskId: string | null; idle: boolean; width: number }>();
  private validInstances = new Map<string, AgentConfig>();
  private manifests = loadManifests();
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
    this.validInstances = buildInstanceIndex(options.config);
    this.periodicRunner = new PeriodicTaskRunner({
      name: 'tmux-probe-poller',
      intervalMs: this.pollIntervalMs,
      run: () => this.probeConfiguredAgents(),
      onError: err => console.error('[tmux-probe] poll failed:', err),
    });
  }

  replaceConfig(validated: BaxianConfig): void {
    this.config = validated;
    this.validInstances = buildInstanceIndex(validated);
    const allKnownIds = new Set([
      ...this.failureCounts.keys(),
      ...this.lastRecordedIssue.keys(),
      ...this.lastScreen.keys(),
      ...this.store.keys(),
    ]);
    for (const id of allKnownIds) {
      if (!this.validInstances.has(id)) this.purgeAgent(id);
    }
    this.probeTimeoutMs = validated.server.tmuxProbeTimeoutMs;
    this.concurrency = validated.server.tmuxProbeConcurrency;
    const nextIntervalMs = validated.server.tmuxProbePollIntervalMs;
    if (nextIntervalMs !== this.pollIntervalMs) {
      this.pollIntervalMs = nextIntervalMs;
      this.periodicRunner.reschedule(nextIntervalMs);
    }
  }

  purgeAgent(id: string): void {
    this.failureCounts.delete(id);
    this.lastRecordedIssue.delete(id);
    this.resetDetectionBaseline(id);
    this.store.delete(id);
  }

  private resetDetectionBaseline(id: string): void {
    this.lastScreen.delete(id);
    this.debouncers.delete(id);
    this.lastPublishedState.delete(id);
  }

  private isCurrentInstance(agent: AgentConfig): boolean {
    return this.validInstances.get(agent.id) === agent;
  }

  private commitObservation(agent: AgentConfig, entry: TmuxSessionObservation): void {
    if (!this.isCurrentInstance(agent)) {
      this.purgeAgent(agent.id);
      return;
    }
    this.store.set(agent.id, entry);
  }

  private detectViaManifest(
    agentId: string,
    runtime: AgentRuntimeKind,
    runtimeScreen: string,
    oscTitle: string,
  ): { runtimeStatusHint?: AgentRuntimeStatus; visibleBlocker: boolean; visibleWorking: boolean; visibleIdle: boolean } | 'skip' {
    const manifest = this.manifests.get(runtime);
    if (!manifest) {
      return { runtimeStatusHint: undefined, visibleBlocker: false, visibleWorking: false, visibleIdle: false };
    }

    const input: DetectionInput = { screen: runtimeScreen, oscTitle };
    const detection = evaluateManifest(manifest, input);

    if (detection.skipStateUpdate) return 'skip';

    let debouncer = this.debouncers.get(agentId);
    if (!debouncer) {
      debouncer = new WorkingToIdleDebounce();
      this.debouncers.set(agentId, debouncer);
    }
    const previousPublished = this.lastPublishedState.get(agentId) ?? 'unknown';
    const published = debouncer.apply(detection.state, previousPublished, detection.visibleIdle);
    this.lastPublishedState.set(agentId, published);

    return {
      runtimeStatusHint: published === 'working' || published === 'pending' ? published : undefined,
      visibleBlocker: detection.visibleBlocker,
      visibleWorking: detection.visibleWorking,
      visibleIdle: detection.visibleIdle,
    };
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

  private async probeConfiguredAgents(): Promise<void> {
    const agents = uniqueAgents(this.config);
    await runWithConcurrency(agents, Math.max(1, this.concurrency), agent => this.probe(agent));
  }

  private async probe(agent: AgentConfig): Promise<void> {
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
    if (!this.isCurrentInstance(agent)) {
      this.purgeAgent(agent.id);
      return;
    }
    const now = new Date().toISOString();
    const previousEntry = this.store.get(agent.id);
    const previous = previousEntry.tmuxSessionStatus;

    if (result.tmuxSessionStatus === 'unreachable') {
      const failures = (this.failureCounts.get(agent.id) ?? 0) + 1;
      this.failureCounts.set(agent.id, failures);
      if (failures >= this.failureThreshold) {
        this.resetDetectionBaseline(agent.id);
        const latestError = await this.recordProbeError(agent, now, result.error);
        this.commitObservation(agent, {
          tmuxSessionStatus: 'unreachable',
          observedAt: now,
          ...(previousEntry.lastPresentAt ? { lastPresentAt: previousEntry.lastPresentAt } : {}),
          error: result.error,
          ...(latestError ? { latestError } : {}),
        });
        this.logTransition(agent.id, previous, 'unreachable', result.error);
      }
      return;
    }

    this.failureCounts.delete(agent.id);
    const presentProbe = result.tmuxSessionStatus === 'present' && tmux
      ? await this.observePresentSession(agent, tmux, now)
      : {};
    // present hasSession() but no owned pane (undefined) = foreign/gone name reuse; publish absent so reconcile runs, not a stale present.
    const effectiveStatus: TmuxSessionStatus =
      result.tmuxSessionStatus === 'present' && presentProbe === undefined
        ? 'absent'
        : result.tmuxSessionStatus;
    const presentDetails = presentProbe === undefined ? {} : presentProbe;

    if (effectiveStatus !== 'present') {
      this.lastRecordedIssue.delete(agent.id);
      this.resetDetectionBaseline(agent.id);
    }
    this.commitObservation(agent, {
      tmuxSessionStatus: effectiveStatus,
      observedAt: now,
      ...(effectiveStatus === 'present' ? { lastPresentAt: now } : {}),
      ...presentDetails,
    });
    this.logTransition(agent.id, previous, effectiveStatus);

    if (effectiveStatus === 'absent') {
      try {
        await this.agentManager.reconcileFailedAgent(agent.id);
      } catch (err) {
        console.error(`[tmux-probe] reconcileFailedAgent ${agent.id} threw:`, err);
      }
    }
  }

  private async observePresentSession(
    agent: AgentConfig,
    tmux: TmuxManager,
    occurredAt: string,
  ): Promise<Partial<TmuxSessionObservation> | undefined> {
    try {
      // Resolve the pane by generation+claim, not by name: a fresh server can reissue the
      // session name to a foreign session, and polling it would read someone else's pane.
      // A missing timeout lets a stuck remote list-sessions pin the poller worker indefinitely.
      const snapshot = await tmux.getSessionSnapshot(agent.id, { timeout: this.probeTimeoutMs });
      if (!snapshot || snapshot.claim !== agent.id) return undefined;
      const pane = await tmux.getSinglePaneByRef(snapshot.ref, agent.id, { timeout: this.probeTimeoutMs });
      const paneState = await tmux.classifyPaneForAdopt(pane, agent.runtime, { timeout: this.probeTimeoutMs });
      const liveRuntime = paneState.kind === 'live-runtime';
      // the four reads only depend on the pane — run the round-trips concurrently
      const [runtimeScreen, currentTaskId, oscTitle, paneWidth] = liveRuntime
        ? await Promise.all([
            tmux.capturePaneById(pane, {
              ansi: false,
              scrollback: 0,
              timeoutMs: this.probeTimeoutMs,
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
      const manifestResult = liveRuntime
        ? this.detectViaManifest(agent.id, agent.runtime, runtimeScreen, oscTitle)
        : undefined;

      if (liveRuntime) {
        const hash = createHash('sha1').update(runtimeScreen).update(oscTitle).digest('hex');
        const idleNow = manifestResult && manifestResult !== 'skip' ? manifestResult.visibleIdle : false;
        const prev = this.lastScreen.get(agent.id);
        if (!prev || prev.taskId !== currentTaskId) {
          this.lastScreen.set(agent.id, { hash, changedAt: this.now(), taskId: currentTaskId, idle: idleNow, width: paneWidth });
        } else if (prev.hash !== hash) {
          // A viewer resize reflows an idle pane (pane_width changes) — that is not runtime activity; real output keeps the same width. Only a width-changing idle→idle reflow keeps the idle-grace clock.
          const cosmeticIdleReflow = idleNow && prev.idle && prev.width > 0 && paneWidth > 0 && prev.width !== paneWidth;
          this.lastScreen.set(agent.id, { hash, changedAt: cosmeticIdleReflow ? prev.changedAt : this.now(), taskId: currentTaskId, idle: idleNow, width: paneWidth });
        } else if (prev.width !== paneWidth) {
          // Hash unchanged but pane_width changed (a resize that did not alter a short capture) — sync the cached width so the next real output compares against the current width, not a stale pre-resize one.
          this.lastScreen.set(agent.id, { ...prev, width: paneWidth });
        }
      } else {
        this.resetDetectionBaseline(agent.id);
      }

      if (manifestResult === 'skip') {
        const prev = this.store.get(agent.id);
        return {
          paneState: paneState.kind,
          ...(prev.runtimeStatusHint ? { runtimeStatusHint: prev.runtimeStatusHint } : {}),
          ...(prev.reason ? { reason: prev.reason } : {}),
          ...(prev.message ? { message: prev.message } : {}),
          ...(prev.latestError ? { latestError: prev.latestError } : {}),
        };
      }

      const pending = manifestResult ? manifestResult.visibleBlocker : false;
      const busy = manifestResult ? manifestResult.runtimeStatusHint === 'working' : false;
      const screenStatic = !pending && this.screenStaticForGrace(agent.id, paneState);
      const visibleWorking = manifestResult ? manifestResult.visibleWorking : false;
      const stuckBusy = busy && screenStatic && visibleWorking;
      const pendingIdle = !busy && screenStatic;
      const issue = this.issueForPaneState(paneState, pending, pendingIdle, stuckBusy);
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
      this.resetDetectionBaseline(agent.id);
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

  private issueForPaneState(
    paneState: AdoptPaneState,
    pendingRuntimeMenu: boolean,
    pendingIdle: boolean,
    stuckBusy: boolean,
  ): { runtimeStatusHint: AgentRuntimeStatus; reason: string; message: string } | undefined {
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
    issue: { reason: string; message: string; runtimeStatusHint: AgentRuntimeStatus },
  ): Promise<AgentErrorSummary | undefined> {
    if (!this.errorRecordStore) return undefined;
    const key = `${issue.reason}:${issue.message}`;
    if (this.lastRecordedIssue.get(agent.id) === key) {
      return this.store.get(agent.id).latestError;
    }
    this.lastRecordedIssue.set(agent.id, key);
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
        recommendation: issue.runtimeStatusHint === 'pending'
          ? 'Open the web terminal and complete the pending prompt.'
          : 'Inspect the pane before assigning more work to this agent.',
      });
      return this.errorRecordStore.toSummary(record);
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

function uniqueAgents(config: BaxianConfig): AgentConfig[] {
  return [...buildInstanceIndex(config).values()];
}

function buildInstanceIndex(config: BaxianConfig): Map<string, AgentConfig> {
  const byId = new Map<string, AgentConfig>();
  for (const project of config.project) {
    for (const pair of project.agent) {
      for (const agent of pair) {
        byId.set(agent.id, agent);
      }
    }
  }
  return byId;
}

function projectIdForAgent(config: BaxianConfig, agentId: string): string | undefined {
  for (const project of config.project) {
    for (const pair of project.agent) {
      if (pair.some(agent => agent.id === agentId)) return project.id;
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
