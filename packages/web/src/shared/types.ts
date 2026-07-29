export type AgentRuntime = 'claude-code' | 'codex' | 'opencode' | 'qodercli';
export type AgentRole = 'dev' | 'qa';
export type AgentMode = 'local' | 'remote';
export type MergeStrategy = 'auto' | null;
export type SpecApprovalStrategy = 'human' | null;
export type SupportedLanguage = 'zh-CN' | 'en-US';

export interface HostConfig {
  id?: string;
  hostname: string;
  port?: number;
  alias?: string;
  user?: string;
  password?: string;
}

export interface AgentConfig {
  id: string;
  runtime: AgentRuntime;
  role: AgentRole;
  mode: AgentMode;
  host?: string | HostConfig;
  workdir?: string;
  yolo?: boolean;
  model?: string;
  addDirs?: string[];
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

interface HttpsConfig {
  keyFile: string;
  certFile: string;
}

interface ServerConfig {
  port: number;
  token?: string;
  host?: string;
  https?: HttpsConfig;
  allowedHosts?: string[];
  githubPollIntervalMs?: number;
  tmuxProbePollIntervalMs?: number;
  tmuxProbeTimeoutMs?: number;
  tmuxProbeConcurrency?: number;
  bootstrapRetryIntervalMs?: number;
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

type TmuxSessionStatus =
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

type AgentLifecycleStatus = 'ok' | 'awaiting_human';

export interface AgentBindingFacts {
  id: string;
  projectId: string;
  taskId?: string;
  lockToken?: string;
  workdir?: string;
  startedAt?: string;
  updatedAt: string;
  paneId?: string;
  creationToken?: string;
  status?: AgentLifecycleStatus;
  awaitingPhase?: string;
  awaitingReason?: string;
  awaitingSince?: string;
  needInput?: {
    epoch: number;
    askSeq?: number;
    answeredSeq?: number;
    at?: string;
  };
}

interface AgentErrorSummary {
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

type TaskOperation = 'advance' | 'verdict' | 'cancel' | 'retry';

interface TaskAttention {
  reason: string;
  runbook: string;
  occurredAt: string;
  recommendedActions: TaskOperation[];
}

type PetSpritesheetExt = 'png' | 'webp';

export interface PetMeta {
  id: string;
  displayName: string;
  description: string;
  ext: PetSpritesheetExt;
  createdAt: string;
}

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
  latestHeadSha?: string;
  reviewHeadAnchorSha?: string;
  reviewDispatchedAt?: string;
  prFeedbackReceivedAt?: string;
  reviewConversationUpdatedAt?: string;
  closedUnmergedAnchor?: { prNumber: number; generation: number; cleared?: boolean };
  reviewRound: number;
  specReviewRound?: number;
  phase?: TaskPhase;
  deliveryConfirmation?: { phase: TaskPhase; source: 'signal' | 'human'; at: string };
  signalToken?: string;
  maxRoundsContinues?: number;
  replyActorId?: string;
  replyActorStatus?: 'verified' | 'provisional';
  postApproveRevoked?: { generation: string; reason: 'request-changes' | 'redispatch-cap'; at: string };
  attention?: TaskAttention;
  replacementTaskId?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export function needsGitReviewRecovery(
  task: Pick<TaskState, 'phase' | 'deliveryConfirmation' | 'replyActorStatus' | 'prNumber'>,
): boolean {
  return task.prNumber === undefined
    || task.phase === undefined
    || task.deliveryConfirmation?.phase !== task.phase
    || task.replyActorStatus !== 'verified';
}

type PrReviewItemKind = 'review' | 'review-comment' | 'issue-comment';

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

export interface PrReviewConversation {
  available: boolean;
  reason?: 'no-pr' | 'driver-unavailable';
  prNumber?: number;
  prUrl?: string;
  items: PrReviewItem[];
  error?: string;
  rateLimited?: boolean;
  truncated?: boolean;
  fetchedAt?: string;
  autoRefresh?: boolean;
  autoRefreshIntervalMs?: number;
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

type PollerHealth = 'healthy' | 'degraded' | 'failed' | 'unknown';

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
