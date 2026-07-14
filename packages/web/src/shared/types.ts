export type AgentRuntime = 'claude-code' | 'codex' | 'opencode' | 'qodercli';
export type AgentRole = 'dev' | 'qa' | 'research';
export type AgentMode = 'local' | 'remote';
export type MergeStrategy = 'auto' | null;
export type SpecApprovalStrategy = 'human' | null;
export type ReviewMode = 'github' | 'server';
type AfterDone = 'pr' | 'branch' | null;
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
  review?: ProjectReviewConfig;
  agent: AgentConfig[][];
}

export interface ProjectReviewConfig {
  mode?: ReviewMode;
}

interface ReviewConfig {
  rounds: number;
  mode?: ReviewMode;
  afterDone?: AfterDone;
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
  | 'ready'
  | 'merged'
  | 'done'
  | 'max_rounds'
  | 'failed'
  | 'cancelled';

export type TaskPhase = 'research' | 'spec' | 'code';
export type ReviewPhase = 'spec' | 'code';

export function isSpecStagePhase(phase: TaskPhase | undefined): boolean {
  return phase === 'research' || phase === 'spec';
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
  needInputAt?: string;
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
  researchAgentId?: string;
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

interface SpecUserDecision {
  verdict: 'approve' | 'request-changes' | 'archive';
  comments?: string;
  at: string;
}

export interface SpecDocument {
  relPath: string;
  content: string;
}

export function renderSpecDocuments(documents: readonly SpecDocument[]): string {
  if (documents.length === 1) return documents[0]!.content;
  return documents.map(document => `=== ${document.relPath} ===\n${document.content}`).join('\n');
}

interface ReviewRoundBase {
  round: number;
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

export interface SpecReviewRound extends ReviewRoundBase {
  phase: 'spec';
  documents: SpecDocument[];
}

export interface CodeReviewRound extends ReviewRoundBase {
  phase: 'code';
}

export type ReviewRound = SpecReviewRound | CodeReviewRound;

type GithubReviewItemKind = 'review' | 'review-comment' | 'issue-comment' | 'commit';

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
