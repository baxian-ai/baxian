import type { TaskPhase, TaskState, TaskStatus } from '../shared/index.js';
import { getMessages, useT } from '../i18n/index.tsx';

interface TaskStatusContext {
  status: TaskStatus;
  phase?: TaskPhase;
  preferredAgentId?: string;
}

function resolveTaskStatusLabel(
  messages: ReturnType<typeof getMessages>,
  input: TaskStatus | TaskStatusContext,
): string {
  const context = typeof input === 'string' ? { status: input } : input;
  const { status, phase } = context;

  if (status === 'pending' && context.preferredAgentId === '') {
    return messages.statusContext.pendingUnassigned;
  }
  if (status === 'in_progress') {
    if (phase === 'spec') return messages.statusContext.inProgressSpec;
    if (phase === 'code') return messages.statusContext.inProgressCode;
  }
  if (status === 'review') {
    if (phase === 'spec') return messages.statusContext.reviewSpec;
    if (phase === 'code') return messages.statusContext.reviewCode;
  }
  if (status === 'fixing') {
    if (phase === 'spec') return messages.statusContext.fixingSpec;
    if (phase === 'code') return messages.statusContext.fixingCode;
  }
  if (status === 'max_rounds') {
    if (phase === 'spec') return messages.statusContext.maxRoundsSpec;
    if (phase === 'code') return messages.statusContext.maxRoundsCode;
  }
  return messages.status[status] ?? status;
}

export function taskStatusLabel(input: TaskStatus | TaskStatusContext): string {
  return resolveTaskStatusLabel(getMessages(), input);
}

export function getTaskAttentionCopy(
  messages: ReturnType<typeof getMessages>,
  attention: NonNullable<TaskState['attention']>,
): { title: string; guidance: string } {
  const { reason, recommendedActions } = attention;
  const title = /confirm-merge|post-approve|merge/.test(reason)
    ? messages.taskDetail.attentionMergeTitle
    : /review|verdict/.test(reason)
      ? messages.taskDetail.attentionReviewTitle
      : /runtime|session|recovery|tmux|repl/.test(reason)
        ? messages.taskDetail.attentionAgentTitle
        : /dispatch|delivery|pr-created/.test(reason)
          ? messages.taskDetail.attentionHandoffTitle
          : messages.taskDetail.attentionDefaultTitle;
  const guidance = recommendedActions.includes('verdict')
    ? messages.taskDetail.attentionVerdictGuidance
    : recommendedActions.includes('advance')
      ? messages.taskDetail.attentionAdvanceGuidance
      : recommendedActions.includes('retry')
        ? messages.taskDetail.attentionRetryGuidance
        : messages.taskDetail.attentionCancelGuidance;
  return { title, guidance };
}

export const STATUS_BADGE_COLORS: Record<TaskStatus, string> = {
  pending: 'pill',
  in_progress: 'pill pill-live',
  review: 'pill pill-review',
  fixing: 'pill pill-warn',
  'spec-ready': 'pill pill-warn',
  approved: 'pill pill-live',
  'merge-ready': 'pill pill-warn',
  merged: 'pill pill-live',
  done: 'pill pill-live',
  failed: 'pill pill-danger',
  max_rounds: 'pill pill-warn',
  cancelled: 'pill',
};

export function TaskStatusBadge({
  task,
  className = '',
}: {
  task: TaskStatusContext;
  className?: string;
}) {
  const messages = useT();
  const label = resolveTaskStatusLabel(messages, task);
  return (
    <span
      className={`${STATUS_BADGE_COLORS[task.status] ?? 'pill'} ${className}`}
      title={label}
      data-status={task.status}
    >
      {label}
    </span>
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
