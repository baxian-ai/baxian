import { readFile, writeFile, readdir, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskPhase, TaskState, TaskStatus } from '../shared/index.js';
import { isRecord, mapWithConcurrency, FS_READ_CONCURRENCY } from '../shared/index.js';

// a store id becomes a filename; constrain it so a path-like id can't escape the store dir
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export interface TaskFilter {
  projectId?: string;
  status?: TaskStatus;
}

const TASK_FIELDS = [
  'id', 'projectId', 'title', 'description', 'preferredAgentId',
  'agentId', 'devAgentId', 'qaAgentId', 'researchAgentId', 'prNumber', 'prUrl', 'branch', 'branchCreatedByBaxian', 'branchCleanupPending', 'branchCleanupSkipped', 'latestHeadSha', 'reviewHeadAnchorSha',
  'reviewDispatchedAt', 'prFeedbackReceivedAt', 'fixDispatchedAt', 'reviewRound', 'specReviewRound', 'phase', 'signalToken',
  'status', 'createdAt', 'updatedAt', 'images',
  'reviewMode', 'batchIndex', 'batchTotal', 'reviewCheckoutMode', 'maxRoundsContinues', 'afterDone', 'publishDispatchedAt',
  'verdictOverdue',
] as const;

const TASK_STATUSES = new Set<TaskStatus>([
  'pending', 'in_progress', 'review', 'fixing', 'spec-ready', 'approved', 'merge-ready',
  'ready', 'merged', 'done', 'max_rounds', 'failed', 'cancelled',
]);
const TASK_PHASES = new Set<TaskPhase>(['research', 'spec', 'code']);

function taskSchemaError(field: string, expected: string): Error {
  return new Error(`invalid task field "${field}": expected ${expected}`);
}

function requireString(raw: Record<string, unknown>, field: string, allowEmpty = false): void {
  const value = raw[field];
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw taskSchemaError(field, allowEmpty ? 'a string' : 'a non-empty string');
  }
}

function optionalString(raw: Record<string, unknown>, field: string): void {
  const value = raw[field];
  if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
    throw taskSchemaError(field, 'a non-empty string when present');
  }
}

function optionalInteger(raw: Record<string, unknown>, field: string, min = 0): void {
  const value = raw[field];
  if (value !== undefined && (!Number.isInteger(value) || (value as number) < min)) {
    throw taskSchemaError(field, `an integer >= ${min} when present`);
  }
}

function optionalBoolean(raw: Record<string, unknown>, field: string): void {
  const value = raw[field];
  if (value !== undefined && typeof value !== 'boolean') {
    throw taskSchemaError(field, 'a boolean when present');
  }
}

function validateCleanupPending(raw: Record<string, unknown>, field: string): void {
  const value = raw[field];
  if (value === undefined) return;
  if (!isRecord(value)) throw taskSchemaError(field, 'an object when present');
  for (const key of ['agentId', 'reason', 'updatedAt']) requireString(value, key);
}

function validateTask(raw: Record<string, unknown>): void {
  requireString(raw, 'id');
  requireString(raw, 'projectId');
  requireString(raw, 'title');
  requireString(raw, 'description', true);
  requireString(raw, 'preferredAgentId', true);
  requireString(raw, 'agentId', true);
  requireString(raw, 'devAgentId', true);
  requireString(raw, 'createdAt');
  requireString(raw, 'updatedAt');
  optionalString(raw, 'qaAgentId');
  optionalString(raw, 'researchAgentId');
  for (const field of [
    'prUrl', 'branch', 'latestHeadSha', 'reviewHeadAnchorSha', 'reviewDispatchedAt',
    'prFeedbackReceivedAt', 'fixDispatchedAt', 'signalToken', 'publishDispatchedAt',
  ]) optionalString(raw, field);
  if (!Number.isInteger(raw.reviewRound) || (raw.reviewRound as number) < 0) {
    throw taskSchemaError('reviewRound', 'an integer >= 0');
  }
  if (raw.phase !== undefined && (
    typeof raw.phase !== 'string' || !TASK_PHASES.has(raw.phase as TaskPhase)
  )) {
    throw taskSchemaError('phase', 'research, spec, or code when present');
  }
  if (typeof raw.status !== 'string' || !TASK_STATUSES.has(raw.status as TaskStatus)) {
    throw taskSchemaError('status', 'a known task status');
  }
  optionalInteger(raw, 'prNumber', 1);
  optionalInteger(raw, 'specReviewRound', 0);
  optionalInteger(raw, 'batchIndex', 0);
  optionalInteger(raw, 'batchTotal', 1);
  optionalInteger(raw, 'maxRoundsContinues', 0);
  for (const field of ['branchCreatedByBaxian', 'verdictOverdue']) optionalBoolean(raw, field);
  if (raw.images !== undefined && (
    !Array.isArray(raw.images)
    || raw.images.some(image => typeof image !== 'string' || image.trim() === '')
  )) {
    throw taskSchemaError('images', 'an array of non-empty strings when present');
  }
  if (raw.reviewMode !== undefined && raw.reviewMode !== 'github' && raw.reviewMode !== 'server') {
    throw taskSchemaError('reviewMode', 'github or server when present');
  }
  if (raw.reviewCheckoutMode !== undefined
    && raw.reviewCheckoutMode !== 'head' && raw.reviewCheckoutMode !== 'base') {
    throw taskSchemaError('reviewCheckoutMode', 'head or base when present');
  }
  if (raw.afterDone !== undefined && raw.afterDone !== null
    && raw.afterDone !== 'pr' && raw.afterDone !== 'branch') {
    throw taskSchemaError('afterDone', 'pr, branch, or null when present');
  }
  validateCleanupPending(raw, 'branchCleanupPending');
  validateCleanupPending(raw, 'branchCleanupSkipped');
  const participantIds = [raw.devAgentId, raw.qaAgentId, raw.researchAgentId]
    .filter((value): value is string => typeof value === 'string' && value !== '');
  if (new Set(participantIds).size !== participantIds.length) {
    throw taskSchemaError('participants', 'distinct dev, qa, and research agent ids');
  }
  if (raw.agentId !== '' && raw.agentId !== raw.devAgentId && raw.agentId !== raw.researchAgentId) {
    throw taskSchemaError('agentId', 'the task dev or research agent id');
  }
  if (raw.phase === 'research' && raw.researchAgentId === undefined) {
    throw taskSchemaError('researchAgentId', 'a non-empty string during research phase');
  }
  if (raw.phase === undefined && raw.researchAgentId !== undefined) {
    throw taskSchemaError('phase', 'research when a research participant is present');
  }
}

function sanitizeTask(state: unknown): TaskState {
  if (!isRecord(state)) throw new Error('invalid task: expected an object');
  const raw = state;
  const out: Partial<TaskState> = {};
  for (const k of TASK_FIELDS) {
    const value = raw[k];
    if (value !== undefined) {
      (out as Record<string, unknown>)[k] = value;
    }
  }
  validateTask(out as Record<string, unknown>);
  return out as TaskState;
}

export type TaskStoreChangeKind = 'set' | 'delete';
export type TaskStoreListener = (kind: TaskStoreChangeKind, taskId: string) => void;

export class TaskStore {
  private listeners = new Set<TaskStoreListener>();

  constructor(private dir: string) {}

  onChange(fn: TaskStoreListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async get(id: string): Promise<TaskState | null> {
    if (!SAFE_ID.test(id)) return null;
    let content: string;
    try {
      content = await readFile(this.path(id), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
      throw err;
    }
    // the filename is the store key; it overrides whatever id the file body carries
    return sanitizeTask({ ...(JSON.parse(content) as Record<string, unknown>), id });
  }

  async set(state: TaskState): Promise<void> {
    if (!SAFE_ID.test(state.id)) throw new Error(`invalid task id: ${state.id}`);
    const sanitized = sanitizeTask(state);
    const final = this.path(state.id);
    const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(sanitized, null, 2) + '\n');
    await rename(tmp, final);
    this.fire('set', state.id);
  }

  async list(filter?: TaskFilter): Promise<TaskState[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }
    const loaded = await mapWithConcurrency(
      files.filter(f => f.endsWith('.json')),
      FS_READ_CONCURRENCY,
      async (file) => {
        try {
          const content = await readFile(join(this.dir, file), 'utf-8');
          const raw = JSON.parse(content) as Record<string, unknown>;
          return sanitizeTask({ ...raw, id: file.slice(0, -'.json'.length) });
        } catch (err) {
          console.warn(`[TaskStore] skipping unreadable file ${file}:`, err);
          return null;
        }
      },
    );
    return loaded.filter((task): task is TaskState => {
      if (!task) return false;
      if (filter?.projectId && task.projectId !== filter.projectId) return false;
      if (filter?.status && task.status !== filter.status) return false;
      return true;
    });
  }

  // ids come from filenames, so the max scan never needs to read file contents
  async nextId(): Promise<string> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      files = [];
    }
    const maxNum = files.reduce((max, f) => {
      const match = f.match(/^task-(\d+)\.json$/);
      return match ? Math.max(max, parseInt(match[1], 10)) : max;
    }, 0);
    return `task-${String(maxNum + 1).padStart(3, '0')}`;
  }

  async delete(id: string): Promise<void> {
    if (!SAFE_ID.test(id)) return;
    try {
      await unlink(this.path(id));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT') {
        console.error(`[TaskStore] delete ${id} failed; not broadcasting:`, err);
        return;
      }
    }
    this.fire('delete', id);
  }

  private fire(kind: TaskStoreChangeKind, id: string): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(kind, id);
      } catch (err) {
        console.error(`[TaskStore] listener threw on ${kind} ${id}:`, err);
      }
    }
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }
}
