export type AgentRuntime = 'claude-code' | 'codex' | 'opencode' | 'qodercli';
export type AgentRole = 'dev' | 'qa';
export type AgentMode = 'local' | 'remote';
export type MergeStrategy = 'auto' | null;
export type SpecApprovalStrategy = 'human' | null;
export type ReviewMode = 'github' | 'server';
export type AfterDone = 'pr' | 'branch' | null;
type SupportedLanguage = 'zh-CN' | 'en-US';

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
  review?: ProjectReviewConfig;
  agent: AgentConfig[][];
}

interface ProjectReviewConfig {
  mode?: ReviewMode;
}

interface ReviewConfig {
  rounds: number;
  mode?: ReviewMode;
  afterDone?: AfterDone;
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
  | 'ready'
  | 'merged'
  | 'done'
  | 'max_rounds'
  | 'failed'
  | 'cancelled';

export type TaskPhase = 'spec' | 'code';

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
  // Display-only: agent asked its human partner and is waiting ([bx:need-input]).
  // Never consulted by scheduling — that is what status/awaiting* are for.
  needInputAt?: string;
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

export interface TaskState {
  id: string;
  projectId: string;
  title: string;
  description: string;
  preferredAgentId: string;
  agentId: string;
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
  fixDispatchedAt?: string;
  reviewRound: number;
  specReviewRound?: number;
  phase?: TaskPhase;
  images?: string[];
  signalToken?: string;
  reviewMode?: ReviewMode;
  batchIndex?: number;
  batchTotal?: number;
  // Persisted so recovery can re-arm read-file for a base fallback without
  // re-enabling it for a head checkout, which would bypass the tree proof.
  reviewCheckoutMode?: 'head' | 'base';
  maxRoundsContinues?: number;
  afterDone?: AfterDone;
  publishDispatchedAt?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  verdictOverdue?: boolean;
}

type FindingSeverity = 'critical' | 'major' | 'minor';

export interface Finding {
  id: string;
  severity: FindingSeverity;
  message: string;
  file?: string;
  line?: number;
  location?: string;
}

export interface ReviewFindings {
  round: number;
  verdict: 'approve' | 'request-changes';
  findings: Finding[];
}

type FindingAction = 'fix' | 'reject' | 'out-of-scope';

interface FindingResponse {
  findingId: string;
  action: FindingAction;
  rationale: string;
  commitSha?: string;
}

export interface ReviewResponse {
  round: number;
  responses: FindingResponse[];
}

export interface ReviewContentFileRef {
  path: string;
  bytes: number;
}

interface SpecUserDecision {
  verdict: 'approve' | 'request-changes';
  comments?: string;
  at: string;
}

export interface ReviewRound {
  round: number;
  phase: TaskPhase;
  content: string;
  contentTruncated?: boolean;
  diffstat?: string;
  baseSha?: string;
  headSha?: string;
  headTree?: string;
  findings?: ReviewFindings;
  response?: ReviewResponse;
  batchFindings?: ReviewFindings[];
  userDecision?: SpecUserDecision;
  startedAt: string;
  completedAt?: string;
}

export type GithubReviewItemKind = 'review' | 'review-comment' | 'issue-comment' | 'commit';

export type GithubReviewVerdict = 'approve' | 'request-changes' | 'comment';

export interface GithubReviewItem {
  kind: GithubReviewItemKind;
  id: string;
  author?: string;
  body?: string;
  bodyTruncated?: boolean;
  createdAt?: string;
  verdict?: GithubReviewVerdict;
  path?: string;
  line?: number;
  commitSha?: string;
  inReplyTo?: boolean;
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
  | 'server.spec.ready'
  | 'server.spec.review.submitted'
  | 'server.spec.fix.submitted'
  | 'server.code.ready'
  | 'server.code.review.submitted'
  | 'server.code.fix.submitted'
  | 'server.code.published'
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
