import type { AgentRuntime, TaskStatus } from './types.js';

export const AGENT_RUNTIME_LABELS: Record<AgentRuntime, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

export function agentRuntimeLabel(runtime: AgentRuntime | undefined): string | null {
  return runtime ? AGENT_RUNTIME_LABELS[runtime] : null;
}

export function agentRuntimeTitle(id: string, runtime: AgentRuntime | undefined): string {
  const label = agentRuntimeLabel(runtime);
  return label ? `${id} (${label})` : id;
}

// Terminal statuses — no further state transitions fire from these. Only constant
// web needs from the original shared/constants.ts; server keeps the rest.
// max_rounds is NOT terminal: it pauses awaiting a human decision.
export const TASK_TERMINAL_STATUS_SET: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'merged',
  'done',
  'failed',
  'cancelled',
]);

// Active = baxian is driving the task, or (max_rounds) it is paused awaiting a
// human decision. Mirrors the server constant of the same name; the panel splits
// the open working set into 正在处理 vs 待处理 with it.
export const TASK_ACTIVE_STATUS_SET: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'in_progress',
  'review',
  'fixing',
  'approved',
  'merge-ready',
  'ready',
  'max_rounds',
]);

// Page size shared by the server query and the panel's client-side display paging.
export const TASK_LIST_PAGE_SIZE = 20;

// Client-side soft validation only — the server's magic-byte sniff is authoritative.
// Mirrors the server constants of the same name.
export const IMAGE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const TASK_IMAGE_MAX_COUNT = 4;
