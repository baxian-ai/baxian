export type AgentRuntime = 'claude-code' | 'codex';
export type AgentRole = 'dev' | 'qa';
export type AgentMode = 'local' | 'remote';
export type MergeStrategy = 'auto' | null;
export type ReviewMode = 'github' | 'server';
export type AfterDone = 'pr' | 'branch' | null;

export interface HostConfig {
  // Registry entries carry a generated id agents reference; legacy inline hosts omit it.
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
  // string = registry host id; object = legacy inline host (back-compat).
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
  /**
   * Maximum review iterations for this task. Applies to BOTH the code-review
   * loop (dev↔qa code rounds) AND the spec-review loop (dev↔qa spec rounds);
   * same numeric cap. If the two ever need to diverge, split this field then.
   */
  rounds: number;
  /** 'github' keeps PR-based review; 'server' uses the server-mediated protocol. */
  mode?: ReviewMode;
  /** Server mode only: what dev publishes after QA approves. Ignored when mode==='github'. */
  afterDone?: AfterDone;
}

export interface HttpsConfig {
  /** Absolute path to PEM-encoded private key, readable by the server user. */
  keyFile: string;
  /** Absolute path to PEM-encoded full-chain certificate. */
  certFile: string;
}

export interface ServerConfig {
  port: number;
  host: string;
  token?: string;
  /** When set, server listens with TLS instead of plain HTTP. */
  https?: HttpsConfig;
  /**
   * Allowed Host header values. Empty/undefined = accept any (dev default).
   * Set in production to mitigate Host-header attacks.
   */
  allowedHosts?: string[];
  githubPollIntervalMs: number;
  tmuxProbePollIntervalMs: number;
  tmuxProbeTimeoutMs: number;
  tmuxProbeConcurrency: number;
  bootstrapRetryIntervalMs: number;
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

// baxian 自己设的 lifecycle 状态（权威），区别于 AgentRuntimeStatus（探针派生量）。
// awaiting_human: 自动调度路径无法继续，必须 operator 显式 resumeAgent 才放出。
export type AgentLifecycleStatus = 'ok' | 'awaiting_human';

export interface AgentBindingFacts {
  id: string;
  projectId: string;
  taskId?: string;
  worktreePath?: string;
  repoPath?: string;
  startedAt?: string;
  // Set while a NEW dispatch is mid-bootstrap for this taskId (running-binding written, prompt not yet
  // ack'd); cleared once injectAndAwaitAck confirms delivery. recover() rolls a develop task back only
  // when this names it — a legacy binding (older build, no field) is left alone, so its still-running
  // prompt isn't duplicated or its worktree removed out from under it.
  bootstrappingTaskId?: string;
  updatedAt: string;
  paneId?: string;
  creationToken?: string;
  status?: AgentLifecycleStatus;
  awaitingPhase?: string;
  awaitingReason?: string;
  awaitingSince?: string;
  // Skills already inlined into the REPL session's context, scoped to
  // (taskId, paneId). When either changes we treat the agent's context as
  // fresh and re-inject — this is the "across task cycles re-inject, within
  // a cycle dedup" boundary.
  injectedSkills?: InjectedSkillsRecord;
}

export interface InjectedSkillsRecord {
  taskId: string;
  paneId: string;
  skills: string[];
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
  /** Agent Pet assignment; the web animates this pet in place of the status pill. */
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
  /** Server-trusted PR head SHA — anchor for review.submitted staleness checks. */
  latestHeadSha?: string;
  /**
   * Immutable head SHA captured at the moment QA was dispatched for review/recheck.
   * Pane-signal verdicts (no SHA in payload) use this as `reviewedHeadSha` so they
   * approve only the commit QA actually looked at — protecting against the race
   * where dev pushes a new head mid-review and `latestHeadSha` shifts under us.
   * Cleared when the task leaves the review state machine.
   */
  reviewHeadAnchorSha?: string;
  /**
   * Wall-clock time the current QA review/recheck pass was dispatched. A poller
   * verdict whose GitHub `submitted_at` precedes this belongs to a SUPERSEDED
   * pass (dev force-pushed mid-review → server re-dispatched a fresh pass) and is
   * rejected. GitHub attributes a review to the submit-time head, so commit_id
   * alone can't catch this race — only baxian knows when it dispatched the pass.
   */
  reviewDispatchedAt?: string;
  /**
   * Wall-clock time the current code-fix round was dispatched (REQUEST_CHANGES →
   * fixing). The pr-fixed verifier uses THIS, not reviewDispatchedAt, as the lower
   * bound for "did the dev do anything": a QA/human top-level comment left during
   * the review (after reviewDispatchedAt, before fixing) must NOT count as dev
   * activity, or a pure no-op would be falsely advanced.
   */
  fixDispatchedAt?: string;
  reviewRound: number;
  /** Spec review round, isolated from PR review round. */
  specReviewRound?: number;
  /** undefined ≡ 'code' for backward compatibility. */
  phase?: TaskPhase;
  /** Uploaded image filenames staged under ${stateDir}/state/task-images/<id>/. */
  images?: string[];
  /** Signal token for the current pending pane signal; rotated each dispatch/phase transition. */
  signalToken?: string;
  /** Review mode snapshotted at task creation; hot config changes do not retarget live tasks. */
  reviewMode?: ReviewMode;
  /** Server-mode large-diff batching cursor (0-based); undefined when not batching. */
  batchIndex?: number;
  batchTotal?: number;
  /** Human "continue one round" grants past the review cap (server mode). */
  maxRoundsContinues?: number;
  /** afterDone snapshotted when the approve verdict routed it; confirm reads THIS, not live config. */
  afterDone?: AfterDone;
  /**
   * Set when the publish prompt was DELIVERED (ack'd + watcher armed); cleared on
   * dispatch failure. Distinguishes a real in-flight publish from a failed,
   * retryable one across restarts — recovered watchers alone cannot tell.
   */
  publishDispatchedAt?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  /** Computed at snapshot time; true when review has been pending past REVIEW_VERDICT_TIMEOUT_MS. */
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

export type FindingAction = 'fix' | 'reject' | 'out-of-scope';

export interface FindingResponse {
  findingId: string;
  action: FindingAction;
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
  /** Full-scope diffstat captured with the diff; batch continuations re-inject it. */
  diffstat?: string;
  /** Merge-base SHA used when this round's diff was computed (audit only). */
  baseSha?: string;
  findings?: ReviewFindings;
  response?: ReviewResponse;
  /** Raw per-batch findings before aggregation (large-diff batching). */
  batchFindings?: ReviewFindings[];
  startedAt: string;
  completedAt?: string;
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

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
