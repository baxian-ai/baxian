import { readFile, writeFile, readdir, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskState, TaskStatus } from '../shared/index.js';
import { mapWithConcurrency, FS_READ_CONCURRENCY } from '../shared/index.js';

// a store id becomes a filename; constrain it so a path-like id can't escape the store dir
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export interface TaskFilter {
  projectId?: string;
  status?: TaskStatus;
}

const TASK_FIELDS = [
  'id', 'projectId', 'title', 'description', 'preferredAgentId',
  'agentId', 'qaAgentId', 'prNumber', 'prUrl', 'branch', 'latestHeadSha', 'reviewHeadAnchorSha',
  'reviewDispatchedAt', 'prFeedbackReceivedAt', 'fixDispatchedAt', 'reviewRound', 'specReviewRound', 'phase', 'signalToken',
  'status', 'createdAt', 'updatedAt', 'images',
  'reviewMode', 'batchIndex', 'batchTotal', 'maxRoundsContinues', 'afterDone', 'publishDispatchedAt',
] as const;

function sanitizeTask(state: unknown): TaskState {
  const raw = (state ?? {}) as Partial<TaskState> & { specMarkerToken?: string };
  const out: Partial<TaskState> = {};
  for (const k of TASK_FIELDS) {
    const value = raw[k];
    if (value !== undefined) {
      (out as Record<string, unknown>)[k] = value;
    }
  }
  // dormant pre-rename task files on disk still carry specMarkerToken; map it on read
  if (out.signalToken === undefined && typeof raw.specMarkerToken === 'string') {
    out.signalToken = raw.specMarkerToken;
  }

  if (typeof out.title !== 'string' || out.title.trim() === '') {
    out.title = typeof out.id === 'string' ? out.id : 'unknown';
  }
  if (typeof out.description !== 'string') {
    out.description = '';
  }
  if (typeof out.preferredAgentId !== 'string' || out.preferredAgentId.trim() === '') {
    const fallback = typeof out.agentId === 'string' ? out.agentId.trim() : '';
    out.preferredAgentId = fallback;
  }

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
