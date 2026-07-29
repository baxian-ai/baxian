export type AgentRuntime = 'claude-code' | 'codex' | 'opencode' | 'qodercli';
export type AgentRole = 'dev' | 'qa';
export type AgentMode = 'local' | 'remote';
export type MergeStrategy = 'auto' | null;
export type SpecApprovalStrategy = 'human' | null;
type SupportedLanguage = 'zh-CN' | 'en-US';

export interface HostConfig {
  id?: string;
  hostname: string;
  port?: number;
  alias?: string;
  user?: string;
  password?: string;
}

export interface AgentRuntimeConfig {
  id: string;
  runtime: AgentRuntime;
  mode: AgentMode;
  host?: string | HostConfig;
  workdir?: string;
  yolo?: boolean;
  model?: string;
  addDirs?: string[];
}

export interface AgentConfig extends AgentRuntimeConfig {
  role: AgentRole;
}

export interface ProjectConfig {
  id: string;
  repo: string;
  merge: MergeStrategy;
  specApproval?: SpecApprovalStrategy;
  gitCli?: GitCliConfig;
  agent: AgentConfig[][];
}

export interface GitCliConfig {
  tool: string;
  binary?: string;
  notes?: string;
}

interface ReviewConfig {
  rounds: number;
}

export interface HttpsConfig {
  keyFile: string;
  certFile: string;
}

export interface ServerConfig {
  port: number;
  host: string;
  token?: string;
  https?: HttpsConfig;
  allowedHosts?: string[];
  githubPollIntervalMs: number;
  tmuxProbePollIntervalMs: number;
  tmuxProbeTimeoutMs: number;
  tmuxProbeConcurrency: number;
  bootstrapRetryIntervalMs: number;
  dispatchReconcileIntervalMs: number;
  dispatchBusyWaitBudgetMs: number;
  dispatchReconcileMaxAttempts: number;
}

export interface BaxianConfig {
  language?: SupportedLanguage;
  review: ReviewConfig;
  server: ServerConfig;
  host: HostConfig[];
  project: ProjectConfig[];
}

export type AgentRuntimeStatus =
  | 'unknown'
  | 'idle'
  | 'pending'
  | 'working'
  | 'waiting'
  | 'error';

export type TmuxSessionStatus =
  | 'unknown'
  | 'present'
  | 'absent'
  | 'unreachable';

export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'review'
  | 'fixing'
  | 'spec-ready'
  | 'approved'
  | 'merge-ready'
  | 'merged'
  | 'done'
  | 'max_rounds'
  | 'failed'
  | 'cancelled';

export type TaskPhase = 'spec' | 'code';
export function isSpecStagePhase(phase: TaskPhase | undefined): boolean {
  return phase === 'spec';
}

export function taskReviewRound(
  task: Pick<TaskState, 'phase' | 'reviewRound' | 'specReviewRound'>,
): number {
  return task.phase === 'spec' ? (task.specReviewRound ?? 0) : task.reviewRound;
}

export function effectiveTaskReviewRound(
  task: Pick<TaskState, 'phase' | 'reviewRound' | 'reviewRoundPending' | 'specReviewRound'>,
): number {
  return Math.max(1, taskReviewRound(task) + (task.reviewRoundPending === true ? 1 : 0));
}

type AgentLifecycleStatus = 'ok' | 'awaiting_human';

export interface AgentBindingFacts {
  id: string;
  projectId: string;
  taskId?: string;
  lockToken?: string;
  workdir?: string;
  startedAt?: string;
  bootstrappingTaskId?: string;
  updatedAt: string;
  paneId?: string;
  creationToken?: string;
  status?: AgentLifecycleStatus;
  awaitingPhase?: string;
  awaitingReason?: string;
  awaitingSince?: string;
  awaitingNonce?: string;
  needInput?: NeedInputWatermark;
}

export interface NeedInputWatermark {
  epoch: number;
  askSeq?: number;
  answeredSeq?: number;
  at?: string;
}

export interface AgentErrorSummary {
  id: string;
  reason: string;
  message: string;
  occurredAt: string;
  recommendation?: string;
}

export interface AgentSnapshot {
  id: string;
  projectId: string;
  runtimeStatus: AgentRuntimeStatus;
  tmuxSessionStatus: TmuxSessionStatus;
  stale: boolean;
  observedAt?: string;
  binding?: AgentBindingFacts;
  latestError?: AgentErrorSummary;
  latestBootstrapError?: AgentErrorSummary;
  reason?: string;
  message?: string;
  petId?: string;
}

export type PetSpritesheetExt = 'png' | 'webp';

export interface PetMeta {
  id: string;
  displayName: string;
  description: string;
  ext: PetSpritesheetExt;
  createdAt: string;
}

export interface RemoteCleanupState {
  generation: string;
  stage: 'close-pending' | 'delete-pending' | 'manual';
  prNumber: number;
  branch: string;
  expectedHeadSha?: string;
  remoteProjectId?: string;
  failure?: {
    kind: 'config' | 'binding' | 'close' | 'persist' | 'delete' | 'probe' | 'tip-changed';
    message: string;
    at: string;
  };
  updatedAt: string;
}

export interface ReviewDispatchLease {
  generation: string;
  phase: 'pending' | 'claimed' | 'uncertain';
  qaPhase: 'review' | 'recheck';
  claimId?: string;
  signalToken: string;
  headSha: string;
  passToken: string;
  failToken: string;
  effectiveRound: number;
  claimedAt?: string;
  updatedAt: string;
}

export type TaskOutboxEntry =
  | { key: string; type: 'human.intervention'; data: Record<string, unknown> }
  | {
      key: string;
      type: 'git.spec-verdict';
      data: { prNumber: number; comments: string; writeAttemptedAt?: string };
  };

export type SpecVerdictOutboxEntry = Extract<TaskOutboxEntry, { type: 'git.spec-verdict' }>;

export interface TaskState {
  id: string;
  projectId: string;
  title: string;
  description: string;
  preferredAgentId: string;
  agentId: string;
  devAgentId: string;
  qaAgentId?: string;
  prNumber?: number;
  prUrl?: string;
  branch?: string;
  branchCreatedByBaxian?: boolean;
  branchCleanupPending?: {
    agentId: string;
    reason: string;
    updatedAt: string;
  };
  branchCleanupSkipped?: {
    agentId: string;
    reason: string;
    updatedAt: string;
  };
  remoteCleanup?: RemoteCleanupState;
  branchLocalCleaned?: {
    remoteTipSha: string;
    updatedAt: string;
  };
  latestHeadSha?: string;
  reviewHeadAnchorSha?: string;
  reviewDispatchedAt?: string;
  prFeedbackReceivedAt?: string;
  reviewConversationUpdatedAt?: string;
  fixDispatchedAt?: string;
  reviewRound: number;
  reviewRoundPending?: boolean;
  specReviewRound?: number;
  phase?: TaskPhase;
  deliveryConfirmation?: { phase: TaskPhase; source: 'signal' | 'human'; at: string };
  images?: string[];
  signalToken?: string;
  maxRoundsContinues?: number;
  postApproveRevoked?: { generation: string; reason: 'request-changes' | 'redispatch-cap'; at: string };
  postApproveHeadSha?: string;
  passToken?: string;
  failToken?: string;
  pendingPrSignalToken?: string;
  postApproveToken?: string;
  postApproveGeneration?: string;
  postApprovePhase?: 'installed' | 'delivered' | 'signaled';
  reviewDispatch?: ReviewDispatchLease;
  platformBinding?: { mode: string; repoKey: string; tool: string };
  baseBranch?: string;
  replyActorId?: string;
  replyActorStatus?: 'verified' | 'provisional';
  closedUnmergedAnchor?: { prNumber: number; generation: number; cleared?: boolean };
  passProvenance?: { sourceKey: string; id: string; bodyDigest: string; token: string; failToken: string; anchorSha: string };
  consumedFeedback?: Record<string, number>;
  outbox?: TaskOutboxEntry[];
  pendingRedispatch?: boolean;
  redispatchCount?: number;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  verdictOverdue?: boolean;
}

export interface TaskGenerationGuard {
  status: TaskStatus;
  phase?: TaskPhase;
  signalToken?: string;
  agentId: string;
  reviewRound: number;
  specReviewRound?: number;
}

export function taskGenerationGuard(task: TaskState): TaskGenerationGuard {
  return {
    status: task.status,
    phase: task.phase,
    signalToken: task.signalToken,
    agentId: task.agentId,
    reviewRound: task.reviewRound,
    specReviewRound: task.specReviewRound,
  };
}

export function taskMatchesGeneration(task: TaskState, expected: TaskGenerationGuard): boolean {
  return task.status === expected.status
    && task.phase === expected.phase
    && task.signalToken === expected.signalToken
    && task.agentId === expected.agentId
    && task.reviewRound === expected.reviewRound
    && task.specReviewRound === expected.specReviewRound;
}

export type PrReviewItemKind = 'review' | 'review-comment' | 'issue-comment';

export type PrReviewVerdict = 'approve' | 'request-changes' | 'comment';

export interface PrReviewItem {
  kind: PrReviewItemKind;
  id: string;
  author?: string;
  body?: string;
  bodyTruncated?: boolean;
  createdAt?: string;
  verdict?: PrReviewVerdict;
  path?: string;
  line?: number;
  commitSha?: string;
  inReplyTo?: boolean;
  sourceKey?: string;
  threadKey?: string;
  reviewState?: string;
  roundToken?: string;
  anchorSha?: string;
}

export type EventType =
  | 'task.created'
  | 'task.assigned'
  | 'task.updated'
  | 'session.started'
  | 'pr.created'
  | 'pr.updated'
  | 'pr.merged'
  | 'review.submitted'
  | 'review.max_rounds'
  | 'spec.ready'
  | 'pr.fix.submitted'
  | 'agent.bootstrap_failed'
  | 'agent.bootstrap_succeeded'
  | 'agent.recovered'
  | 'human.intervention';

export interface BaxianEvent {
  id: string;
  type: EventType;
  timestamp: string;
  projectId: string;
  agentId?: string;
  taskId?: string;
  data: Record<string, unknown>;
}

export type StreamSubMode = 'preview' | 'full';

interface StreamSubscribeMsg {
  op: 'subscribe';
  subscriberId: string;
  agentId: string;
  mode: StreamSubMode;
}

interface StreamUnsubscribeMsg {
  op: 'unsubscribe';
  subscriberId: string;
}

interface StreamInputMsg {
  op: 'input';
  subscriberId: string;
  data: string;
}

interface StreamResizeMsg {
  op: 'resize';
  subscriberId: string;
  cols: number;
  rows: number;
}

interface StreamPingMsg {
  op: 'ping';
}

export type StreamClientMsg =
  | StreamSubscribeMsg
  | StreamUnsubscribeMsg
  | StreamInputMsg
  | StreamResizeMsg
  | StreamPingMsg;

interface StreamSnapshotMsg {
  type: 'snapshot';
  subscriberId: string;
  cols: number;
  rows: number;
  data: string;
  snapshotSeq: number;
}

interface StreamDataMsg {
  type: 'data';
  agentId: string;
  data: string;
  seq: number;
}

interface StreamSubscribedMsg {
  type: 'subscribed';
  subscriberId: string;
  agentId: string;
  cols: number;
  rows: number;
  snapshotSeq: number;
}

interface StreamErrorMsg {
  type: 'error';
  subscriberId?: string;
  agentId?: string;
  code: string;
  message: string;
}

interface StreamSessionGoneMsg {
  type: 'session_gone';
  agentId: string;
}

interface StreamPongMsg {
  type: 'pong';
}

export type StreamServerMsg =
  | StreamSnapshotMsg
  | StreamDataMsg
  | StreamSubscribedMsg
  | StreamErrorMsg
  | StreamSessionGoneMsg
  | StreamPongMsg;

export type PollerHealth = 'healthy' | 'degraded' | 'failed' | 'unknown';

export interface PollerSnapshot {
  repo: string;
  projectId: string;
  intervalMs: number;
  isPolling: boolean;
  lastPollStartedAt?: string;
  lastPollEndedAt?: string;
  lastPollDurationMs?: number;
  lastErrorAt?: string;
  lastErrorMessage?: string;
  lastErrorClass?: string;
  rateLimitedUntil?: string;
  consecutiveFailures: number;
  health: PollerHealth;
}

type EventsTopicAgents = 'agents';
type EventsTopicAgent = `agent:${string}`;
type EventsTopicTask = `task:${string}`;
type EventsTopicProjectTasks = `project-tasks:${string}`;
type EventsTopicPollers = 'pollers';
export type EventsTopic =
  | EventsTopicAgents
  | EventsTopicAgent
  | EventsTopicTask
  | EventsTopicProjectTasks
  | EventsTopicPollers;

export type EventsClientMsg =
  | { op: 'subscribe'; topic: EventsTopic }
  | { op: 'unsubscribe'; topic: EventsTopic }
  | { op: 'ping' };

export type EventsServerMsg =
  | { type: 'data'; topic: EventsTopicAgents; data: AgentSnapshot[] }
  | { type: 'data'; topic: EventsTopicAgent; data: AgentSnapshot | null }
  | { type: 'data'; topic: EventsTopicTask; data: TaskState | null }
  | { type: 'data'; topic: EventsTopicProjectTasks; data: TaskState[] }
  | { type: 'data'; topic: EventsTopicPollers; data: PollerSnapshot[] }
  | { type: 'error'; topic?: EventsTopic; code: string; message: string }
  | { type: 'pong' };

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
