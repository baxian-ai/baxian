import type { AgentRole, TaskStatus } from './types.js';

export const DEFAULT_REVIEW_ROUNDS = 10;
export const DEFAULT_SERVER_PORT = 3000;

export const BRANCH_PREFIX = 'bx/';
export const WORKTREE_DIR = '.baxian-worktrees';
export const STATE_DIR = '.baxian';
export const CONFIG_FILE = 'baxian.json';

// Image input. Single source of truth shared by validation, routes, and UI hints.
export const IMAGE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_UPLOAD_ALLOWED_EXTS = ['png', 'jpg', 'gif', 'webp'] as const;
export const TASK_IMAGE_MAX_COUNT = 4;
// agent-host readable copy; just-in-time, OS-reclaimed.
export const AGENT_HOST_UPLOAD_DIR = '/tmp/baxian/upload';
// persistent server-side staging for entry B, under ${stateDir}/state/<this>.
export const TASK_IMAGE_STAGING_SUBDIR = 'task-images';
// Route bodyLimits sized so the max legal base64 payload clears the parser (see spec §2.3).
export const IMAGE_UPLOAD_ROUTE_BODY_LIMIT = 8 * 1024 * 1024;
export const TASK_CREATE_ROUTE_BODY_LIMIT = 32 * 1024 * 1024;
export const MAX_CONFIG_BACKUPS = 7;

// Server review mode: injected content sizing (spec §7) and exchange paths (spec §4).
export const DIFF_INLINE_THRESHOLD = 800;
export const DIFF_LARGE_THRESHOLD = 2000;
export const MAX_INLINE_CONTENT_BYTES = 10 * 1024;
export const MAX_READ_FILE_BYTES = 50 * 1024;
export const REVIEW_EXCHANGE_DIR = '.baxian/review';
export const SPEC_DOC_RELPATH = '.baxian/spec.md';

// User-level fallback under $HOME, used when cwd has no baxian.json.
// Mirrors the cwd-mode layout: `~/.baxian/config.json` is the config, `~/.baxian/`
// itself is the state dir (state/, locks/, events/ live directly under it).
// Same naming as the cwd-mode `./.baxian/` so users see one consistent label.
export const USER_CONFIG_REL = '.baxian/config.json';
export const USER_STATE_REL = '.baxian';

// Every dispatch action baxian can hand an agent. NOT the spec/code track
// (TaskPhase) — this is the work selector threaded through dispatch. The prompt
// builder is keyed on this union so a phase shipped without instructions is a
// compile error.
export type DispatchPhase =
  | 'develop'
  | 'code'
  | 'fix'
  | 'post-approve'
  | 'merge'
  | 'review'
  | 'recheck'
  | 'server-review'
  | 'server-recheck'
  | 'server-spec-review'
  | 'server-feedback'
  | 'server-after-done';

export const AGENT_PHASES: Record<AgentRole, Record<string, { skills: string[] }>> = {
  dev: {
    develop: { skills: ['baxian-rules', 'task-check', 'spells'] },
    fix: { skills: ['baxian-rules', 'pr-feedback', 'spells'] },
    'post-approve': { skills: ['baxian-rules', 'pr-feedback', 'spells'] },
    merge: { skills: ['baxian-rules', 'spells'] },
    code: { skills: ['baxian-rules', 'task-check', 'spells'] },
    'server-feedback': { skills: ['baxian-rules', 'server-feedback', 'spells'] },
    'server-after-done': { skills: ['baxian-rules', 'spells'] },
  },
  qa: {
    review: { skills: ['baxian-rules', 'pr-review', 'spells'] },
    recheck: { skills: ['baxian-rules', 'pr-recheck', 'spells'] },
    merge: { skills: ['baxian-rules', 'spells'] },
    'server-review': { skills: ['baxian-rules', 'server-review', 'spells'] },
    'server-recheck': { skills: ['baxian-rules', 'server-recheck', 'spells'] },
    'server-spec-review': { skills: ['baxian-rules', 'server-spec-review', 'spells'] },
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
  'server-review': ['review'],
  'server-recheck': ['review'],
  'server-spec-review': ['review'],
  'server-feedback': ['fixing'],
  'server-after-done': ['approved'],
};

export const PHASE_REQUIRES_AGENT_BOUND_TO_TASK: Record<string, boolean> = {
  develop: true,
  fix: true,
  'post-approve': true,
  review: false,
  recheck: false,
  merge: false,
  code: true,
  'server-review': false,
  'server-recheck': false,
  'server-spec-review': false,
  'server-feedback': true,
  'server-after-done': true,
};

// Terminal statuses — no auto transitions fire from these.
// max_rounds is NOT terminal: hitting the review cap pauses the task awaiting a
// human decision (mark complete / continue one round / cancel), not a dead end.
export const TASK_TERMINAL_STATUSES: readonly TaskStatus[] = [
  'merged',
  'done',
  'failed',
  'cancelled',
];

export const TASK_TERMINAL_STATUS_SET: ReadonlySet<TaskStatus> = new Set(TASK_TERMINAL_STATUSES);

// Active statuses — baxian is driving the task, or (max_rounds / ready /
// merge-ready) it is paused awaiting a human decision with resources still held.
export const TASK_ACTIVE_STATUSES: readonly TaskStatus[] = [
  'in_progress',
  'review',
  'fixing',
  'approved',
  'merge-ready',
  'ready',
  'max_rounds',
];

export const TASK_ACTIVE_STATUS_SET: ReadonlySet<TaskStatus> = new Set(TASK_ACTIVE_STATUSES);

// All known statuses — used to validate the `status` query filter.
export const TASK_STATUSES: readonly TaskStatus[] = [
  'pending',
  ...TASK_ACTIVE_STATUSES,
  ...TASK_TERMINAL_STATUSES,
];

export const TASK_STATUS_SET: ReadonlySet<TaskStatus> = new Set(TASK_STATUSES);

// Open = not terminal: the working set (active + pending). Realtime project-tasks
// frames carry only these; terminal tasks are paged lazily over REST.
export function isTaskOpen(status: TaskStatus): boolean {
  return !TASK_TERMINAL_STATUS_SET.has(status);
}

export const TASK_LIST_PAGE_SIZE = 20;
