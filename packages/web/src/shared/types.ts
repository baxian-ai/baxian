export type AgentRuntime = 'claude-code' | 'codex';
export type AgentRole = 'dev' | 'qa';
export type AgentMode = 'local' | 'remote';
export type MergeStrategy = 'auto' | null;
export type ReviewMode = 'github' | 'server';
export type AfterDone = 'pr' | 'branch' | null;

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
  review?: ProjectReviewConfig;
  agent: AgentConfig[][];
}

export interface ProjectReviewConfig {
  mode?: ReviewMode;
}

export interface ReviewConfig {
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
  | 'approved'
  | 'merge-ready'
  | 'ready'
  | 'merged'
  | 'done'
  | 'max_rounds'
  | 'failed'
  | 'cancelled';

export type TaskPhase = 'spec' | 'code';

export type AgentLifecycleStatus = 'ok' | 'awaiting_human';

export interface AgentBindingFacts {
  id: string;
  projectId: string;
  taskId?: string;
  worktreePath?: string;
  repoPath?: string;
  startedAt?: string;
  updatedAt: string;
  paneId?: string;
  creationToken?: string;
  status?: AgentLifecycleStatus;
  awaitingPhase?: string;
  awaitingReason?: string;
  awaitingSince?: string;
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
  latestHeadSha?: string;
  reviewHeadAnchorSha?: string;
  reviewDispatchedAt?: string;
  reviewRound: number;
  specReviewRound?: number;
  phase?: TaskPhase;
  signalToken?: string;
  reviewMode?: ReviewMode;
  batchIndex?: number;
  batchTotal?: number;
  maxRoundsContinues?: number;
  afterDone?: AfterDone;
  publishDispatchedAt?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  verdictOverdue?: boolean;
}

export type FindingSeverity = 'critical' | 'major' | 'minor';

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

export interface FindingResponse {
  findingId: string;
  action: 'fix' | 'reject' | 'out-of-scope';
  rationale: string;
  commitSha?: string;
}

export interface ReviewResponse {
  round: number;
  responses: FindingResponse[];
}

export interface ReviewRound {
  round: number;
  phase: TaskPhase;
  content: string;
  contentTruncated?: boolean;
  diffstat?: string;
  baseSha?: string;
  findings?: ReviewFindings;
  response?: ReviewResponse;
  batchFindings?: ReviewFindings[];
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

export interface GithubReviewConversation {
  available: boolean;
  reason?: 'server-mode' | 'no-pr' | 'not-github';
  prNumber?: number;
  prUrl?: string;
  items: GithubReviewItem[];
  error?: string;
}

export type StreamSubMode = 'preview' | 'full';

export interface StreamSubscribeMsg {
  op: 'subscribe';
  subscriberId: string;
  agentId: string;
  mode: StreamSubMode;
}

export interface StreamUnsubscribeMsg {
  op: 'unsubscribe';
  subscriberId: string;
}

export interface StreamInputMsg {
  op: 'input';
  subscriberId: string;
  data: string;
}

export interface StreamResizeMsg {
  op: 'resize';
  subscriberId: string;
  cols: number;
  rows: number;
}

export interface StreamPingMsg {
  op: 'ping';
}

export type StreamClientMsg =
  | StreamSubscribeMsg
  | StreamUnsubscribeMsg
  | StreamInputMsg
  | StreamResizeMsg
  | StreamPingMsg;

export interface StreamSnapshotMsg {
  type: 'snapshot';
  subscriberId: string;
  cols: number;
  rows: number;
  data: string;
  snapshotSeq: number;
}

export interface StreamDataMsg {
  type: 'data';
  agentId: string;
  data: string;
  seq: number;
}

export interface StreamSubscribedMsg {
  type: 'subscribed';
  subscriberId: string;
  agentId: string;
  cols: number;
  rows: number;
  snapshotSeq: number;
}

export interface StreamErrorMsg {
  type: 'error';
  subscriberId?: string;
  agentId?: string;
  code: string;
  message: string;
}

export interface StreamSessionGoneMsg {
  type: 'session_gone';
  agentId: string;
}

export interface StreamPongMsg {
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

export type EventsTopicAgents = 'agents';
export type EventsTopicAgent = `agent:${string}`;
export type EventsTopicTask = `task:${string}`;
export type EventsTopicProjectTasks = `project-tasks:${string}`;
export type EventsTopicPollers = 'pollers';
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
