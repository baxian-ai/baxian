export type AgentRuntime = 'claude-code' | 'codex' | 'opencode' | 'qodercli';
export type AgentRole = 'dev' | 'qa' | 'research';
export type AgentMode = 'local' | 'remote';
export type MergeStrategy = 'auto' | null;
export type SpecApprovalStrategy = 'human' | null;
export type ReviewMode = 'github' | 'server' | 'git';
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
  gitCli?: GitCliConfig;
  agent: AgentConfig[][];
}

interface ProjectReviewConfig {
  mode?: ReviewMode;
}

export interface GitCliConfig {
  tool: string;
  binary?: string;
  notes?: string;
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
  bootstrappingTaskId?: string;
  updatedAt: string;
  paneId?: string;
  creationToken?: string;
  status?: AgentLifecycleStatus;
  awaitingPhase?: string;
  awaitingReason?: string;
  awaitingSince?: string;
  // Random per-write hold generation: (phase, since) alone can ABA within one millisecond.
  awaitingNonce?: string;
  // Display-only ask/answer watermark ([bx:need-input]/[bx:input-received]).
  // Never consulted by scheduling — that is what status/awaiting* are for.
  needInput?: NeedInputWatermark;
}

// Invariants: epoch and per-epoch seqs only grow; `at` exists iff askSeq > answeredSeq.
// Every whole-binding rebuild write must carry the object through (or bump epoch to void it).
export interface NeedInputWatermark {
  epoch: number;
  askSeq?: number;
  answeredSeq?: number;
  at?: string;
  // A same-token replay split this token's pane history into two generations that reuse
  // the same ordinals: a framebuffer snapshot cannot attribute a literal to either, so
  // this token's arms stop reading it. Dropped as soon as another token takes over.
  cutoverToken?: string;
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
  // 释放时本地任务分支被清理（远端保留）的凭据；检出恢复只信这枚删除时刻的远端 tip
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
  // 本 pass 的轮次尚未计入（直派路径在 startSession 成功后才 bump）；补派/重启重放据此恰好补计一次
  reviewRoundPending?: boolean;
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
  // Deliberately cleared post-approve completion; a restart replay must not rebuild it while this stands.
  postApproveRevoked?: { reason: 'request-changes' | 'redispatch-cap'; at: string };
  // Approved head persisted at post-approve dispatch; the only SHA a completion rebuild may trust.
  postApproveHeadSha?: string;
  passToken?: string;
  failToken?: string;
  // Publish-dispatch pr-created expectation survives review-round token rotation until
  // actor reconciliation completes or the task terminates (spec §5.3 ④).
  pendingPrSignalToken?: string;
  // 'git' post-approve completion token lives on the task so effect fields and consumption
  // keys share one durable write (spec §6); legacy github keeps PostApproveStore until M3c.
  postApproveToken?: string;
  // installed → prompt injected (delivered) → merge-ready received (signaled): recovery/sweep
  // must not re-inject into a mid-prompt dev, and must redispatch once the signal was consumed.
  postApprovePhase?: 'installed' | 'delivered' | 'signaled';
  // Set inside the review-entering transition, cleared after the QA session starts: the
  // same-head/same-PR replay guards stay permeable until a QA round provably dispatched.
  reviewDispatchPending?: boolean;
  // Identity trio snapshot at creation (spec §4): the lock covers online edits, this
  // fingerprint fails offline edits closed before any platform op runs.
  platformBinding?: { mode: string; repoKey: string; tool: string };
  // expectedBase snapshot taken at adoption/signal verification; immutable afterwards (spec §6).
  baseBranch?: string;
  replyActorId?: string;
  replyActorStatus?: 'verified' | 'provisional';
  // cleared keeps the generation counter across reopen so the next close mints a fresh event key.
  closedUnmergedAnchor?: { prNumber: number; generation: number; cleared?: boolean };
  // Self-contained pair snapshot at acceptance: recheck must see the round's failToken even after re-mints.
  passProvenance?: { sourceKey: string; id: string; bodyDigest: string; token: string; failToken: string; anchorSha: string };
  // revision key -> versionTime; effect fields and these keys persist in the same write (spec §6).
  consumedFeedback?: Record<string, number>;
  outbox?: Array<{ key: string; type: 'human.intervention'; data: Record<string, unknown> }>;
  pendingRedispatch?: boolean;
  redispatchCount?: number;
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

export interface SpecDocument {
  relPath: string;
  content: string;
}

export function renderSpecDocuments(documents: readonly SpecDocument[]): string {
  if (documents.length === 1) return documents[0]!.content;
  return documents.map(document => `=== ${document.relPath} ===\n${document.content}`).join('\n');
}

interface SpecUserDecision {
  verdict: 'approve' | 'request-changes' | 'archive';
  comments?: string;
  at: string;
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

export type PrReviewItemKind = 'review' | 'review-comment' | 'issue-comment' | 'commit';

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
  // 三源 id 无跨表唯一性：线程键 = (sourceKey, discussionId ?? id)
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
