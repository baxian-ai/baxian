import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { createSignalToken, type ReadFileSignal } from './phase-signal.js';
import { tmuxInstallHint } from './preflight.js';
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
  ReviewPhase,
  ReviewRound,
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
import { DriverOpError } from '../platform/git-driver.js';
import type { GitDriver, DriverExec } from '../platform/git-driver.js';
import type { PluginRegistry } from '../platform/plugin-registry.js';
import type { NormalizedRow } from '../platform/row-schema.js';
import { checkOpenPrBinding, type PrRejection } from '../platform/pr-binding.js';
import { collectPendingFeedback, scanCommentSourcesOnce, type PendingFeedbackResult } from '../platform/feedback.js';
import { recheckPassProvenance, type VerdictSourceScan } from '../platform/verdict-engine.js';
import type { AgentStore } from '../state/agent-store.js';
import { AGENT_STORE_NOOP } from '../state/agent-store.js';
import type { TaskStore } from '../state/task-store.js';
import { PostApproveStore, type PostApproveCompletion } from '../state/post-approve-store.js';
import type { LockManager } from '../state/lock.js';
import type { EventBus } from '../event/bus.js';
import type { ErrorRecordStore, ErrorRecordInput } from '../state/error-record-store.js';
import { SkillRegistry } from '../skill/registry.js';
import type { CommandRunner } from './runner.js';
import {
  createRunner,
  LocalRunner,
  shellQuote,
  resolveAgentHost,
  hostGroupKey,
  workdirHostGroupKey,
} from './runner.js';
import { GH_EXEC_TIMEOUT_MS, GIT_NET_ENV, execNetwork } from './net-exec.js';
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
  type AdoptPaneState,
  type AgentRuntimeKind,
  type TmuxSessionRef,
} from './tmux.js';
import { BranchManager, DirtyWorkdirError, ReviewHeadMismatchError, isAutoDeletableTaskBranch } from './branch.js';
import { RepoStore, createRepoStoreCache, moveFileIntoPlace, stageFileGuarded, type RepoStoreCache } from './repo-store.js';
import type { PaneStreamerManager } from './pane-streamer-manager.js';
import { PhaseSignalWatcher, type PhaseSignalWatcherStartArgs } from './phase-signal-watcher.js';
import type { PhaseSignalKind } from './phase-signal.js';
import { ReviewTransport, resolveServerPayloads, type ServerPayloadPromptOpts } from './review-transport.js';
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
import { resolveProjectTool } from '../config/validator.js';
import { SHA_HEX_SOURCE } from '../platform/types.js';

export interface EnsureSessionResult {
  ok: true;
  createdSession: boolean;
  freshRuntime: boolean;
  skillsStale?: true;
  paneId: string;
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
  | { kind: 'pane'; paneId: string }
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
  postApproveStore?: PostApproveStore;
  pluginRegistry?: PluginRegistry;
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
const GH_NET = { timeout: GH_EXEC_TIMEOUT_MS, retries: 1 } as const;
const PLATFORM_HEAD_SHA_RE = new RegExp(`^${SHA_HEX_SOURCE}$`);

// 复核类失败（provenance/ack）与平台/瞬态失败分型：前者调用方退回 approved 重入闭环（计划 Task 8）
export class PlatformCloseError extends Error {
  constructor(readonly step: 'close' | 'deleteBranch', cause: unknown) {
    super(`platform ${step} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'PlatformCloseError';
  }
}

export class PlatformMergeRecheckError extends Error {
  constructor(readonly reason: string) {
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
  serverPriorResponse?: string;
  specDocuments?: readonly SpecDocument[];
  armBeforeInject?: (ctx: DispatchArmContext) => Promise<boolean>;
}

interface StartSessionOpts extends SessionDispatchOpts {
  preserveBindingOnFailure?: boolean;
}

export interface ContinueSessionOpts extends SessionDispatchOpts {
  postApproveRedispatchCount?: number;
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

export type CodeInterdiffResult =
  | { ok: true; diff: string }
  | { ok: false; reason: 'no-anchor' }
  | { ok: false; reason: 'released' };

interface DispatchReviewSnapshot {
  qaAgentId?: string;
  signalToken?: string;
  reviewHeadAnchorSha?: string;
  reviewDispatchedAt?: string;
  passToken?: string;
  failToken?: string;
}

export interface ServerReviewDriver {
  dispatchCodeReview(task: TaskState): Promise<boolean>;
  dispatchSpecReview(task: TaskState): Promise<boolean>;
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
  protected pluginRegistry?: PluginRegistry;
  private readonly platformDriverExec: DriverExec;
  protected phaseSignalWatcher?: PhaseSignalWatcher;
  protected errorRecordStore?: ErrorRecordStore;
  protected reviewStore?: ReviewStore;
  private reviewTransportInstance?: ReviewTransport;
  private serverReviewDriver?: ServerReviewDriver;
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
  private manualReviewInFlight = new Set<string>();
  private markCompleteInFlight = new Set<string>();
  private specVerdictInFlight = new Set<string>();
  private codeVerdictInFlight = new Set<string>();
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
    this.pluginRegistry = deps.pluginRegistry;
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

  private async emitIntervention(
    projectId: string,
    agentId: string | undefined,
    taskId: string | undefined,
    data: Record<string, unknown> & { phase: string },
  ): Promise<void> {
    await this.safeEmit({
      id: '',
      type: 'human.intervention',
      timestamp: new Date().toISOString(),
      projectId,
      ...(agentId ? { agentId } : {}),
      ...(taskId ? { taskId } : {}),
      data,
    });
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
      await this.agentStore.update(agentId, (existing) => {
        if (!existing) return AGENT_STORE_NOOP;
        return {
          ...existing,
          workdir,
          updatedAt: new Date().toISOString(),
        };
      });
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
        `tmux probe failed: ${err instanceof Error ? err.message : String(err)}; ` +
          `if tmux is missing, ${tmuxInstallHint(agent.projectId)}`,
      );
    }

    if (mode === 'create' && alive) {
      const reclaimed = await this.runUnderSessionLifecycle(agentId, () =>
        this.reclaimHalfCreatedSession(tmux, agentId),
      );
      if (!reclaimed) {
        throw new EnsureSessionError(
          { createdSession: false, agentId },
          `tmux session "${agentId}" already exists on host; baxian only manages sessions ` +
            `it creates itself — kill it manually or pick a different agent id`,
        );
      }
    }

    if (alive && (mode === 'runtime' || mode === 'recover')) {
      return this.adoptOrRestartSession(tmux, runner, agent, agentId, workdir, workdir);
    }

    return this.buildFreshSession(tmux, agent, agentId, workdir, workdir);
  }

  private async provisionRepoSkills(
    runner: CommandRunner,
    agent: AgentConfig,
    workdir: string,
  ): Promise<void> {
    if (this.skillRegistry.names().length === 0) return;
    const subdir = skillSubdirFor(agent.runtime);
    const destRoot = `${workdir}/${subdir}`;
    await this.excludeInjectedSkills(runner, workdir, subdir);
    // opencode's skills are model-invoked, not slash commands; the dispatched /<skill> sigil
    // reaches the model as message text and it loads the skill from .opencode/skills. We do NOT
    // wrap skills as .opencode/commands: opencode expands $ARGUMENTS in a command template and
    // would execute a `!`cmd`` / inline a @path embedded in an untrusted task title/description
    // before the skill runs. Message-body payloads are not expanded, so this path is injection-safe.
    await this.runUnderSkillDirLock(this.skillDirLockKey(agent, workdir), async () => {
      await this.ensureSkillDirSafe(runner, workdir, subdir);
      await this.skillRegistry.materialize(
        (path, content) => this.atomicWriteFile(runner, workdir, path, content),
        destRoot,
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
        const outcome = await new TmuxManager(runner).killSessionRef(ref);
        if (outcome === 'stale-server') {
          console.warn(
            `[AgentManager] ${agentId} rollback (${reason}): tmux server generation changed — leaving session ${ref.sessionId} untouched`,
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
  ): Promise<void> {
    const top = subdir.split('/')[0];
    const keep = this.skillRegistry.names().map((n) => `! -name ${shellQuote(n)}`).join(' ');
    const inner =
      `[ ! -L ${shellQuote(workdir)} ] && [ -d ${shellQuote(workdir)} ] && ` +
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
      ['@baxian-skills-version', this.skillRegistry.contentHash()],
    ]);
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
      `[ ! -L ${shellQuote(workdir)} ] && [ -d ${shellQuote(workdir)} ] && ` +
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
  ): Promise<void> {
    const outcome = await tmux.setSessionOptionsIfAlive(ref, entries);
    if (outcome === 'gone') {
      throw new Error(
        `tmux session ${ref.sessionId} (${agentId}) vanished before its options could be applied`,
      );
    }
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
      await this.setSessionOptions(tmux, agentId, createdRef, [
        ['@baxian-agent-id', agentId],
        ['@baxian-runtime', agent.runtime],
        [WORKDIR_SESSION_OPTION, sessionDir],
        ['allow-passthrough', 'on'],
        ['set-titles', 'on'],
        ['window-size', 'latest'],
        ...this.runtimePinEntries(),
        ['status-right', ''],
      ]);
      await tmux.setServerOption('extended-keys', 'on');
      await tmux.appendServerOptionIfMissing('terminal-features', 'xterm*:extkeys');
      const paneId = await tmux.getSinglePaneIdByRef(createdRef);
      await tmux.sendKeysToPane(paneId, `${launchCommandIn(sessionDir, agent)}\n`);
      await tmux.handleTrustDialog(paneId, runtime, {
        timeoutMs: this.bootstrapTimeoutsMs.trustDialog,
      });
      await tmux.waitReplReady(paneId, runtime, {
        timeoutMs: this.bootstrapTimeoutsMs.waitReplReady,
        scrollback: 0,
      });
      await this.tagSessionSkillsVersion(tmux, agentId, createdRef);
      return { ok: true, createdSession: true, freshRuntime: true, paneId, workdir, sessionRef: createdRef };
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
      if (!(await this.runGreetingHandshake(agentId, cfgAtStart, result.paneId))) {
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
    await this.emitIntervention(existing.projectId, agentId, undefined, { phase: 'greeting_failed', reason });
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

  // Claim snapshot and adoption declaration share one critical section with rollbacks.
  private async adoptOrRestartSession(
    tmux: TmuxManager,
    runner: CommandRunner,
    agent: AgentConfig & { projectId: string },
    agentId: string,
    workdir: string,
    sessionDir: string,
  ): Promise<EnsureSessionResult> {
    return this.runUnderSessionLifecycle(agentId, () =>
      this.adoptOrRestartSessionLocked(tmux, runner, agent, agentId, workdir, sessionDir),
    );
  }

  private async adoptOrRestartSessionLocked(
    tmux: TmuxManager,
    runner: CommandRunner,
    agent: AgentConfig & { projectId: string },
    agentId: string,
    workdir: string,
    sessionDir: string,
  ): Promise<EnsureSessionResult> {
    let snapshot: Awaited<ReturnType<TmuxManager['getSessionSnapshot']>>;
    try {
      snapshot = await tmux.getSessionSnapshot(agentId);
    } catch (err) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `session snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!snapshot) {
      return this.buildFreshSession(tmux, agent, agentId, workdir, sessionDir);
    }
    const sessionRef = snapshot.ref;
    if (snapshot.claim !== agentId) {
      if (snapshot.claim === null && await this.reclaimHalfCreatedSession(tmux, agentId, snapshot)) {
        return this.buildFreshSession(tmux, agent, agentId, workdir, sessionDir);
      }
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `tmux session "${agentId}" exists but @baxian-agent-id session claim mismatch ` +
          `(got "${snapshot.claim ?? 'null'}"); baxian will not adopt foreign session — operator must intervene`,
      );
    }
    this.adoptGeneration.set(agentId, (this.adoptGeneration.get(agentId) ?? 0) + 1);
    try {
      await this.setSessionOptions(tmux, agentId, sessionRef, this.runtimePinEntries());
    } catch (err) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `pinning runtime session options failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let paneId: string;
    try {
      paneId = await tmux.getSinglePaneIdByRef(sessionRef);
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
    let currentPath: string;
    try {
      currentPath = await tmux.getPaneCurrentPath(paneId);
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
            paneId,
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
          stale = await this.replSkillsStale(tmux, agentId);
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
            workdir,
            sessionRef,
          };
        }
        return { ok: true, createdSession: false, freshRuntime: false, paneId, workdir, sessionRef };
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
          await this.tagSessionSkillsVersion(tmux, agentId, sessionRef);
          return { ok: true, createdSession: false, freshRuntime: true, paneId, workdir, sessionRef };
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
      await tmux.sendKeysToPane(paneId, `${launchCommandIn(sessionDir, agent)}\n`);
      await tmux.handleTrustDialog(paneId, runtime, {
        timeoutMs: this.bootstrapTimeoutsMs.trustDialog,
      });
      await tmux.waitReplReady(paneId, runtime, {
        timeoutMs: this.bootstrapTimeoutsMs.waitReplReady,
        scrollback: 0,
      });
      await this.tagSessionSkillsVersion(tmux, agentId, sessionRef);
      return { ok: true, createdSession: false, freshRuntime: true, paneId, workdir, sessionRef };
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
      outcome = await tmux.killSessionRef(snapshot.ref, { onlyIfUnclaimed: true });
    } catch (err) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `killSessionRef (half-created leftover) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (outcome === 'refused' || outcome === 'stale-server') {
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
      outcome = await tmux.killSessionRef(sessionRef);
    } catch (err) {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `killSessionRef (${reason}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (outcome === 'stale-server') {
      throw new EnsureSessionError(
        { createdSession: false, agentId },
        `tmux server generation changed while replacing session (${reason}); retry to observe the new state`,
      );
    }
    if (outcome === 'killed') {
      console.warn(`[AgentManager] ${agentId}: killed session ${sessionRef.sessionId} (${reason})`);
    } else {
      console.warn(`[AgentManager] ${agentId}: session ${sessionRef.sessionId} already gone (${reason})`);
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
    const now = new Date().toISOString();
    await this.agentStore.update(agentId, (existing) => ({
      ...(existing ?? { id: agentId, projectId: cfg.projectId, updatedAt: now }),
      id: agentId,
      projectId: cfg.projectId,
      taskId,
      lockToken: token,
      ...(phase === 'code' && !sameTaskReentry ? { bootstrappingTaskId: taskId } : {}),
      updatedAt: now,
    }));
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
      expectedHold?: { phase: string | undefined; since: string | undefined; nonce: string | undefined };
      expectedLockToken?: string;
    } = {},
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
            };
            return cleared;
          }
          return {
            ...latest,
            updatedAt: now,
          };
        });
        if (preservedNewerHold) {
          console.warn(
            `[AgentManager] releaseAgentForTask: agent ${agentId} holds a newer generation than the captured one; keeping the hold`,
          );
          return false;
        }
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
            if (state.paneId !== runtime.paneId) {
              await this.agentStore.update(agentId, (latest) => {
                if (
                  !latest
                  || latest.taskId !== expectedTaskId
                  || latest.lockToken !== lockToken
                  || latest.workdir !== releaseWorkdir
                ) {
                  return AGENT_STORE_NOOP;
                }
                return { ...latest, paneId: runtime.paneId, updatedAt: new Date().toISOString() };
              });
              const refreshed = await this.assertTaskGeneration(
                agentId,
                expectedTaskId,
                lockToken,
                releaseWorkdir,
              );
              if (refreshed.paneId !== runtime.paneId) {
                throw new Error(`Agent ${agentId} runtime pane changed during release; operation aborted`);
              }
            }
            await this.waitForReplPromptReady(
              tmux,
              runtime.paneId,
              agentRuntimeKindFor(cfg),
              this.cleanComposerWaitMs,
            );
          } else {
            sessionConfirmedAbsent = true;
          }
          await this.assertTaskGeneration(agentId, expectedTaskId, lockToken, releaseWorkdir);
          // 探测/等待期间 markAwaitingHuman 不受本锁串行；进入 checkout 变更前按当前盘面重验世代
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
          updatedAt: now,
        };
      });
      if (holdGenerationChanged) {
        console.warn(
          `[AgentManager] releaseAgentForTask: agent ${agentId} hold generation changed during release; keeping the hold`,
        );
        return false;
      }
      return this.lockManager.releaseIfOwner(agentId, expectedTaskId, lockToken);
    });
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
      const token = await this.lockManager.acquire(cfg.id, owner);
      if (!token) continue;
      const cleanupResults: Array<{
        task: TaskState;
        cleanup: Awaited<ReturnType<BranchManager['cleanupTaskBranch']>>;
      }> = [];
      try {
        const lockedState = await this.agentStore.get(cfg.id);
        if (!lockedState || !canDispatchWithBinding(lockedState)) continue;
        if (!(await this.lockManager.isOwner(cfg.id, owner, token))) continue;
        refs = await branches.listLocalTaskRefs(workdir);
        refs = refs.filter(ref => candidateByBranch.has(ref.slice('refs/heads/'.length)));
        if (refs.length === 0) continue;
        const tmux = new TmuxManager(runner);
        if (await tmux.hasSession(cfg.id)) {
          const claim = await tmux.getOption(cfg.id, '@baxian-agent-id');
          if (claim !== cfg.id) {
            throw new Error(`tmux session claim mismatch for ${cfg.id}: ${claim ?? '<missing>'}`);
          }
          const paneId = lockedState.paneId ?? await tmux.getSinglePaneId(cfg.id);
          await this.waitForReplPromptReady(
            tmux,
            paneId,
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

  private async setAgentNeedInput(agentId: string, pending: boolean, opts: { taskId?: string } = {}): Promise<void> {
    const now = new Date().toISOString();
    try {
      await this.agentStore.update(agentId, (existing) => {
        if (!existing) return AGENT_STORE_NOOP;
        // A stale watcher callback must not stamp a rebound agent: the badge belongs
        // to the watch's task, so a taskId mismatch means the binding moved on.
        if (opts.taskId !== undefined && existing.taskId !== opts.taskId) return AGENT_STORE_NOOP;
        if (pending) {
          if (existing.needInputAt !== undefined) return AGENT_STORE_NOOP;
          return { ...existing, needInputAt: now, updatedAt: now };
        }
        if (existing.needInputAt === undefined) return AGENT_STORE_NOOP;
        const { needInputAt: _needInputAt, ...rest } = existing;
        return { ...rest, updatedAt: now };
      });
    } catch (err) {
      console.warn(`[AgentManager] setAgentNeedInput(${agentId}, ${pending}) failed:`, err);
    }
  }

  // Single entry for arming phase-signal watches: every path (dispatch, post-approve,
  // recover, rollback) must carry the need-input callback, or that watch silently
  // drops the side-channel and the badge never lights for its phase.
  private startPhaseSignalWatch(
    args: Omit<PhaseSignalWatcherStartArgs, 'onNeedInput'>,
  ): Promise<boolean> {
    if (!this.phaseSignalWatcher) return Promise.resolve(true);
    return this.phaseSignalWatcher.start({
      ...args,
      onNeedInput: (pending) => {
        void this.setAgentNeedInput(args.agentId, pending, { taskId: args.taskId });
      },
    });
  }

  // The user typed into the agent's terminal — its pending question is being answered.
  async notifyHumanTerminalInput(agentId: string): Promise<void> {
    this.phaseSignalWatcher?.rearmNeedInput(agentId);
    await this.setAgentNeedInput(agentId, false);
  }

  async clearAwaitingHuman(
    agentId: string,
    opts: { expectedHold?: { phase?: string; since?: string; nonce?: string } } = {},
  ): Promise<boolean> {
    const now = new Date().toISOString();
    let cleared = false;
    await this.agentStore.update(agentId, (latest) => {
      if (!latest || latest.status !== 'awaiting_human') return AGENT_STORE_NOOP;
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
    const now = new Date().toISOString();
    let projectId = '';
    let taskId: string | undefined;
    let wrote = false;
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
      // 锁代 CAS：绑定被 successor re-acquire 后不得把工作中的 agent 挂回旧 hold
      if (opts.expectedLockToken !== undefined && existing.lockToken !== opts.expectedLockToken) {
        return AGENT_STORE_NOOP;
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
        awaitingNonce: randomBytes(8).toString('hex'),
        updatedAt: now,
      };
    });
    if (!wrote) return false;
    await this.emitIntervention(projectId, agentId, taskId, {
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
      reviewPassToken?: string;
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
            reviewPassToken: boundTask.signalToken,
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
      try {
        await this.dispatchReviewToQa(result.redispatchReviewTaskId, {
          bumpRound: false,
          fromStatus: ['review'],
          ...(result.reviewPassToken !== undefined ? { expectSignalToken: result.reviewPassToken } : {}),
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
            && after.lockToken === result.heldLockToken
          ) {
            await this.markAwaitingHuman(agentId, phase, holdReason, {
              expectedTaskId: reviewTaskId,
              ...(result.heldLockToken !== undefined ? { expectedLockToken: result.heldLockToken } : {}),
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
          passSuperseded = taskNow?.status !== 'review'
            || (result.reviewPassToken !== undefined && taskNow.signalToken !== result.reviewPassToken);
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
                ...(result.heldLockToken !== undefined ? { expectedLockToken: result.heldLockToken } : {}),
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

    let claim: string | null;
    try {
      claim = await tmux.getOption(agentId, '@baxian-agent-id');
    } catch (err) {
      return {
        kind: 'hold',
        reason:
          `Runtime session claim probe failed; refusing checkout cleanup: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (claim !== agentId) {
      return {
        kind: 'hold',
        reason:
          `Runtime session claim mismatch (got "${claim ?? 'null'}"); refusing checkout cleanup`,
      };
    }

    try {
      return { kind: 'pane', paneId: await tmux.getSinglePaneId(agentId) };
    } catch (err) {
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
      await tmux.waitReplReady(paneId, runtime, { timeoutMs, scrollback: 0, titleIdleFastPath: true });
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

    const snapshot = await tmux.getSessionSnapshot(agentId);
    if (!snapshot) {
      throw new Error(`restart-repl: tmux session ${agentId} does not exist; use retry to rebuild`);
    }
    if (snapshot.claim !== agentId) {
      throw new Error(
        `restart-repl: session claim mismatch (got "${snapshot.claim ?? 'null'}"); refusing to touch foreign session`,
      );
    }
    const paneId = await tmux.getSinglePaneIdByRef(snapshot.ref);
    await tmux.sendKeysToPane(paneId, 'C-c');
    const cmd = await this.pollPaneCommandStable(tmux, paneId, { timeoutMs: 2_000 });
    const RUNTIME = /^(?:claude|codex|node|opencode|qodercli(?:-[\d.]+)?|\d+\.\d+\.\d+)$/;
    const SHELL = /^(?:zsh|bash|sh|fish)$/;
    if (RUNTIME.test(cmd)) {
      await tmux.sendKeysToPane(paneId, REPL_EXIT_COMMAND[cfg.runtime], 'Enter');
      await this.pollPaneCommandStable(tmux, paneId, { timeoutMs: 2_000, expectShell: true });
    } else if (!SHELL.test(cmd)) {
      throw new Error(`restart-repl precondition failed: unexpected pane state "${cmd}"`);
    }

    const project = this.getProjectConfig(cfg.projectId);
    if (!project) throw new Error(`restart-repl: project ${cfg.projectId} does not exist`);
    const workdir = (await this.ensureWorkdir(cfg, project, runner)).workdir;
    const paneWorkdir = await tmux.getPaneCurrentPath(paneId);
    if (!await sameDirOnHost(runner, paneWorkdir, workdir)) {
      throw new Error(
        `restart-repl: pane Workdir ${paneWorkdir} does not match agent Workdir ${workdir}; ` +
        'use retry to rebuild the session safely',
      );
    }
    await this.provisionRepoSkills(runner, cfg, workdir);
    await this.setSessionOptions(tmux, agentId, snapshot.ref, [[WORKDIR_SESSION_OPTION, workdir]]);

    const runtime = agentRuntimeKindFor(cfg);
    const relaunch = async (): Promise<void> => {
      await tmux.sendKeysToPane(paneId, `${launchCommandIn(workdir, cfg)}\n`);
      await tmux.handleTrustDialog(paneId, runtime, {
        timeoutMs: this.bootstrapTimeoutsMs.trustDialog,
      });
      await tmux.waitReplReady(paneId, runtime, {
        timeoutMs: this.bootstrapTimeoutsMs.waitReplReady,
        scrollback: 0,
      });
      await this.tagSessionSkillsVersion(tmux, agentId, snapshot.ref);
    };
    await this.runUnderSkillDirLock(this.skillDirLockKey(cfg, workdir), relaunch);

    await this.agentStore.update(agentId, (state) => {
      if (!state) return AGENT_STORE_NOOP;
      return {
        ...state,
        paneId,
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
  ): Promise<boolean> {
    return this.withTaskLock(async () => {
      const fresh = await this.taskStore.get(taskAtEntry.id);
      if (
        fresh?.agentId !== agentId
        || fresh.status !== taskAtEntry.status
        || fresh.phase !== taskAtEntry.phase
        || fresh.signalToken !== taskAtEntry.signalToken
      ) return false;
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

  async redispatchTaskPromptAfterReplRestart(agentId: string, taskId: string): Promise<boolean> {
    const agent = this.getAgentConfig(agentId);
    const task = await this.taskStore.get(taskId);
    if (!agent || !task || !TASK_OWNER_ROLES.has(agent.role)) return false;
    if (task.agentId !== agentId) return false;
    const participantId = agent.role === 'research' ? task.researchAgentId : task.devAgentId;
    if (participantId !== agentId) return false;

    const bindingAtEntry = await this.agentStore.get(agentId);
    const entryHold = {
      phase: bindingAtEntry?.status === 'awaiting_human' ? bindingAtEntry.awaitingPhase : undefined,
      since: bindingAtEntry?.status === 'awaiting_human' ? bindingAtEntry.awaitingSince : undefined,
      nonce: bindingAtEntry?.status === 'awaiting_human' ? bindingAtEntry.awaitingNonce : undefined,
    };
    // Concurrent passes can advance the task mid-replay; every replay gate re-checks this snapshot.
    const taskStillCurrent = async (): Promise<boolean> => {
      const fresh = await this.taskStore.get(taskId);
      return fresh?.agentId === agentId
        && fresh.status === task.status
        && fresh.phase === task.phase
        && fresh.signalToken === task.signalToken;
    };
    // Hold ops share one task-mutation slot with a tuple re-check, and CAS on the entry hold generation.
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
    // skipSnapshot: stale scrollback literals belong to the aborted runtime; onlyReplaceOwnToken keeps a successor's watcher out of reach.
    const fencedReplay = (
      expectedKinds: readonly PhaseSignalKind[],
      token: string,
      stillCurrent: () => Promise<boolean>,
    ): Pick<ContinueSessionOpts, 'armBeforeInject' | 'guardBeforeInject'> => {
      const abortStaleReplay = async (): Promise<boolean> => {
        if (await stillCurrent()) return true;
        this.phaseSignalWatcher?.stopIfToken(taskId, token);
        return false;
      };
      return {
        armBeforeInject: async () => {
          if (!(await stillCurrent())) return false;
          const armed = await this.setupPhaseSignalWatcher(taskId, agentId, expectedKinds, token, {
            skipSnapshot: true,
            onlyReplaceOwnToken: true,
            // git 双 watcher 下 fence 只应比较自己的 (taskId, agentId) 条目：task 域会拿
            // sibling（reconciliation）的不同 token 否决本应合法的重布防
            ...(task.reviewMode === 'git' ? { replaceScope: 'agent' as const } : {}),
          });
          if (!armed) {
            if (!(await stillCurrent())) return false;
            // Own-generation arm failure: throwing routes the caller into the resumable hold.
            throw new Error(
              `replay signal watcher failed to arm for task ${taskId}; Restart REPL again or cancel the task`,
            );
          }
          return abortStaleReplay();
        },
        guardBeforeInject: abortStaleReplay,
      };
    };

    try {
      if (task.status === 'approved' && agent.role === 'dev') {
        return await this.replayApprovedHolderAfterReplRestart(
          agentId, task, taskStillCurrent, fencedReplay, { clearEntryHold, holdReplayFailure },
        );
      }

      // reconciliation 条目不是 replay 目标：它没有对应的可重放 prompt，误选会以 QA 轮换 token
      // 重注 dev 的 publish 提示（spec §5.3 ④ 只允许一次 actor 归位）
      const mapped = this.mapTaskStateToExpectedWatcher(task);
      if (!mapped || mapped.agentId !== agentId) return false;
      if (!task.signalToken) {
        return await holdReplayFailure(
          'restart-redispatch-failed',
          'REPL restarted mid-pass but the task has no signal token to replay the prompt with; cancel the task or re-dispatch it.',
        );
      }
      const signalToken = task.signalToken;

      const replayOpts: ContinueSessionOpts = {
        signalToken,
        preserveDispatchOutputs: true,
        expectedHold: { phase: undefined, since: undefined, nonce: undefined },
        ...fencedReplay(mapped.expectedKinds, signalToken, taskStillCurrent),
      };
      const replayInitialBootstrap = async (
        phase: 'research' | 'develop',
        opts: ContinueSessionOpts,
      ): Promise<boolean> => {
        // This hold means the prompt WAS delivered and only the marker clear failed; replaying would run it twice.
        if (entryHold.phase === 'bootstrap-marker-clear-failed') {
          return holdReplayFailure(
            'restart-redispatch-failed',
            'REPL restarted while the initial prompt was already delivered (its bootstrap marker clear had failed); replaying would dispatch the task twice. Resume and verify the Workdir, or cancel the task.',
          );
        }
        const bindingBefore = await this.agentStore.get(agentId);
        if (!(await clearEntryHold())) return false;
        const resumed = await this.continueSession(taskId, agentId, phase, opts);
        if (resumed && bindingBefore?.bootstrappingTaskId === taskId) {
          await this.finalizeReplayedBootstrap(agentId, taskId, phase, bindingBefore.lockToken);
        }
        return resumed;
      };

      if (task.status === 'in_progress' && task.phase === 'research' && agent.role === 'research') {
        return await replayInitialBootstrap('research', replayOpts);
      }

      if (task.status === 'in_progress' && task.phase === undefined && agent.role === 'dev') {
        // An undelivered bootstrap never started work, so the fresh-dispatch clean gate still applies.
        const delivered = (await this.agentStore.get(agentId))?.bootstrappingTaskId !== taskId;
        return await replayInitialBootstrap('develop', {
          ...replayOpts,
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
        return await this.continueSession(taskId, agentId, 'code', {
          ...replayOpts,
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
        return await this.continueSession(taskId, agentId, 'server-feedback', {
          ...replayOpts,
          ...(agent.role === 'dev' ? { allowDirtyWorkdir: true } : {}),
          serverPriorFindings: JSON.stringify(stored.findings),
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
          return await this.continueSession(taskId, agentId, 'server-feedback', {
            ...replayOpts,
            allowDirtyWorkdir: true,
            serverPriorFindings: JSON.stringify(stored.findings),
          });
        }
        if (!(await clearEntryHold())) return false;
        return await this.continueSession(taskId, agentId, 'fix', {
          ...replayOpts,
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

  // approved hosts two live holder passes — GitHub post-approve (PostApproveStore) and server after-done (task fields); a parked pre-publish holder stays on the waiting path.
  private async replayApprovedHolderAfterReplRestart(
    agentId: string,
    task: TaskState,
    taskStillCurrent: () => Promise<boolean>,
    fencedReplay: (
      expectedKinds: readonly PhaseSignalKind[],
      token: string,
      stillCurrent: () => Promise<boolean>,
    ) => Pick<ContinueSessionOpts, 'armBeforeInject' | 'guardBeforeInject'>,
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
      return this.continueSession(taskId, agentId, 'server-after-done', {
        signalToken: token,
        preserveDispatchOutputs: true,
        expectedHold: { phase: undefined, since: undefined, nonce: undefined },
        allowDirtyWorkdir: true,
        serverAfterDone: { kind: afterDone, branch: task.branch ?? BRANCH_PREFIX + taskId },
        ...fencedReplay(['code-ready'], token, taskStillCurrent),
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
        await this.clearPostApproveCompletionIfMatches(taskId, stored.token);
        completion = await this.rebuildPostApproveCompletion(agentId, task, holdReplayFailure);
      } else {
        completion = { token: stored.token, rebuilt: false };
      }
    } else {
      completion = await this.rebuildPostApproveCompletion(agentId, task, holdReplayFailure);
    }
    if (completion === 'held') return true;
    if (completion === 'stale') return false;
    const resolvedCompletion = completion;
    const completionStillCurrent = async (): Promise<boolean> => {
      const fresh = await this.taskStore.get(taskId);
      return fresh?.agentId === agentId
        && fresh.status === task.status
        && fresh.phase === task.phase
        && fresh.signalToken === task.signalToken
        && fresh.postApproveRevoked === undefined
        && fresh.postApproveHeadSha === task.postApproveHeadSha
        && (await this.getPostApproveCompletion(taskId))?.token === resolvedCompletion.token;
    };
    if (!(await completionStillCurrent())) return false;
    if (!(await clearEntryHold())) return false;
    let resumed = false;
    try {
      resumed = await this.continueSession(taskId, agentId, 'post-approve', {
        signalToken: completion.token,
        preserveDispatchOutputs: true,
        expectedHold: { phase: undefined, since: undefined, nonce: undefined },
        allowDirtyWorkdir: true,
        ...fencedReplay(['pr-merge-ready'], completion.token, completionStillCurrent),
      });
    } catch (err) {
      if (completion.rebuilt) await this.clearPostApproveCompletionIfMatches(taskId, completion.token);
      throw err;
    }
    if (resumed && task.reviewMode === 'git') {
      await this.confirmPostApprovePromptDelivered(taskId, completion.token);
    }
    if (!resumed && completion.rebuilt) {
      await this.clearPostApproveCompletionIfMatches(taskId, completion.token);
      const fresh = await this.taskStore.get(taskId);
      const episodeIntact = fresh?.agentId === agentId
        && fresh.status === task.status
        && fresh.phase === task.phase
        && fresh.signalToken === task.signalToken
        && fresh.postApproveRevoked === undefined
        && fresh.postApproveHeadSha === task.postApproveHeadSha;
      if (!episodeIntact) return false;
      return holdReplayFailure(
        'restart-redispatch-failed',
        'REPL restarted during the post-approve pass and the rebuilt prompt could not be delivered; Resume then Restart REPL to retry, or cancel the task.',
      );
    }
    return resumed;
  }

  // A bare hold would loop (Resume clears it, the next restart misses the record again), so rebuild from the persisted approved head.
  private async rebuildPostApproveCompletion(
    agentId: string,
    task: TaskState,
    holdReplayFailure: (phase: string, reason: string) => Promise<boolean>,
  ): Promise<{ token: string; rebuilt: true } | 'held' | 'stale'> {
    // latestHeadSha drifts with pushes/mismatch probes; only the head persisted at dispatch is provably approved.
    const approvedHeadSha = task.postApproveHeadSha;
    if (!approvedHeadSha) {
      const held = await holdReplayFailure(
        'restart-redispatch-failed',
        'REPL restarted during the post-approve pass but neither its completion context nor a provably approved head are persisted; cancel the task or re-request the review verdict.',
      );
      return held ? 'held' : 'stale';
    }
    const token = createSignalToken();
    // Conditional create: the in-lock re-read rejects any revoke/dispatch landed since the snapshot.
    const created = await this.withTaskLock(async () => {
      const fresh = await this.taskStore.get(task.id);
      if (
        !fresh
        || fresh.agentId !== agentId
        || fresh.status !== 'approved'
        || fresh.phase !== task.phase
        || fresh.signalToken !== task.signalToken
        || fresh.postApproveRevoked !== undefined
        || fresh.postApproveHeadSha !== approvedHeadSha
      ) {
        return false;
      }
      if (fresh.reviewMode === 'git') {
        if (fresh.postApproveToken !== undefined) return false;
        // rebuild 与常规安装同一 installed→delivered 协议：写后崩溃由 sweep 按 pending 补派
        await this.taskStore.set({
          ...fresh,
          postApproveToken: token,
          postApprovePhase: 'installed',
          pendingRedispatch: true,
          updatedAt: new Date().toISOString(),
        });
        return true;
      }
      if (await this.postApproveStore.get(task.id)) return false;
      await this.postApproveStore.set(task.id, { token, approvedHeadSha });
      return true;
    });
    if (!created) return 'stale';
    return { token, rebuilt: true };
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

      const boundState = await this.agentStore.get(id);
      if (boundState?.taskId) {
        try {
          const released = await this.releaseAgentForTask(id, boundState.taskId, 'idle', {
            allowAwaitingHuman: true,
          });
          if (!released) {
            throw new Error(`could not safely release task ${boundState.taskId}`);
          }
        } catch (err) {
          failures.push({ agentId: id, step: 'binding.release', error: err });
          continue;
        }
      }

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
          const snapshot = await tmux.getSessionSnapshot(id);
          if (!snapshot) return;
          if (snapshot.claim !== id) {
            console.warn(
              `[AgentManager] cleanupRemovedAgentRuntime: skipping kill for ${id} ` +
              `(claim=${snapshot.claim ?? 'null'}; not baxian-managed)`,
            );
            return;
          }
          const outcome = await tmux.killSessionRef(snapshot.ref);
          if (outcome === 'stale-server') {
            console.warn(
              `[AgentManager] cleanupRemovedAgentRuntime: tmux server generation changed for ${id} — leaving session untouched`,
            );
          } else if (outcome === 'killed') {
            console.warn(`[AgentManager] cleanupRemovedAgentRuntime: killed session ${snapshot.ref.sessionId} for removed agent ${id}`);
          }
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

  getProjectByRepoIdentity(repoKey: string): ProjectConfig | undefined {
    return this.config.project.find(p => repoIdentityKey(p.repo) === repoKey);
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
    if (task?.reviewMode === 'git') return this.gitCompletionOf(task);
    return this.postApproveStore.get(taskId);
  }

  // 'git' 的 completion 与效果字段同居 TaskState：consumedFeedback/pendingRedispatch 与
  // token CAS 必须同一次持久化（spec §6 双写协议）；legacy github 沿 PostApproveStore 至 M3c。
  private gitCompletionOf(task: TaskState): PostApproveCompletion | null {
    if (task.postApproveToken === undefined || task.postApproveHeadSha === undefined) return null;
    return {
      token: task.postApproveToken,
      approvedHeadSha: task.postApproveHeadSha,
      updatedAt: task.updatedAt,
      ...(task.redispatchCount !== undefined ? { redispatchCount: task.redispatchCount } : {}),
      ...(task.pendingRedispatch !== undefined ? { pendingRedispatch: task.pendingRedispatch } : {}),
    };
  }

  private stripGitCompletionFields(task: TaskState): TaskState {
    const { postApproveToken: _t, pendingRedispatch: _p, redispatchCount: _r, postApprovePhase: _ph, ...rest } = task;
    return rest as TaskState;
  }

  // Install CASes on the current approved episode; only a fresh human verdict (clearRevocation) unlocks a standing marker.
  async setPostApproveCompletion(
    taskId: string,
    value: {
      token: string;
      approvedHeadSha: string;
      redispatchCount?: number;
      pendingRedispatch?: boolean;
    },
    opts: { clearRevocation?: boolean } = {},
  ): Promise<boolean> {
    return this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (task) {
        if (task.status !== 'approved') return false;
        if (task.postApproveRevoked && !opts.clearRevocation) return false;
        if (task.postApproveHeadSha !== undefined && task.postApproveHeadSha !== value.approvedHeadSha) return false;
      }
      if (task?.reviewMode === 'git') {
        const { postApproveRevoked: _revoked, ...rest } = task;
        // 全量替换语义与 PostApproveStore.set 一致：未携带的 pending/redispatch 字段清空
        await this.taskStore.set({
          ...this.stripGitCompletionFields(opts.clearRevocation ? (rest as TaskState) : task),
          postApproveToken: value.token,
          postApprovePhase: 'installed',
          ...(value.redispatchCount !== undefined ? { redispatchCount: value.redispatchCount } : {}),
          ...(value.pendingRedispatch !== undefined ? { pendingRedispatch: value.pendingRedispatch } : {}),
          updatedAt: new Date().toISOString(),
        });
      } else {
        await this.postApproveStore.set(taskId, value);
      }
      if (!task) return true;
      if (task.postApproveRevoked && task.reviewMode !== 'git') {
        const { postApproveRevoked: _revoked, ...rest } = task;
        await this.taskStore.set({ ...rest, updatedAt: new Date().toISOString() });
      }
      if (!this.phaseSignalWatcher) return true;
      const armed = await this.startPhaseSignalWatch({
        taskId,
        projectId: task.projectId,
        agentId: task.agentId,
        expectedKinds: 'pr-merge-ready',
        token: value.token,
      });
      if (!armed) {
        // completion 没有 consumer 就不算安装成功：撤销本次写，durable pending（若有）随原状保留
        if (task.reviewMode === 'git') {
          await this.taskStore.set({ ...task, updatedAt: new Date().toISOString() });
        } else {
          await this.postApproveStore.clear(taskId);
        }
        return false;
      }
      return true;
    });
  }

  // post-approve prompt 的至少一次投递（spec §6）：pendingRedispatch 随 completion 安装保持 true，
  // 仅在 continueSession 确认送达后清除——安装与投递之间的崩溃由恢复扫描按 pending 补派。
  async confirmPostApprovePromptDelivered(taskId: string, token: string): Promise<void> {
    await this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task || task.reviewMode !== 'git' || task.postApproveToken !== token) return;
      await this.taskStore.set({
        ...task,
        pendingRedispatch: false,
        postApprovePhase: 'delivered',
        updatedAt: new Date().toISOString(),
      });
    });
  }

  async markPostApproveSignalReceived(taskId: string, token: string): Promise<void> {
    await this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task || task.reviewMode !== 'git' || task.postApproveToken !== token) return;
      if (task.postApprovePhase === 'signaled') return;
      await this.taskStore.set({ ...task, postApprovePhase: 'signaled', updatedAt: new Date().toISOString() });
    });
  }

  async clearPostApproveCompletion(taskId: string): Promise<void> {
    await this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (task?.reviewMode === 'git') {
        if (task.postApproveToken !== undefined || task.pendingRedispatch !== undefined
          || task.redispatchCount !== undefined) {
          await this.taskStore.set({
            ...this.stripGitCompletionFields(task),
            updatedAt: new Date().toISOString(),
          });
        }
      } else {
        await this.postApproveStore.clear(taskId);
      }
      this.phaseSignalWatcher?.stop(taskId);
    });
  }

  // CAS for an existing pass: never creates a record nor touches the marker, so it cannot resurrect a revoked completion.
  async updatePostApproveCompletionIfToken(
    taskId: string,
    expectedToken: string,
    patch: { redispatchCount?: number; pendingRedispatch?: boolean },
    opts: { consumeRevision?: { key: string; versionTime: number } } = {},
  ): Promise<boolean> {
    return this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (task?.postApproveRevoked) return false;
      if (task?.reviewMode === 'git') {
        if (task.postApproveToken !== expectedToken) return false;
        await this.taskStore.set({
          ...task,
          ...patch,
          ...(opts.consumeRevision
            ? { consumedFeedback: { ...task.consumedFeedback, [opts.consumeRevision.key]: opts.consumeRevision.versionTime } }
            : {}),
          updatedAt: new Date().toISOString(),
        });
        return true;
      }
      const current = await this.postApproveStore.get(taskId);
      if (!current || current.token !== expectedToken) return false;
      await this.postApproveStore.set(taskId, { ...current, ...patch });
      return true;
    });
  }

  // Deliberate clear: the persisted marker keeps a restart replay from rebuilding the completion and bypassing the block.
  async revokePostApproveCompletion(
    taskId: string,
    reason: 'request-changes' | 'redispatch-cap',
    opts: { expectedToken?: string; expectedHeadSha?: string } = {},
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
      if (opts.expectedToken !== undefined) {
        if (task.reviewMode === 'git') {
          if (task.postApproveToken !== opts.expectedToken) return false;
        } else {
          const current = await this.postApproveStore.get(taskId);
          if (current?.token !== opts.expectedToken) return false;
        }
      }
      if (task.reviewMode === 'git') {
        await this.taskStore.set({
          ...this.stripGitCompletionFields(task),
          postApproveRevoked: { reason, at: new Date().toISOString() },
          updatedAt: new Date().toISOString(),
        });
        this.phaseSignalWatcher?.stop(taskId);
        return true;
      }
      // Marker lands first: a crash before the clear leaves marker+completion, which every consumer fences on.
      await this.taskStore.set({
        ...task,
        postApproveRevoked: { reason, at: new Date().toISOString() },
        updatedAt: new Date().toISOString(),
      });
      await this.postApproveStore.clear(taskId);
      this.phaseSignalWatcher?.stop(taskId);
      return true;
    });
  }

  async clearPostApproveCompletionIfMatches(taskId: string, token: string): Promise<boolean> {
    return this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (task?.reviewMode === 'git') {
        if (task.postApproveToken !== token) return false;
        await this.taskStore.set({
          ...this.stripGitCompletionFields(task),
          updatedAt: new Date().toISOString(),
        });
        this.phaseSignalWatcher?.stop(taskId);
        return true;
      }
      const cleared = await this.postApproveStore.clearIfMatches(taskId, token);
      if (cleared) this.phaseSignalWatcher?.stop(taskId);
      return cleared;
    });
  }

  // Marker/token/head/pending are re-checked inside the committing critical section, so a concurrent revoke never loses.
  async completeApprovedPassToMergeReady(
    taskId: string,
    expectedToken: string,
  ): Promise<{ task: TaskState } | { refused: 'stale' | 'pending' }> {
    return this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task || task.status !== 'approved' || task.postApproveRevoked) {
        return { refused: 'stale' as const };
      }
      const completion = task.reviewMode === 'git'
        ? this.gitCompletionOf(task)
        : await this.postApproveStore.get(taskId);
      if (
        !completion
        || completion.token !== expectedToken
        || task.postApproveHeadSha === undefined
        || completion.approvedHeadSha !== task.postApproveHeadSha
      ) {
        return { refused: 'stale' as const };
      }
      if (completion.pendingRedispatch) return { refused: 'pending' as const };
      const next = task.reviewMode === 'git' ? this.stripGitCompletionFields(task) : task;
      delete next.postApproveHeadSha;
      Object.assign(next, {
        status: 'merge-ready' as TaskStatus,
        latestHeadSha: completion.approvedHeadSha,
        updatedAt: new Date().toISOString(),
      });
      await this.taskStore.set(next);
      if (task.reviewMode !== 'git') await this.postApproveStore.clear(taskId);
      this.phaseSignalWatcher?.stop(taskId);
      return { task: next };
    });
  }

  // 修剪顺序单向（spec §6）：仅在对应源 cursor durable 落盘后调用；水位停滞的源不修剪，
  // 有界性由水位前进保证，禁止按容量淘汰未覆盖键。
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

  // TaskState 效果+outbox 先 durable、投递成功再清（spec §6 双写协议）：崩溃于任一侧，
  // 重启从未清 outbox 重投，事件携确定性 key 供展示端去重——效果恰一次、通知至少一次。
  async recordClosedUnmergedAnchor(taskId: string, prNumber: number): Promise<boolean> {
    return this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task || task.reviewMode !== 'git' || TERMINAL_STATUSES.includes(task.status)) return false;
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
          // 确定性 id（spec §6 outbox）：重投/并发 flush 的重复条目同 id，消费/展示端可去重
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

  // merge-ready 信号是单发消费：git 分支在消费点引入网络复核，失败时必须重 arm（skipSnapshot
  // false 让仍在面板上的信号立即重放），否则一次瞬态失败吞掉整轮完成信号。
  async rearmPostApproveSignal(taskId: string, opts: { skipSnapshot?: boolean } = {}): Promise<boolean> {
    const task = await this.taskStore.get(taskId);
    if (!task || task.status !== 'approved') return false;
    const completion = task.reviewMode === 'git'
      ? this.gitCompletionOf(task)
      : await this.postApproveStore.get(taskId);
    if (!completion) return false;
    if (!this.phaseSignalWatcher) return true;
    return this.startPhaseSignalWatch({
      taskId,
      projectId: task.projectId,
      agentId: task.agentId,
      expectedKinds: 'pr-merge-ready',
      token: completion.token,
      // 刚消费的信号仍在滚动区：扫描失败路径必须 live-only，否则与持续失败叠加成无退避热循环
      ...(opts.skipSnapshot ? { skipSnapshot: true } : {}),
    });
  }

  // 配置身份切换与任务创建共栅栏（TOCTOU）：blocker 扫描与提交在 withTaskLock 内执行，
  // createTask 的「读配置快照+落任务」同经该锁，扫描时不可见的并发新任务不存在。
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

  async flushGitOutbox(): Promise<void> {
    const tasks = await this.taskStore.list();
    for (const task of tasks) {
      if (task.reviewMode !== 'git' || !task.outbox?.length) continue;
      try {
        await this.deliverTaskOutbox(task.id);
      } catch (err) {
        // 单任务失败不得饿死其后的 durable outbox（至少一次的重启保证）
        console.warn(`[AgentManager] flushGitOutbox: task=${task.id} failed, continuing:`, err);
      }
    }
  }

  // cancel 清理的部分成功可重试（spec §6 close 条 + 破坏性清理不静默失败）：close 已成而
  // deleteBranch 瞬态失败时任务已终态，重启在守卫成立的前提下幂等补删（REF_NOT_FOUND 即成功）。
  // 只清本代 pending：A 的 start 晚于 B 的失败返回时，无条件清除会吞掉 B 留下的重试锚
  async clearReviewDispatchPending(taskId: string, expectedToken: string): Promise<void> {
    await this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task || task.reviewDispatchPending !== true) return;
      if (task.status !== 'review' || task.signalToken !== expectedToken) return;
      const { reviewDispatchPending: _p, ...rest } = task;
      await this.taskStore.set({ ...(rest as TaskState), updatedAt: new Date().toISOString() });
    });
  }

  // 评审派发的至少一次（sweep 消费）：transition 落 pending、QA session 启动成功才清——
  // QA 缺失/忙/arm/start 失败的每条早退路径都由此在 60s 内自愈，无需依赖事件重放。
  async retryPendingGitReviewDispatches(): Promise<void> {
    const tasks = await this.listActiveGitTasks();
    for (const task of tasks) {
      if (task.reviewDispatchPending !== true) continue;
      // arm/start 失败回滚会退到 in_progress/fixing 且无第二触发源（poller 已记 pushSha、
      // watcher 已消费）：pending 在场即重新拉入 review
      if (!['review', 'in_progress', 'fixing'].includes(task.status)) continue;
      try {
        await this.dispatchReviewToQa(task.id, { bumpRound: false });
      } catch (err) {
        console.warn(`[AgentManager] retryPendingGitReviewDispatches: task=${task.id} still failing:`, err);
      }
    }
  }

  async retryGitRemoteBranchCleanup(): Promise<void> {
    const tasks = await this.taskStore.list({ status: 'cancelled' });
    for (const task of tasks) {
      const reason = task.branchCleanupPending?.reason;
      if (task.reviewMode !== 'git'
        || (reason !== 'remote-delete-failed' && reason !== 'remote-close-failed')) continue;
      try {
        const driver = this.platformDriverFor(task.projectId);
        const branch = task.branch;
        if (!driver || branch === undefined) continue;
        // close 先补（幂等：closed PR 再 PATCH state=closed 为 no-op），再按守卫补删分支
        if (reason === 'remote-close-failed' && task.prNumber !== undefined) {
          await driver.runOp('close', { prNumber: task.prNumber });
        }
        if (!isAutoDeletableTaskBranch({
          taskId: task.id,
          taskBranch: branch,
          branchCreatedByBaxian: task.branchCreatedByBaxian,
          actualRef: `refs/heads/${branch}`,
        })) {
          if (reason !== 'remote-close-failed') continue;
        } else {
          await driver.runOp('deleteBranch', { branch });
        }
        await this.withTaskLock(async () => {
          const fresh = await this.taskStore.get(task.id);
          const freshReason = fresh?.branchCleanupPending?.reason;
          if (freshReason !== 'remote-delete-failed' && freshReason !== 'remote-close-failed') return;
          const { branchCleanupPending: _pending, ...rest } = fresh!;
          await this.taskStore.set({ ...(rest as TaskState), updatedAt: new Date().toISOString() });
        });
      } catch (err) {
        console.warn(`[AgentManager] retryGitRemoteBranchCleanup: task=${task.id} still failing:`, err);
      }
    }
  }

  // 反馈消费的唯一状态机（spec §6 双写协议 + merge 条）：锁内按实时状态决定效果，效果字段
  // 与消费键同一次持久化——入口快照与提交之间的并发状态迁移不再能让 revision 落空。
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
          const next: TaskState = {
            ...task,
            status: 'approved',
            postApproveHeadSha: approvedHead,
            pendingRedispatch: true,
            consumedFeedback: consumed,
            ...(opts.feedbackAt !== undefined ? { prFeedbackReceivedAt: opts.feedbackAt } : {}),
            ...stamp,
          };
          await this.taskStore.set(next);
          return { kind: 'returned' as const, task: next };
        }
      }
      if (task.status === 'approved' && task.postApproveRevoked === undefined) {
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

  // merge-ready 不是评论面的冻结点（spec §6 merge 条）：新反馈单写退回 approved + 消费键，
  // 与 push 使 merge-ready 失效的既有语义对称。
  async returnMergeReadyToApproved(
    taskId: string,
    consume: { key: string; versionTime: number },
  ): Promise<TaskState | null> {
    return this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task || task.reviewMode !== 'git' || task.status !== 'merge-ready') return null;
      const approvedHead = typeof task.latestHeadSha === 'string' && PLATFORM_HEAD_SHA_RE.test(task.latestHeadSha)
        ? task.latestHeadSha
        : undefined;
      if (!approvedHead) return null;
      // pendingRedispatch 与状态翻转/消费键同写：崩溃于派发前，恢复扫描凭它补派（spec §6 至少一次）
      const next: TaskState = {
        ...task,
        status: 'approved',
        postApproveHeadSha: approvedHead,
        pendingRedispatch: true,
        consumedFeedback: { ...task.consumedFeedback, [consume.key]: consume.versionTime },
        updatedAt: new Date().toISOString(),
      };
      await this.taskStore.set(next);
      return next;
    });
  }

  async setupRecoveredPostApproveSignals(): Promise<void> {
    const tasks = await this.taskStore.list({ status: 'approved' });
    for (const task of tasks) {
      if (task.postApproveRevoked) {
        // Finish an interrupted revoke: the marker is authoritative, the leftover record must not re-arm.
        try {
          if (task.reviewMode === 'git') {
            if (task.postApproveToken !== undefined) {
              await this.taskStore.set({
                ...this.stripGitCompletionFields(task),
                updatedAt: new Date().toISOString(),
              });
            }
          } else {
            await this.postApproveStore.clear(task.id);
          }
        } catch (err) {
          console.warn(
            `[AgentManager] setupRecoveredPostApproveSignals: revoked completion cleanup failed for task=${task.id}:`,
            err,
          );
        }
        continue;
      }
      const completion = task.reviewMode === 'git'
        ? this.gitCompletionOf(task)
        : await this.postApproveStore.get(task.id);
      if (!completion) continue;
      if (task.postApproveHeadSha === undefined) {
        // A completion the task head cannot vouch for is another episode's residue until proven otherwise.
        console.warn(
          `[AgentManager] setupRecoveredPostApproveSignals: task=${task.id} has a stored completion but no persisted approved head; not re-arming`,
        );
        continue;
      }
      if (completion.approvedHeadSha !== task.postApproveHeadSha) {
        try {
          if (task.reviewMode === 'git') {
            await this.taskStore.set({
              ...this.stripGitCompletionFields(task),
              updatedAt: new Date().toISOString(),
            });
          } else await this.postApproveStore.clear(task.id);
          console.warn(
            `[AgentManager] setupRecoveredPostApproveSignals: task=${task.id} retired a completion bound to head ${completion.approvedHeadSha} (persisted approved head ${task.postApproveHeadSha})`,
          );
        } catch (err) {
          console.warn(
            `[AgentManager] setupRecoveredPostApproveSignals: stale completion cleanup failed for task=${task.id}:`,
            err,
          );
        }
        continue;
      }
      if (!this.phaseSignalWatcher) continue;
      try {
        await this.startPhaseSignalWatch({
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
      const mappings = this.mapTaskStateToExpectedWatchers(task);
      if (mappings.length === 0) continue;
      for (const mapped of mappings) {
        await this.setupRecoveredWatcherForMapping(task, mapped.token ?? task.signalToken, mapped, mappings.length > 1);
      }
    }
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
        specStage && task.status === 'review' ? 'spec-reviewed'
        : specStage && task.status === 'fixing' ? 'spec-fixed'
        : !specStage && task.status === 'review' ? 'pr-approved|pr-changes-requested'
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
    const result = await execNetwork(
      this.platformRunner,
      `gh api --paginate ${shellQuote(endpoint)} --jq ${shellQuote(jq)}`,
      GH_NET,
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
    const result = await execNetwork(
      this.platformRunner,
      `gh pr view ${task.prNumber} --repo ${shellQuote(repoSlug(project.repo))} --json headRefOid --jq .headRefOid`,
      GH_NET,
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
    const result = await execNetwork(
      this.platformRunner,
      `gh pr view ${prNumber} --repo ${shellQuote(repoSlug(project.repo))} --json headRefName,headRefOid --jq '.headRefName + "\\t" + .headRefOid'`,
      GH_NET,
    ).catch(() => undefined);
    if (!result || result.exitCode !== 0) return undefined;
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
    const result = await execNetwork(
      this.platformRunner,
      `gh pr view ${prNumber} --repo ${shellQuote(repoSlug(project.repo))} --json headRefName,headRefOid,body,state,isCrossRepository --jq '.headRefName + "\\t" + .headRefOid + "\\t" + .state + "\\t" + (.isCrossRepository | tostring) + "\\t" + .body'`,
      GH_NET,
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

  platformBindingFields(projectId: string): Partial<TaskState> {
    if (this.effectiveReviewMode(projectId) !== 'git') return {};
    const project = this.getProjectConfig(projectId);
    if (!project) return {};
    const tool = resolveProjectTool(project);
    if (tool === undefined) return {};
    return { platformBinding: { mode: 'git', repoKey: repoIdentityKey(project.repo), tool } };
  }

  // 指纹为纯身份三元组（spec §4）：binary/env/skill 文本 live 解析可演进，身份失配即拒绝
  private assertPlatformBinding(task: TaskState): void {
    const binding = task.platformBinding;
    if (!binding) {
      if (task.reviewMode !== 'git') return;
      // D11 无兼容负担：不存在合法的无快照 git 任务，缺失即损坏/手工恢复，按失配同级拒绝
      void this.emitIntervention(task.projectId, task.agentId || undefined, task.id, {
        phase: 'platform-binding-mismatch',
        reason: 'missing-binding-snapshot',
      });
      throw new Error(`platform binding missing for git task ${task.id}; refusing platform operations`);
    }
    const project = this.getProjectConfig(task.projectId);
    const live = project === undefined ? undefined : {
      mode: this.effectiveReviewMode(task.projectId),
      repoKey: repoIdentityKey(project.repo),
      tool: resolveProjectTool(project),
    };
    if (live !== undefined && live.mode === binding.mode
      && live.repoKey === binding.repoKey && live.tool === binding.tool) return;
    void this.emitIntervention(task.projectId, task.agentId || undefined, task.id, {
      phase: 'platform-binding-mismatch',
      binding,
      ...(live !== undefined ? { live: { mode: live.mode, repoKey: live.repoKey, tool: live.tool ?? '' } } : {}),
    });
    throw new Error(
      `platform binding mismatch for task ${task.id}: snapshot ${binding.mode}/${binding.repoKey}/${binding.tool} no longer matches the live config`,
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

  async listActiveGitTasks(projectId?: string): Promise<TaskState[]> {
    const tasks = await this.taskStore.list(projectId !== undefined ? { projectId } : undefined);
    return tasks.filter(t => t.reviewMode === 'git' && !TERMINAL_STATUSES.includes(t.status));
  }

  async platformFetchPrView(taskId: string): Promise<NormalizedRow> {
    const { task, driver } = await this.platformTaskAndDriver(taskId);
    if (task.prNumber === undefined) throw new Error(`task ${taskId} has no bound PR`);
    const [row] = await driver.runOp('prView', { prNumber: task.prNumber });
    return row!;
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
      try {
        const [project] = await driver.runOp('projectView');
        if (typeof project?.defaultBranch === 'string') expectedBase = project.defaultBranch;
      } catch {
        // 快照与实时默认分支都拿不到 → unverifiable：核验失败不是核验通过（fail closed）
      }
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

  async platformClosePr(taskId: string, opts: { deleteBranch: boolean }): Promise<void> {
    const { task, driver } = await this.platformTaskAndDriver(taskId);
    if (task.prNumber === undefined) throw new Error(`task ${taskId} has no bound PR`);
    try {
      await driver.runOp('close', { prNumber: task.prNumber });
    } catch (err) {
      throw new PlatformCloseError('close', err);
    }
    const branch = task.branch;
    const deletable = opts.deleteBranch && branch !== undefined && isAutoDeletableTaskBranch({
      taskId: task.id,
      taskBranch: branch,
      branchCreatedByBaxian: task.branchCreatedByBaxian,
      actualRef: `refs/heads/${branch}`,
    });
    if (deletable) {
      try {
        await driver.runOp('deleteBranch', { branch });
      } catch (err) {
        throw new PlatformCloseError('deleteBranch', err);
      }
    }
  }

  private async platformScanComments(driver: GitDriver, prNumber: number): Promise<VerdictSourceScan[]> {
    return scanCommentSourcesOnce(driver, prNumber, () => Date.now());
  }

  // merge-ready 迁移与 merge confirm 的 provenance/ack 双复核共用一次全源扫描（spec §6/§10）
  async platformVerifyAcceptedPass(taskId: string): Promise<
    { ok: true; pendingCount: number } | { ok: false; reason: string }
  > {
    const { task, driver } = await this.platformTaskAndDriver(taskId);
    if (task.prNumber === undefined) return { ok: false, reason: 'no bound PR' };
    const provenance = task.passProvenance;
    if (!provenance) return { ok: false, reason: 'no accepted pass provenance' };
    const scans = await this.platformScanComments(driver, task.prNumber);
    const recheck = recheckPassProvenance({
      token: provenance.token,
      failToken: provenance.failToken,
      anchorSha: provenance.anchorSha,
      carrier: { sourceKey: provenance.sourceKey, id: provenance.id, bodyDigest: provenance.bodyDigest },
    }, scans);
    if (!recheck.ok) return { ok: false, reason: `provenance ${recheck.reason}` };
    const pending = collectPendingFeedback(scans, {
      replyActorId: task.replyActorId,
      replyActorStatus: task.replyActorStatus,
    });
    if (!pending.allSourcesOk) return { ok: false, reason: 'source scan incomplete' };
    return { ok: true, pendingCount: pending.pending.size };
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
    // 人工兜底（max_rounds Mark complete）绕过 QA 授权复核（该路径本就无 pass），
    // binding/head/REST sha 的安全检查保留（spec §7 威胁模型：merge 有人工 confirm）
    if (opts.humanOverride !== true) {
      const provenance = task.passProvenance;
      if (!provenance) throw new PlatformMergeRecheckError('no accepted pass provenance on task');
      if (provenance.anchorSha.toLowerCase() !== opts.expectedHeadSha.toLowerCase()) {
        throw new PlatformMergeRecheckError(
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
        // 瞬态扫描不完整留在 gate 可重试；只有确定性失效（撤销/编辑/缺失）才退回 approved
        if (recheck.reason === 'source-scan-incomplete') {
          throw new Error('merge blocked: provenance source-scan-incomplete');
        }
        throw new PlatformMergeRecheckError(`provenance ${recheck.reason}`);
      }
      const pending = collectPendingFeedback(scans, {
        replyActorId: task.replyActorId,
        replyActorStatus: task.replyActorStatus,
      });
      if (!pending.allSourcesOk) throw new Error('merge blocked: pending-feedback scan incomplete');
      if (pending.pending.size > 0) {
        throw new PlatformMergeRecheckError(`${pending.pending.size} pending feedback revision(s) without ack`);
      }
    }
    // 临门 CAS：扫描期间 durable 退回（approved/pendingRedispatch/fixing）必须使本次 Confirm 失效；
    // REST sha 只保护 source head，保护不了评论面与 TaskState（残余网络窗口按 spec §6 如实声明）
    const fresh = await this.taskStore.get(taskId);
    if (!fresh
      || (opts.humanOverride === true
        // override 只绕过 provenance/ack，不绕过本次认领的 gate 代际：并发 RC 转 fixing 即失效
        ? fresh.status !== 'merge-ready'
        : (fresh.status !== 'merge-ready' && fresh.status !== 'ready'))
      || fresh.latestHeadSha !== opts.expectedHeadSha
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
          // 归因查询失败不遮蔽原始错误
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

  async listTasksByProject(projectId: string): Promise<TaskState[]> {
    return this.taskStore.list({ projectId });
  }

  async findTaskByBranch(branch: string, projectId: string): Promise<TaskState | undefined> {
    const repoKey = this.projectRepoKey(projectId);
    if (!repoKey) return undefined;
    const all = await this.taskStore.list();
    return all.find(t =>
      t.branch === branch && this.projectRepoKey(t.projectId) === repoKey,
    );
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

  async updateTaskIfStatus(
    taskId: string,
    expectedStatus: TaskStatus,
    updates: Partial<TaskState>,
    alsoExpect: Partial<Pick<TaskState, 'signalToken' | 'reviewRound'>> = {},
  ): Promise<boolean> {
    return this.withTaskLock(async () => {
      const task = await this.taskStore.get(taskId);
      if (!task || task.status !== expectedStatus) return false;
      if ('signalToken' in alsoExpect && task.signalToken !== alsoExpect.signalToken) return false;
      if ('reviewRound' in alsoExpect && task.reviewRound !== alsoExpect.reviewRound) return false;
      Object.assign(task, updates, { updatedAt: new Date().toISOString() });
      await this.taskStore.set(task);
      return true;
    });
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
    guard: { fromStatus: TaskStatus[]; expectSignalToken?: string },
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
      // 代际 CAS（spec §7）：校验后提交前的并发换代（push/重派轮换 token+pair）使旧 verdict 失效
      if (guard.expectSignalToken !== undefined && task.signalToken !== guard.expectSignalToken) return null;
      if (patch?.branch && patch.branch !== task.branch) {
        const existing = await this.findTaskByBranch(patch.branch, task.projectId);
        if (existing && existing.id !== taskId) return null;
      }
      // The revocation marker and approved head scope to the approved episode they were created in.
      if (previousStatus === 'approved' && toStatus !== 'approved') {
        delete task.postApproveRevoked;
        delete task.postApproveHeadSha;
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
      return this.repoStoreFactory(
        runner, project.repo, agent.mode, host, this.repoCache, agent.id, agent.workdir,
      );
    }
    return new RepoStore(
      runner, project.repo, agent.mode, host, this.repoCache, agent.id, agent.workdir,
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
        if (latest?.taskId === taskId && latest.lockToken !== expectedLockToken) return AGENT_STORE_NOOP;
        if (latest?.taskId !== undefined && latest.taskId !== taskId) return AGENT_STORE_NOOP;
        return {
          ...(latest ?? existing ?? { id: agentId, projectId, updatedAt: now }),
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
      const queued: TaskState = {
        ...taskBase,
        agentId: '',
        devAgentId: dev.id,
        ...researchFields,
        status: 'pending',
        ...(qa ? { qaAgentId: qa.id } : {}),
      };

      if (!target) {
        return this.persistQueuedTask(queued, 'preferred_agent_busy', input.preferredAgentId);
      }

      const lockToken = await this.lockManager.acquire(target.id, taskId);
      if (!lockToken) {
        return this.persistQueuedTask(queued, 'agent_locked', input.preferredAgentId);
      }

      const task: TaskState = {
        ...taskBase,
        agentId: target.id,
        devAgentId: dev.id,
        ...(qa ? { qaAgentId: qa.id } : {}),
        ...researchFields,
        status: 'in_progress',
      };
      await this.taskStore.set(task);
      await this.agentStore.update(target.id, (existing) => ({
        id: target.id,
        projectId,
        taskId,
        lockToken,
        bootstrappingTaskId: taskId,
        updatedAt: now,
        ...(existing?.paneId !== undefined ? { paneId: existing.paneId } : {}),
        ...(existing?.workdir !== undefined ? { workdir: existing.workdir } : {}),
        ...(existing?.creationToken !== undefined ? { creationToken: existing.creationToken } : {}),
      }));
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

  private async clearRuntimeForTaskBoundary(
    tmux: TmuxManager,
    paneId: string,
    agentId: string,
    runtime: AgentConfig['runtime'],
    revalidate: () => Promise<void>,
  ): Promise<void> {
    await this.acquireCompactGuard(agentId);
    try {
      await this.waitForReplPromptReady(tmux, paneId, runtime, this.cleanComposerWaitMs);
      await revalidate();
      await tmux.clearComposerDraft(paneId);
      const baseline = await tmux.captureSettledSnapshot(paneId, {
        timeoutMs: this.dispatchSettleTimeoutMs,
      });
      const baselineTitle = await tmux.readPaneTitle(paneId);
      await tmux.sendKeysLiteral(paneId, '/clear');
      await tmux.sendEnter(paneId);
      await tmux.waitSubmitAck(paneId, baseline, runtime, {
        timeoutMs: this.dispatchAckTimeoutMs,
        baselineTitle,
        acceptComposerChange: true,
      });
      await this.waitForReplPromptReady(tmux, paneId, runtime, this.dispatchAckTimeoutMs);
      if (await this.hasRuntimeSlashCommandRejection(tmux, paneId, '/clear')) {
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
      await this.taskStore.set(claimedTask);
      await this.agentStore.update(agentId, (existing) => ({
        id: agentId,
        projectId: cfg.projectId,
        taskId,
        lockToken,
        bootstrappingTaskId: taskId,
        updatedAt: now,
        ...(existing?.paneId !== undefined ? { paneId: existing.paneId } : {}),
        ...(existing?.workdir !== undefined ? { workdir: existing.workdir } : {}),
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
      const fetched = await this.fetchPrHeadSha(task.id);
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
        const fetched = await this.fetchPrHeadSha(task.id);
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
    const { paneId, workdir } = ensure;

    const runner = this.createRunnerFor(agent);
    const tmux = new TmuxManager(runner);
    const branchManager = new BranchManager(runner);
    const lockState = await this.agentStore.get(agentId);
    if (!lockState || lockState.taskId !== taskId || lockState.lockToken !== lockToken) return false;
    await assertOwner();
    await this.waitForReplPromptReady(tmux, paneId, agent.runtime, this.cleanComposerWaitMs);

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
        await this.clearRuntimeForTaskBoundary(tmux, paneId, agentId, agent.runtime, assertOwner);
        if (ensure.skillsStale) await this.tagSessionSkillsVersion(tmux, agentId, ensure.sessionRef);
      }
    } catch (err) {
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
      const {
        needInputAt: _needInputAt,
        ...rest
      } = stateNow;
      return {
        ...rest,
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
      prompt = buildPromptInline({
        task,
        phase,
        agent,
        workdir: dispatchWorkdir,
        skillRegistry: this.skillRegistry,
        hasQaPartner,
        ...(promptSignalToken ? { signalToken: promptSignalToken } : {}),
        ...(promptSpecRound !== undefined ? { currentSpecRound: promptSpecRound } : {}),
        ...(imagePaths.length ? { imagePaths } : {}),
        ...(reviewCheckout ? { serverReviewCheckout: reviewCheckout.mode } : {}),
        ...(reviewCheckout?.fallbackReason ? { serverReviewFallbackReason: reviewCheckout.fallbackReason } : {}),
        ...(opts.serverBaseSha !== undefined ? { serverBaseSha: opts.serverBaseSha } : {}),
        ...(opts.serverHeadSha !== undefined ? { serverHeadSha: opts.serverHeadSha } : {}),
        ...(opts.serverHeadTree !== undefined ? { serverHeadTree: opts.serverHeadTree } : {}),
        ...(opts.serverBatch ? { serverBatch: opts.serverBatch } : {}),
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
      await this.agentStore.update(agentId, (existing) => {
        if (isCancelCleanupHold(existing)) { cancelHoldWon = true; return AGENT_STORE_NOOP; }
        return {
          id: agentId,
          projectId: agent.projectId,
          paneId,
          taskId,
          workdir,
          lockToken,
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
        await cleanupCheckoutOrHold();
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
        data: { phase, workdir: dispatchWorkdir },
      });
      this.startRuntimeMenuWatch(agentId);
      return true;
    } catch (err) {
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
    paneId: string,
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
      return await this.injectAndAwaitAckSteps(tmux, paneId, prompt, agentId, runtime, revalidate, guardBeforePaste);
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
    guardBeforePaste?: () => Promise<boolean>,
  ): Promise<{ acked: boolean; composerDelivered: boolean; aborted?: boolean }> {
    // 静态忙信号（文本忙样式/working title）可能是残稿或 stale title 冒充，一律由帧活性仲裁；ready 视图覆盖 stale title。
    const preTitle = await tmux.readPaneTitle(paneId);
    const preFrame = await tmux.capturePaneById(paneId, { ansi: false, scrollback: 0 });
    const staticBusy = hasOscTitleWorking(preTitle)
      ? (runtimeBusyCheck(preFrame, runtime) || !hasRuntimeReadyView(preFrame, runtime))
      : runtimeBusyCheck(preFrame, runtime);
    if (staticBusy && await this.paneHasLiveTurn(tmux, paneId, runtime)) {
      throw new Error(`pre-inject busy check: pane ${paneId} is still running a turn; dispatch aborted`);
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
          await tmux.clearComposerDraft(paneId);
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
            await tmux.clearComposerDraft(paneId);
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
      await tmux.clearComposerDraft(paneId);
      await revalidate?.();
      await tmux.injectPrompt(paneId, prompt, agentId);
    }
    let baseline: string;
    let baselineTitle = '';
    try {
      baseline = await tmux.captureSettledSnapshot(paneId, { timeoutMs: this.dispatchSettleTimeoutMs });
      baselineTitle = await tmux.readPaneTitle(paneId);
      if (guardBeforePaste) {
        // The Enter is the actual submission; it takes the same fenced queue slot.
        const submitted = await this.withTaskLock(async () => {
          if (!(await guardBeforePaste())) return false;
          await tmux.sendEnter(paneId);
          return true;
        });
        if (!submitted) {
          try {
            await tmux.clearComposerDraft(paneId);
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
        await tmux.sendEnter(paneId);
      }
    } catch (preAckErr) {
      if (await this.clearComposerForReuse(tmux, paneId, agentId)) throw preAckErr;
      const message = preAckErr instanceof Error ? preAckErr.message : String(preAckErr);
      throw new DispatchTerminalError(
        'ack_unknown',
        `pre-ack failure left an unconfirmed composer on live pane ${paneId}: ${message}`,
      );
    }
    let staleDuringResend = false;
    try {
      await tmux.waitSubmitAck(paneId, baseline, runtime, {
        timeoutMs: this.dispatchAckTimeoutMs,
        baselineTitle,
        resend: guardBeforePaste
          ? async () => {
            // A resend is a fresh submission of whatever sits in the composer; it takes the same fence.
            const resent = await this.withTaskLock(async () => {
              if (!(await guardBeforePaste())) return false;
              await tmux.sendEnter(paneId);
              return true;
            });
            if (!resent) staleDuringResend = true;
          }
          : () => tmux.sendEnter(paneId),
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
          await tmux.clearComposerDraft(paneId);
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
    opts: {
      allowAwaitingHuman?: boolean;
      clearAwaitingHuman?: boolean;
      expectedTask?: Pick<TaskState, 'status' | 'phase' | 'signalToken'>;
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
    const { paneId } = ensure;

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
      prompt = buildPromptInline({
        task,
        phase,
        agent,
        workdir: verifiedWorkdir,
        skillRegistry: this.skillRegistry,
        hasQaPartner: task.qaAgentId !== undefined,
        ...(signalToken ? { signalToken } : {}),
        ...(useIncrementalNudge
          ? { postApproveRedispatchCount: opts.postApproveRedispatchCount }
          : {}),
        ...(promptSpecRound !== undefined ? { currentSpecRound: promptSpecRound } : {}),
        ...(imagePaths.length ? { imagePaths } : {}),
        ...(opts.serverBatch ? { serverBatch: opts.serverBatch } : {}),
        ...(opts.serverAfterDone ? { serverAfterDone: opts.serverAfterDone } : {}),
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
        && completionFresh.approvedHeadSha === taskFresh.postApproveHeadSha;
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
      // The continuation prompt supersedes any question asked under the previous one.
      const { needInputAt: _needInputAt, ...rest } = latest;
      return {
        ...rest,
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
      tmux, paneId, prompt, agentId, agent.runtime, guardBeforeInject,
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
    // 'git' outbox 重投先行：崩溃于「效果已写、通知未达」的窗口由此闭合（spec §6），legacy 任务零涉
    await this.flushGitOutbox().catch(err => {
      console.warn('[AgentManager] recover: git outbox flush failed:', err);
    });
    await this.retryGitRemoteBranchCleanup().catch(err => {
      console.warn('[AgentManager] recover: git remote branch cleanup retry failed:', err);
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
      const task = await this.taskStore.get(taskId);
      if (!task) throw new ApiError(404, 'Task not found');

      if (this.markCompleteInFlight.has(taskId)) {
        throw new ApiError(409, `Task ${taskId} is being completed (merge in progress); try again shortly`);
      }

      // 终态不早退：状态不再改写，但残留的 pane/绑定（上次清理中途失败）仍走同一条强制清理路径。
      // 唯一例外：清理已在进行中的重复取消——重跑只会重复中断同一批 pane，等它收尾即可。
      const alreadyTerminal = TERMINAL_STATUSES.includes(task.status);
      if (alreadyTerminal && this.cancelCleanupInFlight.has(taskId)) return task;

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
      } else if (!alreadyTerminal && task.reviewMode !== 'server' && task.prNumber !== undefined && task.branch) {
        // GitHub 模式取消时只关闭开放 PR；远程分支归用户所有，baxian 不自动删除。
        // server 模式仍只信 gate+marker——非 gate 状态上的孤立 prNumber 不足以证明远端有待回收的工件
        publishedCleanup = {
          afterDone: 'pr',
          branch: task.branch,
          prNumber: task.prNumber,
          ...(task.agentId ? { devAgentId: task.agentId } : {}),
          mayBeInFlight: false,
        };
      }

      for (const id of [devToRelease, qaToRelease]) {
        if (id) await this.markPaneCancelClearing(id, taskId);
      }

      if (!alreadyTerminal) {
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
      const project = this.getProjectConfig(result.projectId);
      try {
        if (project && result.reviewMode === 'git') {
          // close 不附评论（spec §10 有意差异）；deleteBranch 由 isAutoDeletableTaskBranch 守卫
          await this.platformClosePr(taskId, { deleteBranch: true });
        } else if (project) {
          const close = await execNetwork(
            this.platformRunner,
            `gh pr close ${publishedCleanup.prNumber} --repo ${shellQuote(repoSlug(project.repo))} ` +
            `--comment ${shellQuote('Task cancelled in baxian; closing the published PR.')}`,
            GH_NET,
          );
          if (close.exitCode !== 0) throw new Error(close.stderr.trim() || close.stdout.trim());
        }
      } catch (err) {
        console.warn(`[AgentManager] cancelTask remote retirement failed for ${taskId}:`, err);
        if (result.reviewMode === 'git') {
          await this.withTaskLock(async () => {
            const fresh = await this.taskStore.get(taskId);
            if (!fresh) return;
            await this.taskStore.set({
              ...fresh,
              branchCleanupPending: {
                agentId: fresh.devAgentId,
                reason: err instanceof PlatformCloseError && err.step === 'close'
                  ? 'remote-close-failed'
                  : 'remote-delete-failed',
                updatedAt: new Date().toISOString(),
              },
              updatedAt: new Date().toISOString(),
            });
          }).catch(persistErr => {
            console.warn(`[AgentManager] cancelTask cleanup marker persist failed for ${taskId}:`, persistErr);
          });
        }
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

  async dispatchReviewToQa(
    taskId: string,
    opts: { fromStatus?: TaskStatus[]; bumpRound?: boolean; expectSignalToken?: string } = {},
  ): Promise<TaskState> {
    const claim = await this.withTaskLock(async () => {
      if (this.manualReviewInFlight.has(taskId)) {
        throw new ApiError(409, `Manual review already in progress for task ${taskId}`);
      }
      if (this.markCompleteInFlight.has(taskId)) {
        throw new ApiError(409, `Task ${taskId} is being completed (merge in progress); try again shortly`);
      }
      const task = await this.taskStore.get(taskId);
      if (!task) throw new ApiError(404, `Task ${taskId} not found`);
      if (opts.fromStatus && !opts.fromStatus.includes(task.status)) {
        throw new ApiError(
          409,
          `Task ${taskId} status is ${task.status}; review dispatch requires ${opts.fromStatus.join('/')}`,
        );
      }
      if (opts.expectSignalToken !== undefined && task.signalToken !== opts.expectSignalToken) {
        throw new ApiError(
          409,
          `Task ${taskId} review pass changed during redispatch (signalToken rotated); aborting`,
        );
      }
      if (task.reviewMode === 'server' || isSpecStagePhase(task.phase)) {
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
        // 手工发起=明确要求跑一次 QA 评审；无 QA 时必须拒绝，不得落入自动通过/停驻兜底
        const qaAvailable = task.qaAgentId !== undefined
          && this.getAgentConfig(task.qaAgentId)?.role === 'qa';
        if (!qaAvailable) {
          throw new ApiError(400, `Task ${taskId} has no QA partner configured; manual review requires a QA agent`);
        }
        const isSpec = isSpecStagePhase(task.phase);
        const cap = this.config.review.rounds + (task.maxRoundsContinues ?? 0);
        const round = isSpec ? (task.specReviewRound ?? 0) : task.reviewRound;
        if (round + 1 > cap) {
          throw new ApiError(409, `Task ${taskId} reached the review round cap (${cap}); continue or cancel it instead`);
        }
        this.manualReviewInFlight.add(taskId);
        return { mode: 'server' as const, isSpec, claimToken: task.signalToken };
      }
      if (!task.prNumber) {
        throw new ApiError(400, `Task ${taskId} has no PR yet; cannot dispatch review`);
      }
      if (!task.branch) {
        throw new ApiError(400, `Task ${taskId} has no branch; cannot dispatch review`);
      }
      const qaId = task.qaAgentId;
      if (!qaId) {
        throw new ApiError(400, `Task ${taskId} has no QA participant; cannot dispatch review`);
      }
      if (this.getAgentConfig(qaId)?.role !== 'qa') {
        throw new ApiError(409, `Task ${taskId} QA participant ${qaId} is unavailable`);
      }
      this.manualReviewInFlight.add(taskId);
      return { mode: 'github' as const, qaId, devAgentId: task.agentId, taskStatusAtClaim: task.status };
    });

    if (claim.mode === 'server') {
      return this.runManualServerReview(taskId, claim);
    }

    try {
      const { qaId, devAgentId, taskStatusAtClaim } = claim;
      const isTerminal = TERMINAL_STATUSES.includes(taskStatusAtClaim);
      const qaPhase: 'review' | 'recheck' =
        taskStatusAtClaim === 'pending' || taskStatusAtClaim === 'in_progress'
          ? 'review'
          : 'recheck';

      const prevQa = await this.agentStore.get(qaId);
      const resumingHeldDispatch = prevQa?.taskId === taskId && prevQa.status === 'awaiting_human';
      if (prevQa?.taskId === taskId) {
        if (prevQa.status === 'awaiting_human' && !isRecoverableQaDispatchHold(prevQa)) {
          throw new ApiError(
            409,
            `QA agent ${qaId} is awaiting human (${prevQa.awaitingPhase ?? 'unknown phase'}); resolve that hold before redispatching review`,
          );
        }
        const released = await this.releaseAgentIfBound(
          qaId,
          taskId,
          prevQa.status === 'awaiting_human'
            ? {
                allowAwaitingHuman: true,
                expectedHold: {
                  phase: prevQa.awaitingPhase,
                  since: prevQa.awaitingSince,
                  nonce: prevQa.awaitingNonce,
                },
              }
            : undefined,
        );
        if (!released) {
          const after = await this.agentStore.get(qaId);
          const holdNote = after?.status === 'awaiting_human'
            ? ` (awaiting_human: ${after.awaitingPhase ?? 'unknown phase'})`
            : '';
          throw new ApiError(
            409,
            `QA agent ${qaId} could not be released from task ${taskId}${holdNote}; review dispatch aborted`,
          );
        }
      }

      const acquired = await this.acquireAgentForTask(qaId, taskId, qaPhase);
      if (!acquired) {
        throw new ApiError(409, `QA agent ${qaId} is busy or unavailable`);
      }
      const acquiredClaim = await this.lockManager.claimOf(qaId);
      const acquiredLockToken = acquiredClaim?.taskId === taskId ? acquiredClaim.token : undefined;
      const releaseOwnAcquire = acquiredLockToken !== undefined
        ? { expectedLockToken: acquiredLockToken }
        : {};

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
            await this.releaseAgentForTask(qaId, taskId, 'idle', releaseOwnAcquire)
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
        passToken: pre?.passToken,
        failToken: pre?.failToken,
      };

      const isTerminalAtClaim = TERMINAL_STATUSES.includes(taskStatusAtClaim);
      // 仅当恢复的是任务当前 review pass 时沿用轮次；任务已离开 review 的手工调用是新 pass，保留加轮
      const bumpRound = opts.bumpRound !== false && !(resumingHeldDispatch && taskStatusAtClaim === 'review');
      // 回滚在锁内判定 pass 是否已被并发接管并返回；仅未被接管时才释放本次 acquire 的 QA，
      // 否则会误清接管方 re-acquire 的同一 QA 绑定（同 task 同 agent，绕过 release 的 mismatch 保护）
      const abortDispatch = async (dispatchToken: string | undefined): Promise<void> => {
        const takenOver = await this.rollbackDispatchReviewPhase1(
          taskId, taskStatusAtClaim, isTerminalAtClaim, snapshot, bumpRound, dispatchToken,
        );
        if (!takenOver) await this.releaseAgentForTask(qaId, taskId, 'idle').catch(() => undefined);
        if (devParked) await this.emitManualReviewDevParkedQaFailedIntervention(devAgentId, taskId);
      };

      let transitionToken: string | undefined;
      let reviewAnchor: string | undefined;
      if (!isTerminalAtClaim) {
        let gitDispatchBlocked: string | undefined;
        const anchorViaDriver = async (): Promise<string | undefined> => {
          const preTask = await this.taskStore.get(taskId);
          if (preTask?.prNumber === undefined) {
            gitDispatchBlocked = 'no bound PR';
            return undefined;
          }
          // 与收编/pr-fixed/merge 同一完整谓词：closed/draft/retarget 的 PR 派出去只会造出
          // 不可裁决的评审轮（spec §6 统一谓词）
          const verify = await this.platformVerifyPrBinding(taskId, preTask.prNumber);
          if (!verify.ok) {
            gitDispatchBlocked = `binding ${verify.reason}`;
            return undefined;
          }
          return PLATFORM_HEAD_SHA_RE.test(verify.headSha) ? verify.headSha : undefined;
        };
        const isGitDispatch = (await this.taskStore.get(taskId))?.reviewMode === 'git';
        reviewAnchor = await (isGitDispatch ? anchorViaDriver() : this.fetchPrHeadSha(taskId))
          .catch(() => undefined);
        if (isGitDispatch && reviewAnchor === undefined) {
          // 无锚评审轮不可裁决（verdictEligible 要求 anchorSha 且 pane verdict 已退役）：
          // 派出去只会卡死在 review，fail loud 让调用方看到确定性原因或重试瞬态失败
          const released = await this.releaseAgentForTask(qaId, taskId, 'idle').catch(() => false);
          if (!released) {
            // 预检失败叠加释放失败：QA 仍绑定会让下一次派发报 busy，必须显式暴露
            const blockedTask = await this.taskStore.get(taskId);
            await this.emitIntervention(blockedTask?.projectId ?? '', qaId, taskId, {
              phase: 'qa-release-failed-after-precheck',
              qaAgentId: qaId,
            }).catch(() => undefined);
          }
          if (devParked) await this.emitManualReviewDevParkedQaFailedIntervention(devAgentId, taskId);
          throw gitDispatchBlocked !== undefined
            ? new ApiError(409, `Cannot dispatch git review for ${taskId}: ${gitDispatchBlocked}`)
            : new ApiError(502, `Cannot anchor the review round for ${taskId}: platform prView failed`);
        }
        const preDispatched = await this.transitionTaskStatus(
          taskId,
          'review',
          {
            fromStatus: [taskStatusAtClaim],
            // 入口 claim 到此处之间 pass 可能被并发轮换；expect token 必须与写入同一原子段复核
            ...(opts.expectSignalToken !== undefined ? { expectSignalToken: opts.expectSignalToken } : {}),
          },
          {
            reviewHeadAnchorSha: reviewAnchor,
            reviewDispatchedAt: new Date().toISOString(),
            signalToken: createSignalToken(),
            // pair/pending 与新轮锚点同一原子写可见（spec §7）：两写之间崩溃不得留下无 pending 的新轮
            ...(isGitDispatch ? { ...this.mintReviewTokenPair(), reviewDispatchPending: true } : {}),
          },
        );
        if (!preDispatched) {
          // fence 拒绝可能源于 successor 已换代并 re-acquire 同一 QA；释放必须钉在本次 acquire 的锁代上
          await this.releaseAgentForTask(qaId, taskId, 'idle', releaseOwnAcquire).catch(() => undefined);
          if (devParked) await this.emitManualReviewDevParkedQaFailedIntervention(devAgentId, taskId);
          throw new ApiError(409, `Task ${taskId} status changed during dispatch; cannot enter review`);
        }
        transitionToken = preDispatched.task.signalToken;
      }

      const armedToken = createSignalToken();
      // 合并锁段：复核本代 pass 未被并发接管（仍在 review 且持有 transition 写入的 token）
      // 与写 qaAgentId + 轮换 token 原子完成。withTaskLock 全局串行，接管方的 rotate 无法插在复核与写入之间
      const claim2 = await this.withTaskLock(async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
        const fresh = await this.taskStore.get(taskId);
        if (!fresh) return { ok: false, reason: 'gone' };
        if (!isTerminalAtClaim && (fresh.status !== 'review' || fresh.signalToken !== transitionToken)) {
          return { ok: false, reason: fresh.status !== 'review' ? `status=${fresh.status}` : 'pass superseded' };
        }
        // 并发 push 在 prView 读取与本提交之间前进 head 时，本次手动锚点已陈旧（TOCTOU）
        if (fresh.reviewMode === 'git' && fresh.latestHeadSha !== undefined
          && reviewAnchor !== undefined && fresh.latestHeadSha !== reviewAnchor) {
          return { ok: false, reason: 'head advanced past the manual anchor' };
        }
        await this.taskStore.set({
          ...fresh,
          reviewRound: bumpRound ? fresh.reviewRound + 1 : fresh.reviewRound,
          signalToken: armedToken,
          ...(fresh.reviewMode === 'git' ? { reviewDispatchPending: true } : {}),
          updatedAt: new Date().toISOString(),
        });
        return { ok: true };
      });
      if (!claim2.ok) {
        // 未写入 armedToken：task 仍持 transitionToken，或已被接管方 rotate/漂移 → 用 transitionToken 判 takeover
        await abortDispatch(transitionToken);
        throw new ApiError(409, `Task ${taskId} left its review pass during dispatch (${claim2.reason})`);
      }

      const dispatchTaskAfterClaim = await this.taskStore.get(taskId);
      const armed = await this.setupPhaseSignalWatcher(
        taskId, qaId, ['pr-approved', 'pr-changes-requested'] as const, armedToken,
        dispatchTaskAfterClaim?.reviewMode === 'git' ? { replaceScope: 'agent' } : {},
      );
      if (armed && dispatchTaskAfterClaim?.reviewMode === 'git') {
        await this.rearmGitReconciliationWatcher(taskId);
      }
      if (!armed) {
        await abortDispatch(armedToken);
        throw new ApiError(500, `Failed to arm review verdict watcher for ${taskId}`);
      }

      if (opts.fromStatus) {
        // arm 到 startSession 之间的漂移复核：status 漂移或 token 被插队 rotate 都放弃本次派发
        const preStart = await this.taskStore.get(taskId);
        if (!preStart || !opts.fromStatus.includes(preStart.status) || preStart.signalToken !== armedToken) {
          await abortDispatch(armedToken);
          throw new ApiError(
            409,
            `Task ${taskId} left ${opts.fromStatus.join('/')} during dispatch (now ${preStart?.status ?? 'gone'})`,
          );
        }
      }

      let started = false;
      try {
        started = await this.startSession(taskId, qaId, qaPhase, {
          bypassTaskStatusGate: true,
          dialogFailFromStatuses: [isTerminalAtClaim ? taskStatusAtClaim : 'review'],
        });
      } catch (err) {
        if (err instanceof DispatchTerminalError && err.reason === 'ack_unknown') {
          // prompt 可能已注入：不回滚 armed pass、不释放 QA；hold 持久化失败也不得吞掉 ack_unknown 分类
          try {
            await this.markAwaitingIfAckUnknown(qaId, err, taskId);
          } catch (holdErr) {
            console.error(
              `[AgentManager] dispatchReviewToQa could not persist the ack_unknown hold for ${qaId}:`,
              holdErr,
            );
          }
          throw err;
        }
        if (!(err instanceof EnsureSessionError && err.partial.handled)) {
          await abortDispatch(armedToken);
        }
        throw err;
      }
      if (!started) {
        await abortDispatch(armedToken);
        throw new ApiError(500, `Failed to start QA review session for ${taskId}`);
      }
      await this.clearReviewDispatchPending(taskId, armedToken);

      const final = await this.taskStore.get(taskId);
      return final!;
    } finally {
      this.manualReviewInFlight.delete(taskId);
    }
  }

  private async runManualServerReview(
    taskId: string,
    claim: { isSpec: boolean; claimToken?: string },
  ): Promise<TaskState> {
    try {
      // 不在此处预释放旧 QA：可失败的准备工作（读 diff/spec、存轮次）失败时旧 pass 必须原样保留；
      // 同任务的 QA 重新绑定由 dispatchServerReviewToQa 在派发前完成
      const fresh = await this.taskStore.get(taskId);
      if (!fresh || fresh.signalToken !== claim.claimToken
        || !MANUAL_SERVER_REVIEW_STATUSES.includes(fresh.status)) {
        throw new ApiError(409, `Task ${taskId} changed during manual review dispatch; aborting`);
      }
      const dispatched = claim.isSpec
        ? await this.serverReviewDriver!.dispatchSpecReview(fresh)
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

  // 返回 qaTakenOverInReview：仍在 review 但 token 已换代 = 另一 dispatcher 已 release+acquire 同一 QA
  // （同 task 同 agent，releaseAgentForTask 的 mismatch 保护不设防），此时调用方不得再 release QA。
  // 判定在回滚同一锁段内基于 fresh 完成，是那一刻的权威结论——不受本函数随后恢复 snapshot token 的影响。
  private async rollbackDispatchReviewPhase1(
    taskId: string,
    originalStatus: TaskStatus,
    isTerminalAtClaim: boolean,
    snapshot: DispatchReviewSnapshot,
    roundBumped: boolean,
    dispatchToken?: string,
  ): Promise<boolean> {
    let qaTakenOverInReview = false;
    await this.withTaskLock(async () => {
      const fresh = await this.taskStore.get(taskId);
      if (!fresh) return;
      // only a concurrent cancel/fail into terminal drops the write; a terminal-at-claim recheck still restores snapshot fields
      if (!isTerminalAtClaim && TERMINAL_STATUSES.includes(fresh.status)) return;
      // transition 后的中间态恒为 review 且持有本次 dispatch 的 token；status 漂移（如 REQUEST_CHANGES→fixing）
      // 或 review 内 token 换代（push recheck 接管）都表示 pass 已归并发推进方所有，只撤本次 dispatch 的轮次残留
      const passTakenOver = dispatchToken !== undefined && fresh.signalToken !== dispatchToken;
      qaTakenOverInReview = !isTerminalAtClaim && fresh.status === 'review' && passTakenOver;
      const drifted = !isTerminalAtClaim && (fresh.status !== 'review' || passTakenOver);
      // 只在本次 dispatch 仍拥有该 pass（未 drift）且确实 bump 过时才撤回 +1；
      // drift 后 reviewRound 归接管方所有（它可能基于此再 bump），一律不减
      const rolledRound = (!drifted && roundBumped) ? Math.max(0, fresh.reviewRound - 1) : fresh.reviewRound;
      const next: TaskState = drifted
        ? { ...fresh, reviewRound: rolledRound, updatedAt: new Date().toISOString() }
        : {
          ...fresh,
          reviewRound: rolledRound,
          qaAgentId: snapshot.qaAgentId,
          signalToken: snapshot.signalToken,
          reviewDispatchedAt: snapshot.reviewDispatchedAt,
          // 本代新铸的 pair 从未交付 QA：不随快照恢复会让旧 QA 的在途 verdict 被拒、新 pair 无人知
          passToken: snapshot.passToken,
          failToken: snapshot.failToken,
          updatedAt: new Date().toISOString(),
        };
      if (!isTerminalAtClaim && !drifted) {
        next.status = originalStatus;
        next.reviewHeadAnchorSha = snapshot.reviewHeadAnchorSha;
      }
      await this.taskStore.set(next);
    });

    if (!this.phaseSignalWatcher) return qaTakenOverInReview;

    // a terminal task keeps no watcher: tear down one this dispatch armed before failing, then skip re-arming
    const afterRollback = await this.taskStore.get(taskId);
    if (afterRollback && TERMINAL_STATUSES.includes(afterRollback.status)) {
      this.phaseSignalWatcher.stop(taskId);
      return qaTakenOverInReview;
    }

    if (afterRollback?.status === 'approved') {
      const completion = afterRollback.reviewMode === 'git'
        ? this.gitCompletionOf(afterRollback)
        : await this.postApproveStore.get(taskId);
      const task = afterRollback;
      if (completion && task) {
        try {
          await this.startPhaseSignalWatch({
            taskId,
            projectId: task.projectId,
            agentId: task.agentId,
            expectedKinds: 'pr-merge-ready',
            token: completion.token,
          });
          await this.tearDownWatcherIfTaskTerminal(taskId);
        } catch (err) {
          console.warn(
            `[AgentManager] rollback: re-establish pr-merge-ready failed for task=${taskId}:`,
            err,
          );
        }
        return qaTakenOverInReview;
      }
    }

    const restored = await this.taskStore.get(taskId);
    if (!restored || !restored.signalToken) return qaTakenOverInReview;
    const mappings = this.mapTaskStateToExpectedWatchers(restored);
    if (mappings.length === 0) return qaTakenOverInReview;
    for (const mapped of mappings) {
      try {
        await this.startPhaseSignalWatch({
          taskId,
          projectId: restored.projectId,
          agentId: mapped.agentId,
          expectedKinds: mapped.expectedKinds,
          token: mapped.token ?? restored.signalToken,
          ...(mappings.length > 1 ? { replaceScope: 'agent' as const } : {}),
        });
      } catch (err) {
        console.warn(
          `[AgentManager] rollback: re-establish ${mapped.expectedKinds.join(',')} failed for task=${taskId}:`,
          err,
        );
      }
    }
    // 回滚路径不得因 tearDown 探测失败上抛：那会顶替调用方本应抛出的 ApiError 并跳过 QA 释放
    try {
      await this.tearDownWatcherIfTaskTerminal(taskId);
    } catch (err) {
      console.warn(`[AgentManager] rollback: terminal watcher teardown failed for task=${taskId}:`, err);
    }
    return qaTakenOverInReview;
  }

  // a cancel between our start() and the terminal write leaves a watcher on a dead task; re-check and drop it
  private async tearDownWatcherIfTaskTerminal(taskId: string): Promise<void> {
    const now = await this.taskStore.get(taskId);
    if (now && TERMINAL_STATUSES.includes(now.status)) {
      this.phaseSignalWatcher?.stop(taskId);
    }
  }

  private devInitialSignalKinds(reviewMode?: TaskState['reviewMode']): readonly PhaseSignalKind[] {
    const mode = reviewMode ?? this.config.review.mode ?? 'github';
    return mode === 'server'
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
    // review 窗口内 dev/QA 双条目并存：review 之外 dev 侧另有 pr-fixed/pr-merge-ready 同 agent
    // 期望，(taskId, agentId) 基数无法同 agent 双 token 并存——错过窗口按 fail-closed 交人工（spec §5.3 ④）
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
        expectedKinds: specStage ? ['spec-reviewed'] : ['pr-approved', 'pr-changes-requested'],
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

  private async emitManualReviewDevParkedQaFailedIntervention(
    agentId: string | undefined,
    expectedTaskId: string,
  ): Promise<void> {
    if (!agentId) return;
    const cur = await this.agentStore.get(agentId);
    if (!cur || cur.taskId !== expectedTaskId) return;
    await this.emitIntervention(cur.projectId, agentId, expectedTaskId, {
      phase: 'manual-review-dev-parked-qa-failed',
      note:
        'Manual QA dispatch parked the dev agent into waiting; QA then failed to start. ' +
        'Dev binding is kept but no new prompt is running — re-dispatch the manual review or cancel the task.',
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
    const project = this.getProjectConfig(task.projectId);
    if (!project) {
      throw new Error(`mergePr: unknown project ${task.projectId}`);
    }
    if (task.reviewMode === 'git') {
      const expectedHeadSha = opts.matchHeadSha ?? task.latestHeadSha;
      if (!expectedHeadSha) throw new Error(`mergePr: no expected head sha for git task ${taskId}`);
      // max_rounds 的 Mark complete 在调用前已被转成 merge-ready：override 必须显式随调用链传入
      await this.platformConfirmMerge(taskId, {
        expectedHeadSha,
        ...(opts.humanOverride === true || task.status === 'max_rounds' ? { humanOverride: true } : {}),
      });
      return;
    }
    const matchHead = opts.matchHeadSha
      ? ` --match-head-commit ${shellQuote(opts.matchHeadSha)}`
      : '';
    // A merge is not idempotent from the caller's view (user-triggered, retryable
    // in the UI), so it gets a timeout but no automatic retry.
    const result = await execNetwork(
      this.platformRunner,
      `gh pr merge ${task.prNumber} --repo ${shellQuote(repoSlug(project.repo))}${matchHead} --squash`,
      { retries: 0 },
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
        // 从 max_rounds 认领而来：人工兜底 override 必须显式随调用链传入（此刻 status 已是 merge-ready）
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
      const lockToken = await this.lockManager.acquire(agentId, ctx.taskId);
      if (!lockToken) return;
      await this.agentStore.update(agentId, (existing) => {
        if (!existing) return AGENT_STORE_NOOP;
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
      });
      const fresh = await this.agentStore.get(agentId);
      if (fresh?.taskId !== ctx.taskId || fresh.lockToken !== lockToken) {
        await this.lockManager.releaseIfOwner(agentId, ctx.taskId, lockToken);
        return;
      }
    }

    const runner = this.createRunnerFor(agent);
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
      cleared = await this.sendPostMergeSlashCommand(tmux, paneId, agentId, runtime, bindingStillOurs);
    } catch (err) {
      clearError = err;
    }
    if (!cleared) {
      if (await this.recoverPostMergeExitedRuntime(
        tmux,
        paneId,
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
          await this.waitForReplPromptReady(tmux, paneId, runtime, this.compactIdleWaitMs);
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
    paneId: string,
    agentId: string,
    taskId: string,
    lockToken: string,
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
    if (
      !state
      || state.taskId !== taskId
      || state.lockToken !== lockToken
      || state.paneId !== paneId
      || !(await this.lockManager.isOwner(agentId, taskId, lockToken))
    ) return false;
    try {
      if (paneExists) await tmux.sendKeysToPane(paneId, 'C-c');
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
      titleIdleFastPath: true,
    });
    await new Promise(r => setTimeout(r, this.compactIdlePollMs));
    while (true) {
      const current = await tmux.displayMessage(paneId, '#{pane_current_command}');
      if (!hasReplProcTitle(current, runtime)) {
        throw new Error(`waitForReplPromptReady: pane ${paneId} pane_current_command=${current.trim()} (not runtime, REPL may have exited)`);
      }
      const cap = await tmux.capturePaneById(paneId, { ansi: false, scrollback: 0 });
      const ready = hasRuntimeReadyView(cap, runtime)
        || (screenAllowsTitleIdle(cap, runtime) && hasOscTitleIdle(await tmux.readPaneTitle(paneId), runtime));
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
    opts: {
      skipSnapshot?: boolean;
      onReadFile?: (req: ReadFileSignal) => void;
      onlyReplaceOwnToken?: boolean;
      replaceScope?: 'task' | 'agent';
    } = {},
  ): Promise<boolean> {
    if (!this.phaseSignalWatcher) return true;
    const task = await this.taskStore.get(taskId);
    if (!task) return false;
    try {
      return await this.startPhaseSignalWatch({
        taskId,
        projectId: task.projectId,
        agentId,
        expectedKinds,
        token,
        skipSnapshot: opts.skipSnapshot ?? false,
        ...(opts.onlyReplaceOwnToken ? { onlyReplaceOwnToken: true } : {}),
        ...(opts.replaceScope ? { replaceScope: opts.replaceScope } : {}),
        ...(opts.onReadFile ? { onReadFile: opts.onReadFile } : {}),
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

  // git 任务的初始 dev 派发把 pr-created 期望 token 独立持久化：评审轮轮换不得使 late
  // publish 信号失去 reconciliation 凭据（spec §5.3 ④）。
  dispatchTokenFields(task: TaskState, signalToken: string): Partial<TaskState> {
    const wantsPrCreated = task.reviewMode === 'git'
      && this.devInitialSignalKinds(task.reviewMode).includes('pr-created');
    return { signalToken, ...(wantsPrCreated ? { pendingPrSignalToken: signalToken } : {}) };
  }

  // review 窗口内 QA verdict arm 之后重建 dev reconciliation 条目（spec §5.3 ④）：approval 路径的
  // stop(taskId) 与 fix 轮的同键替换都会拆掉它，重入 review 时在此恢复；skipSnapshot=false 让仍在
  // 面板滚动区的迟到信号立即重放。
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
  ): Promise<{ token: string; armed: boolean }> {
    const newToken = createSignalToken();
    const task = await this.taskStore.get(taskId);
    const kinds = typeof expectedKinds === 'string' ? [expectedKinds] : [...expectedKinds];
    const isGit = task?.reviewMode === 'git';
    // pair 的重铸已随「进入 review 的 transition」单写落盘（spec §7 与新轮可见性原子）；
    // 这里只轮换 signal token 并布防
    await this.updateTask(taskId, { signalToken: newToken });
    const armed = await this.setupPhaseSignalWatcher(taskId, agentId, expectedKinds, newToken,
      isGit ? { replaceScope: 'agent' } : {});
    if (armed && isGit && kinds.includes('pr-approved')) await this.rearmGitReconciliationWatcher(taskId);
    return { token: newToken, armed };
  }

  async rollbackVerdictArmFailure(
    taskId: string,
    restore: {
      status: TaskStatus; signalToken?: string; reviewHeadAnchorSha?: string; reviewDispatchedAt?: string;
      passToken?: string; failToken?: string; restorePair?: boolean;
    },
    opts: { expect?: { status: TaskStatus; signalToken?: string }; rearmSkipSnapshot?: boolean } = {},
  ): Promise<boolean> {
    const expected = opts.expect;
    const rolledBack = await this.withTaskLock(async () => {
      const fresh = await this.taskStore.get(taskId);
      if (!fresh) return false;
      if (TERMINAL_STATUSES.includes(fresh.status)) return false;
      // pass 已被并发接管（token 轮换或状态推进）时禁止回滚，否则会覆盖接管方刚写入的新 pass
      if (expected && (fresh.status !== expected.status || fresh.signalToken !== expected.signalToken)) return false;
      await this.taskStore.set({
        ...fresh,
        status: restore.status,
        signalToken: restore.signalToken,
        reviewHeadAnchorSha: restore.reviewHeadAnchorSha,
        reviewDispatchedAt: restore.reviewDispatchedAt,
        ...(restore.restorePair === true
          ? { passToken: restore.passToken, failToken: restore.failToken }
          : {}),
        updatedAt: new Date().toISOString(),
      });
      return true;
    });
    if (!rolledBack) return false;
    await this.rearmPhaseSignalForCurrentPass(taskId, { skipSnapshot: opts.rearmSkipSnapshot });
    return true;
  }

  async rearmPhaseSignalForCurrentPass(taskId: string, opts: { skipSnapshot?: boolean } = {}): Promise<void> {
    if (!this.phaseSignalWatcher) return;
    const task = await this.taskStore.get(taskId);
    if (!task?.signalToken) return;
    if (TERMINAL_STATUSES.includes(task.status)) return;
    const mappings = this.mapTaskStateToExpectedWatchers(task);
    if (mappings.length === 0) return;
    for (const mapped of mappings) {
      await this.setupPhaseSignal(taskId, mapped.agentId, mapped.expectedKinds, {
        ...(opts.skipSnapshot ? { skipSnapshot: true } : {}),
        ...(mappings.length > 1 ? { replaceScope: 'agent' as const } : {}),
        ...(mapped.token !== undefined ? { tokenOverride: mapped.token } : {}),
      });
    }
    await this.tearDownWatcherIfTaskTerminal(taskId);
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
      content: string;
      interdiff?: string;
      diffstat?: string;
      baseSha?: string;
      headTree?: string;
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
      const qaId = task.qaAgentId;
      if (!qaId) {
        const entryKind: PhaseSignalKind = task.status === 'fixing'
          ? (opts.phase === 'spec' ? 'spec-fixed' : 'code-fixed')
          : (opts.phase === 'spec' ? 'spec-done' : 'code-done');
        await this.setupPhaseSignal(taskId, task.agentId, entryKind, { skipSnapshot: true });
        await this.emitIntervention(task.projectId, task.agentId, taskId, { phase: 'server-review-no-qa-partner', devAgentId: task.agentId });
        return null;
      }
      if (this.getAgentConfig(qaId)?.role !== 'qa') {
        const entryKind: PhaseSignalKind = task.status === 'fixing'
          ? (opts.phase === 'spec' ? 'spec-fixed' : 'code-fixed')
          : (opts.phase === 'spec' ? 'spec-done' : 'code-done');
        await this.setupPhaseSignal(taskId, task.agentId, entryKind, { skipSnapshot: true });
        await this.emitIntervention(task.projectId, task.agentId, taskId, {
          phase: 'server-review-qa-unavailable',
          qaAgentId: qaId,
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
      // 从 review 重派（手工发起）：入口信号早已被消费，dev 停驻等待中，无可重挂
      if (claim.originalStatus === 'review') return;
      const entryKind: PhaseSignalKind = claim.originalStatus === 'fixing'
        ? (opts.phase === 'spec' ? 'spec-fixed' : 'code-fixed')
        : (opts.phase === 'spec' ? 'spec-done' : 'code-done');
      await this.setupPhaseSignal(taskId, devAgentId, entryKind, { skipSnapshot: true });
    };

    if (!opts.continuation) {
      const prevQa = await this.agentStore.get(qaId);
      if (prevQa?.taskId === taskId) {
        // 手工重派：上一 pass 的 QA 仍绑定本任务，先释放再重新 acquire（与 github 手工路径一致）
        await this.releaseAgentForTask(qaId, taskId, 'idle');
      }
      const acquired = await this.acquireAgentForTask(qaId, taskId, dispatchPhase);
      if (!acquired) {
        await rearmEntrySignal();
        await this.emitIntervention(projectId, qaId, taskId, { phase: 'server-review-qa-acquire-failed', qaAgentId: qaId });
        return null;
      }
      if (devAgentId) {
        const devOk = await this.markAgentWaiting(devAgentId, taskId);
        if (!devOk) {
          await this.releaseAgentForTask(qaId, taskId, 'idle').catch(() => undefined);
          await rearmEntrySignal();
          await this.emitIntervention(projectId, devAgentId, taskId, { phase: 'server-review-dev-park-failed', devAgentId });
          return null;
        }
      }
    } else {
      const qaState = await this.agentStore.get(qaId);
      if (qaState?.taskId !== taskId) {
        await this.setupPhaseSignal(taskId, qaId, expectedKind, { skipSnapshot: true });
        await this.emitIntervention(projectId, qaId, taskId, { phase: 'server-review-continuation-qa-not-bound', qaAgentId: qaId });
        return null;
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
        await this.releaseAgentForTask(qaId, taskId, 'idle').catch(() => undefined);
      }
      await this.emitIntervention(projectId, qaId, taskId, { phase: 'server-review-transition-failed', qaAgentId: qaId });
      return null;
    }

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
          ...(allowReadFile
            ? { onReadFile: (req: ReadFileSignal) => { void this.handleReadFileRequest(taskId, qaId, req); } }
            : {}),
        });
      },
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
      await this.emitIntervention(projectId, qaId, taskId, { phase: 'server-review-start-failed', qaAgentId: qaId });
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

  async dispatchServerFixToDev(taskId: string, findingsJson: string): Promise<TaskState | null> {
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
      await this.emitIntervention(projectId, devAgentId, taskId, { phase: 'server-fix-dev-acquire-failed', devAgentId });
      return null;
    }

    if (qaAgentId) {
      const released = await this.releaseAgentIfBound(qaAgentId, taskId)
        .catch(() => false);
      if (!released) {
        await releaseFreshAcquire();
        await rearmReviewedSignal();
        await this.emitIntervention(projectId, qaAgentId, taskId, { phase: 'server-fix-qa-release-failed', qaAgentId });
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
      await this.emitIntervention(projectId, devAgentId, taskId, { phase: 'server-fix-transition-failed', devAgentId });
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
      await this.emitIntervention(projectId, devAgentId, taskId, { phase: 'server-fix-resume-failed', devAgentId });
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
        `${GIT_NET_ENV} git -C ${shellQuote(workdir)} fetch origin --quiet`,
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
        // 复核类失效（provenance 撤销/未 ack 反馈）没有「再 Confirm」的出路：退回 approved 置
        // durable pending 重入 post-approve 闭环（计划 Task 8），把失效授权留在 gate 只剩 Cancel
        const retreated = await this.withTaskLock(async () => {
          const fresh = await this.taskStore.get(task.id);
          if (!fresh || fresh.status !== 'merge-ready') return false;
          const approvedHead = typeof fresh.latestHeadSha === 'string' && PLATFORM_HEAD_SHA_RE.test(fresh.latestHeadSha)
            ? fresh.latestHeadSha
            : undefined;
          if (approvedHead === undefined) return false;
          await this.taskStore.set({
            ...fresh,
            status: 'approved',
            postApproveHeadSha: approvedHead,
            pendingRedispatch: true,
            updatedAt: new Date().toISOString(),
          });
          return true;
        });
        await this.emitIntervention(task.projectId, undefined, task.id, {
          phase: 'confirm-merge-recheck-failed',
          gate: task.status,
          error: message,
          retreated,
          note: retreated
            ? 'Accepted pass no longer verifies; task returned to approved for the post-approve loop to re-settle.'
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
    if (!state.paneId || state.status === 'awaiting_human' || state.creationToken) return false;
    const cfg = this.getAgentConfig(agentId);
    if (!cfg) return false;
    const tmux = new TmuxManager(this.createRunnerFor(cfg));
    void this.runPostMergeCompaction(tmux, state.paneId, agentId, taskId, agentRuntimeKindFor(cfg))
      .catch(err =>
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
      const cd = `cd ${shellQuote(workdir)} && `;
      const db = await runner.exec(`${cd}git symbolic-ref --short refs/remotes/origin/HEAD`);
      const defaultBranch = db.stdout.trim().replace(/^origin\//, '');
      if (db.exitCode !== 0 || defaultBranch === '') {
        throw new Error(`ffMergeBranch: cannot resolve default branch: ${db.stderr.trim() || 'empty origin/HEAD'}`);
      }
      const fetch = await execNetwork(runner, `${cd}${GIT_NET_ENV} git fetch origin`);
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
        `${cd}${GIT_NET_ENV} git push origin ${shellQuote(`origin/${branch}`)}:${shellQuote(defaultBranch)}`,
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
