import type {
  AgentBindingFacts,
  AgentErrorSummary,
  AgentRuntimeStatus,
  AgentSnapshot,
  TaskState,
} from '../shared/index.js';
import type { TmuxSessionObservation } from '../agent/tmux-probe-poller.js';
import type { ErrorRecord } from './error-record-store.js';

export interface AgentSnapshotCtx {
  agentManager: {
    listAgents: () => Array<{ id: string; projectId: string }>;
    getAgentConfig: (id: string) => { id: string; projectId: string } | undefined;
  };
  agentStore: { list: () => Promise<AgentBindingFacts[]>; get: (id: string) => Promise<AgentBindingFacts | null> };
  taskStore: { get: (id: string) => Promise<TaskState | null> };
  tmuxSessionStatusStore: { get: (id: string) => TmuxSessionObservation };
  // Optional: when present, snapshot surfaces the most recent bootstrap error per agent
  // (BootstrapPoller failures don't flow through tmuxObservation, so UI is otherwise blind to them).
  errorRecordStore?: {
    latestBootstrapForAgent: (agentId: string) => Promise<ErrorRecord | undefined>;
    latestBootstrapByAgent: () => Promise<Map<string, ErrorRecord>>;
    toSummary: (record: ErrorRecord) => AgentErrorSummary;
  };
}

const WORKING_TASK_STATUSES = new Set<TaskState['status']>(['in_progress', 'fixing']);
// max_rounds: dev is reserved awaiting a human decision (continue/complete/cancel) → waiting, not error.
const WAITING_TASK_STATUSES = new Set<TaskState['status']>(['review', 'approved', 'merge-ready', 'ready', 'max_rounds']);
const ERROR_TASK_STATUSES = new Set<TaskState['status']>(['failed']);
const UNREACHABLE_ACTIVE_TASK_GRACE_MS = 30_000;

export function agentSnapshot(
  configured: { id: string; projectId: string },
  binding: AgentBindingFacts | undefined,
  tmuxObservation: TmuxSessionObservation,
  task: TaskState | undefined,
  latestBootstrapError?: AgentErrorSummary,
): AgentSnapshot {
  const runtimeStatus = deriveRuntimeStatus(binding, tmuxObservation, task);
  // When PENDING_IDLE is gated by task status, also hide the matching error card / reason /
  // message — otherwise the UI keeps a red "waiting on user input" banner that points operators
  // at a terminal they shouldn't touch (the task is on GitHub now, not in the dev's pane).
  const suppressPendingIdle = shouldGatePendingIdle(tmuxObservation, task);
  // Bootstrap error visibility is gated by errorRecordStore presence, not by binding.repoPath:
  // (a) never-dispatched agents never get a binding (runSingleTarget skips AgentStore.update on
  //     existing=undefined), so repoPath-based suppression keeps showing stale errors forever;
  // (b) once binding.repoPath is set by an early success, a later failure would be SUPPRESSED
  //     and the user can't see the new regression.
  // Truth source is now "is there a current bootstrap error record?" — successful bootstraps
  // purge their agent's bootstrap records (see ErrorRecordStore.purgeBootstrapForAgent).
  const showBootstrapError = !!latestBootstrapError;
  return {
    id: configured.id,
    projectId: configured.projectId,
    runtimeStatus,
    tmuxSessionStatus: tmuxObservation.tmuxSessionStatus,
    stale: !tmuxObservation.observedAt || tmuxObservation.tmuxSessionStatus === 'unreachable',
    ...(tmuxObservation.observedAt ? { observedAt: tmuxObservation.observedAt } : {}),
    ...(binding ? { binding } : {}),
    ...(!suppressPendingIdle && tmuxObservation.latestError ? { latestError: tmuxObservation.latestError } : {}),
    ...(showBootstrapError ? { latestBootstrapError } : {}),
    ...(!suppressPendingIdle && tmuxObservation.reason ? { reason: tmuxObservation.reason } : {}),
    ...(!suppressPendingIdle && tmuxObservation.message ? { message: tmuxObservation.message } : {}),
  };
}

export function deriveRuntimeStatus(
  binding: AgentBindingFacts | undefined,
  tmuxObservation: TmuxSessionObservation,
  task: TaskState | undefined,
): AgentRuntimeStatus {
  if (binding?.creationToken) return 'pending';
  if (tmuxObservation.runtimeStatusHint && !shouldGatePendingIdle(tmuxObservation, task)) {
    return tmuxObservation.runtimeStatusHint;
  }
  if (tmuxObservation.tmuxSessionStatus === 'unknown') return 'unknown';
  if (binding?.taskId && tmuxObservation.paneState === 'shell') return 'error';
  if (binding?.taskId && tmuxObservation.tmuxSessionStatus === 'unreachable') {
    return isRecentPresentObservation(tmuxObservation)
      ? deriveTaskBoundStatus(task)
      : 'unknown';
  }
  if (binding?.taskId && tmuxObservation.tmuxSessionStatus !== 'present') return 'error';
  if (!binding?.taskId) {
    return tmuxObservation.tmuxSessionStatus === 'present' ? 'idle' : 'unknown';
  }
  return deriveTaskBoundStatus(task);
}

// PENDING_IDLE is a soft inference (screen idle ≥ N min); only trust it while dev is actively
// expected at the terminal (task in_progress/fixing). PENDING_HUMAN — menu UI — is a physical
// signal, never gated.
function shouldGatePendingIdle(
  tmuxObservation: TmuxSessionObservation,
  task: TaskState | undefined,
): boolean {
  if (tmuxObservation.runtimeStatusHint !== 'pending') return false;
  if (tmuxObservation.reason !== 'PENDING_IDLE') return false;
  return !(task && WORKING_TASK_STATUSES.has(task.status));
}

function deriveTaskBoundStatus(task: TaskState | undefined): AgentRuntimeStatus {
  if (!task) return 'working';
  if (WORKING_TASK_STATUSES.has(task.status)) return 'working';
  if (WAITING_TASK_STATUSES.has(task.status)) return 'waiting';
  if (ERROR_TASK_STATUSES.has(task.status)) return 'error';
  // Still bound to a merged task = post-merge branch cleanup + /clear in flight. The agent is
  // not yet free for the next task (Start stays disabled), so report 'working' not 'idle'.
  if (task.status === 'merged') return 'working';
  return 'idle';
}

function isRecentPresentObservation(tmuxObservation: TmuxSessionObservation): boolean {
  if (!tmuxObservation.observedAt || !tmuxObservation.lastPresentAt) return false;
  const observedAt = Date.parse(tmuxObservation.observedAt);
  const lastPresentAt = Date.parse(tmuxObservation.lastPresentAt);
  if (!Number.isFinite(observedAt) || !Number.isFinite(lastPresentAt)) return false;
  return observedAt - lastPresentAt <= UNREACHABLE_ACTIVE_TASK_GRACE_MS;
}

async function loadLatestBootstrapError(
  ctx: AgentSnapshotCtx,
  agentId: string,
): Promise<AgentErrorSummary | undefined> {
  if (!ctx.errorRecordStore) return undefined;
  try {
    const record = await ctx.errorRecordStore.latestBootstrapForAgent(agentId);
    return record ? ctx.errorRecordStore.toSummary(record) : undefined;
  } catch (err) {
    console.warn(`[snapshot] failed to load bootstrap error for ${agentId}:`, err);
    return undefined;
  }
}

async function loadLatestBootstrapByAgent(
  ctx: AgentSnapshotCtx,
): Promise<Map<string, AgentErrorSummary>> {
  if (!ctx.errorRecordStore) return new Map();
  try {
    const records = await ctx.errorRecordStore.latestBootstrapByAgent();
    const summaries = new Map<string, AgentErrorSummary>();
    for (const [agentId, record] of records) {
      summaries.set(agentId, ctx.errorRecordStore.toSummary(record));
    }
    return summaries;
  } catch (err) {
    console.warn('[snapshot] failed to batch-load bootstrap errors:', err);
    return new Map();
  }
}

export async function buildAllAgentSnapshots(ctx: AgentSnapshotCtx): Promise<AgentSnapshot[]> {
  const [bindings, bootstrapErrorsByAgent] = await Promise.all([
    ctx.agentStore.list(),
    loadLatestBootstrapByAgent(ctx),
  ]);
  const bindingByAgentId = new Map(bindings.map((s) => [s.id, s]));
  return Promise.all(ctx.agentManager.listAgents().map(async (configured) => {
    const binding = bindingByAgentId.get(configured.id);
    const task = binding?.taskId ? await ctx.taskStore.get(binding.taskId) : null;
    return agentSnapshot(
      configured,
      binding,
      ctx.tmuxSessionStatusStore.get(configured.id),
      task ?? undefined,
      bootstrapErrorsByAgent.get(configured.id),
    );
  }));
}

export async function buildAgentSnapshotById(
  ctx: AgentSnapshotCtx,
  id: string,
): Promise<AgentSnapshot | null> {
  const configured = ctx.agentManager.getAgentConfig(id);
  if (!configured) return null;
  const binding = await ctx.agentStore.get(id);
  const task = binding?.taskId ? await ctx.taskStore.get(binding.taskId) : null;
  const latestBootstrapError = await loadLatestBootstrapError(ctx, id);
  return agentSnapshot(
    configured,
    binding ?? undefined,
    ctx.tmuxSessionStatusStore.get(id),
    task ?? undefined,
    latestBootstrapError,
  );
}
