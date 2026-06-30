import type { TaskStatus } from '../shared/index.js';

export const STATUS_BADGE_COLORS: Record<TaskStatus, string> = {
  pending: 'pill',
  in_progress: 'pill pill-live',
  review: 'pill pill-review',
  fixing: 'pill pill-warn',
  approved: 'pill pill-live',
  'merge-ready': 'pill pill-live',
  ready: 'pill pill-live',
  merged: 'pill pill-live',
  done: 'pill pill-live',
  failed: 'pill pill-warn',
  max_rounds: 'pill pill-warn',
  cancelled: 'pill',
};

const STATUS_DOT_COLORS: Record<TaskStatus, string> = {
  pending: 'bg-og-300',
  in_progress: 'bg-success',
  review: 'bg-accent',
  fixing: 'bg-warn',
  approved: 'bg-success',
  'merge-ready': 'bg-success',
  ready: 'bg-success',
  merged: 'bg-success',
  done: 'bg-success',
  failed: 'bg-warn',
  max_rounds: 'bg-warn',
  cancelled: 'bg-og-300',
};

export function TaskStatusDot({ status }: { status: TaskStatus }) {
  return (
    <span
      role="img"
      aria-label={status}
      title={status}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOT_COLORS[status] ?? 'bg-og-300'}`}
    />
  );
}

export function shortTaskId(id: string): string {
  if (!id) return '';
  const match = id.match(/^task-(\d+)$/);
  return match ? match[1] : id;
}

export function formatTaskTimestamp(value: unknown): string {
  if (value === null || value === undefined) return '';
  const normalized = String(value).trim();
  if (!normalized) return '';
  const match = normalized.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?/);
  if (match) return `${match[1]} ${match[2]}:${match[3] ?? '00'}`;

  const date = new Date(normalized);
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 19).replace('T', ' ');
  return normalized;
}

export function taskDetailPath(projectId: string, taskId: string): string {
  return `/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}`;
}
