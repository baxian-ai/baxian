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

export const TASK_TERMINAL_STATUS_SET: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'merged',
  'done',
  'failed',
  'cancelled',
]);

export const TASK_ACTIVE_STATUS_SET: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'in_progress',
  'review',
  'fixing',
  'approved',
  'merge-ready',
  'ready',
  'max_rounds',
]);

export const TASK_LIST_PAGE_SIZE = 20;

export const IMAGE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const TASK_IMAGE_MAX_COUNT = 4;

export const REVIEW_VERDICT_TIMEOUT_MS = 10 * 60 * 1000;

export const PET_ATLAS_WIDTH = 1536;
export const PET_ATLAS_HEIGHT = 1872;
export const PET_GRID_COLS = 8;
export const PET_GRID_ROWS = 9;
export const PET_CELL_WIDTH = 192;
export const PET_CELL_HEIGHT = 208;
export const PET_SPRITESHEET_MAX_BYTES = 8 * 1024 * 1024;
