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
  buildPostMergeCleanupPrompt,
  PromptSizeError,
  RequiredSkillsMissingError,
  MAX_PROMPT_BYTES_ROUTE_LIMIT,
  type PostMergeCleanupContext,
  type PostMergeBranchCleanupResult,
} from './prompt.js';
import { ApiError } from '../errors.js';
import { prepareConfig } from '../config/loader.js';

export interface EnsureSessionResult {
  ok: true;
  createdSession: boolean;
  // True when the REPL inside the pane was launched (or relaunched) in this
  // call: buildFreshSession 路径，以及 adoptOrRestartSession 的 shell 重启 /
  // trust-dialog 完成两个分支。这些场景下旧 REPL 上下文（如果存在）已经丢失，
  // 调用方应据此重置 skill dedup baseline——adopted live-runtime 则保持 false。
  freshRuntime: boolean;
  paneId: string;
  workdir: string;
}

export class EnsureSessionError extends Error {
  constructor(
    public readonly partial: {
      createdSession: boolean;
      agentId: string;
      // dialogPending=true: session intact, caller records observation instead of killing it.
      dialogPending?: boolean;
      // handled=true: handleDialogPendingFromRuntime 已 mark Held + fail task + release partners；
      // caller (startSession/continueSession catch + 上游 handler) 必须跳过 releaseAgentForTask，
      // 否则 boundTask 已 terminal 会让 shouldReleaseHeldBinding 放行清掉 Held dialog pane 的 lock。
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

// shellQuote model/addDirs: spliced into a tmux command line; unquoted values allow injection.
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
  /** Root for persistent task-image staging; production passes ${stateDir}/state/task-images. */
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
  // >0 → post-approve prompt 走 incremental nudge 分支（dev pane 已带完整上下文，只需通知有新 feedback）
  postApproveRedispatchCount?: number;
  currentSpecRound?: number;
  // spec dispatch 在 Phase 2 调时 task.status 尚未进入 gate 值，需绕开 status 检查。
  bypassTaskStatusGate?: boolean;
  // dialog 失败 fail task 时的允许 fromStatus 集合，覆盖默认 PHASE_EXPECTED_STATUS[phase]。
  dialogFailFromStatuses?: TaskStatus[];
  serverContent?: string;
  serverDiffstat?: string;
  serverBatch?: { index: number; total: number };
  serverPriorFindings?: string;
  serverPriorResponse?: string;
  serverAfterDone?: { kind: 'branch' | 'pr'; branch: string };
  contentTruncated?: boolean;
  // Pre-inject hook: armed once the pane exists but before the prompt is pasted. Returns false to
  // abort the dispatch (e.g. the signal watcher could not arm).
  armBeforeInject?: () => Promise<boolean>;
}

export interface MergePrOpts {
  matchHeadSha?: string;
}

// Captured at the start of dispatchReviewToQa so a hard startSession failure
// can restore the task to its pre-dispatch shape (including the watcher).
interface DispatchReviewSnapshot {
  qaAgentId?: string;
  signalToken?: string;
  reviewHeadAnchorSha?: string;
  reviewDispatchedAt?: string;
}

// Dev-facing deliverable phases that weave the task's uploaded image paths into the prompt.
const IMAGE_DISPATCH_PHASES = new Set<string>(['develop', 'code', 'fix', 'server-feedback']);

// Pane grabs taken to decide live-turn vs static composer; (N-1) * runtimeLivenessProbeMs must exceed 1s.
const RUNTIME_LIVENESS_SAMPLES = 3;

export function canDispatchWithBinding(binding: AgentBindingFacts | null | undefined): boolean {
  return !binding?.taskId && !binding?.creationToken && binding?.status !== 'awaiting_human';
}

// 部分 awaiting phase 表示 agent 这一轮 turn 已跑完，绑定是 stale 的——即使 task 不 terminal
// 也应 release 让 agent 被下一轮 acquire。outcome handler (review.submitted) 走 allowAwaitingHuman 即可。
//
// 当前集合为空：先前包含的 'dev-wait-gate-failed-after-qa-started' 和 'dispatch-failed:ack_unknown'
// 语义都是"QA prompt 已粘贴，可能仍在 pane 中跑"——任何在 outcome 到达前的 release（含 resumeAgent /
// recover 路径）都可能让第二个 prompt 派进同 pane 与旧 turn 混在一起。outcome handler 通过显式
// allowAwaitingHuman:true release，gate 单点放行。
const TURN_COMPLETED_AWAITING_PHASES = new Set<string>();

// Pane is stopped (interrupt landed) but its session was not cleared: cancel is mid /clear
// (`cancel-clearing`) or /clear was unconfirmed (`cancel-clear-failed`). Resume can't fix it (it doesn't
// /clear), so these are DELETE-only: shouldReleaseHeldBinding returns false → recover()/escape/Resume all
// refuse. Persisted, so the protection survives a restart mid-cleanup.
const UNCLEARED_PANE_PHASES = new Set<string>(['cancel-clearing', 'cancel-clear-failed']);

// All cancel-cleanup holds (the un-cleared ones plus `cancel-interrupt-failed`, where the interrupt failed
// so the pane may still be running the cancelled task). None may be AUTO-released — not by recover(), not by
// a terminal-task escape, not even by an allowAwaitingHuman caller — because that would reuse the cancelled
// session. Only cancel's own confirmed-/clear release (fromCancelCleanup) frees one automatically; the
// operator recovers via Resume (cancel-interrupt-failed only, after verifying) or DELETE (any).
const CANCEL_CLEANUP_HOLD_PHASES = new Set<string>([...UNCLEARED_PANE_PHASES, 'cancel-interrupt-failed']);

// The cancel flow owns a binding in a cancel-cleanup hold: NO dispatch-failure cleanup may wipe it or
// overwrite it (else cancel's Phase 2 /clear is skipped and an un-cleared pane is reused). Every binding-wipe
// path must check this — releaseAgentForTask, rollbackFailedDispatch, startSession cleanup, markAwaitingHuman.
function isCancelCleanupHold(binding: { awaitingPhase?: string } | null | undefined): boolean {
  return binding?.awaitingPhase != null && CANCEL_CLEANUP_HOLD_PHASES.has(binding.awaitingPhase);
}

// Cancel-cleanup phases escalate monotonically — a more-locked phase must never be downgraded. cancel-clear-failed
// (DELETE-only: /clear unconfirmed) outranks cancel-interrupt-failed (Resume-able) and the transient cancel-clearing,
// so a re-entrant terminal cleanup can't soften "un-cleared, DELETE-only" into a hold Resume would reuse.
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

// A prompt line still holding the typed `/clear` (e.g. `❯ /clear`, `› /clear`) = the Enter was swallowed,
// so /clear was never submitted. After a real submission /clear wipes the screen and the composer is empty.
const CLEAR_PENDING_IN_COMPOSER_RE = /(?:^|\n)[ \t]*[❯>›→][ \t]*\/clear\b/;

// A greeting capability failure is NOT cleared by a plain Resume or by recover()'s auto-release:
// the agent must re-prove it can signal (restart/retry re-runs the handshake). Auto-releasing it
// would slip an unverified agent back to dispatchable, defeating the whole bootstrap gate.
const REGREET_REQUIRED_HOLD_PHASES = new Set<string>(['greeting_failed']);

// Resume / recover 共用：决定 Held agent 的 binding 是否随状态恢复一起清掉。
export function shouldReleaseHeldBinding(
  state: AgentBindingFacts,
  boundTask: TaskState | null | undefined,
): boolean {
  if (state.awaitingPhase != null && UNCLEARED_PANE_PHASES.has(state.awaitingPhase)) return false;
  if (state.awaitingPhase != null && REGREET_REQUIRED_HOLD_PHASES.has(state.awaitingPhase)) return false;
  const taskIsTerminal = !!boundTask && TERMINAL_STATUSES.includes(boundTask.status);
  const turnCompleted = state.awaitingPhase != null && TURN_COMPLETED_AWAITING_PHASES.has(state.awaitingPhase);
  return !boundTask || taskIsTerminal || turnCompleted;
}

// null 表示 context 已无效（换 task / 换 pane），调用方应回退到完整注入。
// 返回数组（含空数组）则代表当前 REPL session 已有的 skill 名集合，可作 excludeSkills 入参。
function reuseSkillsIfContextValid(
  state: AgentBindingFacts | null,
  taskId: string,
  paneId: string,
): string[] | null {
  const rec = state?.injectedSkills;
  if (!rec) return null;
  if (rec.taskId !== taskId || rec.paneId !== paneId) return null;
  return rec.skills;
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
  // Re-send Enter after this long of continuous post-paste idle — recovers a swallowed first Enter
  // without risking a double-submit (a real submit goes busy well within this window).
  protected dispatchAckResendIntervalMs = 3_000;

  private taskMutationQueue: Promise<unknown> = Promise.resolve();
  private agentIndex: Map<string, AgentConfig & { projectId: string }>;
  private platformRunner: CommandRunner;
  private imageStagingRoot: string;
  private bootstrapTimeoutsMs: { trustDialog: number; waitReplReady: number; greeting: number };
  // Bootstrap greeting handshake: total attempts before holding the agent, to absorb a
  // single transient slow/garbled reply without failing a genuinely capable agent.
  protected greetingMaxAttempts = 2;
  private runtimeMenuWatchers = new Map<string, AbortController>();
  protected runtimeMenuPollIntervalMs = 10_000;
  protected compactIdleWaitMs = 5 * 60_000;
  protected compactIdlePollMs = 2_000;
  protected manualCompactWaitMs = 5_000;
  protected clearContextWaitMs = 30_000;
  // Gap between liveness grabs in interruptPaneAndWaitReady; (SAMPLES-1)*this must exceed 1s + margin so a
  // per-second elapsed-counter tick is always captured (700 * 2 = 1.4s).
  protected runtimeLivenessProbeMs = 700;
  // How long the post-C-c verify polls for the pane to reach a clean/empty composer before holding.
  protected cleanComposerWaitMs = 5_000;
  // How long cancel waits for an in-flight dispatch to release the pane mutex before holding (set in the
  // constructor from the actual dispatchAckTimeoutMs). On timeout the pane is classified DELETE-only, not
  // Resume-able, so a longer non-dispatch holder can't leave an un-cleared pane reusable.
  protected cancelInterruptGuardWaitMs = DEFAULT_DISPATCH_ACK_TIMEOUT_MS + 5_000;
  protected postMergeFetchTimeoutMs = 60_000;
  protected postMergeBranchTimeoutMs = 10_000;
  // taskIds with in-flight manual review — second concurrent POST gets 409.
  private manualReviewInFlight = new Set<string>();
  // taskIds with an in-flight mark-complete (slow external `gh pr merge`). While set, the
  // task is being merged — Cancel / Call review / Continue must refuse so they can't act on
  // the same max_rounds snapshot and interleave with the irreversible merge.
  private markCompleteInFlight = new Set<string>();
  // agentIds with in-flight DELETE — 第二个 DELETE 撞 awaiting_human stale-lock takeover 路径会
  // 把第一个 DELETE 持有的占位也当 stale 接管，导致并发 cleanupRemovedAgentRuntime。
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
    // Track the ACTUAL ack timeout (a dispatch holds the pane mutex through waitSubmitAck), not a hardcoded
    // default — else an overridden dispatchAckTimeoutMs would let cancel give up before the dispatch releases.
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

  // Config validation guarantees non-GitHub projects resolve to server mode.
  effectiveReviewMode(projectId: string): ReviewMode {
    const project = this.getProjectConfig(projectId);
    return project?.review?.mode ?? this.config.review.mode ?? 'github';
  }

  // Snapshot-aware afterDone read: an EXPLICIT null snapshot must win over hot
  // config — `??` would swallow it and reroute an already-decided task.
  resolveAfterDone(task: TaskState): AfterDone {
    if (task.afterDone !== undefined) return task.afterDone;
    return this.coerceAfterDone(task.projectId, this.config.review.afterDone);
  }

  // Non-GitHub repos have no PR platform: 'pr' degrades to 'branch' (push + optional
  // ff-merge). An unset afterDone defaults to 'branch' so reviewed work actually reaches
  // the remote; an explicit null still means "don't publish". GitHub is unchanged.
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

  // ReviewTransport resolves worktrees synchronously; agentStore reads are async.
  // The cache is refreshed by callers (server handlers) before transport use via
  // refreshWorktreeCacheFor — a stale entry only costs one refresh round-trip.
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

  // Live view — handlers that read review.rounds etc. must go through this so PATCH /config
  // takes effect on the very next event instead of frozen-at-boot closure capture.
  getConfig(): BaxianConfig {
    return this.config;
  }

  getAgentConfig(agentId: string): (AgentConfig & { projectId: string }) | undefined {
    return this.agentIndex.get(agentId);
  }

  // DELETE phase1 (withConfigLock 内) 先调；返回冲突 id 表示另一 DELETE 已在跑此 agent，caller 应 409。
  // 成功 claim 后所有出口（含 phase1 reply / phase2/3 完成 / rollback / throw）必须调
  // releaseDeletionClaim 释放，否则 agent 永久卡在 "delete-in-flight" 状态。
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

    // Skills must be on disk at the repo root before the REPL launches OR is reused,
    // so native discovery sees them and the dispatch's /skill / $skill resolves. Runs
    // on every path — fresh launch, adopt of a live runtime, and shell/REPL restart —
    // not just buildFreshSession; the version marker keeps the steady state a single cat.
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

  // Materialize baxian skills into the repo root the REPL launches in (cwd at
  // launch), so the agent's `claude`/`codex` discovers them as native skills and
  // the dispatch can force-load one with `/skill` / `$skill`. Each file is written
  // atomically (stage + rename) and a current skill's dir is never removed, so a
  // concurrent agent's lazy SKILL.md read never observes an absent/partial file.
  private async provisionRepoSkills(
    runner: CommandRunner,
    agent: AgentConfig,
    workdir: string,
  ): Promise<void> {
    if (this.skillRegistry.names().length === 0) return;
    const subdir = agent.runtime === 'codex' ? '.agents/skills' : '.claude/skills';
    const destRoot = `${workdir}/${subdir}`;
    // Re-run on EVERY dispatch — do NOT cache the result. Config hot-reload
    // (replaceConfig, no restart) can repoint this agent's workdir/runtime to another
    // repo / skills dir, and repo code or a prior agent turn can tamper the on-disk
    // skill tree between dispatches; a skip cache (in-memory or on-disk) would then
    // serve a missing or repo-controlled tree. The files are tiny, so materialize
    // unconditionally. The cleanup + git-exclude are idempotent + best-effort.
    await this.excludeInjectedSkills(runner, workdir, subdir);
    // Serialize the cleanup+materialize per target skills dir (shared with the launch-time
    // scan in buildFreshSession): two same-runtime agents on one repo would otherwise let
    // one's `rm` blank the tree while the other materializes or its REPL scans for skills.
    await this.runUnderSkillDirLock(this.skillDirLockKey(agent, workdir), async () => {
      await this.ensureSkillDirSafe(runner, workdir, subdir);
      await this.skillRegistry.materialize(
        (path, content) => this.atomicWriteFile(runner, path, content),
        destRoot,
      );
    });
  }

  // Per (host, workdir, runtime-subdir) in-process lock. Both the cleanup+materialize
  // and the fresh REPL launch (which scans the skills dir at startup) run under it, so a
  // concurrent same-dir agent never observes a transiently-empty skills tree.
  private skillDirChain = new Map<string, Promise<unknown>>();
  private skillDirLockKey(agent: AgentConfig, workdir: string): string {
    // Canonicalize the host (a registry id and an equivalent inline host, or a blank vs default
    // port, must collapse to one key) and the workdir (a trailing slash must not fork the lock),
    // so two agents truly pointing at the same physical dir serialize instead of racing.
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

  // Atomic per-file replace. materialize() hands us each skill file's FINAL path; we stage it as a
  // sibling `.baxian-tmp` and `mv -f` it into place. POSIX rename is atomic, so a claude/codex lazy
  // SKILL.md body read — which happens at `/baxian-*` / `$baxian-*` INVOKE time, after this dir's
  // provisioning lock has already been released — sees either the complete old file or the complete
  // new one, never the truncate-in-place window of a bare writeFile or the blank window of a
  // delete-then-rewrite. The tmp lives inside the `baxian-*` leaf, so the git-exclude rule covers it.
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

  // Make the skills subtree symlink-safe before writing into it, WITHOUT blanking a live skill. A
  // current skill's dir is left in place (its files are swapped atomically by atomicWriteFile); we
  // prune `baxian-*` dirs no longer in the registry, strip EVERY symlink anywhere under a `baxian-*`
  // tree (leaf OR a nested component like `baxian-pr-review/agents`) so the atomic write can't be
  // redirected out of the workdir, and drop stale helper files left by a past skill version (a
  // removed/renamed file) — SKILL.md is kept so a concurrent lazy read is never blanked, and
  // materialize re-writes every current file atomically. The PARENT components (`.claude`/`.agents`
  // + their `skills` subdir) fail fast when they are symlinks: following one could write OUTSIDE the
  // workdir, and silently rm-ing it would destroy a user's legitimate symlinked skills dir (codex
  // documents symlinked skill folders as supported). `find -name`/`-path` (not a bare glob) avoids
  // zsh NOMATCH; the whole thing runs under POSIX `sh -c` since wrapRemoteCommand otherwise uses the
  // login shell (maybe fish). `top`/`subdir` are fixed constants; names are baxian-owned slugs.
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

  // Tag a freshly-launched session with the skills version it discovered at launch, so
  // adoptOrRestartSession can tell when a live REPL predates the current skills.
  private async tagSessionSkillsVersion(tmux: TmuxManager, agentId: string): Promise<void> {
    if (this.skillRegistry.names().length === 0) return;
    await tmux.setOption(agentId, '@baxian-skills-version', this.skillRegistry.contentHash());
  }

  // True when a live REPL's launch-time skills version differs from the current one
  // (or is absent — a pre-skills session): it cannot resolve a dispatched /baxian-*.
  private async replSkillsStale(tmux: TmuxManager, agentId: string): Promise<boolean> {
    if (this.skillRegistry.names().length === 0) return false;
    // getOption already maps a MISSING tag to null (→ stale). Do NOT swallow other
    // errors: a thrown tmux probe failure must propagate so the caller surfaces it as an
    // EnsureSessionError, instead of being read as stale and needlessly killing the REPL.
    const tagged = await tmux.getOption(agentId, '@baxian-skills-version');
    return tagged !== this.skillRegistry.contentHash();
  }

  // Hide ONLY what baxian writes — the `baxian-*` skill dirs — from the agent's
  // `git status` / PRs. Excluding the whole skills dir would also hide a user repo's own
  // untracked native skills there, defeating the `baxian-` prefix's coexistence intent.
  // The `if git rev-parse` guard skips a non-git workdir, and failure only warns: skills
  // are already on disk, so a git hiccup must not block the session.
  private async excludeInjectedSkills(
    runner: CommandRunner,
    workdir: string,
    subdir: string,
  ): Promise<void> {
    // info/exclude patterns anchor at the REPO ROOT, but the skills dir lives at the
    // workdir; when workdir is a SUBDIR of the repo, prefix the rule with the workdir's
    // path relative to the repo root (git rev-parse --show-prefix) so the pattern matches.
    const inner =
      `cd ${shellQuote(workdir)} && if p="$(git rev-parse --git-path info/exclude 2>/dev/null)"; then ` +
      `pre="$(git rev-parse --show-prefix 2>/dev/null)"; rule="\${pre}${subdir}/baxian-*"; ` +
      `mkdir -p "$(dirname "$p")" && { grep -qxF "$rule" "$p" 2>/dev/null || printf '%s\\n' "$rule" >> "$p"; }; fi`;
    // Run under POSIX sh (if/then/fi + $() are not fish syntax; wrapRemoteCommand uses $SHELL).
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

  // New sessions start in latest mode; adopted sessions keep their current size owner.
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
    // Hold the per-skills-dir lock across the launch so the REPL's startup skill scan
    // can't overlap a concurrent same-dir agent's provisioning rm (see provisionRepoSkills).
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
      // Mark BEFORE setOption — failure here must trigger caller's rollback.
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

  // Never throws — failures land in agentStore.
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
      // Capability gate: hold the agent until it proves (via the baxian-signals skill)
      // that it can load skills and echo a valid greeting signal back through its pane.
      // A non-greeting agent that reached 'ok' would silently hang on its first real signal.
      if (!(await this.runGreetingHandshake(agentId, cfgAtStart, result.paneId))) {
        // A newer create may have rotated creationToken during the (slow) greeting wait.
        // Mirror the success token-mismatch path: kill the orphan session we created so the
        // next generation's `create` doesn't trip on a pre-existing tmux session.
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

  // Bootstrap capability handshake: inject the greeting prompt and wait for the agent to
  // echo [bx:greeting:<token>] per the baxian-signals skill. Returns true on a verified
  // echo, false on timeout / lost session across all attempts. No task binding exists yet,
  // so this drives the low-level inject + the pane-scoped awaitOnce directly.
  private async runGreetingHandshake(
    agentId: string,
    agent: AgentConfig & { projectId: string },
    paneId: string,
  ): Promise<boolean> {
    const watcher = this.phaseSignalWatcher;
    if (!watcher) return true; // no watcher wired (minimal harness) — nothing to gate on
    const tmux = new TmuxManager(this.createRunnerFor(agent));
    for (let attempt = 1; attempt <= this.greetingMaxAttempts; attempt++) {
      const token = createSignalToken();
      try {
        // Inject FIRST, then arm the wait: if the paste fails the agent never sees the
        // prompt and cannot echo, so skip the (default 120s) wait entirely and retry.
        await this.injectAndAwaitAckSteps(
          tmux, paneId, buildGreetingPrompt(token, agent.runtime), agentId, agent.runtime,
        );
      } catch (err) {
        console.warn(`[bootstrap] greeting inject failed for ${agentId} (attempt ${attempt}):`, err);
        // ack_unknown = injectAndAwaitAckSteps could NOT confirm the composer was cleared, so the
        // next paste would land on a live/unconfirmed input stream. Hold rather than concatenate.
        // A raw (non-ack_unknown) throw means the composer was already C-c'd → safe to retry.
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
      // 'no-agent' = config removed, unrecoverable. 'timeout'/'session-gone' (incl. a transient
      // subscribe fault disguised as session-gone) keep the remaining retries — a one-off pane
      // jitter must not fail a genuinely capable agent.
      if (outcome === 'no-agent') break;
      // An ack-timeout paste returns acked:false and leaves the unsubmitted greeting prompt in the
      // composer; the next injectPrompt would concatenate onto it. Clear it before retrying — if the
      // composer can't be confirmed clean, hold rather than paste onto a dirty/unsafe one.
      if (attempt < this.greetingMaxAttempts && !(await this.clearComposerForReuse(tmux, paneId, agentId))) {
        break;
      }
    }
    return false;
  }

  // Greeting failed: hold the agent for a human (awaiting_human → not dispatchable) with a
  // reason that names the capability gap. Clearing creationToken drops the "starting" pill;
  // the operator fixes the runtime and restarts (re-greets) or Resumes to override.
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

  // Operator restart-repl/retry recovery for a greeting_failed agent: re-run the handshake on
  // the freshly-restarted REPL. Only a passing greeting clears the hold; a failure re-holds it.
  // Returns true when it took ownership of a greeting_failed agent (caller skips its normal clear).
  async regreetHeldAgent(agentId: string): Promise<boolean> {
    const agent = this.getAgentConfig(agentId);
    if (!agent) return false;
    const state = await this.agentStore.get(agentId);
    if (state?.awaitingPhase !== 'greeting_failed') return false;
    // Identity of THIS hold: a greeting_failed binding carries no creationToken, so a DELETE+recreate
    // during the (slow, up to 2× timeout) handshake is detected via awaitingSince — a stale regreet
    // must never write onto the recreated generation.
    const guardSince = state.awaitingSince;
    let paneId = state.paneId;
    if (!paneId) {
      try {
        paneId = await new TmuxManager(this.createRunnerFor(agent)).getSinglePaneId(agentId);
      } catch (err) {
        console.warn(`[regreet] cannot resolve pane for ${agentId}:`, err);
        return true; // leave it held; operator can restart/retry again
      }
    }
    if (!(await this.runGreetingHandshake(agentId, agent, paneId))) {
      // Failed → leave the existing hold untouched. Do NOT re-write it: an unguarded write could land
      // on a DELETE+recreated generation that reused this id. Operator can restart/retry again.
      return true;
    }
    // Passed → clear the hold, but only if this exact greeting_failed generation is still present.
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
    // A greeting capability failure must not be downgraded into a dialog-resolvable hold: doing so
    // would let Resume release a never-re-greeted agent. Keep the greeting_failed hold; restart/retry
    // re-runs the handshake.
    if (existing.awaitingPhase != null && REGREET_REQUIRED_HOLD_PHASES.has(existing.awaitingPhase)) return;
    // runtime path snapshot 全空时直接拒绝——既无 paneId 也无 taskId 作 generation 证据，
    // 旧 callback 通过 guard 污染同样 idle 的新 agent 的风险无法排除。
    if (opts.runtimePath && opts.expectedPaneId === undefined && opts.expectedTaskId === undefined) {
      console.warn(
        `[AgentManager] markDialogPending runtime path: refusing to write without paneId/taskId snapshot (no generation guard available for ${agentId})`,
      );
      return;
    }
    // Pre-check（early exit；下面 closure 内会再 atomic 校验一次）
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
        // best-effort; slowPoll skips iterations without paneId
      }
    }
    // 原子写入：guard + paneId + awaiting fields 一次性，避免 get→update 中间 race。
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
    // generational guard: token mismatch means a newer create-recreate already won.
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

  // Returns true when handled — caller skips its own kill cleanup.
  // expectedFromStatuses: fail-task transition 的允许 fromStatus 集合。caller (startSession/continueSession)
  // 已根据 phase + opts.dialogFailFromStatuses 计算好；并发 outcome 已把 task 推到此集合外的状态时
  // transitionTaskStatus skip → 不覆盖已接受的 outcome。未传时退化为 [...ACTIVE_TASK_STATUSES] (retry
  // endpoint 等无 phase 路径，且这些路径不绑 task，fail task 分支本就不进入)。
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
    // retry path（state.paneId 未写入但 ensureSession 刚 createSession）：从 tmux 取 paneId
    // 写入 state 作 generation 证据，否则 markDialogPending 的 snapshot 全空 refuse 会 no-op
    // → return true 让 caller 释放锁 202 返回 → agent 留 idle 但 tmux dialog 在跑 → 下一个
    // dispatch 撞进 dialog pane。tmux 探 paneId 失败时返回 false，让 caller 走 killSession 回滚。
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
      // 不用 updatedAt guard：updatedAt 太宽，正常 background updates
      // (repoPath refresh / poller bump 等) 也会触发假阳性让合法 retry dialog 路径误拒。
      // race ("DELETE+recreate 后旧回调写新 agent") 在持锁路径下是 theoretical (retry endpoint 持锁
      // 全程到 handleDialogPendingFromRuntime 返回；startSession/continueSession 由 acquireAgentForTask
      // 持锁)，且 `fresh.paneId !== undefined` 已挡住新 agent 已写 paneId 的情况。
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
    // runtime path: 显式 guard，不传 state.creationToken（race window 内可能已是新 generation）。
    // 同时 snapshot paneId / taskId 作 atomic check，挡住"DELETE+recreate + 新 bootstrap 完成"的 race。
    await this.markDialogPending(agentId, undefined, {
      runtimePath: true,
      ...(state.paneId !== undefined ? { expectedPaneId: state.paneId } : {}),
      expectedTaskId: state.taskId,
    });
    // runtime path (agent 已绑 active task + 无 creationToken)：dialog 在 ensureSession 阶段抛错，
    // prompt 还没 inject——直接 fail task 让 UI Retry 通路打开（无工作丢失）。
    // 若不 fail：task 卡 in_progress、agent Held、operator Resume 后仍无人重发 prompt（owner 评审 #6
    // 指出 transitionToCodePhase 会死锁）。task fail 后 Resume / recover 走 terminal-release 路径。
    // 用 transitionTaskStatus（内含 withTaskLock + fromStatus guard）避免与 Cancel / merge /
    // review outcome 等并发 mutation race，否则 stale 'failed' 会覆盖已经到达的 terminal 状态。
    if (state.taskId && state.creationToken === undefined) {
      // fromStatus 来自 caller 显式计算：startSession/continueSession 用 opts.dialogFailFromStatuses ??
      // PHASE_EXPECTED_STATUS[phase]，dispatchReviewToQa 走 bypassTaskStatusGate 时显式传 [taskStatusAtClaim]
      // (manual review 入口可能是 approved/fixing/in_progress，但 phase='review' 的 default 只接受 'review' →
      // 不传就 skip → task 卡 active 死锁)。
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
        // 同步释放 partner agent 的 binding。task 已 terminal 不会再走 cancel 清理，否则 partner
        // 永远指向 terminal task → retryTask 走 validateTaskDispatch 看 dev 仍 bound → 409。
        await this.releasePartnersAndDrain(agentId, [state.taskId], [transitioned.task.projectId]);
      }
    }
    // 通知 caller (startSession / continueSession catch) 不要再调 releaseAgentForTask 清理——
    // task 已 terminal + agent Held 时，shouldReleaseHeldBinding 第一条规则会放行 release，
    // 把仍卡 dialog 的 pane 解锁让下个 dispatch 派进来。set partial.handled 让 caller 跳过 release。
    err.partial.handled = true;
    // slowPoll 是 fire-and-forget，在 caller 释放锁后继续运行。runtime path 下 creationToken=undefined
    // 不足以挡 DELETE+recreate 后旧 poll 撞新 agent（新 agent ack_unknown/dev-wait-gate-failed 时
    // creationToken 也 undefined）→ 旧 poll 会把新 agent phase 覆为 resolved_runtime → Resume 不再拒。
    // 传入当前 paneId/taskId snapshot 作 generation 证据，atomic update 校验匹配才写。
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

  // 无硬上限——配合 markDialogPending 的 human.intervention emit 让 operator 来；
  // DELETE/recreate 通过 creationToken 失配让循环自然退出。
  // runtime path（creationToken=undefined）下旧 poll 会撞 DELETE+recreate 后的新 agent（也无 token），
  // 需要 opts.expectedPaneId/expectedTaskId 作 generation 证据，loop top + atomic update 双重校验。
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
      // runtime path: 校验 paneId/taskId snapshot 匹配
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
      // The session's live pane is authoritative — never the stored snapshot. A runtime relaunch
      // (skills-stale rebuild, crash / Ctrl-C recovery) gives the session a fresh pane id; trusting
      // a stale state.paneId would poll a dead pane forever and the Held would never clear.
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
      // bootstrap path: creationToken set，agent 未绑 task；ready 后自动清 Held（无需 operator）。
      // runtime path: creationToken undefined，agent 仍绑 task（已被 handleDialogPendingFromRuntime
      // 推 failed）+ lock 在；ready 后切到 'agent_dialog_resolved_runtime' phase，让 resumeAgent 放行
      // 让 operator 显式确认。仍保留 awaiting_human + lock 防止"dialog ready 自动派下一 task 撞 pane"。
      const isBootstrapPath = creationToken !== undefined;
      // A create bootstrap that was blocked on a startup dialog still owes the greeting gate:
      // now that the dialog is dismissed and the REPL is ready, run it before clearing to 'ok',
      // else a dialog-resolved agent would reach the dispatch pool without proving capability.
      if (isBootstrapPath && !(await this.runGreetingHandshake(agentId, cfg, paneId))) {
        await this.markGreetingFailed(agentId, creationToken);
        return;
      }
      await this.agentStore.update(agentId, (fresh) => {
        if (!fresh) return AGENT_STORE_NOOP;
        if (generationMismatch(fresh)) return AGENT_STORE_NOOP;
        // A greeting capability hold must not be downgraded to a dialog-resolvable phase here (the
        // runtime branch would otherwise rewrite it to agent_dialog_resolved_runtime, which Resume
        // then releases un-regreeted). Preserve it; restart/retry's regreet is its recovery path.
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
        // runtime dialog 解决，phase 切到 resolved_runtime；emit 通知 operator 现在可以 Resume。
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

  // Idempotent; self-exits when taskId clears, so callers never need a paired stop.
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

      // Re-fetch after the async capture; release/reassign may have rewritten state.
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
          // A tmux probe failure here is transient — surface it, do NOT kill the REPL.
          throw new EnsureSessionError(
            { createdSession: false, agentId },
            `skills-version probe failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (stale) {
          // This REPL launched before the current skills were on disk; claude/codex only
          // discover a freshly-created top-level skills dir at launch, so a dispatched
          // /baxian-* / $baxian-* would not resolve. Rebuild so the command works.
          await tmux.killSession(agentId).catch(() => {});
          return this.buildFreshSession(tmux, agent, agentId, workdir);
        }
        // 复用既有 REPL，上下文未中断——dedup 仍可沿用。
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
        // Refuse send-keys — would land as input inside vim/make/etc instead of spawning REPL.
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
            // scrollback>0 risks matching a stale ready anchor from before trust prompt.
            scrollback: 0,
          });
          // 信任弹窗刚被答完，REPL 从启动态进入可用——上下文是新的。
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
      // shell 路径：在原 pane 里重新启动了 REPL，新进程没有旧 prompt 上下文。
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
      // Tag the lock with the taskId so post-merge cleanup can later prove it still owns it.
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

  // waiting: dev keeps lock across review/fix. idle: terminal release.
  // 纯状态更新——REPL 是否 ready 不在此处守门，dispatch 路径自己处理就绪问题。
  // awaiting_human 状态拒释：避免上游 catch（如 EnsureSessionError(dialogPending) 的 generic
  // fallback）撕掉 markAwaitingHuman 已标的 await 标记。resumeAgent 用 allowAwaitingHuman 接管。
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
      // Cancel-cleanup hold: only cancel's own release may free it. Checked BEFORE the allowAwaitingHuman
      // gate below, because that gate skips shouldReleaseHeldBinding entirely — so without this an
      // allowAwaitingHuman caller (startup false-start, review/max-rounds handlers, a terminal-task escape)
      // could reassign the un-cleared/maybe-running pane before cancel confirms /clear. (Operator recovery
      // via resumeAgent / DELETE doesn't go through this path.)
      if (isCancelCleanupHold(state) && !opts.fromCancelCleanup) {
        console.warn(
          `[AgentManager] releaseAgentForTask: agent ${agentId} ${state.awaitingPhase} (cancel-cleanup hold); refusing auto-release`,
        );
        return false;
      }
      const boundTask = await this.taskStore.get(expectedTaskId);
      if (state.status === 'awaiting_human' && !opts.allowAwaitingHuman) {
        // gate 例外：bound task 已 terminal / turn-completed phase 都属于正常 cleanup 路径，
        // 必须能清绑定，否则 stale binding 永久指向终态 task → 后续 acquire 全卡。
        // shouldReleaseHeldBinding 和 Resume 共享同一规则。
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
          // clearAwaitingHuman: restart-repl/retry 显式 operator op 已确认 REPL 重启，前面的
          // ack_unknown/dialog_pending Held 不再成立——清掉 awaiting_human 字段让 agent 可派遣。
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

  // baxian 把 agent 标为"自动调度走不通，等 operator 显式 resume"。
  // 唯一禁区入口：cancel C-c 失败 / dispatch ack_unknown / dialog 卡住等场景。
  // 保留绑定 + 锁，靠 canDispatchWithBinding 的 status 检查拦住自动派遣。
  // generation guard 防 DELETE+recreate race：
  //   - expectedCreationToken: 'tok' → store 当前 token 必须等于 'tok'
  //   - expectedCreationToken: null   → store 当前必须仍 *无* token（runtime path 用）
  //   - 不传                         → 不校验 generation
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
        const expected = opts.expectedCreationToken; // string | null
        const actual = existing.creationToken ?? null;
        if (actual !== expected) return AGENT_STORE_NOOP;
      }
      // taskId guard：迟到 mark 撞已 release+reassign 的 binding 时 noop
      // (caller 观察到 expectedTaskId 时 binding 还是它，update 时已变 = race lost)。
      if (opts.expectedTaskId !== undefined) {
        const expectedTask = opts.expectedTaskId; // string | null
        const actualTask = existing.taskId ?? null;
        if (actualTask !== expectedTask) return AGENT_STORE_NOOP;
      }
      // A cancel-cleanup hold is owned by the cancel flow: a generic dispatch-failure hold must not overwrite
      // it, and even a cancel-cleanup phase must not DOWNGRADE it (cancel-clear-failed is DELETE-only — softening
      // it to cancel-clearing/cancel-interrupt-failed would let Resume reuse an un-cleared pane).
      if (isCancelCleanupHold(existing)) {
        if (!CANCEL_CLEANUP_HOLD_PHASES.has(phase)) return AGENT_STORE_NOOP;
        if (cancelPhaseDowngrades(existing.awaitingPhase, phase)) return AGENT_STORE_NOOP;
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

  // dispatch catch helper：caller 调 startSession/continueSession 抛 DispatchTerminalError
  // 时统一区分 ack_unknown vs 其他 reason。返回 true 表示已 markAwaitingHuman（caller
  // 应跳过 release / rollback），返回 false 表示其他错误（caller 走常规清理）。
  // expectedTaskId: caller 当时观察到的 binding；mark 在 lock 释放后才执行的话，binding 可能
  // 已被 outcome/cancel release 给新任务，传 taskId 用作 atomic guard 避免污染无关 binding。
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

  // operator 显式恢复 awaiting_human 的 agent。
  // 如果 taskId 指向已 terminal 的 task，连带清掉绑定 + 锁——回归 idle 可派遣。
  // 如果 taskId 指向仍 active 的 task（罕见，比如 dialog_pending 期间 task 没 fail），保留绑定。
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
      // creationToken 仍 set = bootstrap dialog 仍未解决。Resume 不能让它"继续"——
      // dialog 在 pane 里需要 operator 通过 web terminal 处理，slowPoll 解决后自动清状态。
      // 如果 operator 想放弃这个 agent，应该走 DELETE 路径。
      if (state.creationToken) {
        const reason = 'Bootstrap dialog still unresolved; resolve it via the web terminal or DELETE the agent.';
        console.warn(`[AgentManager] resumeAgent: agent ${agentId} still has creationToken — ${reason}`);
        return { resumed: false, releasedBinding: false, reason };
      }
      const boundTask = state.taskId ? await this.taskStore.get(state.taskId) : null;
      // "prompt 可能仍在 pane 中跑"类 phase + bound task 仍 active 时 refuse：Resume 让
      // shouldReleaseHeldBinding 放行清 binding 后下一次 dispatchPendingTask 会把第二个 prompt
      // 派进同 pane 与旧 turn 混在一起。outcome 到达时 review.submitted handler 通过
      // allowAwaitingHuman:true 显式 release；这里不必再走 Resume。task terminal/missing 时则放行
      // — failTaskForDispatchError 的 ack_unknown 分支会把 task 推 failed 后保留 Held，
      // 此时唯一恢复路径就是 Resume。
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
      // agent_dialog_pending: pane 仍卡 startup dialog，REPL 未 ready。Resume 让
      // shouldReleaseHeldBinding 看 task terminal/missing 放行后会清 binding/lock，下一次
      // dispatchPendingTask 就会把新 prompt 派进仍卡 dialog 的 pane。dialog 的恢复路径只能是
      // operator 通过 web terminal dismiss → slowPollDialogPending 转 phase 到
      // agent_dialog_resolved_runtime（Resume 放行）或 bootstrap path 直接清 Held → status='ok'，
      // 或 DELETE agent。
      if (state.awaitingPhase === 'agent_dialog_pending') {
        const reason = 'Startup dialog still pending; Resume cannot dismiss it. Dismiss the dialog via the web terminal (baxian will auto-resume) or DELETE the agent.';
        console.warn(`[AgentManager] resumeAgent: agent ${agentId} — ${reason}`);
        return { resumed: false, releasedBinding: false, reason };
      }
      // agent_dialog_resolved_runtime + active task：正常路径下 handleDialogPendingFromRuntime
      // 已 fail task → boundTask 应 terminal。bound task 仍 active 表示 crash window
      // (handleDialogPendingFromRuntime 写 awaiting_human 后 transitionTaskStatus 前 crash)；
      // Resume 走 release path 会切 status=ok 但保留 binding + lock，prompt 从未发送 → task 静默卡死。
      // refuse Resume，提示 operator 显式 cancel task 或 DELETE agent。
      if (
        state.awaitingPhase === 'agent_dialog_resolved_runtime'
        && boundTask && ACTIVE_TASK_STATUSES.has(boundTask.status)
      ) {
        const reason = `Dialog resolved but task ${state.taskId} is still active and its prompt was never injected; Resume would strand it. Cancel the task or DELETE the agent.`;
        console.warn(`[AgentManager] resumeAgent: agent ${agentId} — ${reason}`);
        return { resumed: false, releasedBinding: false, reason };
      }
      // code-dispatch-failed: the code-phase prompt never reached the pane (spec
      // approval already transitioned the task). Resume = clear the hold AND
      // redispatch the code prompt (outside this lock) — without the redispatch
      // the task would stay in_progress with nothing running.
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
      // signal-arm-failed: the prompt was already dispatched but its pane-signal watcher never
      // armed. Resume here would only flip status→ok WITHOUT rebuilding the watcher (Resume has no
      // re-arm path), so the prompt's signal would still have no consumer — silent deadlock again.
      // Refuse while the task is active; operator must cancel the task or DELETE the agent to retry.
      if (
        state.awaitingPhase?.startsWith('signal-arm-failed')
        && boundTask && ACTIVE_TASK_STATUSES.has(boundTask.status)
      ) {
        const reason = `The dispatched prompt's pane signal has no consumer and Resume cannot rebuild the watcher; cancel task ${state.taskId} or DELETE the agent to retry.`;
        console.warn(`[AgentManager] resumeAgent: agent ${agentId} ${state.awaitingPhase} — ${reason}`);
        return { resumed: false, releasedBinding: false, reason };
      }
      // Un-cleared pane (cancel mid-clear or /clear unconfirmed): Resume would free + reuse it (terminal
      // task → shouldReleaseHeldBinding) and leak the cancelled task's context. Refuse; only DELETE (which
      // destroys the pane) is a safe recovery.
      if (state.awaitingPhase != null && UNCLEARED_PANE_PHASES.has(state.awaitingPhase)) {
        const reason = 'The pane holds un-cleared context from a cancelled task; Resume would leak it into the next task. DELETE the agent to discard it.';
        console.warn(`[AgentManager] resumeAgent: agent ${agentId} ${state.awaitingPhase} — ${reason}`);
        return { resumed: false, releasedBinding: false, reason };
      }
      // A greeting capability failure must be RE-PROVEN, not Resumed away: the default path below
      // flips status→'ok' regardless of shouldReleaseHeldBinding, which would put an unverified
      // agent back in the dispatch pool. The recovery path is restart-repl / retry (re-greets).
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
    // Outside the task lock: continueSession takes it internally.
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

  // ESC can't clear un-submitted composer text (pane never reaches ready); Ctrl-C does. Under the pane mutex
  // (no key interleave with a concurrent dispatch), C-c'd only while still the runtime and not mid-turn.
  private async interruptPaneAndWaitReady(
    state: AgentBindingFacts,
    cfg: AgentConfig & { projectId: string },
  ): Promise<boolean> {
    const paneId = await this.resolvePaneId(state, cfg);
    if (!paneId) return false;
    const tmux = new TmuxManager(this.createRunnerFor(cfg));
    const runtime = agentRuntimeKindFor(cfg);
    // An in-flight dispatch holds the mutex during its paste/ack; it releases once it sees the now-terminal task,
    // so wait briefly rather than dropping a cancel-during-paste straight to manual hold.
    if (!(await this.acquireCompactGuardWithin(cfg.id, this.cancelInterruptGuardWaitMs))) {
      console.warn(`[AgentManager] interruptPaneAndWaitReady: ${cfg.id} pane mutex still busy after wait; holding (un-cleared)`);
      // A longer-running holder (post-merge compaction, a slow image write) kept the mutex: cancel never
      // verified the pane, so classify it un-cleared/DELETE-only. The monotonic phase guard then blocks the
      // caller from softening it to a Resume-able cancel-interrupt-failed and reusing an un-cleared pane.
      await this.markAwaitingHuman(
        cfg.id,
        'cancel-clear-failed',
        'Cancel could not acquire the pane mutex to interrupt/clear (a dispatch/compact/upload held it); the ' +
          'pane state is unverified and may still hold the cancelled session. DELETE the agent to discard it.',
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
      // Ctrl-C can only restore a runtime prompt: if the pane crashed back to a shell or a human took it
      // over, it would hit their session instead — hold for a human.
      if (!(await this.paneRunsRuntime(tmux, paneId, runtime))) return false;
      if (await this.paneHasLiveTurn(tmux, paneId, runtime)) {
        console.warn(`[AgentManager] interruptPaneAndWaitReady: pane ${paneId} still running a turn after ESC; holding`);
        return false;
      }
      // Re-confirm: the runtime could have crashed to a shell during the ~1.4s liveness window; C-c must not
      // land in a foreign session.
      if (!(await this.paneRunsRuntime(tmux, paneId, runtime))) return false;
      try {
        await tmux.sendKeysToPane(paneId, 'C-c');
        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        console.warn(`[AgentManager] interruptPaneAndWaitReady: send C-c (composer clear) failed for pane ${paneId}:`, err);
        return false;
      }
      // Verify the OUTCOME via the canonical readiness check, not a guessed pre-state.
      return this.paneReachedReplReady(tmux, paneId, runtime, this.cleanComposerWaitMs);
    } finally {
      this.compactInFlight.delete(cfg.id);
    }
  }

  // Liveness = change across samples (pollution-immune): a static screen AND a static title are inert; only a
  // repaint or an advancing OSC braille title is a live turn. (A stale working-shaped title doesn't change.)
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
      if (title !== firstTitle && hasOscTitleWorking(title)) return true; // advancing spinner → live, even over a ready-looking frame
      if (hasRuntimeReadyView(frame, runtime)) return false; // visible idle overrides only a STATIC (stale) working title
      if (frame !== first) return true;
    }
    return false;
  }

  // Ctrl-C must only hit the runtime: confirm the pane's process is still codex/claude, else hold for a human.
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

  // Persist a "cancel is interrupting + /clearing this pane" hold BEFORE the ESC→/clear window so the
  // protection survives a restart (recover() holds UNCLEARED_PANE_PHASES) and the escape can't reassign the
  // un-cleared pane. Direct update (no intervention event): a normal cancel clears it on release; only a
  // crash/failure leaves it. Conditional on the binding so a stale cancel can't mark an agent rebound away.
  private async markPaneCancelClearing(agentId: string, taskId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.agentStore.update(agentId, (latest) => {
      if (!latest || latest.taskId !== taskId) return AGENT_STORE_NOOP;
      // Don't downgrade a more-locked hold (e.g. cancel-clear-failed, DELETE-only) back to the transient
      // cancel-clearing: a re-entrant terminal cleanup must not soften the un-cleared protection.
      if (cancelPhaseDowngrades(latest.awaitingPhase, 'cancel-clearing')) return AGENT_STORE_NOOP;
      return {
        ...latest,
        status: 'awaiting_human',
        awaitingPhase: 'cancel-clearing',
        awaitingReason: 'Cancelling: interrupting and clearing the runtime session; not reusable until /clear is confirmed or the agent is deleted.',
        awaitingSince: now,
        updatedAt: now,
      };
    });
  }

  // Returns whether /clear was confirmed (a real busy→idle, not the stale pre-/clear idle frame); the
  // caller must hold the agent, not release it, on false or the un-cleared context leaks to the next dispatch.
  private async clearPaneContext(
    state: AgentBindingFacts,
    cfg: AgentConfig & { projectId: string },
  ): Promise<boolean> {
    const paneId = await this.resolvePaneId(state, cfg);
    if (!paneId) return false;
    if (!this.tryAcquireCompactGuard(cfg.id)) {
      console.warn(`[AgentManager] clearPaneContext: ${cfg.id} compact/upload in progress; cannot /clear`);
      return false;
    }
    try {
      const tmux = new TmuxManager(this.createRunnerFor(cfg));
      const runtime = agentRuntimeKindFor(cfg);
      // C-c clears any prompt an ack-timeout left in the composer, so /clear isn't appended to it and submitted.
      await tmux.sendKeysToPane(paneId, 'C-c');
      await this.waitForReplPromptReady(tmux, paneId, runtime, this.clearContextWaitMs);
      await tmux.sendKeysLiteral(paneId, '/clear');
      // Snapshot the composer holding the typed /clear; require submission proof so a swallowed Enter
      // (which would leave /clear idle in the composer and let waitForReplPromptReady pass on the stale
      // frame) is resent rather than treated as cleared.
      const beforeSubmit = await tmux.capturePaneSnapshot(paneId);
      await tmux.sendEnter(paneId);
      await tmux.waitSubmitAck(paneId, beforeSubmit, runtime, {
        timeoutMs: this.clearContextWaitMs,
        acceptComposerChange: true,
        resend: () => tmux.sendEnter(paneId),
        resendIntervalMs: this.compactIdlePollMs,
      });
      await this.waitForReplPromptReady(tmux, paneId, runtime, this.clearContextWaitMs);
      // A rejected /clear ("…is disabled while a task is in progress.") returns to a bare prompt that now reads
      // ready — but the context was NOT cleared, so hold the pane instead of releasing it.
      if (await this.hasRuntimeSlashCommandRejection(tmux, paneId, '/clear')) {
        console.warn(`[AgentManager] clearPaneContext: /clear rejected (task still in progress) for ${cfg.id}; unconfirmed`);
        return false;
      }
      // /clear still parked in the composer → its Enter was swallowed, never submitted → unconfirmed.
      const afterClear = await tmux.capturePaneById(paneId, { ansi: false, scrollback: 0 });
      if (CLEAR_PENDING_IN_COMPOSER_RE.test(afterClear)) {
        console.warn(`[AgentManager] clearPaneContext: /clear still in composer for ${cfg.id}; unconfirmed`);
        return false;
      }
      return true;
    } catch (err) {
      console.warn(`[AgentManager] clearPaneContext: /clear failed for ${cfg.id}:`, err);
      return false;
    } finally {
      this.compactInFlight.delete(cfg.id);
    }
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
    // ack_unknown: sendEnter 已发，prompt 可能已被 REPL 接收并正在执行——
    // 不能 release 让下一任务排队进同一 pane。pre-Enter 错误（prompt_too_large /
    // required_skills_missing / gate_failed）则正常 release。
    if (err.reason === 'ack_unknown') {
      await this.markAwaitingHuman(
        agentId,
        `dispatch-failed:${err.reason}`,
        `${err.message}. Prompt may still be running in the pane; verify before resuming.`,
        { expectedTaskId: taskId },
      );
      // task 已 terminal: 同步释放 partner agent binding，否则 partner（如 dev）永远绑 terminal task，
      // retryTask 走 validateTaskDispatch 时会看 dev 仍 bound → 409，UI Retry 通路被堵。
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
        // Human gates are decision states, not running work: an absent agent
        // session must not terminally fail a task whose published PR/branch
        // would then be orphaned — Confirm/Cancel remain the only exits.
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
          // allowAwaitingHuman: task 已 terminal 必须能完整清理；partner 即使被标 Held（罕见）
          // 也应释放，否则 partner stale binding 永远指向 terminal task → 后续 acquire 全卡。
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

  // 100ms poll: fixed 200ms races runtimes that take >200ms to ack SIGINT.
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

    // Re-materialize skills BEFORE the relaunch so the fresh REPL scans the current tree. restart-repl
    // is the operator's recovery for a greeting_failed agent whose on-disk skill tree was stale/missing,
    // and unlike retry it does not go through ensureSession's provisionRepoSkills. Best-effort: a
    // provisioning blip must not block the REPL restart (a still-broken tree surfaces on the next regreet).
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
      // Only re-tag when the tree was actually re-provisioned. Tagging after a FAILED provision
      // would stamp the current version onto a REPL that scanned the stale/missing tree, so the
      // next ensureSession reads it as fresh and reuses it instead of self-healing (rebuild). A
      // successful provision DOES need the tag, else ensureSession needlessly kills this REPL and
      // drops the agent onto a different, ungreeted one.
      if (provisioned) {
        await this.tagSessionSkillsVersion(tmux, agentId);
      }
    };
    // Hold the per-skills-dir lock ACROSS the relaunch (like buildFreshSessionLocked) so a concurrent
    // same-dir agent's provisioning — which transiently removes helper files (agents/openai.yaml) —
    // can't make this fresh REPL scan an incomplete skill tree.
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

  // Aggregates failures so DELETE rolls back the session claim on remote IO error.
  async cleanupRemovedAgentRuntime(targets: string[]): Promise<void> {
    const failures: Array<{ agentId: string; step: string; error: unknown }> = [];

    for (const id of targets) {
      const cfg = this.getAgentConfig(id);
      if (!cfg) continue;
      const runner = this.createRunnerFor(cfg);
      const tmux = new TmuxManager(runner);
      const worktree = new WorktreeManager(runner);

      this.stopRuntimeMenuWatch(id);

      // Streamer first so subscribers see session_gone.
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

  // IO-free preview; caller compares vs MAX_PROMPT_BYTES_ROUTE_LIMIT before allocating worktree.
  // preferredAgentId 为空 → 用项目内 dev 的最长 workdir 估上界（unassigned 路径），dispatch 时仍
  // 会按真实 dev 再算一次；preferredAgentId 有值 → 按该 dev 的 config 算，避免按全局上界误拒。
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
      // A representative token so the preview exercises the SAME required-skill set (baxian-signals)
      // and worst-case byte size the real signal-emitting dispatch will build — else a missing
      // baxian-signals only surfaces async after the task is already created (201).
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
    // Store write + watcher.start under one lock — otherwise concurrent clear zombies the sub.
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

  // Recovery snapshot replay is safe because the completion token is cleared after merge-ready.
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

  // snapshot 扫描按协议族决定：server 协议（含全模式 spec 阶段）恢复时必扫，github code 阶段仅 review/fixing 扫。
  // 只对 spec verdict / spec-fixed emit intervention — spec-done 在 develop
  // prompt 里是 optional, 报警会让所有 in_progress task 噪音化。
  // expectedKinds 必须覆盖 dispatch 时实际 set up 的 kind 集，否则真信号无法匹配。
  async setupRecoveredSpecSignals(): Promise<void> {
    if (!this.phaseSignalWatcher) return;
    const tasks = await this.taskStore.list();
    for (const task of tasks) {
      if (!task.signalToken) continue;
      const mapped = this.mapTaskStateToExpectedWatcher(task);
      if (!mapped) continue;
      const { expectedKinds, agentId } = mapped;
      // Only spec verdict / spec-fixed / PR verdict warrant an intervention —
      // optional kinds (spec-done, pr-created in develop) would spam every
      // in_progress task on restart.
      const interventionKindLabel: string | undefined =
        task.phase === 'spec' && task.status === 'review' ? 'spec-reviewed'
        : task.phase === 'spec' && task.status === 'fixing' ? 'spec-fixed'
        : task.phase !== 'spec' && task.status === 'review' ? 'pr-approved|pr-changes-requested'
        : task.phase !== 'spec' && task.status === 'fixing' ? 'pr-fixed'
        : undefined;
      // spec 阶段恒为 server 协议（无 poller 兜底）；code 阶段才按 reviewMode 区分。
      // Scan pane snapshot on recover for signals the agent emitted before the
      // server consumed them (lost on restart; agent won't re-emit).
      // github code states (review/fixing): replay-safe handlers — token + status
      // gates reject duplicates; PR verdict & pr-fixed covered.
      // github pre-spec (phase undefined, in_progress): spec-done has only the pane
      // channel (pr-created has a poller backstop, scanning it is idempotent).
      // server protocol incl. all-mode spec phase: no poller backstop, pane is the
      // only signal channel; handlers equally replay-safe via same gates.
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

  // Weak "did the dev do anything since the review was dispatched" heuristic for a
  // no-push fixing round: any inline thread reply (in_reply_to_id set) OR any
  // top-level PR/issue comment created after sinceIso. baxian can't attribute
  // comments to an agent (no GitHub identity), and findings may live in the review
  // body / issue comments / a same-identity `gh pr review --comment`, so this only
  // separates a true no-op (zero activity) from a real round — QA still does the
  // real per-finding check. THROWS on gh failure so the caller fails closed (a
  // swallowed error would masquerade as "no reply" → false no-op intervention).
  async prHasDevReplySince(taskId: string, sinceIso: string): Promise<boolean> {
    const task = await this.taskStore.get(taskId);
    if (!task?.prNumber) return false;
    const project = this.getProjectConfig(task.projectId);
    if (!project) return false;
    const since = Date.parse(sinceIso);
    if (Number.isNaN(since)) return false;
    // Three independent endpoints — fetch concurrently, not back-to-back. Reviews
    // cover the same-identity `gh pr review --comment` reply path (a PR review with
    // a body, surfaced via submitted_at, not an inline/issue comment).
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

  // Each matched `created_at` across ALL pages. `gh api --paginate` with `--jq`
  // runs the filter per page and concatenates output, so emitting one timestamp
  // per row (not a per-page `length`) is the only way to count across pages.
  // Throws on non-zero exit so callers can fail closed.
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

  // Pane signals are agent-emitted text; their prNumber is whatever the agent
  // chose to print. Without branch-equality verification the server would
  // happily QA-review and later auto-merge a PR that belongs to a different
  // task (typo / hallucination / copy-paste). Poller-sourced events skip this
  // because the poller routes by `bx/<taskId>` branch already.
  // Returns the verified headSha on success, undefined on mismatch / lookup
  // failure (caller treats as "do not trust this prNumber").
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

  // Count a review pass exactly once, on the dispatch success path (a failed dispatch
  // returns before calling this, so the round is never inflated → no rollback needed).
  // `expectedRound` is the reviewRound captured BEFORE the dispatch transition. Under the
  // lock: if a same-identity verdict raced in between startSession and this call, its
  // review.submitted handler already counted the pass — moving reviewRound off
  // expectedRound — so this no-ops. This is symmetric for the first review (expected 0,
  // verdict counts via reviewRound===0) and an approved re-review (expected ≥1, where the
  // verdict does NOT catch-count) — both end at exactly one increment. withTaskLock
  // serializes this against the verdict transition.
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

  // Empty repos lack origin/HEAD; undefined makes git use base repo HEAD.
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
    // Cancel may have taken over (markPaneCancelClearing keeps taskId, flips to a cancel-cleanup hold). This
    // rollback would clear taskId + release the lock, making cancel's Phase 1 skip interrupt + /clear and leave
    // an un-cleared pane bound to nothing — leave the binding/lock to the cancel owner.
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

      // Stage images first so the task is written + emitted (task.created) WITH its images already
      // on disk — a pending task is never observable, or crash-recoverable, without them. A persist
      // failure here throws before any store write / lock, so nothing half-created survives.
      const imageFilenames = input.images?.length
        ? await this.persistTaskImages(taskId, input.images)
        : undefined;

      // Unassigned: no dev to pick, no qa to derive; goes straight to pending.
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
        // Mark not-yet-delivered from the moment the binding exists — before ensureSession/worktree
        // side-effects — so a crash anywhere in the bootstrap is recoverable (see recover()).
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
    // createTask stages images atomically before the task is visible (store + task.created),
    // so a pending task can never be observed — or crash-recovered — without its images.
    const task = await this.createTask(projectId, input);
    if (task.status === 'in_progress' && task.agentId) {
      // Persist token first — prompt build 和 watcher 验证共用 task.signalToken。
      const signalToken = createSignalToken();
      await this.updateTask(task.id, { signalToken });
      const start = this.startCreatedTaskSession(task.id, task.agentId, signalToken);
      if (opts.background) {
        // Agent bootstrap (worktree + REPL spawn + ready-poll) can take tens of seconds; don't block
        // the create response on it. Failures still land on the task (failed / rolled back) and reach
        // the UI through the same task-event stream as every other lifecycle transition.
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
      // A user Cancel can race the background bootstrap. startSession's success path may have already
      // injected the prompt, so the task can be terminal here with the cancelled prompt still live in the
      // pane. Mirror cancelTask: interrupt + confirm the pane is ready before idle-releasing, else hold —
      // a bare release would hand a pane still running the cancelled prompt to the next dispatch. (If
      // cancel already cleared the binding, releaseAgentForTask is a safe no-op.)
      const fresh = await this.taskStore.get(taskId);
      if (!fresh || TERMINAL_STATUSES.includes(fresh.status)) {
        const cfg = this.getAgentConfig(agentId);
        const state = await this.agentStore.get(agentId);
        if (cfg && state && state.taskId === taskId) {
          // Persist the un-cleared hold before the ESC→/clear window so a restart mid-cleanup recovers it
          // held instead of releasing the still-dirty pane (mirrors cancelTask).
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
          if (!(await this.clearPaneContext(state, cfg))) {
            await this.markAwaitingHuman(
              agentId,
              'cancel-clear-failed',
              'Task was cancelled during startup and the session interrupted, but /clear was not confirmed; ' +
                'the pane holds un-cleared context. DELETE the agent to discard it (Resume will not reuse an un-cleared pane).',
              { expectedTaskId: taskId },
            );
            return null;
          }
          // /clear confirmed → cancel cleanup is done; free the cancel-clearing hold (only path allowed to).
          await this.releaseAgentForTask(agentId, taskId, 'idle', { allowAwaitingHuman: true, fromCancelCleanup: true });
          return null;
        }
        // No live pane to clean (agent gone / rebound): release without the cancel-cleanup bypass — if it
        // somehow holds an un-cleared phase, refusing here keeps the dirty pane for the owning cancel.
        await this.releaseAgentForTask(agentId, taskId, 'idle', { allowAwaitingHuman: true });
        return null;
      }
      // 后台路径吞掉 reject（void start.catch）：arm 抛异常时也要显式 hold agent，否则会留下一个没有
      // spec-done/pr-created 消费者的常驻任务（同步 caller 仍由上游收到异常）。
      // Kinds derive from the task's frozen reviewMode — a hot mode flip during the
      // startSession window must not desync the armed kinds from the sent prompt.
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
      // handleDialogPendingFromRuntime 已标 Held + fail task + release partners；rollback 会清 taskId/lock
      // 让仍卡 dialog 的 pane 在 status='awaiting_human' 被清后可被新 dispatch 撞进——必须跳过。
    } else {
      // startSession returned false. Usually the task changed under us (cancelled/terminal). If it went
      // terminal mid-bootstrap (e.g. the user cancelled before the pane existed — cancelTask then held the
      // agent as cancel-interrupt-failed with nothing actually running), rollbackFailedDispatch only acts
      // on in_progress tasks, so it would leave the agent bound to the dead task needing a manual Resume.
      // Release it instead so the agent is free for the next dispatch.
      const fresh = await this.taskStore.get(taskId);
      if (fresh && TERMINAL_STATUSES.includes(fresh.status) && (await this.agentStore.get(agentId))?.taskId === taskId) {
        await this.releaseAgentForTask(agentId, taskId, 'idle', { allowAwaitingHuman: true });
      } else {
        await this.rollbackFailedDispatch(taskId, agentId);
      }
    }
    return (await this.taskStore.get(taskId)) ?? null;
  }

  /** Write an uploaded image to the running agent's host, paste its path (no Enter). */
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
    // 写文件→粘贴全程持有 pane 互斥：写文件可能卡住，恢复后的粘贴若落进
    // compact 的 C-c→/compact 窗口会把路径拼进指令提交。
    if (!this.tryAcquireCompactGuard(agentId)) {
      throw new ApiError(409, `Agent ${agentId} compact or upload in progress; retry shortly`);
    }
    try {
      // Refuse to paste into a pane cancel is tearing down. Re-check BOTH before and after the (slow) host
      // write: cancel keeps taskId while flipping the hold, and it can land during writeImageToHost.
      const assertUploadStillValid = async (): Promise<void> => {
        const held = await this.agentStore.get(agentId);
        if (!held || held.paneId !== paneId) {
          throw new ApiError(409, `Agent ${agentId} session changed while uploading; image paste aborted`);
        }
        const boundTask = held.taskId ? await this.taskStore.get(held.taskId) : null;
        if (boundTask && TERMINAL_STATUSES.includes(boundTask.status)) {
          throw new ApiError(409, `Agent ${agentId} task ${held.taskId} is terminal; image upload refused`);
        }
        // taskStore.get yielded the loop — re-read the cancel hold LAST so a hold that landed during that await
        // (e.g. while the slow host write was running) is caught before the paste.
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
      // updatedAt 拦同任务 phase 派发（paneId/taskId 均不变，派发 paste 前必写 state）；
      // 快照变了决不注入——中断键（C-c/Escape）会打断刚注入的 prompt。
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
      // Codex quits on Ctrl-C at an empty composer (openai/codex#14708); interrupt it with Escape instead.
      await tmux.sendKeysToPane(paneId, cfg.runtime === 'codex' ? 'Escape' : 'C-c');
      await waitReady();
      await assertSessionUnchanged();
      await tmux.sendKeysLiteral(paneId, command);
      await tmux.sendEnter(paneId);
      if (command === '/clear') {
        await this.agentStore.update(agentId, (s) => {
          if (!s) return AGENT_STORE_NOOP;
          return { ...s, injectedSkills: undefined };
        });
      }
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

  // Retry reads staged bytes up-front; a missing source is a visible 409, never a silent drop.
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

  // Materialize staged task images onto the agent host at dispatch; absolute host paths get
  // woven into the prompt. Missing staging aborts the dispatch loudly (no silent skip).
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

  // Dev-facing deliverable phases all carry the task's uploaded images, since the image is a
  // persistent task input the dev needs while producing or revising the spec/code — and a fresh
  // runtime (restart/recovery) loses the original context. IMAGE_DISPATCH_PHASES 中的后续阶段经
  // continueSession 触发此方法；QA 阶段和 post-approve 不传图。
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
      // 优先沿用 fresh.qaAgentId；缺失（unassigned claim / 旧 task 建时无 QA 伙伴）才查当前 config。
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
        // Same not-yet-delivered marker as createTask, so a crash mid-redispatch is recoverable too.
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
      // handleDialogPendingFromRuntime 已处理；跳过 rollback。
    } else {
      await this.rollbackFailedDispatch(claimed.id, claimed.agentId);
    }
    const refreshed = await this.taskStore.get(claimed.id);
    // startSession 返回 false 而没抛 → 任务状态在锁外发生了变化（如并发 cancel / 已 terminal），
    // 客户端按 409 提示重试 / 刷新即可；只有真正的 dispatch 异常映射为 500。
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
      // dialog 失败时 fail task 的允许 fromStatus 集合；caller (如 dispatchReviewToQa 走
      // bypassTaskStatusGate + 先 startSession 后 transition) 显式传当时 task 实际状态
      // 覆盖默认的 PHASE_EXPECTED_STATUS[phase]。
      dialogFailFromStatuses?: TaskStatus[];
      serverContent?: string;
      serverDiffstat?: string;
      serverBatch?: { index: number; total: number };
      serverPriorFindings?: string;
      serverPriorResponse?: string;
      contentTruncated?: boolean;
      // Pre-inject hook: armed once the pane exists but before the prompt is pasted. Returns false
      // to abort the dispatch (e.g. the signal watcher could not arm).
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
    // bypassTaskStatusGate 只放过 expected gate，不放过 terminal。
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

    // Persist worktreePath now so a crash before set-running leaves a recoverable trail.
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

    // Caller-transmitted token/round take precedence — task fields are stale during dispatch.
    const promptSignalToken = opts.signalToken ?? task.signalToken;
    const promptSpecRound = opts.currentSpecRound ?? task.specReviewRound;
    const beforeInjectAgent = await this.agentStore.get(agentId);
    // freshRuntime=true 覆盖两种场景：(a) buildFreshSession 全新 tmux session；
    // (b) adoptOrRestartSession 的 shell 重启 / trust-dialog 答完——pane 仍在但 REPL
    // 是新进程。两种情况下旧上下文都没了，必须重置 dedup baseline，决不能因为
    // paneId 字符串恰好相同就沿用旧 skill 集。
    const reuseInjectedSkills = ensure.freshRuntime
      ? null
      : reuseSkillsIfContextValid(beforeInjectAgent, taskId, paneId);
    // develop prompt 按 QA 有无裁剪 spec 路线（qaAgentId 快照优先，与 review 派发同一解析）。
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
        ...(reuseInjectedSkills ? { excludeSkills: reuseInjectedSkills } : {}),
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
      // Terminal — rolling back to pending would loop on the same misconfiguration.
      if (err instanceof PromptSizeError) {
        throw new DispatchTerminalError('prompt_too_large', err.message);
      }
      if (err instanceof RequiredSkillsMissingError) {
        throw new DispatchTerminalError('required_skills_missing', err.message);
      }
      throw err;
    }

    // Last cancellable boundary before paste.
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

    // Pane exists now but the prompt is not out — arm here so a request it triggers is a live chunk,
    // not snapshot-suppressed scrollback. Abort cleanly (no binding written yet) if it cannot arm.
    if (opts.armBeforeInject && !(await opts.armBeforeInject())) {
      try { await worktree.removeWithBranch(workdir, worktreePath, customBranch); } catch {}
      return false;
    }

    const now = new Date().toISOString();
    let agentMarkedRunning = false;
    try {
      let cancelHoldWon = false;
      await this.agentStore.update(agentId, (existing) => {
        // This fresh rebuild would drop awaitingPhase: if cancel raced a hold in, overwriting it skips /clear.
        if (isCancelCleanupHold(existing)) { cancelHoldWon = true; return AGENT_STORE_NOOP; }
        return {
          id: agentId,
          projectId: agent.projectId,
          paneId,
          taskId,
          worktreePath,
          repoPath: workdir,
          startedAt: now,
          // Mark this dispatch as mid-bootstrap until the prompt is ack'd — recover() rolls back only a task
          // it can positively see was never delivered, so a crash here doesn't leave it silently stuck.
          bootstrappingTaskId: taskId,
          updatedAt: now,
          ...(existing?.creationToken !== undefined ? { creationToken: existing.creationToken } : {}),
          ...(reuseInjectedSkills
            ? { injectedSkills: { taskId, paneId, skills: reuseInjectedSkills } }
            : {}),
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

      const ack = await this.injectAndAwaitAck(tmux, paneId, prompt, agentId, agent.runtime);
      // Prompt delivered → clear the mid-bootstrap marker IMMEDIATELY, before the slower persist/emit/watch
      // steps: a crash between ack and the clear would otherwise leave recover() seeing a stale marker on
      // an already-running prompt and re-dispatching it. The clear is best-effort and NON-destructive — its
      // own catch holds for human rather than falling into the dispatch-failure teardown below (a storage
      // blip must not tear down a prompt that's already running, nor leave a stale marker recover re-runs).
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
      // dedup baseline 记录的是「已 paste 进 idle composer 的 skill 文本」：paste 落入 composer 即进
      // REPL 上下文，与 submit-ack 无关。ack 超时（首个 Enter 被吞）下 skill 仍在 composer，跳过落盘会让
      // 下一轮整组重注入——即 SKILLS 重复注入。但 composerDelivered=false（paste 时 pane
      // 已 busy，文本进了运行中输入流而非 composer）则不能落盘，否则恢复提示会缺必需 skill。freshRuntime
      // 负责 REPL 真正重启时作废 baseline。
      if (ack.composerDelivered) {
        await this.persistInjectedSkills(agentId, taskId, paneId, agent.role, phase, reuseInjectedSkills);
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
      // ack_unknown 表示 sendEnter 已发，prompt 可能正在 REPL 中执行。
      // 清绑定/lock/worktree 会让下一任务复用仍在跑旧 prompt 的 pane——保留所有 state，
      // 由上游 failTaskForDispatchError → markAwaitingHuman 接手等人。
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
              // Cancel may have taken over the binding while we waited for the pane mutex: markPaneCancelClearing
              // keeps taskId but flips it to a cancel-cleanup hold. Tearing it down here would drop that hold and
              // make cancel's Phase 2 skip /clear, reusing an un-cleared pane — leave it to the cancel owner.
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

  // 注入方必须持有 pane 互斥：compact 侧的快照校验关不死「校验→按键」
  // 之间的 async 边界，竞态只能在这里关死。
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
      // guard 等待期间任务可能被 Cancel（释放绑定）或会话重建；过期派发
      // 决不落 pane。无快照（direct 调用）时跳过——真实派发必有绑定。
      if (before) {
        const now = await this.agentStore.get(agentId);
        if (!now || now.paneId !== before.paneId || now.taskId !== before.taskId) {
          throw new Error(
            `dispatch aborted: agent ${agentId} binding changed while waiting for pane mutex`,
          );
        }
        // Refuse to inject a cancelled task's prompt into a pane cancel is about to /clear — else this
        // dispatch wins the mutex in cancel's interrupt→/clear gap and clearPaneContext fails to re-acquire
        // it, stranding the agent at cancel-clear-failed. Cancel persists the agent hold
        // (markPaneCancelClearing, keeps taskId) BEFORE flipping the task terminal, so check the hold too —
        // a task-status-only check would slip through the window between the two writes.
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
        // taskStore.get yielded the loop — re-read right before the paste so a cancel hold that landed during
        // that await can't slip an injection into a pane cancel has taken over.
        const fresh = await this.agentStore.get(agentId);
        if (!fresh || fresh.paneId !== before.paneId || fresh.taskId !== before.taskId || isCancelCleanupHold(fresh)) {
          throw new Error(`dispatch aborted: agent ${agentId} taken over by cancel before paste`);
        }
      }
      return await this.injectAndAwaitAckSteps(tmux, paneId, prompt, agentId, runtime);
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
  ): Promise<{ acked: boolean; composerDelivered: boolean }> {
    await tmux.injectPrompt(paneId, prompt, agentId);
    let baseline: string;
    try {
      // Pre-Enter failure is raw, not ack_unknown (3331269349); but the leftover prompt must not reach
      // a reused pane (#223), so only release when the composer is cleared or the session is gone.
      baseline = await tmux.captureSettledSnapshot(paneId, { timeoutMs: this.dispatchSettleTimeoutMs });
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
        resend: () => tmux.sendEnter(paneId),
        resendIntervalMs: this.dispatchAckResendIntervalMs,
      });
      return { acked: true, composerDelivered: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 仅 ack 超时走 intervention（REPL 排队 OK 等人查看）；其他错误（capturePaneSnapshot
      // 等基础设施失败）当 dispatch 终态错误抛出，由上游标 task failed。
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
      // "pane already busy at baseline" means the paste landed on an already-running input stream,
      // NOT an idle composer — the skills did NOT become context, so callers must not record them
      // as injected. Any other timeout (idle composer / swallowed Enter) did
      // deliver the prompt text into the composer.
      const composerDelivered = !/pane already busy at baseline/.test(message);
      return { acked: false, composerDelivered };
    }
  }

  // Returns true once the pane is safe to release for reuse after a pre-Enter failure: C-c cleared the
  // unsubmitted prompt, or the session is gone (next dispatch rebuilds fresh). Returns false when
  // neither could be confirmed — the caller then holds the agent instead of reusing a dirty composer.
  private async clearComposerForReuse(tmux: TmuxManager, paneId: string, agentId: string): Promise<boolean> {
    try {
      await tmux.sendKeysToPane(paneId, 'C-c');
      return true;
    } catch (err) {
      console.warn(`[AgentManager] clearComposerForReuse: C-c failed for pane ${paneId}:`, err);
    }
    try {
      return !(await tmux.hasSession(agentId));
    } catch (err) {
      console.warn(`[AgentManager] clearComposerForReuse: hasSession probe failed for ${agentId}:`, err);
      return false;
    }
  }

  // Snapshot which skills are now resident in the REPL's context, union of
  // the pre-dispatch baseline (when context was still valid) and the phase's
  // declared skills. Guarded by (taskId, paneId) so a concurrent rebind never
  // overwrites a freshly-bound agent.
  private async persistInjectedSkills(
    agentId: string,
    taskId: string,
    paneId: string,
    role: AgentConfig['role'],
    phase: string,
    reuseInjectedSkills: string[] | null,
  ): Promise<void> {
    const phaseSkills = this.skillRegistry.skillsForPhase(role, phase);
    const baseList = reuseInjectedSkills ?? [];
    // 已有有效 context 记录，且本 phase 没有引入新 skill → 写盘无信息增益，short-circuit。
    // reuseInjectedSkills === null 时缺基线记录，仍需建一份初始档。
    if (reuseInjectedSkills !== null && phaseSkills.every(s => baseList.includes(s))) return;
    const merged = Array.from(new Set([...baseList, ...phaseSkills]));
    const now = new Date().toISOString();
    await this.agentStore.update(agentId, (latest) => {
      if (!latest || latest.taskId !== taskId || latest.paneId !== paneId) return AGENT_STORE_NOOP;
      return {
        ...latest,
        injectedSkills: { taskId, paneId, skills: merged },
        updatedAt: now,
      };
    });
  }

  // Ready gate prevents mid-paste webhook from flipping to 'waiting' on a busy REPL.
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
    // 与 startSession 同步：任何 REPL 启动 / 重启路径（freshRuntime=true）都视为新上下文，
    // 强制重新注入完整 skill 集——既覆盖 fresh tmux session，也覆盖同 pane 里的 shell 重启
    // 与 trust-dialog 完成两种 adopt 场景。
    const reuseInjectedSkills = ensure.freshRuntime
      ? null
      : reuseSkillsIfContextValid(agentState, taskId, paneId);
    let prompt: string;
    try {
      // freshRuntime=true 表示 tmux/REPL 刚新建或重启，旧 post-approve prompt 上下文已丢失
      // (同步：reuseInjectedSkills 在 freshRuntime 时也强制 null 重发 skill 集)。此时即使
      // redispatchCount>0 也必须发完整长段，否则 dev 拿不到 T_self / idempotency / final
      // re-fetch / 禁止 merge 等首轮规则。
      const useIncrementalNudge =
        typeof opts.postApproveRedispatchCount === 'number'
        && opts.postApproveRedispatchCount > 0
        && !ensure.freshRuntime;
      // code phase (post spec-approval) flows through here, not startSession — materialize the
      // task's uploaded images so a fresh code-phase context still sees their paths.
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
        ...(reuseInjectedSkills ? { excludeSkills: reuseInjectedSkills } : {}),
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

    // Final state re-check before the irreversible paste — guards against IO-window races.
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

    // Arm before paste (same reasoning as startSession): pane exists, prompt not out yet.
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
        ...(reuseInjectedSkills
          ? { injectedSkills: { taskId, paneId, skills: reuseInjectedSkills } }
          : { injectedSkills: undefined }),
      };
    });

    const ack = await this.injectAndAwaitAck(tmux, paneId, prompt, agentId, agent.runtime);
    // 仅 composer 投递成功才落 dedup baseline（理由见 startSession）；freshRuntime 负责 REPL 重启时作废。
    if (ack.composerDelivered) {
      await this.persistInjectedSkills(agentId, taskId, paneId, agent.role, phase, reuseInjectedSkills);
    }
    return true;
  }

  // A bootstrappingTaskId marker means a dispatch began (binding written) but its prompt was never
  // ack-cleared. The one exception is a delivered task whose marker-clear write blipped (held as
  // bootstrap-marker-clear-failed) — its prompt is running, so leave it. (ack_unknown fails the task to a
  // terminal status, so the in_progress check excludes it.) Everything else with the marker — not yet
  // started, or held on a startup dialog — never ran, so rolling back to pending (and removing the empty
  // worktree, which rollbackFailedDispatch wouldn't) is safe and lets normal dispatch restart it.
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
    // Durable cross-check: the session.started event lives in a separate log that survives an
    // agent-store-specific write failure. If one exists, the prompt WAS delivered (the marker is stale
    // because its clear — and the held fallback — both failed). Rolling back would duplicate a running
    // prompt; instead clear the stale marker and leave the task to the normal re-attach path.
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
    // rollbackFailedDispatch spreads the old binding, keeping any awaiting_human/awaitingPhase (e.g. a
    // dialog-pending hold) — which would leave the now-unbound agent non-dispatchable
    // (canDispatchWithBinding refuses awaiting_human). Clear the held state so the preferred agent can
    // pick the re-queued task back up without a manual Resume.
    await this.agentStore.update(state.id, (latest) => {
      if (!latest || latest.status !== 'awaiting_human') return AGENT_STORE_NOOP;
      const { status: _s, awaitingPhase: _p, awaitingReason: _r, awaitingSince: _a, ...rest } = latest;
      return { ...rest, updatedAt: new Date().toISOString() };
    });
    return true;
  }

  // session.started is emitted (to the event log) only after the prompt is delivered, so its presence is
  // durable proof of delivery even if the agent-store marker-clear failed. Task ids are never reused, so a
  // match is unambiguous; scan from the task's creation date forward.
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
        // A develop bootstrap interrupted before its prompt was ack'd leaves an in_progress task whose
        // runtime never received it; recover() can't re-deliver, so roll it back to pending (helper). We do
        // NOT treat freshRuntime alone as missing (that would discard a delivered task's worktree on host
        // reboot) — only a positively-marked, never-ack'd dispatch is rolled back. (Same check runs in the
        // dialog-pending catch below, so a mid-bootstrap task blocked on a startup dialog isn't held forever.)
        if (await this.rollbackUndeliveredBootstrap(state, agentConfig)) continue;
        // An incomplete create bootstrap (creationToken still set, no task) crashed before it
        // proved signal capability. Re-run the greeting gate — but in the BACKGROUND: recover() is
        // awaited before the server serves, and a synchronous handshake would block startup up to
        // 2×greeting-timeout per such agent (serially). creationToken stays set meanwhile, so
        // canDispatchWithBinding keeps the agent out of the pool until the handshake resolves.
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
        // recover 成功 = server 重启前 dialog_pending 的 agent 现在 REPL ready。
        // 处理 Held：与 resumeAgent 共用 shouldReleaseHeldBinding 规则（task terminal/无 task /
        // turn-completed phase → 同步清 binding；task active 且 phase 不在 completed 集合 → 保留 binding）。
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
              prNumber: boundTask.prNumber,
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
        // A cancel-cleanup hold must NOT be auto-released on restart (it would reuse the cancelled,
        // un-cleared/maybe-running pane). cancel-interrupt-failed has shouldReleaseHeldBinding=true (it's
        // operator-Resume recoverable), so exclude the whole cancel-cleanup set here explicitly.
        const cancelHold = isCancelCleanupHold(state);
        const shouldReleaseBinding = shouldReleaseHeldBinding(state, boundTask) && !cancelHold;
        // 释放 binding 时同步清 worktree（与 resumeAgent 一致）——否则跨重启恢复后
        // worktreePath 在下面 update 中被丢弃，磁盘上的 worktree 永远无人回收。
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
        // 所有 awaiting_human + non-releasable binding 都保留 Held。包括 agent_dialog_pending +
        // active task 这个 crash window 场景：handleDialogPendingFromRuntime 已写 awaiting_human
        // 但 transitionTaskStatus 之前 crash 重启 → task 仍 active；recover 切到 ok 会丢失 Resume
        // 入口、binding 仍指向 active task → 新 dispatch 撞 stale binding。
        // 注意：agent_dialog_pending + 无 taskId（最 common 的 dialog_pending） → shouldReleaseBinding=true
        // → preserveHeld=false → 走 release path 清 Held（recover 视为 dialog dismissed 的正常出口）。
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
          // 保留 awaiting_human 整套字段：operator 仍需干预（Resume / cancel task / DELETE agent）。
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
        // Skip the menu-watch for cancel-cleanup holds: they await operator Resume/DELETE, and their taskId
        // won't clear on its own, so the watcher would poll forever.
        if (state.taskId && !shouldReleaseBinding && !cancelHold) {
          this.startRuntimeMenuWatch(state.id);
        }
      } catch (err) {
        if (err instanceof EnsureSessionError && err.partial.dialogPending) {
          // A mid-bootstrap dispatch (marker set, prompt never ack'd) that comes back blocked on a startup
          // dialog can't be Resumed for an active task — roll it back rather than hold it forever; the
          // re-dispatch handles the dialog fresh via ensureSession's trust-dialog path.
          if (await this.rollbackUndeliveredBootstrap(state, agentConfig)) continue;
          await this.markDialogPending(state.id, state.creationToken);
          // runtime path (creationToken=undefined) 时传 paneId/taskId snapshot 作 generation guard，
          // 否则 generationMismatch 看 expectedTaskId 默认 undefined 与 state.taskId 不匹配会立即退出。
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
        // A greeting capability hold must survive a transient/real tmux disappearance — wiping it
        // (it carries a paneId on the dialog path) would slip an unverified agent back into the
        // dispatch pool. Operator restart/retry re-greets; recover/Resume already preserve it.
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
    // Server-mode ready gate may have already published remote artifacts
    // (pushed branch / open PR). Capture before flipping to cancelled so the
    // post-lock cleanup can retire them instead of orphaning.
    // mayBeInFlight: approved+marker means the publish prompt may STILL be
    // running — retirement must wait for the dev interrupt or the in-flight
    // push/pr-create would recreate the artifacts right after cleanup.
    let publishedCleanup: { afterDone: 'pr' | 'branch'; branch: string; prNumber?: number; devAgentId: string; mayBeInFlight: boolean } | undefined;
    this.phaseSignalWatcher?.stop(taskId);
    const result = await this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task) throw new ApiError(404, 'Task not found');

      if (TERMINAL_STATUSES.includes(task.status)) return task;

      // A mark-complete merge is mid-flight (task is merge-ready, PR being merged) — refuse
      // to cancel so the merge can't land while the task is flipped to cancelled (which would
      // make pr.merged a no-op and skip cleanup). Checked under the lock to close the window.
      if (this.markCompleteInFlight.has(taskId)) {
        throw new ApiError(409, `Task ${taskId} is being completed (merge in progress); try again shortly`);
      }

      if (task.agentId) devToRelease = task.agentId;
      if (task.qaAgentId) qaToRelease = task.qaAgentId;
      // approved + publishDispatchedAt = the publish prompt reached the pane, so
      // remote artifacts may already exist even though code-ready never landed
      // (dispatch crash, or the reviewed-head mismatch gate refused ready —
      // whose documented exit is exactly this Cancel).
      // Truthy (not !== undefined): sanitizeTask passes hand-edited nulls through.
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
            // ready = code-ready consumed, publish finished; approved = no
            // completion signal yet, the publish may still be running.
            mayBeInFlight: task.status === 'approved',
          };
        }
      } else if (task.status === 'merge-ready' && task.prNumber !== undefined && task.branch && task.agentId) {
        // GitHub-mode gate cancel leaves the same orphaned PR/branch.
        publishedCleanup = {
          afterDone: 'pr',
          branch: task.branch,
          prNumber: task.prNumber,
          devAgentId: task.agentId,
          mayBeInFlight: false,
        };
      }

      // Mark the panes cancel-clearing BEFORE flipping the task terminal (still under the lock), so any
      // window — a concurrent escape, or a restart — sees a persisted hold instead of a plain binding to a
      // terminal task that recover()/the escape would release with the session still un-cleared.
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

      return task;
    });

    // 唯一允许打断 agent 会话的入口（用户主动 Cancel）。Interrupt BEFORE remote
    // retirement: an in-flight publish prompt would re-push the branch / re-open
    // the PR right after cleanup, and a cancelled task gets no second pass.
    // Only a successful interrupt PROVES the pane stopped — skipped paths
    // (config hot-removed: the pane outlives the config; state gone; rebound)
    // leave an in-flight publish possible.
    let devStopConfirmed = false;
    // Phase 1 — interrupt every still-bound pane first, so a slow /clear on one agent can't keep another
    // running the cancelled task. The persisted cancel-clearing hold (set under the lock) blocks any
    // concurrent escape from releasing these panes until they are /cleared.
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
      // devStopConfirmed reflects only "the pane stopped" — set before /clear so published-artifact
      // retirement still proceeds even when /clear can't be confirmed.
      if (id === publishedCleanup?.devAgentId) devStopConfirmed = true;
      stopped.push(id);
    }
    // Phase 2 — every pane is stopped; /clear + release each.
    for (const id of stopped) {
      const cfg = this.getAgentConfig(id);
      const state = await this.agentStore.get(id);
      if (!cfg || !state || state.taskId !== taskId) {
        console.warn(`[AgentManager] cancelTask: ${id} rebound before /clear (got ${state?.taskId}); skipping`);
        continue;
      }
      if (!(await this.clearPaneContext(state, cfg))) {
        // /clear unconfirmed → hold; the un-cleared pane stays bound (UNCLEARED_PANE_PHASES) until DELETE.
        await this.markAwaitingHuman(
          id,
          'cancel-clear-failed',
          'Task marked cancelled and the session interrupted, but /clear was not confirmed; the pane holds un-cleared context. DELETE the agent to discard it (Resume will not reuse an un-cleared pane).',
          { expectedTaskId: taskId },
        );
        continue;
      }
      try {
        // fromCancelCleanup: this IS the owning cancel, having confirmed /clear — the only release allowed
        // to free the cancel-clearing hold. allowAwaitingHuman: cross the awaiting_human gate too.
        await this.releaseAgentForTask(id, taskId, 'idle', { allowAwaitingHuman: true, fromCancelCleanup: true });
      } catch (err) {
        console.error(`[AgentManager] cancelTask releaseAgentForTask(${id}) failed:`, err);
      }
    }

    // Best-effort remote retirement for a cancelled published gate: close the PR
    // and delete the pushed branch so they don't outlive the task. Failures only
    // warn + intervene — cancel must not be blocked by remote faults.
    if (publishedCleanup) {
      if (publishedCleanup.mayBeInFlight && !devStopConfirmed) {
        // No proof the publish prompt stopped; cleaning now would race its
        // push/pr-create. Leave the artifacts to the operator.
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

  // create-time 不再校验 awaiting_human / creating / bound —— 这些都是"忙"，
  // 允许入队（落 pending）；可执行性判断下沉到 dispatchPendingTask（或 createTask 已空闲分支）。
  // 仍保留：agent 存在/同 project/role=dev（非空时）+ prompt size 上界。
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

  // Force a fresh QA review pass; bumps reviewRound only after startSession succeeds.
  async dispatchReviewToQa(taskId: string): Promise<TaskState> {
    const claim = await this.withTaskLock(async () => {
      if (this.manualReviewInFlight.has(taskId)) {
        throw new ApiError(409, `Manual review already in progress for task ${taskId}`);
      }
      // A mark-complete merge is mid-flight — refuse so Call review can't flip the
      // merge-ready task back to review while the PR is being merged.
      if (this.markCompleteInFlight.has(taskId)) {
        throw new ApiError(409, `Task ${taskId} is being completed (merge in progress); try again shortly`);
      }
      const task = await this.taskStore.get(taskId);
      if (!task) throw new ApiError(404, `Task ${taskId} not found`);
      // Server-mode tasks review via the exchange protocol; routing one into the
      // legacy GitHub review flow would cross-contaminate the state machines.
      if (task.reviewMode === 'server') {
        throw new ApiError(409, `Task ${taskId} uses server review mode; legacy Call review is not applicable`);
      }
      // spec-phase max_rounds escapes via Retry/Cancel only. Call review dispatches the
      // CODE-review protocol, but review.submitted early-returns for spec phase — so a direct
      // /tasks/:id/review here would transition the task to review + bind QA, yet its verdict
      // could never advance it or release the QA. Guard the server entry (UI already hides it),
      // matching the continue/complete spec guards.
      if (task.phase === 'spec' && task.status === 'max_rounds') {
        throw new ApiError(409, `Call review is not supported for spec-phase max_rounds tasks (use Retry or Cancel)`);
      }
      if (!task.prNumber) {
        throw new ApiError(400, `Task ${taskId} has no PR yet; cannot dispatch review`);
      }
      if (!task.branch) {
        throw new ApiError(400, `Task ${taskId} has no branch; cannot dispatch review`);
      }
      // Stale qaAgentId (deleted + recreated QA) → fall back to current partner.
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

      // dev 被 parked 到 waiting (mode='waiting' 仅 bump updatedAt 不发 C-c 不清 binding)；旧实现
      // approved/其他状态走两条不同分支，但 release(waiting) 和 markAgentWaiting 实际都走相同的
      // releaseAgentForTask(waiting) — 现在统一调 markAgentWaiting，devParked 仅作 QA 失败时
      // emit dev-parked intervention 的旗标。
      // .catch→false: 旧 approved 分支已有此模式，markAgentWaiting reject (store/lock IO 异常) 时
      // 不能直接跳出 try/finally — QA 已 acquire (binding+lock) 必须先 release 清理才能 throw。
      // Park dev only when it is still bound to THIS task. A paused max_rounds task
      // released its dev (spec phase) or kept it reserved (code phase); a released
      // dev has no running session to park, and markAgentWaiting would fail the
      // taskId-match check (manager.ts releaseAgentForTask) → spurious 500.
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

      // PHASE 0 — snapshot fields PHASE 1/2 may overwrite, so rollback can
      // restore them exactly (qaAgentId / signalToken / reviewHeadAnchorSha).
      const pre = await this.taskStore.get(taskId);
      const snapshot: DispatchReviewSnapshot = {
        qaAgentId: pre?.qaAgentId,
        signalToken: pre?.signalToken,
        reviewHeadAnchorSha: pre?.reviewHeadAnchorSha,
        reviewDispatchedAt: pre?.reviewDispatchedAt,
      };

      // PHASE 1 — persist status/qaAgentId/reviewHeadAnchorSha/reviewDispatchedAt
      // BEFORE setting up the fallback watcher (PHASE 2). A same-identity QA can echo
      // pr-approved between watcher.start() and these mutations; if they aren't
      // committed first, the verdict handler reads stale state (fromStatus mismatch,
      // head-unavailable, or release-QA orphans the binding). reviewDispatchedAt
      // also anchors the poller-verdict freshness gate.
      //
      // Terminal tasks (cancelled/failed/merged/max_rounds) skip status
      // transition + anchor — they remain terminal — but still bump reviewRound
      // to record the manual review attempt.
      const isTerminalAtClaim = TERMINAL_STATUSES.includes(taskStatusAtClaim);
      if (!isTerminalAtClaim) {
        const reviewAnchor = await this.fetchPrHeadSha(taskId).catch(() => undefined);
        const preDispatched = await this.transitionTaskStatus(
          taskId,
          'review',
          { fromStatus: [taskStatusAtClaim] },
          // Always overwrite reviewHeadAnchorSha (even with undefined when fetch
          // failed) so a stale anchor from a prior round can never survive into this
          // round's verdict handling. Rotate signalToken + advance reviewDispatchedAt in
          // the SAME mutation that exposes the new anchor/status — otherwise there is a
          // window where the anchor is already new but the token/dispatch time are still
          // the old pass's, and an old QA's late stamped verdict would pass the
          // freshness/token gate. PHASE 0's snapshot captured the prior token, so a
          // failed dispatch still rolls back correctly.
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
      // reviewRound bump + qaAgentId bind. The pass anchor/token/dispatch-time were
      // already advanced atomically in the transition above (non-terminal); terminal
      // tasks skip that transition and only record the review attempt here.
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

      // PHASE 2 — set up the fallback verdict watcher, then inject the prompt. The
      // poller is the authoritative verdict source; this watcher only fires in the
      // same-identity (422) case where `gh pr review` leaves no GitHub state to poll.
      // The verdict can fire any time after `start({...})` returns; PHASE 1 state is
      // already committed so the handler sees a consistent task.
      const { armed } = await this.rotateAndSetupPhaseSignal(
        taskId,
        qaId,
        ['pr-approved', 'pr-changes-requested'] as const,
      );
      if (!armed) {
        // Verdict watcher didn't arm — a same-identity review would have no verdict source.
        // Roll back PHASE 1 and fail loudly instead of injecting a prompt nothing will consume.
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
        // ack_unknown: prompt 已发，QA 可能在跑；保留 binding 让 operator 接管。
        // 不需要再 transition / bump — PHASE 1 已经做完。
        if (await this.markAwaitingIfAckUnknown(qaId, err, taskId)) {
          // no-op
        } else if (err instanceof EnsureSessionError && err.partial.handled) {
          // handleDialogPendingFromRuntime 已 Held QA + fail task + release partners；不能再 release
          // 否则 boundTask terminal 让 shouldReleaseHeldBinding 放行清掉仍卡 dialog 的 pane lock。
        } else {
          // Hard failure (not ack_unknown / dialog handled). Roll back PHASE 1
          // so the manual review attempt leaves no half-bumped state behind.
          await this.rollbackDispatchReviewPhase1(taskId, taskStatusAtClaim, isTerminalAtClaim, snapshot);
          await this.releaseAgentForTask(qaId, taskId, 'idle')
            .catch(() => undefined);
          if (devParked) await this.emitManualReviewDevParkedQaFailedIntervention(devAgentId, taskId);
        }
        throw err;
      }
      if (!started) {
        // startSession resolved false (no exception). Same rollback as the
        // hard-failure catch branch above.
        await this.rollbackDispatchReviewPhase1(taskId, taskStatusAtClaim, isTerminalAtClaim, snapshot);
        await this.releaseAgentForTask(qaId, taskId, 'idle')
          .catch(() => undefined);
        if (devParked) await this.emitManualReviewDevParkedQaFailedIntervention(devAgentId, taskId);
        throw new ApiError(500, `Failed to start QA review session for ${taskId}`);
      }

      // PHASE 1 already wrote the anchor + status + qaAgentId + reviewRound
      // bump under withTaskLock; no further mutations needed here.
      const final = await this.taskStore.get(taskId);
      return final!;
    } finally {
      this.manualReviewInFlight.delete(taskId);
    }
  }

  // Manually push a code-phase max_rounds task through one more dev fix round.
  // Reuses the fixing dispatch chain (fixing → pr-fixed watcher → continueSession),
  // bypassing the review cap for this one round; the round still increments and the
  // task re-pauses at max_rounds if QA requests changes again. The dev is the
  // reserved one from the pause (§2.1), so its worktree is reused as-is.
  async continueDevRound(taskId: string): Promise<TaskState> {
    // A mark-complete merge may be mid-flight after claiming the task but before the
    // max_rounds → merge-ready transition lands; refuse so the two can't both act on the
    // same max_rounds snapshot (the merge-ready status guard covers the post-transition window).
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
    // Server-mode continue: grant one round past the cap, then re-run the server
    // fix protocol from the stored findings — no PR exists at this point.
    if (task.reviewMode === 'server') {
      if (!task.agentId) {
        throw new ApiError(400, `Task ${taskId} has no dev agent; cannot continue`);
      }
      const stored = await this.reviewStore?.getRound(taskId, 'code', Math.max(task.reviewRound, 1));
      if (!stored?.findings) {
        throw new ApiError(409, `Task ${taskId} has no stored findings to continue from; cancel instead`);
      }
      // Re-check + grant under the task lock: the entry checks above ran lock-free,
      // so a concurrent mark-complete may have claimed the gate since (the
      // claimCompleteGate comment promises Continue re-checks under the same lock).
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
        // The grant is only spent when the fix prompt actually reached the dev.
        // Decrement (not restore-snapshot): a snapshot write-back would also
        // erase a concurrent Continue's grant.
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
    // Retained-dev precondition: the paused dev must still hold this task and its
    // worktree. If broken (cancelled, reassigned, external interference), continueSession
    // would have no checkout to reuse — steer the user to Retry instead of recreating it.
    const devAgentId = task.agentId;
    const devState = await this.agentStore.get(devAgentId);
    if (devState?.taskId !== taskId || !devState.worktreePath) {
      // code-phase max_rounds has no Retry (Continue/Complete/Cancel only), so don't
      // point at Retry: the work is on the PR — merge it (mark-complete) or abandon (cancel).
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

    // rollback returns the task to max_rounds AND re-parks the dev to waiting, keeping
    // the reserved-dev invariant (bound + 'waiting' + worktree) so a later continue/cancel
    // sees a consistent state and the snapshot shows 'waiting', not a stale 'working'.
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

  // Undo PHASE 1+2 of dispatchReviewToQa when startSession ultimately fails
  // (resolved false, or threw a hard error other than ack_unknown / dialog).
  // Restores task fields to the pre-dispatch snapshot and re-establishes the pane-signal
  // watcher matching the RESTORED state (develop spec/pr-created, spec verdict,
  // approved→pr-merge-ready, or the review fallback verdict watcher) so a later
  // emit using the prior token is still consumed.
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

    // Special case: approved task with a pending PostApproveCompletion. PHASE 2
    // stopped its pr-merge-ready watcher; restore it so dev's later
    // pr-merge-ready emit gets consumed.
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

    // General case: rolled-back task may still want a watcher matching its
    // current (restored) state — develop dispatch still waiting on
    // spec-done/pr-created, recheck still waiting on verdict, etc.
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

  // Single source of truth for "what watcher should this task have, given its
  // current state". Used by both setupRecoveredSpecSignals (restart recovery)
  // and rollbackDispatchReviewPhase1 (manual dispatch failure).
  // Dev's first prompt offers the spec-first or straight-to-code path; the arm
  // must accept both completion signals for the task's protocol family.
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
      // Code-track fixing: dev emits pr-fixed when the round is done.
      return { expectedKinds: ['pr-fixed'], agentId: task.agentId };
    }
    if (task.phase === undefined && task.status === 'in_progress' && task.agentId) {
      return { expectedKinds: ['spec-done', 'pr-created'], agentId: task.agentId };
    }
    if (task.phase === 'code' && task.status === 'in_progress' && task.agentId) {
      return { expectedKinds: ['pr-created'], agentId: task.agentId };
    }
    if (task.phase !== 'spec' && task.status === 'review' && task.qaAgentId) {
      // Fallback verdict watcher for the same-identity (422) case; the poller is
      // the primary, authoritative verdict source for distinct identities.
      return { expectedKinds: ['pr-approved', 'pr-changes-requested'], agentId: task.qaAgentId };
    }
    return undefined;
  }

  // Recovery mapping for server-mode tasks: the watcher is the ONLY verdict
  // channel (no poller backstop), so every awaiting state must re-arm on restart.
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

  // Public re-establish helper for in-band recoveries that don't rotate the token
  // (e.g. handler reject path: agent's next emit must still match current
  // task.signalToken, so rotating would strand it). Returns whether a watcher
  // armed; callers that consumed a signal must hold on false or it has no consumer.
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
      // max_rounds is non-terminal but still retryable for spec-phase tasks (their
      // only escape this iteration). code-phase max_rounds uses continue/complete/cancel.
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
    // Retry preserves uploaded images: read the old task's staged bytes up-front
    // (missing → visible 409 before any new task/binding is created).
    if (old.images?.length) {
      input.images = await this.readStagedImages(old.id, old.images);
    }
    await this.validateTaskDispatch(old.projectId, input);
    // Non-terminal retry (spec-phase max_rounds) must finalize the old paused task so it
    // leaves the active list instead of lingering beside the fresh run. Terminal tasks
    // already are their own history record and are left untouched.
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

  // Manually finish a max_rounds task: merge its PR, then reuse the normal merged
  // cleanup chain (pr.merged handler → transition merged + post-merge worktree/branch
  // cleanup + /clear + release). Same path the poller drives when it detects the merge.
  async markTaskComplete(taskId: string): Promise<TaskState> {
    const peek = await this.taskStore.get(taskId);
    if (!peek) throw new ApiError(404, `Task ${taskId} not found`);
    // Human gate (spec §10): ready / merge-ready confirm runs its own completion
    // matrix (with its own lock-claimed gate); the legacy max_rounds path below
    // is untouched.
    if (peek.status === 'ready' || peek.status === 'merge-ready') {
      return this.confirmHumanGate(taskId);
    }

    // Claim under the task lock — the whole merge window. markCompleteInFlight
    // blocks Cancel / Call review / Continue (all re-check it under the same
    // lock) so they can't act on the same snapshot and interleave with the
    // irreversible `gh pr merge` (or, server mode, the publish dispatch).
    const task = await this.claimCompleteGate(taskId, ['max_rounds', 'approved']);
    try {
      // Server-mode publish retry: a failed afterDone dispatch leaves the task
      // 'approved' with dev released — mark-complete re-runs the publish.
      const serverApprovedRetry = task.status === 'approved' && task.reviewMode === 'server';
      if (!serverApprovedRetry && task.status !== 'max_rounds') {
        throw new ApiError(409, `Task ${taskId} is not at max_rounds (status=${task.status})`);
      }
      // spec-phase max_rounds escapes via Retry/Cancel only (the UI hides complete). Guard the
      // endpoint too so a direct API call / older client can't merge a spec cap through here.
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
        // task.afterDone was snapshotted when the approve verdict routed it.
        const afterDone = this.resolveAfterDone(task);
        if (afterDone === null) {
          throw new ApiError(409, `Task ${taskId} is approved with no afterDone step; nothing to retry`);
        }
        await this.dispatchServerAfterDone(taskId, afterDone);
        return (await this.taskStore.get(taskId))!;
      }
      // Server-mode capped task, human accepts as-is: no PR exists yet — run the
      // afterDone flow (or finish directly) instead of the legacy PR merge.
      // Inside the in-flight claim so a concurrent Continue can't act on the same
      // max_rounds snapshot and release dev mid-publish.
      if (task.reviewMode === 'server') {
        // Max_rounds never routed an approve verdict — snapshot afterDone NOW so
        // the eventual ready-confirm uses this decision, not future hot config.
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
      // Held-agent check AFTER claiming (the claim blocks a new continueDevRound from starting),
      // and re-reading agent state here catches a continue that Held an agent in the window just
      // before our claim. dispatchPostMergeCleanup early-returns on awaiting_human, so merging with
      // a held dev/QA still bound to this task would orphan the merged task on a locked agent.
      // Bound to *this* task only — a stale id whose agent moved on is harmless (cleanup early-returns).
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

      // Atomically transition max_rounds → merge-ready under the task lock. merge-ready is
      // active + already in pr.merged's fromStatus, so the post-merge cleanup chain runs;
      // combined with the in-flight claim it fully serializes against the other actions.
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
    // Keep the agent BOUND (non-dispatchable) until branch cleanup + context reset finish, then
    // release. dispatchPostMergeCleanup owns the whole lifecycle: worktree removal → branch
    // delete → /clear (or /compact if cleanup failed) → release.
    if (task.prNumber && task.branch) {
      const ctx: PostMergeCleanupContext = {
        prNumber: task.prNumber,
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
      // No PR/branch to clean up and nothing to compact — release immediately so the agent frees.
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
    const cleanupResult: PostMergeBranchCleanupResult = state.repoPath
      ? await this.deleteLocalBranchInRepo(runner, state.repoPath, ctx.branch, agentId)
      : { outcome: 'skipped', detail: 'agent has no repoPath in binding' };

    const tmux = new TmuxManager(runner);
    const prompt = buildPostMergeCleanupPrompt(ctx, cleanupResult);
    const runtime = agentRuntimeKindFor(agent);
    const cleanSlate = cleanupResult.outcome === 'deleted' || cleanupResult.outcome === 'absent';
    void this.runPostMergeCompaction(tmux, state.paneId, agentId, ctx.taskId, runtime, prompt, cleanSlate).catch(err =>
      console.warn(`[AgentManager] runPostMergeCompaction(${agentId}) failed:`, err),
    );
  }

  // Release the post-merge binding (clears taskId + frees the lock we held → agent dispatchable
  // again). Shared success tail. Skips when the binding has already moved to another task, so it
  // never releases a lock owned by a different flow.
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

  // Removes the merged worktree but KEEPS taskId on the binding, so the agent remains
  // non-dispatchable while branch delete + /clear run. Only worktreePath is dropped.
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

  // shellQuote prevents injection. Three outcomes the caller must distinguish so the
  // notification prompt to the agent doesn't lie about a deletion that actually failed:
  //   - deleted: branch ref was removed (or no longer exists at the end of the call).
  //   - absent:  branch wasn't there at all (auto-delete-head-branches, never landed locally).
  //   - failed:  worktree still occupies the ref, permissions, etc. — agent must NOT be told "cleaned".
  private async deleteLocalBranchInRepo(
    runner: CommandRunner,
    repoPath: string,
    branch: string,
    agentId: string,
  ): Promise<PostMergeBranchCleanupResult> {
    // --expire=now: bare `git worktree prune` honors gc.worktreePruneExpire (default 3 months),
    // so a worktree that the release just removed could still be tracked as occupying the ref.
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
      if (delResult.exitCode === 0) {
        return { outcome: 'deleted', detail: delResult.stdout.trim() };
      }
      if (/not found|not a valid|no such branch/i.test(delResult.stderr)) {
        return { outcome: 'absent', detail: delResult.stderr.trim() };
      }
      console.warn(
        `[AgentManager] deleteLocalBranchInRepo(${agentId}, ${branch}): branch -D exit=${delResult.exitCode} ` +
        `stderr=${delResult.stderr.trim()}`,
      );
      return { outcome: 'failed', detail: delResult.stderr.trim() || `exit ${delResult.exitCode}` };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[AgentManager] deleteLocalBranchInRepo(${agentId}, ${branch}) branch -D threw:`, err);
      return { outcome: 'failed', detail };
    }
  }

  private async runPostMergeCompaction(
    tmux: TmuxManager,
    paneId: string,
    agentId: string,
    originalTaskId: string,
    runtime: AgentRuntimeKind,
    prompt: string,
    cleanSlate: boolean,
  ): Promise<void> {
    // 等待获取（而非无条件 add）：手动 compact 持锁时直接进入会并发注入，
    // 且 finally 会误删对方的 guard 放穿后续请求。
    await this.acquireCompactGuard(agentId);
    try {
      await this.runPostMergeCompactionSteps(tmux, paneId, agentId, originalTaskId, runtime, prompt, cleanSlate);
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
    prompt: string,
    cleanSlate: boolean,
  ): Promise<void> {
    const bindingStillOurs = async (): Promise<boolean> => {
      const s = await this.agentStore.get(agentId);
      return !!s && s.taskId === originalTaskId && s.paneId === paneId;
    };

    let attempts = 0;
    let cleared = false;
    while (attempts < 2) {
      attempts++;
      try {
        if (attempts > 1) {
          if (!await bindingStillOurs()) return;
          await tmux.sendKeysToPane(paneId, 'C-c');
          await new Promise(r => setTimeout(r, 1000));
        }
        await this.waitForReplPromptReady(tmux, paneId, runtime, this.compactIdleWaitMs);
        if (!await bindingStillOurs()) return;
        await tmux.injectPrompt(paneId, prompt, agentId);
        // Resend a swallowed first Enter (bracketed-paste TUI quirk); settle so baseline holds the paste.
        const baseline = await tmux.captureSettledSnapshot(paneId, { timeoutMs: this.dispatchSettleTimeoutMs });
        await tmux.sendEnter(paneId);
        try {
          await tmux.waitSubmitAck(paneId, baseline, runtime, {
            timeoutMs: this.dispatchAckTimeoutMs,
            resend: () => tmux.sendEnter(paneId),
            resendIntervalMs: this.dispatchAckResendIntervalMs,
          });
        } catch (ackErr) {
          // Only a genuine ack timeout is best-effort; other (infra) errors must reach the outer retry.
          if (!(ackErr instanceof Error && /runtime ack timeout/.test(ackErr.message))) throw ackErr;
          console.warn(`[AgentManager] post-merge notification ack timeout (${agentId}, pane ${paneId}):`, ackErr);
        }
        await this.waitForReplPromptReady(tmux, paneId, runtime, this.compactIdleWaitMs);
        if (!await bindingStillOurs()) return;
        const command = cleanSlate ? '/clear' : '/compact';
        if (!await this.sendPostMergeSlashCommand(tmux, paneId, agentId, runtime, command, bindingStillOurs)) {
          return;
        }
        cleared = true;
        break;
      } catch (err) {
        const label = attempts < 2 ? 'retrying' : 'giving up';
        console.warn(
          `[AgentManager] runPostMergeCompaction(${agentId}) attempt ${attempts} failed (${label}):`,
          err,
        );
      }
    }
    if (!cleared && await this.recoverPostMergeExitedRuntime(tmux, paneId, agentId, originalTaskId, runtime)) {
      await this.releasePostMergeAgent(agentId, originalTaskId);
      return;
    }
    // Give-up: clear the injected-but-unsubmitted notification; hold (don't release) if it can't be cleared.
    if (!cleared && !await this.clearComposerForReuse(tmux, paneId, agentId)) return;
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
        if (
          existing.paneId === ensure.paneId
          && existing.repoPath === ensure.workdir
          && existing.injectedSkills === undefined
        ) {
          return AGENT_STORE_NOOP;
        }
        return {
          ...existing,
          paneId: ensure.paneId,
          repoPath: ensure.workdir,
          injectedSkills: undefined,
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
    command: '/compact' | '/clear',
    bindingStillOurs: () => Promise<boolean>,
  ): Promise<boolean> {
    let rejection: Error | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      // The runtime rejects /clear|/compact while a turn is in progress, and the post-merge
      // notification turn can still be running when our idle scrape passes. Esc interrupts it (the
      // same stop the cancel flow runs before /clear); a genuinely idle pane absorbs it harmlessly.
      await tmux.sendKeysToPane(paneId, 'Escape');
      await this.waitForReplPromptReady(tmux, paneId, runtime, this.compactIdleWaitMs);
      if (!await bindingStillOurs()) return false;
      await tmux.sendKeysLiteral(paneId, command);
      await tmux.sendEnter(paneId);
      await new Promise(r => setTimeout(r, this.compactIdlePollMs));
      await this.waitForReplPromptReady(tmux, paneId, runtime, this.compactIdleWaitMs);
      if (!await bindingStillOurs()) return false;

      if (!await this.hasRuntimeSlashCommandRejection(tmux, paneId, command)) return true;

      rejection = new Error(`runtime rejected ${command} because a task is still in progress`);
      if (attempt < 2) {
        console.warn(`[AgentManager] runPostMergeCompaction(${agentId}) ${command} rejected; retrying`);
        await new Promise(r => setTimeout(r, this.compactIdlePollMs));
        if (!await bindingStillOurs()) return false;
      }
    }
    throw rejection ?? new Error(`runtime rejected ${command}`);
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

  // pane_current_command 是 runtime 是否仍活的权威信号（不被 viewport stale frame 骗）。
  // anchor 在 codex busy 屏（`Working on it…\n  esc to interrupt`）不存在，所以 busy 状态只看
  // procTitle；只有准备返回 idle 时才用 anchor 作双重证据，挡 stale-frame + shell 误报。
  // 入口先等一拍：上一步刚 sendEnter，给 runtime 时间进入 busy，避免观察到假 idle。
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

  // Returns 'live' when a code-ready watcher is armed and a publish prompt is in flight,
  // 'delivered' when no watcher is running but publishDispatchedAt indicates delivery,
  // or false when the approved state is retryable (stops any stale recovered watcher).
  private checkPublishInFlight(taskId: string, publishDispatchedAt: string | undefined): 'live' | 'delivered' | false {
    if (this.phaseSignalWatcher?.expectedKindsFor(taskId).has('code-ready')) {
      if (!this.phaseSignalWatcher.isRecovered(taskId) || publishDispatchedAt) return 'live';
      this.phaseSignalWatcher.stop(taskId);
      return false;
    }
    return publishDispatchedAt ? 'delivered' : false;
  }

  // Prompt build (via task.signalToken) and watcher must share the same token.
  // Returns whether dispatch may safely proceed. False ONLY when a configured watcher failed
  // to arm — the dangerous case where a same-identity verdict would have no consumer. When no
  // watcher subsystem is configured at all (poller-only deployment) the poller is the verdict
  // path, so this returns true and does not block. Best-effort callers ignore the result.
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

  // Arm a watcher for a signal the just-dispatched prompt will emit, then hold the agent if it
  // could not arm. Used by post-dispatch arms (develop/spec/code phases) whose pane only exists
  // after dispatch, so they can't gate before sending the prompt the way verdict dispatch does.
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

  // The prompt expecting a pane signal is already out but its watcher failed to arm — the signal
  // would have no consumer. Hold the agent so the stuck state is explicit instead of silently
  // waiting forever (#218 item 4). resumeAgent refuses Resume for this phase under an active task
  // (Resume can't rebuild the watcher), so the operator cancels the task / deletes the agent to retry.
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

  // Public helper for phases whose dispatch lives outside this class
  // (handlers.ts pr.created/pr.updated → review/recheck). Rotates the task's
  // signalToken atomically and sets up the watcher; returns the new token so the
  // caller can wire-up only when this resolves.
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

  // Atomically undo a verdict dispatch (pr.created / pr.updated handlers) when the verdict watcher
  // failed to arm and the QA prompt was never sent: restore the pre-transition status/token/anchor,
  // drop the QA binding, and re-establish the watcher matching the restored state so an
  // already-emitted prior-phase signal (e.g. the dev's pr-created) is re-consumed via the snapshot
  // scan. Without restoring the rotated token, the dev's prior prompt signal would fail the token
  // gate and the task would stall. Mirrors rollbackDispatchReviewPhase1 for the automated handlers.
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
    // Rotate token for the code phase so dev's pr-created signal is fresh; old
    // spec token must not survive into a different expected-kind set.
    const newToken = createSignalToken();
    // Atomic transition + persist: 旧版先 transition 再 updateTask, 中间崩溃 task 卡在
    // (phase='spec', status='in_progress') — setupRecoveredSpecSignals 三个 case 都不匹配,
    // freshness gate 也拒所有 spec.* event, 任务 stranded 无 auto-recovery。
    const transition = await this.transitionTaskStatus(
      taskId,
      'in_progress',
      { fromStatus: ['review', 'fixing', 'in_progress'] },
      { phase: 'code', signalToken: newToken },
    );
    if (!transition) return null;
    this.stopPhaseSignalWatcher(taskId);
    // Best-effort arm (NOT hold-on-failure): this runs before the code prompt is dispatched
    // (acquire + continueSession below), so holding here would block that reentry. And pr-created
    // is authoritatively detected by the GitHub poller (PR creation isn't same-identity-gated), so
    // a missed pane watcher only costs one poll cycle of latency, never a stuck task.
    // Server mode has NO poller backstop: an unarmed code-done watcher means the
    // dev's completion signal would have no consumer — fail closed and hold.
    const codeKind: PhaseSignalKind = task.reviewMode === 'server' ? 'code-done' : 'pr-created';
    const codeArmed = await this.setupPhaseSignalWatcher(taskId, devAgentId, codeKind, newToken);
    if (!codeArmed && task.reviewMode === 'server') {
      await this.holdAgentForUnarmedSignal(taskId, devAgentId, codeKind);
      return null;
    }

    if (task.qaAgentId) {
      // release 失败留 stale qa binding → emit intervention 让其可见。
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
      // Task already shows phase='code' in_progress with the code-done watcher
      // armed, and server mode has no poller backstop — without a hold the dev
      // never receives the code prompt and the task dead-ends. The
      // code-dispatch-failed hold gives Resume a redispatch path.
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
      // 同 dispatchServerReviewToQa/dispatchServerFixToDev：DispatchTerminalError 委托给 failTaskForDispatchError
      // （ack_unknown → markAwaitingHuman；其他 reason → release + task failed）。
      if (err instanceof DispatchTerminalError) {
        await this.failTaskForDispatchError(taskId, 'code', devAgentId, err);
      } else if (!(err instanceof EnsureSessionError && err.partial.handled)) {
        // Task already shows phase='code' in_progress but the prompt never landed
        // and there is no retry entry — hold explicitly instead of dead-ending.
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

  // ── Server review mode (spec: docs/spec/server-review-mode.md) ──────────────

  async dispatchServerReviewToQa(
    taskId: string,
    opts: {
      phase: TaskPhase;
      recheck?: boolean;
      /** Batch continuation: same QA, same round, next slice — skip acquire/park/transition. */
      continuation?: boolean;
      content: string;
      diffstat?: string;
      contentTruncated?: boolean;
      batch?: { index: number; total: number };
      priorFindingsJson?: string;
      priorResponseJson?: string;
      /** Dev HEAD the reviewed diff was read at — publish refuses any other head. */
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
      // spec 阶段恒为 server 中转；code 阶段仍 server-only。
      if (task.reviewMode !== 'server' && opts.phase !== 'spec') {
        throw new Error(`dispatchServerReviewToQa: task ${taskId} is not in server review mode`);
      }
      const qaId = task.qaAgentId ?? this.findQaPartner(task.agentId)?.id;
      if (!qaId) {
        // Config validation rejects qa-less server pairs, but a hot-removed QA
        // can still land here — re-arm the consumed entry signal so the task
        // is recoverable once a QA is configured again.
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

    // continueSession failure after the transition would otherwise strand the
    // task in 'review' with a fresh token nobody will ever signal.
    const rollback = async () => {
      await this.transitionTaskStatus(
        taskId,
        claim.originalStatus,
        { fromStatus: ['review'] },
        {
          signalToken: claim.originalToken,
          batchIndex: claim.originalBatchIndex,
          batchTotal: claim.originalBatchTotal,
          // spec transition 写入 phase:'spec'；github 首轮失败若不还原，dev 直发
          // pr-created 会被 legacy freshness gate 拒（设计 §2）。
          phase: claim.originalPhase,
          ...(opts.phase === 'spec'
            ? { specReviewRound: claim.originalRound }
            : { reviewRound: claim.originalRound }),
        },
      ).catch(() => undefined);
    };

    // The entry signal (code/spec-done|fixed) was already consumed by the
    // watcher; a pre-transition failure must re-arm it with the unrotated token
    // or the agent's re-emit after the operator fixes availability has no
    // consumer.
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

    // First dispatch creates the QA's base-detached worktree (startSession);
    // batch continuations reuse the live session + worktree (continueSession).
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
      // Arm the verdict + read-file watcher in the pane-exists / pre-paste window so a QA
      // [bx:read-file:...] emitted during the dispatch is a live chunk, not snapshot-suppressed.
      armBeforeInject: () => this.setupPhaseSignalWatcher(
        taskId, qaId, expectedKind, newToken, false,
        (req) => { void this.handleReadFileRequest(taskId, qaId, req); },
      ),
    };
    // A continuation consumed the QA's reviewed signal (not the dev's entry
    // signal): rollback restores the prior slice's review/token, so re-arm the
    // reviewed watcher — the QA's re-emit replays the stored batch findings and
    // resumes the next-slice dispatch.
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
      // armBeforeInject may have armed the watcher before the failing paste — drop it so a stale
      // entry can't fire on a rolled-back / failed task (no-op if it never armed).
      this.stopPhaseSignalWatcher(taskId);
      if (err instanceof DispatchTerminalError) {
        await this.failTaskForDispatchError(taskId, dispatchPhase, qaId, err);
      } else if (err instanceof EnsureSessionError && err.partial.handled) {
        // handleDialogPendingFromRuntime already held + failed + released.
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
      // Covers armBeforeInject returning false (watcher couldn't arm) as well as any other
      // pre-paste abort; stop is a no-op when nothing armed.
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
        // Continue-one-round enters from max_rounds — failure must restore THAT,
        // not silently demote the human's pause decision to 'review'.
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
    // The QA's reviewed signal was consumed before this dispatch; pre-transition
    // failures must re-arm it (unrotated token) so a later re-emit is consumed.
    const rearmReviewedSignal = async () => {
      if (!qaAgentId) return;
      const reviewedKind: PhaseSignalKind = taskPhase === 'spec' ? 'spec-reviewed' : 'code-reviewed';
      await this.setupPhaseSignal(taskId, qaAgentId, reviewedKind, { skipSnapshot: true });
    };

    // Dev BEFORE QA: releasing the QA first is irreversible (binding cleared,
    // worktree removed, schedulable elsewhere) — a dev acquire failure after it
    // would leave the review-parked task with no stably-bound agent to retry
    // from. With the dev secured first, both failure exits keep the QA bound.
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

    // max_rounds entry = human "continue one round" via continueDevRound.
    const transition = await this.transitionTaskStatus(
      taskId,
      'fixing',
      { fromStatus: ['review', 'max_rounds'] },
      { signalToken: newToken, fixDispatchedAt: new Date().toISOString() },
    );
    if (!transition) {
      // Refusal = the task left review/max_rounds concurrently (cancel / fail /
      // mark-complete publish). Ownership moved with it — releasing dev here
      // would strip a binding the winning chain may be actively using (e.g. a
      // publish prompt running in the pane); its own cleanup releases the dev.
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
        // handled upstream
      } else {
        await rollbackToEntry();
        await this.releaseAgentForTask(devAgentId, taskId, 'idle').catch(() => undefined);
        // Rollback restored review/old-token, but the QA's reviewed signal was
        // consumed — without a subscriber its re-emit can never retry the fix
        // dispatch.
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
    // The publish prompt never reached the pane — restore the pre-rotation token
    // (so recovery still matches the pre-dispatch arm) and clear the delivery
    // marker so retry knows this approved state is preemptible.
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

    // Pessimistic delivery marker BEFORE the irreversible paste: every failure
    // path below clears it. The remaining crash window (marker written, paste
    // never ran) fails CLOSED — retry 409s on a publish that never started and
    // the operator escapes via Cancel — instead of the old window's fail-open
    // double publish (paste ran, marker missing, retry re-pastes).
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
        // Keep dev BOUND — its worktree holds the reviewed (unpushed) commits.
        // mark-complete retries the publish via server-after-done same-task reentry.
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

  // QA asked for file context during a server-mode review. Read from the DEV
  // worktree (the QA worktree sits on the base branch) and paste into QA's pane.
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
    // The read ran async — QA may have submitted its verdict and been released
    // or rebound meanwhile. Never paste old-task content into a new task's pane.
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

  // Plain text paste + submit into a live agent pane (no skills, no ack protocol).
  async injectTextToAgent(
    agentId: string,
    text: string,
    opts: { expectedTaskId?: string } = {},
  ): Promise<void> {
    const cfg = this.getAgentConfig(agentId);
    if (!cfg) throw new Error(`injectTextToAgent: unknown agent ${agentId}`);
    await this.acquireCompactGuard(agentId);
    try {
      // 锁内重读：guard 等待期间绑定可能已易主，过期文本决不落 pane。
      const state = await this.agentStore.get(agentId);
      if (opts.expectedTaskId !== undefined && state?.taskId !== opts.expectedTaskId) {
        throw new Error(
          `injectTextToAgent: agent ${agentId} no longer bound to ${opts.expectedTaskId}`,
        );
      }
      // Same cancel race as the prompt dispatch: cancel persists the agent hold (keeps taskId) before the
      // task flips terminal, and this responder can win the mutex in cancel's interrupt→/clear gap. Refuse to
      // inject into a pane cancel is tearing down — by the hold AND by terminal task status.
      if (isCancelCleanupHold(state)) {
        throw new Error(`injectTextToAgent: agent ${agentId} taken over by cancel (${state?.awaitingPhase}); refusing injection`);
      }
      const boundTask = state?.taskId ? await this.taskStore.get(state.taskId) : null;
      if (boundTask && TERMINAL_STATUSES.includes(boundTask.status)) {
        throw new Error(`injectTextToAgent: task ${state?.taskId} for agent ${agentId} is terminal; refusing injection`);
      }
      const paneId = state?.paneId;
      if (!paneId) throw new Error(`injectTextToAgent: agent ${agentId} has no live pane`);
      // taskStore.get yielded the loop — re-read right before the paste so a cancel hold that landed during
      // that await can't slip text into a pane cancel has taken over.
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

  // Human gate confirm (spec §10): executes the configured completion for
  // ready (server mode) / merge-ready (github mode) tasks.
  async confirmHumanGate(taskId: string): Promise<TaskState> {
    // Claim under the task lock: a Cancel racing this read can no longer flip the
    // task to cancelled (and retire its artifacts) while we proceed on a stale
    // gate snapshot — cancelTask checks the in-flight flag inside the same lock.
    const task = await this.claimCompleteGate(taskId, ['ready', 'merge-ready']);
    try {
      const project = this.getProjectConfig(task.projectId);
      const mergeAuto = project?.merge === 'auto';
      // Snapshot from verdict time — a hot config flip between publish and
      // confirm must not reroute an already-published artifact.
      const afterDone = this.resolveAfterDone(task);

      if (task.status === 'merge-ready') {
        if (mergeAuto && task.prNumber) {
          // Guard on the post-approve head persisted at the merge-ready transition.
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

      // status === 'ready' (server mode)
      if (afterDone === 'pr' && mergeAuto && task.prNumber) {
        // Reviewed-head guard is mandatory here — publish fail-closes on capture,
        // so a missing sha means tampered/legacy state, not a soft fallback.
        if (!task.latestHeadSha) {
          throw new ApiError(409, `Task ${taskId} has no reviewed head recorded; cannot safely merge`);
        }
        await this.executeConfirmMerge(task, () => this.mergePr(taskId, {
          matchHeadSha: task.latestHeadSha,
        }));
        // pr.merged's fromStatus now includes 'ready' — let the handler own the
        // merged transition + full cleanup chain (branch delete, /clear, release).
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

  // Atomic gate claim: re-read + status check + markCompleteInFlight.add under
  // the task lock, so confirm and cancel serialize on the same snapshot.
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

  // Merge failures keep the gate: transient gh/network errors retry via another
  // Confirm, a stale head resolves via Cancel or an external decision — terminal
  // 'failed' would orphan the published PR/branch outside the task flow.
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

  // Terminal-state resource release shared by done/merged(branch)/failed confirm
  // paths: stop the watcher, release dev+qa (worktree removal rides releaseAgentForTask).
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

  // afterDone:'branch' + merge:'auto' — fast-forward the remote default branch
  // to the reviewed branch ref-to-ref (`git push origin origin/bx/X:main`).
  // Never touches the repo working tree, and a plain push is ff-only by default:
  // a non-ff base is rejected by the remote and a human must rebase/decide (spec §6).
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
        // A silent 'main' fallback would push the reviewed branch onto the wrong
        // ref for repos whose default branch differs.
        throw new Error(`ffMergeBranch: cannot resolve default branch: ${db.stderr.trim() || 'empty origin/HEAD'}`);
      }
      const fetch = await runner.exec(`${cd}git fetch origin`);
      if (fetch.exitCode !== 0) {
        throw new Error(`ffMergeBranch [git fetch] failed: ${fetch.stderr.trim()}`);
      }
      // Reviewed-head guard (branch path): refuse if origin/<branch> moved after
      // the gate — symmetric with the pr path's --match-head-commit.
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
      // The merge has landed; branch deletion is cleanup — a transient failure
      // here must not flip an already-merged task to failed.
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
