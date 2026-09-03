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
  errorRecordStore?: {
    latestBootstrapForAgent: (agentId: string) => Promise<ErrorRecord | undefined>;
    latestBootstrapByAgent: () => Promise<Map<string, ErrorRecord>>;
    toSummary: (record: ErrorRecord) => AgentErrorSummary;
  };
  petStore?: {
    listAssignments: () => Promise<Record<string, string>>;
    getAssignment: (agentId: string) => Promise<string | null>;
  };
}

const WORKING_TASK_STATUSES = new Set<TaskState['status']>(['in_progress', 'fixing']);
const WAITING_TASK_STATUSES = new Set<TaskState['status']>(['review', 'spec-ready', 'approved', 'merge-ready', 'max_rounds']);
const ERROR_TASK_STATUSES = new Set<TaskState['status']>(['failed']);
const UNREACHABLE_ACTIVE_TASK_GRACE_MS = 30_000;

export function agentSnapshot(
  configured: { id: string; projectId: string },
  binding: AgentBindingFacts | undefined,
  tmuxObservation: TmuxSessionObservation,
  task: TaskState | undefined,
  latestBootstrapError?: AgentErrorSummary,
  petId?: string,
): AgentSnapshot {
  const runtimeStatus = deriveRuntimeStatus(binding, tmuxObservation, task);
  const suppressPendingIdle = shouldGatePendingIdle(tmuxObservation, task, binding?.id);
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
    ...(petId ? { petId } : {}),
  };
}

export function deriveRuntimeStatus(
  binding: AgentBindingFacts | undefined,
  tmuxObservation: TmuxSessionObservation,
  task: TaskState | undefined,
): AgentRuntimeStatus {
  if (binding?.creationToken) return 'pending';
  if (tmuxObservation.runtimeStatusHint && !shouldGatePendingIdle(tmuxObservation, task, binding?.id)) {
    return tmuxObservation.runtimeStatusHint;
  }
  if (tmuxObservation.tmuxSessionStatus === 'unknown') return 'unknown';
  if (binding?.taskId && tmuxObservation.paneState === 'shell') return 'error';
  if (binding?.taskId && tmuxObservation.tmuxSessionStatus === 'unreachable') {
    return isRecentPresentObservation(tmuxObservation)
      ? deriveTaskBoundStatus(task, binding.id)
      : 'unknown';
  }
  if (binding?.taskId && tmuxObservation.tmuxSessionStatus !== 'present') return 'error';
  if (!binding?.taskId) {
    return tmuxObservation.tmuxSessionStatus === 'present' ? 'idle' : 'unknown';
  }
  return deriveTaskBoundStatus(task, binding.id);
}

function shouldGatePendingIdle(
  tmuxObservation: TmuxSessionObservation,
  task: TaskState | undefined,
  agentId?: string,
): boolean {
  if (tmuxObservation.runtimeStatusHint !== 'pending') return false;
  if (tmuxObservation.reason !== 'PENDING_IDLE') return false;
  if (agentId && task?.qaAgentId === agentId && task.status === 'review') return false;
  if (qaWaitingOnDev(task, agentId)) return true;
  return !(task && WORKING_TASK_STATUSES.has(task.status));
}

function qaWaitingOnDev(task: TaskState | undefined, agentId?: string): boolean {
  return !!task && !!agentId && task.qaAgentId === agentId && WORKING_TASK_STATUSES.has(task.status);
}

function deriveTaskBoundStatus(task: TaskState | undefined, agentId?: string): AgentRuntimeStatus {
  if (!task) return 'working';
  if (agentId && task.qaAgentId === agentId && task.status === 'review') return 'working';
  if (qaWaitingOnDev(task, agentId)) return 'waiting';
  if (WORKING_TASK_STATUSES.has(task.status)) return 'working';
  if (WAITING_TASK_STATUSES.has(task.status)) return 'waiting';
  if (ERROR_TASK_STATUSES.has(task.status)) return 'error';
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

async function loadPetAssignments(ctx: AgentSnapshotCtx): Promise<Record<string, string>> {
  if (!ctx.petStore) return {};
  try {
    return await ctx.petStore.listAssignments();
  } catch (err) {
    console.warn('[snapshot] failed to load pet assignments:', err);
    return {};
  }
}

async function loadPetAssignment(ctx: AgentSnapshotCtx, agentId: string): Promise<string | undefined> {
  if (!ctx.petStore) return undefined;
  try {
    return (await ctx.petStore.getAssignment(agentId)) ?? undefined;
  } catch (err) {
    console.warn(`[snapshot] failed to load pet assignment for ${agentId}:`, err);
    return undefined;
  }
}

export async function buildAllAgentSnapshots(ctx: AgentSnapshotCtx): Promise<AgentSnapshot[]> {
  const [bindings, bootstrapErrorsByAgent, petAssignments] = await Promise.all([
    ctx.agentStore.list(),
    loadLatestBootstrapByAgent(ctx),
    loadPetAssignments(ctx),
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
      petAssignments[configured.id],
    );
  }));
}

export async function buildAgentSnapshotById(
  ctx: AgentSnapshotCtx,
  id: string,
): Promise<AgentSnapshot | null> {
  const configured = ctx.agentManager.getAgentConfig(id);
  if (!configured) return null;
  const [binding, latestBootstrapError, petId] = await Promise.all([
    ctx.agentStore.get(id),
    loadLatestBootstrapError(ctx, id),
    loadPetAssignment(ctx, id),
  ]);
  const task = binding?.taskId ? await ctx.taskStore.get(binding.taskId) : null;
  return agentSnapshot(
    configured,
    binding ?? undefined,
    ctx.tmuxSessionStatusStore.get(id),
    task ?? undefined,
    latestBootstrapError,
    petId,
  );
}
