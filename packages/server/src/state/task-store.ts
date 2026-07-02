import { readFile, writeFile, readdir, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskState, TaskStatus } from '../shared/index.js';

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

type LegacyTaskShape = Partial<TaskState> & {
  issueNumber?: number;
  issueUrl?: string;
  specMarkerToken?: string;
};

function sanitizeTask(state: unknown): TaskState {
  const raw = (state ?? {}) as LegacyTaskShape;
  const out: Partial<TaskState> = {};
  for (const k of TASK_FIELDS) {
    const value = raw[k];
    if (value !== undefined) {
      (out as Record<string, unknown>)[k] = value;
    }
  }
  if (out.signalToken === undefined && typeof raw.specMarkerToken === 'string') {
    out.signalToken = raw.specMarkerToken;
  }

  if (typeof out.title !== 'string' || out.title.trim() === '') {
    const legacyIssue = raw.issueNumber;
    out.title = legacyIssue
      ? `(legacy) Issue #${legacyIssue}`
      : `(legacy) ${typeof out.id === 'string' ? out.id : 'unknown'}`;
  }
  if (typeof out.description !== 'string') {
    const legacyUrl = raw.issueUrl;
    out.description = legacyUrl
      ? `Migrated from ${legacyUrl}.`
      : '';
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
    let content: string;
    try {
      content = await readFile(this.path(id), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
      throw err;
    }
    return sanitizeTask(JSON.parse(content));
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
    const tasks: TaskState[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      let task: TaskState;
      try {
        const content = await readFile(join(this.dir, file), 'utf-8');
        const raw = JSON.parse(content);
        task = sanitizeTask(raw);
      } catch (err) {
        console.warn(`[TaskStore] skipping unreadable file ${file}:`, err);
        continue;
      }
      if (filter?.projectId && task.projectId !== filter.projectId) continue;
      if (filter?.status && task.status !== filter.status) continue;
      tasks.push(task);
    }
    return tasks;
  }

  async nextId(): Promise<string> {
    const tasks = await this.list();
    const maxNum = tasks.reduce((max, t) => {
      const match = t.id.match(/^task-(\d+)$/);
      return match ? Math.max(max, parseInt(match[1], 10)) : max;
    }, 0);
    return `task-${String(maxNum + 1).padStart(3, '0')}`;
  }

  async delete(id: string): Promise<void> {
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

  async migrateLegacyFiles(): Promise<{ migrated: number; failed: number }> {
    let migrated = 0;
    let failed = 0;
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return { migrated, failed };
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const fileId = file.slice(0, -'.json'.length);
      try {
        const content = await readFile(join(this.dir, file), 'utf-8');
        const raw = JSON.parse(content) as Record<string, unknown>;
        const needsMigration =
          'issueNumber' in raw
          || 'issueUrl' in raw
          || raw.id !== fileId
          || typeof raw.title !== 'string' || raw.title.trim() === ''
          || typeof raw.description !== 'string'
          || typeof raw.preferredAgentId !== 'string' || raw.preferredAgentId.trim() === '';
        if (needsMigration) {
          raw.id = fileId;
          await this.set(sanitizeTask(raw));
          migrated += 1;
        }
      } catch (err) {
        console.warn(`[TaskStore] migrateLegacyFiles skip ${file}:`, err);
        failed += 1;
      }
    }
    return { migrated, failed };
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }
}
