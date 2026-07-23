import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { createSignalToken, PASSIVE_VERDICT_WATCH, type ReadFileSignal } from './phase-signal.js';
import { tmuxInstallHint, type AgentGitPreflight } from './preflight.js';
import type {
  AfterDone,
  BaxianConfig,
  AgentConfig,
  AgentBindingFacts,
  BaxianEvent,
  HostConfig,
  ProjectConfig,
  ReviewFindings,
  ReviewMode,
  ReviewDispatchLease,
  ReviewPhase,
  ReviewRound,
  RemoteCleanupState,
  ServerResponseFailure,
  ServerSignalKind,
  ServerSignalRecovery,
  ServerSignalRecoveryReason,
  SpecDocument,
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
  TASK_OWNER_ROLES,
  isSpecStagePhase,
  isGitHubRepo,
  parseGitRemote,
  repoIdentityKey,
  repoSlug,
} from '../shared/index.js';
import { buildProjectDriver, makeDriverExec } from '../platform/driver-host.js';
import { DriverOpError, buildDriverRunContext, GitDriver, safeDriverErrorText } from '../platform/git-driver.js';
import type { DriverExec } from '../platform/git-driver.js';
import type { PluginRegistry } from '../platform/plugin-registry.js';
import type { NormalizedRow } from '../platform/row-schema.js';
import { checkOpenPrBinding, checkPrBinding, type PrRejection } from '../platform/pr-binding.js';
import { collectPendingFeedback, scanCommentSourcesOnce, type PendingFeedbackResult } from '../platform/feedback.js';
import { recheckPassProvenance, type VerdictSourceScan } from '../platform/verdict-engine.js';
import {
  platformBindingMismatch,
  taskNeedsPlatformBindingAudit,
  type PlatformBindingMismatch,
} from '../platform/startup.js';
import type { AgentStore } from '../state/agent-store.js';
import { AGENT_STORE_NOOP } from '../state/agent-store.js';
import type { TaskStore } from '../state/task-store.js';
import type { LockManager } from '../state/lock.js';
import type { EventBus } from '../event/bus.js';
import type { ErrorRecordStore, ErrorRecordInput } from '../state/error-record-store.js';
import { SkillRegistry, type SkillScope } from '../skill/registry.js';
import type { CommandRunner } from './runner.js';
import {
  createRunner,
  LocalRunner,
  shellQuote,
  resolveAgentHost,
  hostGroupKey,
  workdirHostGroupKey,
} from './runner.js';
import { GIT_NET_ENV, execNetwork, isTransientNetworkFailure } from './net-exec.js';
import { findForeignTaskTip, type LineageViolation } from './lineage.js';
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
  hasOscTitleIdle,
  screenAllowsTitleIdle,
  PaneGoneError,
  type AdoptPaneState,
  type AgentRuntimeKind,
  type TmuxSessionRef,
  type PaneRef,
} from './tmux.js';
import { BranchManager, DirtyWorkdirError, ReviewHeadMismatchError, isAutoDeletableTaskBranch } from './branch.js';
import { RepoStore, createRepoStoreCache, moveFileIntoPlace, stageFileGuarded, canonicalSelfGuard, type RepoStoreCache } from './repo-store.js';
import type { PaneStreamerManager } from './pane-streamer-manager.js';
import {
  PhaseSignalWatcher,
  type NeedInputCommitIntent,
  type NeedInputCommitResult,
  type PhaseSignalWatcherStartArgs,
} from './phase-signal-watcher.js';
import type { PhaseSignalKind } from './phase-signal.js';
import { ReviewTransport, resolveServerPayloads, type ServerPayloadPromptOpts } from './review-transport.js';
import { reviewFindingsDigest, type ReviewStore } from '../state/review-store.js';
import {
  buildPromptInline,
  buildGreetingPrompt,
  PromptSizeError,
  RequiredSkillsMissingError,
  MAX_PROMPT_BYTES_ROUTE_LIMIT,
  type PostMergeCleanupContext,
  type PlatformCliDescriptor,
  type ServerFeedbackCorrectionPrompt,
} from './prompt.js';
import { ApiError } from '../errors.js';
import { prepareConfig } from '../config/loader.js';
import { projectAfterDone, projectReviewMode, resolveProjectTool } from '../config/validator.js';
import { SHA_HEX_SOURCE } from '../platform/types.js';

export interface EnsureSessionResult {
  ok: true;
  createdSession: boolean;
  freshRuntime: boolean;
  skillsStale?: true;
  paneId: string;
  pane: PaneRef;
  workdir: string;
  sessionRef: TmuxSessionRef;
}

export class EnsureSessionError extends Error {
  constructor(
    public readonly partial: {
      createdSession: boolean;
      agentId: string;
      sessionRef?: TmuxSessionRef;
      genAtCreate?: number;
      dialogPending?: boolean;
      handled?: boolean;
      busyPending?: boolean;
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

export type DeletionClaimOutcome =
  | { ok: true }
  | { ok: false; code: 'active'; agentId: string; taskId: string }
  | { ok: false; code: 'bootstrapping'; agentId: string }
  | { ok: false; code: 'referencing'; taskId: string }
  | { ok: false; code: 'already-deleting'; agentId: string };

export function buildLaunchCommand(agent: AgentConfig): string {
  const yolo = agent.yolo !== false;
  const segments: string[] = [];
  switch (agent.runtime) {
    case 'claude-code':
      segments.push('env CLAUDE_CODE_NO_FLICKER=1 CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 claude');
      if (yolo) segments.push('--permission-mode bypassPermissions');
      break;
    case 'codex':
      segments.push('codex');
      if (yolo) segments.push('--dangerously-bypass-approvals-and-sandbox');
      break;
    case 'opencode':
      // opencode materializes skills into .agents/skills (shared with codex; see skillSubdirFor).
      // Its .agents/.claude compatibility scans can't both be disabled by env, so also turn off
      // the .claude/skills scan — that closes the last collision source: a claude-code agent's
      // .claude/skills/baxian-* in a shared base repo.
      segments.push('env OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1 opencode');
      if (yolo) segments.push('--auto');
      break;
    case 'qodercli':
      segments.push('qodercli');
      if (yolo) segments.push('--dangerously-skip-permissions');
      break;
  }
  if (agent.model) {
    segments.push(`--model ${shellQuote(agent.model)}`);
  }
  // opencode has no --add-dir; extra roots go through its permission model instead (validator rejects the pairing).
  if (agent.addDirs && agent.addDirs.length > 0 && agent.runtime !== 'opencode') {
    for (const dir of agent.addDirs) {
      segments.push(`--add-dir ${shellQuote(dir)}`);
    }
  }
  return segments.join(' ');
}

// cd re-resolves by pathname: a reused pane shell may sit on a deleted-and-recreated cwd inode.
export function launchCommandIn(dir: string, agent: AgentConfig): string {
  return `cd ${shellQuote(dir)} && ${buildLaunchCommand(agent)}`;
}

function agentRuntimeKindFor(agent: AgentConfig): AgentConfig['runtime'] {
  return agent.runtime;
}

// restart-repl drives the REPL back to a shell before relaunch. Each runtime exits
// via its own slash command (a bare "exit" would be sent to the model as chat text).
const REPL_EXIT_COMMAND: Record<AgentConfig['runtime'], string> = {
  'claude-code': '/exit',
  codex: '/quit',
  opencode: '/exit',
  qodercli: '/quit',
};

const WORKDIR_SESSION_OPTION = '@baxian-workdir';

type ReleaseRuntime =
  | { kind: 'absent' }
  | { kind: 'pane'; pane: PaneRef }
  | { kind: 'hold'; reason: string };

function normalizedDir(left: string | null | undefined): string | null {
  if (!left) return null;
  return left.replace(/\/+$/, '') || '/';
}

async function sameDirOnHost(
  runner: CommandRunner,
  left: string | null | undefined,
  right: string | null | undefined,
): Promise<boolean> {
  if (!left || !right) return false;
  if (normalizedDir(left) === normalizedDir(right)) return true;
  const physical = async (path: string): Promise<string> => {
    const result = await runner.exec(`cd -P ${shellQuote(path)} && pwd -P`);
    const resolved = normalizedDir(result.stdout.trim());
    if (result.exitCode !== 0 || !resolved) {
      throw new Error(
        `Cannot resolve physical path for ${path}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      );
    }
    return resolved;
  };
  return await physical(left) === await physical(right);
}

export function skillSubdirFor(runtime: AgentConfig['runtime']): string {
  switch (runtime) {
    case 'codex':
    case 'opencode':
      // opencode has no way to disable its .agents/skills compatibility scan (only .claude via
      // env), and when it shares a base repo with a codex agent it loads the codex copy of a
      // same-named baxian-* skill (verified: the .agents copy wins over .opencode). So opencode
      // materializes into .agents/skills too — both runtimes share one runtime-agnostic copy
      // (serialized by the same skill-dir lock) instead of colliding on duplicate names.
      return '.agents/skills';
    case 'qodercli':
      return '.qoder/skills';
    default:
      return '.claude/skills';
  }
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
    agentId: string,
    workdir?: string,
  ) => RepoStore;
  paneStreamerManager?: PaneStreamerManager;
  pluginRegistry?: PluginRegistry;
  platformDefaultBranchOf?: (projectId: string) => string | undefined;
  phaseSignalWatcher?: PhaseSignalWatcher;
  errorRecordStore?: ErrorRecordStore;
  reviewStore?: ReviewStore;
  bootstrapTimeoutsMs?: {
    trustDialog?: number;
    waitReplReady?: number;
    greeting?: number;
  };
  dispatchAckTimeoutMs?: number;
  needInputRetryIntervalMs?: number;
  dispatchSettleTimeoutMs?: number;
}

const DEFAULT_DISPATCH_ACK_TIMEOUT_MS = 30_000;
const DEFAULT_NEED_INPUT_RETRY_INTERVAL_MS = 5_000;
const DEFAULT_DISPATCH_SETTLE_TIMEOUT_MS = 3_000;
// DELETE runtime cleanup runs while holding the deletion tombstone + rotated lock; an unbounded remote
// probe/kill would block rollback/finally forever, so every tmux round-trip in it carries this deadline.
const DELETE_CLEANUP_TIMEOUT_MS = 15_000;
const PLATFORM_HEAD_SHA_RE = new RegExp(`^${SHA_HEX_SOURCE}$`);

function createSignalTokenExcluding(...excluded: string[]): string {
  let token = createSignalToken();
  while (excluded.includes(token)) token = createSignalToken();
  return token;
}

export class PlatformMergeRecheckError extends Error {
  constructor(
    readonly kind: 'pending-feedback' | 'provenance-invalid',
    readonly reason: string,
  ) {
    super(`merge blocked: ${reason}`);
    this.name = 'PlatformMergeRecheckError';
  }
}

export interface TransitionResult {
  task: TaskState;
  previousStatus: TaskStatus;
}

interface SessionDispatchOpts {
  signalToken?: string;
  currentSpecRound?: number;
  bypassTaskStatusGate?: boolean;
  dialogFailFromStatuses?: TaskStatus[];
  serverContent?: string;
  serverInterdiff?: string;
  serverDiffstat?: string;
  serverBaseSha?: string;
  serverHeadSha?: string;
  serverHeadTree?: string;
  serverBatch?: { index: number; total: number };
  serverPriorFindings?: string;
  serverFindingsDigest?: string;
  serverFeedbackCorrection?: ServerFeedbackCorrectionPrompt;
  serverPriorResponse?: string;
  specDocuments?: readonly SpecDocument[];
  armBeforeInject?: (ctx: DispatchArmContext) => Promise<boolean>;
}

interface StartSessionOpts extends SessionDispatchOpts {
  preserveBindingOnFailure?: boolean;
  dispatchPassToken?: string;
  dispatchReviewLease?: Pick<ReviewDispatchLease,
    'generation' | 'claimId' | 'signalToken' | 'headSha' | 'passToken' | 'failToken' | 'effectiveRound' | 'qaPhase'>;
  dispatchPendingBudget?: { since: number; budgetAlerted?: boolean };
}

export interface ContinueSessionOpts extends SessionDispatchOpts {
  postApproveRedispatchCount?: number;
  postApproveEpisode?: PostApproveEpisodeKey;
  serverAfterDone?: { kind: 'branch' | 'pr'; branch: string };
  preserveDispatchOutputs?: boolean;
  // In-flight replay: the dirty tree is the holder's own work, so only the branch pointer is asserted.
  allowDirtyWorkdir?: boolean;
  // Post-arm binding/lock rechecks don't re-verify task state; the replay fence extends to the pre-paste gates.
  guardBeforeInject?: () => Promise<boolean>;
  // Replay holds CAS on the entry hold generation so a successor hold is never overwritten.
  expectedHold?: { phase?: string; since?: string; nonce?: string };
}

export interface DispatchArmContext {
  serverReviewCheckout?: 'head' | 'base';
}

export interface MergePrOpts {
  matchHeadSha?: string;
  humanOverride?: boolean;
}

export interface PostApproveEpisodeKey {
  generation: string;
  token: string;
  headSha: string;
}

type ReviewDispatchFence = Pick<
  ReviewDispatchLease,
  'generation' | 'signalToken' | 'headSha' | 'passToken' | 'failToken' | 'effectiveRound' | 'qaPhase'
>;

export type CodeInterdiffResult =
  | { ok: true; diff: string }
  | { ok: false; reason: 'no-anchor' }
  | { ok: false; reason: 'released' };

export interface ServerReviewDriver {
  dispatchCodeReview(task: TaskState, opts?: { bumpRound?: boolean }): Promise<boolean>;
  dispatchSpecReview(task: TaskState, opts?: { bumpRound?: boolean }): Promise<boolean>;
}

const MANUAL_SERVER_REVIEW_STATUSES: readonly TaskStatus[] = ['in_progress', 'review', 'fixing'];

const IMAGE_DISPATCH_PHASES = new Set<string>(['develop', 'research', 'code', 'fix', 'server-feedback']);

const RUNTIME_LIVENESS_SAMPLES = 3;

export function canDispatchWithBinding(binding: AgentBindingFacts | null | undefined): boolean {
  return !binding?.taskId && !binding?.creationToken && binding?.status !== 'awaiting_human';
}

// 派发期 hold：prompt 从未注入、pane 无在途回合，重派安全；ack_unknown 一类不在此列
export const RECOVERABLE_QA_DISPATCH_HOLD_PHASES = new Set<string>([
  'checkout-preparation-failed',
  'dirty-workdir',
]);

export function isRecoverableQaDispatchHold(binding: AgentBindingFacts | null | undefined): boolean {
  return binding?.status === 'awaiting_human'
    && binding.awaitingPhase != null
    && RECOVERABLE_QA_DISPATCH_HOLD_PHASES.has(binding.awaitingPhase);
}

// REPL 忙碌是常态（QA 回合分钟级、dev 修完即推），遇忙派发不落 hold 而登记待补派；
// 内存态即可：进程重启丢失后由对账兜底路径按 PENDING_IDLE 观察恢复。
export interface PendingDispatchRetry {
  kind: 'qa-recheck' | 'dev-fix';
  agentId: string;
  signalToken: string;
  qaPhase?: 'review' | 'recheck';
  since: number;
  budgetAlerted?: boolean;
}

const TURN_COMPLETED_AWAITING_PHASES = new Set<string>();

const CANCEL_CLEANUP_HOLD_PHASES = new Set<string>(['cancel-clearing', 'cancel-interrupt-failed']);

function isCancelCleanupHold(binding: { awaitingPhase?: string } | null | undefined): boolean {
  return binding?.awaitingPhase != null && CANCEL_CLEANUP_HOLD_PHASES.has(binding.awaitingPhase);
}

const CANCEL_CLEANUP_PHASE_RANK: Record<string, number> = {
  'cancel-clearing': 1,
  'cancel-interrupt-failed': 2,
};
function cancelPhaseRank(phase: string | undefined): number {
  return phase ? (CANCEL_CLEANUP_PHASE_RANK[phase] ?? 0) : 0;
}
function cancelPhaseDowngrades(prev: string | undefined, next: string): boolean {
  return cancelPhaseRank(next) < cancelPhaseRank(prev);
}

const REGREET_REQUIRED_HOLD_PHASES = new Set<string>(['greeting_failed']);

const CHECKOUT_HOLD_PHASES = new Set([
  'dirty-workdir',
  'checkout-preparation-failed',
  'branch-cleanup-pending',
]);

function shouldReleaseHeldBinding(
  state: AgentBindingFacts,
  boundTask: TaskState | null | undefined,
): boolean {
  if (state.awaitingPhase != null && REGREET_REQUIRED_HOLD_PHASES.has(state.awaitingPhase)) return false;
  const taskIsTerminal = !!boundTask && TERMINAL_STATUSES.includes(boundTask.status);
  const turnCompleted = state.awaitingPhase != null && TURN_COMPLETED_AWAITING_PHASES.has(state.awaitingPhase);
  // 任务已退回 verdict 门禁且当前持有者不是本 agent：这次绑定是转码失败的残留
  // （fresh-acquire 释放被脏树挡下），Resume 时补完释放，否则 dev 被永久占住
  const staleCodeHandoff =
    state.awaitingPhase != null
    && CHECKOUT_HOLD_PHASES.has(state.awaitingPhase)
    && !!boundTask
    && (boundTask.status === 'spec-ready' || boundTask.status === 'max_rounds')
    && boundTask.agentId !== state.id;
  return !boundTask || taskIsTerminal || turnCompleted || staleCodeHandoff;
}

export interface PostApproveCompletion {
  token: string;
  approvedHeadSha: string;
  generation: string;
  updatedAt: string;
  redispatchCount?: number;
  pendingRedispatch?: boolean;
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
  protected pluginRegistry?: PluginRegistry;
  private platformDefaultBranchOf?: (projectId: string) => string | undefined;
  private readonly platformDriverExec: DriverExec;
  protected phaseSignalWatcher?: PhaseSignalWatcher;
  protected errorRecordStore?: ErrorRecordStore;
  protected reviewStore?: ReviewStore;
  private reviewTransportInstance?: ReviewTransport;
  private serverReviewDriver?: ServerReviewDriver;
  protected dispatchAckTimeoutMs: number;
  private readonly needInputRetryIntervalMs: number;
  protected dispatchSettleTimeoutMs: number;
  protected dispatchAckResendIntervalMs = 3_000;

  private taskMutationQueue: Promise<unknown> = Promise.resolve();
  private agentOperationQueues = new Map<string, Promise<void>>();
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
  protected platformVerificationRetryDelayMs = 2_000;
  protected readyStableSamples = 3;
  protected readyStableSpacingMs = 1_000;
  private pendingDispatchRetryByTask = new Map<string, PendingDispatchRetry>();
  protected cancelInterruptGuardWaitMs = DEFAULT_DISPATCH_ACK_TIMEOUT_MS + 5_000;
  private manualReviewInFlight = new Set<string>();
  private markCompleteInFlight = new Set<string>();
  private specVerdictInFlight = new Set<string>();
  private codeVerdictInFlight = new Set<string>();
  // 引用计数：cancelTask 与 startCreatedTaskSession 的清理段可合法并存（启动期 Stop），先完成者不得清掉后者的 guard。
  private cancelCleanupInFlight = new Map<string, number>();
  private deletionInFlight = new Set<string>();
  // Diverged ids live in a separate set the DELETE finally never clears: a post-commit replaceConfig throw must fail-stop for the whole process.
  private divergedAgents = new Set<string>();
  private deletionGeneration = new Map<string, number>();
  private compactInFlight = new Set<string>();
  private configInterventionKeys = new Set<string>();

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
    this.pluginRegistry = deps.pluginRegistry;
    this.platformDefaultBranchOf = deps.platformDefaultBranchOf;
    this.errorRecordStore = deps.errorRecordStore;
    this.phaseSignalWatcher = deps.phaseSignalWatcher
      ?? (deps.paneStreamerManager
        ? new PhaseSignalWatcher({
            paneStreamerManager: deps.paneStreamerManager,
            eventBus: deps.eventBus,
            resolveAgent: (id) => this.getAgentConfig(id),
            commitNeedInputWatermark: (intent) => this.commitNeedInputWatermark(intent),
          })
        : undefined);
    this.needInputRetryIntervalMs = deps.needInputRetryIntervalMs ?? DEFAULT_NEED_INPUT_RETRY_INTERVAL_MS;
    this.reviewStore = deps.reviewStore;
    this.dispatchAckTimeoutMs = deps.dispatchAckTimeoutMs ?? DEFAULT_DISPATCH_ACK_TIMEOUT_MS;
    this.dispatchSettleTimeoutMs = deps.dispatchSettleTimeoutMs ?? DEFAULT_DISPATCH_SETTLE_TIMEOUT_MS;
    this.cancelInterruptGuardWaitMs = this.dispatchAckTimeoutMs + 5_000;
    this.agentIndex = buildAgentIndex(config);
    this.platformRunner = deps.platformRunner ?? new LocalRunner();
    this.platformDriverExec = makeDriverExec(this.platformRunner);
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

  private withAgentOperationLease<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.agentOperationQueues.get(agentId) ?? Promise.resolve();
    const next = previous.then(fn);
    const settled = next.then(() => undefined, () => undefined);
    this.agentOperationQueues.set(agentId, settled);
    void settled.then(() => {
      if (this.agentOperationQueues.get(agentId) === settled) {
        this.agentOperationQueues.delete(agentId);
      }
    });
    return next;
  }

  private async resolveTaskLockToken(
    state: AgentBindingFacts,
    taskId: string,
  ): Promise<string | null> {
    if (state.lockToken && await this.lockManager.isOwner(state.id, taskId, state.lockToken)) {
      return state.lockToken;
    }
    if (state.lockToken) return null;
    const claim = await this.lockManager.claimOf(state.id);
    const token = claim?.taskId === taskId ? claim.token : null;
    if (!token) return null;
    await this.agentStore.update(state.id, (latest) => {
      if (!latest || latest.taskId !== taskId || latest.lockToken) return AGENT_STORE_NOOP;
      return { ...latest, lockToken: token, updatedAt: new Date().toISOString() };
    });
    return token;
  }

  private async assertTaskLockOwner(agentId: string, taskId: string, token: string): Promise<void> {
    if (!(await this.lockManager.isOwner(agentId, taskId, token))) {
      throw new Error(`Agent ${agentId} ownership changed for task ${taskId}; operation aborted`);
    }
  }

  private async assertTaskGeneration(
    agentId: string,
    taskId: string,
    lockToken: string,
    workdir: string,
  ): Promise<AgentBindingFacts> {
    const state = await this.agentStore.get(agentId);
    if (
      !state
      || state.taskId !== taskId
      || state.lockToken !== lockToken
      || state.workdir !== workdir
    ) {
      throw new Error(`Agent ${agentId} task generation changed for ${taskId}; operation aborted`);
    }
    await this.assertTaskLockOwner(agentId, taskId, lockToken);
    return state;
  }

  getReviewStore(): ReviewStore | undefined {
    return this.reviewStore;
  }

  setServerReviewDriver(driver: ServerReviewDriver): void {
    this.serverReviewDriver = driver;
  }

  effectiveReviewMode(projectId: string): ReviewMode {
    const project = this.getProjectConfig(projectId);
    return project?.review?.mode ?? this.config.review.mode ?? 'git';
  }

  resolveAfterDone(task: TaskState): AfterDone {
    if (task.afterDone !== undefined) return task.afterDone;
    return this.coerceAfterDone(task.projectId);
  }

  private coerceAfterDone(projectId: string): AfterDone {
    const project = this.getProjectConfig(projectId);
    return project ? projectAfterDone(this.config, project) : (this.config.review.afterDone ?? null);
  }

  async commitServerAfterDone(taskId: string): Promise<AfterDone> {
    return this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task) throw new ApiError(404, `Task ${taskId} not found`);
      if (task.afterDone === 'pr' && task.platformBinding === undefined) {
        throw new Error(`platform binding missing for task ${task.id}; refusing to reconstruct it from live config`);
      }
      if (task.afterDone === 'pr') this.assertPlatformBinding(task);
      const afterDone = this.resolveAfterDone(task);
      const shouldSnapshotBinding = task.afterDone === undefined && afterDone === 'pr';
      const defaultBaseBranch = afterDone === 'pr' && task.baseBranch === undefined
        ? this.platformDefaultBranchOf?.(task.projectId)
        : undefined;
      if (task.afterDone === afterDone && !shouldSnapshotBinding && defaultBaseBranch === undefined) return afterDone;
      await this.taskStore.set({
        ...task,
        afterDone,
        ...(shouldSnapshotBinding ? { platformBinding: this.platformBindingFor(task.projectId) } : {}),
        ...(defaultBaseBranch !== undefined ? { baseBranch: defaultBaseBranch } : {}),
        updatedAt: new Date().toISOString(),
      });
      return afterDone;
    });
  }

  getReviewTransport(): ReviewTransport {
    this.reviewTransportInstance ??= new ReviewTransport({
      createRunnerFor: (agent) => this.createRunnerFor(agent),
      resolveWorkdir: (agentId) => this.bindingWorkdirCache.get(agentId),
    });
    return this.reviewTransportInstance;
  }

  private async prepareDispatchArtifacts(
    agent: AgentConfig,
    workdir: string,
    phase: string,
    opts: {
      specDocuments: readonly SpecDocument[] | undefined;
      preserveOutputs: boolean;
      assertOwner: () => Promise<void>;
    },
  ): Promise<void> {
    const transport = this.getReviewTransport();
    if (!opts.preserveOutputs) await transport.clearDispatchOutputs(agent, workdir, phase);
    if (opts.specDocuments) {
      await transport.replaceSpecDocuments(agent, workdir, opts.specDocuments, opts.assertOwner);
    }
  }

  private bindingWorkdirCache = new Map<string, string>();

  async refreshWorkdirCacheFor(agentId: string): Promise<string | undefined> {
    const state = await this.agentStore.get(agentId);
    const workdir = state?.workdir;
    if (workdir) {
      this.bindingWorkdirCache.set(agentId, workdir);
      return workdir;
    }
    this.bindingWorkdirCache.delete(agentId);
    return undefined;
  }

  private async safeEmit(event: BaxianEvent): Promise<boolean> {
    try {
      await this.eventBus.emit(event);
      return true;
    } catch (err) {
      console.warn(
        `[AgentManager] safeEmit ${event.type} failed (audit log loss; state machine unaffected):`,
        err,
      );
      return false;
    }
  }

  private async emitIntervention(
    projectId: string,
    agentId: string | undefined,
    taskId: string | undefined,
    data: Record<string, unknown> & { phase: string },
  ): Promise<boolean> {
    return this.safeEmit({
      id: '',
      type: 'human.intervention',
      timestamp: new Date().toISOString(),
      projectId,
      ...(agentId ? { agentId } : {}),
      ...(taskId ? { taskId } : {}),
      data,
    });
  }

  // 配置层 intervention（无 agent/task 上下文）：如 repo-conflict——离线绕过锁的同 repo 冲突项目。
  async emitConfigIntervention(
    projectId: string,
    data: Record<string, unknown> & { phase: string },
  ): Promise<void> {
    const key = this.configInterventionKey(projectId, data);
    if (this.configInterventionKeys.has(key)) return;
    if (await this.emitIntervention(projectId, undefined, undefined, data)) {
      this.configInterventionKeys.add(key);
    }
  }

  configInterventionKey(projectId: string, data: Record<string, unknown> & { phase: string }): string {
    return `config:${projectId}:${JSON.stringify(data)}`;
  }

  platformBindingInterventionKey(task: TaskState, mismatch: PlatformBindingMismatch): string {
    return `binding:${task.id}:${mismatch.reason}:${mismatch.differences.join(',')}:` +
      `${JSON.stringify(mismatch.binding ?? null)}:${JSON.stringify(mismatch.live ?? null)}`;
  }

  retainConfigInterventionKeys(keys: ReadonlySet<string>): void {
    for (const key of this.configInterventionKeys) {
      if (!keys.has(key)) this.configInterventionKeys.delete(key);
    }
  }

  async emitPlatformBindingIntervention(
    task: TaskState,
    mismatch: PlatformBindingMismatch,
  ): Promise<void> {
    const key = this.platformBindingInterventionKey(task, mismatch);
    if (this.configInterventionKeys.has(key)) return;
    const emitted = await this.emitIntervention(task.projectId, task.agentId || undefined, task.id, {
      phase: 'platform-binding-mismatch',
      reason: mismatch.reason,
      differences: mismatch.differences,
      ...(mismatch.binding !== undefined ? { binding: mismatch.binding } : {}),
      ...(mismatch.live !== undefined ? { live: mismatch.live } : {}),
    });
    if (emitted) this.configInterventionKeys.add(key);
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
    const previousConfig = this.config;
    const previousIndex = this.agentIndex;
    const nextIndex = buildAgentIndex(config);
    for (const [ownerKey, agentId] of this.repoCache.owners) {
      const previous = previousIndex.get(agentId);
      const next = nextIndex.get(agentId);
      const previousHost = previous
        ? resolveAgentHost(previousConfig.host, previous.host)
        : undefined;
      const nextHost = next ? resolveAgentHost(config.host, next.host) : undefined;
      const previousOwnerConfig = previous
        ? `${workdirHostGroupKey(previous.mode, previousHost)}\0${previous.workdir ? normalize(previous.workdir) : ''}`
        : null;
      const nextOwnerConfig = next
        ? `${workdirHostGroupKey(next.mode, nextHost)}\0${next.workdir ? normalize(next.workdir) : ''}`
        : null;
      if (previousOwnerConfig === null || previousOwnerConfig !== nextOwnerConfig) {
        this.repoCache.owners.delete(ownerKey);
      }
    }
    this.config = config;
    this.agentIndex = nextIndex;
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

  // Scan + claim share createTask/dispatchPendingTask's withTaskLock, so a delete can't pass an active-scan that a concurrent in_progress commit then orphans.
  async scanActiveThenClaimDeletion(targets: readonly string[]): Promise<DeletionClaimOutcome> {
    return this.withTaskLock(async () => {
      for (const id of targets) {
        const state = await this.agentStore.get(id);
        const task = state?.taskId ? await this.taskStore.get(state.taskId) : null;
        if (task && ACTIVE_TASK_STATUSES.has(task.status)) {
          return { ok: false, code: 'active', agentId: id, taskId: task.id };
        }
        if (state?.status === 'awaiting_human') continue;
        if (state?.creationToken) return { ok: false, code: 'bootstrapping', agentId: id };
      }
      const targetSet = new Set(targets);
      const referencing = (await this.taskStore.list({})).find(t =>
        ACTIVE_TASK_STATUSES.has(t.status)
        && ((t.preferredAgentId !== '' && targetSet.has(t.preferredAgentId))
          || (!!t.agentId && targetSet.has(t.agentId))
          || (!!t.devAgentId && targetSet.has(t.devAgentId))
          || (!!t.qaAgentId && targetSet.has(t.qaAgentId))
          || (!!t.researchAgentId && targetSet.has(t.researchAgentId))));
      if (referencing) return { ok: false, code: 'referencing', taskId: referencing.id };
      const conflict = this.tryClaimDeletion(targets);
      if (conflict) return { ok: false, code: 'already-deleting', agentId: conflict };
      return { ok: true };
    });
  }

  releaseDeletionClaim(agentIds: readonly string[]): void {
    for (const id of agentIds) this.deletionInFlight.delete(id);
  }

  // strict 读取：守卫扫描不能把读失败折叠成「无活跃任务」放行提交
  async listActiveParticipantSeats(): Promise<Array<{
    taskId: string;
    projectId: string;
    participants: Array<{ agentId: string; expectedRole?: AgentConfig['role'] }>;
  }>> {
    const tasks = await this.taskStore.listStrict();
    return tasks
      .filter(task => ACTIVE_TASK_STATUSES.has(task.status))
      .map(task => {
        const byId = new Map<string, { agentId: string; expectedRole?: AgentConfig['role'] }>();
        const add = (agentId: string | undefined, expectedRole?: AgentConfig['role']): void => {
          if (typeof agentId !== 'string' || agentId === '') return;
          const existing = byId.get(agentId);
          if (existing === undefined || (existing.expectedRole === undefined && expectedRole !== undefined)) {
            byId.set(agentId, { agentId, ...(expectedRole !== undefined ? { expectedRole } : {}) });
          }
        };
        add(task.preferredAgentId);
        add(task.agentId);
        add(task.devAgentId, 'dev');
        add(task.qaAgentId, 'qa');
        add(task.researchAgentId, 'research');
        return { taskId: task.id, projectId: task.projectId, participants: [...byId.values()] };
      });
  }

  // A completed DELETE keeps blocking this id past tombstone release; the process dies with any suspended flow, so no persistence is needed.
  bumpDeletionGeneration(agentId: string): void {
    this.deletionGeneration.set(agentId, this.deletionGenerationOf(agentId) + 1);
  }

  deletionGenerationOf(agentId: string): number {
    return this.deletionGeneration.get(agentId) ?? 0;
  }

  // Boolean tombstone alone is ABA-prone (delete→recreate same id); commits must hold both the tombstone-clear and an unchanged generation from entry.
  private deletionGateOpen(agentId: string, genAtEntry: number): boolean {
    return !this.isDeletionInFlight(agentId) && this.deletionGenerationOf(agentId) === genAtEntry;
  }

  isDeletionInFlight(agentId: string): boolean {
    return this.deletionInFlight.has(agentId) || this.divergedAgents.has(agentId);
  }

  // replaceConfig 抛错后的 fail-stop：进入 divergedAgents（不随 DELETE finally 释放），重建/分配持续被拒直到重启。
  retainTombstoneForDivergence(agentId: string): void {
    this.divergedAgents.add(agentId);
  }

  async ensureSession(
    agentId: string,
    mode: EnsureSessionMode,
    opts: { expectedGeneration?: number } = {},
  ): Promise<EnsureSessionResult> {
    const genAtEntry = opts.expectedGeneration ?? this.deletionGenerationOf(agentId);
    if (!this.deletionGateOpen(agentId, genAtEntry)) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `agent ${agentId} is being deleted (or was deleted and recreated); refusing session work`,
      );
    }
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

    // Side-effects run inside the lifecycle section (serialized with DELETE cleanup) behind a re-checked generation gate; the entry gate is only a fast-fail.
    return this.runUnderSessionLifecycle(agentId, () =>
      this.ensureSessionLocked(tmux, runner, agent, project, agentId, mode, genAtEntry),
    );
  }

  private async ensureSessionLocked(
    tmux: TmuxManager,
    runner: CommandRunner,
    agent: AgentConfig & { projectId: string },
    project: ProjectConfig,
    agentId: string,
    mode: EnsureSessionMode,
    genAtEntry: number,
  ): Promise<EnsureSessionResult> {
    const assertGenerationOpen = (): void => {
      if (!this.deletionGateOpen(agentId, genAtEntry)) {
        throw new EnsureSessionError(
          { createdSession: false, agentId },
          `agent ${agentId} is being deleted (or was deleted and recreated); refusing session work`,
        );
      }
    };
    assertGenerationOpen();

    let workdir: string;
    try {
      const resolved = await this.ensureWorkdir(agent, project, runner);
      workdir = resolved.workdir;
    } catch (err) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `ensureWorkdir failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Gate the Workdir write too: a DELETE→recreate during the slow ensureWorkdir must not persist a stale Workdir onto the new incarnation.
    assertGenerationOpen();
    await this.agentStore.update(agentId, (existing) => {
      if (!existing || !this.deletionGateOpen(agentId, genAtEntry)) return AGENT_STORE_NOOP;
      return { ...existing, workdir, updatedAt: new Date().toISOString() };
    });
    assertGenerationOpen();

    try {
      await this.provisionRepoSkills(runner, agent, workdir);
    } catch (err) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `skill provisioning failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    assertGenerationOpen();
    let snapshot: Awaited<ReturnType<TmuxManager['getSessionSnapshot']>>;
    try {
      snapshot = await tmux.getSessionSnapshot(agentId);
    } catch (err) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `tmux probe failed: ${err instanceof Error ? err.message : String(err)}; ` +
          `if tmux is missing, ${tmuxInstallHint(agent.projectId)}`,
      );
    }
    // Re-gate after the probe await: a DELETE may have tombstoned mid-probe, and build/adopt would else create a session cleanup can only reap later.
    assertGenerationOpen();
    if (!snapshot) {
      return this.buildFreshSession(tmux, agent, agentId, workdir, workdir);
    }
    if (snapshot.claim === null) {
      if (await this.reclaimHalfCreatedSession(tmux, agentId, snapshot)) {
        return this.buildFreshSession(tmux, agent, agentId, workdir, workdir);
      }
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `tmux session "${agentId}" already exists on host; baxian only manages sessions ` +
          `it creates itself — kill it manually or pick a different agent id`,
      );
    }
    if (mode === 'create' || snapshot.claim !== agentId) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        mode === 'create'
          ? `tmux session "${agentId}" already exists on host; baxian only manages sessions ` +
            `it creates itself — kill it manually or pick a different agent id`
          : `tmux session "${agentId}" exists but @baxian-agent-id session claim mismatch ` +
            `(got "${snapshot.claim}"); baxian will not adopt foreign session — operator must intervene`,
      );
    }
    return this.adoptOrRestartSessionLocked(tmux, runner, agent, agentId, workdir, workdir, snapshot);
  }

  private agentSkillScope(agentId: string): SkillScope {
    const projectId = this.getAgentConfig(agentId)?.projectId;
    if (projectId === undefined || this.effectiveReviewMode(projectId) !== 'git') {
      return { pluginTools: [] };
    }
    const project = this.getProjectConfig(projectId);
    const tool = project === undefined ? undefined : resolveProjectTool(project);
    return { pluginTools: tool === undefined ? [] : [tool] };
  }

  private async provisionRepoSkills(
    runner: CommandRunner,
    agent: AgentConfig,
    workdir: string,
  ): Promise<void> {
    if (this.skillRegistry.names().length === 0) return;
    const scope = this.agentSkillScope(agent.id);
    const subdir = skillSubdirFor(agent.runtime);
    const destRoot = `${workdir}/${subdir}`;
    await this.excludeInjectedSkills(runner, workdir, subdir);
    // opencode's skills are model-invoked, not slash commands; the dispatched /<skill> sigil
    // reaches the model as message text and it loads the skill from .opencode/skills. We do NOT
    // wrap skills as .opencode/commands: opencode expands $ARGUMENTS in a command template and
    // would execute a `!`cmd`` / inline a @path embedded in an untrusted task title/description
    // before the skill runs. Message-body payloads are not expanded, so this path is injection-safe.
    await this.runUnderSkillDirLock(this.skillDirLockKey(agent, workdir), async () => {
      await this.ensureSkillDirSafe(runner, workdir, subdir, [
        ...this.skillRegistry.names(),
        ...this.skillRegistry.pluginSkillNames(scope),
      ]);
      await this.skillRegistry.materialize(
        (path, content) => this.atomicWriteFile(runner, workdir, path, content),
        destRoot,
        scope,
      );
    });
  }

  // A rollback only kills if no adoption bumped the generation since its create.
  private sessionLifecycleChain = new Map<string, Promise<unknown>>();
  private adoptGeneration = new Map<string, number>();

  private runUnderSessionLifecycle<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionLifecycleChain.get(agentId) ?? Promise.resolve();
    const cur = prev.then(fn, fn);
    const settled = cur.then(() => undefined, () => undefined);
    this.sessionLifecycleChain.set(agentId, settled);
    void settled.finally(() => {
      if (this.sessionLifecycleChain.get(agentId) === settled) this.sessionLifecycleChain.delete(agentId);
    });
    return cur;
  }

  // Inside the lifecycle lock, a generation bump since create means handoff — stand down.
  private async rollbackCreatedSession(
    agentId: string,
    partial: { sessionRef?: TmuxSessionRef; genAtCreate?: number },
    reason: string,
    opts: { expectCreationToken?: string } = {},
  ): Promise<void> {
    await this.runUnderSessionLifecycle(agentId, async () => {
      try {
        const ref = partial.sessionRef;
        if (!ref) {
          console.warn(`[AgentManager] ${agentId} rollback (${reason}) skipped: no session ref recorded`);
          return;
        }
        if ((this.adoptGeneration.get(agentId) ?? 0) !== (partial.genAtCreate ?? 0)) {
          console.warn(
            `[AgentManager] ${agentId} rollback (${reason}) skipped: session adopted since create — leaving it to its successor`,
          );
          return;
        }
        if (opts.expectCreationToken !== undefined) {
          let fresh;
          try {
            fresh = await this.agentStore.get(agentId);
          } catch (storeErr) {
            console.warn(
              `[AgentManager] ${agentId} rollback (${reason}) skipped: agent store read failed — session left in place:`,
              storeErr,
            );
            return;
          }
          if (!fresh) {
            console.warn(`[AgentManager] ${agentId} rollback (${reason}) skipped: agent record gone`);
            return;
          }
          if (fresh.creationToken !== opts.expectCreationToken) {
            console.warn(
              `[AgentManager] ${agentId} rollback (${reason}) skipped: creationToken rotated — leaving the session to its successor`,
            );
            return;
          }
        }
        const cfg = this.getAgentConfig(agentId);
        if (!cfg) {
          console.warn(`[AgentManager] ${agentId} rollback (${reason}) skipped: agent no longer in config`);
          return;
        }
        const runner = this.createRunnerFor(cfg);
        // Rollback may run before or after the claim write, so accept empty-or-ours.
        const outcome = await new TmuxManager(runner).killSessionRef(ref, { kind: 'emptyOr', claim: agentId });
        if (outcome === 'refused') {
          console.warn(
            `[AgentManager] ${agentId} rollback (${reason}): tmux generation/claim changed — leaving session ${ref.sessionId} untouched`,
          );
        } else if (outcome === 'killed') {
          console.warn(`[AgentManager] ${agentId} rollback (${reason}): killed created session ${ref.sessionId}`);
        }
      } catch (cleanupErr) {
        console.warn(
          `[AgentManager] created-session rollback (${reason}) failed for ${agentId}:`,
          cleanupErr,
        );
      }
    });
  }

  async rollbackEnsureSessionFailure(agentId: string, err: unknown, reason: string): Promise<void> {
    if (!(err instanceof EnsureSessionError) || !err.partial.createdSession) return;
    await this.rollbackCreatedSession(agentId, err.partial, reason);
  }

  private skillDirChain = new Map<string, Promise<unknown>>();
  private skillDirLockKey(agent: AgentConfig, workdir: string): string {
    const host = hostGroupKey(agent.mode, resolveAgentHost(this.config.host, agent.host));
    const subdir = skillSubdirFor(agent.runtime);
    const dir = workdir.replace(/\/+$/, '');
    return `${host}:${dir}:${subdir}`;
  }
  private runUnderSkillDirLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.skillDirChain.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.then(() => undefined, () => undefined);
    this.skillDirChain.set(key, settled);
    void settled.finally(() => {
      if (this.skillDirChain.get(key) === settled) this.skillDirChain.delete(key);
    });
    return run;
  }

  private async atomicWriteFile(
    runner: CommandRunner,
    workdir: string,
    finalPath: string,
    content: Buffer,
  ): Promise<void> {
    const tmp = `${finalPath}.baxian-tmp-${randomBytes(6).toString('hex')}`;
    try {
      await stageFileGuarded(runner, workdir, tmp, content);
      await moveFileIntoPlace(runner, tmp, finalPath, { guardRoot: workdir });
    } catch (err) {
      throw new Error(`atomic skill write failed (${finalPath}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async ensureSkillDirSafe(
    runner: CommandRunner,
    workdir: string,
    subdir: string,
    keepNames: string[],
  ): Promise<void> {
    const top = subdir.split('/')[0];
    const keep = keepNames.map((n) => `! -name ${shellQuote(n)}`).join(' ');
    const inner =
      // canonicalSelfGuard (cd+pwd -P) rejects a rebound MIDDLE ancestor, not just a symlinked leaf, so the find/rm can't escape.
      `${canonicalSelfGuard(workdir)} && ` +
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

  private async tagSessionSkillsVersion(
    tmux: TmuxManager,
    agentId: string,
    ref: TmuxSessionRef,
  ): Promise<void> {
    if (this.skillRegistry.names().length === 0) return;
    await this.setSessionOptions(tmux, agentId, ref, [
      ['@baxian-skills-version', this.skillRegistry.contentHash(this.agentSkillScope(agentId))],
    ]);
  }

  private async replSkillsStale(tmux: TmuxManager, agentId: string, ref: TmuxSessionRef): Promise<boolean> {
    if (this.skillRegistry.names().length === 0) return false;
    const tagged = await tmux.getSessionOptionByRef(ref, agentId, '@baxian-skills-version');
    return tagged !== this.skillRegistry.contentHash(this.agentSkillScope(agentId));
  }

  private async excludeInjectedSkills(
    runner: CommandRunner,
    workdir: string,
    subdir: string,
  ): Promise<void> {
    const inner =
      // canonicalSelfGuard (cd+pwd -P) rejects a rebound MIDDLE ancestor too, so the info/exclude write can't escape.
      `${canonicalSelfGuard(workdir)} && ` +
      `cd ${shellQuote(workdir)} && ` +
      `if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo BX_SKILLS_NON_GIT; exit 0; fi; ` +
      `tracked="$(git ls-files -- ${shellQuote(`${subdir}/baxian-*`)} 2>/dev/null | head -5)"; ` +
      `if [ -n "$tracked" ]; then printf 'BX_SKILLS_TRACKED %s\\n' "$tracked" | head -1; exit 0; fi; ` +
      `p="$(git rev-parse --git-path info/exclude)" || { echo BX_SKILLS_EXCLUDE_WRITE_FAILED; exit 0; }; ` +
      `pre="$(git rev-parse --show-prefix 2>/dev/null)"; rule="\${pre}${subdir}/baxian-*"; ` +
      `{ mkdir -p "$(dirname "$p")" && { grep -qxF "$rule" "$p" 2>/dev/null || printf '%s\\n' "$rule" >> "$p"; }; } ` +
      `|| { echo BX_SKILLS_EXCLUDE_WRITE_FAILED; exit 0; }; ` +
      `if git check-ignore -q -- ${shellQuote(`${subdir}/baxian-__probe__/SKILL.md`)}; then echo BX_SKILLS_OK; ` +
      `else echo BX_SKILLS_EXCLUDE_INEFFECTIVE; fi`;
    const res = await runner.exec(`sh -c ${shellQuote(inner)}`);
    if (res.exitCode !== 0) {
      throw new Error(
        `skill exclusion probe failed in ${workdir}: ${res.stderr.trim() || `exit ${res.exitCode}`}`,
      );
    }
    const verdict = res.stdout.trim().split('\n').pop() ?? '';
    if (verdict === 'BX_SKILLS_NON_GIT' || verdict === 'BX_SKILLS_OK') return;
    if (verdict.startsWith('BX_SKILLS_TRACKED')) {
      throw new Error(
        `refusing to inject baxian skills into ${workdir}: project tracks ` +
        `${verdict.replace('BX_SKILLS_TRACKED ', '')}`,
      );
    }
    throw new Error(
      `cannot make injected skills invisible to Git in ${workdir}: ${verdict || 'no probe output'}`,
    );
  }

  private runtimePinEntries(): Array<[string, string]> {
    return [
      ['prefix', 'C-b'],
      ['prefix2', 'None'],
      ['mouse', 'on'],
    ];
  }

  // A name (or even a bare $id) can rebind to a same-name successor mid-flight;
  // every option write goes through the identity-checked by-ref batch.
  private async setSessionOptions(
    tmux: TmuxManager,
    agentId: string,
    ref: TmuxSessionRef,
    entries: Array<[string, string]>,
    expectedClaim: string = agentId,
  ): Promise<void> {
    const outcome = await tmux.setSessionOptionsIfAlive(ref, entries, { expectedClaim });
    if (outcome === 'gone') {
      throw new Error(
        `tmux session ${ref.sessionId} (${agentId}) vanished before its options could be applied`,
      );
    }
  }

  // Snapshot's claim check is a filter; the returned PaneRef re-proves generation+claim on every op.
  private async resolveClaimedPane(
    tmux: TmuxManager,
    agentId: string,
    expectedPaneId?: string,
  ): Promise<PaneRef> {
    const snapshot = await tmux.getSessionSnapshot(agentId);
    if (!snapshot) throw new PaneGoneError(agentId, 'no tmux session');
    if (snapshot.claim !== agentId) {
      throw new PaneGoneError(agentId, `session claim mismatch (got "${snapshot.claim ?? 'null'}")`);
    }
    const pane = await tmux.getSinglePaneByRef(snapshot.ref, agentId);
    if (expectedPaneId !== undefined && pane.paneId !== expectedPaneId) {
      throw new PaneGoneError(agentId, `pane id changed (state ${expectedPaneId} != live ${pane.paneId})`);
    }
    return pane;
  }

  private async buildFreshSession(
    tmux: TmuxManager,
    agent: AgentConfig & { projectId: string },
    agentId: string,
    workdir: string,
    sessionDir: string = workdir,
  ): Promise<EnsureSessionResult> {
    return this.runUnderSkillDirLock(
      this.skillDirLockKey(agent, sessionDir),
      () => this.buildFreshSessionLocked(tmux, agent, agentId, workdir, sessionDir),
    );
  }

  private async buildFreshSessionLocked(
    tmux: TmuxManager,
    agent: AgentConfig & { projectId: string },
    agentId: string,
    workdir: string,
    sessionDir: string,
  ): Promise<EnsureSessionResult> {
    let createdSession = false;
    let createdRef: TmuxSessionRef | undefined;
    const genAtCreate = this.adoptGeneration.get(agentId) ?? 0;
    const runtime = agentRuntimeKindFor(agent);
    try {
      createdRef = await tmux.createSession(agentId, sessionDir);
      createdSession = true;
      // First batch writes the claim itself, so it must prove the session is still unclaimed.
      await this.setSessionOptions(tmux, agentId, createdRef, [
        ['@baxian-agent-id', agentId],
        ['@baxian-runtime', agent.runtime],
        [WORKDIR_SESSION_OPTION, sessionDir],
        ['allow-passthrough', 'on'],
        ['set-titles', 'on'],
        ['window-size', 'latest'],
        ...this.runtimePinEntries(),
        ['status-right', ''],
      ], '');
      await tmux.setServerOption('extended-keys', 'on');
      await tmux.appendServerOptionIfMissing('terminal-features', 'xterm*:extkeys');
      const pane = await tmux.getSinglePaneByRef(createdRef, agentId);
      await tmux.sendKeysLiteral(pane, launchCommandIn(sessionDir, agent));
      await tmux.sendEnter(pane);
      await tmux.handleTrustDialog(pane, runtime, {
        timeoutMs: this.bootstrapTimeoutsMs.trustDialog,
      });
      await tmux.waitReplReady(pane, runtime, {
        timeoutMs: this.bootstrapTimeoutsMs.waitReplReady,
        scrollback: 0,
      });
      await this.tagSessionSkillsVersion(tmux, agentId, createdRef);
      return { ok: true, createdSession: true, freshRuntime: true, paneId: pane.paneId, pane, workdir, sessionRef: createdRef };
    } catch (err) {
      const partial: {
        createdSession: boolean;
        agentId: string;
        sessionRef?: TmuxSessionRef;
        genAtCreate?: number;
        dialogPending?: boolean;
        lastScreen?: string;
      } = { createdSession, agentId, genAtCreate };
      if (createdRef) partial.sessionRef = createdRef;
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
    try {
      const result = await this.ensureSession(agentId, 'create');
      if (!(await this.runGreetingHandshake(agentId, cfgAtStart, result.pane))) {
        const current = await this.agentStore.get(agentId);
        if (current && current.creationToken !== creationToken) {
          console.warn(
            `[bootstrap] ${agentId} creationToken changed during greeting — leaving the session to its successor`,
          );
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
          `[bootstrap] ${agentId} creationToken mismatch on success — leaving the session to its successor`,
        );
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
              `[bootstrap] ${agentId} dialog-path token mismatch — leaving the session to its successor`,
            );
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
        await this.rollbackCreatedSession(agentId, err.partial, 'hard-failure rollback', {
          expectCreationToken: creationToken,
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      await this.markBootstrapFailed(agentId, creationToken, message);
    }
  }

  private async runGreetingHandshake(
    agentId: string,
    agent: AgentConfig & { projectId: string },
    pane: PaneRef,
  ): Promise<boolean> {
    const watcher = this.phaseSignalWatcher;
    if (!watcher) return true;
    const tmux = new TmuxManager(this.createRunnerFor(agent));
    for (let attempt = 1; attempt <= this.greetingMaxAttempts; attempt++) {
      const token = createSignalToken();
      try {
        await this.injectAndAwaitAckSteps(
          tmux, pane, buildGreetingPrompt(token, agent.runtime), agentId, agent.runtime,
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
      if (attempt < this.greetingMaxAttempts && !(await this.clearComposerForReuse(tmux, pane, agentId))) {
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
    await this.emitIntervention(existing.projectId, agentId, undefined, { phase: 'greeting_failed', reason });
  }

  async regreetHeldAgent(agentId: string): Promise<boolean> {
    const agent = this.getAgentConfig(agentId);
    if (!agent) return false;
    // Pin the incarnation before reading state so a DELETE→recreate reusing %0 can't route the greeting handshake to the new session.
    const genAtEntry = this.deletionGenerationOf(agentId);
    const state = await this.agentStore.get(agentId);
    if (state?.awaitingPhase !== 'greeting_failed') return false;
    const guardSince = state.awaitingSince;
    if (!this.deletionGateOpen(agentId, genAtEntry)) return false;
    let pane: PaneRef;
    try {
      pane = await this.resolveClaimedPane(new TmuxManager(this.createRunnerFor(agent)), agentId, state.paneId);
    } catch (err) {
      console.warn(`[regreet] cannot resolve pane for ${agentId}:`, err);
      return true;
    }
    if (!this.deletionGateOpen(agentId, genAtEntry)) return false;
    if (!(await this.runGreetingHandshake(agentId, agent, pane))) {
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
        paneId = (await this.resolveClaimedPane(new TmuxManager(this.createRunnerFor(cfg)), agentId)).paneId;
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
    await this.emitIntervention(projectIdForEmit, agentId, taskIdForEmit, {
      phase: 'agent_dialog_pending',
      reason: 'Agent REPL launched but blocked on a startup dialog (e.g. CLI update notice). Operator should attach via web terminal and dismiss it; baxian will auto-detect ready and resume.',
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
    opts: { expectedFromStatuses?: TaskStatus[]; expectedGeneration?: number } = {},
  ): Promise<boolean> {
    if (!(err instanceof EnsureSessionError) || !err.partial.dialogPending) {
      return false;
    }
    // The error belongs to the caller's incarnation; gate every side-effect so a DELETE→recreate reusing %0 can't write the stale dialog/fail onto the new agent.
    const gateOpen = (): boolean =>
      opts.expectedGeneration === undefined || this.deletionGateOpen(agentId, opts.expectedGeneration);
    let state = await this.agentStore.get(agentId);
    if (!state || !gateOpen()) return false;
    if (state.paneId === undefined && err.partial.createdSession) {
      const cfg = this.getAgentConfig(agentId);
      if (!cfg) return false;
      let discoveredPaneId: string | undefined;
      try {
        discoveredPaneId = (await this.resolveClaimedPane(new TmuxManager(this.createRunnerFor(cfg)), agentId)).paneId;
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
        if (!fresh || !gateOpen()) return AGENT_STORE_NOOP;
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
    if (!gateOpen()) return false;
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
      let pane: PaneRef;
      try {
        pane = await this.resolveClaimedPane(tmux, agentId);
      } catch {
        continue;
      }
      const paneId = pane.paneId;

      try {
        await tmux.waitReplReady(pane, runtime, {
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
      if (isBootstrapPath && !(await this.runGreetingHandshake(agentId, cfg, pane))) {
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
        await this.emitIntervention(projectIdForEmit, agentId, undefined, {
          phase: 'agent_dialog_resolved_runtime',
          note: 'Runtime dialog resolved; agent REPL ready. Click Resume to continue.',
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
        const pane = await this.resolveClaimedPane(tmux, agentId, state.paneId);
        stripped = await tmux.capturePaneById(pane, { ansi: false, scrollback: 0 });
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
        await this.emitIntervention(fresh.projectId, agentId, fresh.taskId, {
          phase: 'agent_runtime_menu_pending',
          note: 'Agent paused on an interactive menu mid-task. Attach via web terminal and respond; baxian will auto-clear once the menu closes.',
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

  // Runs inside the caller's lifecycle section (ensureSessionLocked routed the snapshot here).
  private async adoptOrRestartSessionLocked(
    tmux: TmuxManager,
    runner: CommandRunner,
    agent: AgentConfig & { projectId: string },
    agentId: string,
    workdir: string,
    sessionDir: string,
    snapshot: NonNullable<Awaited<ReturnType<TmuxManager['getSessionSnapshot']>>>,
  ): Promise<EnsureSessionResult> {
    const sessionRef = snapshot.ref;
    this.adoptGeneration.set(agentId, (this.adoptGeneration.get(agentId) ?? 0) + 1);
    try {
      await this.setSessionOptions(tmux, agentId, sessionRef, this.runtimePinEntries());
    } catch (err) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `pinning runtime session options failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let pane: PaneRef;
    try {
      pane = await tmux.getSinglePaneByRef(sessionRef, agentId);
    } catch (err) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `getSinglePaneId failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const paneId = pane.paneId;
    const runtime = agentRuntimeKindFor(agent);
    let state: AdoptPaneState;
    try {
      state = await tmux.classifyPaneForAdopt(pane, runtime);
    } catch (err) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `classifyPaneForAdopt failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let currentPath: string;
    try {
      currentPath = await tmux.getPaneCurrentPath(pane);
    } catch (err) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `pane current path probe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let pathMatches: boolean;
    try {
      pathMatches = await sameDirOnHost(runner, currentPath, sessionDir);
    } catch (err) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `pane current path comparison failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!pathMatches) {
      if (state.kind === 'live-runtime') {
        try {
          await this.waitForReplPromptReady(
            tmux,
            pane,
            agent.runtime,
            this.cleanComposerWaitMs,
          );
        } catch (err) {
          throw new EnsureSessionError(
            { createdSession: false, agentId },
            `Workdir change requires an idle runtime: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else if (state.kind !== 'shell') {
        throw new EnsureSessionError(
          { createdSession: false, agentId },
          `tmux pane path ${currentPath} differs from Workdir ${sessionDir}, but runtime is not safely idle`,
        );
      }
      await this.killAdoptTarget(tmux, agentId, sessionRef, 'workdir change');
      return this.buildFreshSession(tmux, agent, agentId, workdir, sessionDir);
    }
    await this.setSessionOptions(tmux, agentId, sessionRef, [[WORKDIR_SESSION_OPTION, sessionDir]]);
    switch (state.kind) {
      case 'live-runtime': {
        let stale: boolean;
        try {
          stale = await this.replSkillsStale(tmux, agentId, sessionRef);
        } catch (err) {
          throw new EnsureSessionError(
            { createdSession: false, agentId },
            `skills-version probe failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (stale) {
          return {
            ok: true,
            createdSession: false,
            freshRuntime: false,
            skillsStale: true,
            paneId,
            pane,
            workdir,
            sessionRef,
          };
        }
        return { ok: true, createdSession: false, freshRuntime: false, paneId, pane, workdir, sessionRef };
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
          await tmux.handleTrustDialog(pane, runtime, {
            timeoutMs: this.bootstrapTimeoutsMs.trustDialog,
          });
          await tmux.waitReplReady(pane, runtime, {
            timeoutMs: this.bootstrapTimeoutsMs.waitReplReady,
            scrollback: 0,
          });
          await this.tagSessionSkillsVersion(tmux, agentId, sessionRef);
          return { ok: true, createdSession: false, freshRuntime: true, paneId, pane, workdir, sessionRef };
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
      await tmux.sendKeysLiteral(pane, launchCommandIn(sessionDir, agent));
      await tmux.sendEnter(pane);
      await tmux.handleTrustDialog(pane, runtime, {
        timeoutMs: this.bootstrapTimeoutsMs.trustDialog,
      });
      await tmux.waitReplReady(pane, runtime, {
        timeoutMs: this.bootstrapTimeoutsMs.waitReplReady,
        scrollback: 0,
      });
      await this.tagSessionSkillsVersion(tmux, agentId, sessionRef);
      return { ok: true, createdSession: false, freshRuntime: true, paneId, pane, workdir, sessionRef };
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

  // Frees a bootstrap blocked on its predecessor's half-created session (nonce
  // env present but claim never written); anything else is left alone.
  private async reclaimHalfCreatedSession(
    tmux: TmuxManager,
    agentId: string,
    knownSnapshot?: Awaited<ReturnType<TmuxManager['getSessionSnapshot']>>,
  ): Promise<boolean> {
    let snapshot: Awaited<ReturnType<TmuxManager['getSessionSnapshot']>>;
    try {
      snapshot = knownSnapshot ?? await tmux.getSessionSnapshot(agentId);
    } catch (err) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `session snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!snapshot) return true;
    if (snapshot.claim !== null) return false;
    let halfCreated: boolean;
    try {
      halfCreated = await tmux.hasCreationNonce(agentId);
    } catch (err) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `creation-nonce probe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!halfCreated) return false;
    let outcome: Awaited<ReturnType<TmuxManager['killSessionRef']>>;
    try {
      // claim-still-empty rides the kill itself — a claim racing the probes makes the server refuse.
      outcome = await tmux.killSessionRef(snapshot.ref, { kind: 'unclaimed' });
    } catch (err) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `killSessionRef (half-created leftover) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (outcome === 'refused') {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `session ${snapshot.ref.sessionId} was claimed (or its server changed) while reclaiming the half-created leftover — retry to observe the new state`,
      );
    }
    if (outcome === 'killed') {
      console.warn(
        `[AgentManager] ${agentId}: killed half-created leftover session ${snapshot.ref.sessionId} (creation nonce present, claim never written)`,
      );
    } else {
      console.warn(
        `[AgentManager] ${agentId}: half-created leftover session ${snapshot.ref.sessionId} already gone`,
      );
    }
    return true;
  }

  private async killAdoptTarget(
    tmux: TmuxManager,
    agentId: string,
    sessionRef: TmuxSessionRef,
    reason: string,
  ): Promise<void> {
    let outcome: Awaited<ReturnType<TmuxManager['killSessionRef']>>;
    try {
      outcome = await tmux.killSessionRef(sessionRef, { kind: 'equals', claim: agentId });
    } catch (err) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `killSessionRef (${reason}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (outcome === 'refused') {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `tmux generation/claim changed while replacing session (${reason}); retry to observe the new state`,
      );
    }
    if (outcome === 'killed') {
      console.warn(`[AgentManager] ${agentId}: killed session ${sessionRef.sessionId} (${reason})`);
    } else {
      console.warn(`[AgentManager] ${agentId}: session ${sessionRef.sessionId} already gone (${reason})`);
    }
  }

  // Create-on-null only under this predicate (evaluated inside the store's serialized commit): closes the delete→recreate ABA yet keeps lazy first-allocation for config-only agents.
  private bindingInitPredicate(agentId: string, genAtEntry: number): boolean {
    return this.deletionGateOpen(agentId, genAtEntry) && this.getAgentConfig(agentId) !== undefined;
  }

  async acquireAgentForTask(
    agentId: string,
    taskId: string,
    phase: string,
    // 锁代必须由 acquire 原子交出：事后重读 claim/binding 的窗口里并发派发方可以
    // release + re-acquire 同一 agent/同一 task，读到的会是 successor 的代
    opts: { onAcquired?: (lockToken: string) => void } = {},
  ): Promise<boolean> {
    const genAtEntry = this.deletionGenerationOf(agentId);
    if (this.isDeletionInFlight(agentId)) return false;
    const cfg = this.getAgentConfig(agentId);
    if (!cfg) throw new Error(`Unknown agent: ${agentId}`);
    const state = await this.agentStore.get(agentId);
    const existingToken = state?.taskId === taskId && state
      ? await this.resolveTaskLockToken(state, taskId)
      : null;
    const sameTaskLocked = existingToken !== null;
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
    const token = reuseLock ? existingToken : await this.lockManager.acquire(agentId, taskId);
    if (!token) return false;
    const releaseAcquired = async (originalErr?: unknown): Promise<void> => {
      if (reuseLock) return;
      try {
        await this.lockManager.releaseIfOwner(agentId, taskId, token);
      } catch (releaseErr) {
        console.warn(
          `[AgentManager] acquireAgentForTask(${agentId}, ${taskId}): lock release after ` +
          `${originalErr === undefined ? 'refused commit' : 'commit failure'} itself failed:`,
          releaseErr,
        );
      }
    };
    const now = new Date().toISOString();
    let commit: Awaited<ReturnType<AgentStore['update']>>;
    try {
      commit = await this.agentStore.update(agentId, (existing) => {
        if (existing === null && !this.bindingInitPredicate(agentId, genAtEntry)) return AGENT_STORE_NOOP;
        if (!this.deletionGateOpen(agentId, genAtEntry)) return AGENT_STORE_NOOP;
        return {
          ...(existing ?? { id: agentId, projectId: cfg.projectId, updatedAt: now }),
          id: agentId,
          projectId: cfg.projectId,
          taskId,
          lockToken: token,
          ...(phase === 'code' && !sameTaskReentry ? { bootstrappingTaskId: taskId } : {}),
          updatedAt: now,
        };
      });
    } catch (err) {
      await releaseAcquired(err);
      throw err;
    }
    if (commit !== 'committed') {
      await releaseAcquired();
      return false;
    }
    opts.onAcquired?.(token);
    return true;
  }

  async releaseAgentForTask(
    agentId: string,
    expectedTaskId: string,
    mode: 'waiting' | 'idle',
    opts: {
      allowAwaitingHuman?: boolean;
      clearAwaitingHuman?: boolean;
      fromCancelCleanup?: boolean;
      expectedTask?: Pick<TaskState, 'status' | 'phase' | 'signalToken'>;
      expectedReviewDispatch?: Pick<ReviewDispatchLease, 'generation' | 'claimId' | 'signalToken'>;
      expectedPostApproveEpisode?: PostApproveEpisodeKey;
      expectedHold?: { phase: string | undefined; since: string | undefined; nonce: string | undefined };
      expectedLockToken?: string;
      // 调用方承诺把「忙碌拒绝」转成待补派登记时才置位；否则遇忙仍按原样落 hold 告警，
      // 免得终态/清理路径静默留下绑定
      deferWhenBusy?: boolean;
    } = {},
  ): Promise<boolean> {
    return this.withTaskLock(() => this.withAgentOperationLease(agentId, async () => {
      const state = await this.agentStore.get(agentId);
      if (!state) return false;
      if (state.taskId !== expectedTaskId) {
        console.warn(
          `[AgentManager] releaseAgentForTask: agent ${agentId} taskId mismatch ` +
          `(expected ${expectedTaskId}, got ${state.taskId}); skipping`,
        );
        return false;
      }
      if (opts.expectedLockToken !== undefined && state.lockToken !== opts.expectedLockToken) {
        console.warn(
          `[AgentManager] releaseAgentForTask: agent ${agentId} lock generation changed ` +
          `(binding re-acquired by a successor); skipping release`,
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
      const boundReviewDispatch = boundTask?.reviewDispatch;
      if (opts.expectedReviewDispatch
        && (!boundTask
          || !boundReviewDispatch
          || boundReviewDispatch.phase !== 'claimed'
          || boundReviewDispatch.generation !== opts.expectedReviewDispatch.generation
          || boundReviewDispatch.claimId !== opts.expectedReviewDispatch.claimId
          || boundReviewDispatch.signalToken !== opts.expectedReviewDispatch.signalToken
          || !this.gitReviewLeaseMatches(boundTask, boundReviewDispatch))) {
        console.warn(
          `[AgentManager] releaseAgentForTask: review dispatch for ${expectedTaskId} changed; skipping ${mode} transition`,
        );
        return false;
      }
      if (opts.expectedPostApproveEpisode
        && (!boundTask || !this.postApproveEpisodeMatches(boundTask, opts.expectedPostApproveEpisode))) {
        console.warn(
          `[AgentManager] releaseAgentForTask: post-approve episode for ${expectedTaskId} changed; skipping ${mode} transition`,
        );
        return false;
      }
      if (
        opts.expectedTask
        && boundTask
        && (
          boundTask.status !== opts.expectedTask.status
          || boundTask.phase !== opts.expectedTask.phase
          || boundTask.signalToken !== opts.expectedTask.signalToken
        )
      ) {
        console.warn(
          `[AgentManager] releaseAgentForTask: task ${expectedTaskId} moved past the captured pass; skipping ${mode} transition`,
        );
        return false;
      }
      if (state.status === 'awaiting_human' && !opts.allowAwaitingHuman) {
        if (!shouldReleaseHeldBinding(state, boundTask)) {
          console.warn(
            `[AgentManager] releaseAgentForTask: agent ${agentId} is awaiting_human (${state.awaitingPhase}); refusing to release`,
          );
          return false;
        }
      }
      // expectedHold 是 hold 世代快照的严格 CAS（全 undefined 表示“期望无 hold”）：
      // hold 消失（被并发 Resume 清掉）或换代同样意味着接管，不得继续释放
      const matchesExpectedHold = (binding: AgentBindingFacts): boolean => {
        const held = binding.status === 'awaiting_human';
        return (held ? binding.awaitingPhase : undefined) === opts.expectedHold!.phase
          && (held ? binding.awaitingSince : undefined) === opts.expectedHold!.since
          && (held ? binding.awaitingNonce : undefined) === opts.expectedHold!.nonce;
      };
      // 世代门前置：hold 换代时任何 pane/workdir 副作用都不得发生（末尾 CAS 只兜最后窗口）
      if (opts.expectedHold && !matchesExpectedHold(state)) {
        console.warn(
          `[AgentManager] releaseAgentForTask: agent ${agentId} hold generation changed or cleared before release; refusing`,
        );
        return false;
      }
      if (mode === 'waiting' && (!boundTask || !ACTIVE_TASK_STATUSES.has(boundTask.status))) {
        console.warn(
          `[AgentManager] releaseAgentForTask: task ${expectedTaskId} is not active; skipping waiting transition`,
        );
        return false;
      }
      const cfg = this.getAgentConfig(agentId);
      if (!cfg) return false;
      const lockToken = await this.resolveTaskLockToken(state, expectedTaskId);
      if (!lockToken) {
        console.warn(
          `[AgentManager] releaseAgentForTask: agent ${agentId} no longer owns task ${expectedTaskId}; skipping`,
        );
        return false;
      }

      const now = new Date().toISOString();

      if (mode === 'waiting') {
        let preservedNewerHold = false;
        await this.agentStore.update(agentId, (latest) => {
          if (!latest) return AGENT_STORE_NOOP;
          if (opts.clearAwaitingHuman && latest.status === 'awaiting_human') {
            // The hold-generation CAS lives inside the atomic update: a hold written after any pre-read survives.
            if (
              opts.expectedHold
              && (
                latest.awaitingPhase !== opts.expectedHold.phase
                || latest.awaitingSince !== opts.expectedHold.since
                || latest.awaitingNonce !== opts.expectedHold.nonce
              )
            ) {
              preservedNewerHold = true;
              return AGENT_STORE_NOOP;
            }
            const cleared: AgentBindingFacts = {
              id: latest.id,
              projectId: latest.projectId,
              updatedAt: now,
              ...(latest.taskId !== undefined ? { taskId: latest.taskId } : {}),
              ...(latest.lockToken !== undefined ? { lockToken: latest.lockToken } : {}),
              ...(latest.paneId !== undefined ? { paneId: latest.paneId } : {}),
              ...(latest.workdir !== undefined ? { workdir: latest.workdir } : {}),
              ...(latest.startedAt !== undefined ? { startedAt: latest.startedAt } : {}),
              ...(latest.creationToken !== undefined ? { creationToken: latest.creationToken } : {}),
              // Release voids the open question: strip the watermark, bump the epoch so
              // any in-flight/queued commit of the old generation fences server-side.
              needInput: { epoch: (latest.needInput?.epoch ?? 0) + 1 },
            };
            return cleared;
          }
          return {
            ...latest,
            needInput: { epoch: (latest.needInput?.epoch ?? 0) + 1 },
            updatedAt: now,
          };
        });
        if (preservedNewerHold) {
          console.warn(
            `[AgentManager] releaseAgentForTask: agent ${agentId} holds a newer generation than the captured one; keeping the hold`,
          );
          return false;
        }
        this.clearNeedInputRetryFor(agentId, expectedTaskId);
        return true;
      }

      let sessionConfirmedAbsent = false;
      if (state.workdir) {
        const releaseWorkdir = state.workdir;
        const runner = this.createRunnerFor(cfg);
        const tmux = new TmuxManager(runner);
        const holdMatchesExpected = (binding: AgentBindingFacts): boolean =>
          !opts.expectedHold || matchesExpectedHold(binding);
        const hold = async (reason: string): Promise<boolean> => {
          const latest = await this.agentStore.get(agentId);
          if (
            !latest
            || latest.taskId !== expectedTaskId
            || latest.lockToken !== lockToken
            || !await this.lockManager.isOwner(agentId, expectedTaskId, lockToken)
          ) {
            return false;
          }
          // 释放中被写入的新 hold（如 ack_unknown）比 cleanup 失败信息更关键，不得覆盖
          if (!holdMatchesExpected(latest)) {
            console.warn(
              `[AgentManager] releaseAgentForTask: agent ${agentId} hold generation changed during release; not overwriting with branch-cleanup-pending`,
            );
            return false;
          }
          const pendingAt = new Date().toISOString();
          if (boundTask && cfg.role === 'dev') {
            boundTask.branchCleanupPending = { agentId, reason, updatedAt: pendingAt };
            boundTask.updatedAt = pendingAt;
            await this.taskStore.set(boundTask);
          }
          let wrote = false;
          await this.agentStore.update(agentId, (latest2) => {
            if (!latest2 || latest2.taskId !== expectedTaskId || latest2.lockToken !== lockToken) {
              return AGENT_STORE_NOOP;
            }
            if (!holdMatchesExpected(latest2)) return AGENT_STORE_NOOP;
            wrote = true;
            return {
              ...latest2,
              status: 'awaiting_human',
              awaitingPhase: 'branch-cleanup-pending',
              awaitingReason: reason,
              awaitingSince: pendingAt,
              updatedAt: pendingAt,
            };
          });
          if (!wrote) {
            console.warn(
              `[AgentManager] releaseAgentForTask: agent ${agentId} branch-cleanup-pending hold not written (binding or hold changed)`,
            );
            return false;
          }
          await this.emitIntervention(state.projectId, agentId, expectedTaskId, {
            phase: 'branch-cleanup-pending',
            reason,
          });
          return false;
        };
        try {
          await this.assertTaskGeneration(agentId, expectedTaskId, lockToken, releaseWorkdir);
          const runtime = await this.inspectReleaseRuntime(tmux, agentId);
          if (runtime.kind === 'hold') return hold(runtime.reason);
          await this.assertTaskGeneration(agentId, expectedTaskId, lockToken, releaseWorkdir);
          if (runtime.kind === 'pane') {
            if (state.paneId !== runtime.pane.paneId) {
              await this.agentStore.update(agentId, (latest) => {
                if (
                  !latest
                  || latest.taskId !== expectedTaskId
                  || latest.lockToken !== lockToken
                  || latest.workdir !== releaseWorkdir
                ) {
                  return AGENT_STORE_NOOP;
                }
                return { ...latest, paneId: runtime.pane.paneId, updatedAt: new Date().toISOString() };
              });
              const refreshed = await this.assertTaskGeneration(
                agentId,
                expectedTaskId,
                lockToken,
                releaseWorkdir,
              );
              if (refreshed.paneId !== runtime.pane.paneId) {
                throw new Error(`Agent ${agentId} runtime pane changed during release; operation aborted`);
              }
            }
            await this.waitForReplPromptReady(
              tmux,
              runtime.pane,
              agentRuntimeKindFor(cfg),
              this.cleanComposerWaitMs,
            );
          } else {
            sessionConfirmedAbsent = true;
          }
          await this.assertTaskGeneration(agentId, expectedTaskId, lockToken, releaseWorkdir);
          // 仍重验持久化世代，防护当前进程租约之外的状态写入。
          if (opts.expectedHold) {
            const beforeBranchOps = await this.agentStore.get(agentId);
            if (!beforeBranchOps || !matchesExpectedHold(beforeBranchOps)) {
              console.warn(
                `[AgentManager] releaseAgentForTask: agent ${agentId} hold generation changed before checkout cleanup; aborting release`,
              );
              return false;
            }
          }
          if (cfg.role === 'dev' && boundTask) {
            const branches = new BranchManager(runner);
            const cleanup = await branches.cleanupTaskBranch(releaseWorkdir, {
              taskId: boundTask.id,
              taskBranch: boundTask.branch,
              branchCreatedByBaxian: boundTask.branchCreatedByBaxian,
            }, () => this.assertTaskGeneration(
              agentId,
              expectedTaskId,
              lockToken,
              releaseWorkdir,
            ).then(() => undefined));
            let cleanupStateChanged = false;
            if (cleanup.status === 'pending') {
              if (
                boundTask.branchCleanupPending?.agentId !== agentId
                || boundTask.branchCleanupPending.reason !== cleanup.reason
                || boundTask.branchCleanupSkipped !== undefined
              ) {
                boundTask.branchCleanupPending = {
                  agentId,
                  reason: cleanup.reason,
                  updatedAt: new Date().toISOString(),
                };
                delete boundTask.branchCleanupSkipped;
                cleanupStateChanged = true;
              }
            } else if (cleanup.status === 'skipped') {
              if (
                boundTask.branchCleanupSkipped?.agentId !== agentId
                || boundTask.branchCleanupSkipped.reason !== cleanup.reason
                || boundTask.branchCleanupPending !== undefined
              ) {
                boundTask.branchCleanupSkipped = {
                  agentId,
                  reason: cleanup.reason,
                  updatedAt: new Date().toISOString(),
                };
                delete boundTask.branchCleanupPending;
                cleanupStateChanged = true;
              }
            } else {
              if (boundTask.branchCleanupPending?.agentId === agentId) {
                delete boundTask.branchCleanupPending;
                cleanupStateChanged = true;
              }
              if (boundTask.branchCleanupSkipped?.agentId === agentId) {
                delete boundTask.branchCleanupSkipped;
                cleanupStateChanged = true;
              }
              if (cleanup.remoteTipSha) {
                boundTask.branchLocalCleaned = {
                  remoteTipSha: cleanup.remoteTipSha,
                  updatedAt: new Date().toISOString(),
                };
                cleanupStateChanged = true;
              }
            }
            if (cleanupStateChanged) {
              boundTask.updatedAt = new Date().toISOString();
              await this.taskStore.set(boundTask);
            }
            if (cleanup.status !== 'deleted') await branches.parkOnDefaultDetached(releaseWorkdir);
          } else {
            await new BranchManager(runner).parkOnDefaultDetached(releaseWorkdir);
          }
          await this.assertTaskGeneration(agentId, expectedTaskId, lockToken, releaseWorkdir);
        } catch (err) {
          // REPL 忙碌不是清理失败：pane 完好、绑定未动、非 dev 无分支凭据可留。落
          // branch-cleanup-pending（不在可恢复白名单）会把常态忙碌变成永久 hold（#558 验收 1），
          // 故拒绝释放而不落 hold，由调用方按「仍绑定且未 hold」判定重新排队本 pass
          if (opts.deferWhenBusy && err instanceof ReplNotReadyError && cfg.role !== 'dev') {
            console.warn(
              `[AgentManager] releaseAgentForTask: agent ${agentId} REPL is busy; refusing release without a hold ` +
              `(the pass can be re-queued): ${err.message}`,
            );
            return false;
          }
          const reason = err instanceof DirtyWorkdirError
            ? err.message
            : `checkout cleanup failed: ${err instanceof Error ? err.message : String(err)}`;
          return hold(reason);
        }
      }
      if (state.workdir) {
        await this.assertTaskGeneration(agentId, expectedTaskId, lockToken, state.workdir);
      } else {
        await this.assertTaskLockOwner(agentId, expectedTaskId, lockToken);
      }
      let holdGenerationChanged = false;
      await this.agentStore.update(agentId, (existing) => {
        if (!existing) return AGENT_STORE_NOOP;
        if (
          existing.taskId !== expectedTaskId
          || existing.lockToken !== lockToken
          || (state.workdir !== undefined && existing.workdir !== state.workdir)
        ) {
          return AGENT_STORE_NOOP;
        }
        // 世代 CAS 在原子写入内判定：预读后被重写或清除的 hold 都不得被这次释放清掉
        if (opts.expectedHold && !matchesExpectedHold(existing)) {
          holdGenerationChanged = true;
          return AGENT_STORE_NOOP;
        }
        return {
          id: existing.id,
          projectId: existing.projectId,
          ...(existing.workdir !== undefined ? { workdir: existing.workdir } : {}),
          ...(!sessionConfirmedAbsent && existing.paneId !== undefined ? { paneId: existing.paneId } : {}),
          ...(existing.creationToken !== undefined ? { creationToken: existing.creationToken } : {}),
          needInput: { epoch: (existing.needInput?.epoch ?? 0) + 1 },
          updatedAt: now,
        };
      });
      if (holdGenerationChanged) {
        console.warn(
          `[AgentManager] releaseAgentForTask: agent ${agentId} hold generation changed during release; keeping the hold`,
        );
        return false;
      }
      this.clearNeedInputRetryFor(agentId, expectedTaskId);
      return this.lockManager.releaseIfOwner(agentId, expectedTaskId, lockToken);
    }));
  }

  private async clearBranchLocalCleaned(taskId: string): Promise<void> {
    await this.withTaskLock(async () => {
      const fresh = await this.taskStore.get(taskId);
      if (!fresh?.branchLocalCleaned) return;
      delete fresh.branchLocalCleaned;
      fresh.updatedAt = new Date().toISOString();
      await this.taskStore.set(fresh);
    }).catch(err => {
      console.warn(`[AgentManager] clearing branchLocalCleaned(${taskId}) failed:`, err);
    });
  }

  private async releaseAgentIfBound(
    agentId: string,
    expectedTaskId: string,
    opts?: {
      allowAwaitingHuman?: boolean;
      expectedHold?: { phase: string | undefined; since: string | undefined; nonce: string | undefined };
    },
  ): Promise<boolean> {
    const state = await this.agentStore.get(agentId);
    if (state?.taskId !== expectedTaskId) return true;
    const released = opts
      ? await this.releaseAgentForTask(agentId, expectedTaskId, 'idle', opts)
      : await this.releaseAgentForTask(agentId, expectedTaskId, 'idle');
    if (released) return true;
    return (await this.agentStore.get(agentId))?.taskId !== expectedTaskId;
  }

  async reconcileTaskBranches(): Promise<void> {
    const tasks = await this.taskStore.list();
    const terminalByBranch = new Map(
      tasks
        .filter(task =>
          task.branchCreatedByBaxian === true
          && TERMINAL_STATUSES.includes(task.status)
          && task.branch === `${BRANCH_PREFIX}${task.id}`
          && task.branchCleanupSkipped === undefined,
        )
        .map(task => [task.branch, task]),
    );
    const owner = 'maintenance:branch-reconcile';
    const persistCleanup = async (
      task: TaskState,
      agentId: string,
      cleanup: Awaited<ReturnType<BranchManager['cleanupTaskBranch']>>,
    ): Promise<void> => {
      await this.withTaskLock(async () => {
        const latest = await this.taskStore.get(task.id);
        if (
          !latest
          || latest.branch !== task.branch
          || latest.branchCreatedByBaxian !== true
          || !TERMINAL_STATUSES.includes(latest.status)
        ) return;
        const now = new Date().toISOString();
        let changed = false;
        if (cleanup.status === 'pending') {
          if (
            latest.branchCleanupPending?.agentId !== agentId
            || latest.branchCleanupPending.reason !== cleanup.reason
            || latest.branchCleanupSkipped !== undefined
          ) {
            latest.branchCleanupPending = { agentId, reason: cleanup.reason, updatedAt: now };
            delete latest.branchCleanupSkipped;
            changed = true;
          }
        } else if (cleanup.status === 'skipped') {
          if (
            latest.branchCleanupSkipped?.agentId !== agentId
            || latest.branchCleanupSkipped.reason !== cleanup.reason
            || latest.branchCleanupPending !== undefined
          ) {
            latest.branchCleanupSkipped = { agentId, reason: cleanup.reason, updatedAt: now };
            delete latest.branchCleanupPending;
            changed = true;
          }
        } else {
          if (latest.branchCleanupPending !== undefined) {
            delete latest.branchCleanupPending;
            changed = true;
          }
          if (latest.branchCleanupSkipped !== undefined) {
            delete latest.branchCleanupSkipped;
            changed = true;
          }
        }
        if (!changed) return;
        latest.updatedAt = now;
        await this.taskStore.set(latest);
      });
    };

    for (const cfg of this.agentIndex.values()) {
      if (cfg.role !== 'dev') continue;
      const candidateTasks = [...terminalByBranch.values()].filter(task =>
        task.agentId === cfg.id || task.branchCleanupPending?.agentId === cfg.id,
      );
      if (candidateTasks.length === 0) continue;
      const candidateByBranch = new Map(candidateTasks.map(task => [task.branch!, task]));
      // Pin the incarnation before the first state/workdir/refs snapshot so a DELETE→same-id recreate (possibly a different workdir) in the read→gate window is rejected.
      const genAtEntry = this.deletionGenerationOf(cfg.id);
      const state = await this.agentStore.get(cfg.id);
      if (!state || !canDispatchWithBinding(state)) continue;
      const workdir = state.workdir ?? cfg.workdir;
      if (!workdir) continue;
      const runner = this.createRunnerFor(cfg);
      const branches = new BranchManager(runner);
      let refs: string[];
      try {
        refs = await branches.listLocalTaskRefs(workdir);
      } catch (err) {
        console.warn(
          `[AgentManager] reconcileTaskBranches(${cfg.id}) local ref preflight failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (!refs.some(ref => candidateByBranch.has(ref.slice('refs/heads/'.length)))) continue;
      if (this.isDeletionInFlight(cfg.id)) continue;
      const token = await this.lockManager.acquire(cfg.id, owner);
      if (!token) continue;
      const cleanupResults: Array<{
        task: TaskState;
        cleanup: Awaited<ReturnType<BranchManager['cleanupTaskBranch']>>;
      }> = [];
      try {
        if (!this.deletionGateOpen(cfg.id, genAtEntry)) continue;
        const lockedState = await this.agentStore.get(cfg.id);
        if (!lockedState || !canDispatchWithBinding(lockedState)) continue;
        if (!(await this.lockManager.isOwner(cfg.id, owner, token))) continue;
        refs = await branches.listLocalTaskRefs(workdir);
        refs = refs.filter(ref => candidateByBranch.has(ref.slice('refs/heads/'.length)));
        if (refs.length === 0) continue;
        const tmux = new TmuxManager(runner);
        if (await tmux.hasSession(cfg.id)) {
          const pane = await this.resolveClaimedPane(tmux, cfg.id, lockedState.paneId ?? undefined);
          await this.waitForReplPromptReady(
            tmux,
            pane,
            agentRuntimeKindFor(cfg),
            this.cleanComposerWaitMs,
          );
        }
        if (!(await this.lockManager.isOwner(cfg.id, owner, token))) continue;
        for (const actualRef of refs) {
          const branch = actualRef.slice('refs/heads/'.length);
          const task = candidateByBranch.get(branch);
          if (!task) continue;
          const cleanup = await branches.cleanupTaskBranch(workdir, {
            taskId: task.id,
            taskBranch: task.branch,
            branchCreatedByBaxian: task.branchCreatedByBaxian,
          }, () => this.assertTaskLockOwner(cfg.id, owner, token));
          cleanupResults.push({ task, cleanup });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof DirtyWorkdirError) {
          await this.markAwaitingHuman(cfg.id, 'dirty-workdir', message, { expectedTaskId: null });
        } else if (err instanceof ReplNotReadyError || message.includes('stayed busy past')) {
          for (const actualRef of refs) {
            const task = candidateByBranch.get(actualRef.slice('refs/heads/'.length));
            if (!task) continue;
            cleanupResults.push({
              task,
              cleanup: {
                status: 'pending',
                reason: `runtime is not idle; local branch cleanup deferred: ${message}`,
              },
            });
          }
        } else {
          console.warn(`[AgentManager] reconcileTaskBranches(${cfg.id}) failed: ${message}`);
          await this.recordError({
            agentId: cfg.id,
            projectId: cfg.projectId,
            operation: 'branch-reconcile',
            reason: 'BRANCH_RECONCILE_FAILED',
            message,
            observation: { phase: 'branch-reconcile' },
            recommendation: 'Verify the Workdir and remote, then let the next reconciliation retry.',
          });
        }
      } finally {
        await this.lockManager.releaseIfOwner(cfg.id, owner, token);
      }
      for (const result of cleanupResults) {
        await persistCleanup(result.task, cfg.id, result.cleanup);
      }
    }
  }

  // ---- need-input watermark: epoch-fenced monotonic persistence + retry convergence ----

  private readonly needInputRetry = new Map<string, { askSeq: number; answeredSeq: number }>();
  private readonly needInputRetryInFlight = new Set<string>();
  private readonly gitReviewQaConfigAlerted = new Set<string>();
  // Watermark writes currently in the store chain. A restore bump snapshots these along
  // with the queue: an answer whose write has not settled yet would otherwise be invisible
  // to the migration and its error-enqueue would land after the arm already cleared the
  // queue — deleting the only proof the user answered.
  private readonly needInputWritesInFlight = new Map<number, NeedInputCommitIntent>();
  private needInputWriteSeq = 0;
  // Serializes the probe→bump→queue-clear section of concurrent arms for one
  // (agentId, taskId): without it a stale replay probed before a successor's bump can
  // itself bump afterwards, ghost-fencing the installed successor. All locked steps are
  // bounded (memory probe + one store update); subscribe stays outside the lock.
  private readonly needInputArmLocks = new Map<string, Promise<void>>();
  private needInputRetryTimer: ReturnType<typeof setInterval> | null = null;

  private needInputRetryKey(agentId: string, taskId: string, epoch: number): string {
    return `${agentId} ${taskId} ${epoch}`;
  }

  private parseNeedInputRetryKey(key: string): { agentId: string; taskId: string; epoch: number } | null {
    const [agentId, taskId, epochRaw] = key.split(' ');
    if (!agentId || !taskId || epochRaw === undefined) return null;
    const epoch = Number.parseInt(epochRaw, 10);
    if (!Number.isFinite(epoch)) return null;
    return { agentId, taskId, epoch };
  }

  // Standard commit entry: one agentStore.update, NEVER called from inside another
  // updater (the store's per-id chain is non-reentrant).
  // The ledger entry lives until the result is fully handed over — an error is IN the
  // retry queue before deregistration, in the same synchronous continuation. Splitting
  // those two across promise jobs would open a window where neither the ledger nor the
  // queue holds the intent and a concurrent restore snapshot loses the answer.
  async commitNeedInputWatermark(intent: NeedInputCommitIntent): Promise<NeedInputCommitResult> {
    const writeId = ++this.needInputWriteSeq;
    this.needInputWritesInFlight.set(writeId, intent);
    const key = this.needInputRetryKey(intent.agentId, intent.taskId, intent.epoch);
    try {
      const result = await this.writeNeedInputWatermark(intent);
      if (result === 'error') {
        this.enqueueNeedInputRetry(key, intent.askSeq, intent.answeredSeq);
      } else {
        this.settleNeedInputRetry(key, intent.askSeq, intent.answeredSeq, result);
      }
      return result;
    } catch (err) {
      this.enqueueNeedInputRetry(key, intent.askSeq, intent.answeredSeq);
      throw err;
    } finally {
      this.needInputWritesInFlight.delete(writeId);
    }
  }

  private async writeNeedInputWatermark(intent: NeedInputCommitIntent): Promise<NeedInputCommitResult> {
    let outcome: NeedInputCommitResult = 'fenced';
    try {
      await this.agentStore.update(intent.agentId, (existing) => {
        if (!existing || existing.taskId !== intent.taskId) {
          outcome = 'fenced';
          return AGENT_STORE_NOOP;
        }
        const cur = existing.needInput;
        if ((cur?.epoch ?? 0) !== intent.epoch) {
          outcome = 'fenced';
          return AGENT_STORE_NOOP;
        }
        const askSeq = Math.max(cur?.askSeq ?? 0, intent.askSeq);
        const answeredSeq = Math.max(cur?.answeredSeq ?? 0, intent.answeredSeq);
        outcome = 'ok';
        if (cur && (cur.askSeq ?? 0) === askSeq && (cur.answeredSeq ?? 0) === answeredSeq) {
          return AGENT_STORE_NOOP;
        }
        const now = new Date().toISOString();
        const at = askSeq > answeredSeq ? (cur?.at ?? now) : undefined;
        return {
          ...existing,
          needInput: {
            epoch: intent.epoch, askSeq, answeredSeq,
            ...(at !== undefined ? { at } : {}),
          },
          updatedAt: now,
        };
      });
    } catch (err) {
      console.warn(
        `[AgentManager] needInput watermark write failed (agent=${intent.agentId} epoch=${intent.epoch}):`,
        err,
      );
      return 'error';
    }
    return outcome;
  }

  private enqueueNeedInputRetry(key: string, askSeq: number, answeredSeq: number): void {
    const cur = this.needInputRetry.get(key);
    this.needInputRetry.set(key, {
      askSeq: Math.max(cur?.askSeq ?? 0, askSeq),
      answeredSeq: Math.max(cur?.answeredSeq ?? 0, answeredSeq),
    });
    this.ensureNeedInputRetryTimer();
  }

  // ok deletes only when the queued item is still covered by what was written
  // (a concurrent edge may have raised it mid-flight); fenced is terminal either way.
  private settleNeedInputRetry(
    key: string,
    wroteAskSeq: number,
    wroteAnsweredSeq: number,
    result: 'ok' | 'fenced',
  ): void {
    const cur = this.needInputRetry.get(key);
    if (!cur) return;
    if (result === 'fenced' || (cur.askSeq <= wroteAskSeq && cur.answeredSeq <= wroteAnsweredSeq)) {
      this.needInputRetry.delete(key);
      this.ensureNeedInputRetryTimer();
    }
  }

  private clearNeedInputRetryFor(agentId: string, taskId: string): void {
    for (const key of [...this.needInputRetry.keys()]) {
      const parsed = this.parseNeedInputRetryKey(key);
      if (parsed && parsed.agentId === agentId && parsed.taskId === taskId) {
        this.needInputRetry.delete(key);
      }
    }
    this.ensureNeedInputRetryTimer();
  }

  private ensureNeedInputRetryTimer(): void {
    if (this.needInputRetry.size === 0) {
      if (this.needInputRetryTimer) {
        clearInterval(this.needInputRetryTimer);
        this.needInputRetryTimer = null;
      }
      return;
    }
    if (this.needInputRetryTimer) return;
    this.needInputRetryTimer = setInterval(() => {
      void this.needInputRetryPass();
    }, this.needInputRetryIntervalMs);
    this.needInputRetryTimer.unref?.();
  }

  private async needInputRetryPass(): Promise<void> {
    for (const [key, snapshot] of [...this.needInputRetry.entries()]) {
      if (this.needInputRetryInFlight.has(key)) continue;
      const parsed = this.parseNeedInputRetryKey(key);
      if (!parsed) {
        this.needInputRetry.delete(key);
        continue;
      }
      this.needInputRetryInFlight.add(key);
      try {
        const result = await this.writeNeedInputWatermark({
          agentId: parsed.agentId,
          taskId: parsed.taskId,
          epoch: parsed.epoch,
          askSeq: snapshot.askSeq,
          answeredSeq: snapshot.answeredSeq,
        });
        if (result !== 'error') {
          this.settleNeedInputRetry(key, snapshot.askSeq, snapshot.answeredSeq, result);
        }
      } finally {
        this.needInputRetryInFlight.delete(key);
      }
    }
    this.ensureNeedInputRetryTimer();
  }

  private collectSameEpochNeedInput(
    agentId: string,
    taskId: string,
    epoch: number,
  ): { askSeq: number; answeredSeq: number } | null {
    let owed: { askSeq: number; answeredSeq: number } | null = null;
    const merge = (wm: { askSeq: number; answeredSeq: number }): void => {
      owed = {
        askSeq: Math.max(owed?.askSeq ?? 0, wm.askSeq),
        answeredSeq: Math.max(owed?.answeredSeq ?? 0, wm.answeredSeq),
      };
    };
    for (const [key, wm] of this.needInputRetry) {
      const parsed = this.parseNeedInputRetryKey(key);
      if (!parsed || parsed.agentId !== agentId || parsed.taskId !== taskId) continue;
      if (parsed.epoch === epoch) merge(wm);
    }
    for (const intent of this.needInputWritesInFlight.values()) {
      if (intent.agentId !== agentId || intent.taskId !== taskId) continue;
      if (intent.epoch === epoch) merge(intent);
    }
    return owed;
  }

  // Only the generation this arm directly succeeds (bumps are +1 and serialized per key).
  // Anything older was already superseded — a fresh arm in between stripped its question
  // on purpose, and transplanting it would relight a prompt nobody asked.
  private collectPredecessorNeedInputDelta(
    agentId: string,
    taskId: string,
    epoch: number,
  ): { askSeq: number; answeredSeq: number } | null {
    let delta: { askSeq: number; answeredSeq: number } | null = null;
    const merge = (wm: { askSeq: number; answeredSeq: number }): void => {
      delta = {
        askSeq: Math.max(delta?.askSeq ?? 0, wm.askSeq),
        answeredSeq: Math.max(delta?.answeredSeq ?? 0, wm.answeredSeq),
      };
    };
    for (const [key, wm] of this.needInputRetry) {
      const parsed = this.parseNeedInputRetryKey(key);
      if (!parsed || parsed.agentId !== agentId || parsed.taskId !== taskId) continue;
      if (parsed.epoch === epoch - 1) merge(wm);
    }
    for (const intent of this.needInputWritesInFlight.values()) {
      if (intent.agentId !== agentId || intent.taskId !== taskId) continue;
      if (intent.epoch === epoch - 1) merge(intent);
    }
    return delta;
  }

  private async withNeedInputArmLock<T>(
    agentId: string,
    taskId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = `${agentId} ${taskId}`;
    const prev = this.needInputArmLocks.get(key) ?? Promise.resolve();
    const run = prev.then(fn);
    const settled = run.then(() => undefined, () => undefined);
    this.needInputArmLocks.set(key, settled);
    void settled.finally(() => {
      if (this.needInputArmLocks.get(key) === settled) this.needInputArmLocks.delete(key);
    });
    return run;
  }

  // 'restore' must also merge queued retry seqs of the CURRENT persisted epoch: after
  // session-gone the queue can hold the only proof an answer happened (the entry is
  // gone, so needInputInherit has nothing to merge), and the arm clears the queue.
  private async bumpNeedInputEpochForArm(
    agentId: string,
    taskId: string,
    mode: 'fresh' | 'restore',
  ): Promise<{
    wm: { epoch: number; askSeq: number; answeredSeq: number } | null;
    bumped: boolean;
  }> {
    // Contributions are collected INSIDE the updater: it runs when the store chain
    // reaches this bump, so an answer whose commit started while the bump was queued
    // (registered in the ledger, or already error-queued) is still visible. A snapshot
    // taken at call time would miss exactly that window.
    const collectContributions = (): Map<number, { askSeq: number; answeredSeq: number }> => {
      const queued = new Map<number, { askSeq: number; answeredSeq: number }>();
      if (mode !== 'restore') return queued;
      const mergeContribution = (epoch: number, wm: { askSeq: number; answeredSeq: number }): void => {
        const cur = queued.get(epoch);
        queued.set(epoch, {
          askSeq: Math.max(cur?.askSeq ?? 0, wm.askSeq),
          answeredSeq: Math.max(cur?.answeredSeq ?? 0, wm.answeredSeq),
        });
      };
      for (const [key, qwm] of this.needInputRetry) {
        const parsed = this.parseNeedInputRetryKey(key);
        if (!parsed || parsed.agentId !== agentId || parsed.taskId !== taskId) continue;
        mergeContribution(parsed.epoch, qwm);
      }
      for (const intent of this.needInputWritesInFlight.values()) {
        if (intent.agentId !== agentId || intent.taskId !== taskId) continue;
        mergeContribution(intent.epoch, intent);
      }
      return queued;
    };
    let wm: { epoch: number; askSeq: number; answeredSeq: number } | null = null;
    try {
      await this.agentStore.update(agentId, (existing) => {
        if (!existing || existing.taskId !== taskId) return AGENT_STORE_NOOP;
        const cur = existing.needInput;
        const contrib = collectContributions().get(cur?.epoch ?? 0);
        const epoch = (cur?.epoch ?? 0) + 1;
        const askSeq = mode === 'restore' ? Math.max(cur?.askSeq ?? 0, contrib?.askSeq ?? 0) : 0;
        const answeredSeq = mode === 'restore'
          ? Math.max(cur?.answeredSeq ?? 0, contrib?.answeredSeq ?? 0)
          : 0;
        wm = { epoch, askSeq, answeredSeq };
        const at = askSeq > answeredSeq ? (cur?.at ?? new Date().toISOString()) : undefined;
        return {
          ...existing,
          needInput: {
            epoch, askSeq, answeredSeq,
            ...(at !== undefined ? { at } : {}),
          },
          updatedAt: new Date().toISOString(),
        };
      });
    } catch (err) {
      console.warn(`[AgentManager] needInput epoch bump failed (agent=${agentId} task=${taskId}):`, err);
      // Fall back to the persisted watermark for a restore: without it the entry would
      // start at 0/0 and swallow the answer to a question that is still open in the
      // store, leaving the badge lit forever. No bump means no generation advance —
      // the caller must not treat this as a fresh generation.
      if (mode === 'restore') {
        try {
          const cur = await this.agentStore.get(agentId);
          if (cur?.taskId === taskId && cur.needInput) {
            // Same-generation intents still owed to the store hold questions the
            // persisted watermark has not caught up with; merge them in.
            const owed = this.collectSameEpochNeedInput(agentId, taskId, cur.needInput.epoch);

            return {
              wm: {
                epoch: cur.needInput.epoch,
                askSeq: Math.max(cur.needInput.askSeq ?? 0, owed?.askSeq ?? 0),
                answeredSeq: Math.max(cur.needInput.answeredSeq ?? 0, owed?.answeredSeq ?? 0),
              },
              bumped: false,
            };
          }
        } catch (readErr) {
          console.warn(`[AgentManager] needInput watermark read-back failed (agent=${agentId}):`, readErr);
        }
      }
      return { wm: null, bumped: false };
    }
    return { wm, bumped: wm !== null };
  }

  // Single entry for arming phase-signal watches — every path must flow through the
  // epoch bump, or stale-generation commits could survive the re-arm.
  private async startPhaseSignalWatch(
    args: Omit<PhaseSignalWatcherStartArgs, 'needInput' | 'needInputInherit'>
      & { needInputMode?: 'fresh' | 'restore' },
  ): Promise<boolean> {
    if (!this.phaseSignalWatcher) return true;
    const { needInputMode, ...rest } = args;
    const mode = needInputMode ?? 'restore';
    const watcher = this.phaseSignalWatcher;
    // Claim ownership before bumping: a rejected arm must not bump (it would fence the
    // owner), and the claim keeps this arm visible to later probes while it subscribes.
    const gateResult = await this.withNeedInputArmLock(args.agentId, args.taskId, async () => {
      const claim = watcher.claimArm?.({
        taskId: args.taskId,
        agentId: args.agentId,
        token: args.token,
        ...(args.onlyReplaceOwnToken !== undefined ? { onlyReplaceOwnToken: args.onlyReplaceOwnToken } : {}),
        ...(args.replaceFromToken !== undefined ? { replaceFromToken: args.replaceFromToken } : {}),
        ...(args.replaceScope !== undefined ? { replaceScope: args.replaceScope } : {}),
      });
      if (claim === null) return 'rejected' as const;
      const bump = await this.bumpNeedInputEpochForArm(args.agentId, args.taskId, mode);
      // Only a real generation advance may drop the queue: same-generation intents
      // (bump failed, watermark read back) are still owed to the store.
      if (bump.bumped) this.clearNeedInputRetryFor(args.agentId, args.taskId);
      return { ...bump, claim };
    });
    if (gateResult === 'rejected') return false;
    const { wm, bumped, claim } = gateResult;
    // Same synchronous section as the bump result: old-generation answers must not slip
    // between the bump and the handoff (start() migrates the predecessor synchronously).
    if (wm !== null && bumped && mode === 'restore') {
      const delta = this.collectPredecessorNeedInputDelta(args.agentId, args.taskId, wm.epoch);
      if (delta) {
        void this.commitNeedInputWatermark({
          agentId: args.agentId,
          taskId: args.taskId,
          epoch: wm.epoch,
          askSeq: Math.max(delta.askSeq, wm.askSeq),
          answeredSeq: Math.max(delta.answeredSeq, wm.answeredSeq),
        });
      }
    }
    // wm === null (no binding / store error): arm anyway with badge commits disabled —
    // the badge is display-only, the signal watch drives task progress.
    try {
      return await watcher.start({
        ...rest,
        ...(claim != null ? { armClaimId: claim } : {}),
        // Inherit is about restore semantics, not about having a generation: a degraded
        // restore still has to keep the predecessor's pending question in memory.
        needInputInherit: mode === 'restore',
        ...(wm !== null ? { needInput: wm } : {}),
      });
    } finally {
      watcher.releaseArm?.(claim);
    }
  }

  // Web-fallback confirm: settles the newest known question (store ∪ retry queue) as
  // answered in ONE store update — usable when no watch entry exists (pre-recovery,
  // arm failure, post-stop). Queue contributions are snapshotted synchronously; the
  // updater derives everything else from `existing`, so no nested store calls.
  private async confirmNeedInputAnswered(agentId: string): Promise<void> {
    const queueAsk = new Map<string, number>();
    for (const [key, wm] of this.needInputRetry) {
      const parsed = this.parseNeedInputRetryKey(key);
      if (!parsed || parsed.agentId !== agentId) continue;
      const mapKey = `${parsed.taskId} ${parsed.epoch}`;
      queueAsk.set(mapKey, Math.max(queueAsk.get(mapKey) ?? 0, wm.askSeq));
    }
    for (const intent of this.needInputWritesInFlight.values()) {
      if (intent.agentId !== agentId) continue;
      const mapKey = `${intent.taskId} ${intent.epoch}`;
      queueAsk.set(mapKey, Math.max(queueAsk.get(mapKey) ?? 0, intent.askSeq));
    }
    let settled: { taskId: string; epoch: number; askSeq: number } | null = null;
    try {
      await this.agentStore.update(agentId, (existing) => {
        if (!existing?.taskId) return AGENT_STORE_NOOP;
        const cur = existing.needInput;
        const epoch = cur?.epoch ?? 0;
        const qAsk = queueAsk.get(`${existing.taskId} ${epoch}`) ?? 0;
        const askSeq = Math.max(cur?.askSeq ?? 0, qAsk);
        const answeredSeq = Math.max(cur?.answeredSeq ?? 0, askSeq);
        settled = { taskId: existing.taskId, epoch, askSeq };
        if (cur && (cur.askSeq ?? 0) === askSeq && (cur.answeredSeq ?? 0) === answeredSeq && cur.at === undefined) {
          return AGENT_STORE_NOOP;
        }
        if (!cur && askSeq === 0) return AGENT_STORE_NOOP;
        return {
          ...existing,
          needInput: {
            epoch, askSeq, answeredSeq,
          },
          updatedAt: new Date().toISOString(),
        };
      });
    } catch (err) {
      console.warn(`[AgentManager] confirmNeedInputAnswered(${agentId}) failed:`, err);
      if (settled !== null) {
        const s: { taskId: string; epoch: number; askSeq: number } = settled;
        this.enqueueNeedInputRetry(this.needInputRetryKey(agentId, s.taskId, s.epoch), s.askSeq, s.askSeq);
      }
      return;
    }
    if (settled !== null) {
      const s: { taskId: string; epoch: number; askSeq: number } = settled;
      this.settleNeedInputRetry(this.needInputRetryKey(agentId, s.taskId, s.epoch), s.askSeq, s.askSeq, 'ok');
    }
  }

  // The user typed into the agent's terminal — its open question counts as answered.
  // The store fallback runs only when no watch entry exists (pre-recovery, arm failure,
  // post-stop): with a live entry it would race the entry's in-flight writes and could
  // confirm an ask that arrived after this input.
  async notifyHumanTerminalInput(agentId: string): Promise<void> {
    // Rearm first: it settles entry state synchronously, so a question printed during
    // this call cannot be confirmed by mistake. The binding read only decides whether a
    // watcher of the CURRENT task took the input — a leftover entry of a finished task
    // must not suppress the store fallback.
    const handled = await this.phaseSignalWatcher?.rearmNeedInput(agentId);
    let taskId: string | undefined;
    try {
      taskId = (await this.agentStore.get(agentId))?.taskId;
    } catch (err) {
      console.warn(`[AgentManager] notifyHumanTerminalInput(${agentId}) binding read failed:`, err);
    }
    if (taskId === undefined || !handled?.has(taskId)) await this.confirmNeedInputAnswered(agentId);
  }

  async clearAwaitingHuman(
    agentId: string,
    opts: {
      expectedTaskId?: string;
      expectedHold?: { phase?: string; since?: string; nonce?: string };
    } = {},
  ): Promise<boolean> {
    const now = new Date().toISOString();
    let cleared = false;
    await this.agentStore.update(agentId, (latest) => {
      if (!latest || latest.status !== 'awaiting_human') return AGENT_STORE_NOOP;
      if (opts.expectedTaskId !== undefined && latest.taskId !== opts.expectedTaskId) {
        return AGENT_STORE_NOOP;
      }
      if (opts.expectedHold
        && (latest.awaitingPhase !== opts.expectedHold.phase
          || latest.awaitingSince !== opts.expectedHold.since
          || latest.awaitingNonce !== opts.expectedHold.nonce)) {
        return AGENT_STORE_NOOP;
      }
      cleared = true;
      const {
        status: _status,
        awaitingPhase: _awaitingPhase,
        awaitingReason: _awaitingReason,
        awaitingSince: _awaitingSince,
        awaitingNonce: _awaitingNonce,
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
    opts: {
      expectedCreationToken?: string | null;
      expectedTaskId?: string | null;
      expectedHold?: { phase?: string; since?: string; nonce?: string };
      expectedLockToken?: string;
    } = {},
  ): Promise<boolean> {
    const written = await this.withAgentOperationLease(agentId, async () => {
      const now = new Date().toISOString();
      let details: { projectId: string; taskId?: string } | undefined;
      await this.agentStore.update(agentId, (existing) => {
        if (!existing) return AGENT_STORE_NOOP;
        if (opts.expectedHold) {
          const heldPhase = existing.status === 'awaiting_human' ? existing.awaitingPhase : undefined;
          const heldSince = existing.status === 'awaiting_human' ? existing.awaitingSince : undefined;
          const heldNonce = existing.status === 'awaiting_human' ? existing.awaitingNonce : undefined;
          if (
            heldPhase !== opts.expectedHold.phase
            || heldSince !== opts.expectedHold.since
            || heldNonce !== opts.expectedHold.nonce
          ) {
            return AGENT_STORE_NOOP;
          }
        }
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
        if (opts.expectedLockToken !== undefined && existing.lockToken !== opts.expectedLockToken) {
          return AGENT_STORE_NOOP;
        }
        if (isCancelCleanupHold(existing)) {
          if (!CANCEL_CLEANUP_HOLD_PHASES.has(phase)) return AGENT_STORE_NOOP;
          if (cancelPhaseRank(phase) <= cancelPhaseRank(existing.awaitingPhase)) return AGENT_STORE_NOOP;
        }
        details = {
          projectId: existing.projectId,
          ...(existing.taskId !== undefined ? { taskId: existing.taskId } : {}),
        };
        return {
          ...existing,
          status: 'awaiting_human',
          awaitingPhase: phase,
          awaitingReason: reason,
          awaitingSince: now,
          awaitingNonce: randomBytes(8).toString('hex'),
          updatedAt: now,
        };
      });
      return details;
    });
    if (!written) return false;
    await this.emitIntervention(written.projectId, agentId, written.taskId, {
      phase,
      reason,
    });
    return true;
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
      redispatchReviewTaskId?: string;
      reviewPass?: Pick<TaskState, 'status' | 'phase' | 'signalToken'>;
      heldLockToken?: string;
      releaseTaskId?: string;
      releaseHeldQa?: {
        taskId: string;
        expectedHold: { phase: string | undefined; since: string | undefined; nonce: string | undefined };
        expectedTask: Pick<TaskState, 'status' | 'phase' | 'signalToken'>;
      };
      projectId?: string;
      previousPhase?: string;
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
        const uncertainRecovery = state.awaitingPhase === 'dispatch-failed:ack_unknown'
          ? ' Confirm the uncertain review dispatch as not delivered, cancel the task,'
          : ` Cancel task ${state.taskId}`;
        const reason = `Prompt may still be running (${state.awaitingPhase}); Resume is blocked until the task outcome arrives.${uncertainRecovery} or DELETE the agent to recover.`;
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
        (state.awaitingPhase === 'dirty-workdir' || state.awaitingPhase === 'checkout-preparation-failed')
        && boundTask && ACTIVE_TASK_STATUSES.has(boundTask.status)
        // verdict 门禁状态没有在途派发：清掉 hold 后由 spec verdict 重新走完整转码，Resume 放行
        && boundTask.status !== 'spec-ready' && boundTask.status !== 'max_rounds'
      ) {
        if (state.taskId && boundTask.qaAgentId === agentId) {
          // 停驻的 review pass 已死（任务离开 review）：重派会伪造新 pass，只清 hold 并释放绑定；
          // 快照 hold/task 世代供释放路径 CAS，且不得借用 cancel-cleanup 的绕行凭据
          if (boundTask.status !== 'review') {
            return {
              resumed: true,
              releasedBinding: false,
              releaseHeldQa: {
                taskId: state.taskId,
                expectedHold: {
                  phase: state.awaitingPhase,
                  since: state.awaitingSince,
                  nonce: state.awaitingNonce,
                },
                expectedTask: {
                  status: boundTask.status,
                  phase: boundTask.phase,
                  signalToken: boundTask.signalToken,
                },
              },
              projectId: state.projectId,
              previousPhase: state.awaitingPhase,
            };
          }
          const nowQa = new Date().toISOString();
          let clearedHold = false;
          await this.agentStore.update(agentId, (existing) => {
            if (!existing || existing.taskId !== state.taskId) return AGENT_STORE_NOOP;
            if (
              existing.awaitingPhase !== state.awaitingPhase
              || existing.awaitingSince !== state.awaitingSince
              || existing.awaitingNonce !== state.awaitingNonce
            ) {
              return AGENT_STORE_NOOP;
            }
            clearedHold = true;
            return {
              ...existing,
              status: 'ok',
              awaitingPhase: undefined,
              awaitingReason: undefined,
              awaitingSince: undefined,
              awaitingNonce: undefined,
              updatedAt: nowQa,
            };
          });
          if (!clearedHold) {
            const reason = `Agent ${agentId} hold changed while resuming; re-check the agent state and Resume again.`;
            console.warn(`[AgentManager] resumeAgent: ${reason}`);
            return { resumed: false, releasedBinding: false, reason };
          }
          return {
            resumed: true,
            releasedBinding: false,
            redispatchReviewTaskId: state.taskId,
            reviewPass: {
              status: boundTask.status,
              phase: boundTask.phase,
              signalToken: boundTask.signalToken,
            },
            heldLockToken: state.lockToken,
            projectId: state.projectId,
            previousPhase: state.awaitingPhase,
          };
        }
        const reason =
          `Task ${state.taskId} was not dispatched because its checkout could not be prepared. ` +
          'Fix the Workdir, then cancel and redispatch the task; Resume cannot reconstruct the original dispatch safely.';
        console.warn(`[AgentManager] resumeAgent: agent ${agentId} ${state.awaitingPhase} — ${reason}`);
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
      if (shouldReleaseBinding && state.taskId) {
        return {
          resumed: true,
          releasedBinding: false,
          releaseTaskId: state.taskId,
          projectId: state.projectId,
          previousPhase: state.awaitingPhase,
        };
      }

      await this.agentStore.update(agentId, (existing) => {
        if (!existing) return AGENT_STORE_NOOP;
        const next: AgentBindingFacts = {
          id: existing.id,
          projectId: existing.projectId,
          updatedAt: now,
          ...(existing.workdir !== undefined ? { workdir: existing.workdir } : {}),
          ...(existing.paneId !== undefined ? { paneId: existing.paneId } : {}),
          ...(existing.creationToken !== undefined ? { creationToken: existing.creationToken } : {}),
          status: 'ok',
        };
        if (!shouldReleaseBinding) {
          if (existing.taskId !== undefined) next.taskId = existing.taskId;
          if (existing.lockToken !== undefined) next.lockToken = existing.lockToken;
          if (existing.startedAt !== undefined) next.startedAt = existing.startedAt;
          if (existing.needInput !== undefined) next.needInput = existing.needInput;
        }
        return next;
      });
      await this.emitIntervention(state.projectId, agentId, state.taskId, {
        phase: 'resumed',
        previousPhase: state.awaitingPhase,
        releasedBinding: false,
      });
      return { resumed: true, releasedBinding: false };
    });
    if (result.releaseTaskId) {
      const released = await this.releaseAgentForTask(agentId, result.releaseTaskId, 'idle', {
        allowAwaitingHuman: true,
        fromCancelCleanup: true,
      });
      if (!released) {
        const refreshed = await this.agentStore.get(agentId);
        return {
          resumed: false,
          releasedBinding: false,
          reason: refreshed?.awaitingReason
            ?? `Agent ${agentId} could not safely release task ${result.releaseTaskId}.`,
        };
      }
      await this.emitIntervention(result.projectId!, agentId, result.releaseTaskId, {
        phase: 'resumed',
        previousPhase: result.previousPhase,
        releasedBinding: true,
      });
      return { resumed: true, releasedBinding: true };
    }
    if (result.redispatchCodeTaskId) {
      try {
        const task = await this.taskStore.get(result.redispatchCodeTaskId);
        const round = task ? (task.specReviewRound ?? 1) : undefined;
        const stored = round === undefined
          ? null
          : await this.reviewStore?.getRound(result.redispatchCodeTaskId, 'spec', round);
        if (!task || task.phase !== 'code' || !task.signalToken || !stored || stored.phase !== 'spec') {
          await this.markAwaitingHuman(
            agentId,
            'code-dispatch-failed',
            'Code-phase redispatch cannot continue because the persisted Spec handoff is missing or invalid. Restore the review record or cancel the task.',
            { expectedTaskId: result.redispatchCodeTaskId },
          ).catch(() => undefined);
          return { resumed: false, releasedBinding: false, reason: 'Persisted Spec handoff is missing or invalid.' };
        }
        const resumed = await this.dispatchCodePhasePrompt(
          task,
          agentId,
          task.signalToken,
          stored.documents,
          round,
        );
        if (!resumed) {
          const reason = 'Code-phase redispatch on Resume was not delivered; Resume again to retry or cancel the task.';
          await this.markAwaitingHuman(
            agentId,
            'code-dispatch-failed',
            reason,
            { expectedTaskId: result.redispatchCodeTaskId },
          ).catch(() => undefined);
          return { resumed: false, releasedBinding: false, reason };
        }
        // 重派与首派同样不经 startSession 的 post-ack finalize：残留的 bootstrap 标记
        // 会让下一次 recover 把已送达的 code prompt 再判成未送达
        if (!this.isResearchHandoff(task, agentId)) {
          const lockToken = (await this.agentStore.get(agentId))?.lockToken;
          await this.finalizeReplayedBootstrap(agentId, result.redispatchCodeTaskId, 'code', lockToken);
        }
      } catch (err) {
        console.error(`[AgentManager] resumeAgent code redispatch failed for ${agentId}:`, err);
        const reason = `Code-phase redispatch on Resume failed: ${err instanceof Error ? err.message : String(err)}`;
        await this.markAwaitingHuman(
          agentId,
          'code-dispatch-failed',
          reason,
          { expectedTaskId: result.redispatchCodeTaskId },
        ).catch(() => undefined);
        return { resumed: false, releasedBinding: false, reason };
      }
    }
    if (result.releaseHeldQa) {
      const { taskId: heldTaskId, expectedHold, expectedTask } = result.releaseHeldQa;
      const released = await this.releaseAgentForTask(agentId, heldTaskId, 'idle', {
        allowAwaitingHuman: true,
        expectedHold,
        expectedTask,
      });
      if (!released) {
        const refreshed = await this.agentStore.get(agentId).catch((readErr) => {
          console.warn(`[AgentManager] resumeAgent post-release read failed for ${agentId}:`, readErr);
          return null;
        });
        return {
          resumed: false,
          releasedBinding: false,
          reason: refreshed?.awaitingReason
            ?? `Agent ${agentId} could not safely release task ${heldTaskId}; its pass or hold moved on — re-check the agent state and Resume again.`,
        };
      }
      await this.emitIntervention(result.projectId!, agentId, heldTaskId, {
        phase: 'resumed',
        previousPhase: result.previousPhase,
        releasedBinding: true,
      });
      return { resumed: true, releasedBinding: true };
    }
    if (result.redispatchReviewTaskId) {
      const reviewPass = result.reviewPass!;
      let recoveryLockToken = result.heldLockToken;
      try {
        const reviewTask = await this.taskStore.get(result.redispatchReviewTaskId);
        const resumeEntry = this.getPendingDispatchRetry(result.redispatchReviewTaskId);
        const resumeQaPhase = resumeEntry?.kind === 'qa-recheck'
          && resumeEntry.signalToken === reviewTask?.signalToken
          && resumeEntry.qaPhase !== undefined
          ? resumeEntry.qaPhase
          : (reviewTask?.reviewRound === 0 ? 'review' as const : undefined);
        await this.dispatchReviewToQa(result.redispatchReviewTaskId, {
          bumpRound: reviewTask?.reviewRoundPending === true,
          fromStatus: ['review'],
          expectPhase: reviewPass.phase,
          expectSignalToken: reviewPass.signalToken,
          ...(resumeQaPhase !== undefined ? { qaPhase: resumeQaPhase } : {}),
          onQaAcquired: (lockToken) => { recoveryLockToken = lockToken; },
        });
      } catch (err) {
        console.error(`[AgentManager] resumeAgent review redispatch failed for ${agentId}:`, err);
        const reason = `QA review redispatch on Resume failed: ${err instanceof Error ? err.message : String(err)}`;
        const reviewTaskId = result.redispatchReviewTaskId;
        // 锁代未变（未被 successor re-acquire）才允许补挂；markAwaitingHuman 内的 CAS 原子复核同一条件
        const restoreHoldIfStillOurs = async (phase: string, holdReason: string): Promise<void> => {
          const after = await this.agentStore.get(agentId);
          if (
            after?.taskId === reviewTaskId
            && after.status !== 'awaiting_human'
            && after.lockToken === recoveryLockToken
          ) {
            await this.markAwaitingHuman(agentId, phase, holdReason, {
              expectedTaskId: reviewTaskId,
              ...(recoveryLockToken !== undefined ? { expectedLockToken: recoveryLockToken } : {}),
            });
          }
        };
        // handled 只代表 startSession 已尝试落 hold；落库可能已失败，必须核实并按需补挂
        if (err instanceof EnsureSessionError && err.partial.handled) {
          try {
            await restoreHoldIfStillOurs(result.previousPhase ?? 'checkout-preparation-failed', reason);
            return { resumed: false, releasedBinding: false, reason };
          } catch (holdErr) {
            const holdMsg = holdErr instanceof Error ? holdErr.message : String(holdErr);
            console.error(`[AgentManager] resumeAgent could not verify/restore the handled hold for ${agentId}:`, holdErr);
            return {
              resumed: false,
              releasedBinding: false,
              reason: `${reason}; verifying/restoring the hold also failed: ${holdMsg} — the agent may be missing its awaiting_human flag, inspect it manually`,
            };
          }
        }
        // ack_unknown：prompt 可能已在跑，必须恢复 ack hold 的可见性，而非按普通失败补挂 checkout hold
        if (err instanceof DispatchTerminalError && err.reason === 'ack_unknown') {
          try {
            await restoreHoldIfStillOurs(
              'dispatch-failed:ack_unknown',
              `${err.message}. Prompt may still be running in the pane; verify before resuming.`,
            );
            return { resumed: false, releasedBinding: false, reason };
          } catch (holdErr) {
            const holdMsg = holdErr instanceof Error ? holdErr.message : String(holdErr);
            console.error(`[AgentManager] resumeAgent could not restore the ack_unknown hold for ${agentId}:`, holdErr);
            return {
              resumed: false,
              releasedBinding: false,
              reason: `${reason}; restoring the dispatch-failed:ack_unknown hold also failed: ${holdMsg} — prompt state is unknown and the agent is NOT flagged awaiting_human, inspect it manually`,
            };
          }
        }
        // pass 被接管（token 轮换或任务离开 review）说明该 pass 已死，补挂会把新 pass 的 QA 打成 hold
        let passSuperseded = false;
        let recoveryReadFailed = false;
        try {
          const taskNow = await this.taskStore.get(reviewTaskId);
          passSuperseded = taskNow?.status !== reviewPass.status
            || taskNow.phase !== reviewPass.phase
            || taskNow.signalToken !== reviewPass.signalToken;
        } catch (readErr) {
          recoveryReadFailed = true;
          console.error(`[AgentManager] resumeAgent recovery task read failed for ${agentId}:`, readErr);
        }
        if (passSuperseded) return { resumed: false, releasedBinding: false, reason };
        try {
          if (recoveryReadFailed) {
            // 读失败时无法证明接管，优先恢复可见性：锁代/绑定 CAS 全部由 markAwaitingHuman 原子判定
            await this.markAwaitingHuman(
              agentId,
              result.previousPhase ?? 'checkout-preparation-failed',
              reason,
              {
                expectedTaskId: reviewTaskId,
                ...(recoveryLockToken !== undefined ? { expectedLockToken: recoveryLockToken } : {}),
              },
            );
          } else {
            await restoreHoldIfStillOurs(result.previousPhase ?? 'checkout-preparation-failed', reason);
          }
          return { resumed: false, releasedBinding: false, reason };
        } catch (holdErr) {
          const holdMsg = holdErr instanceof Error ? holdErr.message : String(holdErr);
          console.error(`[AgentManager] resumeAgent could not restore the QA hold for ${agentId}:`, holdErr);
          return {
            resumed: false,
            releasedBinding: false,
            reason: `${reason}; restoring the hold also failed: ${holdMsg} — the agent is NOT flagged awaiting_human, inspect it manually`,
          };
        }
      }
    }
    return {
      resumed: result.resumed,
      releasedBinding: result.releasedBinding,
      ...(result.reason ? { reason: result.reason } : {}),
    };
  }

  private async resolveClaimedPaneOrNull(
    state: AgentBindingFacts,
    cfg: AgentConfig & { projectId: string },
  ): Promise<PaneRef | null> {
    try {
      return await this.resolveClaimedPane(
        new TmuxManager(this.createRunnerFor(cfg)),
        cfg.id,
        state.paneId,
      );
    } catch (err) {
      console.warn(`[AgentManager] resolveClaimedPane failed for ${cfg.id}:`, err);
      return null;
    }
  }

  private async inspectReleaseRuntime(
    tmux: TmuxManager,
    agentId: string,
  ): Promise<ReleaseRuntime> {
    let sessionAlive: boolean;
    try {
      sessionAlive = await tmux.hasSession(agentId);
    } catch (err) {
      return {
        kind: 'hold',
        reason:
          `Runtime availability probe failed; refusing checkout cleanup: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!sessionAlive) return { kind: 'absent' };

    try {
      return { kind: 'pane', pane: await this.resolveClaimedPane(tmux, agentId) };
    } catch (err) {
      if (err instanceof PaneGoneError) {
        return {
          kind: 'hold',
          reason: `Runtime session claim probe/mismatch; refusing checkout cleanup: ${err.message}`,
        };
      }
      return {
        kind: 'hold',
        reason:
          `Runtime pane probe failed; refusing checkout cleanup: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async interruptPaneAndWaitReady(
    state: AgentBindingFacts,
    cfg: AgentConfig & { projectId: string },
  ): Promise<boolean> {
    const pane = await this.resolveClaimedPaneOrNull(state, cfg);
    if (!pane) return false;
    const paneId = pane.paneId;
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
        await tmux.sendKeysToPane(pane, 'Escape');
        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        console.warn(`[AgentManager] interruptPaneAndWaitReady: send Escape failed for pane ${paneId}:`, err);
        return false;
      }
      if (await this.paneReachedReplReady(tmux, pane, runtime, 10_000)) return true;
      if (!(await this.paneRunsRuntime(tmux, pane, runtime))) return false;
      if (await this.paneHasLiveTurn(tmux, pane, runtime)) {
        console.warn(`[AgentManager] interruptPaneAndWaitReady: pane ${paneId} still running a turn after ESC; holding`);
        return false;
      }
      if (!(await this.paneRunsRuntime(tmux, pane, runtime))) return false;
      try {
        await tmux.sendKeysToPane(pane, 'C-c');
        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        console.warn(`[AgentManager] interruptPaneAndWaitReady: send C-c (composer clear) failed for pane ${paneId}:`, err);
        return false;
      }
      return this.paneReachedReplReady(tmux, pane, runtime, this.cleanComposerWaitMs);
    } finally {
      this.compactInFlight.delete(cfg.id);
    }
  }

  private async paneHasLiveTurn(tmux: TmuxManager, pane: PaneRef, runtime: AgentRuntimeKind): Promise<boolean> {
    const paneId = pane.paneId;
    let first: string;
    let firstTitle: string;
    try {
      first = await tmux.capturePaneById(pane, { ansi: false, scrollback: 0 });
      firstTitle = await tmux.readPaneTitle(pane);
    } catch (err) {
      console.warn(`[AgentManager] interruptPaneAndWaitReady: liveness capture failed for pane ${paneId}:`, err);
      return true;
    }
    for (let i = 1; i < RUNTIME_LIVENESS_SAMPLES; i++) {
      await new Promise(r => setTimeout(r, this.runtimeLivenessProbeMs));
      let frame: string;
      let title: string;
      try {
        frame = await tmux.capturePaneById(pane, { ansi: false, scrollback: 0 });
        title = await tmux.readPaneTitle(pane);
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

  private async paneRunsRuntime(tmux: TmuxManager, pane: PaneRef, runtime: AgentRuntimeKind): Promise<boolean> {
    const paneId = pane.paneId;
    let proc: string;
    try {
      proc = await tmux.displayMessage(pane, '#{pane_current_command}');
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
    pane: PaneRef,
    runtime: AgentRuntimeKind,
    timeoutMs: number,
  ): Promise<boolean> {
    const paneId = pane.paneId;
    try {
      await tmux.waitReplReady(pane, runtime, { timeoutMs, scrollback: 0, titleIdleFastPath: true });
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
    opts: {
      expectedPostApproveEpisode?: PostApproveEpisodeKey;
      expectedReviewDispatch?: ReviewDispatchFence;
      expectedLockToken?: string;
    } = {},
  ): Promise<void> {
    const expected = PHASE_EXPECTED_STATUS[phase] ?? [];
    const transitioned = await this.transitionTaskStatus(
      taskId,
      'failed',
      {
        fromStatus: expected.length > 0 ? expected : ['in_progress', 'review', 'fixing', 'approved', 'merge-ready'],
        ...(opts.expectedPostApproveEpisode !== undefined
          ? { expectPostApproveEpisode: opts.expectedPostApproveEpisode }
          : {}),
        ...(opts.expectedReviewDispatch !== undefined
          ? { expectReviewDispatch: opts.expectedReviewDispatch }
          : {}),
      },
    );
    if (!transitioned
      && (opts.expectedPostApproveEpisode !== undefined || opts.expectedReviewDispatch !== undefined)) {
      console.warn(
        `[AgentManager] failTaskForDispatchError: dispatch generation for ${taskId} was superseded; skipping stale failure`,
      );
      return;
    }
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
        {
          expectedTaskId: taskId,
          ...(opts.expectedLockToken !== undefined ? { expectedLockToken: opts.expectedLockToken } : {}),
        },
      );
      if (transitioned) {
        await this.releasePartnersAndDrain(agentId, [taskId], [transitioned.task.projectId]);
      }
      return;
    }
    try {
      if (opts.expectedLockToken !== undefined) {
        await this.releaseAgentForTask(agentId, taskId, 'idle', {
          expectedLockToken: opts.expectedLockToken,
        });
      } else {
        await this.releaseAgentForTask(agentId, taskId, 'idle');
      }
    } catch (releaseErr) {
      console.warn(
        `[AgentManager] failTaskForDispatchError: releaseAgentForTask(${agentId}) failed:`,
        releaseErr,
      );
    }
    await this.emitIntervention(transitioned?.task.projectId ?? '', agentId, taskId, {
      phase: `dispatch-failed:${err.reason}`,
      reason: err.reason,
      message: err.message,
      replDrained: err.replDrained,
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
        // spec-ready 不豁免：approve/打回都依赖 dev Workdir，dev 丢失后停驻只是假活
        if (t.status === 'ready' || t.status === 'merge-ready') continue;
        if (ACTIVE_TASK_STATUSES.has(t.status) && bound) {
          const failedTask = this.stripGitStatusScopedState(t, 'failed');
          failedTask.status = 'failed';
          failedTask.updatedAt = new Date().toISOString();
          await this.taskStore.set(failedTask);
          out.push(failedTask);
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
    pane: PaneRef,
    opts: { timeoutMs: number; expectShell?: boolean },
  ): Promise<string> {
    const deadline = Date.now() + opts.timeoutMs;
    const SHELL = /^(?:zsh|bash|sh|fish)$/;
    let last = '';
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
      const raw = await tmux.displayMessage(pane, '#{pane_current_command}');
      last = raw.trim();
      if (opts.expectShell ? SHELL.test(last) : last !== '') return last;
    }
    return last;
  }

  async restartReplOnly(agentId: string, opts: { expectedGeneration?: number } = {}): Promise<void> {
    // Re-verify the entry generation so a request that slept across a DELETE→recreate can't restart the NEW incarnation's REPL (claim check alone can't tell).
    const genAtEntry = opts.expectedGeneration ?? this.deletionGenerationOf(agentId);
    if (!this.deletionGateOpen(agentId, genAtEntry)) {
      throw new Error(`restart-repl: agent ${agentId} is being deleted or was recreated; aborting`);
    }
    const cfg = this.getAgentConfig(agentId);
    if (!cfg) throw new Error(`Unknown agent: ${agentId}`);
    const runner = this.createRunnerFor(cfg);
    const tmux = new TmuxManager(runner);

    const snapshot = await tmux.getSessionSnapshot(agentId);
    if (!snapshot) {
      throw new Error(`restart-repl: tmux session ${agentId} does not exist; use retry to rebuild`);
    }
    if (snapshot.claim !== agentId) {
      throw new Error(
        `restart-repl: session claim mismatch (got "${snapshot.claim ?? 'null'}"); refusing to touch foreign session`,
      );
    }
    if (!this.deletionGateOpen(agentId, genAtEntry)) {
      throw new Error(`restart-repl: agent ${agentId} is being deleted or was recreated; aborting`);
    }
    const pane = await tmux.getSinglePaneByRef(snapshot.ref, agentId);
    await tmux.sendKeysToPane(pane, 'C-c');
    const cmd = await this.pollPaneCommandStable(tmux, pane, { timeoutMs: 2_000 });
    const RUNTIME = /^(?:claude|codex|node|opencode|qodercli(?:-[\d.]+)?|\d+\.\d+\.\d+)$/;
    const SHELL = /^(?:zsh|bash|sh|fish)$/;
    if (RUNTIME.test(cmd)) {
      await tmux.sendKeysToPane(pane, REPL_EXIT_COMMAND[cfg.runtime], 'Enter');
      await this.pollPaneCommandStable(tmux, pane, { timeoutMs: 2_000, expectShell: true });
    } else if (!SHELL.test(cmd)) {
      throw new Error(`restart-repl precondition failed: unexpected pane state "${cmd}"`);
    }

    const project = this.getProjectConfig(cfg.projectId);
    if (!project) throw new Error(`restart-repl: project ${cfg.projectId} does not exist`);
    // Re-verify before Workdir/skill/session-option side-effects: pane writes fail-closed on a stale PaneRef, but ensureWorkdir/skills would write old-cfg files under a recreated id.
    if (!this.deletionGateOpen(agentId, genAtEntry)) {
      throw new Error(`restart-repl: agent ${agentId} is being deleted or was recreated; aborting`);
    }
    const workdir = (await this.ensureWorkdir(cfg, project, runner)).workdir;
    const paneWorkdir = await tmux.getPaneCurrentPath(pane);
    if (!await sameDirOnHost(runner, paneWorkdir, workdir)) {
      throw new Error(
        `restart-repl: pane Workdir ${paneWorkdir} does not match agent Workdir ${workdir}; ` +
        'use retry to rebuild the session safely',
      );
    }
    if (!this.deletionGateOpen(agentId, genAtEntry)) {
      throw new Error(`restart-repl: agent ${agentId} is being deleted or was recreated; aborting`);
    }
    await this.provisionRepoSkills(runner, cfg, workdir);
    await this.setSessionOptions(tmux, agentId, snapshot.ref, [[WORKDIR_SESSION_OPTION, workdir]]);

    const runtime = agentRuntimeKindFor(cfg);
    const relaunch = async (): Promise<void> => {
      await tmux.sendKeysLiteral(pane, launchCommandIn(workdir, cfg));
      await tmux.sendEnter(pane);
      await tmux.handleTrustDialog(pane, runtime, {
        timeoutMs: this.bootstrapTimeoutsMs.trustDialog,
      });
      await tmux.waitReplReady(pane, runtime, {
        timeoutMs: this.bootstrapTimeoutsMs.waitReplReady,
        scrollback: 0,
      });
      await this.tagSessionSkillsVersion(tmux, agentId, snapshot.ref);
    };
    await this.runUnderSkillDirLock(this.skillDirLockKey(cfg, workdir), relaunch);

    // Final writeback is generation-gated too, so a DELETE→recreate reusing %0 can't persist the old incarnation's paneId onto the new agent.
    await this.agentStore.update(agentId, (state) => {
      if (!state || !this.deletionGateOpen(agentId, genAtEntry)) return AGENT_STORE_NOOP;
      return {
        ...state,
        paneId: pane.paneId,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  // Holds only the pass captured in the task tuple: a successor pass (rotated token/phase/status) is never overwritten.
  async holdReplayFailureIfCurrent(
    agentId: string,
    taskAtEntry: Pick<TaskState, 'id' | 'status' | 'phase' | 'signalToken'>,
    holdPhase: string,
    reason: string,
    entryHold: { phase: string | undefined; since: string | undefined; nonce: string | undefined },
    extraCurrent?: (fresh: TaskState) => Promise<boolean>,
  ): Promise<boolean> {
    return this.withTaskLock(async () => {
      const fresh = await this.taskStore.get(taskAtEntry.id);
      if (
        fresh?.agentId !== agentId
        || fresh.status !== taskAtEntry.status
        || fresh.phase !== taskAtEntry.phase
        || fresh.signalToken !== taskAtEntry.signalToken
      ) return false;
      if (extraCurrent && !(await extraCurrent(fresh))) return false;
      if (await this.markAwaitingHuman(agentId, holdPhase, reason, {
        expectedTaskId: taskAtEntry.id,
        expectedHold: entryHold,
      })) return true;
      // Entry hold gone (Resume raced): write over the empty generation, never over a foreign hold.
      if (await this.markAwaitingHuman(agentId, holdPhase, reason, {
        expectedTaskId: taskAtEntry.id,
        expectedHold: { phase: undefined, since: undefined, nonce: undefined },
      })) return true;
      const now = await this.agentStore.get(agentId);
      return now?.status === 'awaiting_human';
    });
  }

  private async runRotatedReplay(args: {
    agentId: string;
    taskAtEntry: TaskState;
    oldToken: string;
    expectedKinds: readonly PhaseSignalKind[];
    rotateUnderTaskLock: (newToken: string) => Promise<boolean>;
    stillCurrent: (newToken: string) => Promise<boolean>;
    holdFailure: (newToken: string, reason: string) => Promise<boolean>;
    continueWith: (
      newToken: string,
      fence: Pick<ContinueSessionOpts, 'armBeforeInject' | 'guardBeforeInject'>,
    ) => Promise<boolean>;
    afterDelivered?: (newToken: string) => Promise<void>;
  }): Promise<boolean> {
    const { agentId, taskAtEntry: task, oldToken } = args;
    const taskId = task.id;
    const watcher = this.phaseSignalWatcher;
    let newToken = createSignalToken();
    while (newToken === oldToken) newToken = createSignalToken();
    let claim = watcher?.claimArm({
      taskId,
      agentId,
      token: newToken,
      replaceFromToken: oldToken,
      onlyReplaceOwnToken: true,
      replaceScope: 'agent',
    });
    if (claim === null) return false;
    let released = false;
    const releaseClaimOnce = (): void => {
      if (released) return;
      released = true;
      watcher?.releaseArm(claim);
      claim = undefined;
    };
    let rotated = false;
    let armed = false;
    let retiredOld = false;
    const retireOldOnce = (): void => {
      if (retiredOld) return;
      retiredOld = true;
      watcher?.stopAgentIfToken(taskId, agentId, oldToken);
    };
    const settleFailure = async (err: Error): Promise<boolean> => {
      releaseClaimOnce();
      if (!armed) retireOldOnce();
      if (!(await args.stillCurrent(newToken))) return false;
      const held = await args.holdFailure(
        newToken,
        `REPL restarted but replaying the task prompt failed: ${err.message}. Resume to retry, or cancel the task.`,
      );
      if (held) return true;
      if (!(await args.stillCurrent(newToken))) return false;
      throw err;
    };

    try {
      let needInput: { epoch: number; askSeq: number; answeredSeq: number } | null = null;
      const prepared = await this.withTaskLock(async () => {
        if (!(await args.rotateUnderTaskLock(newToken))) return false;
        rotated = true;
        if (!watcher) return true;
        const bump = await this.withNeedInputArmLock(agentId, taskId, () =>
          this.bumpNeedInputEpochForArm(agentId, taskId, 'fresh'));
        if (bump.bumped) this.clearNeedInputRetryFor(agentId, taskId);
        needInput = bump.wm;
        return true;
      });
      if (!prepared) return false;

      const abortStaleReplay = async (): Promise<boolean> => {
        if (await args.stillCurrent(newToken)) return true;
        watcher?.stopAgentIfToken(taskId, agentId, newToken);
        return false;
      };
      const fence: Pick<ContinueSessionOpts, 'armBeforeInject' | 'guardBeforeInject'> = {
        armBeforeInject: async () => {
          try {
            if (!(await args.stillCurrent(newToken))) return false;
            armed = await this.setupPhaseSignalWatcher(taskId, agentId, args.expectedKinds, newToken, {
              replaceFromToken: oldToken,
              onlyReplaceOwnToken: true,
              replaceScope: 'agent',
              skipSnapshot: true,
              preparedReplay: {
                ...(claim != null ? { armClaimId: claim } : {}),
                needInput,
              },
            });
            if (!armed) {
              if (!(await args.stillCurrent(newToken))) return false;
              throw new Error(
                `replay signal watcher failed to arm for task ${taskId}; Restart REPL again or cancel the task`,
              );
            }
            retiredOld = true;
            return abortStaleReplay();
          } finally {
            releaseClaimOnce();
          }
        },
        guardBeforeInject: abortStaleReplay,
      };

      const resumed = await args.continueWith(newToken, fence);
      if (resumed) {
        await args.afterDelivered?.(newToken);
        return true;
      }
      releaseClaimOnce();
      if (!armed) retireOldOnce();
      else watcher?.stopAgentIfToken(taskId, agentId, newToken);
      throw new Error(`the replay prompt for task ${taskId} was not delivered`);
    } catch (err) {
      if (!rotated) throw err;
      return settleFailure(err instanceof Error ? err : new Error(String(err)));
    } finally {
      releaseClaimOnce();
      if (rotated && !armed) retireOldOnce();
    }
  }

  async redispatchTaskPromptAfterReplRestart(agentId: string, taskId: string): Promise<boolean> {
    const agent = this.getAgentConfig(agentId);
    const loadedTask = await this.taskStore.get(taskId);
    if (!agent || !loadedTask || !TASK_OWNER_ROLES.has(agent.role)) return false;
    let task: TaskState = loadedTask;
    if (task.agentId !== agentId) return false;
    const participantId = agent.role === 'research' ? task.researchAgentId : task.devAgentId;
    if (participantId !== agentId) return false;

    const bindingAtEntry = await this.agentStore.get(agentId);
    const entryHold = {
      phase: bindingAtEntry?.status === 'awaiting_human' ? bindingAtEntry.awaitingPhase : undefined,
      since: bindingAtEntry?.status === 'awaiting_human' ? bindingAtEntry.awaitingSince : undefined,
      nonce: bindingAtEntry?.status === 'awaiting_human' ? bindingAtEntry.awaitingNonce : undefined,
    };
    const taskStillCurrent = async (signalToken = task.signalToken): Promise<boolean> => {
      const fresh = await this.taskStore.get(taskId);
      return fresh?.agentId === agentId
        && fresh.status === task.status
        && fresh.phase === task.phase
        && fresh.signalToken === signalToken;
    };
    const clearEntryHold = async (): Promise<boolean> => this.withTaskLock(async () => {
      if (!(await taskStillCurrent())) return false;
      if (entryHold.phase === undefined) {
        const now = await this.agentStore.get(agentId);
        return now?.status !== 'awaiting_human';
      }
      return this.clearAwaitingHuman(agentId, { expectedHold: entryHold });
    });
    const holdReplayFailure = (phase: string, reason: string): Promise<boolean> =>
      this.holdReplayFailureIfCurrent(agentId, task, phase, reason, entryHold);

    try {
      if (task.status === 'approved' && agent.role === 'dev') {
        return await this.replayApprovedHolderAfterReplRestart(
          agentId, task, entryHold, { clearEntryHold, holdReplayFailure },
        );
      }

      if (task.serverSignalRecovery) {
        const recovery = task.serverSignalRecovery;
        if (recovery.mode !== 'hold') {
          if (!(await clearEntryHold())) return false;
          await this.recoverServerSignalRecovery(task);
          return true;
        }
        const cleared = await this.updateTaskIfStatus(
          task.id,
          task.status,
          { serverSignalRecovery: undefined },
          {
            signalToken: task.signalToken,
            phase: task.phase,
            ...(recovery.phase === 'spec'
              ? { specReviewRound: task.specReviewRound }
              : { reviewRound: task.reviewRound }),
          },
        );
        if (!cleared) return false;
        const fresh = await this.taskStore.get(task.id);
        if (!fresh) return false;
        task = fresh;
      }

      const mapped = this.mapTaskStateToExpectedWatcher(task);
      if (!mapped || mapped.agentId !== agentId) return false;
      if (!task.signalToken) {
        return await holdReplayFailure(
          'restart-redispatch-failed',
          'REPL restarted mid-pass but the task has no signal token to replay the prompt with; cancel the task or re-dispatch it.',
        );
      }
      const signalToken = task.signalToken;
      const replayTask = (
        phase: string,
        opts: Omit<ContinueSessionOpts, 'signalToken' | 'armBeforeInject' | 'guardBeforeInject'> = {},
        afterDelivered?: () => Promise<void>,
      ): Promise<boolean> => this.runRotatedReplay({
        agentId,
        taskAtEntry: task,
        oldToken: signalToken,
        expectedKinds: mapped.expectedKinds,
        rotateUnderTaskLock: async (newToken) => {
          const fresh = await this.taskStore.get(taskId);
          if (
            fresh?.agentId !== agentId
            || fresh.status !== task.status
            || fresh.phase !== task.phase
            || fresh.signalToken !== signalToken
          ) return false;
          const rotatePendingPr = mapped.expectedKinds.includes('pr-created')
            && fresh.pendingPrSignalToken === signalToken;
          await this.taskStore.set({
            ...fresh,
            signalToken: newToken,
            ...(rotatePendingPr ? { pendingPrSignalToken: newToken } : {}),
            updatedAt: new Date().toISOString(),
          });
          return true;
        },
        stillCurrent: taskStillCurrent,
        holdFailure: (newToken, reason) => this.holdReplayFailureIfCurrent(
          agentId,
          { ...task, signalToken: newToken },
          'restart-redispatch-failed',
          reason,
          entryHold,
        ),
        continueWith: (newToken, fence) => this.continueSession(taskId, agentId, phase, {
          ...opts,
          signalToken: newToken,
          preserveDispatchOutputs: true,
          expectedHold: { phase: undefined, since: undefined, nonce: undefined },
          ...fence,
        }),
        ...(afterDelivered ? { afterDelivered: async () => afterDelivered() } : {}),
      });
      const replayInitialBootstrap = async (
        phase: 'research' | 'develop',
        opts: Omit<ContinueSessionOpts, 'signalToken' | 'armBeforeInject' | 'guardBeforeInject'>,
      ): Promise<boolean> => {
        if (entryHold.phase === 'bootstrap-marker-clear-failed') {
          return holdReplayFailure(
            'restart-redispatch-failed',
            'REPL restarted while the initial prompt was already delivered (its bootstrap marker clear had failed); replaying would dispatch the task twice. Resume and verify the Workdir, or cancel the task.',
          );
        }
        const bindingBefore = await this.agentStore.get(agentId);
        if (!(await clearEntryHold())) return false;
        return replayTask(phase, opts, async () => {
          if (bindingBefore?.bootstrappingTaskId === taskId) {
            await this.finalizeReplayedBootstrap(agentId, taskId, phase, bindingBefore.lockToken);
          }
        });
      };

      if (task.status === 'in_progress' && task.phase === 'research' && agent.role === 'research') {
        return await replayInitialBootstrap('research', {});
      }

      if (task.status === 'in_progress' && task.phase === undefined && agent.role === 'dev') {
        // An undelivered bootstrap never started work, so the fresh-dispatch clean gate still applies.
        const delivered = (await this.agentStore.get(agentId))?.bootstrappingTaskId !== taskId;
        return await replayInitialBootstrap('develop', {
          ...(delivered ? { allowDirtyWorkdir: true } : {}),
        });
      }

      if (task.status === 'in_progress' && task.phase === 'code' && agent.role === 'dev') {
        const state = await this.agentStore.get(agentId);
        // A no-QA auto-approved spec never writes specReviewRound back; the code dispatch defaults to round 1.
        const round = task.specReviewRound ?? 1;
        const stored = await this.reviewStore?.getRound(taskId, 'spec', round);
        if (state?.bootstrappingTaskId === taskId || !stored || stored.phase !== 'spec') {
          return await holdReplayFailure(
            'code-dispatch-failed',
            'REPL restarted but the code-phase prompt cannot be resumed in place. Resume to replay the persisted Spec documents, or cancel the task.',
          );
        }
        if (!(await clearEntryHold())) return false;
        return replayTask('code', {
          allowDirtyWorkdir: true,
          specDocuments: stored.documents,
          ...(task.specReviewRound !== undefined ? { currentSpecRound: task.specReviewRound } : {}),
        });
      }

      if (task.status === 'fixing' && task.phase === 'spec') {
        const round = task.specReviewRound ?? 1;
        const stored = await this.reviewStore?.getRound(taskId, 'spec', round);
        if (!stored?.findings) {
          return await holdReplayFailure(
            'restart-redispatch-failed',
            `REPL restarted during the spec fixing round but round ${round} findings are not persisted; the feedback prompt cannot be replayed. Cancel the task or re-run the spec review.`,
          );
        }
        if (!(await clearEntryHold())) return false;
        return replayTask('server-feedback', {
          ...(agent.role === 'dev' ? { allowDirtyWorkdir: true } : {}),
          serverPriorFindings: JSON.stringify(stored.findings),
          serverFindingsDigest: reviewFindingsDigest(stored.findings),
          ...(task.specReviewRound !== undefined ? { currentSpecRound: task.specReviewRound } : {}),
        });
      }

      // A direct (no-SDD) pass never persists a phase, so fixing + undefined is the plain code-feedback round.
      if (
        task.status === 'fixing'
        && (task.phase === 'code' || task.phase === undefined)
        && agent.role === 'dev'
      ) {
        if (task.reviewMode === 'server') {
          const round = Math.max(task.reviewRound, 1);
          const stored = await this.reviewStore?.getRound(taskId, 'code', round);
          if (!stored?.findings) {
            return await holdReplayFailure(
              'restart-redispatch-failed',
              `REPL restarted during the code fixing round but round ${round} findings are not persisted; the feedback prompt cannot be replayed. Cancel the task or re-run the code review.`,
            );
          }
          if (!(await clearEntryHold())) return false;
          return replayTask('server-feedback', {
            allowDirtyWorkdir: true,
            serverPriorFindings: JSON.stringify(stored.findings),
            serverFindingsDigest: reviewFindingsDigest(stored.findings),
          });
        }
        if (!(await clearEntryHold())) return false;
        return replayTask('fix', {
          allowDirtyWorkdir: true,
        });
      }

      return false;
    } catch (err) {
      // A post-entry throw may land after clearEntryHold; only a tuple-checked hold on the live generation is safe.
      const message = err instanceof Error ? err.message : String(err);
      if (await holdReplayFailure(
        'restart-redispatch-failed',
        `REPL restarted but replaying the task prompt failed: ${message}. Resume to retry, or cancel the task.`,
      )) {
        return true;
      }
      throw err;
    }
  }

  // approved hosts two live holder passes — post-approve and server after-done; a parked pre-publish holder stays on the waiting path.
  private async replayApprovedHolderAfterReplRestart(
    agentId: string,
    task: TaskState,
    entryHold: { phase: string | undefined; since: string | undefined; nonce: string | undefined },
    holdGen: {
      clearEntryHold: () => Promise<boolean>;
      holdReplayFailure: (phase: string, reason: string) => Promise<boolean>;
    },
  ): Promise<boolean> {
    const taskId = task.id;
    const { clearEntryHold, holdReplayFailure } = holdGen;
    if (task.reviewMode === 'server') {
      if (!task.publishDispatchedAt) return false;
      if (!task.signalToken) {
        return holdReplayFailure(
          'restart-redispatch-failed',
          'REPL restarted mid-publish but the rotated publish token is missing; the publish prompt cannot be replayed. Cancel the task or mark-complete to re-dispatch the publish.',
        );
      }
      const token = task.signalToken;
      const afterDone = this.resolveAfterDone(task);
      if (!afterDone) {
        return holdReplayFailure(
          'restart-redispatch-failed',
          'REPL restarted mid-publish but the after-done target cannot be resolved anymore. Resume then mark-complete to retry the publish, or cancel the task.',
        );
      }
      let violation: Awaited<ReturnType<typeof this.findLineageViolation>>;
      try {
        violation = await this.findLineageViolation(taskId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return holdReplayFailure(
          'restart-redispatch-failed',
          `REPL restarted mid-publish but the branch lineage re-check failed: ${message}. Resume then Restart REPL to retry, or cancel the task.`,
        );
      }
      if (violation) {
        return holdReplayFailure(
          'restart-redispatch-failed',
          `The task branch embeds another active task's commits (${violation.branch}); rebase onto origin/HEAD, then mark-complete to retry the publish.`,
        );
      }
      if (!(await clearEntryHold())) return false;
      const stillCurrent = async (signalToken: string): Promise<boolean> => {
        const fresh = await this.taskStore.get(taskId);
        return fresh?.agentId === agentId
          && fresh.status === task.status
          && fresh.phase === task.phase
          && fresh.signalToken === signalToken;
      };
      return this.runRotatedReplay({
        agentId,
        taskAtEntry: task,
        oldToken: token,
        expectedKinds: ['code-ready'],
        rotateUnderTaskLock: async (newToken) => {
          const fresh = await this.taskStore.get(taskId);
          if (
            fresh?.agentId !== agentId
            || fresh.status !== task.status
            || fresh.phase !== task.phase
            || fresh.signalToken !== token
          ) return false;
          await this.taskStore.set({ ...fresh, signalToken: newToken, updatedAt: new Date().toISOString() });
          return true;
        },
        stillCurrent,
        holdFailure: (newToken, reason) => this.holdReplayFailureIfCurrent(
          agentId,
          { ...task, signalToken: newToken },
          'restart-redispatch-failed',
          reason,
          entryHold,
        ),
        continueWith: (newToken, fence) => this.continueSession(taskId, agentId, 'server-after-done', {
          signalToken: newToken,
          preserveDispatchOutputs: true,
          expectedHold: { phase: undefined, since: undefined, nonce: undefined },
          allowDirtyWorkdir: true,
          serverAfterDone: { kind: afterDone, branch: task.branch ?? BRANCH_PREFIX + taskId },
          ...fence,
        }),
      });
    }

    if (task.postApproveRevoked) {
      return holdReplayFailure(
        'restart-redispatch-failed',
        `The post-approve completion was deliberately revoked (${task.postApproveRevoked.reason}); ` +
        'the block stays effective, so the pass is not replayed. Re-request changes to restart the review round, or cancel the task.',
      );
    }
    const stored = await this.getPostApproveCompletion(taskId);
    let completion: { token: string; rebuilt: boolean } | 'held' | 'stale';
    if (stored) {
      if (!task.postApproveHeadSha) {
        return holdReplayFailure(
          'restart-redispatch-failed',
          'REPL restarted during the post-approve pass but the stored completion cannot be tied to a persisted approved head; re-request the review verdict or cancel the task.',
        );
      }
      if (stored.approvedHeadSha !== task.postApproveHeadSha) {
        // Provably a dead episode's residue: retire it by token, then rebuild for the current head.
        await this.clearPostApproveCompletionIfMatches(
          taskId,
          { generation: stored.generation, token: stored.token, headSha: stored.approvedHeadSha },
        );
        completion = await this.holdIncompleteGitPostApproveEpisode(holdReplayFailure);
      } else {
        completion = { token: stored.token, rebuilt: false };
      }
    } else {
      completion = await this.holdIncompleteGitPostApproveEpisode(holdReplayFailure);
    }
    if (completion === 'held') return true;
    if (completion === 'stale') return false;
    const oldCompletionToken = completion.token;
    const episodeMatches = (fresh: TaskState | null): fresh is TaskState => fresh?.agentId === agentId
      && fresh.status === task.status
      && fresh.phase === task.phase
      && fresh.signalToken === task.signalToken
      && fresh.reviewMode === task.reviewMode
      && fresh.postApproveRevoked === undefined
      && fresh.postApproveHeadSha === task.postApproveHeadSha
      && fresh.postApproveGeneration === task.postApproveGeneration
      && fresh.postApprovePhase !== undefined;
    const completionTokenMatches = (fresh: TaskState, token: string): boolean =>
      fresh.postApproveToken === token;
    const completionStillCurrent = async (token: string): Promise<boolean> => {
      const fresh = await this.taskStore.get(taskId);
      return episodeMatches(fresh) && completionTokenMatches(fresh, token);
    };
    if (!(await completionStillCurrent(oldCompletionToken))) return false;
    if (!(await clearEntryHold())) return false;
    return this.runRotatedReplay({
      agentId,
      taskAtEntry: task,
      oldToken: oldCompletionToken,
      expectedKinds: ['pr-merge-ready'],
      rotateUnderTaskLock: async (newToken) => {
        const fresh = await this.taskStore.get(taskId);
        if (!episodeMatches(fresh) || !completionTokenMatches(fresh, oldCompletionToken)) return false;
        await this.taskStore.set({
          ...fresh,
          postApproveToken: newToken,
          updatedAt: new Date().toISOString(),
        });
        return true;
      },
      stillCurrent: completionStillCurrent,
      holdFailure: (newToken, reason) => this.holdReplayFailureIfCurrent(
        agentId,
        task,
        'restart-redispatch-failed',
        reason,
        entryHold,
        async (fresh) => episodeMatches(fresh) && completionTokenMatches(fresh, newToken),
      ),
      continueWith: (newToken, fence) => this.continueSession(taskId, agentId, 'post-approve', {
        signalToken: newToken,
        postApproveEpisode: {
          generation: task.postApproveGeneration!,
          token: newToken,
          headSha: task.postApproveHeadSha!,
        },
        preserveDispatchOutputs: true,
        expectedHold: { phase: undefined, since: undefined, nonce: undefined },
        allowDirtyWorkdir: true,
        ...fence,
      }),
      afterDelivered: (newToken: string) => this.confirmPostApprovePromptDelivered(taskId, {
        generation: task.postApproveGeneration!,
        token: newToken,
        headSha: task.postApproveHeadSha!,
      }),
    });
  }

  private async holdIncompleteGitPostApproveEpisode(
    holdReplayFailure: (phase: string, reason: string) => Promise<boolean>,
  ): Promise<'held' | 'stale'> {
    const held = await holdReplayFailure(
      'restart-redispatch-failed',
      'The approved git task has no complete post-approve episode; automatic recovery will not infer one.',
    );
    return held ? 'held' : 'stale';
  }

  prepareRemoveTargets(agentId: string): { targets: string[] } {
    const cfg = this.getAgentConfig(agentId);
    if (!cfg) throw new Error(`Unknown agent: ${agentId}`);
    const project = this.getProjectConfig(cfg.projectId);
    if (!project) throw new Error(`Unknown project: ${cfg.projectId}`);

    if (cfg.role !== 'dev') return { targets: [agentId] };
    const group = this.findAgentGroup(agentId);
    return { targets: group?.map(agent => agent.id) ?? [agentId] };
  }

  async cleanupRemovedAgentRuntime(targets: string[]): Promise<void> {
    const failures: Array<{ agentId: string; step: string; error: unknown }> = [];

    for (const id of targets) {
      const cfg = this.getAgentConfig(id);
      if (!cfg) continue;
      const runner = this.createRunnerFor(cfg);
      const tmux = new TmuxManager(runner);

      // No releaseAgentForTask: the binding dies with the state file in phase 3, and deletability was already enforced by the phase-1 API gates — so cleanup only stops watchers and kills the session.
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
        await this.runUnderSessionLifecycle(id, async () => {
          const cleanupOpts = { timeout: DELETE_CLEANUP_TIMEOUT_MS };
          const snapshot = await tmux.getSessionSnapshot(id, cleanupOpts);
          if (!snapshot) return;
          if (snapshot.claim === id) {
            const outcome = await tmux.killSessionRef(snapshot.ref, { kind: 'equals', claim: id }, cleanupOpts);
            if (outcome === 'refused') {
              throw new Error(
                `tmux generation/claim changed for ${id} before kill; retry DELETE to observe new state`,
              );
            }
            if (outcome === 'killed') {
              console.warn(`[AgentManager] cleanupRemovedAgentRuntime: killed session ${snapshot.ref.sessionId} for removed agent ${id}`);
            }
            return;
          }
          if (snapshot.claim === null) {
            // A nonce-owned unclaimed session is this project's own half-created leftover — reclaim it.
            let nonceOwned: boolean;
            try {
              nonceOwned = await tmux.hasCreationNonce(id, cleanupOpts);
            } catch (err) {
              throw new Error(
                `creation-nonce probe failed for ${id}; retry DELETE: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            if (!nonceOwned) {
              console.warn(
                `[AgentManager] cleanupRemovedAgentRuntime: skipping ${id} ` +
                `(unclaimed, no baxian creation nonce; foreign session)`,
              );
              return;
            }
            const outcome = await tmux.killSessionRef(snapshot.ref, { kind: 'unclaimed' }, cleanupOpts);
            if (outcome === 'refused') {
              throw new Error(
                `half-created session for ${id} was claimed or its server changed before kill; retry DELETE`,
              );
            }
            if (outcome === 'killed') {
              console.warn(`[AgentManager] cleanupRemovedAgentRuntime: killed half-created leftover ${snapshot.ref.sessionId} for removed agent ${id}`);
            }
            return;
          }
          console.warn(
            `[AgentManager] cleanupRemovedAgentRuntime: skipping kill for ${id} ` +
            `(claim=${snapshot.claim}; not baxian-managed)`,
          );
        });
      } catch (err) {
        failures.push({ agentId: id, step: 'tmux', error: err });
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
    const now = new Date().toISOString();
    const isResearch = cfg.role === 'research';
    const group = this.findAgentGroup(cfg.id);
    const devAgentId = isResearch ? group?.find(agent => agent.role === 'dev')?.id : cfg.id;
    if (!devAgentId) throw new Error(`Agent ${cfg.id} has no dev agent in its group`);
    const qaAgentId = group?.find(agent => agent.role === 'qa')?.id;
    const fakeTask: TaskState = {
      id: 'task-9999999999',
      projectId,
      title: input.title,
      description: input.description,
      preferredAgentId: input.preferredAgentId,
      agentId: cfg.id,
      devAgentId,
      ...(qaAgentId ? { qaAgentId } : {}),
      ...(isResearch ? { researchAgentId: cfg.id, phase: 'research' as const } : {}),
      branch: `${BRANCH_PREFIX}task-9999999999`,
      reviewRound: 0,
      reviewMode: this.effectiveReviewMode(projectId),
      ...this.platformBindingFields(projectId),
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
    };
    const fullPrompt = buildPromptInline({
      task: fakeTask,
      phase: isResearch ? 'research' : 'develop',
      agent: cfg,
      workdir: workdirGuess,
      skillRegistry: this.skillRegistry,
      signalToken: 'preview-signal-token',
      hasQaPartner: qaAgentId !== undefined,
      ...(!isResearch && fakeTask.reviewMode === 'git'
        ? { platformCli: this.platformCliContextOf(fakeTask) }
        : {}),
    });
    return Buffer.byteLength(fullPrompt, 'utf8');
  }

  listAgents(): Array<AgentConfig & { projectId: string }> {
    return [...this.agentIndex.values()];
  }

  getProjectConfig(projectId: string): ProjectConfig | undefined {
    return this.config.project.find(p => p.id === projectId);
  }

  platformDriverFor(projectId: string): GitDriver | undefined {
    if (!this.pluginRegistry) return undefined;
    const project = this.getProjectConfig(projectId);
    if (!project) return undefined;
    return buildProjectDriver(project, this.pluginRegistry, this.platformDriverExec);
  }

  private findAgentGroup(anchorAgentId: string): AgentConfig[] | undefined {
    for (const project of this.config.project) {
      for (const group of project.agent) {
        if (group.some(agent => agent.id === anchorAgentId)) return group;
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
    const task = await this.taskStore.get(taskId);
    return task ? this.completionOf(task) : null;
  }

  // completion 与效果字段同居 TaskState：consumedFeedback/pendingRedispatch 与 token CAS
  // 必须同一次持久化（spec §6 双写协议）。
  private completionOf(task: TaskState): PostApproveCompletion | null {
    if (task.postApproveToken === undefined || task.postApproveHeadSha === undefined
      || task.postApproveGeneration === undefined || task.postApprovePhase === undefined) return null;
    return {
      token: task.postApproveToken,
      approvedHeadSha: task.postApproveHeadSha,
      generation: task.postApproveGeneration,
      updatedAt: task.updatedAt,
      ...(task.redispatchCount !== undefined ? { redispatchCount: task.redispatchCount } : {}),
      ...(task.pendingRedispatch !== undefined ? { pendingRedispatch: task.pendingRedispatch } : {}),
    };
  }

  private postApproveEpisodeMatches(
    task: TaskState,
    expected: { token: string; generation?: string; headSha?: string },
  ): boolean {
    return task.status === 'approved'
      && task.postApproveRevoked === undefined
      && task.postApproveGeneration !== undefined
      && task.postApproveHeadSha !== undefined
      && task.postApprovePhase !== undefined
      && task.postApproveToken === expected.token
      && (expected.generation === undefined || task.postApproveGeneration === expected.generation)
      && (expected.headSha === undefined || task.postApproveHeadSha === expected.headSha);
  }

  async armGitPostApproveEpisode(
    taskId: string,
    expected: PostApproveEpisodeKey,
    opts: { recovered?: boolean } = {},
  ): Promise<boolean> {
    return this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task || task.reviewMode !== 'git' || !this.postApproveEpisodeMatches(task, expected)) return false;
      if (!this.phaseSignalWatcher) return true;
      return this.startPhaseSignalWatch({
        taskId,
        projectId: task.projectId,
        agentId: task.agentId,
        expectedKinds: 'pr-merge-ready',
        token: expected.token,
        needInputMode: opts.recovered ? 'restore' : 'fresh',
        ...(opts.recovered ? { recovered: true } : {}),
      });
    });
  }

  async rotateGitPostApproveEpisode(
    taskId: string,
    expected: PostApproveEpisodeKey,
    redispatchCount: number,
  ): Promise<PostApproveEpisodeKey | null> {
    return this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task || task.reviewMode !== 'git' || task.pendingRedispatch !== true
        || !this.postApproveEpisodeMatches(task, expected)) return null;
      const token = createSignalTokenExcluding(expected.generation, expected.token);
      const now = new Date().toISOString();
      await this.taskStore.set({
        ...task,
        postApproveToken: token,
        postApprovePhase: 'installed',
        pendingRedispatch: true,
        redispatchCount,
        updatedAt: now,
      });
      return { generation: expected.generation, headSha: expected.headSha, token };
    });
  }

  private stripPostApproveFields(task: TaskState): TaskState {
    const {
      postApproveToken: _token,
      postApproveGeneration: _generation,
      postApproveHeadSha: _head,
      postApprovePhase: _phase,
      pendingRedispatch: _pending,
      redispatchCount: _count,
      ...rest
    } = task;
    return rest as TaskState;
  }

  private stripPostApproveEpisodeFields(task: TaskState): TaskState {
    const {
      postApproveToken: _token,
      postApproveGeneration: _generation,
      postApproveHeadSha: _head,
      postApprovePhase: _phase,
      postApproveRevoked: _revoked,
      pendingRedispatch: _pending,
      redispatchCount: _count,
      ...rest
    } = task;
    return rest as TaskState;
  }

  private stripGitStatusScopedState(task: TaskState, nextStatus: TaskStatus): TaskState {
    const next = nextStatus === 'approved'
      ? { ...task }
      : this.stripPostApproveEpisodeFields(task);
    if (task.reviewMode === 'git' && nextStatus !== 'review') {
      delete next.reviewDispatch;
      delete next.reviewRoundPending;
    }
    return next;
  }

  async confirmPostApprovePromptDelivered(
    taskId: string,
    expected: string | PostApproveEpisodeKey,
  ): Promise<void> {
    await this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      const key = typeof expected === 'string' ? { token: expected } : expected;
      if (!task || !this.postApproveEpisodeMatches(task, key)) return;
      await this.taskStore.set({
        ...task,
        pendingRedispatch: false,
        postApprovePhase: 'delivered',
        updatedAt: new Date().toISOString(),
      });
    });
  }

  async markPostApproveSignalReceived(
    taskId: string,
    expected: string | PostApproveEpisodeKey,
  ): Promise<void> {
    await this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      const key = typeof expected === 'string' ? { token: expected } : expected;
      if (!task || !this.postApproveEpisodeMatches(task, key)) return;
      if (task.postApprovePhase === 'signaled') return;
      await this.taskStore.set({ ...task, postApprovePhase: 'signaled', updatedAt: new Date().toISOString() });
    });
  }

  async clearPostApproveCompletion(taskId: string): Promise<void> {
    await this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (task && (task.postApproveToken !== undefined || task.pendingRedispatch !== undefined
        || task.redispatchCount !== undefined)) {
        await this.taskStore.set({
          ...this.stripPostApproveFields(task),
          updatedAt: new Date().toISOString(),
        });
      }
      this.phaseSignalWatcher?.stop(taskId);
    });
  }

  // CAS for an existing pass: never creates a record nor touches the marker, so it cannot resurrect a revoked completion.
  async updatePostApproveCompletionIfToken(
    taskId: string,
    expectedToken: string,
    patch: { redispatchCount?: number; pendingRedispatch?: boolean },
    opts: {
      consumeRevision?: { key: string; versionTime: number };
      expectedGeneration?: string;
      expectedHeadSha?: string;
    } = {},
  ): Promise<boolean> {
    return this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task || task.postApproveRevoked || !this.postApproveEpisodeMatches(task, {
        token: expectedToken,
        ...(opts.expectedGeneration !== undefined ? { generation: opts.expectedGeneration } : {}),
        ...(opts.expectedHeadSha !== undefined ? { headSha: opts.expectedHeadSha } : {}),
      })) return false;
      await this.taskStore.set({
        ...task,
        ...patch,
        ...(opts.consumeRevision
          ? { consumedFeedback: { ...task.consumedFeedback, [opts.consumeRevision.key]: opts.consumeRevision.versionTime } }
          : {}),
        updatedAt: new Date().toISOString(),
      });
      return true;
    });
  }

  // Deliberate clear: the persisted marker keeps a restart replay from rebuilding the completion and bypassing the block.
  async revokePostApproveCompletion(
    taskId: string,
    reason: 'request-changes' | 'redispatch-cap',
    opts: { expectedToken?: string; expectedHeadSha?: string; expectedGeneration?: string } = {},
  ): Promise<boolean> {
    return this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task || task.status !== 'approved') return false;
      // Head binds the revoke to one approved episode; an unpersisted head cannot disprove it, so blocking stays fail closed.
      if (
        opts.expectedHeadSha !== undefined
        && task.postApproveHeadSha !== undefined
        && task.postApproveHeadSha !== opts.expectedHeadSha
      ) return false;
      const completion = this.completionOf(task);
      if (!completion) return false;
      if (opts.expectedToken !== undefined && completion.token !== opts.expectedToken) return false;
      if (opts.expectedGeneration !== undefined && completion.generation !== opts.expectedGeneration) return false;
      await this.taskStore.set({
        ...this.stripPostApproveFields(task),
        postApproveRevoked: { generation: completion.generation, reason, at: new Date().toISOString() },
        updatedAt: new Date().toISOString(),
      });
      if (opts.expectedToken !== undefined) this.phaseSignalWatcher?.stopIfToken(taskId, opts.expectedToken);
      else this.phaseSignalWatcher?.stop(taskId);
      return true;
    });
  }

  async clearPostApproveCompletionIfMatches(
    taskId: string,
    expected: string | PostApproveEpisodeKey,
  ): Promise<boolean> {
    return this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      const key = typeof expected === 'string' ? { token: expected } : expected;
      if (!task || !this.postApproveEpisodeMatches(task, key)) return false;
      await this.taskStore.set({
        ...this.stripPostApproveFields(task),
        updatedAt: new Date().toISOString(),
      });
      this.phaseSignalWatcher?.stopIfToken(taskId, key.token);
      return true;
    });
  }

  // Marker/token/head/pending are re-checked inside the committing critical section, so a concurrent revoke never loses.
  async completeApprovedPassToMergeReady(
    taskId: string,
    expected: string | PostApproveEpisodeKey,
  ): Promise<{ task: TaskState } | { refused: 'stale' | 'pending' }> {
    return this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      const key = typeof expected === 'string' ? { token: expected } : expected;
      if (!task || task.status !== 'approved' || task.postApproveRevoked) {
        return { refused: 'stale' as const };
      }
      const completion = this.completionOf(task);
      if (
        !completion
        || completion.token !== key.token
        || task.postApproveHeadSha === undefined
        || completion.approvedHeadSha !== task.postApproveHeadSha
        || !this.postApproveEpisodeMatches(task, key)
      ) {
        return { refused: 'stale' as const };
      }
      if (completion.pendingRedispatch) return { refused: 'pending' as const };
      const next = this.stripPostApproveFields(task);
      delete next.postApproveHeadSha;
      Object.assign(next, {
        status: 'merge-ready' as TaskStatus,
        latestHeadSha: completion.approvedHeadSha,
        updatedAt: new Date().toISOString(),
      });
      await this.taskStore.set(next);
      this.phaseSignalWatcher?.stopIfToken(taskId, key.token);
      return { task: next };
    });
  }

  async pruneConsumedFeedback(taskId: string, sourceKey: string, watermarkTime: number): Promise<void> {
    await this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task?.consumedFeedback) return;
      const prefix = `${sourceKey}:`;
      const kept = Object.entries(task.consumedFeedback)
        .filter(([key, time]) => !key.startsWith(prefix) || time >= watermarkTime);
      if (kept.length === Object.keys(task.consumedFeedback).length) return;
      await this.taskStore.set({
        ...task,
        consumedFeedback: Object.fromEntries(kept),
        updatedAt: new Date().toISOString(),
      });
    });
  }

  async recordClosedUnmergedAnchor(taskId: string, prNumber: number): Promise<boolean> {
    return this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      const tracksPlatformLifecycle = task?.reviewMode === 'git'
        || (task?.reviewMode === 'server' && task.afterDone === 'pr' && task.platformBinding !== undefined);
      if (!task || !tracksPlatformLifecycle || TERMINAL_STATUSES.includes(task.status)) return false;
      const anchor = task.closedUnmergedAnchor;
      if (anchor?.prNumber === prNumber && anchor.cleared !== true) return false;
      const generation = (anchor?.generation ?? 0) + 1;
      const eventKey = `${taskId}:${prNumber}:mr-closed-unmerged:${generation}`;
      await this.taskStore.set({
        ...task,
        closedUnmergedAnchor: { prNumber, generation },
        outbox: [...(task.outbox ?? []), {
          key: eventKey,
          type: 'human.intervention',
          data: { phase: 'mr-closed-unmerged', prNumber, eventKey },
        }],
        updatedAt: new Date().toISOString(),
      });
      return true;
    });
  }

  async clearClosedUnmergedAnchor(taskId: string, prNumber: number): Promise<boolean> {
    return this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      const anchor = task?.closedUnmergedAnchor;
      if (!task || anchor?.prNumber !== prNumber || anchor.cleared === true) return false;
      const generation = anchor.generation;
      const eventKey = `${taskId}:${prNumber}:mr-reopened:${generation}`;
      await this.taskStore.set({
        ...task,
        closedUnmergedAnchor: { ...anchor, cleared: true },
        outbox: [...(task.outbox ?? []), {
          key: eventKey,
          type: 'human.intervention',
          data: { phase: 'mr-reopened', prNumber, eventKey },
        }],
        updatedAt: new Date().toISOString(),
      });
      return true;
    });
  }

  async deliverTaskOutbox(taskId: string): Promise<void> {
    const task = await this.taskStore.get(taskId);
    if (!task?.outbox?.length) return;
    for (const entry of task.outbox) {
      try {
        await this.eventBus.emit({
          id: `outbox:${entry.key}`,
          type: entry.type,
          timestamp: new Date().toISOString(),
          projectId: task.projectId,
          agentId: task.agentId,
          taskId: task.id,
          data: entry.data,
        });
      } catch (err) {
        console.warn(`[AgentManager] outbox delivery failed for task=${taskId} key=${entry.key}:`, err);
        continue;
      }
      await this.withTaskLock(async () => {
        const fresh = await this.taskStore.get(taskId);
        if (!fresh?.outbox?.some(e => e.key === entry.key)) return;
        const remaining = fresh.outbox.filter(e => e.key !== entry.key);
        const { outbox: _outbox, ...rest } = fresh;
        await this.taskStore.set({
          ...(rest as TaskState),
          ...(remaining.length > 0 ? { outbox: remaining } : {}),
          updatedAt: new Date().toISOString(),
        });
      });
    }
  }

  async rearmPostApproveSignal(taskId: string, opts: { skipSnapshot?: boolean } = {}): Promise<boolean> {
    const task = await this.taskStore.get(taskId);
    if (!task || task.reviewMode !== 'git' || task.status !== 'approved') return false;
    const completion = this.completionOf(task);
    if (!completion) return false;
    if (opts.skipSnapshot) {
      return this.withTaskLock(async () => {
        const fresh = await this.taskStore.get(taskId);
        if (!fresh || !this.postApproveEpisodeMatches(fresh, {
          generation: completion.generation,
          token: completion.token,
          headSha: completion.approvedHeadSha,
        })) return false;
        return this.setupPhaseSignalWatcher(
          taskId,
          fresh.agentId,
          'pr-merge-ready',
          completion.token,
          { skipSnapshot: true, onlyReplaceOwnToken: true },
        );
      });
    }
    return this.armGitPostApproveEpisode(taskId, {
      generation: completion.generation,
      token: completion.token,
      headSha: completion.approvedHeadSha,
    });
  }

  // 启动期按「未引用」跳过 skill 池的插件，被热配置首次引用时同步重扫；仍不可物化即拒绝提交——
  // 可解析但物化为空的 tool 会让派发要求加载一个不存在的 skill。
  async ensurePluginSkillPools(next: BaxianConfig): Promise<void> {
    if (!this.pluginRegistry) return;
    for (const project of next.project) {
      if (projectReviewMode(next, project) !== 'git') continue;
      const tool = resolveProjectTool(project);
      if (tool === undefined) continue;
      const plugin = this.pluginRegistry.resolveTool(tool);
      // 静默放行会存下一个「无 driver、无平台 skill、重启即 fatal」的配置（启动期同判据）
      if (plugin === undefined) {
        throw new Error(
          `project '${project.id}': no git-driver plugin provides tool '${tool}' — install it under ~/.baxian/plugins/ first`,
        );
      }
      if (this.skillRegistry.pluginSkillNames({ pluginTools: [tool] }).length > 0) continue;
      await this.skillRegistry.scanPluginSkills(tool, join(plugin.pluginPath, 'skills'));
      if (this.skillRegistry.pluginSkillNames({ pluginTools: [tool] }).length === 0) {
        throw new Error(`plugin '${plugin.manifest.name}' provides no materializable skills for tool '${tool}'`);
      }
    }
  }

  async guardGitConfigCommit(
    current: BaxianConfig,
    next: BaxianConfig,
    scan: (manager: AgentManager, current: BaxianConfig, next: BaxianConfig) => Promise<Array<{ projectId: string; taskIds: string[] }>>,
    commit: () => Promise<void>,
  ): Promise<{ ok: true } | { ok: false; blockers: Array<{ projectId: string; taskIds: string[] }> }> {
    return this.withTaskLock(async () => {
      const blockers = await scan(this, current, next);
      if (blockers.length > 0) return { ok: false as const, blockers };
      await commit();
      return { ok: true as const };
    });
  }

  async flushTaskOutboxes(): Promise<void> {
    const tasks = await this.taskStore.list();
    for (const task of tasks) {
      if (!task.outbox?.length) continue;
      try {
        await this.deliverTaskOutbox(task.id);
      } catch (err) {
        console.warn(`[AgentManager] flushTaskOutboxes: task=${task.id} failed, continuing:`, err);
      }
    }
  }

  private gitReviewLeaseMatches(task: TaskState, lease: ReviewDispatchLease): boolean {
    return task.reviewMode === 'git'
      && task.status === 'review'
      && task.signalToken === lease.signalToken
      && task.reviewHeadAnchorSha === lease.headSha
      && task.passToken === lease.passToken
      && task.failToken === lease.failToken
      && lease.effectiveRound === Math.max(
        1,
        task.reviewRound + (task.reviewRoundPending === true ? 1 : 0),
      );
  }

  // startSession 按 agent 的 projectId 解析 repo/workdir，项目归属不入判会跨仓库检出
  private gitReviewQaConfigUsable(task: Pick<TaskState, 'qaAgentId' | 'projectId'>): boolean {
    if (!task.qaAgentId) return false;
    const config = this.getAgentConfig(task.qaAgentId);
    return config?.role === 'qa' && config.projectId === task.projectId;
  }

  async beginGitReviewPass(
    taskId: string,
    opts: {
      fromStatus: TaskStatus[];
      headSha: string;
      bumpRound: boolean;
      qaPhase?: 'review' | 'recheck';
      expectSignalToken?: string;
      expectPhase?: TaskPhase;
      allowDuringComplete?: boolean;
      patch?: Partial<Pick<TaskState,
        | 'prNumber' | 'prUrl' | 'latestHeadSha' | 'branch' | 'baseBranch'
        | 'replyActorId' | 'replyActorStatus' | 'pendingPrSignalToken'>>;
    },
  ): Promise<TransitionResult | null> {
    if (!PLATFORM_HEAD_SHA_RE.test(opts.headSha)) {
      throw new ApiError(400, `Cannot begin git review for ${taskId}: invalid head sha`);
    }
    return this.withTaskLock(async () => {
      if (this.markCompleteInFlight.has(taskId) && opts.allowDuringComplete !== true) return null;
      const current = await this.taskStore.get(taskId);
      if (!current || current.reviewMode !== 'git' || TERMINAL_STATUSES.includes(current.status)) return null;
      if (!opts.fromStatus.includes(current.status)) return null;
      if (current.reviewDispatch?.phase === 'uncertain') return null;
      if (Object.hasOwn(opts, 'expectSignalToken') && current.signalToken !== opts.expectSignalToken) return null;
      if (Object.hasOwn(opts, 'expectPhase') && current.phase !== opts.expectPhase) return null;
      if (opts.patch?.branch && opts.patch.branch !== current.branch) {
        const existing = await this.findTaskByBranch(opts.patch.branch, current.projectId);
        if (existing && existing.id !== taskId) return null;
      }
      const previousStatus = current.status;
      const now = new Date().toISOString();
      const pair = this.mintReviewTokenPair();
      const signalToken = createSignalTokenExcluding(pair.passToken, pair.failToken);
      const generation = createSignalTokenExcluding(signalToken, pair.passToken, pair.failToken);
      const reviewRoundPending = opts.bumpRound ? true : undefined;
      const effectiveRound = Math.max(
        1,
        current.reviewRound + (reviewRoundPending === true ? 1 : 0),
      );
      const qaPhase = opts.qaPhase ?? (
        current.status === 'in_progress'
          || (current.status === 'review' && current.reviewRound === 0 && opts.bumpRound)
          ? 'review'
          : 'recheck'
      );
      const next = this.stripPostApproveEpisodeFields(current);
      delete next.passProvenance;
      delete next.serverSignalRecovery;
      Object.assign(next, opts.patch ?? {}, {
        status: 'review' as const,
        signalToken,
        reviewHeadAnchorSha: opts.headSha,
        reviewDispatchedAt: now,
        reviewRoundPending,
        ...pair,
        reviewDispatch: {
          generation,
          phase: 'pending' as const,
          qaPhase,
          signalToken,
          headSha: opts.headSha,
          passToken: pair.passToken,
          failToken: pair.failToken,
          effectiveRound,
          updatedAt: now,
        },
        updatedAt: now,
      });
      await this.taskStore.set(next);
      return { task: next, previousStatus };
    });
  }

  async claimGitReviewDispatch(
    taskId: string,
    expectedGeneration?: string,
  ): Promise<{ task: TaskState; lease: ReviewDispatchLease & {
    phase: 'claimed'; claimId: string; claimedAt: string;
  } } | null> {
    return this.withTaskLock(async () => {
      if (this.markCompleteInFlight.has(taskId)) return null;
      const task = await this.taskStore.get(taskId);
      const lease = task?.reviewDispatch;
      if (!task || !lease || lease.phase !== 'pending') return null;
      if (expectedGeneration !== undefined && lease.generation !== expectedGeneration) return null;
      if (!this.gitReviewLeaseMatches(task, lease)) return null;
      const now = new Date().toISOString();
      const claimed = {
        ...lease,
        phase: 'claimed' as const,
        claimId: createSignalTokenExcluding(
          lease.generation, lease.signalToken, lease.passToken, lease.failToken,
        ),
        claimedAt: now,
        updatedAt: now,
      };
      const next = { ...task, reviewDispatch: claimed, updatedAt: now };
      await this.taskStore.set(next);
      return { task: next, lease: claimed };
    });
  }

  async approveGitReviewPass(
    taskId: string,
    opts: {
      expectedSignalToken: string;
      headSha: string;
      reviewRound: number;
      prNumber?: number;
      prUrl?: string;
      provenance: NonNullable<TaskState['passProvenance']>;
    },
  ): Promise<TaskState | null> {
    if (!PLATFORM_HEAD_SHA_RE.test(opts.headSha) || !Number.isInteger(opts.reviewRound) || opts.reviewRound < 1) {
      throw new ApiError(400, `Cannot approve git review for ${taskId}: invalid head or round`);
    }
    return this.withTaskLock(async () => {
      const current = await this.taskStore.get(taskId);
      if (!current || current.reviewMode !== 'git' || current.status !== 'review') return null;
      if (current.signalToken !== opts.expectedSignalToken
        || current.passToken !== opts.provenance.token
        || current.failToken !== opts.provenance.failToken
        || current.reviewHeadAnchorSha !== opts.headSha) return null;
      if (current.reviewDispatch && !this.gitReviewLeaseMatches(current, current.reviewDispatch)) return null;
      const now = new Date().toISOString();
      const next = this.stripPostApproveEpisodeFields(current);
      delete next.reviewDispatch;
      delete next.reviewRoundPending;
      const postApproveGeneration = createSignalToken();
      const postApproveToken = createSignalTokenExcluding(postApproveGeneration);
      Object.assign(next, {
        status: 'approved' as const,
        reviewRound: opts.reviewRound,
        latestHeadSha: opts.headSha,
        passProvenance: opts.provenance,
        ...(opts.prNumber !== undefined ? { prNumber: opts.prNumber } : {}),
        ...(opts.prUrl !== undefined ? { prUrl: opts.prUrl } : {}),
        postApproveGeneration,
        postApproveHeadSha: opts.headSha,
        postApproveToken,
        postApprovePhase: 'installed' as const,
        pendingRedispatch: true,
        redispatchCount: 0,
        updatedAt: now,
      });
      await this.taskStore.set(next);
      return next;
    });
  }

  private async resetGitReviewDispatchClaim(
    taskId: string,
    lease: Pick<ReviewDispatchLease, 'generation' | 'claimId' | 'signalToken'>,
  ): Promise<boolean> {
    return this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      const current = task?.reviewDispatch;
      if (!task || !current || current.phase !== 'claimed'
        || current.generation !== lease.generation
        || current.claimId !== lease.claimId
        || current.signalToken !== lease.signalToken
        || !this.gitReviewLeaseMatches(task, current)) return false;
      const now = new Date().toISOString();
      const { claimId: _claimId, claimedAt: _claimedAt, ...rest } = current;
      await this.taskStore.set({
        ...task,
        reviewDispatch: { ...rest, phase: 'pending', updatedAt: now },
        updatedAt: now,
      });
      return true;
    });
  }

  private async markGitReviewDispatchUncertain(
    taskId: string,
    lease: Pick<ReviewDispatchLease, 'generation' | 'claimId' | 'signalToken'>,
  ): Promise<boolean> {
    return this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      const current = task?.reviewDispatch;
      if (!task || !current || current.phase !== 'claimed'
        || current.generation !== lease.generation
        || current.claimId !== lease.claimId
        || current.signalToken !== lease.signalToken
        || !this.gitReviewLeaseMatches(task, current)) return false;
      const now = new Date().toISOString();
      await this.taskStore.set({
        ...task,
        reviewDispatch: { ...current, phase: 'uncertain', updatedAt: now },
        updatedAt: now,
      });
      return true;
    });
  }

  private async confirmUncertainGitReviewDispatch(
    taskId: string,
    expectedGeneration: string,
    verifiedHeadSha: string,
  ): Promise<TaskState | null> {
    return this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      const current = task?.reviewDispatch;
      if (!task || !current || current.phase !== 'uncertain'
        || current.generation !== expectedGeneration
        || !this.gitReviewLeaseMatches(task, current)) return null;
      const qaId = task.qaAgentId;
      let qaHold: { phase?: string; since?: string; nonce?: string } | undefined;
      if (qaId !== undefined) {
        const qa = await this.agentStore.get(qaId);
        if (qa?.taskId === task.id && qa.status === 'awaiting_human') {
          if (qa.awaitingPhase !== 'dispatch-failed:ack_unknown') return null;
          qaHold = {
            phase: qa.awaitingPhase,
            since: qa.awaitingSince,
            nonce: qa.awaitingNonce,
          };
        } else if (qa?.taskId !== task.id && !canDispatchWithBinding(qa)) {
          return null;
        }
      }
      const now = new Date().toISOString();
      const { claimId: _claimId, claimedAt: _claimedAt, ...rest } = current;
      const next = {
        ...task,
        latestHeadSha: verifiedHeadSha,
        reviewHeadAnchorSha: verifiedHeadSha,
        reviewDispatch: {
          ...rest,
          phase: 'pending' as const,
          headSha: verifiedHeadSha,
          updatedAt: now,
        },
        updatedAt: now,
      };
      await this.taskStore.set(next);
      if (qaHold !== undefined && qaId !== undefined) {
        const cleared = await this.clearAwaitingHuman(qaId, {
          expectedTaskId: task.id,
          expectedHold: qaHold,
        });
        if (!cleared) {
          const restoredAt = new Date().toISOString();
          await this.taskStore.set({
            ...task,
            reviewDispatch: { ...current, updatedAt: restoredAt },
            updatedAt: restoredAt,
          });
          return null;
        }
        await this.emitIntervention(task.projectId, qaId, task.id, {
          phase: 'git-review-dispatch-hold-cleared',
          previousPhase: 'dispatch-failed:ack_unknown',
          generation: current.generation,
        });
      }
      return next;
    });
  }

  private async completeGitReviewDispatch(
    taskId: string,
    lease: Pick<ReviewDispatchLease, 'generation' | 'claimId' | 'signalToken'>,
  ): Promise<boolean> {
    return this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      const current = task?.reviewDispatch;
      if (!task || !current || current.phase !== 'claimed'
        || current.generation !== lease.generation
        || current.claimId !== lease.claimId
        || current.signalToken !== lease.signalToken
        || !this.gitReviewLeaseMatches(task, current)) return false;
      const now = new Date().toISOString();
      const next = { ...task, updatedAt: now };
      if (next.reviewRoundPending === true) {
        next.reviewRound += 1;
        delete next.reviewRoundPending;
      }
      next.reviewDispatchedAt = now;
      delete next.reviewDispatch;
      await this.taskStore.set(next);
      return true;
    });
  }

  private async recoverPendingGitReviewDispatchHold(
    taskId: string,
    expectedGeneration: string,
  ): Promise<{ claimId: string } | null> {
    return this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      const current = task?.reviewDispatch;
      if (!task || !current || current.phase !== 'pending'
        || current.generation !== expectedGeneration
        || !this.gitReviewLeaseMatches(task, current)
        || task.qaAgentId === undefined) return null;
      const qa = await this.agentStore.get(task.qaAgentId);
      if (qa?.taskId !== task.id
        || qa.status !== 'awaiting_human'
        || qa.awaitingPhase !== 'dispatch-failed:ack_unknown') return null;
      const now = new Date().toISOString();
      const claimId = createSignalTokenExcluding(
        current.generation, current.signalToken, current.passToken, current.failToken,
      );
      await this.taskStore.set({
        ...task,
        reviewDispatch: {
          ...current,
          phase: 'uncertain',
          claimId,
          claimedAt: now,
          updatedAt: now,
        },
        updatedAt: now,
      });
      return { claimId };
    });
  }

  async recoverClaimedGitReviewDispatches(): Promise<void> {
    const tasks = await this.taskStore.list();
    for (const snapshot of tasks) {
      const lease = snapshot.reviewDispatch;
      if (snapshot.reviewMode !== 'git' || !lease || lease.phase !== 'claimed') continue;
      const qa = snapshot.qaAgentId ? await this.agentStore.get(snapshot.qaAgentId) : null;
      if (!qa || qa.taskId !== snapshot.id) {
        await this.resetGitReviewDispatchClaim(snapshot.id, lease);
        continue;
      }
      const uncertain = await this.markGitReviewDispatchUncertain(snapshot.id, lease);
      if (uncertain) {
        await this.emitIntervention(snapshot.projectId, snapshot.qaAgentId, snapshot.id, {
          phase: 'git-review-dispatch-recovery-uncertain',
          generation: lease.generation,
          claimId: lease.claimId,
          qaStatus: qa.status ?? 'unknown',
        });
      }
    }
  }

  async retryPendingGitReviewDispatches(): Promise<void> {
    const tasks = await this.taskStore.list();
    for (const snapshot of tasks) {
      const lease = snapshot.reviewDispatch;
      if (snapshot.reviewMode !== 'git' || lease?.phase !== 'pending') continue;
      if (!snapshot.qaAgentId) continue;
      if (!this.gitReviewQaConfigUsable(snapshot)) {
        // 快照可能已过期：告警前 live 复核；按 lease 代际告警一次，emit 成功才落闩
        const latch = `${snapshot.id}:${lease.generation}`;
        if (!this.gitReviewQaConfigAlerted.has(latch)) {
          try {
            const live = await this.taskStore.get(snapshot.id);
            const liveLease = live?.reviewDispatch;
            if (live && liveLease?.phase === 'pending'
              && liveLease.generation === lease.generation
              && live.qaAgentId === snapshot.qaAgentId
              && !this.gitReviewQaConfigUsable(live)) {
              const alerted = await this.emitIntervention(live.projectId, live.qaAgentId, live.id, {
                phase: 'git-review-qa-config-missing',
                qaAgentId: live.qaAgentId,
                generation: lease.generation,
              });
              if (alerted) this.gitReviewQaConfigAlerted.add(latch);
            }
          } catch (err) {
            console.warn(
              `[AgentManager] retryPendingGitReviewDispatches: task=${snapshot.id} qa-config alert check failed, continuing:`,
              err,
            );
          }
        }
        continue;
      }
      try {
        const recovered = await this.recoverPendingGitReviewDispatchHold(snapshot.id, lease.generation);
        if (recovered) {
          await this.emitIntervention(snapshot.projectId, snapshot.qaAgentId, snapshot.id, {
            phase: 'git-review-dispatch-recovery-uncertain',
            generation: lease.generation,
            claimId: recovered.claimId,
            qaStatus: 'awaiting_human',
          });
          continue;
        }
        const entry = this.getPendingDispatchRetry(snapshot.id);
        if (entry?.kind === 'qa-recheck' && entry.signalToken === lease.signalToken) continue;
        if (snapshot.prNumber === undefined) {
          throw new Error(`task ${snapshot.id} has no PR bound to its pending review lease`);
        }
        const verified = await this.platformVerifyPrBinding(snapshot.id, snapshot.prNumber);
        if (!verified.ok || verified.headSha.toLowerCase() !== lease.headSha.toLowerCase()) {
          console.warn(
            `[AgentManager] retryPendingGitReviewDispatches: task=${snapshot.id} binding/head changed; ` +
            `preserving generation=${lease.generation} without dispatch`,
          );
          continue;
        }
        await this.dispatchGitReviewLease(snapshot.id, {
          expectedGeneration: lease.generation,
        });
      } catch (err) {
        if (err instanceof DispatchTerminalError && err.reason !== 'ack_unknown' && snapshot.qaAgentId) {
          await this.failTaskForDispatchError(
            snapshot.id,
            lease.qaPhase,
            snapshot.qaAgentId,
            err,
            { expectedReviewDispatch: lease },
          );
          continue;
        }
        console.warn(`[AgentManager] retryPendingGitReviewDispatches: task=${snapshot.id} still failing:`, err);
      }
    }
  }

  async retryGitRemoteCleanupIntents(): Promise<void> {
    const tasks = await this.taskStore.list();
    for (const task of tasks) {
      const intent = task.remoteCleanup;
      if (task.reviewMode !== 'git' || !intent || intent.stage === 'manual') continue;
      try {
        await this.processGitRemoteCleanup(task.id, intent.generation);
      } catch (err) {
        console.warn(
          `[AgentManager] retryGitRemoteCleanupIntents: task=${task.id} stage=${intent.stage} failed:`,
          err,
        );
        try {
          const current = await this.taskStore.get(task.id);
          if (current?.remoteCleanup?.generation === intent.generation
            && current.remoteCleanup.failure === undefined) {
            await this.recordRemoteCleanupFailure(current, intent.generation, 'probe', safeDriverErrorText(err));
          }
        } catch (recordErr) {
          console.error(
            `[AgentManager] retryGitRemoteCleanupIntents: task=${task.id} could not record sweep failure:`,
            recordErr,
          );
        }
      }
    }
  }

  async consumeGitFeedbackRevision(
    taskId: string,
    consume: { key: string; versionTime: number },
    opts: { feedbackAt?: string } = {},
  ): Promise<
    | { kind: 'duplicate' | 'gone' | 'consumed' }
    | { kind: 'returned' | 'pending'; task: TaskState }
  > {
    return this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task || task.reviewMode !== 'git') return { kind: 'gone' as const };
      if (task.consumedFeedback?.[consume.key] !== undefined) return { kind: 'duplicate' as const };
      const consumed = { ...task.consumedFeedback, [consume.key]: consume.versionTime };
      const stamp = { updatedAt: new Date().toISOString() };
      if (TERMINAL_STATUSES.includes(task.status)) {
        await this.taskStore.set({ ...task, consumedFeedback: consumed, ...stamp });
        return { kind: 'consumed' as const };
      }
      if (task.status === 'merge-ready') {
        const approvedHead = typeof task.latestHeadSha === 'string' && PLATFORM_HEAD_SHA_RE.test(task.latestHeadSha)
          ? task.latestHeadSha
          : undefined;
        if (approvedHead !== undefined) {
          const generation = createSignalToken();
          const token = createSignalTokenExcluding(generation);
          const next: TaskState = {
            ...task,
            status: 'approved',
            postApproveGeneration: generation,
            postApproveHeadSha: approvedHead,
            postApproveToken: token,
            postApprovePhase: 'installed',
            pendingRedispatch: true,
            redispatchCount: 0,
            consumedFeedback: consumed,
            ...(opts.feedbackAt !== undefined ? { prFeedbackReceivedAt: opts.feedbackAt } : {}),
            ...stamp,
          };
          await this.taskStore.set(next);
          return { kind: 'returned' as const, task: next };
        }
      }
      if (task.status === 'approved' && task.postApproveRevoked === undefined) {
        if (!this.completionOf(task)) {
          throw new Error(`approved git task ${task.id} has no complete post-approve episode`);
        }
        const next: TaskState = {
          ...task,
          pendingRedispatch: true,
          consumedFeedback: consumed,
          ...(opts.feedbackAt !== undefined ? { prFeedbackReceivedAt: opts.feedbackAt } : {}),
          ...stamp,
        };
        await this.taskStore.set(next);
        return { kind: 'pending' as const, task: next };
      }
      await this.taskStore.set({
        ...task,
        consumedFeedback: consumed,
        ...(opts.feedbackAt !== undefined ? { prFeedbackReceivedAt: opts.feedbackAt } : {}),
        ...stamp,
      });
      return { kind: 'consumed' as const };
    });
  }

  async setupRecoveredPostApproveSignals(): Promise<void> {
    const tasks = await this.taskStore.list({ status: 'approved' });
    for (const task of tasks) {
      if (task.reviewMode !== 'git') continue;
      if (task.postApproveRevoked) {
        // Finish an interrupted revoke: the marker is authoritative, the leftover record must not re-arm.
        try {
          if (task.postApproveToken !== undefined) {
            await this.taskStore.set({
              ...this.stripPostApproveFields(task),
              updatedAt: new Date().toISOString(),
            });
          }
        } catch (err) {
          console.warn(
            `[AgentManager] setupRecoveredPostApproveSignals: revoked completion cleanup failed for task=${task.id}:`,
            err,
          );
        }
        continue;
      }
      const completion = this.completionOf(task);
      if (!completion) {
        await this.emitIntervention(task.projectId, task.agentId, task.id, {
          phase: 'post-approve-recovery-incomplete-episode',
        });
        continue;
      }
      if (!this.phaseSignalWatcher) continue;
      try {
        await this.armGitPostApproveEpisode(task.id, {
          generation: completion.generation,
          token: completion.token,
          headSha: completion.approvedHeadSha,
        }, { recovered: true });
      } catch (err) {
        console.warn(
          `[AgentManager] setupRecoveredPostApproveSignals: failed to set up task=${task.id}:`,
          err,
        );
      }
    }
  }

  async setupRecoveredSpecSignals(): Promise<void> {
    const tasks = await this.taskStore.list();
    for (const task of tasks) {
      if (task.serverSignalRecovery) {
        try {
          await this.recoverServerSignalRecovery(task);
        } catch (err) {
          console.warn(
            `[AgentManager] setupRecoveredSpecSignals: failed to recover server signal for task=${task.id}:`,
            err,
          );
        }
        continue;
      }
      if (!this.phaseSignalWatcher) continue;
      if (!task.signalToken) continue;
      const mappings = this.mapTaskStateToExpectedWatchers(task);
      if (mappings.length === 0) continue;
      for (const mapped of mappings) {
        await this.setupRecoveredWatcherForMapping(task, mapped.token ?? task.signalToken, mapped, mappings.length > 1);
      }
    }
  }

  private async recoverServerSignalRecovery(task: TaskState): Promise<void> {
    const recovery = task.serverSignalRecovery;
    const successorToken = task.signalToken;
    if (!recovery || !successorToken) return;
    const agentId = recovery.signalKind.endsWith('-reviewed') ? (task.qaAgentId ?? '') : task.agentId;
    const hold = async (phase: string, reason: string): Promise<void> => {
      const held = await this.holdServerSignalRecovery(task.id, agentId, successorToken, phase, reason);
      if (!held) return;
      await this.emitIntervention(task.projectId, agentId, task.id, {
        phase,
        recoveryReason: recovery.reason,
        successorToken,
      });
    };
    if (recovery.mode === 'hold') {
      if (!agentId) return;
      const state = await this.agentStore.get(agentId);
      if (state?.status === 'awaiting_human') return;
      await hold(
        recovery.failurePhase ?? `server-signal-${recovery.reason}`,
        `A consumed ${recovery.signalKind} signal is held for ${recovery.reason}. `
        + 'Resolve the cause, then Restart or Cancel the task.',
      );
      return;
    }
    const stored = await this.reviewStore?.getRound(task.id, recovery.phase, recovery.round);
    if (!stored?.findings || !recovery.findingsDigest
      || reviewFindingsDigest(stored.findings) !== recovery.findingsDigest) {
      await hold(
        `server-${recovery.phase}-feedback-recovery-findings-missing`,
        `Cannot recover the rejected response because round ${recovery.round} findings are missing or changed.`,
      );
      return;
    }
    const responseReasons = new Set<ServerResponseFailure['reason']>([
      'response-missing', 'response-invalid', 'round-mismatch', 'token-mismatch',
      'findings-digest-mismatch', 'coverage-gap',
    ]);
    const dev = agentId ? this.getAgentConfig(agentId) : undefined;
    if (!dev || !recovery.failureSignature
      || (recovery.signalKind !== 'code-fixed' && recovery.signalKind !== 'spec-fixed')
      || !responseReasons.has(recovery.reason as ServerResponseFailure['reason'])) {
      await hold(
        `server-${recovery.phase}-feedback-recovery-invalid`,
        'The persisted response recovery intent is incomplete and cannot be resumed safely.',
      );
      return;
    }
    const readResponse = async () => {
      try {
        const result = await this.getReviewTransport().readResponseWithRaw(task, dev);
        if (result.kind === 'unknown') {
          await hold(
            `server-${recovery.phase}-feedback-recovery-read-failed`,
            'The rejected response could not be read while finishing crash recovery; the file was preserved.',
          );
          return null;
        }
        return result;
      } catch (err) {
        await hold(
          `server-${recovery.phase}-feedback-recovery-read-failed`,
          `The rejected response could not be read while finishing crash recovery: `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    };
    const holdChangedResponse = async (): Promise<void> => hold(
      `server-${recovery.phase}-feedback-recovery-response-changed`,
      'The response changed after its token was retired, so recovery preserved the file for manual inspection.',
    );
    if (recovery.mode === 'classify-response') {
      const result = await readResponse();
      if (!result) return;
      let rawResponse: string | undefined;
      let responseDigest: string | undefined;
      if (recovery.reason === 'response-missing') {
        if (result.kind !== 'absent') {
          await holdChangedResponse();
          return;
        }
      } else if (result.kind === 'absent' || result.responseDigest !== recovery.responseDigest) {
        await holdChangedResponse();
        return;
      } else {
        rawResponse = result.raw;
        responseDigest = result.responseDigest;
      }
      let recorded: ServerResponseFailure;
      try {
        recorded = await this.reviewStore!.recordServerResponseFailure(
          task.id,
          recovery.phase,
          recovery.round,
          {
            signalKind: recovery.signalKind,
            sourceToken: recovery.sourceToken,
            successorToken,
            failureSignature: recovery.failureSignature,
            reason: recovery.reason as ServerResponseFailure['reason'],
            missingFindingIds: [...(recovery.missingFindingIds ?? [])],
            unknownFindingIds: [...(recovery.unknownFindingIds ?? [])],
            schemaViolationCodes: [...(recovery.schemaViolationCodes ?? [])],
            createdAt: recovery.createdAt,
            ...(responseDigest ? { responseDigest } : {}),
            ...(rawResponse !== undefined ? { rawResponse } : {}),
          },
        );
      } catch (err) {
        await hold(
          `server-${recovery.phase}-feedback-recovery-audit-failed`,
          `Could not archive the rejected response during recovery: `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      const mode = recorded.disposition === 'auto-correct' ? 'correct-response' : 'hold';
      const finalized = await this.setServerSignalRecoveryMode(task.id, successorToken, mode);
      if (!finalized) return;
      if (mode === 'hold') {
        await hold(
          recorded.disposition === 'hold-repeated-signature'
            ? 'server-feedback-response-repeated'
            : 'server-feedback-correction-limit',
          `Automatic correction stopped during recovery (${recorded.disposition}).`,
        );
        return;
      }
    }
    if (agentId && (await this.agentStore.get(agentId))?.status === 'awaiting_human') return;
    const liveResponse = await readResponse();
    if (!liveResponse) return;
    if (liveResponse.kind !== 'absent') {
      if (!recovery.responseDigest || liveResponse.responseDigest !== recovery.responseDigest) {
        await holdChangedResponse();
        return;
      }
      const fresh = await this.taskStore.get(task.id);
      const current = fresh?.serverSignalRecovery;
      const currentRound = recovery.phase === 'spec' ? (fresh?.specReviewRound ?? 0) : fresh?.reviewRound;
      if (fresh?.status !== task.status
        || fresh.phase !== task.phase
        || fresh.signalToken !== successorToken
        || currentRound !== recovery.round
        || current?.mode !== 'correct-response'
        || current.sourceToken !== recovery.sourceToken
        || current.failureSignature !== recovery.failureSignature) {
        return;
      }
      try {
        await this.getReviewTransport().deleteResponse(dev);
      } catch (err) {
        await hold(
          `server-${recovery.phase}-feedback-recovery-cleanup-failed`,
          `The rejected response was archived but could not be removed during recovery: `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
    }
    await this.dispatchServerFeedbackCorrection(task.id, JSON.stringify(stored.findings));
  }

  private async setupRecoveredWatcherForMapping(
    task: TaskState,
    signalToken: string,
    mapped: { expectedKinds: readonly PhaseSignalKind[]; agentId: string; token?: string },
    hasSiblings: boolean,
  ): Promise<void> {
    {
      const { expectedKinds, agentId } = mapped;
      const specStage = isSpecStagePhase(task.phase);
      const interventionKindLabel: string | undefined =
        expectedKinds.length === 0 ? undefined
        : specStage && task.status === 'review' ? 'spec-reviewed'
        : specStage && task.status === 'fixing' ? 'spec-fixed'
        : !specStage && task.status === 'review' ? 'pr-verdict-comment'
        : !specStage && task.status === 'fixing' ? 'pr-fixed'
        : undefined;
      const isServerProtocol = task.reviewMode === 'server' || specStage;
      const scanSnapshotOnRecover = isServerProtocol
        || (task.phase === undefined && task.status === 'in_progress')
        || (!specStage && (task.status === 'review' || task.status === 'fixing'));
      const allowRecoveredReadFile = task.status === 'review'
        && (specStage
          || (task.reviewMode === 'server' && task.batchTotal !== undefined)
          || (task.reviewMode === 'server' && task.reviewCheckoutMode === 'base'));
      try {
        await this.startPhaseSignalWatch({
          taskId: task.id,
          projectId: task.projectId,
          agentId,
          expectedKinds,
          token: signalToken,
          skipSnapshot: !scanSnapshotOnRecover,
          recovered: true,
          ...(hasSiblings ? { replaceScope: 'agent' as const } : {}),
          ...(allowRecoveredReadFile
            ? { onReadFile: (req: ReadFileSignal) => { void this.handleReadFileRequest(task.id, agentId, req); } }
            : {}),
        });
        if (interventionKindLabel) {
          await this.emitIntervention(task.projectId, agentId, task.id, {
            phase: 'spec-signal-setup-during-recovery',
            kind: interventionKindLabel,
            note: 'Task is waiting for a spec signal after server recovery; if no signal arrives, the prompt may not have been fully delivered before the previous crash. Inspect the agent pane and consider manual retry or transition.',
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

  async verifyPaneSignalPrNumber(
    taskId: string,
    prNumber: number,
  ): Promise<{ headRefName: string; headSha: string; targetBranch: string } | undefined> {
    const task = await this.taskStore.get(taskId);
    if (!task || !task.branch) return undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        const verified = await this.platformVerifyPrBinding(taskId, prNumber);
        if (!verified.ok) return undefined;
        return {
          headRefName: verified.branch,
          headSha: verified.headSha,
          targetBranch: verified.targetBranch,
        };
      } catch (err) {
        const transient = err instanceof DriverOpError
          && (err.info.exitCode === 255
            || isTransientNetworkFailure(err.message)
            || isTransientNetworkFailure(err.info.stderrTail ?? ''));
        if (!transient || attempt >= 2) throw err;
        await new Promise(resolve => setTimeout(resolve, this.platformVerificationRetryDelayMs));
      }
    }
  }

  // 创建期快照（spec §4）：git 任务在建任务那一刻定身份。
  platformBindingFields(projectId: string): Partial<TaskState> {
    return this.effectiveReviewMode(projectId) === 'git'
      ? { platformBinding: this.platformBindingFor(projectId) }
      : {};
  }

  private platformBindingFor(projectId: string): NonNullable<TaskState['platformBinding']> {
    const project = this.getProjectConfig(projectId);
    if (!project) throw new Error(`project ${projectId} not found while capturing platform binding`);
    const tool = resolveProjectTool(project);
    if (tool === undefined) throw new Error(`project ${projectId} has no resolved platform tool`);
    return {
      mode: this.effectiveReviewMode(projectId),
      repoKey: repoIdentityKey(project.repo),
      tool,
    };
  }

  // agent 面一律 PATH 解析 tool；server 面 binary/env 不进入该轨。
  agentGitPreflightContext(projectId: string): AgentGitPreflight | undefined {
    if (this.effectiveReviewMode(projectId) !== 'git') return undefined;
    const project = this.getProjectConfig(projectId);
    if (!project || !this.pluginRegistry) return undefined;
    const tool = resolveProjectTool(project);
    if (tool === undefined) return undefined;
    const plugin = this.pluginRegistry.resolveTool(tool);
    if (plugin === undefined) return undefined;
    const renderCtx = buildDriverRunContext(project.repo, tool);
    return {
      tool,
      minToolVersion: plugin.manifest.minToolVersion,
      steps: plugin.spec.preflight,
      agentCommands: plugin.spec.agentCommands,
      renderCtx,
      driverFor: (exec) => new GitDriver(plugin, renderCtx, exec),
    };
  }

  // cli 字段族每次派发实时渲染，不做创建时快照。渲染前按持久化 binding 校验身份——
  // 离线漂移的配置会把旧任务的 PR 号/分支/令牌带到新仓库，与平台操作同一守卫。
  platformCliContextOf(task: TaskState): PlatformCliDescriptor | undefined {
    if (task.reviewMode !== 'git') return undefined;
    this.assertPlatformBinding(task);
    const project = this.getProjectConfig(task.projectId);
    if (!project) return undefined;
    const tool = resolveProjectTool(project);
    if (tool === undefined) return undefined;
    const ctx = buildDriverRunContext(project.repo, tool);
    return {
      tool,
      host: ctx.host,
      repo: ctx.repoPath,
      repoEncoded: encodeURIComponent(ctx.repoPath),
      ...(project.gitCli?.notes !== undefined ? { notes: project.gitCli.notes } : {}),
    };
  }

  // base 快照一经持久化不可变；无快照保持缺省，由 agent 现场显式查询。
  async ensureGitBaseSnapshot(task: TaskState, phase: string): Promise<TaskState> {
    if (task.reviewMode !== 'git' || (phase !== 'develop' && phase !== 'code')) return task;
    if (task.baseBranch !== undefined) return task;
    // 读默认分支与落快照都以 binding 为前提：失配任务先写入新仓库的 base 会永久污染不可变快照
    this.assertPlatformBinding(task);
    const base = this.platformDefaultBranchOf?.(task.projectId);
    if (base === undefined) return task;
    return this.withTaskLock(async () => {
      const fresh = await this.taskStore.get(task.id);
      if (!fresh) return task;
      if (fresh.baseBranch !== undefined) return fresh;
      this.assertPlatformBinding(fresh);
      const next = { ...fresh, baseBranch: base, updatedAt: new Date().toISOString() };
      await this.taskStore.set(next);
      return next;
    });
  }

  async noteReviewConversationRevision(taskId: string): Promise<void> {
    await this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task || TERMINAL_STATUSES.includes(task.status)) return;
      const now = new Date().toISOString();
      await this.taskStore.set({ ...task, reviewConversationUpdatedAt: now, updatedAt: now });
    });
  }

  private assertPlatformBinding(task: TaskState): void {
    const mismatch = platformBindingMismatch(this.config, task);
    if (mismatch === undefined) return;
    void this.emitPlatformBindingIntervention(task, mismatch);
    if (mismatch.reason === 'missing-binding-snapshot') {
      throw new Error(`platform binding missing for task ${task.id}; refusing platform operations`);
    }
    throw new Error(
      `platform binding mismatch for task ${task.id}: ${mismatch.reason} (${mismatch.differences.join(', ')})`,
    );
  }

  private async platformTaskAndDriver(taskId: string): Promise<{ task: TaskState; driver: GitDriver }> {
    const task = await this.taskStore.get(taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    this.assertPlatformBinding(task);
    const driver = this.platformDriverFor(task.projectId);
    if (!driver) throw new Error(`no git driver resolvable for project ${task.projectId}`);
    return { task, driver };
  }

  // 配置锁也覆盖终态任务尚未完成的远端清理；否则 cancel 落 intent 后即可改写/删除其 binding。
  async listActiveGitTasks(projectId?: string): Promise<TaskState[]> {
    const tasks = await this.taskStore.listStrict(projectId !== undefined ? { projectId } : undefined);
    return tasks.filter(t =>
      (t.remoteCleanup !== undefined && t.remoteCleanup.stage !== 'manual')
      || (!TERMINAL_STATUSES.includes(t.status) && taskNeedsPlatformBindingAudit(t)));
  }

  async platformFetchPrView(taskId: string): Promise<NormalizedRow> {
    const { task, driver } = await this.platformTaskAndDriver(taskId);
    if (task.prNumber === undefined) throw new Error(`task ${taskId} has no bound PR`);
    const [row] = await driver.runOp('prView', { prNumber: task.prNumber });
    return row!;
  }

  // git 模式的 head 刷新一律经任务解析出的 driver（spec §4 两执行面）：QA checkout 的
  // moved-head fallback 不得旁路到硬编码 gh，否则自定义/非 github driver 会错误调用 gh。
  async platformFetchPrHeadSha(taskId: string): Promise<string> {
    const headSha = String((await this.platformFetchPrView(taskId)).headSha);
    if (!PLATFORM_HEAD_SHA_RE.test(headSha)) {
      throw new Error(`prView returned an invalid head sha for task ${taskId}`);
    }
    return headSha;
  }

  async platformVerifyPrBinding(
    taskId: string,
    prNumber: number,
    opts: { branchOverride?: string } = {},
  ): Promise<
    { ok: true; headSha: string; branch: string; targetBranch: string }
    | { ok: false; reason: PrRejection; prBranch?: string }
  > {
    const { task, driver } = await this.platformTaskAndDriver(taskId);
    const [row] = await driver.runOp('prView', { prNumber });
    let expectedBase = task.baseBranch;
    if (expectedBase === undefined) {
      const [project] = await driver.runOp('projectView');
      if (typeof project?.defaultBranch === 'string') expectedBase = project.defaultBranch;
    }
    const check = checkOpenPrBinding(row!, { branch: opts.branchOverride ?? task.branch, expectedBase });
    if (!check.ok) {
      return {
        ...check,
        ...(check.reason === 'branch' && typeof row!.branch === 'string' ? { prBranch: row!.branch } : {}),
      };
    }
    return {
      ok: true,
      headSha: String(row!.headSha),
      branch: String(row!.branch),
      targetBranch: String(row!.targetBranch),
    };
  }

  stopPhaseSignalWatcherAgent(taskId: string, agentId: string): void {
    this.phaseSignalWatcher?.stopAgent(taskId, agentId);
  }

  private async mutateRemoteCleanup(
    taskId: string,
    generation: string,
    mutate: (intent: RemoteCleanupState) => RemoteCleanupState | undefined,
  ): Promise<TaskState | null> {
    let context: Pick<TaskState, 'projectId' | 'agentId'> | undefined;
    try {
      return await this.withTaskLock(async () => {
        const task = await this.taskStore.get(taskId);
        if (!task?.remoteCleanup || task.remoteCleanup.generation !== generation) return null;
        context = task;
        const nextIntent = mutate(task.remoteCleanup);
        if (nextIntent === task.remoteCleanup) return task;
        const now = new Date().toISOString();
        const next = { ...task, updatedAt: now };
        if (nextIntent === undefined) delete next.remoteCleanup;
        else next.remoteCleanup = { ...nextIntent, updatedAt: now };
        await this.taskStore.set(next);
        return next;
      });
    } catch (err) {
      await this.emitIntervention(context?.projectId ?? '', context?.agentId || undefined, taskId, {
        phase: 'remote-cleanup-persist-failed', generation,
        error: safeDriverErrorText(err),
      });
      throw err;
    }
  }

  private async recordRemoteCleanupFailure(
    task: TaskState,
    generation: string,
    kind: NonNullable<RemoteCleanupState['failure']>['kind'],
    message: string,
  ): Promise<void> {
    const at = new Date().toISOString();
    let changed = false;
    const updated = await this.mutateRemoteCleanup(task.id, generation, intent => {
      if (intent.failure?.kind === kind && intent.failure.message === message) return intent;
      changed = true;
      return { ...intent, failure: { kind, message, at } };
    });
    if (!updated || !changed) return;
    await this.emitIntervention(task.projectId, task.agentId || undefined, task.id, {
      phase: 'remote-cleanup-failed', generation, stage: updated.remoteCleanup?.stage, kind, message,
    });
  }

  private async markRemoteCleanupManual(
    task: TaskState,
    generation: string,
    kind: NonNullable<RemoteCleanupState['failure']>['kind'],
    message: string,
  ): Promise<void> {
    let changed = false;
    const manual = await this.mutateRemoteCleanup(task.id, generation, current => {
      if (current.stage === 'manual') return current;
      changed = true;
      return {
        ...current,
        stage: 'manual',
        failure: { kind, message, at: new Date().toISOString() },
      };
    });
    if (!manual || !changed) return;
    await this.emitIntervention(task.projectId, task.agentId || undefined, task.id, {
      phase: 'remote-cleanup-manual', generation, kind, reason: message,
    });
  }

  async processGitRemoteCleanup(taskId: string, expectedGeneration?: string): Promise<void> {
    const snapshot = await this.taskStore.get(taskId);
    const snapshotIntent = snapshot?.remoteCleanup;
    if (!snapshot || snapshot.reviewMode !== 'git' || !snapshotIntent || snapshotIntent.stage === 'manual') return;
    if (expectedGeneration !== undefined && snapshotIntent.generation !== expectedGeneration) return;
    const generation = snapshotIntent.generation;

    const mismatch = platformBindingMismatch(this.config, snapshot);
    if (mismatch !== undefined) {
      const kind = mismatch.reason === 'project-missing' ? 'config' : 'binding';
      await this.markRemoteCleanupManual(
        snapshot,
        generation,
        kind,
        `${mismatch.reason}${mismatch.differences.length > 0 ? ` (${mismatch.differences.join(', ')})` : ''}`,
      );
      return;
    }
    let driver: GitDriver | undefined;
    try {
      driver = this.platformDriverFor(snapshot.projectId);
    } catch (err) {
      await this.markRemoteCleanupManual(snapshot, generation, 'config', safeDriverErrorText(err));
      return;
    }
    if (!driver) {
      await this.markRemoteCleanupManual(
        snapshot,
        generation,
        'config',
        `no git driver resolvable for project ${snapshot.projectId}`,
      );
      return;
    }
    let task = snapshot;
    let intent = task.remoteCleanup;
    if (!intent || intent.generation !== generation || intent.stage === 'manual') return;

    if (intent.stage === 'close-pending') {
      let pr: NormalizedRow;
      let project: NormalizedRow;
      try {
        [pr] = await driver.runOp('prView', { prNumber: intent.prNumber });
        [project] = await driver.runOp('projectView');
      } catch (err) {
        if (err instanceof DriverOpError
          && (err.info.errorClass === 'NOT_FOUND' || err.info.errorClass === 'ACCESS_DENIED')) {
          await this.markRemoteCleanupManual(task, generation, 'probe', safeDriverErrorText(err));
          return;
        }
        await this.recordRemoteCleanupFailure(task, generation, 'probe', safeDriverErrorText(err));
        throw err;
      }
      const remoteProjectId = typeof project!.remoteProjectId === 'string'
        ? project!.remoteProjectId : undefined;
      const binding = checkPrBinding(pr!, {
        branch: intent.branch,
        expectedBase: task.baseBranch,
        defaultBranch: typeof project!.defaultBranch === 'string' ? project!.defaultBranch : undefined,
      });
      if (!remoteProjectId || binding !== undefined) {
        let reason = 'projectView did not return remoteProjectId';
        if (remoteProjectId && binding) {
          reason = `PR binding ${binding.kind === 'mismatch' ? binding.mismatch : 'unverifiable'}`;
        }
        await this.markRemoteCleanupManual(task, generation, 'binding', reason);
        return;
      }
      const staticOwnership = isAutoDeletableTaskBranch({
        taskId: task.id,
        taskBranch: intent.branch,
        branchCreatedByBaxian: task.branchCreatedByBaxian,
      });
      const liveHead = typeof pr!.headSha === 'string' && PLATFORM_HEAD_SHA_RE.test(pr!.headSha)
        ? pr!.headSha : undefined;
      const expectedHeadSha = intent.expectedHeadSha;
      const deleteEligible = staticOwnership && expectedHeadSha !== undefined && liveHead === expectedHeadSha;
      const tipChanged = staticOwnership && !deleteEligible;

      const credentialed = await this.mutateRemoteCleanup(taskId, generation, current => {
        if (current.stage !== 'close-pending') return current;
        return { ...current, remoteProjectId };
      });
      if (!credentialed?.remoteCleanup || credentialed.remoteCleanup.stage !== 'close-pending') return;
      task = credentialed;
      intent = credentialed.remoteCleanup;

      try {
        await driver.runOp('close', { prNumber: intent.prNumber });
      } catch (err) {
        if (err instanceof DriverOpError
          && (err.info.errorClass === 'NOT_FOUND' || err.info.errorClass === 'ACCESS_DENIED')) {
          await this.markRemoteCleanupManual(task, generation, 'close', safeDriverErrorText(err));
          return;
        }
        await this.recordRemoteCleanupFailure(task, generation, 'close', safeDriverErrorText(err));
        throw err;
      }

      try {
        await this.eventBus.emit({
          id: `outbox:${task.id}:${intent.prNumber}:remote-pr-closed:${generation}`,
          type: 'task.updated',
          timestamp: new Date().toISOString(),
          projectId: task.projectId,
          taskId: task.id,
          data: {
            status: task.status,
            operation: 'git-pr-close',
            outcome: 'succeeded',
            generation,
            prNumber: intent.prNumber,
            ...(task.prUrl !== undefined ? { prUrl: task.prUrl } : {}),
            branch: intent.branch,
            remoteProjectId,
          },
        });
      } catch (err) {
        await this.recordRemoteCleanupFailure(task, generation, 'persist', safeDriverErrorText(err));
        throw err;
      }

      if (tipChanged) {
        const message = expectedHeadSha === undefined
          ? 'automatic branch deletion has no trusted expected head'
          : `branch head changed from ${expectedHeadSha} to ${liveHead ?? 'unverifiable'}`;
        await this.markRemoteCleanupManual(task, generation, 'tip-changed', message);
        return;
      }
      if (!deleteEligible) {
        await this.mutateRemoteCleanup(taskId, generation, () => undefined);
        return;
      }
      const pending = await this.mutateRemoteCleanup(taskId, generation, current => ({
        ...current,
        stage: 'delete-pending',
        expectedHeadSha,
        remoteProjectId,
        failure: undefined,
      }));
      if (!pending?.remoteCleanup || pending.remoteCleanup.stage !== 'delete-pending') return;
      task = pending;
      intent = pending.remoteCleanup;
    }

    if (intent.stage !== 'delete-pending'
      || intent.expectedHeadSha === undefined || intent.remoteProjectId === undefined) return;
    let mutationError: unknown;
    try {
      await driver.runOp('deleteBranch', {
        branch: intent.branch,
        expectedHeadSha: intent.expectedHeadSha,
        remoteProjectId: intent.remoteProjectId,
      });
    } catch (err) {
      mutationError = err;
    }

    let branch: NormalizedRow;
    try {
      [branch] = await driver.runOp('branchView', {
        branch: intent.branch,
        remoteProjectId: intent.remoteProjectId,
      });
    } catch (err) {
      const mutation = mutationError === undefined ? '' : `; delete attempt: ${safeDriverErrorText(mutationError)}`;
      await this.recordRemoteCleanupFailure(task, generation, 'probe', `${safeDriverErrorText(err)}${mutation}`);
      throw err;
    }
    if (branch!.remoteProjectId !== intent.remoteProjectId) {
      const message = `branchView repository id changed from ${intent.remoteProjectId} to ${String(branch!.remoteProjectId)}`;
      await this.markRemoteCleanupManual(task, generation, 'binding', message);
      return;
    }
    if (branch!.headSha === undefined) {
      await this.mutateRemoteCleanup(taskId, generation, () => undefined);
      return;
    }
    if (typeof branch!.headSha !== 'string' || !PLATFORM_HEAD_SHA_RE.test(branch!.headSha)) {
      const message = `branchView returned an invalid head ${String(branch!.headSha)}`;
      await this.recordRemoteCleanupFailure(task, generation, 'probe', message);
      throw new Error(message);
    }
    if (branch!.headSha !== intent.expectedHeadSha) {
      const message = `branch head changed from ${intent.expectedHeadSha} to ${branch!.headSha}`;
      await this.markRemoteCleanupManual(task, generation, 'tip-changed', message);
      return;
    }
    const message = mutationError === undefined
      ? 'conditional delete returned success but branchView still sees the expected head'
      : safeDriverErrorText(mutationError);
    await this.recordRemoteCleanupFailure(task, generation, 'delete', message);
    throw mutationError instanceof Error ? mutationError : new Error(message);
  }

  private async platformScanComments(driver: GitDriver, prNumber: number): Promise<VerdictSourceScan[]> {
    return scanCommentSourcesOnce(driver, prNumber, () => Date.now());
  }

  async platformVerifyAcceptedPass(taskId: string): Promise<
    | { kind: 'valid'; pendingCount: number }
    | { kind: 'retryable'; reason: string }
    | { kind: 'provenance-invalid'; reason: string }
  > {
    const { task, driver } = await this.platformTaskAndDriver(taskId);
    if (task.prNumber === undefined) return { kind: 'provenance-invalid', reason: 'no bound PR' };
    const provenance = task.passProvenance;
    if (!provenance) return { kind: 'provenance-invalid', reason: 'no accepted pass provenance' };
    const scans = await this.platformScanComments(driver, task.prNumber);
    const recheck = recheckPassProvenance({
      token: provenance.token,
      failToken: provenance.failToken,
      anchorSha: provenance.anchorSha,
      carrier: { sourceKey: provenance.sourceKey, id: provenance.id, bodyDigest: provenance.bodyDigest },
    }, scans);
    if (!recheck.ok) {
      return recheck.reason === 'source-scan-incomplete'
        ? { kind: 'retryable', reason: recheck.reason }
        : { kind: 'provenance-invalid', reason: `provenance ${recheck.reason}` };
    }
    const pending = collectPendingFeedback(scans, {
      replyActorId: task.replyActorId,
      replyActorStatus: task.replyActorStatus,
    });
    if (!pending.allSourcesOk) return { kind: 'retryable', reason: 'source scan incomplete' };
    return { kind: 'valid', pendingCount: pending.pending.size };
  }

  async platformPendingFeedback(taskId: string): Promise<PendingFeedbackResult> {
    const { task, driver } = await this.platformTaskAndDriver(taskId);
    if (task.prNumber === undefined) throw new Error(`task ${taskId} has no bound PR`);
    const scans = await this.platformScanComments(driver, task.prNumber);
    const failed = scans.filter(s => !s.ok).map(s => s.key);
    if (failed.length > 0) {
      throw new Error(`pending-feedback scan incomplete; failed sources: ${failed.join(', ')}`);
    }
    return collectPendingFeedback(scans, {
      replyActorId: task.replyActorId,
      replyActorStatus: task.replyActorStatus,
    });
  }

  async platformConfirmMerge(
    taskId: string,
    opts: { expectedHeadSha: string; humanOverride?: boolean },
  ): Promise<void> {
    const { task, driver } = await this.platformTaskAndDriver(taskId);
    if (task.prNumber === undefined) throw new Error(`task ${taskId} has no bound PR`);
    const prNumber = task.prNumber;
    const [row] = await driver.runOp('prView', { prNumber });
    const binding = checkOpenPrBinding(row!, { branch: task.branch, expectedBase: task.baseBranch });
    if (!binding.ok) throw new Error(`merge blocked: binding ${binding.reason}`);
    if (String(row!.headSha) !== opts.expectedHeadSha) {
      throw new Error(`merge blocked: head moved (expected ${opts.expectedHeadSha}, saw ${String(row!.headSha)})`);
    }
    if (task.reviewMode === 'git' && opts.humanOverride !== true) {
      const provenance = task.passProvenance;
      if (!provenance) {
        throw new PlatformMergeRecheckError('provenance-invalid', 'no accepted pass provenance on task');
      }
      if (provenance.anchorSha.toLowerCase() !== opts.expectedHeadSha.toLowerCase()) {
        throw new PlatformMergeRecheckError(
          'provenance-invalid',
          `pass provenance anchors ${provenance.anchorSha}, not the merge head ${opts.expectedHeadSha}`,
        );
      }
      const scans = await this.platformScanComments(driver, prNumber);
      const recheck = recheckPassProvenance({
        token: provenance.token,
        failToken: provenance.failToken,
        anchorSha: provenance.anchorSha,
        carrier: { sourceKey: provenance.sourceKey, id: provenance.id, bodyDigest: provenance.bodyDigest },
      }, scans);
      if (!recheck.ok) {
        if (recheck.reason === 'source-scan-incomplete') {
          throw new Error('merge blocked: provenance source-scan-incomplete');
        }
        throw new PlatformMergeRecheckError('provenance-invalid', `provenance ${recheck.reason}`);
      }
      const pending = collectPendingFeedback(scans, {
        replyActorId: task.replyActorId,
        replyActorStatus: task.replyActorStatus,
      });
      if (!pending.allSourcesOk) throw new Error('merge blocked: pending-feedback scan incomplete');
      if (pending.pending.size > 0) {
        throw new PlatformMergeRecheckError(
          'pending-feedback',
          `${pending.pending.size} pending feedback revision(s) without ack`,
        );
      }
    }
    const fresh = await this.taskStore.get(taskId);
    if (!fresh
      || (opts.humanOverride === true
        ? fresh.status !== 'merge-ready'
        : (fresh.status !== 'merge-ready' && fresh.status !== 'ready'))
      || fresh.latestHeadSha !== opts.expectedHeadSha
      || fresh.signalToken !== task.signalToken
      || fresh.pendingRedispatch === true) {
      throw new Error(`merge blocked: task left its merge gate (status=${fresh?.status ?? 'gone'})`);
    }
    try {
      await driver.runOp('merge', { prNumber, expectedHeadSha: opts.expectedHeadSha });
    } catch (err) {
      if (err instanceof DriverOpError && err.info.errorClass === 'MERGE_BLOCKED') {
        let mergeStatus: string | undefined;
        try {
          const [fresh] = await driver.runOp('prView', { prNumber });
          if (typeof fresh?.detailedMergeStatus === 'string') mergeStatus = fresh.detailedMergeStatus;
        } catch {
        }
        throw new Error(`merge blocked by platform${mergeStatus ? ` (${mergeStatus})` : ''}: ${err.message}`);
      }
      throw err;
    }
  }

  mintReviewTokenPair(): { passToken: string; failToken: string } {

    const passToken = createSignalToken();
    let failToken = createSignalToken();
    while (failToken === passToken) failToken = createSignalToken();
    return { passToken, failToken };
  }

  private taskBelongsToPlatformEntry(
    task: TaskState,
    entryBinding: NonNullable<TaskState['platformBinding']>,
  ): boolean {
    const binding = task.platformBinding;
    return binding !== undefined
      && binding.mode === entryBinding.mode
      && binding.repoKey === entryBinding.repoKey
      && binding.tool === entryBinding.tool;
  }

  async listTasksForPlatformEntry(projectId: string): Promise<TaskState[]> {
    const project = this.getProjectConfig(projectId);
    if (project === undefined) return [];
    const key = repoIdentityKey(project.repo);
    const entryBinding: NonNullable<TaskState['platformBinding']> = {
      mode: this.effectiveReviewMode(projectId),
      repoKey: key,
      tool: resolveProjectTool(project) ?? '',
    };
    const ids = new Set(this.config.project.filter(p => repoIdentityKey(p.repo) === key).map(p => p.id));
    const tasks = await this.taskStore.listStrict();
    return tasks.filter(task => ids.has(task.projectId)
      && this.taskBelongsToPlatformEntry(task, entryBinding));
  }

  async findTaskByBranch(branch: string, projectId: string): Promise<TaskState | undefined> {
    const repoKey = this.projectRepoKey(projectId);
    if (!repoKey) return undefined;
    const all = await this.taskStore.list();
    return all.find(t =>
      t.branch === branch && this.projectRepoKey(t.projectId) === repoKey,
    );
  }

  async adoptServerPr(
    taskId: string,
    pr: { prNumber: number; prUrl?: string; headSha?: string; targetBranch?: string },
  ): Promise<boolean> {
    return this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task || task.reviewMode !== 'server' || task.afterDone !== 'pr'
        || task.platformBinding === undefined || TERMINAL_STATUSES.includes(task.status)) return false;
      if (task.prNumber !== undefined && task.prNumber !== pr.prNumber) return false;
      await this.taskStore.set({
        ...task,
        prNumber: pr.prNumber,
        ...(pr.prUrl !== undefined ? { prUrl: pr.prUrl } : {}),
        ...(pr.headSha !== undefined ? { latestHeadSha: pr.headSha } : {}),
        ...(task.baseBranch === undefined && pr.targetBranch !== undefined
          ? { baseBranch: pr.targetBranch }
          : {}),
        updatedAt: new Date().toISOString(),
      });
      return true;
    });
  }

  async updateTaskIfStatus(
    taskId: string,
    expectedStatus: TaskStatus,
    updates: Partial<TaskState>,
    alsoExpect: Partial<Pick<TaskState, 'signalToken' | 'phase' | 'reviewRound' | 'specReviewRound'>> = {},
  ): Promise<boolean> {
    return this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task || task.status !== expectedStatus) return false;
      if ('signalToken' in alsoExpect && task.signalToken !== alsoExpect.signalToken) return false;
      if ('phase' in alsoExpect && task.phase !== alsoExpect.phase) return false;
      if ('reviewRound' in alsoExpect && task.reviewRound !== alsoExpect.reviewRound) return false;
      if ('specReviewRound' in alsoExpect && task.specReviewRound !== alsoExpect.specReviewRound) return false;
      Object.assign(task, updates, { updatedAt: new Date().toISOString() });
      await this.taskStore.set(task);
      return true;
    });
  }

  async claimServerSignalRecovery(
    taskAtEntry: TaskState,
    agentId: string,
    signalKind: ServerSignalKind,
    input: Omit<ServerSignalRecovery, 'signalKind' | 'sourceToken' | 'createdAt'>,
  ): Promise<TaskState | null> {
    const sourceToken = taskAtEntry.signalToken;
    if (!sourceToken) return null;
    const currentRound = input.phase === 'spec'
      ? (taskAtEntry.specReviewRound ?? 0)
      : taskAtEntry.reviewRound;
    const phaseMatches = input.phase === 'spec'
      ? taskAtEntry.phase !== 'code'
      : taskAtEntry.phase === 'code' || taskAtEntry.phase === undefined;
    if (!phaseMatches || input.round !== currentRound) return null;
    let successorToken = createSignalToken();
    while (successorToken === sourceToken) successorToken = createSignalToken();
    const recovery: ServerSignalRecovery = {
      ...input,
      signalKind,
      sourceToken,
      missingFindingIds: [...(input.missingFindingIds ?? [])].sort(),
      unknownFindingIds: [...(input.unknownFindingIds ?? [])].sort(),
      schemaViolationCodes: [...(input.schemaViolationCodes ?? [])].sort(),
      createdAt: new Date().toISOString(),
    };
    const expectedRound = input.phase === 'spec'
      ? { specReviewRound: taskAtEntry.specReviewRound }
      : { reviewRound: taskAtEntry.reviewRound };
    const claimed = await this.updateTaskIfStatus(
      taskAtEntry.id,
      taskAtEntry.status,
      {
        signalToken: successorToken,
        serverSignalRecovery: recovery,
        ...(taskAtEntry.status === 'fixing' ? { fixDispatchedAt: new Date().toISOString() } : {}),
      },
      {
        signalToken: sourceToken,
        phase: taskAtEntry.phase,
        ...expectedRound,
      },
    );
    if (!claimed) return null;
    if (agentId) this.phaseSignalWatcher?.stopAgentIfToken(taskAtEntry.id, agentId, sourceToken);
    else this.phaseSignalWatcher?.stopIfToken(taskAtEntry.id, sourceToken);
    const fresh = await this.taskStore.get(taskAtEntry.id);
    if (fresh?.signalToken !== successorToken
      || fresh.serverSignalRecovery?.sourceToken !== sourceToken
      || fresh.serverSignalRecovery.signalKind !== signalKind) {
      return null;
    }
    if (input.mode === 'hold' && agentId) {
      const holdPhase = input.failurePhase ?? `server-signal-${input.reason}`;
      const held = await this.markAwaitingHuman(
        agentId,
        holdPhase,
        `The ${signalKind} marker was consumed but could not be completed (${input.reason}). `
        + 'The old token is retired. Restart or cancel the task after resolving the reported cause.',
        { expectedTaskId: taskAtEntry.id },
      );
      if (!held) {
        console.error(
          `[AgentManager] failed to hold ${agentId} for consumed ${signalKind} on ${taskAtEntry.id}; `
          + `recovery=${successorToken}`,
        );
      }
    }
    return fresh;
  }

  async holdConsumedServerSignal(
    taskAtEntry: TaskState,
    agentId: string,
    signalKind: ServerSignalKind,
    input: {
      phase: 'spec' | 'code';
      round: number;
      reason: ServerSignalRecoveryReason;
      failurePhase: string;
    },
  ): Promise<TaskState | null> {
    return this.claimServerSignalRecovery(taskAtEntry, agentId, signalKind, {
      mode: 'hold',
      ...input,
    });
  }

  async setServerSignalRecoveryMode(
    taskId: string,
    successorToken: string,
    mode: 'correct-response' | 'hold',
  ): Promise<TaskState | null> {
    const task = await this.taskStore.get(taskId);
    const recovery = task?.serverSignalRecovery;
    if (!task || !recovery || task.signalToken !== successorToken) return null;
    const currentRound = recovery.phase === 'spec' ? (task.specReviewRound ?? 0) : task.reviewRound;
    const phaseMatches = recovery.phase === 'spec'
      ? task.phase !== 'code'
      : task.phase === 'code' || task.phase === undefined;
    if (!phaseMatches || currentRound !== recovery.round) return null;
    const expectedRound = recovery.phase === 'spec'
      ? { specReviewRound: task.specReviewRound }
      : { reviewRound: task.reviewRound };
    const updated = await this.updateTaskIfStatus(
      taskId,
      task.status,
      { serverSignalRecovery: { ...recovery, mode } },
      {
        signalToken: successorToken,
        phase: task.phase,
        ...expectedRound,
      },
    );
    if (!updated) return null;
    const fresh = await this.taskStore.get(taskId);
    if (fresh?.signalToken !== successorToken
      || fresh.serverSignalRecovery?.mode !== mode
      || fresh.serverSignalRecovery.sourceToken !== recovery.sourceToken) {
      return null;
    }
    return fresh;
  }

  async holdServerSignalRecovery(
    taskId: string,
    agentId: string,
    successorToken: string,
    holdPhase: string,
    reason: string,
  ): Promise<TaskState | null> {
    const task = await this.setServerSignalRecoveryMode(taskId, successorToken, 'hold');
    if (!task) return null;
    this.phaseSignalWatcher?.stopAgentIfToken(taskId, agentId, successorToken);
    if (agentId) {
      const held = await this.markAwaitingHuman(agentId, holdPhase, reason, { expectedTaskId: taskId });
      if (!held) {
        console.error(`[AgentManager] failed to hold ${agentId} for recovery ${taskId}/${successorToken}`);
      }
    }
    return task;
  }

  async dispatchServerFeedbackCorrection(taskId: string, findingsJson: string): Promise<boolean> {
    const task = await this.taskStore.get(taskId);
    const recovery = task?.serverSignalRecovery;
    if (!task || !recovery || recovery.mode !== 'correct-response' || !task.signalToken) return false;
    const agentId = task.agentId;
    const successorToken = task.signalToken;
    if (!agentId || !this.getAgentConfig(agentId)) {
      await this.holdServerSignalRecovery(
        taskId,
        agentId,
        successorToken,
        `server-${recovery.phase}-feedback-correction-no-dev`,
        'The response was rejected, but the correction prompt cannot be delivered because the dev agent is unavailable.',
      );
      return false;
    }
    const stillCurrent = async (): Promise<boolean> => {
      const fresh = await this.taskStore.get(taskId);
      const current = fresh?.serverSignalRecovery;
      const round = recovery.phase === 'spec' ? (fresh?.specReviewRound ?? 0) : fresh?.reviewRound;
      return fresh?.status === task.status
        && fresh.phase === task.phase
        && fresh.signalToken === successorToken
        && round === recovery.round
        && current?.mode === 'correct-response'
        && current.sourceToken === recovery.sourceToken
        && current.failureSignature === recovery.failureSignature;
    };
    try {
      const delivered = await this.continueSession(taskId, agentId, 'server-feedback', {
        allowDirtyWorkdir: true,
        signalToken: successorToken,
        serverPriorFindings: findingsJson,
        serverFindingsDigest: recovery.findingsDigest,
        serverFeedbackCorrection: {
          reason: recovery.reason,
          missingFindingIds: recovery.missingFindingIds,
          unknownFindingIds: recovery.unknownFindingIds,
          schemaViolationCodes: recovery.schemaViolationCodes,
        },
        ...(recovery.phase === 'spec' ? { currentSpecRound: recovery.round } : {}),
        armBeforeInject: () => this.setupPhaseSignalWatcher(
          taskId,
          agentId,
          recovery.signalKind,
          successorToken,
          {
            skipSnapshot: true,
            onlyReplaceOwnToken: true,
            replaceFromToken: recovery.sourceToken,
            needInputMode: 'fresh',
          },
        ),
        guardBeforeInject: stillCurrent,
      });
      if (!delivered) throw new Error('correction prompt was not delivered');
      const cleared = await this.updateTaskIfStatus(
        taskId,
        task.status,
        { serverSignalRecovery: undefined },
        {
          signalToken: successorToken,
          phase: task.phase,
          ...(recovery.phase === 'spec'
            ? { specReviewRound: task.specReviewRound }
            : { reviewRound: task.reviewRound }),
        },
      );
      if (!cleared && await stillCurrent()) {
        throw new Error('correction prompt delivered but recovery intent could not be cleared');
      }
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const held = await this.holdServerSignalRecovery(
        taskId,
        agentId,
        successorToken,
        `server-${recovery.phase}-feedback-correction-failed`,
        `${message}. The old token remains retired; Restart or Cancel the task.`,
      );
      if (!held) return false;
      await this.emitIntervention(task.projectId, agentId, taskId, {
        phase: `server-${recovery.phase}-feedback-correction-failed`,
        error: message,
        successorToken,
      });
      return false;
    }
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
    guard: {
      fromStatus: TaskStatus[];
      expectSignalToken?: string;
      expectPhase?: TaskPhase;
      expectPostApproveEpisode?: PostApproveEpisodeKey;
      expectReviewDispatch?: ReviewDispatchFence;
    },
    patch?: Partial<Pick<
      TaskState,
      | 'reviewRound'
      | 'agentId'
      | 'prNumber'
      | 'prUrl'
      | 'qaAgentId'
      | 'latestHeadSha'
      | 'reviewHeadAnchorSha'
      | 'reviewDispatchedAt'
      | 'fixDispatchedAt'
      | 'specReviewRound'
      | 'signalToken'
      | 'passToken'
      | 'failToken'
      | 'reviewRoundPending'
      | 'reviewDispatch'
      | 'phase'
      | 'batchIndex'
      | 'batchTotal'
      | 'branch'
      | 'maxRoundsContinues'
    >>,
  ): Promise<TransitionResult | null> {
    return this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task) return null;
      const previousStatus = task.status;
      if (TERMINAL_STATUSES.includes(previousStatus)) return null;
      if (!guard.fromStatus.includes(previousStatus)) return null;
      if (Object.hasOwn(guard, 'expectSignalToken') && task.signalToken !== guard.expectSignalToken) return null;
      if (Object.hasOwn(guard, 'expectPhase') && task.phase !== guard.expectPhase) return null;
      if (guard.expectPostApproveEpisode !== undefined
        && !this.postApproveEpisodeMatches(task, guard.expectPostApproveEpisode)) return null;
      if (guard.expectReviewDispatch !== undefined
        && !this.gitReviewDispatchMatches(task, guard.expectReviewDispatch)) return null;
      if (patch?.branch && patch.branch !== task.branch) {
        const existing = await this.findTaskByBranch(patch.branch, task.projectId);
        if (existing && existing.id !== taskId) return null;
      }
      const next = this.stripGitStatusScopedState(task, toStatus);
      if (previousStatus !== toStatus) delete next.serverSignalRecovery;
      Object.assign(next, patch ?? {}, {
        status: toStatus,
        updatedAt: new Date().toISOString(),
      });
      await this.taskStore.set(next);
      return { task: next, previousStatus };
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
      return this.repoStoreFactory(
        runner, project.repo, agent.mode, host, this.repoCache, agent.id, agent.workdir,
      );
    }
    const cloneViaGh = this.effectiveReviewMode(project.id) === 'git'
      ? resolveProjectTool(project) === 'gh'
      : undefined;
    return new RepoStore(
      runner, project.repo, agent.mode, host, this.repoCache, agent.id, agent.workdir, cloneViaGh,
    );
  }

  private async ensureWorkdir(
    agent: AgentConfig,
    project: ProjectConfig,
    runner: CommandRunner,
  ): Promise<{ workdir: string; repoStore: RepoStore | null }> {
    const repoStore = this.createRepoStore(agent, project, runner);
    const workdir = await repoStore.ensure();
    return { workdir, repoStore };
  }

  private resolveWorkdir(agent: AgentConfig, agentState: AgentBindingFacts | null): string | null {
    if (agent.workdir) return agent.workdir;
    return agentState?.workdir ?? null;
  }

  getRepoCache(): RepoStoreCache {
    return this.repoCache;
  }

  private async rollbackFailedDispatch(
    taskId: string,
    agentId: string,
    reason?: { phase: string; message: string },
    expectedLockToken?: string,
  ): Promise<void> {
    // Pin the incarnation: task rollback / intervention below await, and a DELETE→same-id recreate in that
    // window must not let the final state write-back resurrect the deleted agent.
    const genAtEntry = this.deletionGenerationOf(agentId);
    const existing = await this.agentStore.get(agentId);
    if (existing && existing.taskId !== undefined && existing.taskId !== taskId) {
      console.warn(
        `[AgentManager] rollback: agent ${agentId} taskId mismatch (expected ${taskId}, got ${existing.taskId}); ` +
        `skipping rollback — agent already reassigned`,
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
    if (
      !expectedLockToken
      || !(await this.lockManager.isOwner(agentId, taskId, expectedLockToken))
      || (existing?.taskId === taskId && existing.lockToken !== expectedLockToken)
    ) {
      console.warn(
        `[AgentManager] rollback: generation mismatch for ${agentId}/${taskId}; skipping stale rollback`,
      );
      return;
    }

    let rolledBack: { projectId: string } | null = null;
    await this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task) return;
      if (task.status !== 'in_progress') return;
      task.agentId = '';
      task.status = 'pending';
      task.updatedAt = new Date().toISOString();
      await this.taskStore.set(task);
      rolledBack = { projectId: task.projectId };
    });
    if (rolledBack && reason) {
      await this.emitIntervention((rolledBack as { projectId: string }).projectId, agentId, taskId, {
        phase: reason.phase,
        message: reason.message,
        note: 'Dispatch failed; the task is back in pending — re-dispatch it once the cause is resolved.',
      });
    }

    const lockToken = expectedLockToken;

    const projectId = existing?.projectId ?? this.getAgentConfig(agentId)?.projectId;
    if (!projectId) {
      console.error(
        `[AgentManager] CRITICAL: cannot resolve projectId for agent ${agentId} during rollback; deleting agent state.`,
      );
      await this.agentStore.delete(agentId);
    } else {
      const now = new Date().toISOString();
      await this.agentStore.update(agentId, (latest) => {
        // Never resurrect a deleted/recreated incarnation: if the state is gone or the generation moved
        // since entry, this rollback is stale — clear nothing rather than rebuild from the old snapshot.
        if (!latest || !this.deletionGateOpen(agentId, genAtEntry)) return AGENT_STORE_NOOP;
        if (latest.taskId === taskId && latest.lockToken !== expectedLockToken) return AGENT_STORE_NOOP;
        if (latest.taskId !== undefined && latest.taskId !== taskId) return AGENT_STORE_NOOP;
        return {
          ...latest,
          id: agentId,
          projectId,
          taskId: undefined,
          lockToken: undefined,
          updatedAt: now,
        };
      });
    }
    if (lockToken) await this.lockManager.releaseIfOwner(agentId, taskId, lockToken);
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
    if (!TASK_OWNER_ROLES.has(cfg.role)) {
      throw new ApiError(400, `Agent ${preferredAgentId} is not dev or research role`);
    }
    const state = await this.agentStore.get(preferredAgentId);
    if (!canDispatchWithBinding(state)) return null;
    const { projectId: _projectId, ...rest } = cfg;
    return rest;
  }

  private async persistQueuedTask(
    task: TaskState,
    queueReason: 'unassigned' | 'preferred_agent_busy' | 'agent_locked',
    agentId?: string,
  ): Promise<TaskState> {
    await this.taskStore.set(task);
    await this.safeEmit({
      id: '',
      type: 'task.created',
      timestamp: task.createdAt,
      projectId: task.projectId,
      taskId: task.id,
      data: {
        queued: true,
        queueReason,
        ...(agentId ? { agentId } : {}),
      },
    });
    return task;
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
      const branchCreatedByBaxian = input.branch === undefined;

      if (input.branch) {
        const existing = await this.findTaskByBranch(input.branch, projectId);
        if (existing) {
          throw new ApiError(400, `Branch "${input.branch}" is already bound to task ${existing.id}`);
        }
      }

      const imageFilenames = input.images?.length
        ? await this.persistTaskImages(taskId, input.images)
        : undefined;
      const taskBase = {
        id: taskId,
        projectId,
        title: input.title,
        description: input.description,
        preferredAgentId: input.preferredAgentId,
        reviewRound: 0,
        branch: taskBranch,
        branchCreatedByBaxian,
        reviewMode: this.effectiveReviewMode(projectId),
        ...this.platformBindingFields(projectId),
        createdAt: now,
        updatedAt: now,
        ...(imageFilenames ? { images: imageFilenames } : {}),
      };

      if (input.preferredAgentId === '') {
        const unassigned: TaskState = {
          ...taskBase,
          agentId: '',
          devAgentId: '',
          status: 'pending',
        };
        return this.persistQueuedTask(unassigned, 'unassigned');
      }

      // Capture generation before the first config/group read so a DELETE→same-id recreate in the read→commit window fails the gate.
      const genAtEntry = this.deletionGenerationOf(input.preferredAgentId);
      const target = await this.pickAgent(projectId, input.preferredAgentId);
      const targetConfig = this.getAgentConfig(input.preferredAgentId)!;
      const group = this.findAgentGroup(input.preferredAgentId);
      const dev = group?.find(agent => agent.role === 'dev');
      if (!dev) throw new ApiError(409, `Agent ${input.preferredAgentId} has no dev agent in its group`);
      const qa = group?.find(agent => agent.role === 'qa');
      const research = targetConfig.role === 'research' ? targetConfig : undefined;
      const researchFields = research
        ? { researchAgentId: research.id, phase: 'research' as const }
        : {};
      // Pin EVERY participant's generation: a member (e.g. QA) deleted→reintroduced after the snapshot leaves isDeletionInFlight false and the preferred generation unchanged, yet the task would still carry its stale id.
      const participantGens = new Map<string, number>(
        [dev.id, ...(qa ? [qa.id] : []), ...(research ? [research.id] : [])]
          .map(id => [id, this.deletionGenerationOf(id)] as const),
      );
      const participantsFresh = (): boolean =>
        this.deletionGenerationOf(input.preferredAgentId) === genAtEntry
        && !this.isDeletionInFlight(input.preferredAgentId)
        && [...participantGens].every(([id, gen]) =>
          this.deletionGenerationOf(id) === gen && !this.isDeletionInFlight(id));
      const queued: TaskState = {
        ...taskBase,
        agentId: '',
        devAgentId: dev.id,
        ...researchFields,
        status: 'pending',
        ...(qa ? { qaAgentId: qa.id } : {}),
      };
      // A DELETE→recreate of the preferred OR any participant after the group snapshot must not persist a
      // pending task carrying its stale devAgentId/qaAgentId; reject and let the client re-select.
      const persistQueuedOrReject = (reason: 'preferred_agent_busy' | 'agent_locked'): Promise<TaskState> => {
        if (!participantsFresh()) {
          throw new ApiError(409, `Agent ${input.preferredAgentId} or a group member is being deleted or recreated during task creation; please retry`);
        }
        return this.persistQueuedTask(queued, reason, input.preferredAgentId);
      };

      if (!target) {
        return persistQueuedOrReject('preferred_agent_busy');
      }

      if (this.isDeletionInFlight(target.id)) {
        return persistQueuedOrReject('agent_locked');
      }
      const lockToken = await this.lockManager.acquire(target.id, taskId);
      if (!lockToken) {
        return persistQueuedOrReject('agent_locked');
      }

      // Three-step transaction (queued task → binding → in_progress): any failure leaves at worst a queued task and/or a stale binding to it, both reclaimable — never an active task with no binding.
      const releaseLock = async (): Promise<void> => {
        try {
          await this.lockManager.releaseIfOwner(target.id, taskId, lockToken);
        } catch (releaseErr) {
          console.warn(`[AgentManager] createTask(${taskId}): lock release after failed assignment also failed:`, releaseErr);
        }
      };
      try {
        await this.taskStore.set(queued);
      } catch (err) {
        await releaseLock();
        throw err;
      }
      let commit: Awaited<ReturnType<AgentStore['update']>>;
      try {
        commit = await this.agentStore.update(target.id, (existing) => {
          if (existing === null && !this.bindingInitPredicate(target.id, genAtEntry)) return AGENT_STORE_NOOP;
          if (!this.deletionGateOpen(target.id, genAtEntry)) return AGENT_STORE_NOOP;
          return {
            id: target.id,
            projectId,
            taskId,
            lockToken,
            bootstrappingTaskId: taskId,
            updatedAt: now,
            ...(existing?.paneId !== undefined ? { paneId: existing.paneId } : {}),
            ...(existing?.workdir !== undefined ? { workdir: existing.workdir } : {}),
            ...(existing?.creationToken !== undefined ? { creationToken: existing.creationToken } : {}),
            // A new task never inherits the previous one's question: void the watermark.
            needInput: { epoch: (existing?.needInput?.epoch ?? 0) + 1 },
          };
        });
      } catch (err) {
        await releaseLock();
        throw err;
      }
      if (commit !== 'committed') {
        await releaseLock();
        return (await this.taskStore.get(taskId)) ?? queued;
      }
      // Binding-before-active: a DELETE slipping in after the binding commit sees a still-'pending' task and can rotate the lock; re-verify lock ownership + preferred/participant generations before the active write, else roll back.
      if (this.isDeletionInFlight(target.id)
          || !this.deletionGateOpen(target.id, genAtEntry)
          || !participantsFresh()
          || !(await this.lockManager.isOwner(target.id, taskId, lockToken))) {
        await this.agentStore.update(target.id, (existing) => {
          if (!existing || existing.taskId !== taskId || existing.lockToken !== lockToken) return AGENT_STORE_NOOP;
          const { taskId: _t, lockToken: _l, bootstrappingTaskId: _b, ...rest } = existing;
          return { ...rest, updatedAt: new Date().toISOString() };
        });
        await releaseLock();
        return (await this.taskStore.get(taskId)) ?? queued;
      }
      const task: TaskState = {
        ...taskBase,
        agentId: target.id,
        devAgentId: dev.id,
        ...(qa ? { qaAgentId: qa.id } : {}),
        ...researchFields,
        status: 'in_progress',
      };
      try {
        await this.taskStore.set(task);
      } catch (err) {
        try {
          await this.agentStore.update(target.id, (existing) => {
            if (!existing || existing.taskId !== taskId || existing.lockToken !== lockToken) return AGENT_STORE_NOOP;
            const { taskId: _t, lockToken: _l, bootstrappingTaskId: _b, ...rest } = existing;
            return { ...rest, updatedAt: new Date().toISOString() };
          });
        } catch (rollbackErr) {
          console.warn(`[AgentManager] createTask(${taskId}): binding rollback after task write failure also failed (stale-binding path will reclaim):`, rollbackErr);
        }
        await releaseLock();
        throw err;
      }
      await this.safeEmit({
        id: '',
        type: 'task.assigned',
        timestamp: now,
        projectId,
        agentId: target.id,
        taskId,
        data: { agentId: target.id },
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
      await this.updateTask(task.id, this.dispatchTokenFields(task, signalToken));
      const dispatchLockToken = (await this.agentStore.get(task.agentId))?.lockToken;
      const start = this.startCreatedTaskSession(
        task.id,
        task.agentId,
        signalToken,
        dispatchLockToken,
      );
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
    dispatchLockToken?: string,
  ): Promise<TaskState | null> {
    const initialTask = await this.taskStore.get(taskId);
    if (!initialTask) return null;
    const initialDispatch = this.resolveInitialDispatch(initialTask);
    const dispatchPhase = initialDispatch.phase;
    let started = false;
    let dispatchErr: unknown = null;
    try {
      started = await this.startSession(taskId, agentId, dispatchPhase);
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
      const initialKinds = this.resolveInitialDispatch(fresh).kinds;
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
      await this.failTaskForDispatchError(taskId, dispatchPhase, agentId, dispatchErr);
    } else if (dispatchErr instanceof EnsureSessionError && dispatchErr.partial.handled) {
    } else {
      const fresh = await this.taskStore.get(taskId);
      if (fresh && TERMINAL_STATUSES.includes(fresh.status) && (await this.agentStore.get(agentId))?.taskId === taskId) {
        await this.releaseAgentForTask(agentId, taskId, 'idle', { allowAwaitingHuman: true });
      } else {
        await this.rollbackFailedDispatch(taskId, agentId, dispatchErr ? {
          phase: 'dispatch-rollback',
          message: dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr),
        } : undefined, dispatchLockToken);
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
    // Pin the incarnation before reading paneId: paneId equality is ABA-blind (a recreate reuses %0), so a
    // DELETE→same-id recreate during the upload would otherwise paste the stale image into the new session.
    const genAtEntry = this.deletionGenerationOf(agentId);
    const state = await this.agentStore.get(agentId);
    const paneId = state?.paneId;
    if (!paneId) throw new ApiError(409, `Agent ${agentId} has no live session`);
    if (!this.tryAcquireCompactGuard(agentId)) {
      throw new ApiError(409, `Agent ${agentId} compact or upload in progress; retry shortly`);
    }
    try {
      const assertUploadStillValid = async (): Promise<void> => {
        if (!this.deletionGateOpen(agentId, genAtEntry)) {
          throw new ApiError(409, `Agent ${agentId} was deleted or recreated while uploading; image paste aborted`);
        }
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
      const pane = await this.resolveClaimedPane(tmux, agentId, paneId);
      // resolveClaimedPane resolved by the CURRENT same-name session; re-verify once more before injecting so a DELETE→recreate in that gap can't take the paste.
      await assertUploadStillValid();
      await tmux.injectPrompt(pane, `${path} `, agentId);
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
      const pane = await this.resolveClaimedPane(tmux, agentId, paneId);
      const waitReady = async (): Promise<void> => {
        try {
          await this.waitForReplPromptReady(tmux, pane, cfg.runtime, this.manualCompactWaitMs);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new ApiError(409, `Agent ${agentId} runtime is not at an idle REPL prompt: ${detail}`);
        }
      };
      await waitReady();
      await assertSessionUnchanged();
      await tmux.clearComposerDraft(pane);
      await waitReady();
      await assertSessionUnchanged();
      await tmux.sendKeysLiteral(pane, command);
      await tmux.sendEnter(pane);
      guardHandedOff = true;
      void this.waitForReplPromptReady(tmux, pane, cfg.runtime, this.compactIdleWaitMs)
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

  registerPendingDispatchRetry(
    taskId: string,
    entry: Omit<PendingDispatchRetry, 'since' | 'budgetAlerted'>,
    budgetOverride?: { since: number; budgetAlerted?: boolean },
  ): void {
    const prev = this.pendingDispatchRetryByTask.get(taskId);
    // 预算随登记代走：同 kind 但 pass 换代（token/agent 变化）时必须重置 since 与告警标志。
    // budgetOverride 供对账内部重排延续同一笔欠投递的预算——它只经 startSession 的 armedToken
    // fence 注入，外部 successor 的登记结构上拿不到
    const sameGeneration = prev?.kind === entry.kind
      && prev.agentId === entry.agentId
      && prev.signalToken === entry.signalToken;
    const since = sameGeneration ? prev.since : (budgetOverride?.since ?? Date.now());
    const budgetAlerted = sameGeneration
      ? prev.budgetAlerted === true
      : budgetOverride?.budgetAlerted === true;
    this.pendingDispatchRetryByTask.set(taskId, {
      ...entry,
      since,
      ...(budgetAlerted ? { budgetAlerted: true } : {}),
    });
  }

  getPendingDispatchRetry(taskId: string): PendingDispatchRetry | undefined {
    return this.pendingDispatchRetryByTask.get(taskId);
  }

  listPendingDispatchRetries(): ReadonlyMap<string, PendingDispatchRetry> {
    return this.pendingDispatchRetryByTask;
  }

  clearPendingDispatchRetry(taskId: string): void {
    this.pendingDispatchRetryByTask.delete(taskId);
  }

  clearPendingDispatchRetryIfMatches(
    taskId: string,
    expected: { agentId: string; signalToken: string },
  ): void {
    const entry = this.pendingDispatchRetryByTask.get(taskId);
    if (entry?.agentId === expected.agentId && entry.signalToken === expected.signalToken) {
      this.pendingDispatchRetryByTask.delete(taskId);
    }
  }

  markPendingDispatchRetryBudgetAlerted(
    taskId: string,
    expected: { agentId: string; signalToken: string },
  ): void {
    const entry = this.pendingDispatchRetryByTask.get(taskId);
    if (entry?.agentId === expected.agentId && entry.signalToken === expected.signalToken) {
      this.pendingDispatchRetryByTask.set(taskId, { ...entry, budgetAlerted: true });
    }
  }


  private async queueQaBusyPendingRetry(
    taskId: string,
    agentId: string,
    phase: string,
    createdSession: boolean,
    err: unknown,
    dispatch: { passToken?: string; pendingBudget?: { since: number; budgetAlerted?: boolean } },
  ): Promise<EnsureSessionError | null> {
    if (!(err instanceof ReplNotReadyError)) return null;
    if (phase !== 'review' && phase !== 'recheck') return null;
    // 无本次派发的 pass 令牌就不登记（宁走既有失败路径，不造无 fence 重试）；
    // 令牌漂移说明 pass 已被接管，忙碌属于旧派发，不得登记到 successor 上
    const passToken = dispatch.passToken;
    if (!passToken) return null;
    let current: TaskState | null;
    try {
      current = await this.taskStore.get(taskId);
    } catch (readErr) {
      console.warn(
        `[AgentManager] startSession[${phase}]: busy on task ${taskId} but pass token could not be verified; ` +
        `falling back to the non-pending failure path:`,
        readErr,
      );
      return null;
    }
    if (current?.signalToken !== passToken) {
      console.warn(
        `[AgentManager] startSession[${phase}]: busy on task ${taskId} but the review pass was superseded ` +
        `(expected ${passToken}, now ${current?.signalToken ?? 'gone'}); not queueing a pending retry`,
      );
      return null;
    }
    this.registerPendingDispatchRetry(taskId, {
      kind: 'qa-recheck',
      agentId,
      signalToken: passToken,
      qaPhase: phase,
    }, dispatch.pendingBudget);
    console.warn(
      `[AgentManager] startSession[${phase}]: QA pane busy for task ${taskId}; ` +
      `${phase} queued for redispatch when idle (${(err.message.split('\n')[0])})`,
    );
    return new EnsureSessionError(
      { createdSession, agentId, handled: true, busyPending: true },
      `QA REPL busy; ${phase} dispatch for task ${taskId} queued for redispatch when idle`,
    );
  }

  private async clearRuntimeForTaskBoundary(
    tmux: TmuxManager,
    pane: PaneRef,
    agentId: string,
    runtime: AgentConfig['runtime'],
    revalidate: () => Promise<void>,
  ): Promise<void> {
    await this.acquireCompactGuard(agentId);
    try {
      await this.waitForReplPromptReady(tmux, pane, runtime, this.cleanComposerWaitMs, { stableIdle: true });
      await revalidate();
      await tmux.clearComposerDraft(pane);
      const baseline = await tmux.captureSettledSnapshot(pane, {
        timeoutMs: this.dispatchSettleTimeoutMs,
      });
      const baselineTitle = await tmux.readPaneTitle(pane);
      await tmux.sendKeysLiteral(pane, '/clear');
      await tmux.sendEnter(pane);
      await tmux.waitSubmitAck(pane, baseline, runtime, {
        timeoutMs: this.dispatchAckTimeoutMs,
        baselineTitle,
        acceptComposerChange: true,
      });
      await this.waitForReplPromptReady(tmux, pane, runtime, this.dispatchAckTimeoutMs, { stableIdle: true });
      if (await this.hasRuntimeSlashCommandRejection(tmux, pane, '/clear')) {
        throw new Error('Runtime rejected /clear at the task boundary; refusing to reuse prior task context');
      }
      await revalidate();
    } finally {
      this.compactInFlight.delete(agentId);
    }
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
      // Capture generation before the first config/state read so a DELETE→same-id recreate in the read→commit window fails the gate.
      const genAtEntry = this.deletionGenerationOf(agentId);
      const cfg = this.getAgentConfig(agentId);
      if (!cfg) return { task: fresh, errorCode: 400 as const, error: `Unknown agent: ${agentId}` };
      if (cfg.projectId !== fresh.projectId) {
        return { task: fresh, errorCode: 400 as const, error: `Agent ${agentId} not in project ${fresh.projectId}` };
      }
      if (!TASK_OWNER_ROLES.has(cfg.role)) {
        return { task: fresh, errorCode: 400 as const, error: `Agent ${agentId} is not dev or research role` };
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
      if (this.isDeletionInFlight(agentId)) {
        return { task: fresh, errorCode: 409 as const, error: `Agent ${agentId} is being deleted` };
      }
      const lockToken = await this.lockManager.acquire(agentId, taskId);
      if (!lockToken) {
        return { task: fresh, errorCode: 409 as const, error: `Agent ${agentId} lock acquisition failed` };
      }

      const now = new Date().toISOString();
      const initiallyUnassigned = fresh.preferredAgentId === '';
      const group = initiallyUnassigned ? this.findAgentGroup(agentId) : undefined;
      const devId = initiallyUnassigned
        ? group?.find(agent => agent.role === 'dev')?.id
        : fresh.devAgentId;
      if (!devId) {
        await this.lockManager.releaseIfOwner(agentId, taskId, lockToken);
        return { task: fresh, errorCode: 409 as const, error: `Agent ${agentId} has no dev agent in its group` };
      }
      const qaId = initiallyUnassigned
        ? group?.find(agent => agent.role === 'qa')?.id
        : fresh.qaAgentId;
      const researchId = initiallyUnassigned && cfg.role === 'research' ? cfg.id : fresh.researchAgentId;
      // Pin every participant's generation (mirror createTask) so a member deleted→recreated before the active write isn't baked in.
      const participantGens = new Map<string, number>(
        [devId, ...(qaId ? [qaId] : []), ...(researchId ? [researchId] : [])]
          .map(pid => [pid, this.deletionGenerationOf(pid)] as const),
      );
      const participantsFresh = (): boolean =>
        [...participantGens].every(([pid, gen]) =>
          this.deletionGenerationOf(pid) === gen && !this.isDeletionInFlight(pid));
      const claimedTask: TaskState = {
        ...fresh,
        preferredAgentId: agentId,
        agentId,
        devAgentId: devId,
        researchAgentId: researchId,
        qaAgentId: qaId,
        phase: researchId ? 'research' : undefined,
        status: 'in_progress',
        updatedAt: now,
      };
      // Binding-first: the fresh task snapshot already exists on disk, so a failure at any later
      // step leaves at worst a stale binding to a still-unclaimed task — an existing reclaimable state.
      const releaseLock = async (): Promise<void> => {
        try {
          await this.lockManager.releaseIfOwner(agentId, taskId, lockToken);
        } catch (releaseErr) {
          console.warn(`[AgentManager] claimTask(${taskId}): lock release after failed claim also failed:`, releaseErr);
        }
      };
      let commit: Awaited<ReturnType<AgentStore['update']>>;
      try {
        commit = await this.agentStore.update(agentId, (existing) => {
          if (existing === null && !this.bindingInitPredicate(agentId, genAtEntry)) return AGENT_STORE_NOOP;
          if (!this.deletionGateOpen(agentId, genAtEntry)) return AGENT_STORE_NOOP;
          return {
            id: agentId,
            projectId: cfg.projectId,
            taskId,
            lockToken,
            bootstrappingTaskId: taskId,
            updatedAt: now,
            ...(existing?.paneId !== undefined ? { paneId: existing.paneId } : {}),
            ...(existing?.workdir !== undefined ? { workdir: existing.workdir } : {}),
            ...(existing?.creationToken !== undefined ? { creationToken: existing.creationToken } : {}),
            // A new task never inherits the previous one's question: void the watermark.
            needInput: { epoch: (existing?.needInput?.epoch ?? 0) + 1 },
          };
        });
      } catch (err) {
        await releaseLock();
        throw err;
      }
      if (commit !== 'committed') {
        await releaseLock();
        return { task: fresh, errorCode: 409 as const, error: `Agent ${agentId} is being deleted` };
      }
      // Re-verify lock ownership + preferred/participant generations before the active write, else a DELETE after the binding commit orphans it.
      if (this.isDeletionInFlight(agentId)
          || !this.deletionGateOpen(agentId, genAtEntry)
          || !participantsFresh()
          || !(await this.lockManager.isOwner(agentId, taskId, lockToken))) {
        await this.agentStore.update(agentId, (existing) => {
          if (!existing || existing.taskId !== taskId || existing.lockToken !== lockToken) return AGENT_STORE_NOOP;
          const { taskId: _t, lockToken: _l, bootstrappingTaskId: _b, ...rest } = existing;
          return { ...rest, updatedAt: new Date().toISOString() };
        });
        await releaseLock();
        return { task: fresh, errorCode: 409 as const, error: `Agent ${agentId} is being deleted` };
      }
      try {
        await this.taskStore.set(claimedTask);
      } catch (err) {
        try {
          await this.agentStore.update(agentId, (existing) => {
            if (!existing || existing.taskId !== taskId || existing.lockToken !== lockToken) return AGENT_STORE_NOOP;
            const { taskId: _t, lockToken: _l, bootstrappingTaskId: _b, ...rest } = existing;
            return { ...rest, updatedAt: new Date().toISOString() };
          });
        } catch (rollbackErr) {
          console.warn(`[AgentManager] claimTask(${taskId}): binding rollback after task write failure also failed (stale-binding path will reclaim):`, rollbackErr);
        }
        await releaseLock();
        throw err;
      }
      await this.safeEmit({
        id: '',
        type: 'task.assigned',
        timestamp: now,
        projectId: cfg.projectId,
        agentId,
        taskId,
        data: { agentId, manuallyDispatched: true },
      });
      return { task: claimedTask, lockToken };
    });

    if (claim.errorCode !== undefined) return claim;
    if (!claim.task) return claim;
    const claimed = claim.task;

    const signalToken = createSignalToken();
    await this.updateTask(claimed.id, this.dispatchTokenFields(claimed, signalToken));

    let started = false;
    let dispatchErr: unknown = null;
    const initialDispatch = this.resolveInitialDispatch(claimed);
    try {
      started = await this.startSession(
        claimed.id,
        claimed.agentId,
        initialDispatch.phase,
      );
    } catch (err) {
      dispatchErr = err;
      console.error(
        `[AgentManager] dispatchPendingTask startSession hard error for task=${claimed.id}:`,
        err,
      );
    }
    if (started) {
      await this.armPostDispatchSignalOrHold(
        claimed.id,
        claimed.agentId,
        initialDispatch.kinds,
        signalToken,
      );
      const refreshed = await this.taskStore.get(claimed.id);
      return { task: refreshed ?? claimed };
    }

    if (dispatchErr instanceof DispatchTerminalError) {
      await this.failTaskForDispatchError(
        claimed.id,
        initialDispatch.phase,
        claimed.agentId,
        dispatchErr,
      );
    } else if (dispatchErr instanceof EnsureSessionError && dispatchErr.partial.handled) {
    } else {
      await this.rollbackFailedDispatch(claimed.id, claimed.agentId, dispatchErr ? {
        phase: 'dispatch-rollback',
        message: dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr),
      } : undefined, claim.lockToken);
    }
    const refreshed = await this.taskStore.get(claimed.id);
    if (dispatchErr === null) {
      return { task: refreshed, errorCode: 409, error: 'task state changed during dispatch; startSession refused' };
    }
    const err = dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
    return { task: refreshed, errorCode: 500, error: err };
  }

  private async switchToVerifiedReviewHead(
    branchManager: BranchManager,
    workdir: string,
    task: TaskState,
    assertOwner: () => Promise<void>,
  ): Promise<void> {
    if (!task.branch) throw new Error(`Task ${task.id} has no review branch`);
    const current = await this.taskStore.get(task.id);
    let expectedHeadSha = current?.latestHeadSha ?? task.latestHeadSha;
    if (!expectedHeadSha) {
      const fetched = await this.platformFetchPrHeadSha(task.id);
      expectedHeadSha = await this.persistReviewHeadIfCurrent(task.id, undefined, fetched);
    }
    await assertOwner();
    try {
      await branchManager.switchToRemoteBranchDetached(workdir, task.branch, expectedHeadSha);
      return;
    } catch (err) {
      if (!(err instanceof ReviewHeadMismatchError)) throw err;
      const latest = await this.taskStore.get(task.id);
      let replacement = latest?.latestHeadSha;
      if (!replacement || replacement === expectedHeadSha) {
        const fetched = await this.platformFetchPrHeadSha(task.id);
        replacement = await this.persistReviewHeadIfCurrent(task.id, expectedHeadSha, fetched);
      }
      if (replacement === expectedHeadSha) throw err;
      await assertOwner();
      await branchManager.switchToRemoteBranchDetached(workdir, task.branch, replacement);
    }
  }

  private persistReviewHeadIfCurrent(
    taskId: string,
    expected: string | undefined,
    replacement: string,
  ): Promise<string> {
    return this.withTaskLock(async () => {
      const latest = await this.taskStore.get(taskId);
      if (!latest || TERMINAL_STATUSES.includes(latest.status)) {
        throw new Error(`Task ${taskId} became terminal while refreshing its review head`);
      }
      if (latest.latestHeadSha && latest.latestHeadSha !== expected) {
        return latest.latestHeadSha;
      }
      latest.latestHeadSha = replacement;
      latest.updatedAt = new Date().toISOString();
      await this.taskStore.set(latest);
      return replacement;
    });
  }

  async startSession(
    taskId: string,
    agentId: string,
    phase: string,
    opts: StartSessionOpts = {},
  ): Promise<boolean> {
    const agent = this.getAgentConfig(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    // Pin the incarnation: a DELETE completing during dispatch bumps this, and every gated commit/side-effect below refuses the stale generation.
    const genAtEntry = this.deletionGenerationOf(agentId);

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
    if (!preAgent || preAgent.taskId !== taskId) {
      console.warn(
        `[AgentManager] startSession[${phase}]: agent=${agentId} has no exact task binding for lock validation`,
      );
      return false;
    }
    const lockToken = await this.resolveTaskLockToken(preAgent, taskId);
    if (!lockToken) {
      console.warn(
        `[AgentManager] startSession[${phase}]: agent=${agentId} does not own the exclusive lock for ${taskId}`,
      );
      return false;
    }
    const assertOwner = async (): Promise<void> => {
      // Also gate on the entry generation: a DELETE→same-id recreate can pass the task/lock check on the
      // reused binding, so every Workdir/runtime side-effect guarded by assertOwner must fail closed on it.
      if (!this.deletionGateOpen(agentId, genAtEntry)) {
        throw new Error(`Agent ${agentId} is being deleted or was recreated for task ${taskId}; operation aborted`);
      }
      const stateNow = await this.agentStore.get(agentId);
      if (stateNow?.taskId !== taskId || stateNow.lockToken !== lockToken) {
        throw new Error(`Agent ${agentId} binding changed for task ${taskId}; operation aborted`);
      }
      await this.assertTaskLockOwner(agentId, taskId, lockToken);
    };
    await assertOwner();

    const dialogFailFromStatuses =
      opts.dialogFailFromStatuses ?? PHASE_EXPECTED_STATUS[phase] ?? [...ACTIVE_TASK_STATUSES];
    let ensure: EnsureSessionResult;
    try {
      ensure = await this.ensureSession(agentId, 'runtime', { expectedGeneration: genAtEntry });
    } catch (err) {
      if (await this.handleDialogPendingFromRuntime(agentId, err, { expectedFromStatuses: dialogFailFromStatuses, expectedGeneration: genAtEntry })) {
        throw err;
      }
      if (err instanceof EnsureSessionError && err.partial.createdSession) {
        const stateNow = await this.agentStore.get(agentId);
        const stillOwner = stateNow?.taskId === taskId
          && stateNow.lockToken === lockToken
          && await this.lockManager.isOwner(agentId, taskId, lockToken);
        if (stillOwner) {
          await this.rollbackCreatedSession(agentId, err.partial, 'startSession ensure rollback');
        } else {
          console.warn(
            `[AgentManager] startSession ensureSession rollback skipped for stale owner ` +
            `${agentId}/${taskId}`,
          );
        }
      }
      throw err;
    }
    const { paneId, pane, workdir } = ensure;

    const runner = this.createRunnerFor(agent);
    const tmux = new TmuxManager(runner);
    const branchManager = new BranchManager(runner);
    const lockState = await this.agentStore.get(agentId);
    if (!lockState || lockState.taskId !== taskId || lockState.lockToken !== lockToken) return false;
    await assertOwner();
    try {
      await this.waitForReplPromptReady(tmux, pane, agent.runtime, this.cleanComposerWaitMs, { stableIdle: true });
    } catch (err) {
      const busyPend = await this.queueQaBusyPendingRetry(taskId, agentId, phase, ensure.createdSession, err, { passToken: opts.dispatchPassToken, pendingBudget: opts.dispatchPendingBudget });
      if (busyPend) throw busyPend;
      throw err;
    }

    const isServerQaPhase = phase === 'server-review' || phase === 'server-recheck' || phase === 'server-spec-review';
    const isServerCodeReviewPhase = phase === 'server-review' || phase === 'server-recheck';
    let reviewCheckout: { mode: 'head' | 'base'; fallbackReason?: string } | undefined;
    const dispatchWorkdir = workdir;
    try {
      if (isServerCodeReviewPhase && opts.serverContent !== undefined) {
        reviewCheckout = await branchManager.materializeReviewHead(workdir, {
          patch: opts.serverContent,
          baseSha: opts.serverBaseSha,
          headSha: opts.serverHeadSha,
          headTree: opts.serverHeadTree,
        });
      } else if (isServerQaPhase) {
        await branchManager.switchToDefaultDetached(workdir);
      } else if (phase === 'review' || phase === 'recheck') {
        if (!task.branch) throw new Error(`Task ${taskId} has no review branch`);
        await this.switchToVerifiedReviewHead(branchManager, workdir, task, assertOwner);
      } else if (phase === 'research') {
        await branchManager.switchToDefaultDetached(workdir);
      } else {
        if (!task.branch) throw new Error(`Task ${taskId} has no task branch`);
        await branchManager.switchToTaskBranch(
          workdir,
          taskId,
          task.branch,
          task.branchCreatedByBaxian === true,
          task.branchLocalCleaned
            ? { restorableRemoteTip: task.branchLocalCleaned.remoteTipSha }
            : {},
        );
        if (task.branchLocalCleaned) await this.clearBranchLocalCleaned(taskId);
      }
      await assertOwner();
      if (!ensure.freshRuntime) {
        await this.clearRuntimeForTaskBoundary(tmux, pane, agentId, agent.runtime, assertOwner);
        if (ensure.skillsStale) await this.tagSessionSkillsVersion(tmux, agentId, ensure.sessionRef);
      }
    } catch (err) {
      const busyPend = await this.queueQaBusyPendingRetry(taskId, agentId, phase, ensure.createdSession, err, { passToken: opts.dispatchPassToken, pendingBudget: opts.dispatchPendingBudget });
      if (busyPend) throw busyPend;
      const message = err instanceof Error ? err.message : String(err);
      const holdPhase = err instanceof DirtyWorkdirError
        ? 'dirty-workdir'
        : 'checkout-preparation-failed';
      await this.markAwaitingHuman(agentId, holdPhase, message, { expectedTaskId: taskId })
        .catch((holdErr) => {
          console.error(
            `[AgentManager] startSession could not persist ${holdPhase} hold for ${agentId}:`,
            holdErr,
          );
        });
      throw new EnsureSessionError(
        { createdSession: ensure.createdSession, agentId, handled: true },
        `checkout preparation failed for task ${taskId}: ${message}`,
      );
    }

    const cleanupCheckout = async (): Promise<void> => {
      try {
        await assertOwner();
      } catch {
        return;
      }
      await branchManager.parkOnDefaultDetached(workdir);
      await assertOwner();
    };
    const cleanupCheckoutOrHold = async (): Promise<void> => {
      try {
        await cleanupCheckout();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        let holdFailure = '';
        try {
          await this.markAwaitingHuman(
            agentId,
            'checkout-cleanup-failed',
            `Task checkout could not be parked safely: ${message}`,
            { expectedTaskId: taskId },
          );
        } catch (holdErr) {
          holdFailure = `; persisting the hold also failed: ${holdErr instanceof Error ? holdErr.message : String(holdErr)}`;
        }
        throw new EnsureSessionError(
          { createdSession: ensure.createdSession, agentId, handled: true },
          `checkout cleanup failed for task ${taskId}: ${message}${holdFailure}`,
        );
      }
    };

    await this.agentStore.update(agentId, (stateNow) => {
      if (!stateNow || stateNow.taskId !== taskId) return AGENT_STORE_NOOP;
      // Watermark stays: the arm-time epoch bump owns superseding the old question.
      return {
        ...stateNow,
        paneId,
        workdir,
        updatedAt: new Date().toISOString(),
      };
    });

    const promptSignalToken = opts.signalToken ?? task.signalToken;
    const promptSpecRound = opts.currentSpecRound ?? task.specReviewRound;
    const hasQaPartner = task.qaAgentId !== undefined;
    let prompt: string;
    try {
      await this.prepareDispatchArtifacts(agent, dispatchWorkdir, phase, {
        specDocuments: opts.specDocuments,
        preserveOutputs: false,
        assertOwner,
      });
      const imagePaths = await this.imagePathsForDispatch(runner, task, phase);
      let payloadOpts: ServerPayloadPromptOpts = {};
      if (opts.serverContent !== undefined || opts.serverDiffstat !== undefined || opts.serverInterdiff !== undefined || opts.serverPriorFindings || opts.serverPriorResponse) {
        payloadOpts = await resolveServerPayloads(this.getReviewTransport(), agent, dispatchWorkdir, {
          phase,
          taskPhase: task.phase,
          ...(promptSpecRound !== undefined ? { specRound: promptSpecRound } : {}),
          reviewRound: task.reviewRound,
          ...(opts.serverBatch ? { batch: opts.serverBatch } : {}),
          ...(opts.serverContent !== undefined ? { serverContent: opts.serverContent } : {}),
          ...(reviewCheckout?.mode === 'head' ? { forceContentFile: true } : {}),
          ...(opts.serverDiffstat !== undefined ? { serverDiffstat: opts.serverDiffstat } : {}),
          ...(opts.serverInterdiff !== undefined ? { serverInterdiff: opts.serverInterdiff } : {}),
          ...(opts.serverPriorFindings ? { serverPriorFindings: opts.serverPriorFindings } : {}),
          ...(opts.serverPriorResponse ? { serverPriorResponse: opts.serverPriorResponse } : {}),
        });
      }
      const taskForPrompt = await this.ensureGitBaseSnapshot(task, phase);
      const platformCli = this.platformCliContextOf(taskForPrompt);
      prompt = buildPromptInline({
        task: taskForPrompt,
        phase,
        agent,
        workdir: dispatchWorkdir,
        skillRegistry: this.skillRegistry,
        hasQaPartner,
        ...(platformCli ? { platformCli } : {}),
        ...(promptSignalToken ? { signalToken: promptSignalToken } : {}),
        ...(promptSpecRound !== undefined ? { currentSpecRound: promptSpecRound } : {}),
        ...(imagePaths.length ? { imagePaths } : {}),
        ...(reviewCheckout ? { serverReviewCheckout: reviewCheckout.mode } : {}),
        ...(reviewCheckout?.fallbackReason ? { serverReviewFallbackReason: reviewCheckout.fallbackReason } : {}),
        ...(opts.serverBaseSha !== undefined ? { serverBaseSha: opts.serverBaseSha } : {}),
        ...(opts.serverHeadSha !== undefined ? { serverHeadSha: opts.serverHeadSha } : {}),
        ...(opts.serverHeadTree !== undefined ? { serverHeadTree: opts.serverHeadTree } : {}),
        ...(opts.serverBatch ? { serverBatch: opts.serverBatch } : {}),
        ...(opts.serverFindingsDigest ? { serverFindingsDigest: opts.serverFindingsDigest } : {}),
        ...(opts.serverFeedbackCorrection ? { serverFeedbackCorrection: opts.serverFeedbackCorrection } : {}),
        ...payloadOpts,
      });
    } catch (err) {
      await cleanupCheckoutOrHold();
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
        `[AgentManager] startSession: task ${taskId} disappeared mid-dispatch; parking checkout before paste`,
      );
      await cleanupCheckoutOrHold();
      return false;
    }
    if (TERMINAL_STATUSES.includes(taskFresh.status)) {
      console.warn(
        `[AgentManager] startSession: task ${taskId} status=${taskFresh.status} is terminal ` +
        `for phase=${phase}; parking checkout before paste`,
      );
      await cleanupCheckoutOrHold();
      return false;
    }
    if (!opts.bypassTaskStatusGate && !expectedStatuses.includes(taskFresh.status)) {
      console.warn(
        `[AgentManager] startSession: task ${taskId} status=${taskFresh.status} not in ` +
        `expected ${expectedStatuses.join('/')} for phase=${phase}; parking checkout before paste`,
      );
      await cleanupCheckoutOrHold();
      return false;
    }

    const agentFresh = await this.agentStore.get(agentId);
    if (PHASE_REQUIRES_AGENT_BOUND_TO_TASK[phase]) {
      if (!agentFresh || agentFresh.taskId !== taskId) {
        console.warn(
          `[AgentManager] startSession[${phase}]: agent ${agentId} not bound to ${taskId} ` +
          `(got taskId=${agentFresh?.taskId}); parking checkout before paste`,
        );
        await cleanupCheckoutOrHold();
        return false;
      }
    } else if (agentFresh && agentFresh.taskId && agentFresh.taskId !== taskId) {
      console.warn(
        `[AgentManager] startSession[${phase}]: agent ${agentId} reassigned to ${agentFresh.taskId} ` +
        `(was ${taskId}); parking checkout before paste`,
      );
      await cleanupCheckoutOrHold();
      return false;
    }

    if (opts.armBeforeInject && !(await opts.armBeforeInject({ serverReviewCheckout: reviewCheckout?.mode }))) {
      await cleanupCheckoutOrHold();
      return false;
    }

    const now = new Date().toISOString();
    let agentMarkedRunning = false;
    try {
      let cancelHoldWon = false;
      let deletedDuringDispatch = false;
      const runningCommit = await this.agentStore.update(agentId, (existing) => {
        if (isCancelCleanupHold(existing)) { cancelHoldWon = true; return AGENT_STORE_NOOP; }
        // Binding must already exist and still hold our lock; never re-create a deleted agent's state nor write under a bumped deletion generation (ABA).
        if (!existing || existing.taskId !== taskId || existing.lockToken !== lockToken
            || !this.deletionGateOpen(agentId, genAtEntry)) {
          deletedDuringDispatch = true;
          return AGENT_STORE_NOOP;
        }
        return {
          ...existing,
          id: agentId,
          projectId: agent.projectId,
          paneId,
          taskId,
          workdir,
          lockToken,
          startedAt: now,
          bootstrappingTaskId: taskId,
          updatedAt: now,
        };
      });
      if (cancelHoldWon) {
        console.warn(
          `[AgentManager] startSession[${phase}]: agent ${agentId} entered a cancel-cleanup hold during dispatch; ` +
          `aborting so cancel can finish interrupt + /clear`,
        );
        await cleanupCheckoutOrHold();
        return false;
      }
      if (deletedDuringDispatch || runningCommit !== 'committed') {
        console.warn(
          `[AgentManager] startSession[${phase}]: agent ${agentId} binding vanished or was deleted/recreated ` +
          `during dispatch; not marking running (no orphan state)`,
        );
        return false;
      }
      agentMarkedRunning = true;

      // armed pass 的 fence 延伸到最终 paste：checkout//clear/artifacts 的 await 窗口里 pass 可被
      // push/其他 dispatcher 轮换，旧 prompt 不得注入 successor；guard 在 composer/paste/Enter
      // 的 task-mutation 队列槽内复核（与轮换串行），漂移即放弃投递。
      // cancel 只写终态不轮换 token，故 fence 须同时复核任务仍处本相位的可投递状态
      const passDeliverableStatuses =
        opts.dialogFailFromStatuses ?? PHASE_EXPECTED_STATUS[phase] ?? [...ACTIVE_TASK_STATUSES];
      const passStillArmed = opts.dispatchPassToken !== undefined
        ? async (): Promise<boolean> => {
            const freshTask = await this.taskStore.get(taskId);
            if (!freshTask || freshTask.signalToken !== opts.dispatchPassToken) return false;
            if (opts.dispatchReviewLease !== undefined
              && !this.gitReviewClaimMatches(freshTask, opts.dispatchReviewLease)) return false;
            return passDeliverableStatuses.includes(freshTask.status);
          }
        : undefined;
      if (passStillArmed && !(await passStillArmed())) {
        console.warn(
          `[AgentManager] startSession[${phase}]: review pass superseded before injection for task ${taskId}; aborting paste`,
        );
        return false;
      }
      const injectResult = await this.injectAndAwaitAck(tmux, pane, prompt, agentId, agent.runtime, passStillArmed);
      if (injectResult.aborted === true) {
        console.warn(
          `[AgentManager] startSession[${phase}]: injection fenced off (pass superseded) for task ${taskId}`,
        );
        return false;
      }
      // prompt 已确认投递：只 CAS 清理本次派发那一代的登记；successor 在窗口内登记的新 pending 不受影响，
      // 且清理先于可失败的审计事件——事件写失败不能把已投递的 prompt 重新变回 pending
      if (opts.dispatchPassToken !== undefined) {
        this.clearPendingDispatchRetryIfMatches(taskId, { agentId, signalToken: opts.dispatchPassToken });
      }
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
        data: { phase, workdir: dispatchWorkdir },
      });
      this.startRuntimeMenuWatch(agentId);
      return true;
    } catch (err) {
      // 注入阶段的忙碌（预注入活回合检查）仍在任何按键之前：登记 pending 并保持 checkout/绑定原样，
      // 在途回合还在使用该工作树，park/release 会拽走它
      const injectBusyPend = await this.queueQaBusyPendingRetry(
        taskId, agentId, phase, ensure.createdSession, err,
        { passToken: opts.dispatchPassToken, pendingBudget: opts.dispatchPendingBudget },
      );
      if (injectBusyPend) throw injectBusyPend;
      const isAckUnknown = err instanceof DispatchTerminalError && err.reason === 'ack_unknown';
      if (!isAckUnknown) {
        await cleanupCheckoutOrHold();
        if (agentMarkedRunning && !opts.preserveBindingOnFailure) {
          try {
            let released = false;
            let releaseToken: string | undefined;
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
              releaseToken = agentNow.lockToken;
              void err;
              return {
                id: agentId,
                projectId: agent.projectId,
                paneId,
                workdir,
                updatedAt: new Date().toISOString(),
                ...(agentNow.creationToken !== undefined ? { creationToken: agentNow.creationToken } : {}),
              };
            });
            if (released && releaseToken) {
              await this.lockManager.releaseIfOwner(agentId, taskId, releaseToken);
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
    pane: PaneRef,
    prompt: string,
    agentId: string,
    runtime: AgentConfig['runtime'],
    guardBeforePaste?: () => Promise<boolean>,
  ): Promise<{ acked: boolean; composerDelivered: boolean; aborted?: boolean }> {
    const before = await this.agentStore.get(agentId);
    const beforeLockToken = before?.taskId
      ? await this.resolveTaskLockToken(before, before.taskId)
      : null;
    if (before?.taskId && !beforeLockToken) {
      throw new Error(`dispatch aborted: agent ${agentId} no longer owns task ${before.taskId}`);
    }
    await this.acquireCompactGuard(agentId);
    try {
      if (before) {
        const now = await this.agentStore.get(agentId);
        if (
          !now
          || now.paneId !== before.paneId
          || now.taskId !== before.taskId
          || (beforeLockToken !== null && now.lockToken !== beforeLockToken)
        ) {
          throw new Error(
            `dispatch aborted: agent ${agentId} binding changed while waiting for pane mutex`,
          );
        }
        if (before.taskId && beforeLockToken) {
          await this.assertTaskLockOwner(agentId, before.taskId, beforeLockToken);
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
          if (
            !fresh
            || fresh.paneId !== before.paneId
            || fresh.taskId !== before.taskId
            || (beforeLockToken !== null && fresh.lockToken !== beforeLockToken)
            || isCancelCleanupHold(fresh)
          ) {
            throw new Error(`dispatch aborted: agent ${agentId} taken over by cancel before paste`);
          }
          if (before.taskId && beforeLockToken) {
            await this.assertTaskLockOwner(agentId, before.taskId, beforeLockToken);
          }
          const boundTask = fresh.taskId ? await this.taskStore.get(fresh.taskId) : null;
          if (boundTask && TERMINAL_STATUSES.includes(boundTask.status)) {
            throw new Error(`dispatch aborted: task ${fresh.taskId} for agent ${agentId} went terminal before paste`);
          }
        }
        : undefined;
      await revalidate?.();
      if (guardBeforePaste && !(await guardBeforePaste())) {
        return { acked: false, composerDelivered: false, aborted: true };
      }
      return await this.injectAndAwaitAckSteps(tmux, pane, prompt, agentId, runtime, revalidate, guardBeforePaste);
    } finally {
      this.compactInFlight.delete(agentId);
    }
  }

  private async injectAndAwaitAckSteps(
    tmux: TmuxManager,
    pane: PaneRef,
    prompt: string,
    agentId: string,
    runtime: AgentConfig['runtime'],
    revalidate?: () => Promise<void>,
    guardBeforePaste?: () => Promise<boolean>,
  ): Promise<{ acked: boolean; composerDelivered: boolean; aborted?: boolean }> {
    const paneId = pane.paneId;
    // 静态忙信号（文本忙样式/working title）可能是残稿或 stale title 冒充，一律由帧活性仲裁；ready 视图覆盖 stale title。
    const preTitle = await tmux.readPaneTitle(pane);
    const preFrame = await tmux.capturePaneById(pane, { ansi: false, scrollback: 0 });
    const staticBusy = hasOscTitleWorking(preTitle)
      ? (runtimeBusyCheck(preFrame, runtime) || !hasRuntimeReadyView(preFrame, runtime))
      : runtimeBusyCheck(preFrame, runtime);
    if (staticBusy && await this.paneHasLiveTurn(tmux, pane, runtime)) {
      throw new ReplNotReadyError(
        paneId,
        runtime,
        preFrame,
        `pre-inject busy check: pane ${paneId} is still running a turn; dispatch aborted`,
      );
    }
    await revalidate?.();
    if (guardBeforePaste) {
      // A stale replay must not touch the pane at all: the guard runs before the first composer scrub.
      if (!(await guardBeforePaste())) {
        return { acked: false, composerDelivered: false, aborted: true };
      }
      const staged = await tmux.stagePromptBuffer(paneId, prompt, agentId);
      // Fence + scrub + paste share one task-mutation-queue slot, so a rotation lands before or after, never between.
      let pasted = false;
      try {
        pasted = await this.withTaskLock(async () => {
          if (!(await guardBeforePaste())) return false;
          await tmux.clearComposerDraft(pane);
          await tmux.pasteStagedBuffer(paneId, staged.buf);
          return true;
        });
      } catch (pasteErr) {
        // Buffer still present proves the paste never landed; missing/unprobeable fails closed to a composer scrub.
        let bufferConsumed = true;
        try {
          await tmux.dropStagedBuffer(staged.buf);
          bufferConsumed = false;
        } catch (dropErr) {
          console.warn(
            `[AgentManager] staged buffer ${staged.buf} not confirmed dropped after failed paste (missing or unprobeable); failing closed to a composer scrub:`,
            dropErr,
          );
        }
        if (bufferConsumed) {
          try {
            await tmux.clearComposerDraft(pane);
          } catch (clearErr) {
            console.warn(`[AgentManager] composer scrub after unknown paste outcome failed for pane ${paneId}:`, clearErr);
          }
        }
        throw pasteErr;
      }
      if (!pasted) {
        try {
          await tmux.dropStagedBuffer(staged.buf);
        } catch (err) {
          console.warn(`[AgentManager] staged buffer ${staged.buf} cleanup failed:`, err);
        }
        return { acked: false, composerDelivered: false, aborted: true };
      }
    } else {
      await tmux.clearComposerDraft(pane);
      await revalidate?.();
      await tmux.injectPrompt(pane, prompt, agentId);
    }
    let baseline: string;
    let baselineTitle = '';
    try {
      baseline = await tmux.captureSettledSnapshot(pane, { timeoutMs: this.dispatchSettleTimeoutMs });
      baselineTitle = await tmux.readPaneTitle(pane);
      if (guardBeforePaste) {
        // The Enter is the actual submission; it takes the same fenced queue slot.
        const submitted = await this.withTaskLock(async () => {
          if (!(await guardBeforePaste())) return false;
          await tmux.sendEnter(pane);
          return true;
        });
        if (!submitted) {
          try {
            await tmux.clearComposerDraft(pane);
          } catch (err) {
            // Fail closed: a submit-ready stale prompt could not be confirmed gone.
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(
              `fence-rejected prompt could not be scrubbed from the composer of pane ${paneId}; verify the pane before reuse: ${message}`,
            );
          }
          return { acked: false, composerDelivered: false, aborted: true };
        }
      } else {
        await tmux.sendEnter(pane);
      }
    } catch (preAckErr) {
      if (await this.clearComposerForReuse(tmux, pane, agentId)) throw preAckErr;
      const message = preAckErr instanceof Error ? preAckErr.message : String(preAckErr);
      throw new DispatchTerminalError(
        'ack_unknown',
        `pre-ack failure left an unconfirmed composer on live pane ${paneId}: ${message}`,
      );
    }
    let staleDuringResend = false;
    try {
      await tmux.waitSubmitAck(pane, baseline, runtime, {
        timeoutMs: this.dispatchAckTimeoutMs,
        baselineTitle,
        resend: guardBeforePaste
          ? async () => {
            // A resend is a fresh submission of whatever sits in the composer; it takes the same fence.
            const resent = await this.withTaskLock(async () => {
              if (!(await guardBeforePaste())) return false;
              await tmux.sendEnter(pane);
              return true;
            });
            if (!resent) staleDuringResend = true;
          }
          : () => tmux.sendEnter(pane),
        resendIntervalMs: this.dispatchAckResendIntervalMs,
      });
      return { acked: true, composerDelivered: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!(err instanceof Error && /runtime ack timeout/.test(err.message))) {
        throw new DispatchTerminalError('ack_unknown', `ack_unknown for pane ${paneId}: ${message}`);
      }
      if (staleDuringResend) {
        try {
          await tmux.clearComposerDraft(pane);
        } catch (scrubErr) {
          const scrubMessage = scrubErr instanceof Error ? scrubErr.message : String(scrubErr);
          throw new Error(
            `fence-rejected resend left an unverified composer on pane ${paneId}; verify the pane before reuse: ${scrubMessage}`,
          );
        }
        return { acked: false, composerDelivered: false, aborted: true };
      }
      console.warn(
        `[AgentManager] dispatch ack timeout for pane ${paneId} agent ${agentId}: ${message}`,
      );
      const state = await this.agentStore.get(agentId).catch(() => null);
      await this.emitIntervention(state?.projectId ?? '', agentId, state?.taskId, {
        phase: 'dispatch-ack-timeout',
        paneId,
        message,
        note:
          'REPL did not acknowledge the pasted prompt within timeout. ' +
          'baxian intentionally did NOT send C-c — the input may still be queued. ' +
          'Attach via web terminal to verify and resolve.',
      });
      const composerDelivered = !/pane already busy at baseline/.test(message);
      return { acked: false, composerDelivered };
    }
  }

  private async clearComposerForReuse(tmux: TmuxManager, pane: PaneRef, agentId: string): Promise<boolean> {
    const paneId = pane.paneId;
    try {
      await tmux.clearComposerDraft(pane);
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
    opts: {
      allowAwaitingHuman?: boolean;
      clearAwaitingHuman?: boolean;
      expectedTask?: Pick<TaskState, 'status' | 'phase' | 'signalToken'>;
      expectedReviewDispatch?: Pick<ReviewDispatchLease, 'generation' | 'claimId' | 'signalToken'>;
      expectedPostApproveEpisode?: PostApproveEpisodeKey;
      expectedHold?: { phase: string | undefined; since: string | undefined; nonce: string | undefined };
    } = {},
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
      if (!completion || !signalToken || completion.token !== signalToken
        || (opts.postApproveEpisode !== undefined
          && !this.postApproveEpisodeMatches(task, opts.postApproveEpisode))) {
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

    const taskWorkdir = agentState.workdir;
    if (!taskWorkdir) throw new Error(`Agent ${agentId} has no Workdir`);
    const lockToken = await this.resolveTaskLockToken(agentState, taskId);
    if (!lockToken) throw new Error(`Agent ${agentId} no longer owns task ${taskId}`);

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
        const stateNow = await this.agentStore.get(agentId);
        const stillOwner = stateNow?.taskId === taskId
          && stateNow.lockToken === lockToken
          && await this.lockManager.isOwner(agentId, taskId, lockToken);
        if (stillOwner) {
          await this.rollbackCreatedSession(agentId, err.partial, 'continueSession ensure rollback');
        } else {
          console.warn(
            `[AgentManager] continueSession ensureSession rollback skipped for stale owner ` +
            `${agentId}/${taskId}`,
          );
        }
      }
      throw err;
    }
    const { paneId, pane } = ensure;

    const runner = this.createRunnerFor(agent);
    const tmux = new TmuxManager(runner);
    const stateAfterEnsure = await this.agentStore.get(agentId);
    if (stateAfterEnsure?.taskId !== taskId || stateAfterEnsure.lockToken !== lockToken) {
      console.warn(`[AgentManager] continueSession[${phase}]: ownership changed during ensureSession; skipping`);
      return false;
    }
    await this.assertTaskLockOwner(agentId, taskId, lockToken);
    const verifiedWorkdir = stateAfterEnsure.workdir;
    if (
      !verifiedWorkdir
      || verifiedWorkdir !== ensure.workdir
      || verifiedWorkdir !== taskWorkdir
    ) {
      const reason =
        `Workdir changed during continueSession: ` +
        `before=${taskWorkdir}, ensure=${ensure.workdir}, state=${verifiedWorkdir ?? 'missing'}`;
      console.warn(`[AgentManager] continueSession[${phase}]: ${reason}; holding`);
      await this.markAwaitingHuman(
        agentId,
        'workdir-changed-during-dispatch',
        `${reason}. The prompt was not delivered; verify the agent runtime and Workdir before resuming.`,
        { expectedTaskId: taskId, ...(opts.expectedHold ? { expectedHold: opts.expectedHold } : {}) },
      );
      return false;
    }
    const expectedStatuses = PHASE_EXPECTED_STATUS[phase] ?? [];
    const taskAfterEnsure = await this.taskStore.get(taskId);
    if (!taskAfterEnsure || TERMINAL_STATUSES.includes(taskAfterEnsure.status)) {
      console.warn(
        `[AgentManager] continueSession: task ${taskId} status=${taskAfterEnsure?.status} terminal/missing after ensure; skipping`,
      );
      return false;
    }
    if (!opts.bypassTaskStatusGate && !expectedStatuses.includes(taskAfterEnsure.status)) {
      console.warn(
        `[AgentManager] continueSession: task ${taskId} status=${taskAfterEnsure.status} not in ` +
        `expected ${expectedStatuses.join('/')} for phase=${phase} after ensure; skipping`,
      );
      return false;
    }
    if (agent.role === 'dev' && task.branch) {
      const branches = new BranchManager(runner);
      if (!opts.allowDirtyWorkdir) await branches.assertClean(verifiedWorkdir);
      const actualRef = await branches.currentRef(verifiedWorkdir);
      if (actualRef !== `refs/heads/${task.branch}`) {
        // dev 可能已被释放过（如 spec max_rounds 停驻默认分支）；switchToTaskBranch 自带
        // assertClean，脏树时抛 DirtyWorkdirError fail-closed，不会覆盖未提交的改动
        await this.assertTaskGeneration(agentId, taskId, lockToken, verifiedWorkdir);
        await branches.switchToTaskBranch(
          verifiedWorkdir,
          taskId,
          task.branch,
          task.branchCreatedByBaxian === true,
          {
            requireExistingWork: true,
            ...(task.branchLocalCleaned
              ? { restorableRemoteTip: task.branchLocalCleaned.remoteTipSha }
              : {}),
          },
        );
        await this.assertTaskGeneration(agentId, taskId, lockToken, verifiedWorkdir);
        if (task.branchLocalCleaned) await this.clearBranchLocalCleaned(taskId);
      }
    } else if (agent.role === 'research') {
      await this.assertTaskGeneration(agentId, taskId, lockToken, verifiedWorkdir);
      await new BranchManager(runner).switchToDefaultDetached(verifiedWorkdir);
      await this.assertTaskGeneration(agentId, taskId, lockToken, verifiedWorkdir);
    }

    const promptSpecRound = opts.currentSpecRound ?? task.specReviewRound;
    let prompt: string;
    try {
      await this.prepareDispatchArtifacts(agent, verifiedWorkdir, phase, {
        specDocuments: opts.specDocuments,
        preserveOutputs: opts.preserveDispatchOutputs ?? false,
        assertOwner: async () => {
          await this.assertTaskGeneration(agentId, taskId, lockToken, verifiedWorkdir);
        },
      });
      const useIncrementalNudge =
        typeof opts.postApproveRedispatchCount === 'number'
        && opts.postApproveRedispatchCount > 0
        && !ensure.freshRuntime;
      const imagePaths = await this.imagePathsForDispatch(runner, task, phase);
      let payloadOpts: ServerPayloadPromptOpts = {};
      if (opts.serverContent !== undefined || opts.serverDiffstat !== undefined || opts.serverInterdiff !== undefined || opts.serverPriorFindings || opts.serverPriorResponse) {
        payloadOpts = await resolveServerPayloads(this.getReviewTransport(), agent, verifiedWorkdir, {
          phase,
          taskPhase: task.phase,
          ...(promptSpecRound !== undefined ? { specRound: promptSpecRound } : {}),
          reviewRound: task.reviewRound,
          ...(opts.serverBatch ? { batch: opts.serverBatch } : {}),
          ...(opts.serverContent !== undefined ? { serverContent: opts.serverContent } : {}),
          ...(opts.serverDiffstat !== undefined ? { serverDiffstat: opts.serverDiffstat } : {}),
          ...(opts.serverInterdiff !== undefined ? { serverInterdiff: opts.serverInterdiff } : {}),
          ...(opts.serverPriorFindings ? { serverPriorFindings: opts.serverPriorFindings } : {}),
          ...(opts.serverPriorResponse ? { serverPriorResponse: opts.serverPriorResponse } : {}),
        });
      }
      const taskForPrompt = await this.ensureGitBaseSnapshot(task, phase);
      const platformCli = this.platformCliContextOf(taskForPrompt);
      prompt = buildPromptInline({
        task: taskForPrompt,
        phase,
        agent,
        workdir: verifiedWorkdir,
        skillRegistry: this.skillRegistry,
        hasQaPartner: task.qaAgentId !== undefined,
        ...(platformCli ? { platformCli } : {}),
        ...(signalToken ? { signalToken } : {}),
        ...(useIncrementalNudge
          ? { postApproveRedispatchCount: opts.postApproveRedispatchCount }
          : {}),
        ...(promptSpecRound !== undefined ? { currentSpecRound: promptSpecRound } : {}),
        ...(imagePaths.length ? { imagePaths } : {}),
        ...(opts.serverBatch ? { serverBatch: opts.serverBatch } : {}),
        ...(opts.serverAfterDone ? { serverAfterDone: opts.serverAfterDone } : {}),
        ...(opts.serverFindingsDigest ? { serverFindingsDigest: opts.serverFindingsDigest } : {}),
        ...(opts.serverFeedbackCorrection ? { serverFeedbackCorrection: opts.serverFeedbackCorrection } : {}),
        ...payloadOpts,
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
    if (!agentFresh || agentFresh.lockToken !== lockToken) {
      console.warn(`[AgentManager] continueSession[${phase}]: ownership token changed; skipping`);
      return false;
    }
    if (agentFresh.workdir !== verifiedWorkdir) {
      const reason =
        `Workdir changed before prompt injection: ` +
        `verified=${verifiedWorkdir}, current=${agentFresh.workdir ?? 'missing'}`;
      console.warn(`[AgentManager] continueSession[${phase}]: ${reason}; holding`);
      await this.markAwaitingHuman(
        agentId,
        'workdir-changed-during-dispatch',
        `${reason}. The prompt was not delivered; verify the agent runtime and Workdir before resuming.`,
        { expectedTaskId: taskId, ...(opts.expectedHold ? { expectedHold: opts.expectedHold } : {}) },
      );
      return false;
    }
    await this.assertTaskLockOwner(agentId, taskId, lockToken);

    // A revoke marks before clearing and a push transitions before clearing; every half-window must abort the paste.
    const postApprovePassStillLive = async (): Promise<boolean> => {
      const [taskFresh, completionFresh] = await Promise.all([
        this.taskStore.get(taskId),
        this.getPostApproveCompletion(taskId),
      ]);
      return taskFresh?.agentId === agentId
        && taskFresh.status === 'approved'
        && taskFresh.postApproveRevoked === undefined
        && taskFresh.postApproveHeadSha !== undefined
        && completionFresh !== null
        && completionFresh.token === signalToken
        && completionFresh.approvedHeadSha === taskFresh.postApproveHeadSha
        && (opts.postApproveEpisode === undefined
          || this.postApproveEpisodeMatches(taskFresh, opts.postApproveEpisode));
    };
    if (phase === 'post-approve' && !(await postApprovePassStillLive())) {
      console.warn(
        `[AgentManager] continueSession[post-approve]: pass revoked or rotated before paste for task ${taskId}; skipping`,
      );
      return false;
    }
    const guardBeforeInject =
      opts.guardBeforeInject ?? (phase === 'post-approve' ? postApprovePassStillLive : undefined);

    if (opts.armBeforeInject && !(await opts.armBeforeInject({}))) {
      return false;
    }

    const now = new Date().toISOString();
    await this.agentStore.update(agentId, (latest) => {
      if (
        !latest
        || latest.taskId !== taskId
        || latest.lockToken !== lockToken
        || latest.workdir !== verifiedWorkdir
      ) {
        return AGENT_STORE_NOOP;
      }
      // The continuation prompt supersedes the previous question, but the arm-time
      // epoch bump owns that transition — stripping here would race an arm that
      // already re-established the watermark (post-approve arms before injecting).
      return {
        ...latest,
        paneId,
        workdir: verifiedWorkdir,
        lockToken,
        updatedAt: now,
      };
    });
    const stateBeforeInject = await this.agentStore.get(agentId);
    if (stateBeforeInject?.taskId !== taskId || stateBeforeInject.lockToken !== lockToken) {
      console.warn(`[AgentManager] continueSession[${phase}]: ownership changed before prompt injection; skipping`);
      return false;
    }
    if (stateBeforeInject.workdir !== verifiedWorkdir) {
      const reason =
        `Workdir changed before prompt injection: ` +
        `verified=${verifiedWorkdir}, current=${stateBeforeInject.workdir ?? 'missing'}`;
      console.warn(`[AgentManager] continueSession[${phase}]: ${reason}; holding`);
      await this.markAwaitingHuman(
        agentId,
        'workdir-changed-during-dispatch',
        `${reason}. The prompt was not delivered; verify the agent runtime and Workdir before resuming.`,
        { expectedTaskId: taskId, ...(opts.expectedHold ? { expectedHold: opts.expectedHold } : {}) },
      );
      return false;
    }
    await this.assertTaskLockOwner(agentId, taskId, lockToken);

    if (guardBeforeInject && !(await guardBeforeInject())) {
      console.warn(
        `[AgentManager] continueSession[${phase}]: pre-inject guard rejected the paste for task ${taskId}; skipping`,
      );
      return false;
    }
    const delivery = await this.injectAndAwaitAck(
      tmux, pane, prompt, agentId, agent.runtime, guardBeforeInject,
    );
    if (delivery.aborted) {
      console.warn(
        `[AgentManager] continueSession[${phase}]: pre-paste guard rejected the inject for task ${taskId}; skipping`,
      );
      return false;
    }
    return true;
  }

  private async rollbackUndeliveredBootstrap(
    state: AgentBindingFacts,
  ): Promise<boolean> {
    if (
      !state.taskId
      || state.bootstrappingTaskId !== state.taskId
      || state.awaitingPhase === 'bootstrap-marker-clear-failed'
    ) {
      return false;
    }
    const boundTask = await this.taskStore.get(state.taskId);
    if (!boundTask) return false;

    if (boundTask.status === 'spec-ready' && isSpecStagePhase(boundTask.phase)) {
      if (state.id === boundTask.devAgentId && state.id !== boundTask.agentId) {
        const lockToken = state.lockToken;
        await this.agentStore.update(state.id, (latest) => {
          if (
            !latest
            || latest.taskId !== state.taskId
            || latest.bootstrappingTaskId !== state.taskId
            || latest.lockToken !== lockToken
          ) {
            return AGENT_STORE_NOOP;
          }
          return {
            id: latest.id,
            projectId: latest.projectId,
            ...(latest.paneId !== undefined ? { paneId: latest.paneId } : {}),
            ...(latest.workdir !== undefined ? { workdir: latest.workdir } : {}),
            ...(latest.creationToken !== undefined ? { creationToken: latest.creationToken } : {}),
            updatedAt: new Date().toISOString(),
          };
        });
        if (lockToken) await this.lockManager.releaseIfOwner(state.id, state.taskId, lockToken);
        return true;
      }
      await this.clearBootstrapMarker(state.id, state.taskId);
      return false;
    }

    if (boundTask.status !== 'in_progress' || boundTask.agentId !== state.id) return false;
    const dispatchPhase = boundTask.phase === 'research'
      ? 'research'
      : boundTask.specReviewRound !== undefined ? 'code' : 'develop';
    if (await this.bootstrapPromptWasDelivered(
      state.taskId,
      boundTask.createdAt,
      state.id,
      dispatchPhase,
    )) {
      await this.clearBootstrapMarker(state.id, state.taskId);
      return false;
    }

    if (dispatchPhase === 'code') {
      await this.markAwaitingHuman(
        state.id,
        'code-dispatch-failed',
        'Code-phase handoff was interrupted before the prompt was delivered. Resume to replay the persisted Spec documents.',
        { expectedTaskId: state.taskId },
      );
      return true;
    }
    console.warn(
      `[recover] agent ${state.id} was mid-bootstrap for in_progress task ${state.taskId} ` +
      `(prompt never ack'd); rolling the task back to pending`,
    );
    await this.rollbackFailedDispatch(state.taskId, state.id, undefined, state.lockToken);
    await this.agentStore.update(state.id, (latest) => {
      if (!latest || latest.status !== 'awaiting_human') return AGENT_STORE_NOOP;
      const { status: _s, awaitingPhase: _p, awaitingReason: _r, awaitingSince: _a, ...rest } = latest;
      return { ...rest, updatedAt: new Date().toISOString() };
    });
    return true;
  }

  private async bootstrapPromptWasDelivered(
    taskId: string,
    createdAtIso: string,
    agentId: string,
    phase: 'develop' | 'research' | 'code',
  ): Promise<boolean> {
    const today = new Date().toISOString().slice(0, 10);
    const from = createdAtIso.slice(0, 10);
    try {
      const events = await this.eventBus.readRange(from, today);
      return events.some((event) => event.type === 'session.started'
        && event.taskId === taskId
        && event.agentId === agentId
        && event.data.phase === phase);
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

  // continueSession never runs startSession's post-ack finalization; a surviving marker would make recover() roll the running task back to pending.
  private async finalizeReplayedBootstrap(
    agentId: string,
    taskId: string,
    phase: 'develop' | 'research' | 'code',
    expectedLockToken: string | undefined,
  ): Promise<void> {
    let cleared = false;
    let deliveredWorkdir: string | undefined;
    try {
      await this.agentStore.update(agentId, (latest) => {
        if (
          !latest
          || latest.taskId !== taskId
          || latest.bootstrappingTaskId !== taskId
          || latest.lockToken !== expectedLockToken
        ) {
          return AGENT_STORE_NOOP;
        }
        cleared = true;
        deliveredWorkdir = latest.workdir;
        const { bootstrappingTaskId: _delivered, ...rest } = latest;
        return { ...rest, updatedAt: new Date().toISOString() };
      });
    } catch (err) {
      console.warn(`[AgentManager] replay: clearing bootstrap marker for task=${taskId} failed:`, err);
      await this.markAwaitingHuman(
        agentId,
        'bootstrap-marker-clear-failed',
        'Prompt was replayed but clearing the in-flight bootstrap marker failed; held so recovery does ' +
          'not roll back an already-running task. Verify the agent via web terminal, then Resume.',
        { expectedTaskId: taskId },
      ).catch((holdErr) => {
        console.warn(`[AgentManager] replay: hold after marker-clear failure for task=${taskId} failed:`, holdErr);
      });
      return;
    }
    if (!cleared) return;
    try {
      await this.eventBus.emit({
        id: '',
        type: 'session.started',
        timestamp: new Date().toISOString(),
        projectId: this.getAgentConfig(agentId)?.projectId ?? '',
        agentId,
        taskId,
        data: { phase, ...(deliveredWorkdir !== undefined ? { workdir: deliveredWorkdir } : {}) },
      });
    } catch (err) {
      console.warn(`[AgentManager] replay: session.started emit failed for task=${taskId}:`, err);
    }
  }

  private async releaseOrphanedLocks(states: AgentBindingFacts[]): Promise<void> {
    const bindings = new Map(states.map(state => [state.id, state]));
    const claims = await this.lockManager.listClaims();
    for (const claim of claims) {
      const binding = bindings.get(claim.agentId);
      const exactBinding = binding?.taskId === claim.taskId && binding.lockToken === claim.token;
      if (!claim.taskId.startsWith('maintenance:') && exactBinding) continue;
      const released = await this.lockManager.releaseIfOwner(
        claim.agentId,
        claim.taskId,
        claim.token,
      );
      if (!released) {
        console.warn(
          `[recover] lock changed while reclaiming ${claim.agentId}/${claim.taskId}; preserving the newer claim`,
        );
      }
    }
  }

  async recover(): Promise<void> {
    await this.flushTaskOutboxes().catch(err => {
      console.warn('[AgentManager] recover: task outbox flush failed:', err);
    });
    await this.retryGitRemoteCleanupIntents().catch(err => {
      console.warn('[AgentManager] recover: git remote cleanup retry failed:', err);
    });
    const states = await this.agentStore.list();
    await this.releaseOrphanedLocks(states);
    const deferredCleanups: Array<{ failingAgentId: string; failedTaskIds: string[]; projectIds: string[] }> = [];

    for (const state of states) {
      const agentConfig = this.getAgentConfig(state.id);
      if (!agentConfig) continue;
      if (state.taskId) {
        let token: string | null = null;
        try {
          token = await this.resolveTaskLockToken(state, state.taskId);
        } catch (err) {
          console.warn(`[recover] lock validation failed for ${state.id}/${state.taskId}:`, err);
        }
        if (!token) {
          const reason = `Exclusive lock ownership cannot be proven for task ${state.taskId}; runtime recovery was not attempted.`;
          await this.markAwaitingHuman(
            state.id,
            'recovery-lock-invalid',
            reason,
            { expectedTaskId: state.taskId },
          );
          await this.recordError({
            agentId: state.id,
            projectId: state.projectId,
            taskId: state.taskId,
            operation: 'recovery',
            reason: 'LOCK_OWNERSHIP_INVALID',
            message: reason,
            observation: { phase: 'pre-runtime-recovery' },
            recommendation: 'Inspect the persisted lock and task binding, then cancel or delete the Agent if ownership cannot be restored.',
          });
          continue;
        }
        state.lockToken = token;
      }
      try {
        const result = await this.ensureSession(state.id, 'recover');
        if (await this.rollbackUndeliveredBootstrap(state)) continue;
        if (state.creationToken && !state.taskId) {
          const ct = state.creationToken;
          const pane = result.pane;
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
                return { ...ready, paneId: pane.paneId, updatedAt: new Date().toISOString() };
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
          && (boundTask.status === 'merged' || boundTask.status === 'done')
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
            if (boundTask.status === 'merged' && boundTask.prNumber != null && boundTask.branch) {
              await this.dispatchPostMergeCleanup(state.id, {
                taskId: boundTask.id,
                branch: boundTask.branch,
              });
              continue;
            }
            if (this.startCompactionThenRelease(recovered.id, recovered, boundTask.id)) continue;
          } catch (cleanupErr) {
            console.warn(
              `[recover] dispatchPostMergeCleanup(${state.id}, ${boundTask.id}) failed:`,
              cleanupErr,
            );
          }
        }
        const cancelHold = isCancelCleanupHold(state);
        const shouldReleaseBinding = shouldReleaseHeldBinding(state, boundTask) && !cancelHold;
        if (shouldReleaseBinding && state.taskId) {
          await this.agentStore.update(state.id, (latest) => {
            if (!latest || latest.taskId !== state.taskId) return AGENT_STORE_NOOP;
            return { ...latest, paneId: result.paneId, updatedAt: new Date().toISOString() };
          });
          await this.releaseAgentForTask(state.id, state.taskId, 'idle', {
            allowAwaitingHuman: true,
          });
          continue;
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
            ...(latest.workdir !== undefined ? { workdir: latest.workdir } : {}),
            status: 'ok' as const,
          };
          if (shouldReleaseBinding) {
            return base;
          }
          const withBinding = {
            ...base,
            ...(latest.taskId !== undefined ? { taskId: latest.taskId } : {}),
            ...(latest.lockToken !== undefined ? { lockToken: latest.lockToken } : {}),
            ...(latest.startedAt !== undefined ? { startedAt: latest.startedAt } : {}),
            ...(latest.needInput !== undefined ? { needInput: latest.needInput } : {}),
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
        if (state.taskId && !shouldReleaseBinding && !cancelHold) {
          this.startRuntimeMenuWatch(state.id);
        }
      } catch (err) {
        if (err instanceof EnsureSessionError && err.partial.dialogPending) {
          if (await this.rollbackUndeliveredBootstrap(state)) continue;
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
          await this.rollbackCreatedSession(state.id, err.partial, 'recover ensure rollback');
        }
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[recover] ensureSession failed for agent=${state.id}: ${message}`);
        await this.agentStore.update(state.id, (latest) => {
          if (!latest) return AGENT_STORE_NOOP;
          return {
            ...latest,
            paneId: undefined,
            creationToken: undefined,
            ...(latest.taskId ? {
              status: 'awaiting_human' as const,
              awaitingPhase: 'recovery-failed',
              awaitingReason: message,
              awaitingSince: new Date().toISOString(),
            } : {}),
            updatedAt: new Date().toISOString(),
          };
        });
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
        await this.emitIntervention(state.projectId, state.id, state.taskId, { phase: 'recovery-failed', error: message });
      }
    }

    for (const c of deferredCleanups) {
      await this.releasePartnersAndDrain(c.failingAgentId, c.failedTaskIds, c.projectIds);
    }
    await this.recoverClaimedGitReviewDispatches().catch(err => {
      console.warn('[AgentManager] recover: claimed git review recovery failed:', err);
    });
    await this.retryPendingGitReviewDispatches().catch(err => {
      console.warn('[AgentManager] recover: pending git review retry failed:', err);
    });
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
          && !existing.startedAt
          && !existing.paneId
          && !existing.creationToken
        ) {
          return AGENT_STORE_NOOP;
        }
        changed = true;
        if (existing.taskId) {
          return {
            ...existing,
            paneId: undefined,
            status: 'awaiting_human',
            awaitingPhase: 'runtime-missing',
            awaitingReason: 'The tmux session is missing; restart the REPL before releasing this task binding.',
            awaitingSince: timestamp,
            updatedAt: timestamp,
          };
        }
        return {
          id: existing.id,
          projectId: existing.projectId,
          ...(existing.workdir !== undefined ? { workdir: existing.workdir } : {}),
          updatedAt: timestamp,
        };
      });

      if (!projectId || !changed) return null;
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
    let remoteCleanupGeneration: string | undefined;
    let publishedCleanup: {
      afterDone: 'pr';
      branch: string;
      prNumber: number;
      devAgentId?: string;
      mayBeInFlight: boolean;
    } | undefined;
    this.phaseSignalWatcher?.stop(taskId);
    let cleanupClaimed = false;
    const result = await this.withTaskLock(async () => {
      let task = await this.taskStore.get(taskId);
      if (!task) throw new ApiError(404, 'Task not found');

      if (this.markCompleteInFlight.has(taskId)) {
        throw new ApiError(409, `Task ${taskId} is being completed (merge in progress); try again shortly`);
      }

      // 终态不早退：状态不再改写，但残留的 pane/绑定（上次清理中途失败）仍走同一条强制清理路径。
      // 唯一例外：清理已在进行中的重复取消——重跑只会重复中断同一批 pane，等它收尾即可。
      const alreadyTerminal = TERMINAL_STATUSES.includes(task.status);
      if (alreadyTerminal && this.cancelCleanupInFlight.has(taskId)) return task;
      if (alreadyTerminal) remoteCleanupGeneration = task.remoteCleanup?.generation;

      if (task.agentId) devToRelease = task.agentId;
      if (task.qaAgentId) qaToRelease = task.qaAgentId;
      const publishedAtGate = task.status === 'ready'
        || (task.status === 'approved' && !!task.publishDispatchedAt);
      if (task.reviewMode === 'server' && publishedAtGate && task.agentId) {
        const afterDone = this.resolveAfterDone(task);
        if (afterDone === 'pr' && task.branch && task.prNumber !== undefined) {
          publishedCleanup = {
            afterDone,
            branch: task.branch,
            prNumber: task.prNumber,
            devAgentId: task.agentId,
            mayBeInFlight: task.status === 'approved',
          };
        }
      }

      for (const id of [devToRelease, qaToRelease]) {
        if (id) await this.markPaneCancelClearing(id, taskId);
      }

      if (!alreadyTerminal) {
        const now = new Date().toISOString();
        if (task.reviewMode === 'git' && task.prNumber !== undefined && task.branch !== undefined) {
          const expectedHeadSha = typeof task.latestHeadSha === 'string'
            && PLATFORM_HEAD_SHA_RE.test(task.latestHeadSha) ? task.latestHeadSha : undefined;
          const intent = task.remoteCleanup ?? {
            generation: createSignalToken(),
            stage: 'close-pending' as const,
            prNumber: task.prNumber,
            branch: task.branch,
            ...(expectedHeadSha !== undefined ? { expectedHeadSha } : {}),
            updatedAt: now,
          };
          task.remoteCleanup = intent;
          remoteCleanupGeneration = intent.generation;
        }
        task = this.stripGitStatusScopedState(task, 'cancelled');
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
      }

      this.claimCancelCleanup(taskId);
      cleanupClaimed = true;
      return task;
    });

    // stop again post-write: a rollback may have re-armed between the pre-lock stop() and the cancelled write
    if (cleanupClaimed) this.phaseSignalWatcher?.stop(taskId);

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

    if (remoteCleanupGeneration !== undefined) {
      try {
        await this.processGitRemoteCleanup(taskId, remoteCleanupGeneration);
      } catch (err) {
        console.warn(`[AgentManager] cancelTask remote retirement failed for ${taskId}:`, err);
        await this.emitIntervention(result.projectId, undefined, taskId, {
          phase: 'cancel-published-artifact-cleanup-failed',
          error: safeDriverErrorText(err),
          generation: remoteCleanupGeneration,
        });
      }
    }

    if (publishedCleanup) {
      if (publishedCleanup.mayBeInFlight && !devStopConfirmed) {
        await this.emitIntervention(result.projectId, undefined, taskId, {
          phase: 'cancel-published-artifact-cleanup-skipped',
          afterDone: publishedCleanup.afterDone,
          branch: publishedCleanup.branch,
          prNumber: publishedCleanup.prNumber,
          reason: 'dev pane stop unconfirmed; the publish prompt may still be running and would recreate the remote artifacts',
        });
        return result;
      }
      try {
        const { driver } = await this.platformTaskAndDriver(taskId);
        await driver.runOp('close', { prNumber: publishedCleanup.prNumber });
        await this.safeEmit({
          id: '',
          type: 'task.updated',
          timestamp: new Date().toISOString(),
          projectId: result.projectId,
          taskId,
          data: {
            status: 'cancelled',
            operation: 'server-pr-close',
            outcome: 'succeeded',
            branch: publishedCleanup.branch,
            prNumber: publishedCleanup.prNumber,
          },
        });
      } catch (err) {
        console.warn(`[AgentManager] cancelTask remote retirement failed for ${taskId}:`, err);
        await this.emitIntervention(result.projectId, undefined, taskId, {
          phase: 'cancel-published-artifact-cleanup-failed',
          afterDone: publishedCleanup.afterDone,
          branch: publishedCleanup.branch,
          prNumber: publishedCleanup.prNumber,
          error: err instanceof Error ? err.message : String(err),
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
      if (!TASK_OWNER_ROLES.has(cfg.role)) {
        throw new ApiError(400, `Agent ${input.preferredAgentId} is not dev or research role`);
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

  private gitReviewClaimMatches(
    task: TaskState,
    expected: Pick<ReviewDispatchLease, 'generation' | 'claimId' | 'signalToken'
      | 'headSha' | 'passToken' | 'failToken' | 'effectiveRound' | 'qaPhase'>,
  ): boolean {
    const lease = task.reviewDispatch;
    return lease?.phase === 'claimed'
      && lease.generation === expected.generation
      && lease.claimId === expected.claimId
      && lease.signalToken === expected.signalToken
      && lease.headSha === expected.headSha
      && lease.passToken === expected.passToken
      && lease.failToken === expected.failToken
      && lease.effectiveRound === expected.effectiveRound
      && lease.qaPhase === expected.qaPhase
      && this.gitReviewLeaseMatches(task, lease);
  }

  private gitReviewDispatchMatches(task: TaskState, expected: ReviewDispatchFence): boolean {
    const lease = task.reviewDispatch;
    return lease !== undefined
      && lease.generation === expected.generation
      && lease.signalToken === expected.signalToken
      && lease.headSha === expected.headSha
      && lease.passToken === expected.passToken
      && lease.failToken === expected.failToken
      && lease.effectiveRound === expected.effectiveRound
      && lease.qaPhase === expected.qaPhase
      && this.gitReviewLeaseMatches(task, lease);
  }

  async dispatchGitReviewLease(
    taskId: string,
    opts: {
      expectedGeneration?: string;
      pendingBudget?: { since: number; budgetAlerted?: boolean };
      onQaAcquired?: (lockToken: string) => void;
    } = {},
  ): Promise<TaskState> {
    const claimed = await this.claimGitReviewDispatch(taskId, opts.expectedGeneration);
    if (!claimed) {
      throw new ApiError(409, `Git review dispatch for ${taskId} was already claimed or superseded`, 'dispatch-superseded');
    }
    const { task, lease } = claimed;
    const qaId = task.qaAgentId;
    if (!qaId || !this.gitReviewQaConfigUsable(task)) {
      await this.resetGitReviewDispatchClaim(taskId, lease);
      throw new ApiError(409, `Task ${taskId} has no available QA participant`);
    }
    const qaPhase = lease.qaPhase;

    const previousQa = await this.agentStore.get(qaId);
    if (previousQa?.taskId === taskId) {
      if (previousQa.status === 'awaiting_human' && !isRecoverableQaDispatchHold(previousQa)) {
        await this.resetGitReviewDispatchClaim(taskId, lease);
        throw new ApiError(
          409,
          `QA agent ${qaId} is awaiting human (${previousQa.awaitingPhase ?? 'unknown phase'})`,
        );
      }
      const released = await this.releaseAgentForTask(qaId, taskId, 'idle', {
        expectedTask: { status: 'review', phase: task.phase, signalToken: lease.signalToken },
        expectedReviewDispatch: lease,
        ...(previousQa.lockToken !== undefined ? { expectedLockToken: previousQa.lockToken } : {}),
        ...(previousQa.status === 'awaiting_human'
          ? {
              allowAwaitingHuman: true,
              expectedHold: {
                phase: previousQa.awaitingPhase,
                since: previousQa.awaitingSince,
                nonce: previousQa.awaitingNonce,
              },
            }
          : {}),
      });
      if (!released) {
        await this.resetGitReviewDispatchClaim(taskId, lease);
        throw new ApiError(409, `QA agent ${qaId} could not be released for git review dispatch`);
      }
    }

    let acquiredLockToken: string | undefined;
    const acquired = await this.acquireAgentForTask(qaId, taskId, qaPhase, {
      onAcquired: token => {
        acquiredLockToken = token;
        opts.onQaAcquired?.(token);
      },
    });
    if (!acquired) {
      await this.resetGitReviewDispatchClaim(taskId, lease);
      throw new ApiError(409, `QA agent ${qaId} is busy or unavailable`);
    }
    const ownAcquire = acquiredLockToken === undefined ? {} : { expectedLockToken: acquiredLockToken };
    const releaseOwnAcquire = async (): Promise<void> => {
      await this.releaseAgentForTask(qaId, taskId, 'idle', ownAcquire).catch(err => {
        console.error(`[AgentManager] git review releaseAgentForTask(${qaId}, ${taskId}) failed:`, err);
      });
    };
    const resetKnownUndelivered = async (): Promise<void> => {
      this.phaseSignalWatcher?.stopAgentIfToken(taskId, qaId, lease.signalToken);
      await this.resetGitReviewDispatchClaim(taskId, lease);
    };

    if (task.agentId) {
      const dev = await this.agentStore.get(task.agentId);
      if (dev?.taskId === taskId) {
        const parked = await this.markAgentWaiting(task.agentId, taskId, {
          expectedReviewDispatch: lease,
        }).catch(err => {
          console.error(`[AgentManager] git review could not park dev ${task.agentId}:`, err);
          return false;
        });
        if (!parked) {
          await resetKnownUndelivered();
          await releaseOwnAcquire();
          throw new ApiError(500, `Cannot park dev ${task.agentId} before git review dispatch`);
        }
      }
    }

    const armed = await this.withTaskLock(async () => {
      const fresh = await this.taskStore.get(taskId);
      if (!fresh || !this.gitReviewClaimMatches(fresh, lease)) return false;
      return this.setupPhaseSignalWatcher(
        taskId,
        qaId,
        PASSIVE_VERDICT_WATCH,
        lease.signalToken,
        { needInputMode: 'fresh', replaceScope: 'agent' },
      );
    });
    if (!armed) {
      await resetKnownUndelivered();
      await releaseOwnAcquire();
      throw new ApiError(500, `Failed to arm git review verdict watcher for ${taskId}`);
    }
    await this.rearmGitReconciliationWatcher(taskId);

    let started: boolean;
    try {
      started = await this.startSession(taskId, qaId, qaPhase, {
        bypassTaskStatusGate: true,
        dialogFailFromStatuses: ['review'],
        dispatchPassToken: lease.signalToken,
        dispatchReviewLease: lease,
        ...(opts.pendingBudget !== undefined ? { dispatchPendingBudget: opts.pendingBudget } : {}),
      });
    } catch (err) {
      if (err instanceof DispatchTerminalError && err.reason === 'ack_unknown') {
        const uncertain = await this.markGitReviewDispatchUncertain(taskId, lease);
        if (uncertain) {
          try {
            await this.markAwaitingIfAckUnknown(qaId, err, taskId);
          } catch (holdErr) {
            console.error(`[AgentManager] git review ack_unknown hold failed for ${qaId}:`, holdErr);
          }
        }
        throw err;
      }
      if (err instanceof EnsureSessionError && err.partial.busyPending) {
        await this.resetGitReviewDispatchClaim(taskId, lease);
        const pending = await this.taskStore.get(taskId);
        if (!pending) throw new ApiError(404, `Task ${taskId} disappeared during git review dispatch`);
        return pending;
      }
      await resetKnownUndelivered();
      if (!(err instanceof EnsureSessionError && err.partial.handled)) await releaseOwnAcquire();
      throw err;
    }
    if (!started) {
      await resetKnownUndelivered();
      await releaseOwnAcquire();
      throw new ApiError(500, `Failed to start git QA review session for ${taskId}`);
    }
    await this.completeGitReviewDispatch(taskId, lease);
    const final = await this.taskStore.get(taskId);
    if (!final) throw new ApiError(404, `Task ${taskId} disappeared after git review dispatch`);
    return final;
  }

  async dispatchReviewToQa(
    taskId: string,
    opts: {
      fromStatus?: TaskStatus[];
      bumpRound?: boolean;
      expectSignalToken?: string;
      expectPhase?: TaskPhase;
      qaPhase?: 'review' | 'recheck';
      pendingBudget?: { since: number; budgetAlerted?: boolean };
      onPassArmed?: (armedToken: string) => void;
      onQaAcquired?: (lockToken: string) => void;
      confirmUncertainNotDelivered?: boolean;
    } = {},
  ): Promise<TaskState> {
    let routeTask = await this.taskStore.get(taskId);
    if (routeTask?.reviewMode === 'git' && !isSpecStagePhase(routeTask.phase)) {
      if (opts.fromStatus && !opts.fromStatus.includes(routeTask.status)) {
        throw new ApiError(
          409,
          `Task ${taskId} status is ${routeTask.status}; review dispatch requires ${opts.fromStatus.join('/')}`,
          'dispatch-superseded',
        );
      }
      if (Object.hasOwn(opts, 'expectSignalToken') && routeTask.signalToken !== opts.expectSignalToken) {
        throw new ApiError(409, `Task ${taskId} review pass changed during redispatch`, 'dispatch-superseded');
      }
      if (Object.hasOwn(opts, 'expectPhase') && routeTask.phase !== opts.expectPhase) {
        throw new ApiError(409, `Task ${taskId} review phase changed during redispatch`, 'dispatch-superseded');
      }
      let lease = routeTask.reviewDispatch;
      if (lease?.phase === 'uncertain') {
        if (opts.confirmUncertainNotDelivered !== true) {
          throw new ApiError(
            409,
            `Git review delivery for ${taskId} is uncertain; verify the QA pane did not receive it, then retry manually`,
            'dispatch-uncertain',
          );
        }
        if (routeTask.prNumber === undefined) {
          throw new ApiError(400, `Task ${taskId} has no PR yet; cannot confirm review delivery`);
        }
        const verified = await this.platformVerifyPrBinding(taskId, routeTask.prNumber);
        if (!verified.ok) {
          throw new ApiError(409, `Cannot confirm git review for ${taskId}: binding ${verified.reason}`);
        }
        if (!PLATFORM_HEAD_SHA_RE.test(verified.headSha)) {
          throw new ApiError(502, `Cannot confirm git review for ${taskId}: invalid platform head`);
        }
        const confirmed = await this.confirmUncertainGitReviewDispatch(
          taskId,
          lease.generation,
          verified.headSha,
        );
        if (!confirmed?.reviewDispatch) {
          throw new ApiError(409, `Task ${taskId} changed before uncertain delivery was confirmed`, 'dispatch-superseded');
        }
        routeTask = confirmed;
        lease = confirmed.reviewDispatch;
      }
      if (lease === undefined) {
        if (routeTask.prNumber === undefined) {
          throw new ApiError(400, `Task ${taskId} has no PR yet; cannot dispatch review`);
        }
        const verified = await this.platformVerifyPrBinding(taskId, routeTask.prNumber);
        if (!verified.ok) {
          throw new ApiError(409, `Cannot dispatch git review for ${taskId}: binding ${verified.reason}`);
        }
        if (!PLATFORM_HEAD_SHA_RE.test(verified.headSha)) {
          throw new ApiError(502, `Cannot dispatch git review for ${taskId}: invalid platform head`);
        }
        const begun = await this.beginGitReviewPass(taskId, {
          fromStatus: [routeTask.status],
          headSha: verified.headSha,
          bumpRound: opts.bumpRound !== false,
          ...(opts.qaPhase !== undefined ? { qaPhase: opts.qaPhase } : {}),
          expectSignalToken: routeTask.signalToken,
          expectPhase: routeTask.phase,
          patch: { latestHeadSha: verified.headSha },
        });
        if (!begun?.task.reviewDispatch) {
          throw new ApiError(409, `Task ${taskId} changed before git review pass creation`, 'dispatch-superseded');
        }
        lease = begun.task.reviewDispatch;
      }
      const dispatched = await this.dispatchGitReviewLease(taskId, {
        expectedGeneration: lease.generation,
        ...(opts.pendingBudget !== undefined ? { pendingBudget: opts.pendingBudget } : {}),
        ...(opts.onQaAcquired !== undefined ? { onQaAcquired: opts.onQaAcquired } : {}),
      });
      opts.onPassArmed?.(lease.signalToken);
      return dispatched;
    }

    const claim = await this.withTaskLock(async () => {
      if (this.manualReviewInFlight.has(taskId)) {
        throw new ApiError(409, `Manual review already in progress for task ${taskId}`, 'dispatch-in-flight');
      }
      if (this.markCompleteInFlight.has(taskId)) {
        throw new ApiError(
          409,
          `Task ${taskId} is being completed (merge in progress); try again shortly`,
          'dispatch-in-flight',
        );
      }
      const task = await this.taskStore.get(taskId);
      if (!task) throw new ApiError(404, `Task ${taskId} not found`);
      if (task.reviewMode !== 'server' && !isSpecStagePhase(task.phase)) {
        throw new ApiError(409, `Task ${taskId} review mode changed during dispatch; retry`, 'dispatch-superseded');
      }
      if (opts.fromStatus && !opts.fromStatus.includes(task.status)) {
        throw new ApiError(
          409,
          `Task ${taskId} status is ${task.status}; review dispatch requires ${opts.fromStatus.join('/')}`,
          'dispatch-superseded',
        );
      }
      if (Object.hasOwn(opts, 'expectSignalToken') && task.signalToken !== opts.expectSignalToken) {
        throw new ApiError(
          409,
          `Task ${taskId} review pass changed during redispatch (signalToken rotated); aborting`,
          'dispatch-superseded',
        );
      }
      if (Object.hasOwn(opts, 'expectPhase') && task.phase !== opts.expectPhase) {
        throw new ApiError(
          409,
          `Task ${taskId} review pass changed during redispatch (phase changed); aborting`,
          'dispatch-superseded',
        );
      }
      if (!MANUAL_SERVER_REVIEW_STATUSES.includes(task.status)) {
        throw new ApiError(
          409,
          `Task ${taskId} status is ${task.status}; manual server-side review requires ${MANUAL_SERVER_REVIEW_STATUSES.join('/')}`,
        );
      }
      if (!this.serverReviewDriver) {
        throw new ApiError(409, `Server review pipeline is not configured; cannot dispatch review for ${taskId}`);
      }
      if (task.status === 'in_progress' && task.phase === undefined) {
        throw new ApiError(
          409,
          `Task ${taskId} has no phase yet (the dev has not delivered spec-done/code-done); wait for the dev signal or use Cancel/Retry`,
        );
      }
      const qaAvailable = task.qaAgentId !== undefined && this.getAgentConfig(task.qaAgentId)?.role === 'qa';
      if (!qaAvailable) {
        throw new ApiError(400, `Task ${taskId} has no QA partner configured; manual review requires a QA agent`);
      }
      const isSpec = isSpecStagePhase(task.phase);
      const cap = this.config.review.rounds + (task.maxRoundsContinues ?? 0);
      const round = isSpec ? (task.specReviewRound ?? 0) : task.reviewRound;
      const nextRound = opts.bumpRound === false ? round : round + 1;
      if (nextRound < 1) {
        throw new ApiError(409, `Task ${taskId} has no current review round to redispatch`);
      }
      if (nextRound > cap) {
        throw new ApiError(409, `Task ${taskId} reached the review round cap (${cap}); continue or cancel it instead`);
      }
      this.manualReviewInFlight.add(taskId);
      return {
        isSpec,
        reviewPass: {
          status: task.status,
          phase: task.phase,
          signalToken: task.signalToken,
        },
        bumpRound: opts.bumpRound,
      };
    });

    return this.runManualServerReview(taskId, claim);
  }

  private async runManualServerReview(
    taskId: string,
    claim: {
      isSpec: boolean;
      reviewPass: Pick<TaskState, 'status' | 'phase' | 'signalToken'>;
      bumpRound?: boolean;
    },
  ): Promise<TaskState> {
    try {
      // 不在此处预释放旧 QA：可失败的准备工作（读 diff/spec、存轮次）失败时旧 pass 必须原样保留；
      // 同任务的 QA 重新绑定由 dispatchServerReviewToQa 在派发前完成
      const fresh = await this.taskStore.get(taskId);
      if (!fresh
        || fresh.status !== claim.reviewPass.status
        || fresh.phase !== claim.reviewPass.phase
        || fresh.signalToken !== claim.reviewPass.signalToken
        || !MANUAL_SERVER_REVIEW_STATUSES.includes(fresh.status)) {
        throw new ApiError(409, `Task ${taskId} changed during manual review dispatch; aborting`);
      }
      const dispatched = claim.isSpec
        ? claim.bumpRound === false
          ? await this.serverReviewDriver!.dispatchSpecReview(fresh, { bumpRound: false })
          : await this.serverReviewDriver!.dispatchSpecReview(fresh)
        : claim.bumpRound === false
          ? await this.serverReviewDriver!.dispatchCodeReview(fresh, { bumpRound: false })
          : await this.serverReviewDriver!.dispatchCodeReview(fresh);
      if (!dispatched) {
        throw new ApiError(500, `Manual review dispatch for ${taskId} did not start; check the event feed for the cause`);
      }
      return (await this.taskStore.get(taskId))!;
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
    if (isSpecStagePhase(task.phase)) {
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
    if (devState?.taskId !== taskId || !devState.workdir) {
      throw new ApiError(
        409,
        `Dev ${devAgentId} no longer holds task ${taskId}'s Workdir (cannot continue); ` +
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

    const { armed } = await this.rotateAndSetupPhaseSignal(
      taskId,
      devAgentId,
      'pr-fixed',
      { expectedStatus: 'fixing', expectedToken: transitioned.task.signalToken },
    );
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

  private devInitialSignalKinds(reviewMode: TaskState['reviewMode']): readonly PhaseSignalKind[] {
    return reviewMode === 'server'
      ? (['spec-done', 'code-done'] as const)
      : (['spec-done', 'pr-created'] as const);
  }

  private resolveInitialDispatch(task: Pick<TaskState, 'phase' | 'reviewMode'>): {
    phase: 'develop' | 'research';
    kinds: readonly PhaseSignalKind[];
  } {
    if (task.phase === 'research') return { phase: 'research', kinds: ['spec-done'] };
    return { phase: 'develop', kinds: this.devInitialSignalKinds(task.reviewMode) };
  }

  private mapTaskStateToExpectedWatchers(task: TaskState): Array<{
    expectedKinds: readonly PhaseSignalKind[];
    agentId: string;
    token?: string;
  }> {
    const single = this.mapTaskStateToExpectedWatcher(task);
    const mappings: Array<{ expectedKinds: readonly PhaseSignalKind[]; agentId: string; token?: string }> =
      single ? [single] : [];
    if (task.reviewMode === 'git' && task.status === 'review'
      && task.replyActorStatus !== 'verified' && task.pendingPrSignalToken !== undefined
      && task.devAgentId && task.prNumber !== undefined) {
      mappings.push({
        expectedKinds: ['pr-created'],
        agentId: task.devAgentId,
        token: task.pendingPrSignalToken,
      });
    }
    return mappings;
  }

  private mapTaskStateToExpectedWatcher(task: TaskState): {
    expectedKinds: readonly PhaseSignalKind[];
    agentId: string;
  } | undefined {
    if (task.reviewMode === 'server') return this.mapServerTaskToExpectedWatcher(task);
    const specStage = isSpecStagePhase(task.phase);
    if (task.status === 'review' && task.qaAgentId) {
      return {
        expectedKinds: specStage ? ['spec-reviewed'] : PASSIVE_VERDICT_WATCH,
        agentId: task.qaAgentId,
      };
    }
    if (task.status === 'fixing' && task.agentId) {
      return {
        expectedKinds: [specStage ? 'spec-fixed' : 'pr-fixed'],
        agentId: task.agentId,
      };
    }
    if (task.status === 'in_progress' && task.agentId) {
      if (task.phase === 'research') return { expectedKinds: ['spec-done'], agentId: task.agentId };
      if (task.phase === 'code') return { expectedKinds: ['pr-created'], agentId: task.agentId };
      if (task.phase === undefined) {
        return { expectedKinds: ['spec-done', 'pr-created'], agentId: task.agentId };
      }
    }
    return undefined;
  }

  private mapServerTaskToExpectedWatcher(task: TaskState): {
    expectedKinds: readonly PhaseSignalKind[];
    agentId: string;
  } | undefined {
    const isSpec = isSpecStagePhase(task.phase);
    if (task.status === 'review' && task.qaAgentId) {
      return { expectedKinds: [isSpec ? 'spec-reviewed' : 'code-reviewed'], agentId: task.qaAgentId };
    }
    if (task.status === 'fixing' && task.agentId) {
      return { expectedKinds: [isSpec ? 'spec-fixed' : 'code-fixed'], agentId: task.agentId };
    }
    if (task.status === 'in_progress' && task.agentId) {
      if (task.phase === 'research') return { expectedKinds: ['spec-done'], agentId: task.agentId };
      if (task.phase === 'code') {
        return { expectedKinds: ['code-done'], agentId: task.agentId };
      }
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
    opts: { skipSnapshot?: boolean; replaceScope?: 'task' | 'agent'; tokenOverride?: string } = {},
  ): Promise<boolean> {
    const task = await this.taskStore.get(taskId);
    if (!task?.signalToken) return false;
    return this.setupPhaseSignalWatcher(taskId, agentId, expectedKinds, opts.tokenOverride ?? task.signalToken, {
      skipSnapshot: opts.skipSnapshot ?? false,
      ...(opts.replaceScope ? { replaceScope: opts.replaceScope } : {}),
    });
  }

  async retryTask(taskId: string): Promise<TaskState> {
    const old = await this.withTaskLock(async () => {
      const t = await this.taskStore.get(taskId);
      if (!t) throw new ApiError(404, 'Task not found');
      const retryable =
        TERMINAL_STATUSES.includes(t.status)
        || (t.status === 'max_rounds' && isSpecStagePhase(t.phase));
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
          task.agentId = '';
          task.devAgentId = '';
          delete task.phase;
          delete task.qaAgentId;
          delete task.researchAgentId;
        } else {
          const cfg = this.getAgentConfig(patch.preferredAgentId);
          if (!cfg) throw new ApiError(400, `Unknown agent: ${patch.preferredAgentId}`);
          if (cfg.projectId !== task.projectId) {
            throw new ApiError(400, `Agent not in project ${task.projectId}`);
          }
          if (!TASK_OWNER_ROLES.has(cfg.role)) throw new ApiError(400, `Agent is not dev or research role`);
          const group = this.findAgentGroup(cfg.id);
          const dev = group?.find(agent => agent.role === 'dev');
          if (!dev) throw new ApiError(409, `Agent ${cfg.id} has no dev agent in its group`);
          task.preferredAgentId = patch.preferredAgentId;
          task.devAgentId = dev.id;
          if (cfg.role === 'research') {
            task.phase = 'research';
            task.researchAgentId = cfg.id;
          } else {
            delete task.phase;
            delete task.researchAgentId;
          }
          const qaId = group?.find(agent => agent.role === 'qa')?.id;
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
    if (task.reviewMode === 'git') {
      const expectedHeadSha = opts.matchHeadSha ?? task.latestHeadSha;
      if (!expectedHeadSha) throw new Error(`mergePr: no expected head sha for git task ${taskId}`);
      await this.platformConfirmMerge(taskId, {
        expectedHeadSha,
        ...(opts.humanOverride === true || task.status === 'max_rounds' ? { humanOverride: true } : {}),
      });
      return;
    }
    const expectedHeadSha = opts.matchHeadSha ?? task.latestHeadSha;
    if (!expectedHeadSha || !PLATFORM_HEAD_SHA_RE.test(expectedHeadSha)) {
      throw new Error(`mergePr: no valid expected head sha for server task ${taskId}`);
    }
    await this.platformConfirmMerge(taskId, { expectedHeadSha });
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
      if (isSpecStagePhase(task.phase)) {
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
        const afterDone = await this.commitServerAfterDone(taskId);
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
        await this.mergePr(taskId, { humanOverride: true });
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
    // Pin the incarnation before the first state/paneId read: paneId equality is ABA-blind (a recreated
    // agent reuses %0), so a DELETE→same-id recreate would otherwise let post-merge /clear hit a new session.
    const genAtEntry = this.deletionGenerationOf(agentId);
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
      if (this.isDeletionInFlight(agentId)) return;
      const lockToken = await this.lockManager.acquire(agentId, ctx.taskId);
      if (!lockToken) return;
      const commit = await this.agentStore.update(agentId, (existing) => {
        if (!existing) return AGENT_STORE_NOOP;
        if (!this.deletionGateOpen(agentId, genAtEntry)) return AGENT_STORE_NOOP;
        if (existing.taskId && existing.taskId !== ctx.taskId) return AGENT_STORE_NOOP;
        if (existing.creationToken) return AGENT_STORE_NOOP;
        if (existing.status === 'awaiting_human') return AGENT_STORE_NOOP;
        if (existing.paneId !== state.paneId) return AGENT_STORE_NOOP;
        return {
          ...existing,
          taskId: ctx.taskId,
          lockToken,
          updatedAt: new Date().toISOString(),
        };
      }).catch(async (err) => {
        await this.lockManager.releaseIfOwner(agentId, ctx.taskId, lockToken).catch((releaseErr) => {
          console.warn(`[AgentManager] postMergeCleanup(${agentId}): lock release after commit failure also failed:`, releaseErr);
        });
        throw err;
      });
      if (commit !== 'committed') {
        await this.lockManager.releaseIfOwner(agentId, ctx.taskId, lockToken);
        return;
      }
      const fresh = await this.agentStore.get(agentId);
      if (fresh?.taskId !== ctx.taskId || fresh.lockToken !== lockToken) {
        await this.lockManager.releaseIfOwner(agentId, ctx.taskId, lockToken);
        return;
      }
    }

    // A DELETE→recreate (gen bump) before this pane work must skip it, or /clear lands on the new incarnation's reused pane.
    if (!this.deletionGateOpen(agentId, genAtEntry)) return;
    const runner = this.createRunnerFor(agent);
    const tmux = new TmuxManager(runner);
    const runtime = agentRuntimeKindFor(agent);
    const expectedPaneId = state.paneId;
    void (async () => {
      if (!this.deletionGateOpen(agentId, genAtEntry)) return;
      const pane = await this.resolveClaimedPane(tmux, agentId, expectedPaneId);
      await this.runPostMergeCompaction(tmux, pane, agentId, ctx.taskId, runtime);
    })().catch(err =>
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

  private async runPostMergeCompaction(
    tmux: TmuxManager,
    pane: PaneRef,
    agentId: string,
    originalTaskId: string,
    runtime: AgentRuntimeKind,
  ): Promise<void> {
    await this.acquireCompactGuard(agentId);
    try {
      await this.runPostMergeCompactionSteps(tmux, pane, agentId, originalTaskId, runtime);
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
    pane: PaneRef,
    agentId: string,
    originalTaskId: string,
    runtime: AgentRuntimeKind,
  ): Promise<void> {
    const paneId = pane.paneId;
    const initial = await this.agentStore.get(agentId);
    if (!initial || initial.taskId !== originalTaskId || initial.paneId !== paneId) return;
    const lockToken = await this.resolveTaskLockToken(initial, originalTaskId);
    if (!lockToken) return;
    const bindingStillOurs = async (): Promise<boolean> => {
      const s = await this.agentStore.get(agentId);
      return !!s
        && s.taskId === originalTaskId
        && s.lockToken === lockToken
        && s.paneId === paneId
        && await this.lockManager.isOwner(agentId, originalTaskId, lockToken);
    };
    if (!await bindingStillOurs()) return;

    let cleared = false;
    let clearError: unknown;
    try {
      cleared = await this.sendPostMergeSlashCommand(tmux, pane, agentId, runtime, bindingStillOurs);
    } catch (err) {
      clearError = err;
    }
    if (!cleared) {
      if (await this.recoverPostMergeExitedRuntime(
        tmux,
        pane,
        agentId,
        originalTaskId,
        lockToken,
        runtime,
      )) {
        cleared = true;
      } else if (!await bindingStillOurs()) {
        return;
      } else if (
        clearError instanceof Error
        && clearError.message.includes('runtime rejected /clear')
      ) {
        try {
          await this.waitForReplPromptReady(tmux, pane, runtime, this.compactIdleWaitMs);
        } catch (err) {
          clearError = err;
        }
        if (clearError instanceof Error && !clearError.message.includes('runtime rejected /clear')) {
          await this.markAwaitingHuman(
            agentId,
            'post-merge-cleanup-not-idle',
            `Task finished, but the runtime could not be proven idle after /clear: ${clearError.message}`,
            { expectedTaskId: originalTaskId },
          );
          return;
        }
      } else {
        const reason = clearError instanceof Error ? clearError.message : String(clearError ?? 'unknown error');
        await this.markAwaitingHuman(
          agentId,
          'post-merge-cleanup-not-idle',
          `Task finished, but /clear and the runtime idle check did not complete safely: ${reason}`,
          { expectedTaskId: originalTaskId },
        );
        return;
      }
    }
    await this.releasePostMergeAgent(agentId, originalTaskId);
  }

  private async recoverPostMergeExitedRuntime(
    tmux: TmuxManager,
    pane: PaneRef,
    agentId: string,
    taskId: string,
    lockToken: string,
    runtime: AgentRuntimeKind,
  ): Promise<boolean> {
    const paneId = pane.paneId;
    let paneExists = true;
    try {
      if (hasReplProcTitle(await tmux.displayMessage(pane, '#{pane_current_command}'), runtime)) return false;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (!/no server running|session not found|can't find (?:pane|session)|no such (?:pane|session)/i.test(detail)) {
        return false;
      }
      paneExists = false;
    }
    const state = await this.agentStore.get(agentId);
    if (
      !state
      || state.taskId !== taskId
      || state.lockToken !== lockToken
      || state.paneId !== paneId
      || !(await this.lockManager.isOwner(agentId, taskId, lockToken))
    ) return false;
    try {
      if (paneExists) await tmux.sendKeysToPane(pane, 'C-c');
      const ensure = await this.ensureSession(agentId, 'runtime');
      if (!ensure.freshRuntime) return false;
      await this.agentStore.update(agentId, (existing) => {
        if (!existing || existing.taskId !== taskId || existing.lockToken !== lockToken) {
          return AGENT_STORE_NOOP;
        }
        if (existing.paneId === ensure.paneId && existing.workdir === ensure.workdir) {
          return AGENT_STORE_NOOP;
        }
        return {
          ...existing,
          paneId: ensure.paneId,
          workdir: ensure.workdir,
          updatedAt: new Date().toISOString(),
        };
      });
      const current = await this.agentStore.get(agentId);
      return current?.taskId === taskId
        && current.lockToken === lockToken
        && current.paneId === ensure.paneId
        && await this.lockManager.isOwner(agentId, taskId, lockToken);
    } catch (err) {
      console.warn(`[AgentManager] recoverPostMergeExitedRuntime(${agentId}, ${taskId}) failed:`, err);
      return false;
    }
  }

  private async sendPostMergeSlashCommand(
    tmux: TmuxManager,
    pane: PaneRef,
    agentId: string,
    runtime: AgentRuntimeKind,
    bindingStillOurs: () => Promise<boolean>,
  ): Promise<boolean> {
    let rejection: Error | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (!await bindingStillOurs()) return false;
      await tmux.clearComposerDraft(pane);
      await this.waitForReplPromptReady(tmux, pane, runtime, this.compactIdleWaitMs);
      if (!await bindingStillOurs()) return false;
      await tmux.sendKeysLiteral(pane, '/clear');
      await tmux.sendEnter(pane);
      await new Promise(r => setTimeout(r, this.compactIdlePollMs));
      await this.waitForReplPromptReady(tmux, pane, runtime, this.compactIdleWaitMs);
      if (!await bindingStillOurs()) return false;

      if (!await this.hasRuntimeSlashCommandRejection(tmux, pane, '/clear')) return true;

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
    pane: PaneRef,
    command: '/compact' | '/clear',
  ): Promise<boolean> {
    const cap = await tmux.capturePaneById(pane, { ansi: false, scrollback: 0 });
    return this.runtimeSlashCommandRejectedPattern(command).test(cap);
  }

  private runtimeSlashCommandRejectedPattern(command: '/compact' | '/clear'): RegExp {
    return new RegExp(`["'“”‘’]?${command}["'“”‘’]?\\s+is disabled while a task is in progress\\.`, 'gi');
  }

  private async waitForReplPromptReady(
    tmux: TmuxManager,
    pane: PaneRef,
    runtime: AgentRuntimeKind,
    timeoutMs: number,
    opts: { stableIdle?: boolean } = {},
  ): Promise<void> {
    if (opts.stableIdle) {
      return this.waitForReplPromptStableIdle(tmux, pane, runtime, timeoutMs);
    }
    const paneId = pane.paneId;
    const deadline = Date.now() + timeoutMs;
    await tmux.waitReplReady(pane, runtime, {
      timeoutMs,
      intervalMs: this.compactIdlePollMs,
      titleIdleFastPath: true,
    });
    await new Promise(r => setTimeout(r, this.compactIdlePollMs));
    while (true) {
      const current = await tmux.displayMessage(pane, '#{pane_current_command}');
      if (!hasReplProcTitle(current, runtime)) {
        throw new Error(`waitForReplPromptReady: pane ${paneId} pane_current_command=${current.trim()} (not runtime, REPL may have exited)`);
      }
      const cap = await tmux.capturePaneById(pane, { ansi: false, scrollback: 0 });
      const ready = hasRuntimeReadyView(cap, runtime)
        || (screenAllowsTitleIdle(cap, runtime) && hasOscTitleIdle(await tmux.readPaneTitle(pane), runtime));
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
        // 与 stableIdle 分支同一类型：忙碌超时是「常态忙」而非故障，调用方（release/派发）
        // 据此延后重排；菜单/对话框/REPL 退出等仍是普通 Error，不得被当成可延后
        throw new ReplNotReadyError(paneId, runtime, cap, `stayed busy past ${timeoutMs}ms`);
      }
      await new Promise(r => setTimeout(r, this.compactIdlePollMs));
    }
  }

  // 注入前置门：codex 忙碌回合的工具间隙会闪现单帧 idle footer（#558 事故放大器），
  // 连续 K 帧稳定就绪才放行，任何忙碌/不确定帧清零计数；超时按忙碌分类抛 ReplNotReadyError。
  private async waitForReplPromptStableIdle(
    tmux: TmuxManager,
    pane: PaneRef,
    runtime: AgentRuntimeKind,
    timeoutMs: number,
  ): Promise<void> {
    const paneId = pane.paneId;
    const samples = Math.max(1, this.readyStableSamples);
    const spacing = this.readyStableSpacingMs;
    const deadline = Date.now() + timeoutMs + (samples - 1) * spacing;
    let streak = 0;
    while (true) {
      const current = await tmux.displayMessage(pane, '#{pane_current_command}');
      if (!hasReplProcTitle(current, runtime)) {
        throw new Error(`waitForReplPromptReady: pane ${paneId} pane_current_command=${current.trim()} (not runtime, REPL may have exited)`);
      }
      const cap = await tmux.capturePaneById(pane, { ansi: false, scrollback: 0 });
      const ready = hasRuntimeReadyView(cap, runtime)
        || (screenAllowsTitleIdle(cap, runtime) && hasOscTitleIdle(await tmux.readPaneTitle(pane), runtime));
      if (detectRuntimeMenu(cap) || (!ready && detectStartupDialog(cap, runtime))) {
        throw new Error(`waitForReplPromptReady: pane ${paneId} shows menu/dialog, not a ready REPL prompt`);
      }
      streak = ready && !runtimeBusyCheck(cap, runtime) ? streak + 1 : 0;
      if (streak >= samples) return;
      if (Date.now() >= deadline) {
        throw new ReplNotReadyError(
          paneId,
          runtime,
          cap,
          `stable idle not confirmed within ${timeoutMs}ms (+${(samples - 1) * spacing}ms stability window)`,
        );
      }
      await new Promise(r => setTimeout(r, spacing));
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
    opts: {
      skipSnapshot?: boolean;
      onReadFile?: (req: ReadFileSignal) => void;
      onlyReplaceOwnToken?: boolean;
      replaceFromToken?: string;
      replaceScope?: 'task' | 'agent';
      needInputMode?: 'fresh' | 'restore';
      preparedReplay?: {
        armClaimId?: number;
        needInput: { epoch: number; askSeq: number; answeredSeq: number } | null;
      };
    } = {},
  ): Promise<boolean> {
    if (!this.phaseSignalWatcher) return true;
    const task = await this.taskStore.get(taskId);
    if (!task) return false;
    try {
      if (opts.preparedReplay) {
        return await this.phaseSignalWatcher.start({
          taskId,
          projectId: task.projectId,
          agentId,
          expectedKinds,
          token,
          skipSnapshot: opts.skipSnapshot ?? false,
          needInputInherit: false,
          ...(opts.onlyReplaceOwnToken ? { onlyReplaceOwnToken: true } : {}),
          ...(opts.replaceFromToken ? { replaceFromToken: opts.replaceFromToken } : {}),
          ...(opts.replaceScope ? { replaceScope: opts.replaceScope } : {}),
          ...(opts.preparedReplay.armClaimId !== undefined
            ? { armClaimId: opts.preparedReplay.armClaimId }
            : {}),
          ...(opts.preparedReplay.needInput !== null
            ? { needInput: opts.preparedReplay.needInput }
            : {}),
        });
      }
      return await this.startPhaseSignalWatch({
        taskId,
        projectId: task.projectId,
        agentId,
        expectedKinds,
        token,
        skipSnapshot: opts.skipSnapshot ?? false,
        ...(opts.onlyReplaceOwnToken ? { onlyReplaceOwnToken: true } : {}),
        ...(opts.replaceFromToken ? { replaceFromToken: opts.replaceFromToken } : {}),
        ...(opts.replaceScope ? { replaceScope: opts.replaceScope } : {}),
        ...(opts.onReadFile ? { onReadFile: opts.onReadFile } : {}),
        ...(opts.needInputMode ? { needInputMode: opts.needInputMode } : {}),
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
    const armed = await this.setupPhaseSignalWatcher(taskId, agentId, expectedKinds, token, {
      skipSnapshot,
      // Every post-dispatch arm follows a freshly injected prompt: the previous
      // question is superseded, its watermark must not carry over (fix/publish
      // continuations included).
      needInputMode: 'fresh',
      ...(onReadFile ? { onReadFile } : {}),
    });
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

  dispatchTokenFields(task: TaskState, signalToken: string): Partial<TaskState> {
    const wantsPrCreated = task.reviewMode === 'git'
      && this.devInitialSignalKinds(task.reviewMode).includes('pr-created');
    return { signalToken, ...(wantsPrCreated ? { pendingPrSignalToken: signalToken } : {}) };
  }

  async rearmGitReconciliationWatcher(taskId: string, opts: { skipSnapshot?: boolean } = {}): Promise<void> {
    const task = await this.taskStore.get(taskId);
    if (!task || task.reviewMode !== 'git' || task.status !== 'review') return;
    if (task.replyActorStatus === 'verified' || task.pendingPrSignalToken === undefined) return;
    if (!task.devAgentId || task.prNumber === undefined) return;
    await this.setupPhaseSignalWatcher(taskId, task.devAgentId, ['pr-created'], task.pendingPrSignalToken, {
      replaceScope: 'agent',
      ...(opts.skipSnapshot ? { skipSnapshot: true } : {}),
    }).catch(() => false);
  }

  async rotateAndSetupPhaseSignal(
    taskId: string,
    agentId: string,
    expectedKinds: PhaseSignalKind | readonly PhaseSignalKind[],
    guard?: { expectedStatus: TaskStatus; expectedToken?: string },
  ): Promise<{ token: string; armed: boolean }> {
    const newToken = createSignalToken();
    const result = await this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task) return { token: newToken, armed: false, isGit: false };
      const isGit = task.reviewMode === 'git';
      if (isGit && guard === undefined) {
        throw new Error('git phase-signal rotation requires a status/token guard');
      }
      if (guard && (task.status !== guard.expectedStatus
        || (guard.expectedToken !== undefined && task.signalToken !== guard.expectedToken))) {
        return { token: newToken, armed: false, isGit };
      }
      await this.taskStore.set({ ...task, signalToken: newToken, updatedAt: new Date().toISOString() });
      const armed = await this.setupPhaseSignalWatcher(taskId, agentId, expectedKinds, newToken, {
        needInputMode: 'fresh',
        ...(isGit ? { replaceScope: 'agent' as const } : {}),
      });
      return { token: newToken, armed, isGit };
    });
    return { token: result.token, armed: result.armed };
  }

  async parkTaskAtSpecReady(taskId: string, opts: { specReviewRound?: number } = {}): Promise<TaskState | null> {
    const task = await this.taskStore.get(taskId);
    if (!task) return null;
    const transition = await this.transitionTaskStatus(
      taskId,
      'spec-ready',
      { fromStatus: ['review', 'in_progress', 'fixing'] },
      {
        phase: 'spec',
        ...(opts.specReviewRound !== undefined ? { specReviewRound: opts.specReviewRound } : {}),
      },
    );
    if (!transition) return null;
    this.stopPhaseSignalWatcher(taskId);
    if (task.agentId) {
      const devOk = await this.markAgentWaiting(task.agentId, taskId).catch(() => false);
      if (!devOk) {
        await this.emitIntervention(task.projectId, task.agentId, taskId, { phase: 'spec-ready-dev-park-failed', devAgentId: task.agentId });
      }
    }
    if (task.qaAgentId) {
      const released = await this.releaseAgentForTask(task.qaAgentId, taskId, 'idle')
        .catch(() => false);
      if (!released) {
        await this.emitIntervention(task.projectId, task.qaAgentId, taskId, { phase: 'spec-ready-qa-release-failed', qaAgentId: task.qaAgentId });
      }
    }
    return transition.task;
  }

  async submitSpecVerdict(
    taskId: string,
    verdict: 'approve' | 'request-changes' | 'archive',
    comments?: string,
  ): Promise<TaskState> {
    const trimmed = comments?.trim();
    if (verdict === 'request-changes' && !trimmed) {
      throw new ApiError(400, 'comments is required for request-changes');
    }
    const task = await this.withTaskLock(async () => {
      const fresh = await this.taskStore.get(taskId);
      if (!fresh) throw new ApiError(404, `Task ${taskId} not found`);
      const specMaxRounds = fresh.status === 'max_rounds' && isSpecStagePhase(fresh.phase);
      if (fresh.status !== 'spec-ready' && !specMaxRounds) {
        throw new ApiError(
          409,
          `Task ${taskId} is ${fresh.status}; spec verdict requires spec-ready or spec-phase max_rounds`,
        );
      }
      if (verdict === 'archive' && !fresh.researchAgentId) {
        throw new ApiError(409, `Task ${taskId} is not a Research task; only Research specs can be archived`);
      }
      if (this.specVerdictInFlight.has(taskId)) {
        throw new ApiError(409, `Task ${taskId} spec verdict is already being processed`);
      }
      this.specVerdictInFlight.add(taskId);
      return fresh;
    });
    try {
      return await this.executeSpecVerdict(task, verdict, trimmed);
    } finally {
      this.specVerdictInFlight.delete(taskId);
    }
  }

  private async executeSpecVerdict(
    task: TaskState,
    verdict: 'approve' | 'request-changes' | 'archive',
    trimmed: string | undefined,
  ): Promise<TaskState> {
    const taskId = task.id;
    const store = this.getReviewStore();
    if (!store) throw new ApiError(500, 'Review store unavailable');
    const round = task.specReviewRound ?? 1;
    const at = new Date().toISOString();
    const roundData = await store.getRound(taskId, 'spec', round);
    if (!roundData || roundData.phase !== 'spec') {
      throw new ApiError(409, `Task ${taskId} has no persisted spec review round ${round}`);
    }
    const base: ReviewRound = roundData;

    if (verdict === 'archive') {
      await store.putRound(taskId, 'spec', {
        ...base,
        userDecision: { verdict, ...(trimmed ? { comments: trimmed } : {}), at },
      });
      const transition = await this.transitionTaskStatus(
        taskId,
        'done',
        { fromStatus: ['spec-ready', 'max_rounds'] },
      );
      if (!transition) throw new ApiError(409, `Task ${taskId} changed while archiving`);
      this.stopPhaseSignalWatcher(taskId);
      const participants = new Set([
        task.agentId,
        task.devAgentId,
        task.qaAgentId,
        task.researchAgentId,
      ].filter((id): id is string => typeof id === 'string' && id !== ''));
      for (const agentId of participants) {
        const state = await this.agentStore.get(agentId);
        if (state?.taskId !== taskId) continue;
        const released = await this.releaseAgentForTask(
          agentId,
          taskId,
          'idle',
          { allowAwaitingHuman: true },
        ).catch(() => false);
        if (!released) {
          await this.emitIntervention(task.projectId, agentId, taskId, {
            phase: 'spec-archive-agent-release-failed',
            agentId,
          });
        }
      }
      return (await this.taskStore.get(taskId))!;
    }

    if (verdict === 'approve') {
      await store.putRound(taskId, 'spec', { ...base, userDecision: { verdict, at } });
      let result: TaskState | null;
      try {
        result = await this.transitionToCodePhase(taskId);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        const after = await this.taskStore.get(taskId);
        if (after?.status === 'failed') {
          const reason = err instanceof DispatchTerminalError ? ` (${err.reason})` : '';
          throw new ApiError(
            500,
            `Code-phase dispatch failed terminally for task ${taskId}${reason}: ${message}. `
            + 'The task has been marked failed; use Retry to run it as a fresh task.',
          );
        }
        if (after?.phase === 'code' && after.status === 'in_progress') {
          throw new ApiError(
            500,
            `Code-phase dispatch failed for task ${taskId}: ${message}. `
            + 'The task already moved to the code phase and the dev is held; '
            + 'Resume the dev agent to redeliver the prompt.',
          );
        }
        throw new ApiError(
          500,
          `Code-phase dispatch failed for task ${taskId}: ${message}. `
          + 'The task was rolled back to await the verdict; fix the dev Workdir '
          + '(Resume the dev first if it is still held), then retry the verdict.',
        );
      }
      if (!result) {
        const after = await this.taskStore.get(taskId);
        if (after?.phase === 'code' && after.status === 'in_progress') {
          throw new ApiError(
            500,
            `Code-phase prompt was not delivered for task ${taskId}; the task already moved to the `
            + 'code phase and the dev is held. Resume the dev agent to redeliver the prompt '
            + '(retrying the verdict will be rejected).',
          );
        }
        throw new ApiError(409, `Dev is unavailable for task ${taskId}; approval was recorded and can be retried`);
      }
      return result;
    }

    if (!trimmed) throw new ApiError(400, 'comments is required for request-changes');
    const priorFindings = base.findings?.findings ?? [];
    const nextUserId = `u-${priorFindings.filter(f => f.id.startsWith('u-')).length + 1}`;
    const mergedFindings: ReviewFindings = {
      round,
      verdict: 'request-changes',
      findings: [...priorFindings, { id: nextUserId, severity: 'major', message: trimmed }],
    };
    const rejectedRound: ReviewRound = {
      ...base,
      findings: mergedFindings,
      userDecision: { verdict, comments: trimmed, at },
    };
    // 到达上限后用户仍显式打回 = 对「再评一轮」的当场决策：扩 cap 而非拒绝。
    // holder 恢复与扩 cap 正交：max_rounds 入态时 holder 已被释放清空，即便 cap
    // 因配置热更新出现余量，打回前也必须先恢复 holder
    const cap = this.getConfig().review.rounds + (task.maxRoundsContinues ?? 0);
    const claim = task.status === 'max_rounds' || round >= cap
      ? await this.claimSpecFixDispatch(taskId, { extendCapToFit: round >= cap ? round : null })
      : null;
    let dispatched: TaskState | null = null;
    try {
      await store.putRound(taskId, 'spec', rejectedRound);
      dispatched = await this.dispatchServerFixToDev(taskId, JSON.stringify(mergedFindings));
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      const after = await this.taskStore.get(taskId);
      if (after?.status === 'failed') {
        const reason = err instanceof DispatchTerminalError ? ` (${err.reason})` : '';
        throw new ApiError(
          500,
          `Spec fix dispatch failed terminally for task ${taskId}${reason}: ${message}. `
          + 'The task has been marked failed with the rejection kept on record; '
          + 'use Retry to run it as a fresh task.',
        );
      }
      if (after?.status === 'fixing') {
        throw new ApiError(
          500,
          `Spec fix dispatch was interrupted for task ${taskId}: ${message}. `
          + 'The task moved to fixing with the rejection recorded; resume the holder agent to redeliver it.',
        );
      }
      throw new ApiError(
        500,
        `Spec fix dispatch failed for task ${taskId}: ${message}. `
        + 'The rejection was rolled back; fix the agent runtime or configuration, then retry.',
      );
    } finally {
      if (!dispatched) await this.recoverSpecRejectionState(taskId, claim, base);
    }
    if (!dispatched) throw new ApiError(500, `Failed to dispatch spec fix for task ${taskId}`);
    return dispatched;
  }

  private async claimSpecFixDispatch(
    taskId: string,
    opts: { extendCapToFit: number | null },
  ): Promise<{ originalAgentId: string; originalCounter: number; holderWritten: string; counterAfter: number }> {
    return await this.withTaskLock(async () => {
      const fresh = await this.taskStore.get(taskId);
      if (!fresh) throw new ApiError(404, `Task ${taskId} not found`);
      if (fresh.status !== 'spec-ready' && fresh.status !== 'max_rounds') {
        throw new ApiError(409, `Task ${taskId} changed status during the spec verdict; aborted`);
      }
      const holder = fresh.agentId || fresh.researchAgentId || fresh.devAgentId;
      if (!holder || !this.getAgentConfig(holder)) {
        throw new ApiError(
          409,
          `Task ${taskId} spec holder agent ${holder || '(none)'} is not in the current config; `
          + 'restore the agent config or cancel the task',
        );
      }
      const originalAgentId = fresh.agentId;
      const originalCounter = fresh.maxRoundsContinues ?? 0;
      let counterAfter = originalCounter;
      if (opts.extendCapToFit !== null) {
        // cap 必须容下下一轮（round+1）；rounds 被调低时一次 +1 可能不够
        counterAfter = Math.max(originalCounter + 1, opts.extendCapToFit + 1 - this.getConfig().review.rounds);
        fresh.maxRoundsContinues = counterAfter;
      }
      fresh.agentId = holder;
      fresh.updatedAt = new Date().toISOString();
      await this.taskStore.set(fresh);
      return { originalAgentId, originalCounter, holderWritten: holder, counterAfter };
    });
  }

  // 补偿以 claim 时的 status+counter+holder 为代际证明：任务已被推进（fixing/cancelled/新扩轮）
  // 就放弃恢复——尤其派发把任务带进 held fixing 时，打回 round 必须保留给后续 Resume 重派
  private async recoverSpecRejectionState(
    taskId: string,
    claim: { originalAgentId: string; originalCounter: number; holderWritten: string; counterAfter: number } | null,
    baseRound: ReviewRound,
  ): Promise<void> {
    const store = this.getReviewStore();
    await this.withTaskLock(async () => {
      const fresh = await this.taskStore.get(taskId);
      if (!fresh) return;
      if (fresh.status !== 'spec-ready' && fresh.status !== 'max_rounds') {
        console.warn(
          `[AgentManager] spec rejection recovery(${taskId}) skipped: task moved to ${fresh.status}`,
        );
        return;
      }
      if (claim) {
        if (
          (fresh.maxRoundsContinues ?? 0) !== claim.counterAfter
          || fresh.agentId !== claim.holderWritten
        ) {
          console.warn(
            `[AgentManager] spec rejection recovery(${taskId}) skipped: `
            + `continues=${fresh.maxRoundsContinues ?? 0} agentId=${fresh.agentId} `
            + `(expected ${claim.counterAfter}/${claim.holderWritten})`,
          );
          return;
        }
        fresh.maxRoundsContinues = claim.originalCounter;
        fresh.agentId = claim.originalAgentId;
        fresh.updatedAt = new Date().toISOString();
        await this.taskStore.set(fresh);
      }
      await store?.putRound(taskId, 'spec', baseRound);
    }).catch(err => {
      console.error(`[AgentManager] spec rejection recovery(${taskId}) failed:`, err);
    });
  }

  async submitCodeVerdict(taskId: string, comments: string): Promise<TaskState> {
    const trimmed = comments?.trim();
    if (!trimmed) {
      throw new ApiError(400, 'comments is required for request-changes');
    }
    const task = await this.withTaskLock(async () => {
      const fresh = await this.taskStore.get(taskId);
      if (!fresh) throw new ApiError(404, `Task ${taskId} not found`);
      if (fresh.status !== 'ready') {
        throw new ApiError(409, `Task ${taskId} is ${fresh.status}; code verdict requires ready`);
      }
      if (isSpecStagePhase(fresh.phase)) {
        throw new ApiError(409, `Task ${taskId} is in the spec phase; reject the spec via the spec verdict instead`);
      }
      if (fresh.reviewMode !== 'server') {
        throw new ApiError(409, `Task ${taskId} is not in server review mode; request changes on the PR instead`);
      }
      if (!fresh.agentId) {
        throw new ApiError(400, `Task ${taskId} has no dev agent; cannot request changes`);
      }
      if (this.markCompleteInFlight.has(taskId)) {
        throw new ApiError(409, `Task ${taskId} is being completed (merge in progress); try again shortly`);
      }
      if (this.codeVerdictInFlight.has(taskId)) {
        throw new ApiError(409, `Task ${taskId} code verdict is already being processed`);
      }
      this.codeVerdictInFlight.add(taskId);
      return fresh;
    });
    try {
      return await this.executeCodeVerdict(task, trimmed);
    } finally {
      this.codeVerdictInFlight.delete(taskId);
    }
  }

  private async executeCodeVerdict(task: TaskState, trimmed: string): Promise<TaskState> {
    const taskId = task.id;
    const store = this.getReviewStore();
    if (!store) throw new ApiError(500, 'Review store unavailable');
    const round = Math.max(task.reviewRound, 1);
    const at = new Date().toISOString();

    // 打回消耗一轮修订；到达上限时拒绝而非派发注定进 max_rounds 的修订，让用户当场决策
    const cap = this.getConfig().review.rounds + (task.maxRoundsContinues ?? 0);
    if (round >= cap) {
      throw new ApiError(
        409,
        `Task ${taskId} has reached the code review round cap (${cap}); `
        + 'confirm completion, or cancel the task',
      );
    }

    const roundData = await store.getRound(taskId, 'code', round);
    // 无 QA 项目经 autoApproveCode 到达 ready 时从未存轮；补底轮次保证 userDecision 留痕与 fix 闭环
    const base = roundData ?? await this.synthesizeEmptyCodeRound(task, round, at);

    // runCodeFixSubmission 按 Math.max(reviewRound,1) 读轮、recheck 按 reviewRound+1 存新轮；
    // reviewRound 停在 0 会让 recheck 覆写本轮，故落库为 1 对齐两侧
    if (task.reviewRound === 0) {
      await this.withTaskLock(async () => {
        const fresh = await this.taskStore.get(taskId);
        if (!fresh) return;
        fresh.reviewRound = 1;
        fresh.updatedAt = new Date().toISOString();
        await this.taskStore.set(fresh);
      });
    }

    const priorFindings = base.findings?.findings ?? [];
    const nextUserId = `u-${priorFindings.filter(f => f.id.startsWith('u-')).length + 1}`;
    const mergedFindings: ReviewFindings = {
      round,
      verdict: 'request-changes',
      findings: [...priorFindings, { id: nextUserId, severity: 'major', message: trimmed }],
    };
    await store.putRound(taskId, 'code', {
      ...base,
      findings: mergedFindings,
      userDecision: { verdict: 'request-changes', comments: trimmed, at },
    });
    const dispatched = await this.dispatchServerFixToDev(taskId, JSON.stringify(mergedFindings));
    if (!dispatched) throw new ApiError(500, `Failed to dispatch code fix for task ${taskId}`);
    return dispatched;
  }

  private async synthesizeEmptyCodeRound(task: TaskState, round: number, at: string): Promise<ReviewRound> {
    const empty: ReviewRound = { round, phase: 'code', content: '', startedAt: at };
    const dev = task.agentId ? this.getAgentConfig(task.agentId) : undefined;
    if (!dev || !task.agentId) return empty;
    // 读取失败不阻断打回：留痕与 fix 闭环优先于 diff 展示
    try {
      await this.refreshWorkdirCacheFor(task.agentId);
      const content = await this.getReviewTransport().readContent(task, dev, 'code');
      return {
        round,
        phase: 'code',
        content: content.content,
        ...(content.diffstat ? { diffstat: content.diffstat } : {}),
        ...(content.baseSha ? { baseSha: content.baseSha } : {}),
        startedAt: at,
      };
    } catch (err) {
      console.warn(`[AgentManager] submitCodeVerdict: code content read failed for ${task.id}; using empty round:`, err);
      return empty;
    }
  }

  private isResearchHandoff(
    task: Pick<TaskState, 'researchAgentId'>,
    devAgentId: string,
  ): boolean {
    return task.researchAgentId !== undefined && task.researchAgentId !== devAgentId;
  }

  private dispatchCodePhasePrompt(
    task: Pick<TaskState, 'id' | 'reviewMode' | 'researchAgentId'>,
    devAgentId: string,
    signalToken: string,
    specDocuments: readonly SpecDocument[],
    currentSpecRound?: number,
  ): Promise<boolean> {
    const expectedKind: PhaseSignalKind = task.reviewMode === 'server' ? 'code-done' : 'pr-created';
    const dispatchOpts: SessionDispatchOpts = {
      signalToken,
      specDocuments,
      ...(currentSpecRound !== undefined ? { currentSpecRound } : {}),
      armBeforeInject: () => this.setupPhaseSignalWatcher(
        task.id,
        devAgentId,
        expectedKind,
        signalToken,
        { needInputMode: 'fresh' },
      ),
    };
    return this.isResearchHandoff(task, devAgentId)
      ? this.startSession(task.id, devAgentId, 'code', {
          ...dispatchOpts,
          preserveBindingOnFailure: true,
        })
      : this.continueSession(task.id, devAgentId, 'code', dispatchOpts);
  }

  async transitionToCodePhase(taskId: string): Promise<TaskState | null> {
    const task = await this.taskStore.get(taskId);
    if (!task) return null;
    const devAgentId = task.devAgentId;
    const dev = devAgentId ? this.getAgentConfig(devAgentId) : undefined;
    if (!devAgentId || dev?.role !== 'dev') {
      await this.emitIntervention(task.projectId, task.agentId, taskId, {
        phase: 'code-dev-missing',
        devAgentId,
      });
      return null;
    }
    const round = task.specReviewRound ?? 1;
    const stored = await this.reviewStore?.getRound(taskId, 'spec', round);
    if (!stored || stored.phase !== 'spec') {
      await this.emitIntervention(task.projectId, task.agentId, taskId, {
        phase: 'code-spec-round-missing',
        round,
      });
      return null;
    }
    const researchAgentId = task.researchAgentId;
    const researchHandoff = this.isResearchHandoff(task, devAgentId);

    const releaseParticipant = async (agentId: string, failurePhase: string): Promise<boolean> => {
      const released = await this.releaseAgentIfBound(agentId, taskId, { allowAwaitingHuman: true })
        .catch(() => false);
      if (!released) {
        await this.emitIntervention(task.projectId, agentId, taskId, { phase: failurePhase, agentId });
      }
      return released;
    };

    if (researchHandoff && researchAgentId) {
      if (!await releaseParticipant(researchAgentId, 'code-phase-research-release-failed')) return null;
    }
    if (task.qaAgentId && !await releaseParticipant(task.qaAgentId, 'code-phase-qa-release-failed')) {
      return null;
    }

    const devBoundBefore = (await this.agentStore.get(devAgentId))?.taskId === taskId;
    const acquired = await this.acquireAgentForTask(devAgentId, taskId, 'code');
    if (!acquired) {
      await this.emitIntervention(task.projectId, devAgentId, taskId, {
        phase: 'code-dev-acquire-failed',
        devAgentId,
      });
      return null;
    }
    const acquiredLockToken = (await this.agentStore.get(devAgentId))?.lockToken;

    const newToken = createSignalToken();
    // spec 阶段的扩轮决策不延续到 code 评审：cap 共享字段，进入编码时归零
    const transition = await this.transitionTaskStatus(
      taskId,
      'in_progress',
      { fromStatus: ['review', 'fixing', 'in_progress', 'spec-ready', 'max_rounds'] },
      { agentId: devAgentId, phase: 'code', maxRoundsContinues: 0, ...this.dispatchTokenFields({ ...task, phase: 'code' }, newToken) },
    );
    if (!transition) {
      await this.releaseAgentForTask(devAgentId, taskId, 'idle', { allowAwaitingHuman: true })
        .catch(() => undefined);
      return null;
    }
    this.stopPhaseSignalWatcher(taskId);
    let started = false;
    try {
      started = await this.dispatchCodePhasePrompt(
        task,
        devAgentId,
        newToken,
        stored.documents,
      );
    } catch (err) {
      if (err instanceof DispatchTerminalError) {
        await this.failTaskForDispatchError(taskId, 'code', devAgentId, err);
      } else if (
        err instanceof EnsureSessionError && err.partial.handled
        && (task.status === 'spec-ready' || task.status === 'max_rounds')
      ) {
        // dev 已被 checkout/dialog hold 且 prompt 未送达；resumeAgent 不重派这些 hold，
        // 任务停在 in_progress 会同时封死 Resume 与 verdict——退回 verdict 门禁状态
        const rolledBack = await this.transitionTaskStatus(
          taskId,
          task.status,
          { fromStatus: ['in_progress'] },
          {
            ...(task.phase !== undefined ? { phase: task.phase } : {}),
            agentId: task.agentId,
            ...(task.signalToken ? { signalToken: task.signalToken } : {}),
            maxRoundsContinues: task.maxRoundsContinues ?? 0,
          },
        );
        if (!rolledBack) {
          console.warn(
            `[AgentManager] transitionToCodePhase(${taskId}): handled dispatch failure but the task `
            + 'moved on; leaving its status as-is',
          );
        } else if (!devBoundBefore) {
          // 转码前 dev 未持有本任务（如 research handoff / max_rounds 重占用）：任务已退回
          // verdict 门禁，释放本次新占用，否则 dev 会被回退后的任务永久占住
          const released = await this.releaseAgentForTask(devAgentId, taskId, 'idle', { allowAwaitingHuman: true })
            .catch(() => false);
          if (!released) {
            await this.emitIntervention(task.projectId, devAgentId, taskId, {
              phase: 'code-rollback-dev-release-failed',
              devAgentId,
            });
          }
        }
      } else if (!(err instanceof EnsureSessionError && err.partial.handled)) {
        await this.markAwaitingHuman(
          devAgentId,
          'code-dispatch-failed',
          'Code-phase prompt was not delivered after spec approval; the task looks in_progress but the dev never received it. Resume/restart the agent or cancel the task.',
          { expectedTaskId: taskId },
        ).catch(() => undefined);
      }
      console.error(
        `[AgentManager] transitionToCodePhase dispatch(dev=${devAgentId}) failed:`,
        err,
      );
      throw err;
    }
    if (!started) {
      await this.markAwaitingHuman(
        devAgentId,
        'code-dispatch-failed',
        'Code-phase prompt was not delivered after spec approval; the task looks in_progress but the dev never received it. Resume/restart the agent or cancel the task.',
        { expectedTaskId: taskId },
      ).catch(() => undefined);
      await this.emitIntervention(task.projectId, devAgentId, taskId, {
        phase: researchHandoff ? 'code-start-failed' : 'code-resume-failed',
        devAgentId,
      });
      return null;
    }
    // 重占用（released dev）的 acquire 会写 bootstrappingTaskId，而 continueSession 不做
    // startSession 的 post-ack finalize；残留标记会让 recover 把已运行的任务按未送达回滚
    if (!researchHandoff) {
      await this.finalizeReplayedBootstrap(devAgentId, taskId, 'code', acquiredLockToken);
    }
    return await this.taskStore.get(taskId);
  }


  async dispatchServerReviewToQa(
    taskId: string,
    opts: {
      phase: ReviewPhase;
      recheck?: boolean;
      continuation?: boolean;
      bumpRound?: boolean;
      content: string;
      interdiff?: string;
      diffstat?: string;
      baseSha?: string;
      headTree?: string;
      batch?: { index: number; total: number };
      priorFindingsJson?: string;
      priorResponseJson?: string;
      reviewHeadAnchorSha?: string;
      callerOwnsConsumedSignalFailure?: boolean;
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
      const qaId = task.qaAgentId;
      if (!qaId) {
        if (!opts.callerOwnsConsumedSignalFailure) {
          const entryKind: PhaseSignalKind = task.status === 'fixing'
            ? (opts.phase === 'spec' ? 'spec-fixed' : 'code-fixed')
            : (opts.phase === 'spec' ? 'spec-done' : 'code-done');
          await this.setupPhaseSignal(taskId, task.agentId, entryKind, { skipSnapshot: true });
          await this.emitIntervention(task.projectId, task.agentId, taskId, {
            phase: 'server-review-no-qa-partner',
            devAgentId: task.agentId,
          });
        }
        return null;
      }
      if (this.getAgentConfig(qaId)?.role !== 'qa') {
        if (!opts.callerOwnsConsumedSignalFailure) {
          const entryKind: PhaseSignalKind = task.status === 'fixing'
            ? (opts.phase === 'spec' ? 'spec-fixed' : 'code-fixed')
            : (opts.phase === 'spec' ? 'spec-done' : 'code-done');
          await this.setupPhaseSignal(taskId, task.agentId, entryKind, { skipSnapshot: true });
          await this.emitIntervention(task.projectId, task.agentId, taskId, {
            phase: 'server-review-qa-unavailable',
            qaAgentId: qaId,
          });
        }
        return null;
      }
      const roundField = opts.phase === 'spec' ? (task.specReviewRound ?? 0) : task.reviewRound;
      const newRound = opts.continuation
        ? Math.max(roundField, 1)
        : opts.bumpRound === false
          ? roundField
          : roundField + 1;
      if (newRound < 1) {
        throw new Error(`dispatchServerReviewToQa: task ${taskId} has no current ${opts.phase} review round to redispatch`);
      }
      return {
        qaId,
        devAgentId: task.agentId,
        projectId: task.projectId,
        newToken: createSignalToken(),
        newRound,
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

    const rollback = async (
      installedPass: Pick<TaskState, 'status' | 'phase' | 'signalToken'>,
    ): Promise<boolean> => {
      try {
        return (await this.transitionTaskStatus(
          taskId,
          claim.originalStatus,
          {
            fromStatus: [installedPass.status],
            expectPhase: installedPass.phase,
            expectSignalToken: installedPass.signalToken,
          },
          {
            signalToken: claim.originalToken,
            batchIndex: claim.originalBatchIndex,
            batchTotal: claim.originalBatchTotal,
            phase: claim.originalPhase,
            ...(opts.phase === 'spec'
              ? { specReviewRound: claim.originalRound }
              : { reviewRound: claim.originalRound }),
          },
        )) !== null;
      } catch (err) {
        console.error(`[AgentManager] dispatchServerReviewToQa rollback failed for ${taskId}:`, err);
        return false;
      }
    };

    const rearmEntrySignal = async () => {
      if (opts.callerOwnsConsumedSignalFailure) return;
      // 从 review 重派（手工发起）：入口信号早已被消费，dev 停驻等待中，无可重挂
      if (claim.originalStatus === 'review') return;
      const entryKind: PhaseSignalKind = claim.originalStatus === 'fixing'
        ? (opts.phase === 'spec' ? 'spec-fixed' : 'code-fixed')
        : (opts.phase === 'spec' ? 'spec-done' : 'code-done');
      await this.setupPhaseSignal(taskId, devAgentId, entryKind, { skipSnapshot: true });
    };

    let acquiredLockToken: string | undefined;
    const ownAcquire = (): { expectedLockToken?: string } => acquiredLockToken === undefined
      ? {}
      : { expectedLockToken: acquiredLockToken };
    const releaseOwnAcquire = async (context: string): Promise<boolean> => {
      try {
        const released = await this.releaseAgentForTask(qaId, taskId, 'idle', ownAcquire());
        if (!released) {
          console.warn(
            `[AgentManager] dispatchServerReviewToQa: QA release refused for ${qaId}/${taskId} (${context})`,
          );
        }
        return released;
      } catch (err) {
        console.error(
          `[AgentManager] dispatchServerReviewToQa: QA release failed for ${qaId}/${taskId} (${context}):`,
          err,
        );
        return false;
      }
    };

    if (!opts.continuation) {
      const prevQa = await this.agentStore.get(qaId);
      if (prevQa?.taskId === taskId) {
        // 手工重派：上一 pass 的 QA 仍绑定本任务，先释放再重新 acquire（与 github 手工路径一致）
        const released = await this.releaseAgentForTask(qaId, taskId, 'idle', {
          ...(prevQa.lockToken !== undefined ? { expectedLockToken: prevQa.lockToken } : {}),
        });
        if (!released) {
          await rearmEntrySignal();
          return null;
        }
      }
      const acquired = await this.acquireAgentForTask(qaId, taskId, dispatchPhase, {
        onAcquired: (lockToken) => { acquiredLockToken = lockToken; },
      });
      if (!acquired) {
        await rearmEntrySignal();
        if (!opts.callerOwnsConsumedSignalFailure) {
          await this.emitIntervention(projectId, qaId, taskId, {
            phase: 'server-review-qa-acquire-failed',
            qaAgentId: qaId,
          });
        }
        return null;
      }
      if (devAgentId) {
        const devOk = await this.markAgentWaiting(devAgentId, taskId);
        if (!devOk) {
          await releaseOwnAcquire('dev park failed');
          await rearmEntrySignal();
          if (!opts.callerOwnsConsumedSignalFailure) {
            await this.emitIntervention(projectId, devAgentId, taskId, {
              phase: 'server-review-dev-park-failed',
              devAgentId,
            });
          }
          return null;
        }
      }
    } else {
      const qaState = await this.agentStore.get(qaId);
      if (qaState?.taskId !== taskId) {
        if (!opts.callerOwnsConsumedSignalFailure) {
          await this.setupPhaseSignal(taskId, qaId, expectedKind, { skipSnapshot: true });
          await this.emitIntervention(projectId, qaId, taskId, {
            phase: 'server-review-continuation-qa-not-bound',
            qaAgentId: qaId,
          });
        }
        return null;
      }
    }

    const roundPatch = opts.phase === 'spec'
      ? { specReviewRound: newRound, phase: 'spec' as TaskPhase }
      : { reviewRound: newRound };
    const transition = await this.transitionTaskStatus(
      taskId,
      'review',
      {
        fromStatus: [claim.originalStatus],
        expectPhase: claim.originalPhase,
        expectSignalToken: claim.originalToken,
      },
      {
        signalToken: newToken,
        reviewDispatchedAt: new Date().toISOString(),
        ...(opts.reviewHeadAnchorSha ? { reviewHeadAnchorSha: opts.reviewHeadAnchorSha } : {}),
        ...(opts.batch
          ? { batchIndex: opts.batch.index, batchTotal: opts.batch.total }
          : { batchIndex: undefined, batchTotal: undefined }),
        // Fresh dispatch: clear any stale mode until startSession materializes the review checkout,
        // so a crash in this window recovers conservatively (no read-file) rather than
        // re-arming it for what might be a head-mode review.
        ...(opts.continuation ? {} : { reviewCheckoutMode: undefined }),
        ...roundPatch,
      },
    );
    if (!transition) {
      if (!opts.continuation) {
        await releaseOwnAcquire('pass transition rejected');
      }
      if (!opts.callerOwnsConsumedSignalFailure) {
        await this.emitIntervention(projectId, qaId, taskId, {
          phase: 'server-review-transition-failed',
          qaAgentId: qaId,
        });
      }
      return null;
    }
    const installedPass = {
      status: transition.task.status,
      phase: transition.task.phase,
      signalToken: transition.task.signalToken,
    };

    let dispatchedCheckoutMode: 'head' | 'base' | undefined;
    const sessionOpts = {
      bypassTaskStatusGate: true,
      signalToken: newToken,
      serverContent: opts.content,
      ...(opts.interdiff !== undefined ? { serverInterdiff: opts.interdiff } : {}),
      ...(opts.diffstat !== undefined ? { serverDiffstat: opts.diffstat } : {}),
      ...(opts.baseSha !== undefined ? { serverBaseSha: opts.baseSha } : {}),
      ...(opts.reviewHeadAnchorSha !== undefined ? { serverHeadSha: opts.reviewHeadAnchorSha } : {}),
      ...(opts.headTree !== undefined ? { serverHeadTree: opts.headTree } : {}),
      ...(opts.batch ? { serverBatch: opts.batch } : {}),
      ...(opts.priorFindingsJson ? { serverPriorFindings: opts.priorFindingsJson } : {}),
      ...(opts.priorResponseJson ? { serverPriorResponse: opts.priorResponseJson } : {}),
      ...(opts.phase === 'spec' ? { currentSpecRound: newRound } : {}),
      armBeforeInject: (ctx: DispatchArmContext) => {
        dispatchedCheckoutMode = ctx.serverReviewCheckout;
        const allowReadFile = opts.phase === 'spec' || opts.continuation || ctx.serverReviewCheckout === 'base';
        return this.setupPhaseSignalWatcher(taskId, qaId, expectedKind, newToken, {
          needInputMode: 'fresh',
          ...(allowReadFile
            ? { onReadFile: (req: ReadFileSignal) => { void this.handleReadFileRequest(taskId, qaId, req); } }
            : {}),
        });
      },
    };
    const rearmConsumedSignal = async () => {
      if (opts.callerOwnsConsumedSignalFailure) return;
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
        await this.failTaskForDispatchError(taskId, dispatchPhase, qaId, err, ownAcquire());
      } else if (err instanceof EnsureSessionError && err.partial.handled) {
      } else {
        const rolledBack = await rollback(installedPass);
        if (!opts.continuation) {
          await releaseOwnAcquire('session dispatch threw');
        }
        if (rolledBack) await rearmConsumedSignal();
      }
      throw err;
    }
    if (!started) {
      this.stopPhaseSignalWatcher(taskId);
      const rolledBack = await rollback(installedPass);
      if (!opts.continuation) {
        await releaseOwnAcquire('session did not start');
      }
      if (rolledBack) await rearmConsumedSignal();
      if (!opts.callerOwnsConsumedSignalFailure) {
        await this.emitIntervention(projectId, qaId, taskId, {
          phase: 'server-review-start-failed',
          qaAgentId: qaId,
        });
      }
      return null;
    }

    // Persist the checkout mode so base-mode recovery can re-arm read-file.
    if (opts.phase !== 'spec' && !opts.continuation) {
      try {
        await this.updateTask(taskId, { reviewCheckoutMode: dispatchedCheckoutMode });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[AgentManager] failed to persist review checkout mode for ${taskId}: ${message}`);
        await this.emitIntervention(projectId, qaId, taskId, {
          phase: 'review-checkout-mode-persist-failed',
          error: message,
          note: 'The review prompt is running, but restart recovery cannot safely infer its checkout mode.',
        });
      }
    }
    return await this.taskStore.get(taskId);
  }

  async dispatchServerFixToDev(
    taskId: string,
    _findingsJson: string,
    opts: { callerOwnsConsumedSignalFailure?: boolean } = {},
  ): Promise<TaskState | null> {
    const claim = await this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task) throw new Error(`dispatchServerFixToDev: task ${taskId} not found`);
      if (task.reviewMode !== 'server' && !isSpecStagePhase(task.phase)) {
        throw new Error(`dispatchServerFixToDev: task ${taskId} is not in server review mode`);
      }
      if (!task.agentId) throw new Error(`dispatchServerFixToDev: task ${taskId} has no dev agent`);
      return {
        devAgentId: task.agentId,
        qaAgentId: task.qaAgentId,
        projectId: task.projectId,
        newToken: createSignalToken(),
        taskPhase: task.phase,
        currentReviewRound: task.reviewRound,
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
      if (opts.callerOwnsConsumedSignalFailure) return;
      if (!qaAgentId) return;
      const reviewedKind: PhaseSignalKind = taskPhase === 'spec' ? 'spec-reviewed' : 'code-reviewed';
      await this.setupPhaseSignal(taskId, qaAgentId, reviewedKind, { skipSnapshot: true });
    };

    const devBoundBefore = (await this.agentStore.get(devAgentId))?.taskId === taskId;
    const releaseFreshAcquire = async (): Promise<void> => {
      if (devBoundBefore) return;
      const released = await this.releaseAgentForTask(devAgentId, taskId, 'idle')
        .catch(() => false);
      if (!released) {
        console.error(
          `[AgentManager] dispatchServerFixToDev: releasing freshly acquired dev ${devAgentId} for ${taskId} failed`,
        );
      }
    };

    const acquired = await this.acquireAgentForTask(devAgentId, taskId, 'server-feedback');
    if (!acquired) {
      await rearmReviewedSignal();
      if (!opts.callerOwnsConsumedSignalFailure) {
        await this.emitIntervention(projectId, devAgentId, taskId, {
          phase: 'server-fix-dev-acquire-failed',
          devAgentId,
        });
      }
      return null;
    }

    if (qaAgentId) {
      const released = await this.releaseAgentIfBound(qaAgentId, taskId)
        .catch(() => false);
      if (!released) {
        await releaseFreshAcquire();
        await rearmReviewedSignal();
        if (!opts.callerOwnsConsumedSignalFailure) {
          await this.emitIntervention(projectId, qaAgentId, taskId, {
            phase: 'server-fix-qa-release-failed',
            qaAgentId,
          });
        }
        return null;
      }
    }

    const transition = await this.transitionTaskStatus(
      taskId,
      'fixing',
      { fromStatus: ['review', 'max_rounds', 'spec-ready', 'ready'] },
      { signalToken: newToken, fixDispatchedAt: new Date().toISOString() },
    );
    if (!transition) {
      await releaseFreshAcquire();
      if (!opts.callerOwnsConsumedSignalFailure) {
        await this.emitIntervention(projectId, devAgentId, taskId, {
          phase: 'server-fix-transition-failed',
          devAgentId,
        });
      }
      return null;
    }

    let resumed = false;
    try {
      const feedbackPhase = taskPhase === 'spec' ? 'spec' : 'code';
      const feedbackRound = feedbackPhase === 'spec'
        ? (currentSpecRound ?? 1)
        : Math.max(claim.currentReviewRound, 1);
      const stored = await this.reviewStore?.getRound(taskId, feedbackPhase, feedbackRound);
      if (!stored?.findings) {
        throw new Error(
          `dispatchServerFixToDev: persisted aggregate findings missing for ${taskId}/${feedbackPhase}/${feedbackRound}`,
        );
      }
      const findingsJson = JSON.stringify(stored.findings);
      const findingsDigest = reviewFindingsDigest(stored.findings);
      resumed = await this.continueSession(taskId, devAgentId, 'server-feedback', {
        bypassTaskStatusGate: true,
        signalToken: newToken,
        serverPriorFindings: findingsJson,
        serverFindingsDigest: findingsDigest,
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
      if (!opts.callerOwnsConsumedSignalFailure) {
        await this.emitIntervention(projectId, devAgentId, taskId, {
          phase: 'server-fix-resume-failed',
          devAgentId,
        });
      }
      return null;
    }

    await this.armPostDispatchSignalOrHold(taskId, devAgentId, expectedKind, newToken);
    return await this.taskStore.get(taskId);
  }

  private projectRepoKey(projectId: string): string | null {
    const repo = this.getProjectConfig(projectId)?.repo;
    if (!repo) return null;
    if (isGitHubRepo(repo)) return `gh:${repoSlug(repo).toLowerCase()}`;
    const parsed = parseGitRemote(repo);
    if (parsed) return `git:${parsed.host.toLowerCase()}/${parsed.path}`;
    return `raw:${repo.trim()}`;
  }

  async computeCodeInterdiff(taskId: string, round: number): Promise<CodeInterdiffResult> {
    const store = this.getReviewStore();
    if (!store || !Number.isInteger(round) || round < 2) return { ok: false, reason: 'no-anchor' };
    const [cur, prev] = await Promise.all([
      store.getRound(taskId, 'code', round),
      store.getRound(taskId, 'code', round - 1),
    ]);
    const curSha = cur?.headSha;
    const prevSha = prev?.headSha;
    if (!curSha || !prevSha) return { ok: false, reason: 'no-anchor' };

    const task = await this.taskStore.get(taskId);
    if (!task?.agentId) return { ok: false, reason: 'released' };
    const agent = this.getAgentConfig(task.agentId);
    const agentState = await this.agentStore.get(task.agentId);
    // A rebound agent's Workdir checkout belongs to its new task — its git state describes
    // another branch, so the interdiff would be meaningless. Same skip rule as
    // findLineageViolation: the Workdir must still be bound to THIS task.
    if (!agent || agentState?.taskId !== taskId || !agentState.workdir) {
      return { ok: false, reason: 'released' };
    }
    await this.refreshWorkdirCacheFor(task.agentId);
    const diff = await this.getReviewTransport().readInterdiff(agent, prevSha, curSha);
    return { ok: true, diff };
  }

  async findLineageViolation(taskId: string, baseSha?: string): Promise<LineageViolation | null> {
    const task = await this.taskStore.get(taskId);
    if (!task?.agentId) return null;
    const agent = this.getAgentConfig(task.agentId);
    const agentState = await this.agentStore.get(task.agentId);
    // A rebound agent's Workdir checkout belongs to its new task — checking it would
    // produce verdicts about the wrong branch. Skip; the dispatch path's own
    // binding guards (acquire) surface the real failure.
    if (agentState?.taskId !== taskId) return null;
    const workdir = agentState.workdir;
    if (!agent || !workdir) return null;

    const runner = this.createRunnerFor(agent);
    let base = baseSha;
    if (!base) {
      // Callers without a baseSha (publish) run long after the review diff was
      // read; refresh origin/HEAD first or upstream commits merged since then
      // would linger in base..HEAD and flag tasks that leak nothing.
      const fetch = await execNetwork(
        runner,
        `${canonicalSelfGuard(workdir)} && ${GIT_NET_ENV} git -C ${shellQuote(workdir)} fetch origin --quiet`,
      );
      if (fetch.exitCode !== 0) {
        throw new Error(`lineage fetch failed in ${workdir}: ${fetch.stderr.trim()}`);
      }
      const mb = await runner.exec(
        `git -C ${shellQuote(workdir)} merge-base origin/HEAD HEAD`,
      );
      if (mb.exitCode !== 0) {
        throw new Error(`lineage merge-base failed in ${workdir}: ${mb.stderr.trim()}`);
      }
      base = mb.stdout.trim();
    }

    // Projects pointing at the same repo share one store and branch namespace,
    // so candidates are scoped by repo identity, not by projectId.
    const selfRepoKey = this.projectRepoKey(task.projectId);
    if (!selfRepoKey) return null;
    const tasks = await this.taskStore.list();
    const candidates = tasks
      .filter(t => t.id !== taskId
        && !TERMINAL_STATUSES.includes(t.status)
        && this.projectRepoKey(t.projectId) === selfRepoKey)
      .map(t => ({ taskId: t.id, branch: t.branch ?? BRANCH_PREFIX + t.id }));
    if (candidates.length === 0) return null;

    return findForeignTaskTip((cmd) => runner.exec(cmd), workdir, base, candidates);
  }

  async dispatchServerAfterDone(taskId: string, kind: 'branch' | 'pr'): Promise<TaskState | null> {
    const task = await this.taskStore.get(taskId);
    if (!task) throw new Error(`dispatchServerAfterDone: task ${taskId} not found`);
    const devAgentId = task.agentId;
    if (!devAgentId) throw new Error(`dispatchServerAfterDone: task ${taskId} has no dev agent`);

    // 幂等兜底：主路径已在 approve 前经 commitServerAfterDone 落盘 afterDone+binding；
    // 重启/重试直连本函数时，这里补齐（binding 不可变，已在则短路）。
    await this.commitServerAfterDone(taskId);

    let violation: LineageViolation | null;
    try {
      violation = await this.findLineageViolation(taskId);
    } catch (err) {
      await this.emitIntervention(task.projectId, devAgentId, taskId, {
        phase: 'server-after-done-lineage-check-failed',
        error: err instanceof Error ? err.message : String(err),
        note: 'Publish was not dispatched; mark-complete retries it once the repo state is fixed.',
      });
      return null;
    }
    if (violation) {
      await this.emitIntervention(task.projectId, devAgentId, taskId, {
        phase: 'server-after-done-lineage-violation',
        offendingTaskId: violation.taskId,
        offendingBranch: violation.branch,
        offendingSha: violation.sha,
        note: 'The task branch embeds another active task\'s commits; publishing would leak them into this PR. Rebase the branch onto origin/HEAD, then mark-complete to retry the publish.',
      });
      return null;
    }

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
      await this.emitIntervention(task.projectId, devAgentId, taskId, { phase: 'server-after-done-dev-acquire-failed', devAgentId });
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
      await this.emitIntervention(task.projectId, devAgentId, taskId, {
        phase: 'server-after-done-resume-failed',
        devAgentId,
        note: 'Publish prompt was not delivered; mark-complete retries the publish dispatch.',
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
    await this.refreshWorkdirCacheFor(task.agentId);
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
    // Pin the incarnation before reading state so a DELETE→recreate reusing %0 can't route the text to the new session.
    const genAtEntry = this.deletionGenerationOf(agentId);
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
      const taskId = state?.taskId;
      const lockToken = taskId ? await this.resolveTaskLockToken(state, taskId) : null;
      if (taskId && !lockToken) {
        throw new Error(
          `injectTextToAgent: agent ${agentId} no longer owns the exclusive lock for task ${taskId}`,
        );
      }
      const boundTask = state?.taskId ? await this.taskStore.get(state.taskId) : null;
      if (boundTask && TERMINAL_STATUSES.includes(boundTask.status)) {
        throw new Error(`injectTextToAgent: task ${state?.taskId} for agent ${agentId} is terminal; refusing injection`);
      }
      const paneId = state?.paneId;
      if (!paneId) throw new Error(`injectTextToAgent: agent ${agentId} has no live pane`);
      const fresh = await this.agentStore.get(agentId);
      if (!fresh || fresh.paneId !== paneId
        || fresh.taskId !== taskId
        || (taskId !== undefined && fresh.lockToken !== lockToken)) {
        throw new Error(`injectTextToAgent: agent ${agentId} binding or exclusive lock changed before paste`);
      }
      if (isCancelCleanupHold(fresh)) {
        throw new Error(`injectTextToAgent: agent ${agentId} taken over by cancel before paste`);
      }
      if (taskId && lockToken) {
        await this.assertTaskLockOwner(agentId, taskId, lockToken);
      }
      const tmux = new TmuxManager(this.createRunnerFor(cfg));
      const pane = await this.resolveClaimedPane(tmux, agentId, paneId);
      // resolveClaimedPane resolved by the CURRENT same-name session; re-verify incarnation + binding before paste (same as the image path).
      if (!this.deletionGateOpen(agentId, genAtEntry)) {
        throw new Error(`injectTextToAgent: agent ${agentId} was deleted or recreated before paste`);
      }
      const afterResolve = await this.agentStore.get(agentId);
      if (!afterResolve || afterResolve.paneId !== paneId || afterResolve.taskId !== taskId
        || (taskId !== undefined && afterResolve.lockToken !== lockToken)) {
        throw new Error(`injectTextToAgent: agent ${agentId} binding changed before paste`);
      }
      await tmux.injectPrompt(pane, text, agentId);
      await tmux.sendEnter(pane);
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
      if (this.codeVerdictInFlight.has(taskId)) {
        throw new ApiError(409, `Task ${taskId} code verdict is already being processed`);
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
      if (err instanceof PlatformMergeRecheckError && task.reviewMode === 'git' && task.status === 'merge-ready') {
        let retreated = false;
        if (err.kind === 'pending-feedback') {
          retreated = await this.withTaskLock(async () => {
            const fresh = await this.taskStore.get(task.id);
            if (!fresh || fresh.status !== 'merge-ready'
              || fresh.signalToken !== task.signalToken
              || fresh.latestHeadSha !== task.latestHeadSha) return false;
            const headSha = typeof fresh.latestHeadSha === 'string' && PLATFORM_HEAD_SHA_RE.test(fresh.latestHeadSha)
              ? fresh.latestHeadSha
              : undefined;
            if (headSha === undefined) return false;
            const now = new Date().toISOString();
            const generation = createSignalToken();
            const token = createSignalTokenExcluding(generation);
            await this.taskStore.set({
              ...this.stripPostApproveEpisodeFields(fresh),
              status: 'approved',
              postApproveGeneration: generation,
              postApproveHeadSha: headSha,
              postApproveToken: token,
              postApprovePhase: 'installed',
              pendingRedispatch: true,
              redispatchCount: 0,
              updatedAt: now,
            });
            return true;
          });
        } else {
          const fresh = await this.taskStore.get(task.id);
          const headSha = typeof fresh?.latestHeadSha === 'string' && PLATFORM_HEAD_SHA_RE.test(fresh.latestHeadSha)
            ? fresh.latestHeadSha
            : undefined;
          if (fresh?.status === 'merge-ready' && headSha !== undefined
            && fresh.signalToken === task.signalToken
            && fresh.latestHeadSha === task.latestHeadSha) {
            retreated = (await this.beginGitReviewPass(task.id, {
              fromStatus: [fresh.status],
              headSha,
              bumpRound: true,
              allowDuringComplete: true,
              expectPhase: fresh.phase,
              expectSignalToken: fresh.signalToken,
              patch: { latestHeadSha: headSha },
            })) !== null;
          }
        }
        await this.emitIntervention(task.projectId, undefined, task.id, {
          phase: 'confirm-merge-recheck-failed',
          kind: err.kind,
          gate: task.status,
          error: message,
          retreated,
          note: retreated
            ? err.kind === 'pending-feedback'
              ? 'Pending feedback returned the task to an approved post-approve episode.'
              : 'Invalid provenance created a new durable QA review pass.'
            : 'Accepted pass no longer verifies and the task could not be returned automatically; inspect and re-dispatch.',
        });
        throw new ApiError(409, `Merge blocked for task ${task.id}: ${message}`);
      }
      await this.emitIntervention(task.projectId, undefined, task.id, {
        phase: 'confirm-merge-failed',
        gate: task.status,
        error: message,
        note: 'Task stays at the gate: Confirm again to retry, or Cancel to retire the published artifact.',
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
      if (this.startCompactionThenRelease(id, state, taskId)) continue;
      await this.releaseAgentForTask(id, taskId, 'idle', { allowAwaitingHuman: true })
        .catch(err => {
          console.warn(`[AgentManager] confirm release ${id} failed:`, err);
        });
    }
  }

  private startCompactionThenRelease(
    agentId: string,
    state: AgentBindingFacts,
    taskId: string,
  ): boolean {
    // 人工介入/重建中的 pane 不发 /clear;confirm 语义要求解绑,落回直接释放
    const expectedPaneId = state.paneId;
    if (!expectedPaneId || state.status === 'awaiting_human' || state.creationToken) return false;
    const cfg = this.getAgentConfig(agentId);
    if (!cfg) return false;
    const tmux = new TmuxManager(this.createRunnerFor(cfg));
    void (async () => {
      const pane = await this.resolveClaimedPane(tmux, agentId, expectedPaneId);
      await this.runPostMergeCompaction(tmux, pane, agentId, taskId, agentRuntimeKindFor(cfg));
    })().catch(err =>
      console.warn(`[AgentManager] releaseTaskAgents compaction(${agentId}) failed:`, err),
    );
    return true;
  }

  private repoMergeQueue = new Map<string, Promise<unknown>>();

  protected async ffMergeBranch(task: TaskState): Promise<void> {
    const dev = this.getAgentConfig(task.agentId);
    if (!dev) throw new Error(`ffMergeBranch: no dev agent for task ${task.id}`);
    const state = await this.agentStore.get(task.agentId);
    const workdir = state?.workdir;
    if (!workdir) throw new Error(`ffMergeBranch: no Workdir for agent ${task.agentId}`);
    const branch = task.branch ?? BRANCH_PREFIX + task.id;
    const runner = this.createRunnerFor(dev);

    const prev = this.repoMergeQueue.get(task.projectId) ?? Promise.resolve();
    const run = prev.then(async () => {
      // fetch/push reach a remote derived from THIS Workdir; a rebound Workdir would redirect the push to a foreign repo, so each mutation carries the canonical self-guard in its own command.
      const guard = `${canonicalSelfGuard(workdir)} && `;
      const cd = `cd ${shellQuote(workdir)} && `;
      const db = await runner.exec(`${cd}git symbolic-ref --short refs/remotes/origin/HEAD`);
      const defaultBranch = db.stdout.trim().replace(/^origin\//, '');
      if (db.exitCode !== 0 || defaultBranch === '') {
        throw new Error(`ffMergeBranch: cannot resolve default branch: ${db.stderr.trim() || 'empty origin/HEAD'}`);
      }
      const fetch = await execNetwork(runner, `${guard}${cd}${GIT_NET_ENV} git fetch origin`);
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
      const push = await execNetwork(
        runner,
        `${guard}${cd}${GIT_NET_ENV} git push origin ${shellQuote(`origin/${branch}`)}:${shellQuote(defaultBranch)}`,
      );
      if (push.exitCode !== 0) {
        throw new Error(`ffMergeBranch [push] failed: ${push.stderr.trim() || push.stdout.trim()}`);
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
