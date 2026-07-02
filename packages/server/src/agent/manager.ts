import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSignalToken, type ReadFileSignal } from './phase-signal.js';
import type {
  AfterDone,
  BaxianConfig,
  AgentConfig,
  AgentBindingFacts,
  BaxianEvent,
  HostConfig,
  ProjectConfig,
  ReviewMode,
  TaskPhase,
  TaskState,
  TaskStatus,
} from '../shared/index.js';
import {
  BRANCH_PREFIX,
  isValidBranchName,
  PHASE_EXPECTED_STATUS,
  PHASE_REQUIRES_AGENT_BOUND_TO_TASK,
  TASK_TERMINAL_STATUSES as TERMINAL_STATUSES,
  TASK_ACTIVE_STATUS_SET as ACTIVE_TASK_STATUSES,
  isGitHubRepo,
  repoSlug,
} from '../shared/index.js';
import type { AgentStore } from '../state/agent-store.js';
import { AGENT_STORE_NOOP } from '../state/agent-store.js';
import type { TaskStore } from '../state/task-store.js';
import { PostApproveStore, type PostApproveCompletion } from '../state/post-approve-store.js';
import type { LockManager } from '../state/lock.js';
import type { EventBus } from '../event/bus.js';
import type { ErrorRecordStore, ErrorRecordInput } from '../state/error-record-store.js';
import { SkillRegistry } from '../skill/registry.js';
import type { CommandRunner } from './runner.js';
import { createRunner, LocalRunner, shellQuote, resolveAgentHost, hostGroupKey } from './runner.js';
import { imageFilename, agentHostPath, writeImageToHost } from './image-input.js';
import {
  TmuxManager,
  ReplNotReadyError,
  detectStartupDialog,
  detectRuntimeMenu,
  runtimeBusyCheck,
  hasRuntimeReadyView,
  hasReplProcTitle,
  hasOscTitleWorking,
  type AdoptPaneState,
  type AgentRuntimeKind,
} from './tmux.js';
import { WorktreeManager } from './worktree.js';
import { RepoStore, createRepoStoreCache, type RepoStoreCache } from './repo-store.js';
import type { PaneStreamerManager } from './pane-streamer-manager.js';
import { PhaseSignalWatcher } from './phase-signal-watcher.js';
import type { PhaseSignalKind } from './phase-signal.js';
import { ReviewTransport } from './review-transport.js';
import type { ReviewStore } from '../state/review-store.js';
import {
  buildPromptInline,
  buildGreetingPrompt,
  PromptSizeError,
  RequiredSkillsMissingError,
  MAX_PROMPT_BYTES_ROUTE_LIMIT,
  type PostMergeCleanupContext,
} from './prompt.js';
import { ApiError } from '../errors.js';
import { prepareConfig } from '../config/loader.js';

export interface EnsureSessionResult {
  ok: true;
  createdSession: boolean;
  freshRuntime: boolean;
  paneId: string;
  workdir: string;
}

export class EnsureSessionError extends Error {
  constructor(
    public readonly partial: {
      createdSession: boolean;
      agentId: string;
      dialogPending?: boolean;
      handled?: boolean;
      lastScreen?: string;
    },
    message: string,
  ) {
    super(message);
    this.name = 'EnsureSessionError';
  }
}

export type DispatchTerminalReason =
  | 'runtime_ack_timeout'
  | 'ack_unknown'
  | 'gate_failed'
  | 'prompt_too_large'
  | 'required_skills_missing'
  | 'task_image_missing';

export class CleanupFailedError extends Error {
  constructor(
    message: string,
    public readonly failures: Array<{ agentId: string; step: string; error: unknown }>,
  ) {
    super(message);
    this.name = 'CleanupFailedError';
  }
}

export class DispatchTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatchTransientError';
  }
}

export class DispatchTerminalError extends Error {
  constructor(
    public readonly reason: DispatchTerminalReason,
    message: string,
    public readonly replDrained: boolean = false,
  ) {
    super(message);
    this.name = 'DispatchTerminalError';
  }
}

export type EnsureSessionMode = 'create' | 'runtime' | 'recover';

export function buildLaunchCommand(agent: AgentConfig): string {
  const segments: string[] = [];
  switch (agent.runtime) {
    case 'claude-code':
      segments.push('env CLAUDE_CODE_NO_FLICKER=1 CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 claude --permission-mode bypassPermissions');
      break;
    case 'codex':
      segments.push('codex --dangerously-bypass-approvals-and-sandbox');
      break;
  }
  if (agent.model) {
    segments.push(`--model ${shellQuote(agent.model)}`);
  }
  if (agent.addDirs && agent.addDirs.length > 0) {
    for (const dir of agent.addDirs) {
      segments.push(`--add-dir ${shellQuote(dir)}`);
    }
  }
  return segments.join(' ');
}

function agentRuntimeKindFor(agent: AgentConfig): 'claude-code' | 'codex' {
  return agent.runtime;
}

export interface AgentManagerDeps {
  config: BaxianConfig;
  agentStore: AgentStore;
  taskStore: TaskStore;
  lockManager: LockManager;
  eventBus: EventBus;
  skillRegistry?: SkillRegistry;
  runnerFactory?: (agent: AgentConfig) => CommandRunner;
  platformRunner?: CommandRunner;
  imageStagingRoot?: string;
  repoStoreFactory?: (
    runner: CommandRunner,
    repoSlug: string,
    mode: AgentConfig['mode'],
    host: HostConfig | undefined,
    cache: RepoStoreCache,
  ) => RepoStore;
  paneStreamerManager?: PaneStreamerManager;
  postApproveStore?: PostApproveStore;
  phaseSignalWatcher?: PhaseSignalWatcher;
  errorRecordStore?: ErrorRecordStore;
  reviewStore?: ReviewStore;
  bootstrapTimeoutsMs?: {
    trustDialog?: number;
    waitReplReady?: number;
    greeting?: number;
  };
  dispatchAckTimeoutMs?: number;
  dispatchSettleTimeoutMs?: number;
}

const DEFAULT_DISPATCH_ACK_TIMEOUT_MS = 30_000;
const DEFAULT_DISPATCH_SETTLE_TIMEOUT_MS = 3_000;

export interface TransitionResult {
  task: TaskState;
  previousStatus: TaskStatus;
}

export interface ContinueSessionOpts {
  signalToken?: string;
  postApproveRedispatchCount?: number;
  currentSpecRound?: number;
  bypassTaskStatusGate?: boolean;
  dialogFailFromStatuses?: TaskStatus[];
  serverContent?: string;
  serverDiffstat?: string;
  serverBatch?: { index: number; total: number };
  serverPriorFindings?: string;
  serverPriorResponse?: string;
  serverAfterDone?: { kind: 'branch' | 'pr'; branch: string };
  contentTruncated?: boolean;
  armBeforeInject?: () => Promise<boolean>;
}

export interface MergePrOpts {
  matchHeadSha?: string;
}

interface DispatchReviewSnapshot {
  qaAgentId?: string;
  signalToken?: string;
  reviewHeadAnchorSha?: string;
  reviewDispatchedAt?: string;
}

const IMAGE_DISPATCH_PHASES = new Set<string>(['develop', 'code', 'fix', 'server-feedback']);

const RUNTIME_LIVENESS_SAMPLES = 3;

export function canDispatchWithBinding(binding: AgentBindingFacts | null | undefined): boolean {
  return !binding?.taskId && !binding?.creationToken && binding?.status !== 'awaiting_human';
}

const TURN_COMPLETED_AWAITING_PHASES = new Set<string>();

// 'cancel-clear-failed' is no longer produced (cancel stopped clearing); kept so legacy persisted holds stay recognized.
const CANCEL_CLEANUP_HOLD_PHASES = new Set<string>(['cancel-clearing', 'cancel-clear-failed', 'cancel-interrupt-failed']);

function isCancelCleanupHold(binding: { awaitingPhase?: string } | null | undefined): boolean {
  return binding?.awaitingPhase != null && CANCEL_CLEANUP_HOLD_PHASES.has(binding.awaitingPhase);
}

const CANCEL_CLEANUP_PHASE_RANK: Record<string, number> = {
  'cancel-clearing': 1,
  'cancel-interrupt-failed': 2,
  'cancel-clear-failed': 3,
};
function cancelPhaseRank(phase: string | undefined): number {
  return phase ? (CANCEL_CLEANUP_PHASE_RANK[phase] ?? 0) : 0;
}
function cancelPhaseDowngrades(prev: string | undefined, next: string): boolean {
  return cancelPhaseRank(next) < cancelPhaseRank(prev);
}

const REGREET_REQUIRED_HOLD_PHASES = new Set<string>(['greeting_failed']);

export function shouldReleaseHeldBinding(
  state: AgentBindingFacts,
  boundTask: TaskState | null | undefined,
): boolean {
  if (state.awaitingPhase != null && REGREET_REQUIRED_HOLD_PHASES.has(state.awaitingPhase)) return false;
  const taskIsTerminal = !!boundTask && TERMINAL_STATUSES.includes(boundTask.status);
  const turnCompleted = state.awaitingPhase != null && TURN_COMPLETED_AWAITING_PHASES.has(state.awaitingPhase);
  return !boundTask || taskIsTerminal || turnCompleted;
}

export class AgentManager {
  private config: BaxianConfig;
  protected agentStore: AgentStore;
  protected taskStore: TaskStore;
  protected lockManager: LockManager;
  protected eventBus: EventBus;
  protected skillRegistry: SkillRegistry;
  protected runnerFactory?: (agent: AgentConfig) => CommandRunner;
  protected repoStoreFactory?: AgentManagerDeps['repoStoreFactory'];
  protected repoCache: RepoStoreCache;
  protected paneStreamerManager?: PaneStreamerManager;
  protected postApproveStore: PostApproveStore;
  protected phaseSignalWatcher?: PhaseSignalWatcher;
  protected errorRecordStore?: ErrorRecordStore;
  protected reviewStore?: ReviewStore;
  private reviewTransportInstance?: ReviewTransport;
  protected dispatchAckTimeoutMs: number;
  protected dispatchSettleTimeoutMs: number;
  protected dispatchAckResendIntervalMs = 3_000;

  private taskMutationQueue: Promise<unknown> = Promise.resolve();
  private agentIndex: Map<string, AgentConfig & { projectId: string }>;
  private platformRunner: CommandRunner;
  private imageStagingRoot: string;
  private bootstrapTimeoutsMs: { trustDialog: number; waitReplReady: number; greeting: number };
  protected greetingMaxAttempts = 2;
  private runtimeMenuWatchers = new Map<string, AbortController>();
  protected runtimeMenuPollIntervalMs = 10_000;
  protected compactIdleWaitMs = 5 * 60_000;
  protected compactIdlePollMs = 2_000;
  protected manualCompactWaitMs = 5_000;
  protected runtimeLivenessProbeMs = 700;
  protected cleanComposerWaitMs = 5_000;
  protected cancelInterruptGuardWaitMs = DEFAULT_DISPATCH_ACK_TIMEOUT_MS + 5_000;
  protected postMergeFetchTimeoutMs = 60_000;
  protected postMergeBranchTimeoutMs = 10_000;
  private manualReviewInFlight = new Set<string>();
  private markCompleteInFlight = new Set<string>();
  // 引用计数：cancelTask 与 startCreatedTaskSession 的清理段可合法并存（启动期 Stop），先完成者不得清掉后者的 guard。
  private cancelCleanupInFlight = new Map<string, number>();
  private deletionInFlight = new Set<string>();
  private compactInFlight = new Set<string>();

  constructor(deps: AgentManagerDeps) {
    const config = prepareConfig(deps.config);
    this.config = config;
    this.agentStore = deps.agentStore;
    this.taskStore = deps.taskStore;
    this.lockManager = deps.lockManager;
    this.eventBus = deps.eventBus;
    this.skillRegistry = deps.skillRegistry ?? new SkillRegistry();
    this.runnerFactory = deps.runnerFactory;
    this.repoStoreFactory = deps.repoStoreFactory;
    this.paneStreamerManager = deps.paneStreamerManager;
    this.postApproveStore = deps.postApproveStore ?? new PostApproveStore();
    this.errorRecordStore = deps.errorRecordStore;
    this.phaseSignalWatcher = deps.phaseSignalWatcher
      ?? (deps.paneStreamerManager
        ? new PhaseSignalWatcher({
            paneStreamerManager: deps.paneStreamerManager,
            eventBus: deps.eventBus,
            resolveAgent: (id) => this.getAgentConfig(id),
          })
        : undefined);
    this.reviewStore = deps.reviewStore;
    this.dispatchAckTimeoutMs = deps.dispatchAckTimeoutMs ?? DEFAULT_DISPATCH_ACK_TIMEOUT_MS;
    this.dispatchSettleTimeoutMs = deps.dispatchSettleTimeoutMs ?? DEFAULT_DISPATCH_SETTLE_TIMEOUT_MS;
    this.cancelInterruptGuardWaitMs = this.dispatchAckTimeoutMs + 5_000;
    this.agentIndex = buildAgentIndex(config);
    this.platformRunner = deps.platformRunner ?? new LocalRunner();
    this.imageStagingRoot = deps.imageStagingRoot ?? join(tmpdir(), 'baxian-task-images');
    this.repoCache = createRepoStoreCache();
    this.bootstrapTimeoutsMs = {
      trustDialog: deps.bootstrapTimeoutsMs?.trustDialog ?? 10_000,
      waitReplReady: deps.bootstrapTimeoutsMs?.waitReplReady ?? 30_000,
      greeting: deps.bootstrapTimeoutsMs?.greeting ?? 120_000,
    };
  }

  private withTaskLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.taskMutationQueue.then(fn);
    this.taskMutationQueue = next.catch(() => undefined);
    return next;
  }

  getReviewStore(): ReviewStore | undefined {
    return this.reviewStore;
  }

  effectiveReviewMode(projectId: string): ReviewMode {
    const project = this.getProjectConfig(projectId);
    return project?.review?.mode ?? this.config.review.mode ?? 'github';
  }

  resolveAfterDone(task: TaskState): AfterDone {
    if (task.afterDone !== undefined) return task.afterDone;
    return this.coerceAfterDone(task.projectId, this.config.review.afterDone);
  }

  private coerceAfterDone(projectId: string, configured: AfterDone | undefined): AfterDone {
    const project = this.getProjectConfig(projectId);
    if (project && !isGitHubRepo(project.repo)) {
      if (configured === 'pr' || configured === undefined) return 'branch';
      return configured;
    }
    return configured ?? null;
  }

  getReviewTransport(): ReviewTransport {
    this.reviewTransportInstance ??= new ReviewTransport({
      createRunnerFor: (agent) => this.createRunnerFor(agent),
      resolveWorktree: (agentId) => this.bindingWorktreeCache.get(agentId),
    });
    return this.reviewTransportInstance;
  }

  private bindingWorktreeCache = new Map<string, string>();

  async refreshWorktreeCacheFor(agentId: string): Promise<string | undefined> {
    const state = await this.agentStore.get(agentId);
    if (state?.worktreePath) {
      this.bindingWorktreeCache.set(agentId, state.worktreePath);
      return state.worktreePath;
    }
    this.bindingWorktreeCache.delete(agentId);
    return undefined;
  }

  private async safeEmit(event: BaxianEvent): Promise<void> {
    try {
      await this.eventBus.emit(event);
    } catch (err) {
      console.warn(
        `[AgentManager] safeEmit ${event.type} failed (audit log loss; state machine unaffected):`,
        err,
      );
    }
  }

  private async recordError(input: ErrorRecordInput): Promise<void> {
    if (!this.errorRecordStore) return;
    try {
      await this.errorRecordStore.append(input);
    } catch (err) {
      console.warn(`[AgentManager] ErrorRecordStore.append failed (${input.operation}/${input.reason}):`, err);
    }
  }

  replaceConfig(validated: BaxianConfig): void {
    const config = prepareConfig(validated);
    this.config = config;
    this.agentIndex = buildAgentIndex(config);
  }

  getConfig(): BaxianConfig {
    return this.config;
  }

  getAgentConfig(agentId: string): (AgentConfig & { projectId: string }) | undefined {
    return this.agentIndex.get(agentId);
  }

  tryClaimDeletion(agentIds: readonly string[]): string | null {
    for (const id of agentIds) {
      if (this.deletionInFlight.has(id)) return id;
    }
    for (const id of agentIds) this.deletionInFlight.add(id);
    return null;
  }

  releaseDeletionClaim(agentIds: readonly string[]): void {
    for (const id of agentIds) this.deletionInFlight.delete(id);
  }

  isDeletionInFlight(agentId: string): boolean {
    return this.deletionInFlight.has(agentId);
  }

  async ensureSession(agentId: string, mode: EnsureSessionMode): Promise<EnsureSessionResult> {
    const agent = this.getAgentConfig(agentId);
    if (!agent) {
      throw new EnsureSessionError({ createdSession: false, agentId }, `Unknown agent: ${agentId}`);
    }
    const project = this.getProjectConfig(agent.projectId);
    if (!project) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `Unknown project: ${agent.projectId}`,
      );
    }
    const runner = this.createRunnerFor(agent);
    const tmux = new TmuxManager(runner);

    let workdir: string;
    try {
      const resolved = await this.ensureWorkdir(agent, project, runner);
      workdir = resolved.workdir;
      if (resolved.repoStore) {
        await this.agentStore.update(agentId, (existing) => {
          if (!existing) return AGENT_STORE_NOOP;
          return {
            ...existing,
            repoPath: workdir,
            updatedAt: new Date().toISOString(),
          };
        });
      }
    } catch (err) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `ensureWorkdir failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      await this.provisionRepoSkills(runner, agent, workdir);
    } catch (err) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `skill provisioning failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let alive: boolean;
    try {
      alive = await tmux.hasSession(agentId);
    } catch (err) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `tmux probe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (mode === 'create' && alive) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `tmux session "${agentId}" already exists on host; baxian only manages sessions ` +
          `it creates itself — kill it manually or pick a different agent id`,
      );
    }

    if (alive && (mode === 'runtime' || mode === 'recover')) {
      return this.adoptOrRestartSession(tmux, agent, agentId, workdir);
    }

    return this.buildFreshSession(tmux, agent, agentId, workdir);
  }

  private async provisionRepoSkills(
    runner: CommandRunner,
    agent: AgentConfig,
    workdir: string,
  ): Promise<void> {
    if (this.skillRegistry.names().length === 0) return;
    const subdir = agent.runtime === 'codex' ? '.agents/skills' : '.claude/skills';
    const destRoot = `${workdir}/${subdir}`;
    await this.excludeInjectedSkills(runner, workdir, subdir);
    await this.runUnderSkillDirLock(this.skillDirLockKey(agent, workdir), async () => {
      await this.ensureSkillDirSafe(runner, workdir, subdir);
      await this.skillRegistry.materialize(
        (path, content) => this.atomicWriteFile(runner, path, content),
        destRoot,
      );
    });
  }

  private skillDirChain = new Map<string, Promise<unknown>>();
  private skillDirLockKey(agent: AgentConfig, workdir: string): string {
    const host = hostGroupKey(agent.mode, resolveAgentHost(this.config.host, agent.host));
    const subdir = agent.runtime === 'codex' ? '.agents/skills' : '.claude/skills';
    const dir = workdir.replace(/\/+$/, '');
    return `${host}:${dir}:${subdir}`;
  }
  private runUnderSkillDirLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.skillDirChain.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.skillDirChain.set(key, run.then(() => undefined, () => undefined));
    return run;
  }

  private async atomicWriteFile(
    runner: CommandRunner,
    finalPath: string,
    content: Buffer,
  ): Promise<void> {
    const tmp = `${finalPath}.baxian-tmp`;
    await runner.writeFile(tmp, content);
    const mv = `mv -f ${shellQuote(tmp)} ${shellQuote(finalPath)}`;
    const res = await runner.exec(`sh -c ${shellQuote(mv)}`);
    if (res.exitCode !== 0) {
      throw new Error(`atomic skill write failed (${finalPath}): ${res.stderr || 'unknown error'}`);
    }
  }

  private async ensureSkillDirSafe(
    runner: CommandRunner,
    workdir: string,
    subdir: string,
  ): Promise<void> {
    const top = subdir.split('/')[0];
    const keep = this.skillRegistry.names().map((n) => `! -name ${shellQuote(n)}`).join(' ');
    const inner =
      `cd ${shellQuote(workdir)} && ` +
      `for d in ${top} ${subdir}; do if [ -L "$d" ]; then ` +
      `printf 'baxian: %s is a symlink -> %s; replace it with a real directory\\n' "$d" "$(readlink "$d")" >&2; ` +
      `exit 3; fi; done && ` +
      `mkdir -p ${subdir} && ` +
      `find ${subdir} -maxdepth 1 -name 'baxian-*' ${keep} -exec rm -rf {} + && ` +
      `find ${subdir} -path '${subdir}/baxian-*' -type l -exec rm -f {} + && ` +
      `find ${subdir} -path '${subdir}/baxian-*/*' -type f ! -name 'SKILL.md' -exec rm -f {} +`;
    const res = await runner.exec(`sh -c ${shellQuote(inner)}`);
    if (res.exitCode !== 0) {
      throw new Error(
        `failed to prepare a symlink-safe ${subdir} in ${workdir}: ${res.stderr || 'unknown error'}`,
      );
    }
  }

  private async tagSessionSkillsVersion(tmux: TmuxManager, agentId: string): Promise<void> {
    if (this.skillRegistry.names().length === 0) return;
    await tmux.setOption(agentId, '@baxian-skills-version', this.skillRegistry.contentHash());
  }

  private async replSkillsStale(tmux: TmuxManager, agentId: string): Promise<boolean> {
    if (this.skillRegistry.names().length === 0) return false;
    const tagged = await tmux.getOption(agentId, '@baxian-skills-version');
    return tagged !== this.skillRegistry.contentHash();
  }

  private async excludeInjectedSkills(
    runner: CommandRunner,
    workdir: string,
    subdir: string,
  ): Promise<void> {
    const inner =
      `cd ${shellQuote(workdir)} && if p="$(git rev-parse --git-path info/exclude 2>/dev/null)"; then ` +
      `pre="$(git rev-parse --show-prefix 2>/dev/null)"; rule="\${pre}${subdir}/baxian-*"; ` +
      `mkdir -p "$(dirname "$p")" && { grep -qxF "$rule" "$p" 2>/dev/null || printf '%s\\n' "$rule" >> "$p"; }; fi`;
    const res = await runner.exec(`sh -c ${shellQuote(inner)}`);
    if (res.exitCode !== 0) {
      console.warn(
        `[AgentManager] skill info/exclude best-effort failed in ${workdir} ` +
          `(skills still materialized): ${res.stderr || 'unknown error'}`,
      );
    }
  }

  private async pinRuntimeSessionOptions(tmux: TmuxManager, agentId: string): Promise<void> {
    await tmux.setOption(agentId, 'prefix', 'C-b');
    await tmux.setOption(agentId, 'prefix2', 'None');
    await tmux.setOption(agentId, 'mouse', 'on');
  }

  private async pinFreshSessionOptions(tmux: TmuxManager, agentId: string): Promise<void> {
    await tmux.setOption(agentId, 'window-size', 'latest');
    await this.pinRuntimeSessionOptions(tmux, agentId);
  }

  private async buildFreshSession(
    tmux: TmuxManager,
    agent: AgentConfig & { projectId: string },
    agentId: string,
    workdir: string,
  ): Promise<EnsureSessionResult> {
    return this.runUnderSkillDirLock(
      this.skillDirLockKey(agent, workdir),
      () => this.buildFreshSessionLocked(tmux, agent, agentId, workdir),
    );
  }

  private async buildFreshSessionLocked(
    tmux: TmuxManager,
    agent: AgentConfig & { projectId: string },
    agentId: string,
    workdir: string,
  ): Promise<EnsureSessionResult> {
    let createdSession = false;
    const runtime = agentRuntimeKindFor(agent);
    try {
      await tmux.createSession(agentId, workdir);
      createdSession = true;
      await tmux.setOption(agentId, '@baxian-agent-id', agentId);
      await tmux.setOption(agentId, '@baxian-runtime', agent.runtime);
      await tmux.setOption(agentId, 'allow-passthrough', 'on');
      await tmux.setOption(agentId, 'set-titles', 'on');
      await this.pinFreshSessionOptions(tmux, agentId);
      await tmux.setOption(agentId, 'status-right', '');
      await tmux.setServerOption('extended-keys', 'on');
      await tmux.appendServerOptionIfMissing('terminal-features', 'xterm*:extkeys');
      const paneId = await tmux.getSinglePaneId(agentId);
      await tmux.sendKeysToPane(paneId, `${buildLaunchCommand(agent)}\n`);
      await tmux.handleTrustDialog(paneId, runtime, {
        timeoutMs: this.bootstrapTimeoutsMs.trustDialog,
      });
      await tmux.waitReplReady(paneId, runtime, {
        timeoutMs: this.bootstrapTimeoutsMs.waitReplReady,
        scrollback: 0,
      });
      await this.tagSessionSkillsVersion(tmux, agentId);
      return { ok: true, createdSession: true, freshRuntime: true, paneId, workdir };
    } catch (err) {
      const partial: {
        createdSession: boolean;
        agentId: string;
        dialogPending?: boolean;
        lastScreen?: string;
      } = { createdSession, agentId };
      if (err instanceof ReplNotReadyError) {
        partial.lastScreen = err.lastScreen;
        if (createdSession && detectStartupDialog(err.lastScreen, runtime)) {
          partial.dialogPending = true;
        }
      }
      throw new EnsureSessionError(
        partial,
        `buildFreshSession failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async startBootstrapAsync(agentId: string, creationToken: string): Promise<void> {
    const cfgAtStart = this.getAgentConfig(agentId);
    if (!cfgAtStart) {
      console.warn(
        `[bootstrap] ${agentId} not in config at bootstrap start — aborting`,
      );
      return;
    }
    const tryKillOrphanSession = async (reason: string): Promise<void> => {
      try {
        const runner = this.createRunnerFor(cfgAtStart);
        await new TmuxManager(runner).killSession(agentId);
      } catch (cleanupErr) {
        console.warn(
          `[bootstrap] orphan killSession (${reason}) failed for ${agentId}:`,
          cleanupErr,
        );
      }
    };

    try {
      const result = await this.ensureSession(agentId, 'create');
      if (!(await this.runGreetingHandshake(agentId, cfgAtStart, result.paneId))) {
        const current = await this.agentStore.get(agentId);
        if (current && current.creationToken !== creationToken) {
          console.warn(
            `[bootstrap] ${agentId} creationToken changed during greeting — killing orphan session`,
          );
          await tryKillOrphanSession('greeting-failure token mismatch');
          return;
        }
        await this.markGreetingFailed(agentId, creationToken);
        return;
      }
      let resolvedExisting: AgentBindingFacts | null = null;
      const now = new Date().toISOString();
      await this.agentStore.update(agentId, (existing) => {
        if (!existing || existing.creationToken !== creationToken) return AGENT_STORE_NOOP;
        resolvedExisting = existing;
        const {
          status: _status,
          awaitingPhase: _awaitingPhase,
          awaitingReason: _awaitingReason,
          awaitingSince: _awaitingSince,
          ...readyState
        } = existing;
        return {
          ...readyState,
          paneId: result.paneId,
          creationToken: undefined,
          updatedAt: now,
        };
      });
      if (!resolvedExisting) {
        console.warn(
          `[bootstrap] ${agentId} creationToken mismatch on success — killing orphan session`,
        );
        await tryKillOrphanSession('post-success token mismatch');
        return;
      }
      await this.safeEmit({
        id: '',
        type: 'agent.bootstrap_succeeded',
        timestamp: now,
        projectId: (resolvedExisting as AgentBindingFacts).projectId,
        agentId,
        data: { paneId: result.paneId, phase: 'session' },
      });
      return;
    } catch (err) {
      if (err instanceof EnsureSessionError && err.partial.dialogPending) {
        if (err.partial.createdSession) {
          const fresh = await this.agentStore.get(agentId);
          if (!fresh || fresh.creationToken !== creationToken) {
            console.warn(
              `[bootstrap] ${agentId} dialog-path token mismatch — killing orphan session`,
            );
            await tryKillOrphanSession('dialog-path token mismatch');
            return;
          }
        }
        await this.markDialogPending(agentId, creationToken);
        void this.slowPollDialogPending(agentId, creationToken).catch((pollErr) => {
          console.warn(`[bootstrap] slowPoll for ${agentId} crashed:`, pollErr);
        });
        return;
      }
      if (err instanceof EnsureSessionError && err.partial.createdSession) {
        await tryKillOrphanSession('hard-failure rollback');
      }
      const message = err instanceof Error ? err.message : String(err);
      await this.markBootstrapFailed(agentId, creationToken, message);
    }
  }

  private async runGreetingHandshake(
    agentId: string,
    agent: AgentConfig & { projectId: string },
    paneId: string,
  ): Promise<boolean> {
    const watcher = this.phaseSignalWatcher;
    if (!watcher) return true;
    const tmux = new TmuxManager(this.createRunnerFor(agent));
    for (let attempt = 1; attempt <= this.greetingMaxAttempts; attempt++) {
      const token = createSignalToken();
      try {
        await this.injectAndAwaitAckSteps(
          tmux, paneId, buildGreetingPrompt(token, agent.runtime), agentId, agent.runtime,
        );
      } catch (err) {
        console.warn(`[bootstrap] greeting inject failed for ${agentId} (attempt ${attempt}):`, err);
        if (err instanceof DispatchTerminalError && err.reason === 'ack_unknown') break;
        continue;
      }
      const outcome = await watcher.awaitOnce({
        agentId,
        kind: 'greeting',
        token,
        timeoutMs: this.bootstrapTimeoutsMs.greeting,
      });
      if (outcome === 'matched') return true;
      console.warn(
        `[bootstrap] greeting attempt ${attempt}/${this.greetingMaxAttempts} for ${agentId}: ${outcome}`,
      );
      if (outcome === 'no-agent') break;
      if (attempt < this.greetingMaxAttempts && !(await this.clearComposerForReuse(tmux, paneId, agentId))) {
        break;
      }
    }
    return false;
  }

  private async markGreetingFailed(
    agentId: string,
    creationToken: string | undefined,
  ): Promise<void> {
    const existing = await this.agentStore.get(agentId);
    if (!existing) return;
    if (creationToken !== undefined && existing.creationToken !== creationToken) return;
    const now = new Date().toISOString();
    const reason =
      'Greeting capability check failed: the agent did not echo a valid [bx:greeting] signal ' +
      'per the baxian-signals skill within the timeout. Its runtime/model may not meet baxian ' +
      'requirements (skill loading or pane signalling). Fix the runtime, then restart-repl or ' +
      'retry the agent to re-run the check (Resume will not clear it — capability must be re-proven).';
    let wrote = false;
    await this.agentStore.update(agentId, (fresh) => {
      if (!fresh) return AGENT_STORE_NOOP;
      if (creationToken !== undefined && fresh.creationToken !== creationToken) return AGENT_STORE_NOOP;
      wrote = true;
      return {
        ...fresh,
        creationToken: undefined,
        status: 'awaiting_human',
        awaitingPhase: 'greeting_failed',
        awaitingReason: reason,
        awaitingSince: now,
        updatedAt: now,
      };
    });
    if (!wrote) return;
    await this.safeEmit({
      id: '',
      type: 'human.intervention',
      timestamp: now,
      projectId: existing.projectId,
      agentId,
      data: { phase: 'greeting_failed', reason },
    });
  }

  async regreetHeldAgent(agentId: string): Promise<boolean> {
    const agent = this.getAgentConfig(agentId);
    if (!agent) return false;
    const state = await this.agentStore.get(agentId);
    if (state?.awaitingPhase !== 'greeting_failed') return false;
    const guardSince = state.awaitingSince;
    let paneId = state.paneId;
    if (!paneId) {
      try {
        paneId = await new TmuxManager(this.createRunnerFor(agent)).getSinglePaneId(agentId);
      } catch (err) {
        console.warn(`[regreet] cannot resolve pane for ${agentId}:`, err);
        return true;
      }
    }
    if (!(await this.runGreetingHandshake(agentId, agent, paneId))) {
      return true;
    }
    await this.agentStore.update(agentId, (fresh) => {
      if (!fresh || fresh.awaitingPhase !== 'greeting_failed' || fresh.awaitingSince !== guardSince) {
        return AGENT_STORE_NOOP;
      }
      const {
        status: _s, awaitingPhase: _ap, awaitingReason: _ar, awaitingSince: _as, ...ready
      } = fresh;
      return { ...ready, updatedAt: new Date().toISOString() };
    });
    return true;
  }

  private async markDialogPending(
    agentId: string,
    creationToken: string | undefined,
    opts: {
      runtimePath?: boolean;
      expectedPaneId?: string;
      expectedTaskId?: string | undefined;
    } = {},
  ): Promise<void> {
    const existing = await this.agentStore.get(agentId);
    if (!existing) return;
    if (existing.awaitingPhase != null && REGREET_REQUIRED_HOLD_PHASES.has(existing.awaitingPhase)) return;
    if (opts.runtimePath && opts.expectedPaneId === undefined && opts.expectedTaskId === undefined) {
      console.warn(
        `[AgentManager] markDialogPending runtime path: refusing to write without paneId/taskId snapshot (no generation guard available for ${agentId})`,
      );
      return;
    }
    if (opts.runtimePath) {
      if (existing.creationToken !== undefined) return;
      if (opts.expectedPaneId !== undefined && existing.paneId !== opts.expectedPaneId) return;
      if (existing.taskId !== opts.expectedTaskId) return;
    } else if (creationToken !== undefined && existing.creationToken !== creationToken) {
      return;
    }
    const cfg = this.getAgentConfig(agentId);
    let paneId: string | undefined = existing.paneId;
    if (cfg && !paneId) {
      try {
        const runner = this.createRunnerFor(cfg);
        paneId = await new TmuxManager(runner).getSinglePaneId(agentId);
      } catch {
      }
    }
    const now = new Date().toISOString();
    let wrote = false;
    let projectIdForEmit = '';
    let taskIdForEmit: string | undefined;
    await this.agentStore.update(agentId, (fresh) => {
      if (!fresh) return AGENT_STORE_NOOP;
      if (fresh.awaitingPhase != null && REGREET_REQUIRED_HOLD_PHASES.has(fresh.awaitingPhase)) return AGENT_STORE_NOOP;
      if (opts.runtimePath) {
        if (fresh.creationToken !== undefined) return AGENT_STORE_NOOP;
        if (opts.expectedPaneId !== undefined && fresh.paneId !== opts.expectedPaneId) return AGENT_STORE_NOOP;
        if (fresh.taskId !== opts.expectedTaskId) return AGENT_STORE_NOOP;
      } else if (creationToken !== undefined && fresh.creationToken !== creationToken) {
        return AGENT_STORE_NOOP;
      }
      projectIdForEmit = fresh.projectId;
      taskIdForEmit = fresh.taskId;
      wrote = true;
      return {
        ...fresh,
        ...(paneId !== undefined ? { paneId } : {}),
        status: 'awaiting_human',
        awaitingPhase: 'agent_dialog_pending',
        awaitingReason: 'Agent REPL launched but blocked on a startup dialog (e.g. CLI update notice). Operator should attach via web terminal and dismiss it; baxian will auto-detect ready and resume.',
        awaitingSince: now,
        updatedAt: now,
      };
    });
    if (!wrote) return;
    await this.safeEmit({
      id: '',
      type: 'human.intervention',
      timestamp: now,
      projectId: projectIdForEmit,
      agentId,
      ...(taskIdForEmit ? { taskId: taskIdForEmit } : {}),
      data: {
        phase: 'agent_dialog_pending',
        reason: 'Agent REPL launched but blocked on a startup dialog (e.g. CLI update notice). Operator should attach via web terminal and dismiss it; baxian will auto-detect ready and resume.',
      },
    });
  }

  private async markBootstrapFailed(
    agentId: string,
    creationToken: string | undefined,
    errorMessage: string,
  ): Promise<void> {
    const existing = await this.agentStore.get(agentId);
    if (!existing) return;
    if (creationToken !== undefined && existing.creationToken !== creationToken) return;
    const now = new Date().toISOString();
    await this.agentStore.update(agentId, (fresh) => {
      if (!fresh) return AGENT_STORE_NOOP;
      if (creationToken !== undefined && fresh.creationToken !== creationToken) return AGENT_STORE_NOOP;
      return {
        ...fresh,
        paneId: undefined,
        creationToken: undefined,
        updatedAt: now,
      };
    });
    await this.safeEmit({
      id: '',
      type: 'agent.bootstrap_failed',
      timestamp: now,
      projectId: existing.projectId,
      agentId,
      data: { error: errorMessage, phase: 'session' },
    });
  }

  async handleDialogPendingFromRuntime(
    agentId: string,
    err: unknown,
    opts: { expectedFromStatuses?: TaskStatus[] } = {},
  ): Promise<boolean> {
    if (!(err instanceof EnsureSessionError) || !err.partial.dialogPending) {
      return false;
    }
    let state = await this.agentStore.get(agentId);
    if (!state) return false;
    if (state.paneId === undefined && err.partial.createdSession) {
      const cfg = this.getAgentConfig(agentId);
      if (!cfg) return false;
      let discoveredPaneId: string | undefined;
      try {
        const runner = this.createRunnerFor(cfg);
        discoveredPaneId = await new TmuxManager(runner).getSinglePaneId(agentId);
      } catch (probeErr) {
        console.warn(
          `[AgentManager] handleDialogPendingFromRuntime: tmux probe paneId failed for ${agentId}:`,
          probeErr,
        );
        return false;
      }
      if (!discoveredPaneId) return false;
      const probeNow = new Date().toISOString();
      await this.agentStore.update(agentId, (fresh) => {
        if (!fresh) return AGENT_STORE_NOOP;
        if (fresh.paneId !== undefined) return AGENT_STORE_NOOP;
        return { ...fresh, paneId: discoveredPaneId, updatedAt: probeNow };
      });
      state = await this.agentStore.get(agentId);
      if (!state?.paneId) return false;
    }
    if (state.paneId === undefined && state.taskId === undefined) {
      console.warn(
        `[AgentManager] handleDialogPendingFromRuntime: ${agentId} has no paneId/taskId snapshot (no generation guard); refusing — caller should rollback`,
      );
      return false;
    }
    await this.markDialogPending(agentId, undefined, {
      runtimePath: true,
      ...(state.paneId !== undefined ? { expectedPaneId: state.paneId } : {}),
      expectedTaskId: state.taskId,
    });
    if (state.taskId && state.creationToken === undefined) {
      const expectedFromStatuses = opts.expectedFromStatuses ?? [...ACTIVE_TASK_STATUSES];
      const transitioned = await this.transitionTaskStatus(
        state.taskId,
        'failed',
        { fromStatus: expectedFromStatuses },
      );
      if (transitioned) {
        await this.safeEmit({
          id: '',
          type: 'task.updated',
          timestamp: new Date().toISOString(),
          projectId: transitioned.task.projectId,
          taskId: state.taskId,
          data: { status: 'failed', reason: 'agent_dialog_pending_runtime' },
        });
        await this.releasePartnersAndDrain(agentId, [state.taskId], [transitioned.task.projectId]);
      }
    }
    err.partial.handled = true;
    const snapshotPaneId = state.paneId;
    const snapshotTaskId = state.taskId;
    void this.slowPollDialogPending(agentId, state.creationToken, {
      ...(snapshotPaneId !== undefined ? { expectedPaneId: snapshotPaneId } : {}),
      expectedTaskId: snapshotTaskId,
    }).catch((pollErr) => {
      console.warn(`[runtime] slowPoll for ${agentId} crashed:`, pollErr);
    });
    return true;
  }

  async waitForBootstrapSettled(agentId: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.agentStore.get(agentId);
      if (!state) return;
      if (!state.creationToken) return;
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error(`waitForBootstrapSettled(${agentId}) timed out after ${timeoutMs}ms`);
  }

  private async slowPollDialogPending(
    agentId: string,
    creationToken: string | undefined,
    opts: { expectedPaneId?: string; expectedTaskId?: string } = {},
  ): Promise<void> {
    const POLL_INTERVAL_MS = 5_000;

    const cfg = this.getAgentConfig(agentId);
    if (!cfg) return;
    const runner = this.createRunnerFor(cfg);
    const tmux = new TmuxManager(runner);
    const runtime = agentRuntimeKindFor(cfg);

    const generationMismatch = (state: AgentBindingFacts): boolean => {
      if (state.creationToken !== creationToken) return true;
      if (creationToken === undefined) {
        if (opts.expectedPaneId !== undefined && state.paneId !== opts.expectedPaneId) return true;
        if (state.taskId !== opts.expectedTaskId) return true;
      }
      return false;
    };

    while (true) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      const state = await this.agentStore.get(agentId);
      if (!state) return;
      if (generationMismatch(state)) return;
      let paneId: string;
      try {
        paneId = await tmux.getSinglePaneId(agentId);
      } catch {
        continue;
      }

      try {
        await tmux.waitReplReady(paneId, runtime, {
          timeoutMs: 1_000,
          intervalMs: 200,
          scrollback: 0,
        });
      } catch {
        continue;
      }

      const preFresh = await this.agentStore.get(agentId);
      if (!preFresh) return;
      if (generationMismatch(preFresh)) return;
      const now = new Date().toISOString();
      let projectIdForEmit = '';
      let wrote = false;
      const isBootstrapPath = creationToken !== undefined;
      if (isBootstrapPath && !(await this.runGreetingHandshake(agentId, cfg, paneId))) {
        await this.markGreetingFailed(agentId, creationToken);
        return;
      }
      await this.agentStore.update(agentId, (fresh) => {
        if (!fresh) return AGENT_STORE_NOOP;
        if (generationMismatch(fresh)) return AGENT_STORE_NOOP;
        if (fresh.awaitingPhase != null && REGREET_REQUIRED_HOLD_PHASES.has(fresh.awaitingPhase)) {
          return AGENT_STORE_NOOP;
        }
        projectIdForEmit = fresh.projectId;
        wrote = true;
        if (isBootstrapPath) {
          return {
            ...fresh,
            paneId,
            creationToken: undefined,
            status: 'ok',
            awaitingPhase: undefined,
            awaitingReason: undefined,
            awaitingSince: undefined,
            updatedAt: now,
          };
        }
        return {
          ...fresh,
          paneId,
          awaitingPhase: 'agent_dialog_resolved_runtime',
          awaitingReason: 'Runtime dialog resolved; agent REPL ready. Click Resume to release the binding and let baxian pick the next task.',
          updatedAt: now,
        };
      });
      if (!wrote) return;
      if (isBootstrapPath) {
        await this.safeEmit({
          id: '',
          type: 'agent.bootstrap_succeeded',
          timestamp: now,
          projectId: projectIdForEmit,
          agentId,
          data: { paneId, phase: 'session_dialog_resolved' },
        });
      } else {
        await this.safeEmit({
          id: '',
          type: 'human.intervention',
          timestamp: now,
          projectId: projectIdForEmit,
          agentId,
          data: {
            phase: 'agent_dialog_resolved_runtime',
            note: 'Runtime dialog resolved; agent REPL ready. Click Resume to continue.',
          },
        });
      }
      return;
    }
  }

  startRuntimeMenuWatch(agentId: string): void {
    if (this.runtimeMenuWatchers.has(agentId)) return;
    const controller = new AbortController();
    this.runtimeMenuWatchers.set(agentId, controller);
    void this.runtimeMenuWatchLoop(agentId, controller.signal)
      .catch((err) => {
        console.warn(`[runtimeMenuWatch] ${agentId} loop crashed:`, err);
      })
      .finally(() => {
        const current = this.runtimeMenuWatchers.get(agentId);
        if (current === controller) this.runtimeMenuWatchers.delete(agentId);
      });
  }

  stopRuntimeMenuWatch(agentId: string): void {
    const c = this.runtimeMenuWatchers.get(agentId);
    if (c) c.abort();
  }

  private async runtimeMenuWatchLoop(agentId: string, signal: AbortSignal): Promise<void> {
    const cfg = this.getAgentConfig(agentId);
    if (!cfg) return;
    const tmux = new TmuxManager(this.createRunnerFor(cfg));
    let pendingMenu = false;

    while (!signal.aborted) {
      await this.sleep(this.runtimeMenuPollIntervalMs, signal);
      if (signal.aborted) return;

      const state = await this.agentStore.get(agentId);
      if (!state) return;
      if (!state.taskId) {
        return;
      }
      if (!state.paneId) continue;

      let stripped: string;
      try {
        stripped = await tmux.capturePaneById(state.paneId, { ansi: false, scrollback: 0 });
      } catch {
        continue;
      }

      const fresh = await this.agentStore.get(agentId);
      if (!fresh) return;
      if (!fresh.taskId) {
        return;
      }
      if (
        fresh.taskId !== state.taskId ||
        fresh.paneId !== state.paneId
      ) {
        continue;
      }

      const onMenu = detectRuntimeMenu(stripped);
      if (onMenu && !pendingMenu) {
        pendingMenu = true;
        const now = new Date().toISOString();
        await this.safeEmit({
          id: '',
          type: 'human.intervention',
          timestamp: now,
          projectId: fresh.projectId,
          agentId,
          taskId: fresh.taskId,
          data: {
            phase: 'agent_runtime_menu_pending',
            note: 'Agent paused on an interactive menu mid-task. Attach via web terminal and respond; baxian will auto-clear once the menu closes.',
          },
        });
      } else if (!onMenu && pendingMenu) {
        pendingMenu = false;
      }
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async adoptOrRestartSession(
    tmux: TmuxManager,
    agent: AgentConfig & { projectId: string },
    agentId: string,
    workdir: string,
  ): Promise<EnsureSessionResult> {
    let claim: string | null;
    try {
      claim = await tmux.getOption(agentId, '@baxian-agent-id');
    } catch (err) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `getOption(@baxian-agent-id) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (claim !== agentId) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `tmux session "${agentId}" exists but @baxian-agent-id session claim mismatch ` +
          `(got "${claim ?? 'null'}"); baxian will not adopt foreign session — operator must intervene`,
      );
    }
    try {
      await this.pinRuntimeSessionOptions(tmux, agentId);
    } catch (err) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `pinRuntimeSessionOptions failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let paneId: string;
    try {
      paneId = await tmux.getSinglePaneId(agentId);
    } catch (err) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `getSinglePaneId failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const runtime = agentRuntimeKindFor(agent);
    let state: AdoptPaneState;
    try {
      state = await tmux.classifyPaneForAdopt(paneId, runtime);
    } catch (err) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `classifyPaneForAdopt failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    switch (state.kind) {
      case 'live-runtime': {
        let stale: boolean;
        try {
          stale = await this.replSkillsStale(tmux, agentId);
        } catch (err) {
          throw new EnsureSessionError(
            { createdSession: false, agentId },
            `skills-version probe failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (stale) {
          await tmux.killSession(agentId).catch(() => {});
          return this.buildFreshSession(tmux, agent, agentId, workdir);
        }
        return { ok: true, createdSession: false, freshRuntime: false, paneId, workdir };
      }
      case 'startup-dialog':
        throw new EnsureSessionError(
          {
            createdSession: false,
            agentId,
            dialogPending: true,
            lastScreen: state.lastScreen,
          },
          `adoptOrRestartSession: REPL blocked on startup dialog`,
        );
      case 'other':
        throw new EnsureSessionError(
          { createdSession: false, agentId },
          `pane foreground "${state.paneCurrentCommand}" is neither runtime ` +
            `(${runtime}) nor shell; refusing to send launch keys — operator ` +
            `must reset the pane manually`,
        );
      case 'trust-dialog':
        try {
          await tmux.handleTrustDialog(paneId, runtime, {
            timeoutMs: this.bootstrapTimeoutsMs.trustDialog,
          });
          await tmux.waitReplReady(paneId, runtime, {
            timeoutMs: this.bootstrapTimeoutsMs.waitReplReady,
            scrollback: 0,
          });
          await this.tagSessionSkillsVersion(tmux, agentId);
          return { ok: true, createdSession: false, freshRuntime: true, paneId, workdir };
        } catch (trustErr) {
          if (trustErr instanceof ReplNotReadyError && detectStartupDialog(trustErr.lastScreen, runtime)) {
            throw new EnsureSessionError(
              {
                createdSession: false,
                agentId,
                dialogPending: true,
                lastScreen: trustErr.lastScreen,
              },
              `adoptOrRestartSession: REPL blocked on startup dialog after trust auto-answer`,
            );
          }
          throw new EnsureSessionError(
            { createdSession: false, agentId },
            `adoptOrRestartSession: trust dialog handling failed: ` +
              `${trustErr instanceof Error ? trustErr.message : String(trustErr)}`,
          );
        }
      case 'shell':
        break;
    }
    try {
      await tmux.sendKeysToPane(paneId, `${buildLaunchCommand(agent)}\n`);
      await tmux.handleTrustDialog(paneId, runtime, {
        timeoutMs: this.bootstrapTimeoutsMs.trustDialog,
      });
      await tmux.waitReplReady(paneId, runtime, {
        timeoutMs: this.bootstrapTimeoutsMs.waitReplReady,
        scrollback: 0,
      });
      await this.tagSessionSkillsVersion(tmux, agentId);
      return { ok: true, createdSession: false, freshRuntime: true, paneId, workdir };
    } catch (relErr) {
      if (relErr instanceof ReplNotReadyError && detectStartupDialog(relErr.lastScreen, runtime)) {
        throw new EnsureSessionError(
          {
            createdSession: false,
            agentId,
            dialogPending: true,
            lastScreen: relErr.lastScreen,
          },
          `adoptOrRestartSession: REPL relaunch blocked on startup dialog`,
        );
      }
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `REPL relaunch failed: ${relErr instanceof Error ? relErr.message : String(relErr)}`,
      );
    }
  }

  async acquireAgentForTask(
    agentId: string,
    taskId: string,
    phase: string,
  ): Promise<boolean> {
    const cfg = this.getAgentConfig(agentId);
    if (!cfg) throw new Error(`Unknown agent: ${agentId}`);
    const state = await this.agentStore.get(agentId);
    const sameTaskLocked = state?.taskId === taskId && (await this.lockManager.isLocked(agentId));
    const reentryPhases = new Set([
      'fix', 'post-approve', 'code',
      'server-feedback', 'server-after-done',
    ]);
    const sameTaskReentry =
      state?.taskId === taskId &&
      !state.creationToken &&
      state.status !== 'awaiting_human' &&
      reentryPhases.has(phase);
    const reuseLock = sameTaskLocked && reentryPhases.has(phase);
    if (!sameTaskReentry && !canDispatchWithBinding(state)) {
      return false;
    }
    if (!reuseLock) {
      const ok = await this.lockManager.acquire(agentId, taskId);
      if (!ok) return false;
    }
    const now = new Date().toISOString();
    await this.agentStore.update(agentId, (existing) => ({
      ...(existing ?? { id: agentId, projectId: cfg.projectId, updatedAt: now }),
      id: agentId,
      projectId: cfg.projectId,
      taskId,
      updatedAt: now,
    }));
    return true;
  }

  async releaseAgentForTask(
    agentId: string,
    expectedTaskId: string,
    mode: 'waiting' | 'idle',
    opts: { allowAwaitingHuman?: boolean; clearAwaitingHuman?: boolean; fromCancelCleanup?: boolean } = {},
  ): Promise<boolean> {
    return this.withTaskLock(async () => {
      const state = await this.agentStore.get(agentId);
      if (!state) return false;
      if (state.taskId !== expectedTaskId) {
        console.warn(
          `[AgentManager] releaseAgentForTask: agent ${agentId} taskId mismatch ` +
          `(expected ${expectedTaskId}, got ${state.taskId}); skipping`,
        );
        return false;
      }
      if (isCancelCleanupHold(state) && !opts.fromCancelCleanup) {
        console.warn(
          `[AgentManager] releaseAgentForTask: agent ${agentId} ${state.awaitingPhase} (cancel-cleanup hold); refusing auto-release`,
        );
        return false;
      }
      const boundTask = await this.taskStore.get(expectedTaskId);
      if (state.status === 'awaiting_human' && !opts.allowAwaitingHuman) {
        if (!shouldReleaseHeldBinding(state, boundTask)) {
          console.warn(
            `[AgentManager] releaseAgentForTask: agent ${agentId} is awaiting_human (${state.awaitingPhase}); refusing to release`,
          );
          return false;
        }
      }
      if (mode === 'waiting' && (!boundTask || !ACTIVE_TASK_STATUSES.has(boundTask.status))) {
        console.warn(
          `[AgentManager] releaseAgentForTask: task ${expectedTaskId} is not active; skipping waiting transition`,
        );
        return false;
      }
      const cfg = this.getAgentConfig(agentId);
      if (!cfg) return false;

      const now = new Date().toISOString();

      if (mode === 'waiting') {
        await this.agentStore.update(agentId, (latest) => {
          if (!latest) return AGENT_STORE_NOOP;
          if (opts.clearAwaitingHuman && latest.status === 'awaiting_human') {
            const cleared: AgentBindingFacts = {
              id: latest.id,
              projectId: latest.projectId,
              updatedAt: now,
              ...(latest.taskId !== undefined ? { taskId: latest.taskId } : {}),
              ...(latest.paneId !== undefined ? { paneId: latest.paneId } : {}),
              ...(latest.repoPath !== undefined ? { repoPath: latest.repoPath } : {}),
              ...(latest.worktreePath !== undefined ? { worktreePath: latest.worktreePath } : {}),
              ...(latest.startedAt !== undefined ? { startedAt: latest.startedAt } : {}),
              ...(latest.creationToken !== undefined ? { creationToken: latest.creationToken } : {}),
            };
            return cleared;
          }
          return {
            ...latest,
            updatedAt: now,
          };
        });
        return true;
      }

      if (state.worktreePath) {
        const cleanupDir = this.resolveWorkdir(cfg, state);
        if (cleanupDir) {
          const runner = this.createRunnerFor(cfg);
          const worktree = new WorktreeManager(runner);
          try {
            await worktree.remove(cleanupDir, state.worktreePath);
          } catch (err) {
            console.warn(
              `[AgentManager] releaseAgentForTask worktree.remove failed for ${state.worktreePath}:`,
              err,
            );
          }
        }
      }
      await this.agentStore.update(agentId, (existing) => {
        if (!existing) return AGENT_STORE_NOOP;
        if (existing.taskId !== expectedTaskId) return AGENT_STORE_NOOP;
        return {
          id: existing.id,
          projectId: existing.projectId,
          ...(existing.repoPath !== undefined ? { repoPath: existing.repoPath } : {}),
          ...(existing.paneId !== undefined ? { paneId: existing.paneId } : {}),
          ...(existing.creationToken !== undefined ? { creationToken: existing.creationToken } : {}),
          updatedAt: now,
        };
      });
      await this.lockManager.release(agentId);
      return true;
    });
  }

  async clearAwaitingHuman(agentId: string): Promise<boolean> {
    const now = new Date().toISOString();
    let cleared = false;
    await this.agentStore.update(agentId, (latest) => {
      if (!latest || latest.status !== 'awaiting_human') return AGENT_STORE_NOOP;
      cleared = true;
      const {
        status: _status,
        awaitingPhase: _awaitingPhase,
        awaitingReason: _awaitingReason,
        awaitingSince: _awaitingSince,
        ...readyState
      } = latest;
      return {
        ...readyState,
        updatedAt: now,
      };
    });
    return cleared;
  }

  async markAwaitingHuman(
    agentId: string,
    phase: string,
    reason: string,
    opts: { expectedCreationToken?: string | null; expectedTaskId?: string | null } = {},
  ): Promise<void> {
    const now = new Date().toISOString();
    let projectId = '';
    let taskId: string | undefined;
    let wrote = false;
    await this.agentStore.update(agentId, (existing) => {
      if (!existing) return AGENT_STORE_NOOP;
      if (opts.expectedCreationToken !== undefined) {
        const expected = opts.expectedCreationToken;
        const actual = existing.creationToken ?? null;
        if (actual !== expected) return AGENT_STORE_NOOP;
      }
      if (opts.expectedTaskId !== undefined) {
        const expectedTask = opts.expectedTaskId;
        const actualTask = existing.taskId ?? null;
        if (actualTask !== expectedTask) return AGENT_STORE_NOOP;
      }
      if (isCancelCleanupHold(existing)) {
        if (!CANCEL_CLEANUP_HOLD_PHASES.has(phase)) return AGENT_STORE_NOOP;
        // 同 rank 重标也拦：外层泛化文案会覆盖内层更具体的 reason 并重复发 intervention。
        if (cancelPhaseRank(phase) <= cancelPhaseRank(existing.awaitingPhase)) return AGENT_STORE_NOOP;
      }
      projectId = existing.projectId;
      taskId = existing.taskId;
      wrote = true;
      return {
        ...existing,
        status: 'awaiting_human',
        awaitingPhase: phase,
        awaitingReason: reason,
        awaitingSince: now,
        updatedAt: now,
      };
    });
    if (!wrote) return;
    await this.safeEmit({
      id: '',
      type: 'human.intervention',
      timestamp: now,
      projectId,
      agentId,
      ...(taskId ? { taskId } : {}),
      data: {
        phase,
        reason,
      },
    });
  }

  private async markAwaitingIfAckUnknown(
    agentId: string,
    err: unknown,
    expectedTaskId: string,
  ): Promise<boolean> {
    if (err instanceof DispatchTerminalError && err.reason === 'ack_unknown') {
      await this.markAwaitingHuman(
        agentId,
        `dispatch-failed:${err.reason}`,
        `${err.message}. Prompt may still be running in the pane; verify before resuming.`,
        { expectedTaskId },
      );
      return true;
    }
    return false;
  }

  async resumeAgent(agentId: string): Promise<{ resumed: boolean; releasedBinding: boolean; reason?: string }> {
    const result = await this.withTaskLock(async (): Promise<{
      resumed: boolean;
      releasedBinding: boolean;
      redispatchCodeTaskId?: string;
      reason?: string;
    }> => {
      const state = await this.agentStore.get(agentId);
      if (!state) return { resumed: false, releasedBinding: false, reason: 'Agent state not found.' };
      if (state.status !== 'awaiting_human') {
        return { resumed: false, releasedBinding: false, reason: 'Agent is not awaiting human; nothing to resume.' };
      }
      if (state.taskId && this.cancelCleanupInFlight.has(state.taskId)) {
        const reason = `Cancel cleanup for task ${state.taskId} is still in progress; it settles within seconds — Resume again if the hold remains.`;
        console.warn(`[AgentManager] resumeAgent: agent ${agentId} — ${reason}`);
        return { resumed: false, releasedBinding: false, reason };
      }
      if (state.creationToken) {
        const reason = 'Bootstrap dialog still unresolved; resolve it via the web terminal or DELETE the agent.';
        console.warn(`[AgentManager] resumeAgent: agent ${agentId} still has creationToken — ${reason}`);
        return { resumed: false, releasedBinding: false, reason };
      }
      const boundTask = state.taskId ? await this.taskStore.get(state.taskId) : null;
      const PROMPT_MAYBE_RUNNING_PHASES = new Set([
        'dispatch-failed:ack_unknown',
        'dev-wait-gate-failed-after-qa-started',
      ]);
      if (
        state.awaitingPhase != null
        && PROMPT_MAYBE_RUNNING_PHASES.has(state.awaitingPhase)
        && boundTask && ACTIVE_TASK_STATUSES.has(boundTask.status)
      ) {
        const reason = `Prompt may still be running (${state.awaitingPhase}); Resume is blocked until the task outcome arrives. Cancel task ${state.taskId} or DELETE the agent to recover.`;
        console.warn(`[AgentManager] resumeAgent: agent ${agentId} — ${reason}`);
        return { resumed: false, releasedBinding: false, reason };
      }
      if (state.awaitingPhase === 'agent_dialog_pending') {
        const reason = 'Startup dialog still pending; Resume cannot dismiss it. Dismiss the dialog via the web terminal (baxian will auto-resume) or DELETE the agent.';
        console.warn(`[AgentManager] resumeAgent: agent ${agentId} — ${reason}`);
        return { resumed: false, releasedBinding: false, reason };
      }
      if (
        state.awaitingPhase === 'agent_dialog_resolved_runtime'
        && boundTask && ACTIVE_TASK_STATUSES.has(boundTask.status)
      ) {
        const reason = `Dialog resolved but task ${state.taskId} is still active and its prompt was never injected; Resume would strand it. Cancel the task or DELETE the agent.`;
        console.warn(`[AgentManager] resumeAgent: agent ${agentId} — ${reason}`);
        return { resumed: false, releasedBinding: false, reason };
      }
      if (
        state.awaitingPhase === 'code-dispatch-failed'
        && boundTask && ACTIVE_TASK_STATUSES.has(boundTask.status)
        && state.taskId
      ) {
        const now2 = new Date().toISOString();
        await this.agentStore.update(agentId, (existing) => {
          if (!existing) return AGENT_STORE_NOOP;
          return {
            ...existing,
            status: 'ok',
            awaitingPhase: undefined,
            awaitingReason: undefined,
            awaitingSince: undefined,
            updatedAt: now2,
          };
        });
        return { resumed: true, releasedBinding: false, redispatchCodeTaskId: state.taskId };
      }
      if (
        state.awaitingPhase?.startsWith('signal-arm-failed')
        && boundTask && ACTIVE_TASK_STATUSES.has(boundTask.status)
      ) {
        const reason = `The dispatched prompt's pane signal has no consumer and Resume cannot rebuild the watcher; cancel task ${state.taskId} or DELETE the agent to retry.`;
        console.warn(`[AgentManager] resumeAgent: agent ${agentId} ${state.awaitingPhase} — ${reason}`);
        return { resumed: false, releasedBinding: false, reason };
      }
      if (state.awaitingPhase != null && REGREET_REQUIRED_HOLD_PHASES.has(state.awaitingPhase)) {
        const reason = 'Greeting capability check failed; the runtime must re-prove it. Resume cannot clear this hold — use Restart REPL to re-run the greeting check.';
        console.warn(`[AgentManager] resumeAgent: agent ${agentId} ${state.awaitingPhase} — ${reason}`);
        return { resumed: false, releasedBinding: false, reason };
      }
      const now = new Date().toISOString();
      const shouldReleaseBinding = shouldReleaseHeldBinding(state, boundTask);
      const cfg = this.getAgentConfig(agentId);

      if (shouldReleaseBinding && state.worktreePath && cfg) {
        const cleanupDir = this.resolveWorkdir(cfg, state);
        if (cleanupDir) {
          const runner = this.createRunnerFor(cfg);
          const worktree = new WorktreeManager(runner);
          try {
            await worktree.remove(cleanupDir, state.worktreePath);
          } catch (err) {
            console.warn(
              `[AgentManager] resumeAgent worktree.remove failed for ${state.worktreePath}:`,
              err,
            );
          }
        }
      }

      await this.agentStore.update(agentId, (existing) => {
        if (!existing) return AGENT_STORE_NOOP;
        const next: AgentBindingFacts = {
          id: existing.id,
          projectId: existing.projectId,
          updatedAt: now,
          ...(existing.repoPath !== undefined ? { repoPath: existing.repoPath } : {}),
          ...(existing.paneId !== undefined ? { paneId: existing.paneId } : {}),
          ...(existing.creationToken !== undefined ? { creationToken: existing.creationToken } : {}),
          status: 'ok',
        };
        if (!shouldReleaseBinding) {
          if (existing.taskId !== undefined) next.taskId = existing.taskId;
          if (existing.worktreePath !== undefined) next.worktreePath = existing.worktreePath;
          if (existing.startedAt !== undefined) next.startedAt = existing.startedAt;
        }
        return next;
      });
      if (shouldReleaseBinding) {
        await this.lockManager.release(agentId);
      }
      await this.safeEmit({
        id: '',
        type: 'human.intervention',
        timestamp: now,
        projectId: state.projectId,
        agentId,
        ...(state.taskId ? { taskId: state.taskId } : {}),
        data: {
          phase: 'resumed',
          previousPhase: state.awaitingPhase,
          releasedBinding: shouldReleaseBinding,
        },
      });
      return { resumed: true, releasedBinding: shouldReleaseBinding };
    });
    if (result.redispatchCodeTaskId) {
      try {
        const resumed = await this.continueSession(result.redispatchCodeTaskId, agentId, 'code');
        if (!resumed) {
          await this.markAwaitingHuman(
            agentId,
            'code-dispatch-failed',
            'Code-phase redispatch on Resume was not delivered; Resume again to retry or cancel the task.',
            { expectedTaskId: result.redispatchCodeTaskId },
          ).catch(() => undefined);
        }
      } catch (err) {
        console.error(`[AgentManager] resumeAgent code redispatch failed for ${agentId}:`, err);
        await this.markAwaitingHuman(
          agentId,
          'code-dispatch-failed',
          'Code-phase redispatch on Resume failed; Resume again to retry or cancel the task.',
          { expectedTaskId: result.redispatchCodeTaskId },
        ).catch(() => undefined);
      }
    }
    return {
      resumed: result.resumed,
      releasedBinding: result.releasedBinding,
      ...(result.reason ? { reason: result.reason } : {}),
    };
  }

  private async resolvePaneId(
    state: AgentBindingFacts,
    cfg: AgentConfig & { projectId: string },
  ): Promise<string | null> {
    if (state.paneId) return state.paneId;
    try {
      return await new TmuxManager(this.createRunnerFor(cfg)).getSinglePaneId(cfg.id);
    } catch (err) {
      console.warn(`[AgentManager] resolvePaneId: getSinglePaneId failed for ${cfg.id}:`, err);
      return null;
    }
  }

  private async interruptPaneAndWaitReady(
    state: AgentBindingFacts,
    cfg: AgentConfig & { projectId: string },
  ): Promise<boolean> {
    const paneId = await this.resolvePaneId(state, cfg);
    if (!paneId) return false;
    const tmux = new TmuxManager(this.createRunnerFor(cfg));
    const runtime = agentRuntimeKindFor(cfg);
    if (!(await this.acquireCompactGuardWithin(cfg.id, this.cancelInterruptGuardWaitMs))) {
      console.warn(`[AgentManager] interruptPaneAndWaitReady: ${cfg.id} pane mutex still busy after wait; holding`);
      await this.markAwaitingHuman(
        cfg.id,
        'cancel-interrupt-failed',
        'Cancel could not acquire the pane mutex to interrupt (a dispatch/compact/upload held it); the agent ' +
          'may still be running the cancelled prompt. Attach via web terminal to verify, then Resume or Delete.',
        { expectedTaskId: state.taskId },
      );
      return false;
    }
    try {
      try {
        await tmux.sendKeysToPane(paneId, 'Escape');
        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        console.warn(`[AgentManager] interruptPaneAndWaitReady: send Escape failed for pane ${paneId}:`, err);
        return false;
      }
      if (await this.paneReachedReplReady(tmux, paneId, runtime, 10_000)) return true;
      if (!(await this.paneRunsRuntime(tmux, paneId, runtime))) return false;
      if (await this.paneHasLiveTurn(tmux, paneId, runtime)) {
        console.warn(`[AgentManager] interruptPaneAndWaitReady: pane ${paneId} still running a turn after ESC; holding`);
        return false;
      }
      if (!(await this.paneRunsRuntime(tmux, paneId, runtime))) return false;
      try {
        await tmux.sendKeysToPane(paneId, 'C-c');
        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        console.warn(`[AgentManager] interruptPaneAndWaitReady: send C-c (composer clear) failed for pane ${paneId}:`, err);
        return false;
      }
      return this.paneReachedReplReady(tmux, paneId, runtime, this.cleanComposerWaitMs);
    } finally {
      this.compactInFlight.delete(cfg.id);
    }
  }

  private async paneHasLiveTurn(tmux: TmuxManager, paneId: string, runtime: AgentRuntimeKind): Promise<boolean> {
    let first: string;
    let firstTitle: string;
    try {
      first = await tmux.capturePaneById(paneId, { ansi: false, scrollback: 0 });
      firstTitle = await tmux.readPaneTitle(paneId);
    } catch (err) {
      console.warn(`[AgentManager] interruptPaneAndWaitReady: liveness capture failed for pane ${paneId}:`, err);
      return true;
    }
    for (let i = 1; i < RUNTIME_LIVENESS_SAMPLES; i++) {
      await new Promise(r => setTimeout(r, this.runtimeLivenessProbeMs));
      let frame: string;
      let title: string;
      try {
        frame = await tmux.capturePaneById(paneId, { ansi: false, scrollback: 0 });
        title = await tmux.readPaneTitle(paneId);
      } catch (err) {
        console.warn(`[AgentManager] interruptPaneAndWaitReady: liveness re-capture failed for pane ${paneId}:`, err);
        return true;
      }
      if (title !== firstTitle && hasOscTitleWorking(title)) return true;
      if (hasRuntimeReadyView(frame, runtime)) return false;
      if (frame !== first) return true;
    }
    return false;
  }

  private async paneRunsRuntime(tmux: TmuxManager, paneId: string, runtime: AgentRuntimeKind): Promise<boolean> {
    let proc: string;
    try {
      proc = await tmux.displayMessage(paneId, '#{pane_current_command}');
    } catch (err) {
      console.warn(`[AgentManager] interruptPaneAndWaitReady: proc-title read failed for pane ${paneId}:`, err);
      return false;
    }
    if (!hasReplProcTitle(proc, runtime)) {
      console.warn(`[AgentManager] interruptPaneAndWaitReady: pane ${paneId} not running ${runtime} (got ${proc.trim()}); holding`);
      return false;
    }
    return true;
  }

  private async paneReachedReplReady(
    tmux: TmuxManager,
    paneId: string,
    runtime: AgentRuntimeKind,
    timeoutMs: number,
  ): Promise<boolean> {
    try {
      await tmux.waitReplReady(paneId, runtime, { timeoutMs, scrollback: 0 });
      return true;
    } catch (err) {
      console.warn(
        `[AgentManager] interruptPaneAndWaitReady: waitReplReady failed for pane ${paneId}:`,
        err,
      );
      return false;
    }
  }

  private async markPaneCancelClearing(agentId: string, taskId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.agentStore.update(agentId, (latest) => {
      if (!latest || latest.taskId !== taskId) return AGENT_STORE_NOOP;
      if (cancelPhaseDowngrades(latest.awaitingPhase, 'cancel-clearing')) return AGENT_STORE_NOOP;
      return {
        ...latest,
        status: 'awaiting_human',
        awaitingPhase: 'cancel-clearing',
        awaitingReason: 'Cancelling: interrupting the runtime session before releasing the agent to idle.',
        awaitingSince: now,
        updatedAt: now,
      };
    });
  }

  private claimCancelCleanup(taskId: string): void {
    this.cancelCleanupInFlight.set(taskId, (this.cancelCleanupInFlight.get(taskId) ?? 0) + 1);
  }

  private releaseCancelCleanup(taskId: string): void {
    const n = this.cancelCleanupInFlight.get(taskId) ?? 0;
    if (n <= 1) this.cancelCleanupInFlight.delete(taskId);
    else this.cancelCleanupInFlight.set(taskId, n - 1);
  }

  async failTaskForDispatchError(
    taskId: string,
    phase: string,
    agentId: string,
    err: DispatchTerminalError,
  ): Promise<void> {
    const expected = PHASE_EXPECTED_STATUS[phase] ?? [];
    const transitioned = await this.transitionTaskStatus(
      taskId,
      'failed',
      { fromStatus: expected.length > 0 ? expected : ['in_progress', 'review', 'fixing', 'approved', 'merge-ready'] },
    );
    if (!transitioned) {
      console.warn(
        `[AgentManager] failTaskForDispatchError: task ${taskId} not in expected ` +
        `fromStatus for phase=${phase}; skipping task transition`,
      );
    }
    await this.recordError({
      agentId,
      projectId: transitioned?.task.projectId ?? '',
      taskId,
      operation: 'dispatch',
      reason: `DISPATCH_${err.reason.toUpperCase()}`,
      message: err.message,
      observation: {
        phase,
        replDrained: err.replDrained,
      },
      recommendation: 'Inspect the runtime pane, then retry or cancel the task.',
    });
    if (err.reason === 'ack_unknown') {
      await this.markAwaitingHuman(
        agentId,
        `dispatch-failed:${err.reason}`,
        `${err.message}. Prompt may still be running in the pane; verify before resuming.`,
        { expectedTaskId: taskId },
      );
      if (transitioned) {
        await this.releasePartnersAndDrain(agentId, [taskId], [transitioned.task.projectId]);
      }
      return;
    }
    try {
      await this.releaseAgentForTask(agentId, taskId, 'idle');
    } catch (releaseErr) {
      console.warn(
        `[AgentManager] failTaskForDispatchError: releaseAgentForTask(${agentId}) failed:`,
        releaseErr,
      );
    }
    await this.safeEmit({
      id: '',
      type: 'human.intervention',
      timestamp: new Date().toISOString(),
      projectId: transitioned?.task.projectId ?? '',
      agentId,
      taskId,
      data: {
        phase: `dispatch-failed:${err.reason}`,
        reason: err.reason,
        message: err.message,
        replDrained: err.replDrained,
      },
    });
  }

  async failTasksForAgent(
    agentId: string,
    reason: string,
    opts: { deferPartnerCleanup?: boolean } = {},
  ): Promise<{ failedTaskIds: string[]; projectIds: string[] }> {
    const failed = await this.withTaskLock(async () => {
      const tasks = await this.taskStore.list({});
      const out: TaskState[] = [];
      for (const t of tasks) {
        const bound = t.agentId === agentId || t.qaAgentId === agentId;
        if (t.status === 'ready' || t.status === 'merge-ready') continue;
        if (ACTIVE_TASK_STATUSES.has(t.status) && bound) {
          t.status = 'failed';
          t.updatedAt = new Date().toISOString();
          await this.taskStore.set(t);
          out.push(t);
        }
      }
      return out;
    });
    for (const t of failed) {
      await this.safeEmit({
        id: '',
        type: 'task.updated',
        timestamp: new Date().toISOString(),
        projectId: t.projectId,
        taskId: t.id,
        data: { status: 'failed', reason },
      });
    }
    const failedTaskIds = failed.map(t => t.id);
    const projectIds = [...new Set(failed.map(t => t.projectId))];
    if (!opts.deferPartnerCleanup) {
      await this.releasePartnersAndDrain(agentId, failedTaskIds, projectIds);
    }
    return { failedTaskIds, projectIds };
  }

  async releasePartnersAndDrain(
    excludeAgentId: string,
    failedTaskIds: string[],
    _projectIds: string[],
  ): Promise<void> {
    for (const taskId of failedTaskIds) {
      const t = await this.taskStore.get(taskId);
      if (!t) continue;
      for (const partnerId of [t.agentId, t.qaAgentId]) {
        if (!partnerId || partnerId === excludeAgentId) continue;
        try {
          const ok = await this.releaseAgentForTask(partnerId, taskId, 'idle', { allowAwaitingHuman: true });
          if (!ok) {
            console.warn(
              `[AgentManager] failTasksForAgent: partner ${partnerId} release returned false ` +
              `for failed task ${taskId}; operator must use restart-repl / retry if cleanup is still needed.`,
            );
          }
        } catch (err) {
          console.warn(
            `[AgentManager] failTasksForAgent: releaseAgentForTask(partner=${partnerId}, task=${taskId}) failed:`,
            err,
          );
        }
      }
    }
  }

  private async pollPaneCommandStable(
    tmux: TmuxManager,
    paneId: string,
    opts: { timeoutMs: number; expectShell?: boolean },
  ): Promise<string> {
    const deadline = Date.now() + opts.timeoutMs;
    const SHELL = /^(?:zsh|bash|sh|fish)$/;
    let last = '';
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
      const raw = await tmux.displayMessage(paneId, '#{pane_current_command}');
      last = raw.trim();
      if (opts.expectShell ? SHELL.test(last) : last !== '') return last;
    }
    return last;
  }

  async restartReplOnly(agentId: string): Promise<void> {
    const cfg = this.getAgentConfig(agentId);
    if (!cfg) throw new Error(`Unknown agent: ${agentId}`);
    const runner = this.createRunnerFor(cfg);
    const tmux = new TmuxManager(runner);

    const alive = await tmux.hasSession(agentId);
    if (!alive) {
      throw new Error(`restart-repl: tmux session ${agentId} does not exist; use retry to rebuild`);
    }
    const claim = await tmux.getOption(agentId, '@baxian-agent-id');
    if (claim !== agentId) {
      throw new Error(
        `restart-repl: session claim mismatch (got "${claim ?? 'null'}"); refusing to touch foreign session`,
      );
    }
    const paneId = await tmux.getSinglePaneId(agentId);
    await tmux.sendKeysToPane(paneId, 'C-c');
    const cmd = await this.pollPaneCommandStable(tmux, paneId, { timeoutMs: 2_000 });
    const RUNTIME = /^(?:claude|codex|node|\d+\.\d+\.\d+)$/;
    const SHELL = /^(?:zsh|bash|sh|fish)$/;
    if (RUNTIME.test(cmd)) {
      await tmux.sendKeysToPane(paneId, 'exit', 'Enter');
      await this.pollPaneCommandStable(tmux, paneId, { timeoutMs: 2_000, expectShell: true });
    } else if (!SHELL.test(cmd)) {
      throw new Error(`restart-repl precondition failed: unexpected pane state "${cmd}"`);
    }

    const project = this.getProjectConfig(cfg.projectId);
    let workdir: string | undefined;
    let provisioned = false;
    if (project) {
      try {
        workdir = (await this.ensureWorkdir(cfg, project, runner)).workdir;
        await this.provisionRepoSkills(runner, cfg, workdir);
        provisioned = true;
      } catch (err) {
        console.warn(`[restart-repl] skill re-provision failed for ${agentId} (continuing):`, err);
      }
    }

    const runtime = agentRuntimeKindFor(cfg);
    const relaunch = async (): Promise<void> => {
      await tmux.sendKeysToPane(paneId, `${buildLaunchCommand(cfg)}\n`);
      await tmux.handleTrustDialog(paneId, runtime, {
        timeoutMs: this.bootstrapTimeoutsMs.trustDialog,
      });
      await tmux.waitReplReady(paneId, runtime, {
        timeoutMs: this.bootstrapTimeoutsMs.waitReplReady,
        scrollback: 0,
      });
      if (provisioned) {
        await this.tagSessionSkillsVersion(tmux, agentId);
      }
    };
    if (workdir !== undefined) {
      await this.runUnderSkillDirLock(this.skillDirLockKey(cfg, workdir), relaunch);
    } else {
      await relaunch();
    }

    await this.agentStore.update(agentId, (state) => {
      if (!state) return AGENT_STORE_NOOP;
      return {
        ...state,
        paneId,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  prepareRemoveTargets(agentId: string): { targets: string[] } {
    const cfg = this.getAgentConfig(agentId);
    if (!cfg) throw new Error(`Unknown agent: ${agentId}`);
    const project = this.getProjectConfig(cfg.projectId);
    if (!project) throw new Error(`Unknown project: ${cfg.projectId}`);

    if (cfg.role === 'qa') return { targets: [agentId] };
    for (const pair of project.agent) {
      if (pair[0]?.id === agentId) {
        const qa = pair[1];
        return { targets: qa ? [agentId, qa.id] : [agentId] };
      }
    }
    return { targets: [agentId] };
  }

  async cleanupRemovedAgentRuntime(targets: string[]): Promise<void> {
    const failures: Array<{ agentId: string; step: string; error: unknown }> = [];

    for (const id of targets) {
      const cfg = this.getAgentConfig(id);
      if (!cfg) continue;
      const runner = this.createRunnerFor(cfg);
      const tmux = new TmuxManager(runner);
      const worktree = new WorktreeManager(runner);

      this.stopRuntimeMenuWatch(id);

      if (this.paneStreamerManager) {
        try {
          await this.paneStreamerManager.destroy(id);
        } catch (err) {
          console.warn(
            `[AgentManager] cleanupRemovedAgentRuntime: paneStreamerManager.destroy(${id}) failed:`,
            err,
          );
        }
      }

      try {
        const alive = await tmux.hasSession(id);
        if (alive) {
          const claim = await tmux.getOption(id, '@baxian-agent-id');
          if (claim === id) {
            await tmux.killSession(id);
          } else {
            console.warn(
              `[AgentManager] cleanupRemovedAgentRuntime: skipping kill for ${id} ` +
              `(claim=${claim ?? 'null'}; not baxian-managed)`,
            );
          }
        }
      } catch (err) {
        failures.push({ agentId: id, step: 'tmux', error: err });
      }

      const state = await this.agentStore.get(id);
      if (state?.worktreePath) {
        const cleanupDir = this.resolveWorkdir(cfg, state);
        if (cleanupDir) {
          try {
            await worktree.remove(cleanupDir, state.worktreePath);
          } catch (err) {
            failures.push({ agentId: id, step: 'worktree.remove', error: err });
          }
        }
      }
    }

    if (failures.length > 0) {
      const summary = failures
        .map(f => `${f.agentId}/${f.step}: ${f.error instanceof Error ? f.error.message : String(f.error)}`)
        .join('; ');
      throw new CleanupFailedError(
        `cleanupRemovedAgentRuntime: ${failures.length} step(s) failed: ${summary}`,
        failures,
      );
    }
  }

  previewPromptBytesForTaskInput(
    projectId: string,
    input: { title: string; description: string; preferredAgentId: string },
  ): number {
    let cfg: AgentConfig & { projectId: string };
    let workdirForEstimate: string | undefined;
    if (input.preferredAgentId === '') {
      cfg = {
        id: '_unassigned_preview',
        runtime: 'claude-code',
        role: 'dev',
        mode: 'local',
        projectId,
      };
      workdirForEstimate = this.longestDevWorkdirInProject(projectId);
    } else {
      const found = this.getAgentConfig(input.preferredAgentId);
      if (!found) throw new Error(`Unknown agent: ${input.preferredAgentId}`);
      if (found.projectId !== projectId) {
        throw new Error(`Agent ${input.preferredAgentId} not in project ${projectId}`);
      }
      cfg = found;
      workdirForEstimate = cfg.workdir;
    }
    const workdirGuess = workdirForEstimate ?? '/'.padEnd(64, 'x');
    const worktreePathBound = `${workdirGuess}/.baxian-worktrees/task-9999999999_ffffffffffffffff`;
    const now = new Date().toISOString();
    const fakeTask: TaskState = {
      id: 'task-9999999999',
      projectId,
      title: input.title,
      description: input.description,
      preferredAgentId: input.preferredAgentId,
      agentId: cfg.id,
      branch: `${BRANCH_PREFIX}task-9999999999`,
      reviewRound: 0,
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
    };
    const fullPrompt = buildPromptInline({
      task: fakeTask,
      phase: 'develop',
      agent: cfg,
      worktreePath: worktreePathBound,
      skillRegistry: this.skillRegistry,
      signalToken: 'preview-signal-token',
    });
    return Buffer.byteLength(fullPrompt, 'utf8');
  }

  listAgents(): Array<AgentConfig & { projectId: string }> {
    return [...this.agentIndex.values()];
  }

  getProjectConfig(projectId: string): ProjectConfig | undefined {
    return this.config.project.find(p => p.id === projectId);
  }

  getProjectByRepo(repo: string): ProjectConfig | undefined {
    return this.config.project.find(p => repoSlug(p.repo) === repo);
  }

  findQaPartner(devAgentId: string): AgentConfig | undefined {
    for (const project of this.config.project) {
      for (const pair of project.agent) {
        if (pair[0]?.id === devAgentId) {
          return pair[1];
        }
      }
    }
    return undefined;
  }

  private longestDevWorkdirInProject(projectId: string): string | undefined {
    const project = this.getProjectConfig(projectId);
    if (!project) return undefined;
    let longest: string | undefined;
    let longestBytes = -1;
    for (const pair of project.agent) {
      for (const a of pair) {
        if (a.role !== 'dev' || !a.workdir) continue;
        const bytes = Buffer.byteLength(a.workdir, 'utf8');
        if (bytes > longestBytes) {
          longest = a.workdir;
          longestBytes = bytes;
        }
      }
    }
    return longest;
  }

  async getTask(taskId: string): Promise<TaskState | null> {
    return this.taskStore.get(taskId);
  }

  async getAgentState(agentId: string): Promise<AgentBindingFacts | null> {
    return this.agentStore.get(agentId);
  }

  async getPostApproveCompletion(taskId: string): Promise<PostApproveCompletion | null> {
    return this.postApproveStore.get(taskId);
  }

  async setPostApproveCompletion(
    taskId: string,
    value: {
      token: string;
      approvedHeadSha: string;
      redispatchCount?: number;
      pendingRedispatch?: boolean;
    },
  ): Promise<void> {
    await this.withTaskLock(async () => {
      await this.postApproveStore.set(taskId, value);
      if (!this.phaseSignalWatcher) return;
      const task = await this.taskStore.get(taskId);
      if (!task) return;
      await this.phaseSignalWatcher.start({
        taskId,
        projectId: task.projectId,
        agentId: task.agentId,
        expectedKinds: 'pr-merge-ready',
        token: value.token,
      });
    });
  }

  async clearPostApproveCompletion(taskId: string): Promise<void> {
    await this.withTaskLock(async () => {
      await this.postApproveStore.clear(taskId);
      this.phaseSignalWatcher?.stop(taskId);
    });
  }

  async clearPostApproveCompletionIfMatches(taskId: string, token: string): Promise<boolean> {
    return this.withTaskLock(async () => {
      const cleared = await this.postApproveStore.clearIfMatches(taskId, token);
      if (cleared) this.phaseSignalWatcher?.stop(taskId);
      return cleared;
    });
  }

  async setupRecoveredPostApproveSignals(): Promise<void> {
    if (!this.phaseSignalWatcher) return;
    const tasks = await this.taskStore.list({ status: 'approved' });
    for (const task of tasks) {
      const completion = await this.postApproveStore.get(task.id);
      if (!completion) continue;
      try {
        await this.phaseSignalWatcher.start({
          taskId: task.id,
          projectId: task.projectId,
          agentId: task.agentId,
          expectedKinds: 'pr-merge-ready',
          token: completion.token,
          skipSnapshot: false,
          recovered: true,
        });
      } catch (err) {
        console.warn(
          `[AgentManager] setupRecoveredPostApproveSignals: failed to set up task=${task.id}:`,
          err,
        );
      }
    }
  }

  async setupRecoveredSpecSignals(): Promise<void> {
    if (!this.phaseSignalWatcher) return;
    const tasks = await this.taskStore.list();
    for (const task of tasks) {
      if (!task.signalToken) continue;
      const mapped = this.mapTaskStateToExpectedWatcher(task);
      if (!mapped) continue;
      const { expectedKinds, agentId } = mapped;
      const interventionKindLabel: string | undefined =
        task.phase === 'spec' && task.status === 'review' ? 'spec-reviewed'
        : task.phase === 'spec' && task.status === 'fixing' ? 'spec-fixed'
        : task.phase !== 'spec' && task.status === 'review' ? 'pr-approved|pr-changes-requested'
        : task.phase !== 'spec' && task.status === 'fixing' ? 'pr-fixed'
        : undefined;
      const isServerProtocol = task.reviewMode === 'server' || task.phase === 'spec';
      const scanSnapshotOnRecover = isServerProtocol
        || (task.phase === undefined && task.status === 'in_progress')
        || (task.phase !== 'spec' && (task.status === 'review' || task.status === 'fixing'));
      try {
        await this.phaseSignalWatcher.start({
          taskId: task.id,
          projectId: task.projectId,
          agentId,
          expectedKinds,
          token: task.signalToken,
          skipSnapshot: !scanSnapshotOnRecover,
          recovered: true,
          ...(isServerProtocol && task.status === 'review'
            ? { onReadFile: (req: ReadFileSignal) => { void this.handleReadFileRequest(task.id, agentId, req); } }
            : {}),
        });
        if (interventionKindLabel) {
          await this.safeEmit({
            id: '',
            type: 'human.intervention',
            timestamp: new Date().toISOString(),
            projectId: task.projectId,
            agentId,
            taskId: task.id,
            data: {
              phase: 'spec-signal-setup-during-recovery',
              kind: interventionKindLabel,
              note: 'Task is waiting for a spec signal after server recovery; if no signal arrives, the prompt may not have been fully delivered before the previous crash. Inspect the agent pane and consider manual retry or transition.',
            },
          });
        }
      } catch (err) {
        console.warn(
          `[AgentManager] setupRecoveredSpecSignals: failed to set up task=${task.id} kinds=${expectedKinds.join(',')}:`,
          err,
        );
      }
    }
  }

  async prHasDevReplySince(taskId: string, sinceIso: string): Promise<boolean> {
    const task = await this.taskStore.get(taskId);
    if (!task?.prNumber) return false;
    const project = this.getProjectConfig(task.projectId);
    if (!project) return false;
    const since = Date.parse(sinceIso);
    if (Number.isNaN(since)) return false;
    const repo = repoSlug(project.repo);
    const [inlineReplies, issueComments, reviews] = await Promise.all([
      this.ghCreatedAt(
        `repos/${repo}/pulls/${task.prNumber}/comments`,
        '.[] | select(.in_reply_to_id != null) | .created_at',
      ),
      this.ghCreatedAt(
        `repos/${repo}/issues/${task.prNumber}/comments`,
        '.[].created_at',
      ),
      this.ghCreatedAt(
        `repos/${repo}/pulls/${task.prNumber}/reviews`,
        '.[] | select(.submitted_at != null) | .submitted_at',
      ),
    ]);
    const stamps = [...inlineReplies, ...issueComments, ...reviews];
    return stamps.some(ts => {
      const t = Date.parse(ts);
      return !Number.isNaN(t) && t > since;
    });
  }

  private async ghCreatedAt(endpoint: string, jq: string): Promise<string[]> {
    const result = await this.platformRunner.exec(
      `gh api --paginate ${shellQuote(endpoint)} --jq ${shellQuote(jq)}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`gh api ${endpoint} failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  }

  async fetchPrHeadSha(taskId: string): Promise<string> {
    const task = await this.taskStore.get(taskId);
    if (!task || !task.prNumber) {
      throw new Error(`fetchPrHeadSha: no PR number for task ${taskId}`);
    }
    const project = this.getProjectConfig(task.projectId);
    if (!project) {
      throw new Error(`fetchPrHeadSha: unknown project ${task.projectId}`);
    }
    const result = await this.platformRunner.exec(
      `gh pr view ${task.prNumber} --repo ${shellQuote(repoSlug(project.repo))} --json headRefOid --jq .headRefOid`,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `gh pr view failed for PR #${task.prNumber}: ${result.stderr || result.stdout}`,
      );
    }
    const headSha = result.stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(headSha)) {
      throw new Error(`gh pr view returned invalid headRefOid for PR #${task.prNumber}`);
    }
    return headSha;
  }

  async verifyPaneSignalPrNumber(
    taskId: string,
    prNumber: number,
  ): Promise<{ headRefName: string; headSha: string } | undefined> {
    const task = await this.taskStore.get(taskId);
    if (!task || !task.branch) return undefined;
    const project = this.getProjectConfig(task.projectId);
    if (!project) return undefined;
    const result = await this.platformRunner.exec(
      `gh pr view ${prNumber} --repo ${shellQuote(repoSlug(project.repo))} --json headRefName,headRefOid --jq '.headRefName + "\\t" + .headRefOid'`,
    );
    if (result.exitCode !== 0) return undefined;
    const [headRefName, headSha] = result.stdout.trim().split('\t');
    if (!headRefName || !/^[0-9a-f]{40}$/i.test(headSha)) return undefined;
    if (headRefName !== task.branch) return undefined;
    return { headRefName, headSha };
  }

  async fetchPrHeadRef(
    prNumber: number,
    projectId: string,
  ): Promise<{ headRefName: string; headSha: string; body: string } | undefined> {
    const project = this.getProjectConfig(projectId);
    if (!project) return undefined;
    const result = await this.platformRunner.exec(
      `gh pr view ${prNumber} --repo ${shellQuote(repoSlug(project.repo))} --json headRefName,headRefOid,body,state,isCrossRepository --jq '.headRefName + "\\t" + .headRefOid + "\\t" + .state + "\\t" + (.isCrossRepository | tostring) + "\\t" + .body'`,
    );
    if (result.exitCode !== 0) {
      const stderr = result.stderr ?? '';
      if (stderr.includes('Could not resolve to a PullRequest')) return undefined;
      throw new Error(`gh pr view exited ${result.exitCode} for PR #${prNumber}: ${stderr.slice(0, 200)}`);
    }
    const parts = result.stdout.trim().split('\t');
    const [headRefName, headSha, state, isCross] = parts;
    const body = parts.slice(4).join('\t');
    if (!headRefName || !/^[0-9a-f]{40}$/i.test(headSha)) return undefined;
    if (state !== 'OPEN') return undefined;
    if (isCross === 'true') return undefined;
    return { headRefName, headSha, body };
  }

  async listTasksByProject(projectId: string): Promise<TaskState[]> {
    return this.taskStore.list({ projectId });
  }

  async findTaskByBranch(branch: string, projectId: string): Promise<TaskState | undefined> {
    const all = await this.taskStore.list({ projectId });
    return all.find(t => t.branch === branch);
  }

  async listTasksByPrNumber(prNumber: number, projectId?: string): Promise<TaskState[]> {
    const all = await this.taskStore.list({ projectId });
    return all.filter(t => t.prNumber === prNumber);
  }

  async updateTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
    const task = await this.taskStore.get(taskId);
    if (!task) return;
    task.status = status;
    task.updatedAt = new Date().toISOString();
    await this.taskStore.set(task);
  }

  async updateTask(taskId: string, updates: Partial<TaskState>): Promise<void> {
    await this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task) return;
      Object.assign(task, updates, { updatedAt: new Date().toISOString() });
      await this.taskStore.set(task);
    });
  }

  async transitionTaskStatus(
    taskId: string,
    toStatus: TaskStatus,
    guard: { fromStatus: TaskStatus[] },
    patch?: Partial<Pick<
      TaskState,
      | 'reviewRound'
      | 'prNumber'
      | 'prUrl'
      | 'qaAgentId'
      | 'latestHeadSha'
      | 'reviewHeadAnchorSha'
      | 'reviewDispatchedAt'
      | 'fixDispatchedAt'
      | 'specReviewRound'
      | 'signalToken'
      | 'phase'
      | 'batchIndex'
      | 'batchTotal'
      | 'branch'
    >>,
  ): Promise<TransitionResult | null> {
    return this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task) return null;
      const previousStatus = task.status;
      if (TERMINAL_STATUSES.includes(previousStatus)) return null;
      if (!guard.fromStatus.includes(previousStatus)) return null;
      if (patch?.branch && patch.branch !== task.branch) {
        const existing = await this.findTaskByBranch(patch.branch, task.projectId);
        if (existing && existing.id !== taskId) return null;
      }
      Object.assign(task, patch ?? {}, {
        status: toStatus,
        updatedAt: new Date().toISOString(),
      });
      await this.taskStore.set(task);
      return { task, previousStatus };
    });
  }

  async bumpReviewRoundIfStillAt(taskId: string, expectedRound: number): Promise<void> {
    await this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task || TERMINAL_STATUSES.includes(task.status)) return;
      if ((task.reviewRound ?? 0) !== expectedRound) return;
      task.reviewRound = expectedRound + 1;
      task.updatedAt = new Date().toISOString();
      await this.taskStore.set(task);
    });
  }

  private createRunnerFor(agent: AgentConfig): CommandRunner {
    if (this.runnerFactory) {
      return this.runnerFactory(agent);
    }
    return createRunner(agent.mode, resolveAgentHost(this.config.host, agent.host));
  }

  private createRepoStore(agent: AgentConfig, project: ProjectConfig, runner: CommandRunner): RepoStore {
    const host = resolveAgentHost(this.config.host, agent.host);
    if (this.repoStoreFactory) {
      return this.repoStoreFactory(runner, repoSlug(project.repo), agent.mode, host, this.repoCache);
    }
    return new RepoStore(runner, project.repo, agent.mode, host, this.repoCache);
  }

  private async ensureWorkdir(
    agent: AgentConfig,
    project: ProjectConfig,
    runner: CommandRunner,
  ): Promise<{ workdir: string; repoStore: RepoStore | null }> {
    if (agent.workdir) return { workdir: agent.workdir, repoStore: null };
    const repoStore = this.createRepoStore(agent, project, runner);
    const workdir = await repoStore.ensure();
    return { workdir, repoStore };
  }

  private resolveWorkdir(agent: AgentConfig, agentState: AgentBindingFacts | null): string | null {
    if (agent.workdir) return agent.workdir;
    return agentState?.repoPath ?? null;
  }

  private async resolveAutoBaseRef(runner: CommandRunner, workdir: string): Promise<string | undefined> {
    const result = await runner.exec(
      `git -C ${shellQuote(workdir)} rev-parse --verify --quiet origin/HEAD`,
    );
    return result.exitCode === 0 ? 'origin/HEAD' : undefined;
  }

  getRepoCache(): RepoStoreCache {
    return this.repoCache;
  }

  private async rollbackFailedDispatch(taskId: string, agentId: string): Promise<void> {
    await this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task) return;
      if (task.status !== 'in_progress') return;
      task.agentId = '';
      task.status = 'pending';
      task.updatedAt = new Date().toISOString();
      await this.taskStore.set(task);
    });

    const existing = await this.agentStore.get(agentId);
    if (existing && existing.taskId !== taskId) {
      console.warn(
        `[AgentManager] rollback: agent ${agentId} taskId mismatch (expected ${taskId}, got ${existing.taskId}); ` +
        `skipping agent cleanup — agent already reassigned`,
      );
      return;
    }
    if (isCancelCleanupHold(existing)) {
      console.warn(
        `[AgentManager] rollback: agent ${agentId} held by cancel cleanup (${existing?.awaitingPhase}); ` +
        `leaving binding to the owner`,
      );
      return;
    }

    const projectId = existing?.projectId ?? this.getAgentConfig(agentId)?.projectId;
    if (!projectId) {
      console.error(
        `[AgentManager] CRITICAL: cannot resolve projectId for agent ${agentId} during rollback; deleting agent state.`,
      );
      await this.agentStore.delete(agentId);
    } else {
      const now = new Date().toISOString();
      await this.agentStore.update(agentId, (latest) => ({
        ...(latest ?? existing ?? { id: agentId, projectId, updatedAt: now }),
        id: agentId,
        projectId,
        taskId: undefined,
        worktreePath: undefined,
        updatedAt: now,
      }));
    }
    await this.lockManager.release(agentId);
  }

  async pickAgent(
    projectId: string,
    preferredAgentId: string,
  ): Promise<AgentConfig | null> {
    const cfg = this.getAgentConfig(preferredAgentId);
    if (!cfg) throw new ApiError(400, `Unknown agent: ${preferredAgentId}`);
    if (cfg.projectId !== projectId) {
      throw new ApiError(400, `Agent ${preferredAgentId} not in project ${projectId}`);
    }
    if (cfg.role !== 'dev') {
      throw new ApiError(400, `Agent ${preferredAgentId} is not dev role`);
    }
    const state = await this.agentStore.get(preferredAgentId);
    if (!canDispatchWithBinding(state)) return null;
    const { projectId: _projectId, ...rest } = cfg;
    return rest;
  }

  async createTask(
    projectId: string,
    input: {
      title: string;
      description: string;
      preferredAgentId: string;
      branch?: string;
      images?: { bytes: Buffer; ext: string }[];
    },
  ): Promise<TaskState> {
    return this.withTaskLock(async () => {
      const taskId = await this.taskStore.nextId();
      const now = new Date().toISOString();
      if (input.branch) {
        if (input.branch.startsWith(BRANCH_PREFIX)) {
          throw new ApiError(400, `Custom branch must not start with reserved prefix "${BRANCH_PREFIX}"`);
        }
        if (!isValidBranchName(input.branch)) {
          throw new ApiError(400, `Invalid branch name: "${input.branch}"`);
        }
      }
      const taskBranch = input.branch ?? BRANCH_PREFIX + taskId;

      if (input.branch) {
        const existing = await this.findTaskByBranch(input.branch, projectId);
        if (existing) {
          throw new ApiError(400, `Branch "${input.branch}" is already bound to task ${existing.id}`);
        }
      }

      const imageFilenames = input.images?.length
        ? await this.persistTaskImages(taskId, input.images)
        : undefined;

      if (input.preferredAgentId === '') {
        const unassigned: TaskState = {
          id: taskId,
          projectId,
          title: input.title,
          description: input.description,
          preferredAgentId: '',
          agentId: '',
          reviewRound: 0,
          status: 'pending',
          branch: taskBranch,
          reviewMode: this.effectiveReviewMode(projectId),
          createdAt: now,
          updatedAt: now,
          ...(imageFilenames ? { images: imageFilenames } : {}),
        };
        await this.taskStore.set(unassigned);
        await this.safeEmit({
          id: '',
          type: 'task.created',
          timestamp: now,
          projectId,
          taskId,
          data: { queued: true, queueReason: 'unassigned' },
        });
        return unassigned;
      }

      const dev = await this.pickAgent(projectId, input.preferredAgentId);
      const qa = this.findQaPartner(input.preferredAgentId);

      if (!dev) {
        const queued: TaskState = {
          id: taskId,
          projectId,
          title: input.title,
          description: input.description,
          preferredAgentId: input.preferredAgentId,
          agentId: '',
          reviewRound: 0,
          status: 'pending',
          branch: taskBranch,
          reviewMode: this.effectiveReviewMode(projectId),
          createdAt: now,
          updatedAt: now,
          ...(qa ? { qaAgentId: qa.id } : {}),
          ...(imageFilenames ? { images: imageFilenames } : {}),
        };
        await this.taskStore.set(queued);
        await this.safeEmit({
          id: '',
          type: 'task.created',
          timestamp: now,
          projectId,
          taskId,
          data: {
            queued: true,
            queueReason: 'preferred_agent_busy',
            agentId: input.preferredAgentId,
          },
        });
        return queued;
      }

      const acquired = await this.lockManager.acquire(dev.id, taskId);
      if (!acquired) {
        const queued: TaskState = {
          id: taskId,
          projectId,
          title: input.title,
          description: input.description,
          preferredAgentId: input.preferredAgentId,
          agentId: '',
          reviewRound: 0,
          status: 'pending',
          branch: taskBranch,
          reviewMode: this.effectiveReviewMode(projectId),
          createdAt: now,
          updatedAt: now,
          ...(qa ? { qaAgentId: qa.id } : {}),
          ...(imageFilenames ? { images: imageFilenames } : {}),
        };
        await this.taskStore.set(queued);
        await this.safeEmit({
          id: '',
          type: 'task.created',
          timestamp: now,
          projectId,
          taskId,
          data: {
            queued: true,
            queueReason: 'agent_locked',
            agentId: input.preferredAgentId,
          },
        });
        return queued;
      }

      const task: TaskState = {
        id: taskId,
        projectId,
        title: input.title,
        description: input.description,
        preferredAgentId: input.preferredAgentId,
        agentId: dev.id,
        ...(qa ? { qaAgentId: qa.id } : {}),
        reviewRound: 0,
        status: 'in_progress',
        branch: taskBranch,
        reviewMode: this.effectiveReviewMode(projectId),
        createdAt: now,
        updatedAt: now,
        ...(imageFilenames ? { images: imageFilenames } : {}),
      };
      await this.taskStore.set(task);
      await this.agentStore.update(dev.id, (existing) => ({
        id: dev.id,
        projectId,
        taskId,
        bootstrappingTaskId: taskId,
        updatedAt: now,
        ...(existing?.paneId !== undefined ? { paneId: existing.paneId } : {}),
        ...(existing?.repoPath !== undefined ? { repoPath: existing.repoPath } : {}),
        ...(existing?.creationToken !== undefined ? { creationToken: existing.creationToken } : {}),
      }));
      await this.safeEmit({
        id: '',
        type: 'task.assigned',
        timestamp: now,
        projectId,
        agentId: dev.id,
        taskId,
        data: { agentId: dev.id },
      });
      return task;
    });
  }

  async createAndStartTask(
    projectId: string,
    input: {
      title: string;
      description: string;
      preferredAgentId: string;
      branch?: string;
      images?: { bytes: Buffer; ext: string }[];
    },
    opts: { background?: boolean } = {},
  ): Promise<TaskState> {
    const task = await this.createTask(projectId, input);
    if (task.status === 'in_progress' && task.agentId) {
      const signalToken = createSignalToken();
      await this.updateTask(task.id, { signalToken });
      const start = this.startCreatedTaskSession(task.id, task.agentId, signalToken);
      if (opts.background) {
        void start.catch((err) => {
          console.error(
            `[AgentManager] createAndStartTask background start failed for task=${task.id}:`,
            err,
          );
        });
      } else {
        const refreshed = await start;
        if (refreshed) return refreshed;
      }
    }
    return task;
  }

  private async startCreatedTaskSession(
    taskId: string,
    agentId: string,
    signalToken: string,
  ): Promise<TaskState | null> {
    let started = false;
    let dispatchErr: unknown = null;
    try {
      started = await this.startSession(taskId, agentId, 'develop');
    } catch (err) {
      dispatchErr = err;
      console.error(
        `[AgentManager] createAndStartTask startSession hard error for task=${taskId}:`,
        err,
      );
    }
    if (started) {
      const fresh = await this.taskStore.get(taskId);
      if (!fresh || TERMINAL_STATUSES.includes(fresh.status)) {
        const cfg = this.getAgentConfig(agentId);
        const state = await this.agentStore.get(agentId);
        if (cfg && state && state.taskId === taskId) {
          this.claimCancelCleanup(taskId);
          try {
            await this.markPaneCancelClearing(agentId, taskId);
            if (!(await this.interruptPaneAndWaitReady(state, cfg))) {
              await this.markAwaitingHuman(
                agentId,
                'cancel-interrupt-failed',
                'Task was cancelled during startup but ESC / REPL ready check failed; the agent may still be ' +
                  'running the cancelled prompt. Attach via web terminal to verify, then Resume or Delete.',
                { expectedTaskId: taskId },
              );
              return null;
            }
            await this.releaseAgentForTask(agentId, taskId, 'idle', { allowAwaitingHuman: true, fromCancelCleanup: true });
            return null;
          } finally {
            this.releaseCancelCleanup(taskId);
          }
        }
        await this.releaseAgentForTask(agentId, taskId, 'idle', { allowAwaitingHuman: true });
        return null;
      }
      const initialKinds = this.devInitialSignalKinds(fresh.reviewMode);
      try {
        await this.armPostDispatchSignalOrHold(taskId, agentId, initialKinds, signalToken);
      } catch (armErr) {
        console.error(`[AgentManager] createAndStartTask arm failed for task=${taskId}:`, armErr);
        await this.holdAgentForUnarmedSignal(taskId, agentId, initialKinds)
          .catch((holdErr) => {
            console.error(
              `[AgentManager] createAndStartTask hold-after-arm-failure failed for task=${taskId}:`,
              holdErr,
            );
          });
      }
      return null;
    }
    if (dispatchErr instanceof DispatchTerminalError) {
      await this.failTaskForDispatchError(taskId, 'develop', agentId, dispatchErr);
    } else if (dispatchErr instanceof EnsureSessionError && dispatchErr.partial.handled) {
    } else {
      const fresh = await this.taskStore.get(taskId);
      if (fresh && TERMINAL_STATUSES.includes(fresh.status) && (await this.agentStore.get(agentId))?.taskId === taskId) {
        await this.releaseAgentForTask(agentId, taskId, 'idle', { allowAwaitingHuman: true });
      } else {
        await this.rollbackFailedDispatch(taskId, agentId);
      }
    }
    return (await this.taskStore.get(taskId)) ?? null;
  }

  async attachImageToRunningAgent(
    agentId: string,
    bytes: Buffer,
    ext: string,
  ): Promise<{ path: string }> {
    const cfg = this.getAgentConfig(agentId);
    if (!cfg) throw new ApiError(404, `Unknown agent: ${agentId}`);
    const state = await this.agentStore.get(agentId);
    const paneId = state?.paneId;
    if (!paneId) throw new ApiError(409, `Agent ${agentId} has no live session`);
    if (!this.tryAcquireCompactGuard(agentId)) {
      throw new ApiError(409, `Agent ${agentId} compact or upload in progress; retry shortly`);
    }
    try {
      const assertUploadStillValid = async (): Promise<void> => {
        const held = await this.agentStore.get(agentId);
        if (!held || held.paneId !== paneId) {
          throw new ApiError(409, `Agent ${agentId} session changed while uploading; image paste aborted`);
        }
        const boundTask = held.taskId ? await this.taskStore.get(held.taskId) : null;
        if (boundTask && TERMINAL_STATUSES.includes(boundTask.status)) {
          throw new ApiError(409, `Agent ${agentId} task ${held.taskId} is terminal; image upload refused`);
        }
        const fresh = await this.agentStore.get(agentId);
        if (!fresh || fresh.paneId !== paneId || isCancelCleanupHold(fresh)) {
          throw new ApiError(409, `Agent ${agentId} is being cancelled (${fresh?.awaitingPhase}); image upload refused`);
        }
      };
      await assertUploadStillValid();
      const runner = this.createRunnerFor(cfg);
      const path = agentHostPath(agentId, imageFilename(ext));
      await writeImageToHost(runner, path, bytes);
      await assertUploadStillValid();
      const tmux = new TmuxManager(runner);
      await tmux.injectPrompt(paneId, `${path} `, agentId);
      return { path };
    } finally {
      this.compactInFlight.delete(agentId);
    }
  }

  private async sendSlashCommand(agentId: string, command: '/compact' | '/clear'): Promise<void> {
    const cfg = this.getAgentConfig(agentId);
    if (!cfg) throw new ApiError(404, `Unknown agent: ${agentId}`);
    if (!this.tryAcquireCompactGuard(agentId)) {
      throw new ApiError(409, `Agent ${agentId} compact or upload already in progress`);
    }
    let guardHandedOff = false;
    try {
      const state = await this.agentStore.get(agentId);
      const paneId = state?.paneId;
      if (!paneId) throw new ApiError(409, `Agent ${agentId} has no live session`);
      const taskIdAtStart = state.taskId;
      const updatedAtAtStart = state.updatedAt;
      const assertSessionUnchanged = async (): Promise<void> => {
        const now = await this.agentStore.get(agentId);
        if (
          !now
          || now.paneId !== paneId
          || now.taskId !== taskIdAtStart
          || now.updatedAt !== updatedAtAtStart
        ) {
          throw new ApiError(409, `Agent ${agentId} session changed while waiting; ${command} aborted`);
        }
      };
      const tmux = new TmuxManager(this.createRunnerFor(cfg));
      const waitReady = async (): Promise<void> => {
        try {
          await this.waitForReplPromptReady(tmux, paneId, cfg.runtime, this.manualCompactWaitMs);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new ApiError(409, `Agent ${agentId} runtime is not at an idle REPL prompt: ${detail}`);
        }
      };
      await waitReady();
      await assertSessionUnchanged();
      await tmux.clearComposerDraft(paneId);
      await waitReady();
      await assertSessionUnchanged();
      await tmux.sendKeysLiteral(paneId, command);
      await tmux.sendEnter(paneId);
      guardHandedOff = true;
      void this.waitForReplPromptReady(tmux, paneId, cfg.runtime, this.compactIdleWaitMs)
        .catch(err => {
          console.warn(`[AgentManager] sendSlashCommand(${agentId}, ${command}) post idle wait failed:`, err);
        })
        .finally(() => {
          this.compactInFlight.delete(agentId);
        });
    } finally {
      if (!guardHandedOff) this.compactInFlight.delete(agentId);
    }
  }

  async compactAgent(agentId: string): Promise<void> {
    return this.sendSlashCommand(agentId, '/compact');
  }

  async clearAgent(agentId: string): Promise<void> {
    return this.sendSlashCommand(agentId, '/clear');
  }

  private async persistTaskImages(
    taskId: string,
    images: { bytes: Buffer; ext: string }[],
  ): Promise<string[]> {
    const dir = join(this.imageStagingRoot, taskId);
    await mkdir(dir, { recursive: true });
    const filenames: string[] = [];
    for (const img of images) {
      const filename = imageFilename(img.ext);
      await writeFile(join(dir, filename), img.bytes);
      filenames.push(filename);
    }
    return filenames;
  }

  private async readStagedImages(
    taskId: string,
    filenames: string[],
  ): Promise<{ bytes: Buffer; ext: string }[]> {
    const dir = join(this.imageStagingRoot, taskId);
    const out: { bytes: Buffer; ext: string }[] = [];
    for (const filename of filenames) {
      let bytes: Buffer;
      try {
        bytes = await readFile(join(dir, filename));
      } catch {
        throw new ApiError(409, `原任务附图 ${filename} 已不可用，请重新创建并上传`);
      }
      const dot = filename.lastIndexOf('.');
      out.push({ bytes, ext: dot >= 0 ? filename.slice(dot + 1) : 'png' });
    }
    return out;
  }

  private async materializeTaskImages(
    runner: CommandRunner,
    task: TaskState,
  ): Promise<string[]> {
    const filenames = task.images ?? [];
    if (filenames.length === 0) return [];
    const dir = join(this.imageStagingRoot, task.id);
    const hostPaths: string[] = [];
    for (const filename of filenames) {
      let bytes: Buffer;
      try {
        bytes = await readFile(join(dir, filename));
      } catch (err) {
        throw new DispatchTerminalError(
          'task_image_missing',
          `task ${task.id} image ${filename} missing from staging (${dir}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const path = agentHostPath(task.id, filename);
      await writeImageToHost(runner, path, bytes);
      hostPaths.push(path);
    }
    return hostPaths;
  }

  private async imagePathsForDispatch(
    runner: CommandRunner,
    task: TaskState,
    phase: string,
  ): Promise<string[]> {
    if (!IMAGE_DISPATCH_PHASES.has(phase)) return [];
    return this.materializeTaskImages(runner, task);
  }

  async dispatchPendingTask(
    taskId: string,
    requestedAgentId?: string,
  ): Promise<{ task: TaskState | null; error?: string; errorCode?: 400 | 404 | 409 | 500 }> {
    const claim = await this.withTaskLock(async () => {
      const fresh = await this.taskStore.get(taskId);
      if (!fresh) return { task: null, errorCode: 404 as const, error: `Task ${taskId} not found` };
      if (fresh.status !== 'pending') {
        return { task: fresh, errorCode: 409 as const, error: `Task ${taskId} not pending (status=${fresh.status})` };
      }
      const agentId = requestedAgentId ?? fresh.preferredAgentId;
      if (agentId === '') {
        return {
          task: fresh,
          errorCode: 400 as const,
          error: `Task ${taskId} has no preferredAgentId; agentId is required in request body`,
        };
      }
      const cfg = this.getAgentConfig(agentId);
      if (!cfg) return { task: fresh, errorCode: 400 as const, error: `Unknown agent: ${agentId}` };
      if (cfg.projectId !== fresh.projectId) {
        return { task: fresh, errorCode: 400 as const, error: `Agent ${agentId} not in project ${fresh.projectId}` };
      }
      if (cfg.role !== 'dev') {
        return { task: fresh, errorCode: 400 as const, error: `Agent ${agentId} is not dev role` };
      }
      if (fresh.preferredAgentId !== '' && fresh.preferredAgentId !== agentId) {
        return {
          task: fresh,
          errorCode: 400 as const,
          error: `Task ${taskId} preferredAgentId=${fresh.preferredAgentId} ≠ requested agentId=${agentId}`,
        };
      }
      const state = await this.agentStore.get(agentId);
      if (!canDispatchWithBinding(state)) {
        return { task: fresh, errorCode: 409 as const, error: `Agent ${agentId} is busy or awaiting human` };
      }
      const acquired = await this.lockManager.acquire(agentId, taskId);
      if (!acquired) {
        return { task: fresh, errorCode: 409 as const, error: `Agent ${agentId} lock acquisition failed` };
      }

      const now = new Date().toISOString();
      const qaId = fresh.qaAgentId ?? this.findQaPartner(agentId)?.id;
      const claimedTask: TaskState = {
        ...fresh,
        preferredAgentId: agentId,
        agentId,
        status: 'in_progress',
        updatedAt: now,
        ...(qaId ? { qaAgentId: qaId } : {}),
      };
      await this.taskStore.set(claimedTask);
      await this.agentStore.update(agentId, (existing) => ({
        id: agentId,
        projectId: cfg.projectId,
        taskId,
        bootstrappingTaskId: taskId,
        updatedAt: now,
        ...(existing?.paneId !== undefined ? { paneId: existing.paneId } : {}),
        ...(existing?.repoPath !== undefined ? { repoPath: existing.repoPath } : {}),
        ...(existing?.creationToken !== undefined ? { creationToken: existing.creationToken } : {}),
      }));
      await this.safeEmit({
        id: '',
        type: 'task.assigned',
        timestamp: now,
        projectId: cfg.projectId,
        agentId,
        taskId,
        data: { agentId, manuallyDispatched: true },
      });
      return { task: claimedTask };
    });

    if (claim.errorCode !== undefined) return claim;
    if (!claim.task) return claim;
    const claimed = claim.task;

    const signalToken = createSignalToken();
    await this.updateTask(claimed.id, { signalToken });

    let started = false;
    let dispatchErr: unknown = null;
    try {
      started = await this.startSession(claimed.id, claimed.agentId, 'develop');
    } catch (err) {
      dispatchErr = err;
      console.error(
        `[AgentManager] dispatchPendingTask startSession hard error for task=${claimed.id}:`,
        err,
      );
    }
    if (started) {
      await this.armPostDispatchSignalOrHold(claimed.id, claimed.agentId, this.devInitialSignalKinds(claimed.reviewMode), signalToken);
      const refreshed = await this.taskStore.get(claimed.id);
      return { task: refreshed ?? claimed };
    }

    if (dispatchErr instanceof DispatchTerminalError) {
      await this.failTaskForDispatchError(claimed.id, 'develop', claimed.agentId, dispatchErr);
    } else if (dispatchErr instanceof EnsureSessionError && dispatchErr.partial.handled) {
    } else {
      await this.rollbackFailedDispatch(claimed.id, claimed.agentId);
    }
    const refreshed = await this.taskStore.get(claimed.id);
    if (dispatchErr === null) {
      return { task: refreshed, errorCode: 409, error: 'task state changed during dispatch; startSession refused' };
    }
    const err = dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
    return { task: refreshed, errorCode: 500, error: err };
  }

  async startSession(
    taskId: string,
    agentId: string,
    phase: string,
    opts: {
      bypassTaskStatusGate?: boolean;
      signalToken?: string;
      currentSpecRound?: number;
      dialogFailFromStatuses?: TaskStatus[];
      serverContent?: string;
      serverDiffstat?: string;
      serverBatch?: { index: number; total: number };
      serverPriorFindings?: string;
      serverPriorResponse?: string;
      contentTruncated?: boolean;
      armBeforeInject?: () => Promise<boolean>;
    } = {},
  ): Promise<boolean> {
    const agent = this.getAgentConfig(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);

    const task = await this.taskStore.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);

    const project = this.getProjectConfig(agent.projectId);
    if (!project) throw new Error(`Unknown project: ${agent.projectId}`);

    const expectedStatuses = PHASE_EXPECTED_STATUS[phase] ?? [];
    const preTask = await this.taskStore.get(taskId);
    if (!preTask) {
      console.warn(`[AgentManager] startSession[${phase}]: pre-create task=${taskId} not found; aborting`);
      return false;
    }
    if (TERMINAL_STATUSES.includes(preTask.status)) {
      console.warn(
        `[AgentManager] startSession[${phase}]: pre-create task=${taskId} status=${preTask.status} ` +
        `is terminal; aborting`,
      );
      return false;
    }
    if (!opts.bypassTaskStatusGate && !expectedStatuses.includes(preTask.status)) {
      console.warn(
        `[AgentManager] startSession[${phase}]: pre-create task=${taskId} status=${preTask.status} ` +
        `not in expected ${expectedStatuses.join('/')}; aborting`,
      );
      return false;
    }
    const preAgent = await this.agentStore.get(agentId);
    if (PHASE_REQUIRES_AGENT_BOUND_TO_TASK[phase]) {
      if (!preAgent || preAgent.taskId !== taskId) {
        console.warn(
          `[AgentManager] startSession[${phase}]: pre-create agent=${agentId} not bound to ${taskId} ` +
          `(got ${preAgent?.taskId}); aborting`,
        );
        return false;
      }
    } else if (preAgent && preAgent.taskId && preAgent.taskId !== taskId) {
      console.warn(
        `[AgentManager] startSession[${phase}]: pre-create agent=${agentId} already bound to ` +
        `${preAgent.taskId} (request ${taskId}); aborting`,
      );
      return false;
    }

    const dialogFailFromStatuses =
      opts.dialogFailFromStatuses ?? PHASE_EXPECTED_STATUS[phase] ?? [...ACTIVE_TASK_STATUSES];
    let ensure: EnsureSessionResult;
    try {
      ensure = await this.ensureSession(agentId, 'runtime');
    } catch (err) {
      if (await this.handleDialogPendingFromRuntime(agentId, err, { expectedFromStatuses: dialogFailFromStatuses })) {
        throw err;
      }
      if (err instanceof EnsureSessionError && err.partial.createdSession) {
        try {
          const runner = this.createRunnerFor(agent);
          await new TmuxManager(runner).killSession(agentId);
        } catch (cleanupErr) {
          console.warn(
            `[AgentManager] startSession ensureSession rollback killSession failed:`,
            cleanupErr,
          );
        }
      }
      throw err;
    }
    const { paneId, workdir } = ensure;

    const runner = this.createRunnerFor(agent);
    const worktree = new WorktreeManager(runner);
    const tmux = new TmuxManager(runner);

    const baseRef = agent.workdir
      ? undefined
      : await this.resolveAutoBaseRef(runner, workdir);

    const isServerQaPhase = phase === 'server-review' || phase === 'server-recheck' || phase === 'server-spec-review';
    const customBranch = task.branch && !task.branch.startsWith(BRANCH_PREFIX) ? task.branch : undefined;
    const worktreePath = isServerQaPhase
      ? await worktree.createDetachedAtBase(workdir, taskId)
      : phase === 'review' || phase === 'recheck'
        ? await worktree.createDetached(workdir, taskId, task.branch!)
        : await worktree.create(workdir, taskId, baseRef, customBranch);

    await this.agentStore.update(agentId, (stateNow) => {
      if (!stateNow || stateNow.taskId !== taskId) return AGENT_STORE_NOOP;
      return {
        ...stateNow,
        paneId,
        worktreePath,
        repoPath: workdir,
        updatedAt: new Date().toISOString(),
      };
    });

    const promptSignalToken = opts.signalToken ?? task.signalToken;
    const promptSpecRound = opts.currentSpecRound ?? task.specReviewRound;
    const hasQaPartner = !!(task.qaAgentId ?? this.findQaPartner(agentId)?.id);
    let prompt: string;
    try {
      const imagePaths = await this.imagePathsForDispatch(runner, task, phase);
      prompt = buildPromptInline({
        task,
        phase,
        agent,
        worktreePath,
        skillRegistry: this.skillRegistry,
        hasQaPartner,
        ...(promptSignalToken ? { signalToken: promptSignalToken } : {}),
        ...(promptSpecRound !== undefined ? { currentSpecRound: promptSpecRound } : {}),
        ...(imagePaths.length ? { imagePaths } : {}),
        ...(opts.serverContent !== undefined ? { serverContent: opts.serverContent } : {}),
        ...(opts.serverDiffstat !== undefined ? { serverDiffstat: opts.serverDiffstat } : {}),
        ...(opts.serverBatch ? { serverBatch: opts.serverBatch } : {}),
        ...(opts.serverPriorFindings ? { serverPriorFindings: opts.serverPriorFindings } : {}),
        ...(opts.serverPriorResponse ? { serverPriorResponse: opts.serverPriorResponse } : {}),
        ...(opts.contentTruncated ? { contentTruncated: true } : {}),
      });
    } catch (err) {
      try { await worktree.removeWithBranch(workdir, worktreePath, customBranch); } catch {}
      if (err instanceof PromptSizeError) {
        throw new DispatchTerminalError('prompt_too_large', err.message);
      }
      if (err instanceof RequiredSkillsMissingError) {
        throw new DispatchTerminalError('required_skills_missing', err.message);
      }
      throw err;
    }

    const taskFresh = await this.taskStore.get(taskId);
    if (!taskFresh) {
      console.warn(
        `[AgentManager] startSession: task ${taskId} disappeared mid-dispatch; cleaning up worktree before paste`,
      );
      try { await worktree.removeWithBranch(workdir, worktreePath, customBranch); } catch {}
      return false;
    }
    if (TERMINAL_STATUSES.includes(taskFresh.status)) {
      console.warn(
        `[AgentManager] startSession: task ${taskId} status=${taskFresh.status} is terminal ` +
        `for phase=${phase}; cleaning up worktree before paste`,
      );
      try { await worktree.removeWithBranch(workdir, worktreePath, customBranch); } catch {}
      return false;
    }
    if (!opts.bypassTaskStatusGate && !expectedStatuses.includes(taskFresh.status)) {
      console.warn(
        `[AgentManager] startSession: task ${taskId} status=${taskFresh.status} not in ` +
        `expected ${expectedStatuses.join('/')} for phase=${phase}; cleaning up worktree before paste`,
      );
      try { await worktree.removeWithBranch(workdir, worktreePath, customBranch); } catch {}
      return false;
    }

    const agentFresh = await this.agentStore.get(agentId);
    if (PHASE_REQUIRES_AGENT_BOUND_TO_TASK[phase]) {
      if (!agentFresh || agentFresh.taskId !== taskId) {
        console.warn(
          `[AgentManager] startSession[${phase}]: agent ${agentId} not bound to ${taskId} ` +
          `(got taskId=${agentFresh?.taskId}); cleaning up worktree before paste`,
        );
        try { await worktree.removeWithBranch(workdir, worktreePath, customBranch); } catch {}
        return false;
      }
    } else if (agentFresh && agentFresh.taskId && agentFresh.taskId !== taskId) {
      console.warn(
        `[AgentManager] startSession[${phase}]: agent ${agentId} reassigned to ${agentFresh.taskId} ` +
        `(was ${taskId}); cleaning up worktree before paste`,
      );
      try { await worktree.removeWithBranch(workdir, worktreePath, customBranch); } catch {}
      return false;
    }

    if (opts.armBeforeInject && !(await opts.armBeforeInject())) {
      try { await worktree.removeWithBranch(workdir, worktreePath, customBranch); } catch {}
      return false;
    }

    const now = new Date().toISOString();
    let agentMarkedRunning = false;
    try {
      let cancelHoldWon = false;
      await this.agentStore.update(agentId, (existing) => {
        if (isCancelCleanupHold(existing)) { cancelHoldWon = true; return AGENT_STORE_NOOP; }
        return {
          id: agentId,
          projectId: agent.projectId,
          paneId,
          taskId,
          worktreePath,
          repoPath: workdir,
          startedAt: now,
          bootstrappingTaskId: taskId,
          updatedAt: now,
          ...(existing?.creationToken !== undefined ? { creationToken: existing.creationToken } : {}),
        };
      });
      if (cancelHoldWon) {
        console.warn(
          `[AgentManager] startSession[${phase}]: agent ${agentId} entered a cancel-cleanup hold during dispatch; ` +
          `aborting so cancel can finish interrupt + /clear`,
        );
        try { await worktree.removeWithBranch(workdir, worktreePath, customBranch); } catch {}
        return false;
      }
      agentMarkedRunning = true;

      await this.injectAndAwaitAck(tmux, paneId, prompt, agentId, agent.runtime);
      try {
        await this.clearBootstrapMarker(agentId, taskId);
      } catch (clearErr) {
        console.warn(`[AgentManager] startSession: clearing bootstrap marker for task=${taskId} failed:`, clearErr);
        await this.markAwaitingHuman(
          agentId,
          'bootstrap-marker-clear-failed',
          'Prompt was delivered but clearing the in-flight bootstrap marker failed; held so recovery does ' +
            'not re-dispatch an already-running task. Verify the agent via web terminal, then Resume.',
          { expectedTaskId: taskId },
        ).catch((holdErr) => {
          console.warn(`[AgentManager] startSession: hold after marker-clear failure for task=${taskId} failed:`, holdErr);
        });
      }

      await this.eventBus.emit({
        id: '',
        type: 'session.started',
        timestamp: now,
        projectId: agent.projectId,
        agentId,
        taskId,
        data: { phase, worktreePath },
      });
      this.startRuntimeMenuWatch(agentId);
      return true;
    } catch (err) {
      const isAckUnknown = err instanceof DispatchTerminalError && err.reason === 'ack_unknown';
      if (!isAckUnknown) {
        try { await worktree.removeWithBranch(workdir, worktreePath, customBranch); } catch {}
        if (agentMarkedRunning) {
          try {
            let released = false;
            await this.agentStore.update(agentId, (agentNow) => {
              if (!agentNow || agentNow.taskId !== taskId) {
                console.warn(
                  `[AgentManager] startSession cleanup agentStore: agent ${agentId} already reassigned ` +
                  `(taskId=${agentNow?.taskId}, expected ${taskId}); skipping`,
                );
                return AGENT_STORE_NOOP;
              }
              if (isCancelCleanupHold(agentNow)) {
                console.warn(
                  `[AgentManager] startSession cleanup agentStore: agent ${agentId} held by cancel cleanup ` +
                  `(${agentNow.awaitingPhase}); leaving binding to the owner`,
                );
                return AGENT_STORE_NOOP;
              }
              released = true;
              void err;
              return {
                id: agentId,
                projectId: agent.projectId,
                paneId,
                repoPath: workdir,
                updatedAt: new Date().toISOString(),
                ...(agentNow.creationToken !== undefined ? { creationToken: agentNow.creationToken } : {}),
              };
            });
            if (released) {
              await this.lockManager.release(agentId);
            }
          } catch (cleanupErr) {
            console.warn(`[AgentManager] startSession cleanup agentStore failed:`, cleanupErr);
          }
        }
      }
      throw err;
    }
  }

  private async injectAndAwaitAck(
    tmux: TmuxManager,
    paneId: string,
    prompt: string,
    agentId: string,
    runtime: AgentConfig['runtime'],
  ): Promise<{ acked: boolean; composerDelivered: boolean }> {
    const before = await this.agentStore.get(agentId);
    await this.acquireCompactGuard(agentId);
    try {
      if (before) {
        const now = await this.agentStore.get(agentId);
        if (!now || now.paneId !== before.paneId || now.taskId !== before.taskId) {
          throw new Error(
            `dispatch aborted: agent ${agentId} binding changed while waiting for pane mutex`,
          );
        }
        if (isCancelCleanupHold(now)) {
          throw new Error(
            `dispatch aborted: agent ${agentId} taken over by cancel (${now.awaitingPhase}) while waiting for pane mutex`,
          );
        }
        const boundTask = now.taskId ? await this.taskStore.get(now.taskId) : null;
        if (boundTask && TERMINAL_STATUSES.includes(boundTask.status)) {
          throw new Error(
            `dispatch aborted: task ${now.taskId} for agent ${agentId} went terminal while waiting for pane mutex`,
          );
        }
      }
      const revalidate = before
        ? async (): Promise<void> => {
          const fresh = await this.agentStore.get(agentId);
          if (!fresh || fresh.paneId !== before.paneId || fresh.taskId !== before.taskId || isCancelCleanupHold(fresh)) {
            throw new Error(`dispatch aborted: agent ${agentId} taken over by cancel before paste`);
          }
          const boundTask = fresh.taskId ? await this.taskStore.get(fresh.taskId) : null;
          if (boundTask && TERMINAL_STATUSES.includes(boundTask.status)) {
            throw new Error(`dispatch aborted: task ${fresh.taskId} for agent ${agentId} went terminal before paste`);
          }
        }
        : undefined;
      await revalidate?.();
      return await this.injectAndAwaitAckSteps(tmux, paneId, prompt, agentId, runtime, revalidate);
    } finally {
      this.compactInFlight.delete(agentId);
    }
  }

  private async injectAndAwaitAckSteps(
    tmux: TmuxManager,
    paneId: string,
    prompt: string,
    agentId: string,
    runtime: AgentConfig['runtime'],
    revalidate?: () => Promise<void>,
  ): Promise<{ acked: boolean; composerDelivered: boolean }> {
    // 静态忙信号（文本忙样式/working title）可能是残稿或 stale title 冒充，一律由帧活性仲裁；ready 视图覆盖 stale title。
    const preTitle = await tmux.readPaneTitle(paneId);
    const preFrame = await tmux.capturePaneById(paneId, { ansi: false, scrollback: 0 });
    const staticBusy = hasOscTitleWorking(preTitle)
      ? (runtimeBusyCheck(preFrame, runtime) || !hasRuntimeReadyView(preFrame, runtime))
      : runtimeBusyCheck(preFrame, runtime);
    if (staticBusy && await this.paneHasLiveTurn(tmux, paneId, runtime)) {
      throw new Error(`pre-inject busy check: pane ${paneId} is still running a turn; dispatch aborted`);
    }
    await tmux.clearComposerDraft(paneId);
    await revalidate?.();
    await tmux.injectPrompt(paneId, prompt, agentId);
    let baseline: string;
    let baselineTitle = '';
    try {
      baseline = await tmux.captureSettledSnapshot(paneId, { timeoutMs: this.dispatchSettleTimeoutMs });
      baselineTitle = await tmux.readPaneTitle(paneId);
      await tmux.sendEnter(paneId);
    } catch (preAckErr) {
      if (await this.clearComposerForReuse(tmux, paneId, agentId)) throw preAckErr;
      const message = preAckErr instanceof Error ? preAckErr.message : String(preAckErr);
      throw new DispatchTerminalError(
        'ack_unknown',
        `pre-ack failure left an unconfirmed composer on live pane ${paneId}: ${message}`,
      );
    }
    try {
      await tmux.waitSubmitAck(paneId, baseline, runtime, {
        timeoutMs: this.dispatchAckTimeoutMs,
        baselineTitle,
        resend: () => tmux.sendEnter(paneId),
        resendIntervalMs: this.dispatchAckResendIntervalMs,
      });
      return { acked: true, composerDelivered: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!(err instanceof Error && /runtime ack timeout/.test(err.message))) {
        throw new DispatchTerminalError('ack_unknown', `ack_unknown for pane ${paneId}: ${message}`);
      }
      console.warn(
        `[AgentManager] dispatch ack timeout for pane ${paneId} agent ${agentId}: ${message}`,
      );
      const state = await this.agentStore.get(agentId).catch(() => null);
      await this.safeEmit({
        id: '',
        type: 'human.intervention',
        timestamp: new Date().toISOString(),
        projectId: state?.projectId ?? '',
        agentId,
        ...(state?.taskId ? { taskId: state.taskId } : {}),
        data: {
          phase: 'dispatch-ack-timeout',
          paneId,
          message,
          note:
            'REPL did not acknowledge the pasted prompt within timeout. ' +
            'baxian intentionally did NOT send C-c — the input may still be queued. ' +
            'Attach via web terminal to verify and resolve.',
        },
      });
      const composerDelivered = !/pane already busy at baseline/.test(message);
      return { acked: false, composerDelivered };
    }
  }

  private async clearComposerForReuse(tmux: TmuxManager, paneId: string, agentId: string): Promise<boolean> {
    try {
      await tmux.clearComposerDraft(paneId);
      return true;
    } catch (err) {
      console.warn(`[AgentManager] clearComposerForReuse: composer clear failed for pane ${paneId}:`, err);
    }
    try {
      return !(await tmux.hasSession(agentId));
    } catch (err) {
      console.warn(`[AgentManager] clearComposerForReuse: hasSession probe failed for ${agentId}:`, err);
      return false;
    }
  }

  async markAgentWaiting(
    agentId: string,
    expectedTaskId: string,
    opts: { allowAwaitingHuman?: boolean; clearAwaitingHuman?: boolean } = {},
  ): Promise<boolean> {
    return this.releaseAgentForTask(agentId, expectedTaskId, 'waiting', opts);
  }

  async continueSession(
    taskId: string,
    agentId: string,
    phase: string,
    opts: ContinueSessionOpts = {},
  ): Promise<boolean> {
    const agent = this.getAgentConfig(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);

    const task = await this.taskStore.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);

    const signalToken = opts.signalToken ?? task.signalToken;
    if (phase === 'post-approve') {
      const completion = await this.getPostApproveCompletion(taskId);
      if (!completion || !signalToken || completion.token !== signalToken) {
        console.warn(
          `[AgentManager] continueSession[post-approve]: token missing or stale for task ${taskId}; skipping`,
        );
        return false;
      }
    }

    const agentState = await this.agentStore.get(agentId);
    if (!agentState) throw new Error(`No agent state found for: ${agentId}`);

    if (PHASE_REQUIRES_AGENT_BOUND_TO_TASK[phase] && agentState.taskId !== taskId) {
      console.warn(
        `[AgentManager] continueSession[${phase}]: agent ${agentId} not bound to ${taskId} ` +
        `(pre-paste taskId=${agentState.taskId}); skipping`,
      );
      return false;
    }
    if (!PHASE_REQUIRES_AGENT_BOUND_TO_TASK[phase]
        && agentState.taskId
        && agentState.taskId !== taskId) {
      console.warn(
        `[AgentManager] continueSession[${phase}]: agent ${agentId} reassigned ` +
        `(pre-paste taskId=${agentState.taskId} !== ${taskId}); skipping`,
      );
      return false;
    }

    const worktreePath = agentState.worktreePath!;

    const dialogFailFromStatuses =
      opts.dialogFailFromStatuses ?? PHASE_EXPECTED_STATUS[phase] ?? [...ACTIVE_TASK_STATUSES];
    let ensure: EnsureSessionResult;
    try {
      ensure = await this.ensureSession(agentId, 'runtime');
    } catch (err) {
      if (await this.handleDialogPendingFromRuntime(agentId, err, { expectedFromStatuses: dialogFailFromStatuses })) {
        throw err;
      }
      if (err instanceof EnsureSessionError && err.partial.createdSession) {
        try {
          const runner = this.createRunnerFor(agent);
          await new TmuxManager(runner).killSession(agentId);
        } catch (cleanupErr) {
          console.warn(
            `[AgentManager] continueSession ensureSession rollback killSession failed:`,
            cleanupErr,
          );
        }
      }
      throw err;
    }
    const { paneId } = ensure;

    const runner = this.createRunnerFor(agent);
    const tmux = new TmuxManager(runner);

    const promptSpecRound = opts.currentSpecRound ?? task.specReviewRound;
    let prompt: string;
    try {
      const useIncrementalNudge =
        typeof opts.postApproveRedispatchCount === 'number'
        && opts.postApproveRedispatchCount > 0
        && !ensure.freshRuntime;
      const imagePaths = await this.imagePathsForDispatch(runner, task, phase);
      prompt = buildPromptInline({
        task,
        phase,
        agent,
        worktreePath,
        skillRegistry: this.skillRegistry,
        ...(signalToken ? { signalToken } : {}),
        ...(useIncrementalNudge
          ? { postApproveRedispatchCount: opts.postApproveRedispatchCount }
          : {}),
        ...(promptSpecRound !== undefined ? { currentSpecRound: promptSpecRound } : {}),
        ...(imagePaths.length ? { imagePaths } : {}),
        ...(opts.serverContent !== undefined ? { serverContent: opts.serverContent } : {}),
        ...(opts.serverDiffstat !== undefined ? { serverDiffstat: opts.serverDiffstat } : {}),
        ...(opts.serverBatch ? { serverBatch: opts.serverBatch } : {}),
        ...(opts.serverPriorFindings ? { serverPriorFindings: opts.serverPriorFindings } : {}),
        ...(opts.serverPriorResponse ? { serverPriorResponse: opts.serverPriorResponse } : {}),
        ...(opts.serverAfterDone ? { serverAfterDone: opts.serverAfterDone } : {}),
        ...(opts.contentTruncated ? { contentTruncated: opts.contentTruncated } : {}),
      });
    } catch (err) {
      if (err instanceof PromptSizeError) {
        throw new DispatchTerminalError('prompt_too_large', err.message);
      }
      if (err instanceof RequiredSkillsMissingError) {
        throw new DispatchTerminalError('required_skills_missing', err.message);
      }
      throw err;
    }

    const expectedStatuses = PHASE_EXPECTED_STATUS[phase] ?? [];
    const taskFresh = await this.taskStore.get(taskId);
    if (!taskFresh || TERMINAL_STATUSES.includes(taskFresh.status)) {
      console.warn(
        `[AgentManager] continueSession: task ${taskId} status=${taskFresh?.status} terminal/missing; skipping paste`,
      );
      return false;
    }
    if (!opts.bypassTaskStatusGate && !expectedStatuses.includes(taskFresh.status)) {
      console.warn(
        `[AgentManager] continueSession: task ${taskId} status=${taskFresh.status} not in ` +
        `expected ${expectedStatuses.join('/')} for phase=${phase}; skipping paste`,
      );
      return false;
    }

    const agentFresh = await this.agentStore.get(agentId);
    if (PHASE_REQUIRES_AGENT_BOUND_TO_TASK[phase]) {
      if (!agentFresh || agentFresh.taskId !== taskId) {
        console.warn(
          `[AgentManager] continueSession[${phase}]: agent ${agentId} not bound to ${taskId} ` +
          `(got ${agentFresh?.taskId}); skipping`,
        );
        return false;
      }
    } else if (agentFresh && agentFresh.taskId && agentFresh.taskId !== taskId) {
      console.warn(
        `[AgentManager] continueSession[${phase}]: agent ${agentId} reassigned ` +
        `(taskId=${agentFresh.taskId} !== ${taskId}); skipping`,
      );
      return false;
    }

    if (phase === 'post-approve') {
      const completionFresh = await this.getPostApproveCompletion(taskId);
      if (!completionFresh || completionFresh.token !== signalToken) {
        console.warn(
          `[AgentManager] continueSession[post-approve]: token changed before paste for task ${taskId}; skipping`,
        );
        return false;
      }
    }

    if (opts.armBeforeInject && !(await opts.armBeforeInject())) {
      return false;
    }

    const now = new Date().toISOString();
    await this.agentStore.update(agentId, (latest) => {
      if (!latest) return AGENT_STORE_NOOP;
      return {
        ...latest,
        paneId,
        worktreePath,
        updatedAt: now,
      };
    });

    await this.injectAndAwaitAck(tmux, paneId, prompt, agentId, agent.runtime);
    return true;
  }

  private async rollbackUndeliveredBootstrap(
    state: AgentBindingFacts,
    agentConfig: AgentConfig & { projectId: string },
  ): Promise<boolean> {
    if (
      !state.taskId
      || state.bootstrappingTaskId !== state.taskId
      || state.awaitingPhase === 'bootstrap-marker-clear-failed'
    ) {
      return false;
    }
    const boundTask = await this.taskStore.get(state.taskId);
    if (!boundTask || boundTask.phase || boundTask.status !== 'in_progress' || boundTask.agentId !== state.id) {
      return false;
    }
    if (await this.bootstrapPromptWasDelivered(state.taskId, boundTask.createdAt)) {
      await this.clearBootstrapMarker(state.id, state.taskId);
      return false;
    }
    console.warn(
      `[recover] agent ${state.id} was mid-bootstrap for in_progress task ${state.taskId} ` +
      `(prompt never ack'd); rolling the task back to pending`,
    );
    if (state.worktreePath) {
      const cleanupDir = this.resolveWorkdir(agentConfig, state);
      if (cleanupDir) {
        try {
          await new WorktreeManager(this.createRunnerFor(agentConfig)).remove(cleanupDir, state.worktreePath);
        } catch (worktreeErr) {
          console.warn(`[recover] mid-bootstrap rollback: worktree.remove failed for ${state.worktreePath}:`, worktreeErr);
        }
      }
    }
    await this.rollbackFailedDispatch(state.taskId, state.id);
    await this.agentStore.update(state.id, (latest) => {
      if (!latest || latest.status !== 'awaiting_human') return AGENT_STORE_NOOP;
      const { status: _s, awaitingPhase: _p, awaitingReason: _r, awaitingSince: _a, ...rest } = latest;
      return { ...rest, updatedAt: new Date().toISOString() };
    });
    return true;
  }

  private async bootstrapPromptWasDelivered(taskId: string, createdAtIso: string): Promise<boolean> {
    const today = new Date().toISOString().slice(0, 10);
    const from = createdAtIso.slice(0, 10);
    try {
      const events = await this.eventBus.readRange(from, today);
      return events.some((e) => e.type === 'session.started' && e.taskId === taskId);
    } catch (err) {
      console.warn(`[recover] bootstrapPromptWasDelivered read failed for task=${taskId}:`, err);
      return false;
    }
  }

  private async clearBootstrapMarker(agentId: string, taskId: string): Promise<void> {
    await this.agentStore.update(agentId, (latest) => {
      if (!latest || latest.taskId !== taskId || latest.bootstrappingTaskId === undefined) return AGENT_STORE_NOOP;
      const { bootstrappingTaskId: _delivered, ...rest } = latest;
      return { ...rest, updatedAt: new Date().toISOString() };
    });
  }

  async recover(): Promise<void> {
    const states = await this.agentStore.list();
    const deferredCleanups: Array<{ failingAgentId: string; failedTaskIds: string[]; projectIds: string[] }> = [];

    for (const state of states) {
      const agentConfig = this.getAgentConfig(state.id);
      if (!agentConfig) continue;
      try {
        const result = await this.ensureSession(state.id, 'recover');
        if (await this.rollbackUndeliveredBootstrap(state, agentConfig)) continue;
        if (state.creationToken && !state.taskId) {
          const ct = state.creationToken;
          const pane = result.paneId;
          const cfg = agentConfig;
          const agentId = state.id;
          void (async () => {
            if (await this.runGreetingHandshake(agentId, cfg, pane)) {
              await this.agentStore.update(agentId, (latest) => {
                if (!latest || latest.creationToken !== ct) return AGENT_STORE_NOOP;
                const {
                  creationToken: _ct, status: _s,
                  awaitingPhase: _ap, awaitingReason: _ar, awaitingSince: _as,
                  ...ready
                } = latest;
                return { ...ready, paneId: pane, updatedAt: new Date().toISOString() };
              });
            } else {
              await this.markGreetingFailed(agentId, ct);
            }
          })().catch((err) => console.warn(`[recover] background re-greet for ${agentId} crashed:`, err));
          continue;
        }
        const boundTask = state.taskId ? await this.taskStore.get(state.taskId) : null;
        if (
          state.taskId
          && boundTask?.id === state.taskId
          && boundTask.status === 'merged'
          && boundTask.prNumber != null
          && boundTask.branch
          && !state.creationToken
          && state.status !== 'awaiting_human'
        ) {
          try {
            await this.agentStore.update(state.id, (latest) => {
              if (!latest || latest.taskId !== boundTask.id) return AGENT_STORE_NOOP;
              if (latest.creationToken || latest.status === 'awaiting_human') return AGENT_STORE_NOOP;
              return { ...latest, paneId: result.paneId, updatedAt: new Date().toISOString() };
            });
            const recovered = await this.agentStore.get(state.id);
            if (
              recovered?.taskId !== boundTask.id
              || recovered.paneId !== result.paneId
              || recovered.creationToken
              || recovered.status === 'awaiting_human'
            ) {
              continue;
            }
            await this.dispatchPostMergeCleanup(state.id, {
              taskId: boundTask.id,
              branch: boundTask.branch,
            });
            continue;
          } catch (cleanupErr) {
            console.warn(
              `[recover] dispatchPostMergeCleanup(${state.id}, ${boundTask.id}) failed:`,
              cleanupErr,
            );
          }
        }
        const cancelHold = isCancelCleanupHold(state);
        const shouldReleaseBinding = shouldReleaseHeldBinding(state, boundTask) && !cancelHold;
        if (shouldReleaseBinding && state.worktreePath) {
          const cleanupDir = this.resolveWorkdir(agentConfig, state);
          if (cleanupDir) {
            const runner = this.createRunnerFor(agentConfig);
            const worktree = new WorktreeManager(runner);
            try {
              await worktree.remove(cleanupDir, state.worktreePath);
            } catch (worktreeErr) {
              console.warn(
                `[recover] worktree.remove failed for ${state.worktreePath}:`,
                worktreeErr,
              );
            }
          }
        }
        const preserveHeld =
          !shouldReleaseBinding
          && state.status === 'awaiting_human';
        await this.agentStore.update(state.id, (latest) => {
          if (!latest) return AGENT_STORE_NOOP;
          const base = {
            id: latest.id,
            projectId: latest.projectId,
            paneId: result.paneId,
            updatedAt: new Date().toISOString(),
            ...(latest.repoPath !== undefined ? { repoPath: latest.repoPath } : {}),
            status: 'ok' as const,
          };
          if (shouldReleaseBinding) {
            return base;
          }
          const withBinding = {
            ...base,
            ...(latest.taskId !== undefined ? { taskId: latest.taskId } : {}),
            ...(latest.worktreePath !== undefined ? { worktreePath: latest.worktreePath } : {}),
            ...(latest.startedAt !== undefined ? { startedAt: latest.startedAt } : {}),
          };
          if (!preserveHeld) return withBinding;
          return {
            ...withBinding,
            status: 'awaiting_human' as const,
            ...(latest.awaitingPhase !== undefined ? { awaitingPhase: latest.awaitingPhase } : {}),
            ...(latest.awaitingReason !== undefined ? { awaitingReason: latest.awaitingReason } : {}),
            ...(latest.awaitingSince !== undefined ? { awaitingSince: latest.awaitingSince } : {}),
          };
        });
        if (shouldReleaseBinding) {
          await this.lockManager.release(state.id);
        }
        if (state.taskId && !shouldReleaseBinding && !cancelHold) {
          this.startRuntimeMenuWatch(state.id);
        }
      } catch (err) {
        if (err instanceof EnsureSessionError && err.partial.dialogPending) {
          if (await this.rollbackUndeliveredBootstrap(state, agentConfig)) continue;
          await this.markDialogPending(state.id, state.creationToken);
          void this.slowPollDialogPending(state.id, state.creationToken, {
            ...(state.paneId !== undefined ? { expectedPaneId: state.paneId } : {}),
            expectedTaskId: state.taskId,
          }).catch((pollErr) => {
            console.warn(`[recover] slowPoll for ${state.id} crashed:`, pollErr);
          });
          continue;
        }
        if (err instanceof EnsureSessionError && err.partial.createdSession) {
          try {
            const runner = this.createRunnerFor(agentConfig);
            await new TmuxManager(runner).killSession(state.id);
          } catch (cleanupErr) {
            console.warn(
              `[recover] killSession rollback failed for agent=${state.id}:`,
              cleanupErr,
            );
          }
        }
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[recover] ensureSession failed for agent=${state.id}: ${message}`);
        await this.agentStore.update(state.id, (latest) => {
          if (!latest) return AGENT_STORE_NOOP;
          return {
            ...latest,
            paneId: undefined,
            creationToken: undefined,
            updatedAt: new Date().toISOString(),
          };
        });
        await this.lockManager.release(state.id);
        const cleanup = await this.failTasksForAgent(
          state.id,
          `recovery: ${message}`,
          { deferPartnerCleanup: true },
        );
        deferredCleanups.push({
          failingAgentId: state.id,
          failedTaskIds: cleanup.failedTaskIds,
          projectIds: cleanup.projectIds,
        });
        await this.recordError({
          agentId: state.id,
          projectId: state.projectId,
          ...(state.taskId ? { taskId: state.taskId } : {}),
          operation: 'recovery',
          reason: 'RECOVERY_ENSURE_SESSION_FAILED',
          message,
          observation: { phase: 'recovery-failed' },
          recommendation: 'Inspect or recreate the tmux session, then retry the affected task.',
        });
        await this.safeEmit({
          id: '',
          type: 'human.intervention',
          timestamp: new Date().toISOString(),
          projectId: state.projectId,
          agentId: state.id,
          taskId: state.taskId ?? '',
          data: { phase: 'recovery-failed', error: message },
        });
      }
    }

    for (const c of deferredCleanups) {
      await this.releasePartnersAndDrain(c.failingAgentId, c.failedTaskIds, c.projectIds);
    }
  }

  async reconcileFailedAgent(agentId: string): Promise<boolean> {
    const reconciled = await this.withTaskLock(async () => {
      let projectId = '';
      let timestamp = '';
      let hadBinding = false;
      let changed = false;
      let taskId: string | undefined;

      await this.agentStore.update(agentId, (existing) => {
        if (!existing) return AGENT_STORE_NOOP;
        if (existing.creationToken) return AGENT_STORE_NOOP;
        if (existing.awaitingPhase != null && REGREET_REQUIRED_HOLD_PHASES.has(existing.awaitingPhase)) {
          return AGENT_STORE_NOOP;
        }
        timestamp = new Date().toISOString();
        projectId = existing.projectId;
        hadBinding = !!existing.taskId;
        taskId = existing.taskId;
        if (
          !existing.taskId
          && !existing.worktreePath
          && !existing.startedAt
          && !existing.paneId
          && !existing.creationToken
        ) {
          return AGENT_STORE_NOOP;
        }
        changed = true;
        return {
          id: existing.id,
          projectId: existing.projectId,
          ...(existing.repoPath !== undefined ? { repoPath: existing.repoPath } : {}),
          updatedAt: timestamp,
        };
      });

      if (!projectId || !changed) return null;
      await this.lockManager.release(agentId);
      return { projectId, timestamp, hadBinding, taskId };
    });

    if (!reconciled) return false;
    if (reconciled.hadBinding) {
      await this.failTasksForAgent(agentId, 'tmux-probe=absent');
    }
    await this.recordError({
      agentId,
      projectId: reconciled.projectId,
      ...(reconciled.taskId ? { taskId: reconciled.taskId } : {}),
      operation: 'recovery',
      reason: 'TMUX_SESSION_ABSENT',
      message: 'tmux probe reported the agent session absent',
      occurredAt: reconciled.timestamp,
      observation: { tmuxSessionStatus: 'absent' },
      recommendation: 'Restart the agent runtime before assigning more work.',
    });

    await this.safeEmit({
      id: '',
      type: 'agent.recovered',
      timestamp: reconciled.timestamp,
      projectId: reconciled.projectId,
      agentId,
      data: { reason: 'tmux-probe=absent' },
    });
    return true;
  }

  async cancelTask(taskId: string): Promise<TaskState> {
    let devToRelease: string | undefined;
    let qaToRelease: string | undefined;
    let publishedCleanup: { afterDone: 'pr' | 'branch'; branch: string; prNumber?: number; devAgentId: string; mayBeInFlight: boolean } | undefined;
    this.phaseSignalWatcher?.stop(taskId);
    let cleanupClaimed = false;
    const result = await this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task) throw new ApiError(404, 'Task not found');

      if (TERMINAL_STATUSES.includes(task.status)) return task;

      if (this.markCompleteInFlight.has(taskId)) {
        throw new ApiError(409, `Task ${taskId} is being completed (merge in progress); try again shortly`);
      }

      if (task.agentId) devToRelease = task.agentId;
      if (task.qaAgentId) qaToRelease = task.qaAgentId;
      const publishedAtGate = task.status === 'ready'
        || (task.status === 'approved' && !!task.publishDispatchedAt);
      if (task.reviewMode === 'server' && publishedAtGate && task.agentId) {
        const afterDone = this.resolveAfterDone(task);
        if (afterDone !== null && task.branch) {
          publishedCleanup = {
            afterDone,
            branch: task.branch,
            ...(task.prNumber !== undefined ? { prNumber: task.prNumber } : {}),
            devAgentId: task.agentId,
            mayBeInFlight: task.status === 'approved',
          };
        }
      } else if (task.status === 'merge-ready' && task.prNumber !== undefined && task.branch && task.agentId) {
        publishedCleanup = {
          afterDone: 'pr',
          branch: task.branch,
          prNumber: task.prNumber,
          devAgentId: task.agentId,
          mayBeInFlight: false,
        };
      }

      for (const id of [devToRelease, qaToRelease]) {
        if (id) await this.markPaneCancelClearing(id, taskId);
      }

      const now = new Date().toISOString();
      task.status = 'cancelled';
      task.updatedAt = now;
      await this.taskStore.set(task);

      await this.safeEmit({
        id: '',
        type: 'task.updated',
        timestamp: now,
        projectId: task.projectId,
        taskId,
        data: { status: 'cancelled' },
      });

      this.claimCancelCleanup(taskId);
      cleanupClaimed = true;
      return task;
    });

    let devStopConfirmed = false;
    // 两阶段：先中断全部 pane 再释放任一 binding，避免 dev 先空闲、被派新任务时旧任务的 qa prompt 仍在跑。
    try {
      const stopped: string[] = [];
      for (const id of [devToRelease, qaToRelease]) {
        if (!id) continue;
        const cfg = this.getAgentConfig(id);
        const state = await this.agentStore.get(id);
        if (!cfg || !state || state.taskId !== taskId) {
          console.warn(
            `[AgentManager] cancelTask: ${id} no longer bound to ${taskId} (got ${state?.taskId}); skipping`,
          );
          continue;
        }
        if (!(await this.interruptPaneAndWaitReady(state, cfg))) {
          await this.markAwaitingHuman(
            id,
            'cancel-interrupt-failed',
            'Task marked cancelled but ESC / REPL ready check failed; agent may still be running the cancelled prompt. Attach via web terminal to verify, then Resume or Delete.',
            { expectedTaskId: taskId },
          );
          continue;
        }
        if (id === publishedCleanup?.devAgentId) devStopConfirmed = true;
        stopped.push(id);
      }
      for (const id of stopped) {
        try {
          await this.releaseAgentForTask(id, taskId, 'idle', { allowAwaitingHuman: true, fromCancelCleanup: true });
        } catch (err) {
          console.error(`[AgentManager] cancelTask releaseAgentForTask(${id}) failed:`, err);
        }
      }
    } finally {
      if (cleanupClaimed) this.releaseCancelCleanup(taskId);
    }

    if (publishedCleanup) {
      if (publishedCleanup.mayBeInFlight && !devStopConfirmed) {
        await this.safeEmit({
          id: '',
          type: 'human.intervention',
          timestamp: new Date().toISOString(),
          projectId: result.projectId,
          taskId,
          data: {
            phase: 'cancel-published-artifact-cleanup-skipped',
            afterDone: publishedCleanup.afterDone,
            branch: publishedCleanup.branch,
            ...(publishedCleanup.prNumber !== undefined ? { prNumber: publishedCleanup.prNumber } : {}),
            reason: 'dev pane stop unconfirmed; the publish prompt may still be running and would recreate the remote artifacts',
          },
        });
        return result;
      }
      const project = this.getProjectConfig(result.projectId);
      try {
        if (publishedCleanup.afterDone === 'pr' && publishedCleanup.prNumber !== undefined && project) {
          const close = await this.platformRunner.exec(
            `gh pr close ${publishedCleanup.prNumber} --repo ${shellQuote(repoSlug(project.repo))} ` +
            `--comment ${shellQuote('Task cancelled in baxian; closing the published PR.')} --delete-branch`,
          );
          if (close.exitCode !== 0) throw new Error(close.stderr.trim() || close.stdout.trim());
        } else {
          const dev = this.getAgentConfig(publishedCleanup.devAgentId);
          const state = await this.agentStore.get(publishedCleanup.devAgentId);
          if (dev && state?.repoPath) {
            const del = await this.createRunnerFor(dev).exec(
              `cd ${shellQuote(state.repoPath)} && git push origin --delete ${shellQuote(publishedCleanup.branch)}`,
            );
            if (del.exitCode !== 0) throw new Error(del.stderr.trim() || del.stdout.trim());
          }
        }
      } catch (err) {
        console.warn(`[AgentManager] cancelTask remote retirement failed for ${taskId}:`, err);
        await this.safeEmit({
          id: '',
          type: 'human.intervention',
          timestamp: new Date().toISOString(),
          projectId: result.projectId,
          taskId,
          data: {
            phase: 'cancel-published-artifact-cleanup-failed',
            afterDone: publishedCleanup.afterDone,
            branch: publishedCleanup.branch,
            ...(publishedCleanup.prNumber !== undefined ? { prNumber: publishedCleanup.prNumber } : {}),
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    return result;
  }

  async validateTaskDispatch(
    projectId: string,
    input: { title: string; description: string; preferredAgentId: string },
  ): Promise<void> {
    if (input.preferredAgentId !== '') {
      const cfg = this.getAgentConfig(input.preferredAgentId);
      if (!cfg) {
        throw new ApiError(400, `Unknown agent: ${input.preferredAgentId}`);
      }
      if (cfg.projectId !== projectId) {
        throw new ApiError(400, `Agent ${input.preferredAgentId} not in project ${projectId}`);
      }
      if (cfg.role !== 'dev') {
        throw new ApiError(400, `Agent ${input.preferredAgentId} is not dev role`);
      }
    }
    let previewBytes: number;
    try {
      previewBytes = this.previewPromptBytesForTaskInput(projectId, input);
    } catch (err) {
      if (err instanceof RequiredSkillsMissingError) {
        throw new ApiError(500, err.message);
      }
      throw new ApiError(400, err instanceof Error ? err.message : String(err));
    }
    if (previewBytes > MAX_PROMPT_BYTES_ROUTE_LIMIT) {
      throw new ApiError(
        400,
        `estimated prompt size ${previewBytes} bytes exceeds ${MAX_PROMPT_BYTES_ROUTE_LIMIT} limit; ` +
          `reduce task description or remove some skills from AGENT_PHASES[develop]`,
      );
    }
  }

  async dispatchReviewToQa(taskId: string): Promise<TaskState> {
    const claim = await this.withTaskLock(async () => {
      if (this.manualReviewInFlight.has(taskId)) {
        throw new ApiError(409, `Manual review already in progress for task ${taskId}`);
      }
      if (this.markCompleteInFlight.has(taskId)) {
        throw new ApiError(409, `Task ${taskId} is being completed (merge in progress); try again shortly`);
      }
      const task = await this.taskStore.get(taskId);
      if (!task) throw new ApiError(404, `Task ${taskId} not found`);
      if (task.reviewMode === 'server') {
        throw new ApiError(409, `Task ${taskId} uses server review mode; legacy Call review is not applicable`);
      }
      if (task.phase === 'spec' && task.status === 'max_rounds') {
        throw new ApiError(409, `Call review is not supported for spec-phase max_rounds tasks (use Retry or Cancel)`);
      }
      if (!task.prNumber) {
        throw new ApiError(400, `Task ${taskId} has no PR yet; cannot dispatch review`);
      }
      if (!task.branch) {
        throw new ApiError(400, `Task ${taskId} has no branch; cannot dispatch review`);
      }
      let qaId = task.qaAgentId;
      if (qaId && !this.getAgentConfig(qaId)) {
        console.warn(
          `[dispatchReviewToQa] task ${taskId}.qaAgentId="${qaId}" no longer in config; ` +
          `falling back to findQaPartner(${task.agentId})`,
        );
        qaId = undefined;
      }
      if (!qaId) {
        const qa = this.findQaPartner(task.agentId);
        if (!qa) {
          throw new ApiError(
            400,
            `Dev ${task.agentId} has no QA partner configured; cannot dispatch review`,
          );
        }
        qaId = qa.id;
      }
      this.manualReviewInFlight.add(taskId);
      return { qaId, devAgentId: task.agentId, taskStatusAtClaim: task.status };
    });

    try {
      const { qaId, devAgentId, taskStatusAtClaim } = claim;
      const isTerminal = TERMINAL_STATUSES.includes(taskStatusAtClaim);
      const qaPhase: 'review' | 'recheck' =
        taskStatusAtClaim === 'pending' || taskStatusAtClaim === 'in_progress'
          ? 'review'
          : 'recheck';

      const prevQa = await this.agentStore.get(qaId);
      if (prevQa?.taskId === taskId) {
        await this.releaseAgentForTask(qaId, taskId, 'idle');
      }

      const acquired = await this.acquireAgentForTask(qaId, taskId, qaPhase);
      if (!acquired) {
        throw new ApiError(409, `QA agent ${qaId} is busy or unavailable`);
      }

      let devParked = false;
      if (!isTerminal && devAgentId) {
        const devState = await this.agentStore.get(devAgentId);
        if (devState?.taskId === taskId) {
          const devOk = await this.markAgentWaiting(devAgentId, taskId)
            .catch(err => {
              console.warn(`[dispatchReviewToQa] markAgentWaiting(dev=${devAgentId}) threw:`, err);
              return false;
            });
          if (!devOk) {
            await this.releaseAgentForTask(qaId, taskId, 'idle')
              .catch(() => undefined);
            throw new ApiError(
              500,
              `Cannot park dev ${devAgentId} into waiting for manual QA review (task status=${taskStatusAtClaim}); QA released`,
            );
          }
          devParked = true;
        }
      }

      const pre = await this.taskStore.get(taskId);
      const snapshot: DispatchReviewSnapshot = {
        qaAgentId: pre?.qaAgentId,
        signalToken: pre?.signalToken,
        reviewHeadAnchorSha: pre?.reviewHeadAnchorSha,
        reviewDispatchedAt: pre?.reviewDispatchedAt,
      };

      const isTerminalAtClaim = TERMINAL_STATUSES.includes(taskStatusAtClaim);
      if (!isTerminalAtClaim) {
        const reviewAnchor = await this.fetchPrHeadSha(taskId).catch(() => undefined);
        const preDispatched = await this.transitionTaskStatus(
          taskId,
          'review',
          { fromStatus: [taskStatusAtClaim] },
          {
            reviewHeadAnchorSha: reviewAnchor,
            reviewDispatchedAt: new Date().toISOString(),
            signalToken: createSignalToken(),
          },
        );
        if (!preDispatched) {
          await this.releaseAgentForTask(qaId, taskId, 'idle').catch(() => undefined);
          if (devParked) await this.emitManualReviewDevParkedQaFailedIntervention(devAgentId, taskId);
          throw new ApiError(409, `Task ${taskId} status changed during dispatch; cannot enter review`);
        }
      }
      await this.withTaskLock(async () => {
        const fresh = await this.taskStore.get(taskId);
        if (!fresh) return;
        await this.taskStore.set({
          ...fresh,
          reviewRound: fresh.reviewRound + 1,
          qaAgentId: qaId,
          updatedAt: new Date().toISOString(),
        });
      });

      const { armed } = await this.rotateAndSetupPhaseSignal(
        taskId,
        qaId,
        ['pr-approved', 'pr-changes-requested'] as const,
      );
      if (!armed) {
        await this.rollbackDispatchReviewPhase1(taskId, taskStatusAtClaim, isTerminalAtClaim, snapshot);
        await this.releaseAgentForTask(qaId, taskId, 'idle').catch(() => undefined);
        if (devParked) await this.emitManualReviewDevParkedQaFailedIntervention(devAgentId, taskId);
        throw new ApiError(500, `Failed to arm review verdict watcher for ${taskId}`);
      }

      let started = false;
      try {
        started = await this.startSession(taskId, qaId, qaPhase, {
          bypassTaskStatusGate: true,
          dialogFailFromStatuses: [isTerminalAtClaim ? taskStatusAtClaim : 'review'],
        });
      } catch (err) {
        if (await this.markAwaitingIfAckUnknown(qaId, err, taskId)) {
        } else if (err instanceof EnsureSessionError && err.partial.handled) {
        } else {
          await this.rollbackDispatchReviewPhase1(taskId, taskStatusAtClaim, isTerminalAtClaim, snapshot);
          await this.releaseAgentForTask(qaId, taskId, 'idle')
            .catch(() => undefined);
          if (devParked) await this.emitManualReviewDevParkedQaFailedIntervention(devAgentId, taskId);
        }
        throw err;
      }
      if (!started) {
        await this.rollbackDispatchReviewPhase1(taskId, taskStatusAtClaim, isTerminalAtClaim, snapshot);
        await this.releaseAgentForTask(qaId, taskId, 'idle')
          .catch(() => undefined);
        if (devParked) await this.emitManualReviewDevParkedQaFailedIntervention(devAgentId, taskId);
        throw new ApiError(500, `Failed to start QA review session for ${taskId}`);
      }

      const final = await this.taskStore.get(taskId);
      return final!;
    } finally {
      this.manualReviewInFlight.delete(taskId);
    }
  }

  async continueDevRound(taskId: string): Promise<TaskState> {
    if (this.markCompleteInFlight.has(taskId)) {
      throw new ApiError(409, `Task ${taskId} is being completed (merge in progress); try again shortly`);
    }
    const task = await this.taskStore.get(taskId);
    if (!task) throw new ApiError(404, `Task ${taskId} not found`);
    if (task.status !== 'max_rounds') {
      throw new ApiError(409, `Task ${taskId} is not at max_rounds (status=${task.status})`);
    }
    if (task.phase === 'spec') {
      throw new ApiError(409, `Continue one round is only supported for code-phase tasks`);
    }
    if (task.reviewMode === 'server') {
      if (!task.agentId) {
        throw new ApiError(400, `Task ${taskId} has no dev agent; cannot continue`);
      }
      const stored = await this.reviewStore?.getRound(taskId, 'code', Math.max(task.reviewRound, 1));
      if (!stored?.findings) {
        throw new ApiError(409, `Task ${taskId} has no stored findings to continue from; cancel instead`);
      }
      await this.withTaskLock(async () => {
        if (this.markCompleteInFlight.has(taskId)) {
          throw new ApiError(409, `Task ${taskId} is being completed (merge in progress); try again shortly`);
        }
        const fresh = await this.taskStore.get(taskId);
        if (!fresh || fresh.status !== 'max_rounds') {
          throw new ApiError(409, `Task ${taskId} is not at max_rounds (status=${fresh?.status ?? 'gone'})`);
        }
        fresh.maxRoundsContinues = (fresh.maxRoundsContinues ?? 0) + 1;
        fresh.updatedAt = new Date().toISOString();
        await this.taskStore.set(fresh);
      });
      let dispatched: TaskState | null = null;
      try {
        dispatched = await this.dispatchServerFixToDev(taskId, JSON.stringify(stored.findings));
      } finally {
        if (!dispatched) {
          await this.withTaskLock(async () => {
            const fresh = await this.taskStore.get(taskId);
            if (!fresh) return;
            fresh.maxRoundsContinues = Math.max(0, (fresh.maxRoundsContinues ?? 0) - 1);
            fresh.updatedAt = new Date().toISOString();
            await this.taskStore.set(fresh);
          }).catch(() => undefined);
        }
      }
      if (!dispatched) {
        throw new ApiError(500, `Failed to dispatch server fix round for task ${taskId}`);
      }
      return dispatched;
    }
    if (!task.prNumber || !task.branch) {
      throw new ApiError(400, `Task ${taskId} has no PR/branch; cannot continue`);
    }
    if (!task.agentId) {
      throw new ApiError(400, `Task ${taskId} has no dev agent; cannot continue`);
    }
    const devAgentId = task.agentId;
    const devState = await this.agentStore.get(devAgentId);
    if (devState?.taskId !== taskId || !devState.worktreePath) {
      throw new ApiError(
        409,
        `Dev ${devAgentId} no longer holds task ${taskId}'s reserved worktree (cannot continue); ` +
        `use mark-complete to merge the PR as-is, or cancel the task`,
      );
    }

    const prevReviewRound = task.reviewRound;
    const transitioned = await this.transitionTaskStatus(
      taskId,
      'fixing',
      { fromStatus: ['max_rounds'] },
      { reviewRound: prevReviewRound + 1, fixDispatchedAt: new Date().toISOString() },
    );
    if (!transitioned) {
      throw new ApiError(409, `Task ${taskId} changed status during continue; aborted`);
    }

    const rollback = async () => {
      await this.transitionTaskStatus(
        taskId,
        'max_rounds',
        { fromStatus: ['fixing'] },
        { reviewRound: prevReviewRound },
      ).catch(() => undefined);
    };

    const acquired = await this.acquireAgentForTask(devAgentId, taskId, 'fix');
    if (!acquired) {
      await rollback();
      throw new ApiError(409, `Dev ${devAgentId} is no longer available for task ${taskId}`);
    }

    const { armed } = await this.rotateAndSetupPhaseSignal(taskId, devAgentId, 'pr-fixed');
    if (!armed) {
      await this.markAwaitingHuman(
        devAgentId,
        'signal-arm-failed:pr-fixed',
        'pr-fixed watcher failed to arm; the fix was not dispatched (its completion signal would have no consumer). Cancel the task or delete the agent to retry.',
        { expectedTaskId: taskId },
      );
      await rollback();
      throw new ApiError(500, `Failed to arm pr-fixed watcher for task ${taskId}`);
    }

    const rollbackAndRepark = async () => {
      await rollback();
      await this.markAgentWaiting(devAgentId, taskId).catch(() => undefined);
    };

    let resumed = false;
    try {
      resumed = await this.continueSession(taskId, devAgentId, 'fix');
    } catch (err) {
      if (err instanceof DispatchTerminalError) {
        await this.failTaskForDispatchError(taskId, 'fix', devAgentId, err);
        throw new ApiError(500, `Continue dispatch failed: ${err.message}`);
      }
      await rollbackAndRepark();
      throw err;
    }
    if (!resumed) {
      await rollbackAndRepark();
      throw new ApiError(500, `Failed to dispatch fix to dev ${devAgentId} for task ${taskId}`);
    }

    const fresh = await this.taskStore.get(taskId);
    return fresh!;
  }

  private async rollbackDispatchReviewPhase1(
    taskId: string,
    originalStatus: TaskStatus,
    isTerminalAtClaim: boolean,
    snapshot: DispatchReviewSnapshot,
  ): Promise<void> {
    await this.withTaskLock(async () => {
      const fresh = await this.taskStore.get(taskId);
      if (!fresh) return;
      const next: TaskState = {
        ...fresh,
        reviewRound: Math.max(0, fresh.reviewRound - 1),
        qaAgentId: snapshot.qaAgentId,
        signalToken: snapshot.signalToken,
        reviewDispatchedAt: snapshot.reviewDispatchedAt,
        updatedAt: new Date().toISOString(),
      };
      if (!isTerminalAtClaim) {
        next.status = originalStatus;
        next.reviewHeadAnchorSha = snapshot.reviewHeadAnchorSha;
      }
      await this.taskStore.set(next);
    });

    if (!this.phaseSignalWatcher) return;

    if (originalStatus === 'approved') {
      const completion = await this.postApproveStore.get(taskId);
      const task = await this.taskStore.get(taskId);
      if (completion && task) {
        try {
          await this.phaseSignalWatcher.start({
            taskId,
            projectId: task.projectId,
            agentId: task.agentId,
            expectedKinds: 'pr-merge-ready',
            token: completion.token,
          });
        } catch (err) {
          console.warn(
            `[AgentManager] rollback: re-establish pr-merge-ready failed for task=${taskId}:`,
            err,
          );
        }
        return;
      }
    }

    const restored = await this.taskStore.get(taskId);
    if (!restored || !restored.signalToken) return;
    const mapped = this.mapTaskStateToExpectedWatcher(restored);
    if (!mapped) return;
    try {
      await this.phaseSignalWatcher.start({
        taskId,
        projectId: restored.projectId,
        agentId: mapped.agentId,
        expectedKinds: mapped.expectedKinds,
        token: restored.signalToken,
      });
    } catch (err) {
      console.warn(
        `[AgentManager] rollback: re-establish ${mapped.expectedKinds.join(',')} failed for task=${taskId}:`,
        err,
      );
    }
  }

  private devInitialSignalKinds(reviewMode?: TaskState['reviewMode']): readonly PhaseSignalKind[] {
    const mode = reviewMode ?? this.config.review.mode ?? 'github';
    return mode === 'server'
      ? (['spec-done', 'code-done'] as const)
      : (['spec-done', 'pr-created'] as const);
  }

  private mapTaskStateToExpectedWatcher(task: TaskState): {
    expectedKinds: readonly PhaseSignalKind[];
    agentId: string;
  } | undefined {
    if (task.reviewMode === 'server') return this.mapServerTaskToExpectedWatcher(task);
    if (task.phase === 'spec' && task.status === 'review' && task.qaAgentId) {
      return { expectedKinds: ['spec-reviewed'], agentId: task.qaAgentId };
    }
    if (task.phase === 'spec' && task.status === 'fixing' && task.agentId) {
      return { expectedKinds: ['spec-fixed'], agentId: task.agentId };
    }
    if (task.phase !== 'spec' && task.status === 'fixing' && task.agentId) {
      return { expectedKinds: ['pr-fixed'], agentId: task.agentId };
    }
    if (task.phase === undefined && task.status === 'in_progress' && task.agentId) {
      return { expectedKinds: ['spec-done', 'pr-created'], agentId: task.agentId };
    }
    if (task.phase === 'code' && task.status === 'in_progress' && task.agentId) {
      return { expectedKinds: ['pr-created'], agentId: task.agentId };
    }
    if (task.phase !== 'spec' && task.status === 'review' && task.qaAgentId) {
      return { expectedKinds: ['pr-approved', 'pr-changes-requested'], agentId: task.qaAgentId };
    }
    return undefined;
  }

  private mapServerTaskToExpectedWatcher(task: TaskState): {
    expectedKinds: readonly PhaseSignalKind[];
    agentId: string;
  } | undefined {
    const isSpec = task.phase === 'spec';
    if (task.status === 'review' && task.qaAgentId) {
      return { expectedKinds: [isSpec ? 'spec-reviewed' : 'code-reviewed'], agentId: task.qaAgentId };
    }
    if (task.status === 'fixing' && task.agentId) {
      return { expectedKinds: [isSpec ? 'spec-fixed' : 'code-fixed'], agentId: task.agentId };
    }
    if (task.status === 'in_progress' && task.agentId) {
      if (task.phase === 'code') return { expectedKinds: ['code-done'], agentId: task.agentId };
      return { expectedKinds: ['spec-done', 'code-done'], agentId: task.agentId };
    }
    if (task.status === 'approved' && task.agentId) {
      return { expectedKinds: ['code-ready'], agentId: task.agentId };
    }
    return undefined;
  }

  async setupPhaseSignal(
    taskId: string,
    agentId: string,
    expectedKinds: PhaseSignalKind | readonly PhaseSignalKind[],
    opts: { skipSnapshot?: boolean } = {},
  ): Promise<boolean> {
    const task = await this.taskStore.get(taskId);
    if (!task?.signalToken) return false;
    return this.setupPhaseSignalWatcher(taskId, agentId, expectedKinds, task.signalToken, opts.skipSnapshot);
  }

  private async emitManualReviewDevParkedQaFailedIntervention(
    agentId: string | undefined,
    expectedTaskId: string,
  ): Promise<void> {
    if (!agentId) return;
    const cur = await this.agentStore.get(agentId);
    if (!cur || cur.taskId !== expectedTaskId) return;
    await this.safeEmit({
      id: '',
      type: 'human.intervention',
      timestamp: new Date().toISOString(),
      projectId: cur.projectId,
      agentId,
      taskId: expectedTaskId,
      data: {
        phase: 'manual-review-dev-parked-qa-failed',
        note:
          'Manual QA dispatch parked the dev agent into waiting; QA then failed to start. ' +
          'Dev binding is kept but no new prompt is running — re-dispatch the manual review or cancel the task.',
      },
    });
  }

  async retryTask(taskId: string): Promise<TaskState> {
    const old = await this.withTaskLock(async () => {
      const t = await this.taskStore.get(taskId);
      if (!t) throw new ApiError(404, 'Task not found');
      const retryable =
        TERMINAL_STATUSES.includes(t.status)
        || (t.status === 'max_rounds' && t.phase === 'spec');
      if (!retryable) {
        throw new ApiError(
          409,
          `Task ${taskId} cannot be retried in status "${t.status}"; cancel it first or wait for completion`,
        );
      }
      return t;
    });
    const input: {
      title: string;
      description: string;
      preferredAgentId: string;
      images?: { bytes: Buffer; ext: string }[];
    } = {
      title: old.title,
      description: old.description,
      preferredAgentId: old.preferredAgentId,
    };
    if (old.images?.length) {
      input.images = await this.readStagedImages(old.id, old.images);
    }
    await this.validateTaskDispatch(old.projectId, input);
    if (!TERMINAL_STATUSES.includes(old.status)) {
      await this.cancelTask(old.id);
    }
    return this.createAndStartTask(old.projectId, input);
  }

  async editTask(
    taskId: string,
    patch: { title?: string; description?: string; preferredAgentId?: string },
  ): Promise<TaskState> {
    return this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task) throw new ApiError(404, 'Task not found');
      if (task.status !== 'pending') {
        throw new ApiError(409, `Task not editable in status ${task.status}`);
      }

      if (patch.title !== undefined) task.title = patch.title;
      if (patch.description !== undefined) task.description = patch.description;
      if (patch.preferredAgentId !== undefined && patch.preferredAgentId !== task.preferredAgentId) {
        if (patch.preferredAgentId === '') {
          task.preferredAgentId = '';
          delete task.qaAgentId;
        } else {
          const cfg = this.getAgentConfig(patch.preferredAgentId);
          if (!cfg) throw new ApiError(400, `Unknown agent: ${patch.preferredAgentId}`);
          if (cfg.projectId !== task.projectId) {
            throw new ApiError(400, `Agent not in project ${task.projectId}`);
          }
          if (cfg.role !== 'dev') throw new ApiError(400, `Agent is not dev role`);
          task.preferredAgentId = patch.preferredAgentId;
          const qaId = this.findQaPartner(patch.preferredAgentId)?.id;
          if (qaId) {
            task.qaAgentId = qaId;
          } else {
            delete task.qaAgentId;
          }
        }
      }

      task.updatedAt = new Date().toISOString();
      await this.taskStore.set(task);

      return task;
    });
  }

  async mergePr(taskId: string, opts: MergePrOpts = {}): Promise<void> {
    const task = await this.taskStore.get(taskId);
    if (!task || !task.prNumber) {
      throw new Error(`mergePr: no PR number for task ${taskId}`);
    }
    const project = this.getProjectConfig(task.projectId);
    if (!project) {
      throw new Error(`mergePr: unknown project ${task.projectId}`);
    }
    const matchHead = opts.matchHeadSha
      ? ` --match-head-commit ${shellQuote(opts.matchHeadSha)}`
      : '';
    const result = await this.platformRunner.exec(
      `gh pr merge ${task.prNumber} --repo ${shellQuote(repoSlug(project.repo))}${matchHead} --squash --delete-branch`,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `gh pr merge failed for PR #${task.prNumber}: ${result.stderr || result.stdout}`,
      );
    }
  }

  async markTaskComplete(taskId: string): Promise<TaskState> {
    const peek = await this.taskStore.get(taskId);
    if (!peek) throw new ApiError(404, `Task ${taskId} not found`);
    if (peek.status === 'ready' || peek.status === 'merge-ready') {
      return this.confirmHumanGate(taskId);
    }

    const task = await this.claimCompleteGate(taskId, ['max_rounds', 'approved']);
    try {
      const serverApprovedRetry = task.status === 'approved' && task.reviewMode === 'server';
      if (!serverApprovedRetry && task.status !== 'max_rounds') {
        throw new ApiError(409, `Task ${taskId} is not at max_rounds (status=${task.status})`);
      }
      if (task.phase === 'spec') {
        throw new ApiError(409, `Mark complete is only supported for code-phase tasks`);
      }
      if (task.reviewMode !== 'server' && (!task.prNumber || !task.branch)) {
        throw new ApiError(400, `Task ${taskId} has no PR/branch; cannot mark complete`);
      }
      if (serverApprovedRetry) {
        const publishState = this.checkPublishInFlight(taskId, task.publishDispatchedAt);
        if (publishState === 'live') {
          throw new ApiError(409, `Task ${taskId} publish is in flight; retry only after it fails`);
        }
        if (publishState === 'delivered') {
          throw new ApiError(
            409,
            `Task ${taskId} publish was delivered and is awaiting code-ready; ` +
            `retry only after it fails (if the publish is verifiably dead, Cancel the task)`,
          );
        }
        const afterDone = this.resolveAfterDone(task);
        if (afterDone === null) {
          throw new ApiError(409, `Task ${taskId} is approved with no afterDone step; nothing to retry`);
        }
        await this.dispatchServerAfterDone(taskId, afterDone);
        return (await this.taskStore.get(taskId))!;
      }
      if (task.reviewMode === 'server') {
        const afterDone = this.coerceAfterDone(task.projectId, this.config.review.afterDone);
        await this.updateTask(taskId, { afterDone });
        if (afterDone === null) {
          const done = await this.transitionTaskStatus(taskId, 'done', { fromStatus: ['max_rounds'] });
          if (!done) throw new ApiError(409, `Task ${taskId} changed status during mark-complete; aborted`);
          await this.releaseTaskAgents(taskId);
          return (await this.taskStore.get(taskId))!;
        }
        const approved = await this.transitionTaskStatus(taskId, 'approved', { fromStatus: ['max_rounds'] });
        if (!approved) throw new ApiError(409, `Task ${taskId} changed status during mark-complete; aborted`);
        await this.dispatchServerAfterDone(taskId, afterDone);
        return (await this.taskStore.get(taskId))!;
      }
      for (const agentId of [task.agentId, task.qaAgentId]) {
        if (!agentId) continue;
        const state = await this.agentStore.get(agentId);
        if (state?.status === 'awaiting_human' && state.taskId === taskId) {
          throw new ApiError(
            409,
            `Agent ${agentId} is awaiting human intervention on this task; resume/restart/delete it before marking complete`,
          );
        }
      }

      const claimed = await this.transitionTaskStatus(
        taskId,
        'merge-ready',
        { fromStatus: ['max_rounds'] },
      );
      if (!claimed) {
        throw new ApiError(409, `Task ${taskId} changed status during mark-complete; aborted`);
      }

      try {
        await this.mergePr(taskId);
      } catch (err) {
        await this.transitionTaskStatus(taskId, 'max_rounds', { fromStatus: ['merge-ready'] })
          .catch(() => undefined);
        const message = err instanceof Error ? err.message : String(err);
        throw new ApiError(409, `Merge failed for task ${taskId}: ${message}`);
      }

      await this.eventBus.emit({
        id: '',
        type: 'pr.merged',
        timestamp: new Date().toISOString(),
        projectId: task.projectId,
        agentId: task.agentId,
        taskId: task.id,
        data: {
          prNumber: task.prNumber,
          ...(task.prUrl ? { prUrl: task.prUrl } : {}),
        },
      });

      const fresh = await this.taskStore.get(taskId);
      return fresh!;
    } finally {
      this.markCompleteInFlight.delete(taskId);
    }
  }

  async cleanupAfterMerge(taskId: string): Promise<void> {
    const task = await this.taskStore.get(taskId);
    if (!task || !task.agentId) return;
    const dev = this.getAgentConfig(task.agentId);
    if (!dev) return;
    this.phaseSignalWatcher?.stop(taskId);
    if (task.prNumber && task.branch) {
      const ctx: PostMergeCleanupContext = {
        taskId: task.id,
        branch: task.branch,
      };
      await this.dispatchPostMergeCleanup(task.agentId, ctx).catch(err =>
        console.warn(
          `[AgentManager] cleanupAfterMerge: dispatchPostMergeCleanup(${task.agentId}) failed:`,
          err,
        ),
      );
    } else {
      await this.releaseAgentForTask(task.agentId, taskId, 'idle').catch(err =>
        console.warn(
          `[AgentManager] cleanupAfterMerge: releaseAgentForTask(${task.agentId}, ${taskId}) failed:`,
          err,
        ),
      );
    }
  }

  async dispatchPostMergeCleanup(
    agentId: string,
    ctx: PostMergeCleanupContext,
  ): Promise<void> {
    const agent = this.getAgentConfig(agentId);
    if (!agent) return;
    const state = await this.agentStore.get(agentId);
    if (!state) return;
    if (state.taskId && state.taskId !== ctx.taskId) return;
    if (state.creationToken) return;
    if (state.status === 'awaiting_human') return;
    if (!state.paneId) {
      await this.releasePostMergeAgent(agentId, ctx.taskId);
      return;
    }

    if (!state.taskId) {
      await this.agentStore.update(agentId, (existing) => {
        if (!existing) return AGENT_STORE_NOOP;
        if (existing.taskId && existing.taskId !== ctx.taskId) return AGENT_STORE_NOOP;
        if (existing.creationToken) return AGENT_STORE_NOOP;
        if (existing.status === 'awaiting_human') return AGENT_STORE_NOOP;
        if (existing.paneId !== state.paneId) return AGENT_STORE_NOOP;
        return { ...existing, taskId: ctx.taskId, updatedAt: new Date().toISOString() };
      });
      const fresh = await this.agentStore.get(agentId);
      if (fresh?.taskId !== ctx.taskId) return;
    }

    await this.removeMergedWorktree(agent, agentId, ctx.taskId);

    const runner = this.createRunnerFor(agent);
    if (state.repoPath) {
      await this.deleteLocalBranchInRepo(runner, state.repoPath, ctx.branch, agentId);
    } else {
      console.warn(
        `[AgentManager] dispatchPostMergeCleanup(${agentId}): no repoPath on binding; skipping local ` +
        `branch delete for ${ctx.branch} (it may linger locally)`,
      );
    }

    const tmux = new TmuxManager(runner);
    const runtime = agentRuntimeKindFor(agent);
    void this.runPostMergeCompaction(tmux, state.paneId, agentId, ctx.taskId, runtime).catch(err =>
      console.warn(`[AgentManager] runPostMergeCompaction(${agentId}) failed:`, err),
    );
  }

  private async releasePostMergeAgent(agentId: string, taskId: string): Promise<void> {
    const state = await this.agentStore.get(agentId);
    if (state?.taskId !== taskId) return;
    try {
      await this.releaseAgentForTask(agentId, taskId, 'idle');
    } catch (err) {
      console.warn(
        `[AgentManager] releasePostMergeAgent: releaseAgentForTask(${agentId}, ${taskId}) failed:`,
        err,
      );
    }
  }

  private async removeMergedWorktree(
    cfg: AgentConfig,
    agentId: string,
    expectedTaskId: string,
  ): Promise<void> {
    await this.withTaskLock(async () => {
      const state = await this.agentStore.get(agentId);
      if (!state || state.taskId !== expectedTaskId || !state.worktreePath) return;
      const cleanupDir = this.resolveWorkdir(cfg, state);
      if (cleanupDir) {
        const runner = this.createRunnerFor(cfg);
        const worktree = new WorktreeManager(runner);
        try {
          await worktree.remove(cleanupDir, state.worktreePath);
        } catch (err) {
          console.warn(
            `[AgentManager] removeMergedWorktree worktree.remove failed for ${state.worktreePath}:`,
            err,
          );
        }
      }
      const now = new Date().toISOString();
      await this.agentStore.update(agentId, (existing) => {
        if (!existing || existing.taskId !== expectedTaskId) return AGENT_STORE_NOOP;
        const next: AgentBindingFacts = { ...existing, updatedAt: now };
        delete next.worktreePath;
        return next;
      });
    });
  }

  private async deleteLocalBranchInRepo(
    runner: CommandRunner,
    repoPath: string,
    branch: string,
    agentId: string,
  ): Promise<void> {
    const fetchCmd =
      `cd ${shellQuote(repoPath)} && git fetch --prune origin && git worktree prune --expire=now`;
    try {
      const fetchResult = await runner.exec(fetchCmd, { timeout: this.postMergeFetchTimeoutMs });
      if (fetchResult.exitCode !== 0) {
        console.warn(
          `[AgentManager] deleteLocalBranchInRepo(${agentId}, ${branch}): fetch/prune exit=${fetchResult.exitCode} ` +
          `stderr=${fetchResult.stderr.trim()}`,
        );
      }
    } catch (err) {
      console.warn(`[AgentManager] deleteLocalBranchInRepo(${agentId}, ${branch}) fetch/prune threw:`, err);
    }

    const delCmd = `cd ${shellQuote(repoPath)} && git branch -D ${shellQuote(branch)}`;
    try {
      const delResult = await runner.exec(delCmd, { timeout: this.postMergeBranchTimeoutMs });
      if (delResult.exitCode !== 0 && !/not found|not a valid|no such branch/i.test(delResult.stderr)) {
        console.warn(
          `[AgentManager] deleteLocalBranchInRepo(${agentId}, ${branch}): branch -D exit=${delResult.exitCode} ` +
          `stderr=${delResult.stderr.trim()}`,
        );
      }
    } catch (err) {
      console.warn(`[AgentManager] deleteLocalBranchInRepo(${agentId}, ${branch}) branch -D threw:`, err);
    }
  }

  private async runPostMergeCompaction(
    tmux: TmuxManager,
    paneId: string,
    agentId: string,
    originalTaskId: string,
    runtime: AgentRuntimeKind,
  ): Promise<void> {
    await this.acquireCompactGuard(agentId);
    try {
      await this.runPostMergeCompactionSteps(tmux, paneId, agentId, originalTaskId, runtime);
    } finally {
      this.compactInFlight.delete(agentId);
    }
  }

  private async acquireCompactGuard(agentId: string): Promise<void> {
    while (!this.tryAcquireCompactGuard(agentId)) {
      await new Promise(r => setTimeout(r, this.compactIdlePollMs));
    }
  }

  private async acquireCompactGuardWithin(agentId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.tryAcquireCompactGuard(agentId)) {
      if (Date.now() >= deadline) return false;
      await new Promise(r => setTimeout(r, this.compactIdlePollMs));
    }
    return true;
  }

  private tryAcquireCompactGuard(agentId: string): boolean {
    if (this.compactInFlight.has(agentId)) return false;
    this.compactInFlight.add(agentId);
    return true;
  }

  private async runPostMergeCompactionSteps(
    tmux: TmuxManager,
    paneId: string,
    agentId: string,
    originalTaskId: string,
    runtime: AgentRuntimeKind,
  ): Promise<void> {
    const bindingStillOurs = async (): Promise<boolean> => {
      const s = await this.agentStore.get(agentId);
      return !!s && s.taskId === originalTaskId && s.paneId === paneId;
    };
    if (!await bindingStillOurs()) return;

    let cleared = false;
    try {
      cleared = await this.sendPostMergeSlashCommand(tmux, paneId, agentId, runtime, bindingStillOurs);
    } catch (err) {
      console.warn(`[AgentManager] runPostMergeCompaction(${agentId}) /clear failed:`, err);
    }
    if (!cleared) {
      if (await this.recoverPostMergeExitedRuntime(tmux, paneId, agentId, originalTaskId, runtime)) {
        cleared = true;
      } else if (!await bindingStillOurs()) {
        return;
      } else if (!await this.clearComposerForReuse(tmux, paneId, agentId)) {
        return;
      }
    }
    await this.releasePostMergeAgent(agentId, originalTaskId);
  }

  private async recoverPostMergeExitedRuntime(
    tmux: TmuxManager,
    paneId: string,
    agentId: string,
    taskId: string,
    runtime: AgentRuntimeKind,
  ): Promise<boolean> {
    let paneExists = true;
    try {
      if (hasReplProcTitle(await tmux.displayMessage(paneId, '#{pane_current_command}'), runtime)) return false;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (!/no server running|session not found|can't find (?:pane|session)|no such (?:pane|session)/i.test(detail)) {
        return false;
      }
      paneExists = false;
    }
    const state = await this.agentStore.get(agentId);
    if (!state || state.taskId !== taskId || state.paneId !== paneId) return false;
    try {
      if (paneExists) await tmux.sendKeysToPane(paneId, 'C-c');
      const ensure = await this.ensureSession(agentId, 'runtime');
      if (!ensure.freshRuntime) return false;
      await this.agentStore.update(agentId, (existing) => {
        if (!existing || existing.taskId !== taskId) return AGENT_STORE_NOOP;
        if (existing.paneId === ensure.paneId && existing.repoPath === ensure.workdir) {
          return AGENT_STORE_NOOP;
        }
        return {
          ...existing,
          paneId: ensure.paneId,
          repoPath: ensure.workdir,
          updatedAt: new Date().toISOString(),
        };
      });
      const current = await this.agentStore.get(agentId);
      return current?.taskId === taskId && current.paneId === ensure.paneId;
    } catch (err) {
      console.warn(`[AgentManager] recoverPostMergeExitedRuntime(${agentId}, ${taskId}) failed:`, err);
      return false;
    }
  }

  private async sendPostMergeSlashCommand(
    tmux: TmuxManager,
    paneId: string,
    agentId: string,
    runtime: AgentRuntimeKind,
    bindingStillOurs: () => Promise<boolean>,
  ): Promise<boolean> {
    let rejection: Error | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (!await bindingStillOurs()) return false;
      await tmux.clearComposerDraft(paneId);
      await this.waitForReplPromptReady(tmux, paneId, runtime, this.compactIdleWaitMs);
      if (!await bindingStillOurs()) return false;
      await tmux.sendKeysLiteral(paneId, '/clear');
      await tmux.sendEnter(paneId);
      await new Promise(r => setTimeout(r, this.compactIdlePollMs));
      await this.waitForReplPromptReady(tmux, paneId, runtime, this.compactIdleWaitMs);
      if (!await bindingStillOurs()) return false;

      if (!await this.hasRuntimeSlashCommandRejection(tmux, paneId, '/clear')) return true;

      rejection = new Error('runtime rejected /clear because a task is still in progress');
      if (attempt < 2) {
        console.warn(`[AgentManager] runPostMergeCompaction(${agentId}) /clear rejected; retrying`);
        await new Promise(r => setTimeout(r, this.compactIdlePollMs));
      }
    }
    throw rejection ?? new Error('runtime rejected /clear');
  }

  private async hasRuntimeSlashCommandRejection(
    tmux: TmuxManager,
    paneId: string,
    command: '/compact' | '/clear',
  ): Promise<boolean> {
    const cap = await tmux.capturePaneById(paneId, { ansi: false, scrollback: 0 });
    return this.runtimeSlashCommandRejectedPattern(command).test(cap);
  }

  private runtimeSlashCommandRejectedPattern(command: '/compact' | '/clear'): RegExp {
    return new RegExp(`["'“”‘’]?${command}["'“”‘’]?\\s+is disabled while a task is in progress\\.`, 'gi');
  }

  private async waitForReplPromptReady(
    tmux: TmuxManager,
    paneId: string,
    runtime: AgentRuntimeKind,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    await tmux.waitReplReady(paneId, runtime, {
      timeoutMs,
      intervalMs: this.compactIdlePollMs,
    });
    await new Promise(r => setTimeout(r, this.compactIdlePollMs));
    while (true) {
      const current = await tmux.displayMessage(paneId, '#{pane_current_command}');
      if (!hasReplProcTitle(current, runtime)) {
        throw new Error(`waitForReplPromptReady: pane ${paneId} pane_current_command=${current.trim()} (not runtime, REPL may have exited)`);
      }
      const cap = await tmux.capturePaneById(paneId, { ansi: false, scrollback: 0 });
      const ready = hasRuntimeReadyView(cap, runtime);
      if (detectRuntimeMenu(cap) || (!ready && detectStartupDialog(cap, runtime))) {
        throw new Error(`waitForReplPromptReady: pane ${paneId} shows menu/dialog, not a ready REPL prompt`);
      }
      if (!runtimeBusyCheck(cap, runtime)) {
        if (!ready) {
          throw new Error(`waitForReplPromptReady: pane ${paneId} observed idle but no ready anchor (stale frame?)`);
        }
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(`waitForReplPromptReady: pane ${paneId} stayed busy past ${timeoutMs}ms`);
      }
      await new Promise(r => setTimeout(r, this.compactIdlePollMs));
    }
  }

  stopPhaseSignalWatcher(taskId: string): void {
    this.phaseSignalWatcher?.stop(taskId);
  }

  private checkPublishInFlight(taskId: string, publishDispatchedAt: string | undefined): 'live' | 'delivered' | false {
    if (this.phaseSignalWatcher?.expectedKindsFor(taskId).has('code-ready')) {
      if (!this.phaseSignalWatcher.isRecovered(taskId) || publishDispatchedAt) return 'live';
      this.phaseSignalWatcher.stop(taskId);
      return false;
    }
    return publishDispatchedAt ? 'delivered' : false;
  }

  private async setupPhaseSignalWatcher(
    taskId: string,
    agentId: string,
    expectedKinds: PhaseSignalKind | readonly PhaseSignalKind[],
    token: string,
    skipSnapshot = false,
    onReadFile?: (req: ReadFileSignal) => void,
  ): Promise<boolean> {
    if (!this.phaseSignalWatcher) return true;
    const task = await this.taskStore.get(taskId);
    if (!task) return false;
    try {
      return await this.phaseSignalWatcher.start({
        taskId,
        projectId: task.projectId,
        agentId,
        expectedKinds,
        token,
        skipSnapshot,
        ...(onReadFile ? { onReadFile } : {}),
      });
    } catch (err) {
      console.warn(
        `[AgentManager] setupPhaseSignalWatcher(task=${taskId}, kinds=${JSON.stringify(expectedKinds)}) failed:`,
        err,
      );
      return false;
    }
  }

  private async armPostDispatchSignalOrHold(
    taskId: string,
    agentId: string,
    expectedKinds: PhaseSignalKind | readonly PhaseSignalKind[],
    token: string,
    skipSnapshot = false,
    onReadFile?: (req: ReadFileSignal) => void,
  ): Promise<void> {
    const armed = await this.setupPhaseSignalWatcher(taskId, agentId, expectedKinds, token, skipSnapshot, onReadFile);
    if (!armed) await this.holdAgentForUnarmedSignal(taskId, agentId, expectedKinds);
  }

  async holdAgentForUnarmedSignal(
    taskId: string,
    agentId: string,
    expectedKinds: PhaseSignalKind | readonly PhaseSignalKind[],
  ): Promise<void> {
    const label = (Array.isArray(expectedKinds) ? [...expectedKinds] : [expectedKinds]).join(',');
    await this.markAwaitingHuman(
      agentId,
      `signal-arm-failed:${label}`,
      'Pane-signal watcher failed to arm after dispatch; the prompt expects a signal with no consumer. Cancel the task or delete the agent to retry.',
      { expectedTaskId: taskId },
    );
  }

  async rotateAndSetupPhaseSignal(
    taskId: string,
    agentId: string,
    expectedKinds: PhaseSignalKind | readonly PhaseSignalKind[],
  ): Promise<{ token: string; armed: boolean }> {
    const newToken = createSignalToken();
    await this.updateTask(taskId, { signalToken: newToken });
    const armed = await this.setupPhaseSignalWatcher(taskId, agentId, expectedKinds, newToken);
    return { token: newToken, armed };
  }

  async rollbackVerdictArmFailure(
    taskId: string,
    restore: { status: TaskStatus; signalToken?: string; reviewHeadAnchorSha?: string; reviewDispatchedAt?: string },
  ): Promise<void> {
    await this.withTaskLock(async () => {
      const fresh = await this.taskStore.get(taskId);
      if (!fresh) return;
      await this.taskStore.set({
        ...fresh,
        status: restore.status,
        signalToken: restore.signalToken,
        reviewHeadAnchorSha: restore.reviewHeadAnchorSha,
        reviewDispatchedAt: restore.reviewDispatchedAt,
        qaAgentId: undefined,
        updatedAt: new Date().toISOString(),
      });
    });
    if (!this.phaseSignalWatcher) return;
    const restored = await this.taskStore.get(taskId);
    if (!restored?.signalToken) return;
    const mapped = this.mapTaskStateToExpectedWatcher(restored);
    if (mapped) await this.setupPhaseSignal(taskId, mapped.agentId, mapped.expectedKinds);
  }

  async transitionToCodePhase(taskId: string): Promise<TaskState | null> {
    const task = await this.taskStore.get(taskId);
    if (!task) return null;
    const devAgentId = task.agentId;
    if (!devAgentId) return null;
    const newToken = createSignalToken();
    const transition = await this.transitionTaskStatus(
      taskId,
      'in_progress',
      { fromStatus: ['review', 'fixing', 'in_progress'] },
      { phase: 'code', signalToken: newToken },
    );
    if (!transition) return null;
    this.stopPhaseSignalWatcher(taskId);
    const codeKind: PhaseSignalKind = task.reviewMode === 'server' ? 'code-done' : 'pr-created';
    const codeArmed = await this.setupPhaseSignalWatcher(taskId, devAgentId, codeKind, newToken);
    if (!codeArmed && task.reviewMode === 'server') {
      await this.holdAgentForUnarmedSignal(taskId, devAgentId, codeKind);
      return null;
    }

    if (task.qaAgentId) {
      const released = await this.releaseAgentForTask(task.qaAgentId, taskId, 'idle')
        .catch(() => false);
      if (!released) {
        await this.safeEmit({
          id: '',
          type: 'human.intervention',
          timestamp: new Date().toISOString(),
          projectId: task.projectId,
          agentId: task.qaAgentId,
          taskId,
          data: { phase: 'code-phase-qa-release-failed', qaAgentId: task.qaAgentId },
        });
      }
    }

    const acquired = await this.acquireAgentForTask(devAgentId, taskId, 'code');
    if (!acquired) {
      await this.markAwaitingHuman(
        devAgentId,
        'code-dispatch-failed',
        'Dev could not be acquired for the code phase after spec approval; the task looks in_progress but the code prompt was never dispatched. Resume the agent to redispatch or cancel the task.',
        { expectedTaskId: taskId },
      ).catch(() => undefined);
      await this.safeEmit({
        id: '',
        type: 'human.intervention',
        timestamp: new Date().toISOString(),
        projectId: task.projectId,
        agentId: devAgentId,
        taskId,
        data: { phase: 'code-dev-acquire-failed', devAgentId },
      });
      return null;
    }

    let resumed = false;
    try {
      resumed = await this.continueSession(taskId, devAgentId, 'code');
    } catch (err) {
      if (err instanceof DispatchTerminalError) {
        await this.failTaskForDispatchError(taskId, 'code', devAgentId, err);
      } else if (!(err instanceof EnsureSessionError && err.partial.handled)) {
        await this.markAwaitingHuman(
          devAgentId,
          'code-dispatch-failed',
          'Code-phase prompt was not delivered after spec approval; the task looks in_progress but the dev never received it. Resume/restart the agent or cancel the task.',
          { expectedTaskId: taskId },
        ).catch(() => undefined);
      }
      console.error(
        `[AgentManager] transitionToCodePhase continueSession(dev=${devAgentId}) failed:`,
        err,
      );
      throw err;
    }
    if (!resumed) {
      await this.markAwaitingHuman(
        devAgentId,
        'code-dispatch-failed',
        'Code-phase prompt was not delivered after spec approval; the task looks in_progress but the dev never received it. Resume/restart the agent or cancel the task.',
        { expectedTaskId: taskId },
      ).catch(() => undefined);
      await this.safeEmit({
        id: '',
        type: 'human.intervention',
        timestamp: new Date().toISOString(),
        projectId: task.projectId,
        agentId: devAgentId,
        taskId,
        data: { phase: 'code-resume-failed', devAgentId },
      });
      return null;
    }
    return await this.taskStore.get(taskId);
  }


  async dispatchServerReviewToQa(
    taskId: string,
    opts: {
      phase: TaskPhase;
      recheck?: boolean;
      continuation?: boolean;
      content: string;
      diffstat?: string;
      contentTruncated?: boolean;
      batch?: { index: number; total: number };
      priorFindingsJson?: string;
      priorResponseJson?: string;
      reviewHeadAnchorSha?: string;
    },
  ): Promise<TaskState | null> {
    const dispatchPhase = opts.phase === 'spec'
      ? 'server-spec-review'
      : (opts.recheck ? 'server-recheck' : 'server-review');
    const expectedKind: PhaseSignalKind = opts.phase === 'spec' ? 'spec-reviewed' : 'code-reviewed';

    const claim = await this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task) throw new Error(`dispatchServerReviewToQa: task ${taskId} not found`);
      if (task.reviewMode !== 'server' && opts.phase !== 'spec') {
        throw new Error(`dispatchServerReviewToQa: task ${taskId} is not in server review mode`);
      }
      const qaId = task.qaAgentId ?? this.findQaPartner(task.agentId)?.id;
      if (!qaId) {
        const entryKind: PhaseSignalKind = task.status === 'fixing'
          ? (opts.phase === 'spec' ? 'spec-fixed' : 'code-fixed')
          : (opts.phase === 'spec' ? 'spec-done' : 'code-done');
        await this.setupPhaseSignal(taskId, task.agentId, entryKind, { skipSnapshot: true });
        await this.safeEmit({
          id: '',
          type: 'human.intervention',
          timestamp: new Date().toISOString(),
          projectId: task.projectId,
          agentId: task.agentId,
          taskId,
          data: { phase: 'server-review-no-qa-partner', devAgentId: task.agentId },
        });
        return null;
      }
      const roundField = opts.phase === 'spec' ? (task.specReviewRound ?? 0) : task.reviewRound;
      return {
        qaId,
        devAgentId: task.agentId,
        projectId: task.projectId,
        newToken: createSignalToken(),
        newRound: opts.continuation ? Math.max(roundField, 1) : roundField + 1,
        originalStatus: task.status,
        originalToken: task.signalToken,
        originalRound: roundField,
        originalBatchIndex: task.batchIndex,
        originalBatchTotal: task.batchTotal,
        originalPhase: task.phase,
      };
    });
    if (!claim) return null;
    const { qaId, devAgentId, projectId, newToken, newRound } = claim;

    const rollback = async () => {
      await this.transitionTaskStatus(
        taskId,
        claim.originalStatus,
        { fromStatus: ['review'] },
        {
          signalToken: claim.originalToken,
          batchIndex: claim.originalBatchIndex,
          batchTotal: claim.originalBatchTotal,
          phase: claim.originalPhase,
          ...(opts.phase === 'spec'
            ? { specReviewRound: claim.originalRound }
            : { reviewRound: claim.originalRound }),
        },
      ).catch(() => undefined);
    };

    const rearmEntrySignal = async () => {
      const entryKind: PhaseSignalKind = claim.originalStatus === 'fixing'
        ? (opts.phase === 'spec' ? 'spec-fixed' : 'code-fixed')
        : (opts.phase === 'spec' ? 'spec-done' : 'code-done');
      await this.setupPhaseSignal(taskId, devAgentId, entryKind, { skipSnapshot: true });
    };

    if (!opts.continuation) {
      const acquired = await this.acquireAgentForTask(qaId, taskId, dispatchPhase);
      if (!acquired) {
        await rearmEntrySignal();
        await this.safeEmit({
          id: '',
          type: 'human.intervention',
          timestamp: new Date().toISOString(),
          projectId,
          agentId: qaId,
          taskId,
          data: { phase: 'server-review-qa-acquire-failed', qaAgentId: qaId },
        });
        return null;
      }
      if (devAgentId) {
        const devOk = await this.markAgentWaiting(devAgentId, taskId);
        if (!devOk) {
          await this.releaseAgentForTask(qaId, taskId, 'idle').catch(() => undefined);
          await rearmEntrySignal();
          await this.safeEmit({
            id: '',
            type: 'human.intervention',
            timestamp: new Date().toISOString(),
            projectId,
            agentId: devAgentId,
            taskId,
            data: { phase: 'server-review-dev-park-failed', devAgentId },
          });
          return null;
        }
      }
    }

    const roundPatch = opts.phase === 'spec'
      ? { specReviewRound: newRound, phase: 'spec' as TaskPhase }
      : { reviewRound: newRound };
    const transition = await this.transitionTaskStatus(
      taskId,
      'review',
      { fromStatus: ['in_progress', 'fixing', 'review'] },
      {
        signalToken: newToken,
        qaAgentId: qaId,
        reviewDispatchedAt: new Date().toISOString(),
        ...(opts.reviewHeadAnchorSha ? { reviewHeadAnchorSha: opts.reviewHeadAnchorSha } : {}),
        ...(opts.batch
          ? { batchIndex: opts.batch.index, batchTotal: opts.batch.total }
          : { batchIndex: undefined, batchTotal: undefined }),
        ...roundPatch,
      },
    );
    if (!transition) {
      if (!opts.continuation) {
        await this.releaseAgentForTask(qaId, taskId, 'idle').catch(() => undefined);
      }
      await this.safeEmit({
        id: '',
        type: 'human.intervention',
        timestamp: new Date().toISOString(),
        projectId,
        agentId: qaId,
        taskId,
        data: { phase: 'server-review-transition-failed', qaAgentId: qaId },
      });
      return null;
    }

    const sessionOpts = {
      bypassTaskStatusGate: true,
      signalToken: newToken,
      serverContent: opts.content,
      ...(opts.diffstat !== undefined ? { serverDiffstat: opts.diffstat } : {}),
      ...(opts.contentTruncated ? { contentTruncated: true } : {}),
      ...(opts.batch ? { serverBatch: opts.batch } : {}),
      ...(opts.priorFindingsJson ? { serverPriorFindings: opts.priorFindingsJson } : {}),
      ...(opts.priorResponseJson ? { serverPriorResponse: opts.priorResponseJson } : {}),
      ...(opts.phase === 'spec' ? { currentSpecRound: newRound } : {}),
      armBeforeInject: () => this.setupPhaseSignalWatcher(
        taskId, qaId, expectedKind, newToken, false,
        (req) => { void this.handleReadFileRequest(taskId, qaId, req); },
      ),
    };
    const rearmConsumedSignal = async () => {
      if (opts.continuation) {
        await this.setupPhaseSignal(taskId, qaId, expectedKind, { skipSnapshot: true });
      } else {
        await rearmEntrySignal();
      }
    };

    let started = false;
    try {
      started = opts.continuation
        ? await this.continueSession(taskId, qaId, dispatchPhase, sessionOpts)
        : await this.startSession(taskId, qaId, dispatchPhase, sessionOpts);
    } catch (err) {
      this.stopPhaseSignalWatcher(taskId);
      if (err instanceof DispatchTerminalError) {
        await this.failTaskForDispatchError(taskId, dispatchPhase, qaId, err);
      } else if (err instanceof EnsureSessionError && err.partial.handled) {
      } else {
        await rollback();
        if (!opts.continuation) {
          await this.releaseAgentForTask(qaId, taskId, 'idle').catch(() => undefined);
        }
        await rearmConsumedSignal();
      }
      throw err;
    }
    if (!started) {
      this.stopPhaseSignalWatcher(taskId);
      await rollback();
      if (!opts.continuation) {
        await this.releaseAgentForTask(qaId, taskId, 'idle').catch(() => undefined);
      }
      await rearmConsumedSignal();
      await this.safeEmit({
        id: '',
        type: 'human.intervention',
        timestamp: new Date().toISOString(),
        projectId,
        agentId: qaId,
        taskId,
        data: { phase: 'server-review-start-failed', qaAgentId: qaId },
      });
      return null;
    }

    return await this.taskStore.get(taskId);
  }

  async dispatchServerFixToDev(taskId: string, findingsJson: string): Promise<TaskState | null> {
    const claim = await this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task) throw new Error(`dispatchServerFixToDev: task ${taskId} not found`);
      if (task.reviewMode !== 'server' && task.phase !== 'spec') {
        throw new Error(`dispatchServerFixToDev: task ${taskId} is not in server review mode`);
      }
      if (!task.agentId) throw new Error(`dispatchServerFixToDev: task ${taskId} has no dev agent`);
      return {
        devAgentId: task.agentId,
        qaAgentId: task.qaAgentId,
        projectId: task.projectId,
        newToken: createSignalToken(),
        taskPhase: (task.phase ?? 'code') as TaskPhase,
        currentSpecRound: task.specReviewRound,
        originalStatus: task.status as TaskStatus,
        originalToken: task.signalToken,
      };
    });
    if (!claim) return null;
    const { devAgentId, qaAgentId, projectId, newToken, taskPhase, currentSpecRound } = claim;
    const rollbackToEntry = async () => {
      await this.transitionTaskStatus(
        taskId,
        claim.originalStatus,
        { fromStatus: ['fixing'] },
        { signalToken: claim.originalToken },
      ).catch(() => undefined);
    };
    const expectedKind: PhaseSignalKind = taskPhase === 'spec' ? 'spec-fixed' : 'code-fixed';
    const rearmReviewedSignal = async () => {
      if (!qaAgentId) return;
      const reviewedKind: PhaseSignalKind = taskPhase === 'spec' ? 'spec-reviewed' : 'code-reviewed';
      await this.setupPhaseSignal(taskId, qaAgentId, reviewedKind, { skipSnapshot: true });
    };

    const acquired = await this.acquireAgentForTask(devAgentId, taskId, 'server-feedback');
    if (!acquired) {
      await rearmReviewedSignal();
      await this.safeEmit({
        id: '',
        type: 'human.intervention',
        timestamp: new Date().toISOString(),
        projectId,
        agentId: devAgentId,
        taskId,
        data: { phase: 'server-fix-dev-acquire-failed', devAgentId },
      });
      return null;
    }

    if (qaAgentId) {
      const released = await this.releaseAgentForTask(qaAgentId, taskId, 'idle')
        .catch(() => false);
      if (!released) {
        await rearmReviewedSignal();
        await this.safeEmit({
          id: '',
          type: 'human.intervention',
          timestamp: new Date().toISOString(),
          projectId,
          agentId: qaAgentId,
          taskId,
          data: { phase: 'server-fix-qa-release-failed', qaAgentId },
        });
        return null;
      }
    }

    const transition = await this.transitionTaskStatus(
      taskId,
      'fixing',
      { fromStatus: ['review', 'max_rounds'] },
      { signalToken: newToken, fixDispatchedAt: new Date().toISOString() },
    );
    if (!transition) {
      await this.safeEmit({
        id: '',
        type: 'human.intervention',
        timestamp: new Date().toISOString(),
        projectId,
        agentId: devAgentId,
        taskId,
        data: { phase: 'server-fix-transition-failed', devAgentId },
      });
      return null;
    }

    let resumed = false;
    try {
      resumed = await this.continueSession(taskId, devAgentId, 'server-feedback', {
        bypassTaskStatusGate: true,
        signalToken: newToken,
        serverPriorFindings: findingsJson,
        ...(taskPhase === 'spec' && currentSpecRound !== undefined
          ? { currentSpecRound }
          : {}),
      });
    } catch (err) {
      if (err instanceof DispatchTerminalError) {
        await this.failTaskForDispatchError(taskId, 'server-feedback', devAgentId, err);
      } else if (err instanceof EnsureSessionError && err.partial.handled) {
      } else {
        await rollbackToEntry();
        await this.releaseAgentForTask(devAgentId, taskId, 'idle').catch(() => undefined);
        await rearmReviewedSignal();
      }
      throw err;
    }
    if (!resumed) {
      await rollbackToEntry();
      await this.releaseAgentForTask(devAgentId, taskId, 'idle').catch(() => undefined);
      await rearmReviewedSignal();
      await this.safeEmit({
        id: '',
        type: 'human.intervention',
        timestamp: new Date().toISOString(),
        projectId,
        agentId: devAgentId,
        taskId,
        data: { phase: 'server-fix-resume-failed', devAgentId },
      });
      return null;
    }

    await this.armPostDispatchSignalOrHold(taskId, devAgentId, expectedKind, newToken);
    return await this.taskStore.get(taskId);
  }

  async dispatchServerAfterDone(taskId: string, kind: 'branch' | 'pr'): Promise<TaskState | null> {
    const task = await this.taskStore.get(taskId);
    if (!task) throw new Error(`dispatchServerAfterDone: task ${taskId} not found`);
    const devAgentId = task.agentId;
    if (!devAgentId) throw new Error(`dispatchServerAfterDone: task ${taskId} has no dev agent`);
    const branch = task.branch ?? BRANCH_PREFIX + taskId;
    const originalToken = task.signalToken;
    const newToken = createSignalToken();
    await this.updateTask(taskId, { signalToken: newToken });
    const rollbackToken = async () => {
      await this.updateTask(taskId, { signalToken: originalToken, publishDispatchedAt: undefined })
        .catch(() => undefined);
    };

    const acquired = await this.acquireAgentForTask(devAgentId, taskId, 'server-after-done');
    if (!acquired) {
      await rollbackToken();
      await this.safeEmit({
        id: '',
        type: 'human.intervention',
        timestamp: new Date().toISOString(),
        projectId: task.projectId,
        agentId: devAgentId,
        taskId,
        data: { phase: 'server-after-done-dev-acquire-failed', devAgentId },
      });
      return null;
    }

    await this.updateTask(taskId, { publishDispatchedAt: new Date().toISOString() });

    let resumed = false;
    try {
      resumed = await this.continueSession(taskId, devAgentId, 'server-after-done', {
        bypassTaskStatusGate: true,
        signalToken: newToken,
        serverAfterDone: { kind, branch },
      });
    } catch (err) {
      if (err instanceof DispatchTerminalError) {
        await this.failTaskForDispatchError(taskId, 'server-after-done', devAgentId, err);
      } else if (!(err instanceof EnsureSessionError && err.partial.handled)) {
        await rollbackToken();
      }
      throw err;
    }
    if (!resumed) {
      await rollbackToken();
      await this.safeEmit({
        id: '',
        type: 'human.intervention',
        timestamp: new Date().toISOString(),
        projectId: task.projectId,
        agentId: devAgentId,
        taskId,
        data: {
          phase: 'server-after-done-resume-failed',
          devAgentId,
          note: 'Publish prompt was not delivered; mark-complete retries the publish dispatch.',
        },
      });
      return null;
    }

    await this.armPostDispatchSignalOrHold(taskId, devAgentId, 'code-ready', newToken);
    return await this.taskStore.get(taskId);
  }

  private async handleReadFileRequest(taskId: string, qaAgentId: string, req: ReadFileSignal): Promise<void> {
    const task = await this.taskStore.get(taskId);
    if (!task) return;
    const dev = this.getAgentConfig(task.agentId);
    if (!dev) return;
    await this.refreshWorktreeCacheFor(task.agentId);
    let body: string;
    try {
      const text = await this.getReviewTransport().readFileRange(dev, req.file, req.startLine, req.endLine);
      body = `=== baxian read-file ${req.file}:${req.startLine}-${req.endLine} ===\n${text}\n=== end read-file ===`;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      body = `=== baxian read-file ${req.file}:${req.startLine}-${req.endLine} REFUSED: ${reason} ===`;
    }
    const qaState = await this.agentStore.get(qaAgentId);
    if (qaState?.taskId !== taskId) {
      console.warn(
        `[AgentManager] read-file response dropped: qa=${qaAgentId} no longer bound to ${taskId} (got ${qaState?.taskId})`,
      );
      return;
    }
    try {
      await this.injectTextToAgent(qaAgentId, body, { expectedTaskId: taskId });
    } catch (err) {
      console.warn(`[AgentManager] read-file injection to ${qaAgentId} failed:`, err);
    }
  }

  async injectTextToAgent(
    agentId: string,
    text: string,
    opts: { expectedTaskId?: string } = {},
  ): Promise<void> {
    const cfg = this.getAgentConfig(agentId);
    if (!cfg) throw new Error(`injectTextToAgent: unknown agent ${agentId}`);
    await this.acquireCompactGuard(agentId);
    try {
      const state = await this.agentStore.get(agentId);
      if (opts.expectedTaskId !== undefined && state?.taskId !== opts.expectedTaskId) {
        throw new Error(
          `injectTextToAgent: agent ${agentId} no longer bound to ${opts.expectedTaskId}`,
        );
      }
      if (isCancelCleanupHold(state)) {
        throw new Error(`injectTextToAgent: agent ${agentId} taken over by cancel (${state?.awaitingPhase}); refusing injection`);
      }
      const boundTask = state?.taskId ? await this.taskStore.get(state.taskId) : null;
      if (boundTask && TERMINAL_STATUSES.includes(boundTask.status)) {
        throw new Error(`injectTextToAgent: task ${state?.taskId} for agent ${agentId} is terminal; refusing injection`);
      }
      const paneId = state?.paneId;
      if (!paneId) throw new Error(`injectTextToAgent: agent ${agentId} has no live pane`);
      const fresh = await this.agentStore.get(agentId);
      if (!fresh || fresh.paneId !== paneId
        || (opts.expectedTaskId !== undefined && fresh.taskId !== opts.expectedTaskId)
        || isCancelCleanupHold(fresh)) {
        throw new Error(`injectTextToAgent: agent ${agentId} taken over by cancel before paste`);
      }
      const tmux = new TmuxManager(this.createRunnerFor(cfg));
      await tmux.injectPrompt(paneId, text, agentId);
      await tmux.sendEnter(paneId);
    } finally {
      this.compactInFlight.delete(agentId);
    }
  }

  async confirmHumanGate(taskId: string): Promise<TaskState> {
    const task = await this.claimCompleteGate(taskId, ['ready', 'merge-ready']);
    try {
      const project = this.getProjectConfig(task.projectId);
      const mergeAuto = project?.merge === 'auto';
      const afterDone = this.resolveAfterDone(task);

      if (task.status === 'merge-ready') {
        if (mergeAuto && task.prNumber) {
          if (!task.latestHeadSha) {
            throw new ApiError(409, `Task ${taskId} has no approved head recorded; cannot safely merge`);
          }
          await this.executeConfirmMerge(task, () => this.mergePr(taskId, {
            matchHeadSha: task.latestHeadSha,
          }));
          await this.eventBus.emit({
            id: '',
            type: 'pr.merged',
            timestamp: new Date().toISOString(),
            projectId: task.projectId,
            agentId: task.agentId,
            taskId: task.id,
            data: { prNumber: task.prNumber, ...(task.prUrl ? { prUrl: task.prUrl } : {}) },
          });
          return (await this.taskStore.get(taskId))!;
        }
        return this.finishTaskAsDone(taskId);
      }

      if (afterDone === 'pr' && mergeAuto && task.prNumber) {
        if (!task.latestHeadSha) {
          throw new ApiError(409, `Task ${taskId} has no reviewed head recorded; cannot safely merge`);
        }
        await this.executeConfirmMerge(task, () => this.mergePr(taskId, {
          matchHeadSha: task.latestHeadSha,
        }));
        await this.eventBus.emit({
          id: '',
          type: 'pr.merged',
          timestamp: new Date().toISOString(),
          projectId: task.projectId,
          agentId: task.agentId,
          taskId: task.id,
          data: { prNumber: task.prNumber, ...(task.prUrl ? { prUrl: task.prUrl } : {}) },
        });
        return (await this.taskStore.get(taskId))!;
      }
      if (afterDone === 'branch' && mergeAuto && task.branch) {
        await this.executeConfirmMerge(task, () => this.ffMergeBranch(task));
        const merged = await this.transitionTaskStatus(taskId, 'merged', { fromStatus: ['ready'] });
        if (merged) await this.releaseTaskAgents(taskId);
        return (await this.taskStore.get(taskId))!;
      }
      return this.finishTaskAsDone(taskId);
    } finally {
      this.markCompleteInFlight.delete(taskId);
    }
  }

  private async claimCompleteGate(taskId: string, statuses: TaskStatus[]): Promise<TaskState> {
    return this.withTaskLock(async () => {
      const fresh = await this.taskStore.get(taskId);
      if (!fresh) throw new ApiError(404, `Task ${taskId} not found`);
      if (!statuses.includes(fresh.status)) {
        throw new ApiError(409, `Task ${taskId} is not awaiting confirmation (status=${fresh.status})`);
      }
      if (this.markCompleteInFlight.has(taskId)) {
        throw new ApiError(409, `Task ${taskId} is already being completed`);
      }
      this.markCompleteInFlight.add(taskId);
      return fresh;
    });
  }

  private async executeConfirmMerge(task: TaskState, merge: () => Promise<void>): Promise<void> {
    try {
      await merge();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.safeEmit({
        id: '',
        type: 'human.intervention',
        timestamp: new Date().toISOString(),
        projectId: task.projectId,
        taskId: task.id,
        data: {
          phase: 'confirm-merge-failed',
          gate: task.status,
          error: message,
          note: 'Task stays at the gate: Confirm again to retry, or Cancel to retire the published artifact.',
        },
      });
      throw new ApiError(409, `Merge failed for task ${task.id}: ${message}`);
    }
  }

  private async finishTaskAsDone(taskId: string): Promise<TaskState> {
    const done = await this.transitionTaskStatus(
      taskId,
      'done',
      { fromStatus: ['ready', 'merge-ready'] },
    );
    if (!done) throw new ApiError(409, `Task ${taskId} changed status during confirm; aborted`);
    await this.releaseTaskAgents(taskId);
    return (await this.taskStore.get(taskId))!;
  }

  async releaseTaskAgents(taskId: string): Promise<void> {
    this.phaseSignalWatcher?.stop(taskId);
    const task = await this.taskStore.get(taskId);
    if (!task) return;
    for (const id of [task.agentId, task.qaAgentId]) {
      if (!id) continue;
      const state = await this.agentStore.get(id);
      if (!state || state.taskId !== taskId) continue;
      await this.releaseAgentForTask(id, taskId, 'idle', { allowAwaitingHuman: true })
        .catch(err => {
          console.warn(`[AgentManager] confirm release ${id} failed:`, err);
        });
    }
  }

  private repoMergeQueue = new Map<string, Promise<unknown>>();

  protected async ffMergeBranch(task: TaskState): Promise<void> {
    const dev = this.getAgentConfig(task.agentId);
    if (!dev) throw new Error(`ffMergeBranch: no dev agent for task ${task.id}`);
    const state = await this.agentStore.get(task.agentId);
    const repoPath = state?.repoPath;
    if (!repoPath) throw new Error(`ffMergeBranch: no repoPath for agent ${task.agentId}`);
    const branch = task.branch ?? BRANCH_PREFIX + task.id;
    const runner = this.createRunnerFor(dev);

    const prev = this.repoMergeQueue.get(task.projectId) ?? Promise.resolve();
    const run = prev.then(async () => {
      const cd = `cd ${shellQuote(repoPath)} && `;
      const db = await runner.exec(`${cd}git symbolic-ref --short refs/remotes/origin/HEAD`);
      const defaultBranch = db.stdout.trim().replace(/^origin\//, '');
      if (db.exitCode !== 0 || defaultBranch === '') {
        throw new Error(`ffMergeBranch: cannot resolve default branch: ${db.stderr.trim() || 'empty origin/HEAD'}`);
      }
      const fetch = await runner.exec(`${cd}git fetch origin`);
      if (fetch.exitCode !== 0) {
        throw new Error(`ffMergeBranch [git fetch] failed: ${fetch.stderr.trim()}`);
      }
      if (task.latestHeadSha) {
        const remoteHead = await runner.exec(`${cd}git rev-parse ${shellQuote(`origin/${branch}`)}`);
        if (remoteHead.exitCode !== 0 || remoteHead.stdout.trim() !== task.latestHeadSha) {
          throw new Error(
            `ffMergeBranch: origin/${branch} head ${remoteHead.stdout.trim() || '<unresolved>'} ` +
            `!= reviewed head ${task.latestHeadSha}; refusing to merge un-reviewed commits`,
          );
        }
      } else {
        throw new Error(`ffMergeBranch: no reviewed head recorded for task ${task.id}; cannot safely merge`);
      }
      const push = await runner.exec(
        `${cd}git push origin ${shellQuote(`origin/${branch}`)}:${shellQuote(defaultBranch)}`,
      );
      if (push.exitCode !== 0) {
        throw new Error(`ffMergeBranch [push] failed: ${push.stderr.trim() || push.stdout.trim()}`);
      }
      const del = await runner.exec(`${cd}git push origin --delete ${shellQuote(branch)}`);
      if (del.exitCode !== 0) {
        console.warn(
          `[AgentManager] ffMergeBranch: post-merge branch delete failed for ${branch}: ${del.stderr.trim() || del.stdout.trim()}`,
        );
      }
    });
    this.repoMergeQueue.set(task.projectId, run.catch(() => undefined));
    await run;
  }
}

function buildAgentIndex(
  config: BaxianConfig,
): Map<string, AgentConfig & { projectId: string }> {
  const index = new Map<string, AgentConfig & { projectId: string }>();
  for (const project of config.project) {
    for (const pair of project.agent) {
      for (const agent of pair) {
        index.set(agent.id, { ...agent, projectId: project.id });
      }
    }
  }
  return index;
}
