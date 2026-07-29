import type { AgentRole, TaskPhase, TaskStatus } from './types.js';

export const DEFAULT_REVIEW_ROUNDS = 10;
export const DEFAULT_SERVER_PORT = 3000;
export const DEFAULT_SERVER_HOST = '127.0.0.1';
export const DEFAULT_GITHUB_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_TMUX_PROBE_POLL_INTERVAL_MS = 10_000;
export const DEFAULT_TMUX_PROBE_TIMEOUT_MS = 3_000;
export const DEFAULT_TMUX_PROBE_CONCURRENCY = 4;
export const DEFAULT_BOOTSTRAP_RETRY_INTERVAL_MS = 60_000;
export const DEFAULT_DISPATCH_RECONCILE_INTERVAL_MS = 30_000;
export const DEFAULT_DISPATCH_BUSY_WAIT_BUDGET_MS = 30 * 60_000;
export const DEFAULT_DISPATCH_RECONCILE_MAX_ATTEMPTS = 3;
export const TERMINAL_INTERVENTION_PHASES = ['attach', 'detach', 'input', 'close'] as const;
export const TERMINAL_INTERVENTION_PHASE_SET: ReadonlySet<string> = new Set(TERMINAL_INTERVENTION_PHASES);
export type TerminalInterventionPhase = (typeof TERMINAL_INTERVENTION_PHASES)[number];

export const DEFAULT_SERVER_CONFIG = {
  port: DEFAULT_SERVER_PORT,
  host: DEFAULT_SERVER_HOST,
  githubPollIntervalMs: DEFAULT_GITHUB_POLL_INTERVAL_MS,
  tmuxProbePollIntervalMs: DEFAULT_TMUX_PROBE_POLL_INTERVAL_MS,
  tmuxProbeTimeoutMs: DEFAULT_TMUX_PROBE_TIMEOUT_MS,
  tmuxProbeConcurrency: DEFAULT_TMUX_PROBE_CONCURRENCY,
  bootstrapRetryIntervalMs: DEFAULT_BOOTSTRAP_RETRY_INTERVAL_MS,
  dispatchReconcileIntervalMs: DEFAULT_DISPATCH_RECONCILE_INTERVAL_MS,
  dispatchBusyWaitBudgetMs: DEFAULT_DISPATCH_BUSY_WAIT_BUDGET_MS,
  dispatchReconcileMaxAttempts: DEFAULT_DISPATCH_RECONCILE_MAX_ATTEMPTS,
} as const;

export const BRANCH_PREFIX = 'bx/';
const BRANCH_NAME_RE = /^(?!-)[A-Za-z0-9._\/-]+$/;

export function isValidBranchName(name: string): boolean {
  if (!BRANCH_NAME_RE.test(name)) return false;
  if (name.includes('..') || name.includes('@{') || name === '@') return false;
  if (name.endsWith('/') || name.startsWith('/') || name.includes('//')) return false;
  if (name.endsWith('.')) return false;
  return name.split('/').every(p => !p.startsWith('.') && !p.endsWith('.lock'));
}
export const STATE_DIR = '.baxian';
export const CONFIG_FILE = 'baxian.json';

export const IMAGE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const TASK_IMAGE_MAX_COUNT = 4;
export const AGENT_HOST_UPLOAD_DIR = '/tmp/baxian/upload';
export const IMAGE_UPLOAD_ROUTE_BODY_LIMIT = 8 * 1024 * 1024;
export const TASK_CREATE_ROUTE_BODY_LIMIT = 32 * 1024 * 1024;
export const MAX_CONFIG_BACKUPS = 7;

export const PET_ATLAS_WIDTH = 1536;
export const PET_ATLAS_HEIGHT = 1872;
export const PET_DISPLAY_NAME_MAX = 80;
export const PET_DESCRIPTION_MAX = 500;
export const PET_SPRITESHEET_MAX_BYTES = 8 * 1024 * 1024;
export const PET_UPLOAD_ROUTE_BODY_LIMIT = 12 * 1024 * 1024;

export const MAX_INLINE_CONTENT_BYTES = 10 * 1024;

export const USER_CONFIG_REL = '.baxian/config.json';
export const USER_STATE_REL = '.baxian';

export const TOOL_PATTERN = /^[a-z][a-z0-9-]*$/;
export const CONTROL_CHAR_RE = /\p{Cc}/u;

export type DispatchPhase =
  | 'develop'
  | 'code'
  | 'fix'
  | 'post-approve'
  | 'merge'
  | 'review'
  | 'recheck';

export const AGENT_PHASES: Record<AgentRole, Record<string, { skills: string[] }>> = {
  dev: {
    develop: { skills: ['baxian-task-check'] },
    fix: { skills: ['baxian-pr-feedback'] },
    'post-approve': { skills: ['baxian-pr-feedback'] },
    merge: { skills: [] },
    code: { skills: ['baxian-task-check'] },
  },
  qa: {
    review: { skills: ['baxian-pr-review'] },
    recheck: { skills: ['baxian-pr-recheck'] },
    merge: { skills: [] },
  },
};

export const PHASE_EXPECTED_STATUS: Record<string, TaskStatus[]> = {
  develop: ['in_progress'],
  review: ['review'],
  recheck: ['review'],
  fix: ['fixing'],
  'post-approve': ['approved'],
  merge: ['approved', 'merge-ready', 'review'],
  code: ['in_progress'],
};

export const PHASE_REQUIRES_AGENT_BOUND_TO_TASK: Record<string, boolean> = {
  develop: true,
  fix: true,
  'post-approve': true,
  review: false,
  recheck: false,
  merge: false,
  code: true,
};

export const TASK_OWNER_ROLES: ReadonlySet<AgentRole> = new Set(['dev']);

export const TASK_TERMINAL_STATUSES: readonly TaskStatus[] = [
  'merged',
  'done',
  'failed',
  'cancelled',
];

export const TASK_TERMINAL_STATUS_SET: ReadonlySet<TaskStatus> = new Set(TASK_TERMINAL_STATUSES);

const TASK_ACTIVE_STATUSES: readonly TaskStatus[] = [
  'in_progress',
  'review',
  'fixing',
  'spec-ready',
  'approved',
  'merge-ready',
  'max_rounds',
];

export const TASK_ACTIVE_STATUS_SET: ReadonlySet<TaskStatus> = new Set(TASK_ACTIVE_STATUSES);

const TASK_STATUSES: readonly TaskStatus[] = [
  'pending',
  ...TASK_ACTIVE_STATUSES,
  ...TASK_TERMINAL_STATUSES,
];

export const TASK_STATUS_SET: ReadonlySet<TaskStatus> = new Set(TASK_STATUSES);
export const TASK_PHASE_SET: ReadonlySet<TaskPhase> = new Set(['spec', 'code']);

export function isTaskOpen(status: TaskStatus): boolean {
  return !TASK_TERMINAL_STATUS_SET.has(status);
}

export const TASK_LIST_PAGE_SIZE = 20;

export const REVIEW_VERDICT_TIMEOUT_MS = 10 * 60 * 1000;
