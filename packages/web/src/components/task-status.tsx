import type { TaskStatus } from '../shared/index.js';

// 展示用中文标签；内部状态值仍是英文枚举（aria/title 保留原值供排查）。
export const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: '待处理',
  in_progress: '进行中',
  review: '评审中',
  fixing: '修订中',
  'spec-ready': 'Spec 待批',
  approved: '已通过',
  'merge-ready': '待确认',
  ready: '待确认',
  merged: '已合并',
  done: '已完成',
  failed: '失败',
  max_rounds: '轮次达上限',
  cancelled: '已取消',
};

export function taskStatusLabel(status: TaskStatus): string {
  return STATUS_LABELS[status] ?? status;
}

// Color budget: accent marks "needs a human" only; activity/completion is ink, waiting is gray.
export const STATUS_BADGE_COLORS: Record<TaskStatus, string> = {
  pending: 'pill',
  in_progress: 'pill pill-live',
  review: 'pill pill-review',
  fixing: 'pill pill-live',
  'spec-ready': 'pill pill-warn',
  approved: 'pill pill-review',
  'merge-ready': 'pill pill-warn',
  ready: 'pill pill-warn',
  merged: 'pill pill-live',
  done: 'pill pill-live',
  failed: 'pill pill-warn',
  max_rounds: 'pill pill-warn',
  cancelled: 'pill',
};

const STATUS_DOT_COLORS: Record<TaskStatus, string> = {
  pending: 'bg-og-300',
  in_progress: 'bg-og-1000',
  review: 'bg-og-400',
  fixing: 'bg-og-1000',
  'spec-ready': 'bg-accent',
  approved: 'bg-og-400',
  'merge-ready': 'bg-accent',
  ready: 'bg-accent',
  merged: 'bg-og-1000',
  done: 'bg-og-1000',
  failed: 'bg-accent',
  max_rounds: 'bg-accent',
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

export function formatTaskTimestamp(value: unknown, withSeconds = true): string {
  if (value === null || value === undefined) return '';
  const normalized = String(value).trim();
  if (!normalized) return '';
  // space-separated "YYYY-MM-DD HH:mm" is implementation-defined for Date.parse
  // (Safari returns Invalid Date); normalize to the ISO 'T' form before parsing.
  const date = new Date(normalized.replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T'));
  if (Number.isNaN(date.getTime())) return normalized;
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return withSeconds ? `${day} ${time}:${pad(date.getSeconds())}` : `${day} ${time}`;
}

export function taskDetailPath(projectId: string, taskId: string): string {
  return `/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}`;
}
