import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.ts';
import { TaskStatusBadge, getTaskAttentionCopy, shortTaskId, taskDetailPath } from './task-status.tsx';
import { useT } from '../i18n/index.tsx';
import { useToast } from './toast.tsx';
import {
  TASK_ACTIVE_STATUS_SET,
  TASK_LIST_PAGE_SIZE,
  isSpecStagePhase,
  needsGitReviewRecovery,
  type TaskState,
} from '../shared/index.js';

interface TaskPanelProps {
  projectId: string;
  openTasks: TaskState[];
  className?: string;
}

const DONE_EXPANDED_KEY = 'baxian.taskPanel.doneOpen';

function readDoneExpanded(): boolean {
  try {
    return localStorage.getItem(DONE_EXPANDED_KEY) === '1';
  } catch {
    return false;
  }
}

function taskIdNum(id: string): number {
  const match = id.match(/^task-(\d+)$/);
  return match ? parseInt(match[1], 10) : Number.NaN;
}

function byIdAsc(a: TaskState, b: TaskState): number {
  const na = taskIdNum(a.id);
  const nb = taskIdNum(b.id);
  if (Number.isNaN(na) || Number.isNaN(nb)) return a.id.localeCompare(b.id);
  return na - nb;
}

function byUpdatedDesc(a: TaskState, b: TaskState): number {
  const cmp = (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
  if (cmp !== 0) return cmp;
  const na = taskIdNum(a.id);
  const nb = taskIdNum(b.id);
  if (Number.isNaN(na) || Number.isNaN(nb)) return b.id.localeCompare(a.id);
  return nb - na;
}

function useLiveSection(all: TaskState[], projectId: string) {
  const [visible, setVisible] = useState(TASK_LIST_PAGE_SIZE);
  useEffect(() => setVisible(TASK_LIST_PAGE_SIZE), [projectId]);
  const items = all.slice(0, visible);
  const hasMore = all.length > items.length;
  const loadMore = () => setVisible((v) => v + TASK_LIST_PAGE_SIZE);
  return { items, hasMore, loadMore, total: all.length };
}

interface DoneState {
  items: TaskState[];
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  load: (mode: 'first' | 'more') => void;
}

function useDoneSection(projectId: string): DoneState {
  const [items, setItems] = useState<TaskState[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const offsetRef = useRef(0);

  const load = useCallback(
    (mode: 'first' | 'more') => {
      const requestId = ++requestRef.current;
      const offset = mode === 'first' ? 0 : offsetRef.current;
      setLoading(true);
      setError(null);
      void api.tasks.page(projectId, { category: 'done', offset }).then(
        (page) => {
          if (requestRef.current !== requestId) return;
          setItems((prev) => (mode === 'first' ? page.tasks : [...prev, ...page.tasks]));
          setHasMore(page.hasMore);
          offsetRef.current = page.nextOffset;
          setLoaded(true);
          setLoading(false);
        },
        (err) => {
          if (requestRef.current !== requestId) return;
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        },
      );
    },
    [projectId],
  );

  useEffect(() => {
    requestRef.current += 1;
    offsetRef.current = 0;
    setItems([]);
    setHasMore(false);
    setLoaded(false);
    setError(null);
    setLoading(false);
  }, [projectId]);

  return { items, hasMore, loading, loaded, error, load };
}

export function TaskPanel({ projectId, openTasks, className = '' }: TaskPanelProps) {
  const t = useT();
  const activeAll = useMemo(
    () => openTasks.filter((t) => TASK_ACTIVE_STATUS_SET.has(t.status)).sort(byUpdatedDesc),
    [openTasks],
  );
  const pendingAll = useMemo(
    () => openTasks.filter((t) => t.status === 'pending').sort(byIdAsc),
    [openTasks],
  );
  const active = useLiveSection(activeAll, projectId);
  const pending = useLiveSection(pendingAll, projectId);
  const done = useDoneSection(projectId);
  const [doneExpanded, setDoneExpanded] = useState(readDoneExpanded);

  useEffect(() => {
    try {
      localStorage.setItem(DONE_EXPANDED_KEY, doneExpanded ? '1' : '0');
    } catch {
    }
  }, [doneExpanded]);

  useEffect(() => {
    if (doneExpanded) done.load('first');
  }, [doneExpanded, done.load]);

  const toggleDone = () => setDoneExpanded((v) => !v);

  return (
    <aside
      aria-label={t.taskPanel.ariaLabel}
      className={`flex flex-col rounded-lg border border-hairline bg-surface ${className}`}
    >
      <div>
        <LiveSection title={t.taskPanel.inProgressTitle} section={active} emptyHint={t.taskPanel.emptyInProgress} />
        <LiveSection title={t.taskPanel.pendingTitle} section={pending} emptyHint={t.taskPanel.emptyPending} />

        <div>
          <button
            type="button"
            onClick={toggleDone}
            aria-expanded={doneExpanded}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-normal uppercase tracking-[0.05em] text-og-500 transition-colors hover:bg-og-50/40"
          >
            <span>{t.taskPanel.doneTitle}</span>
            <span className="font-normal normal-case text-accent">{doneExpanded ? t.taskPanel.collapse : t.taskPanel.view}</span>
          </button>
          {doneExpanded && <DoneBody state={done} />}
        </div>
      </div>
    </aside>
  );
}

function LiveSection({
  title,
  section,
  emptyHint,
}: {
  title: string;
  section: { items: TaskState[]; hasMore: boolean; loadMore: () => void; total: number };
  emptyHint: string;
}) {
  const t = useT();
  return (
    <section aria-label={title} className="border-b border-hairline">
      <div className="px-3 py-2 text-xs font-normal uppercase tracking-[0.05em] text-og-500">
        {title} <span className="text-og-400">({section.total})</span>
      </div>
      {section.items.length === 0 ? (
        <div className="px-3 pb-3 text-xs text-og-400">{emptyHint}</div>
      ) : (
        <div className="divide-y divide-hairline">
          {section.items.map((task) => <TaskRow key={task.id} task={task} />)}
          {section.hasMore && (
            <button
              type="button"
              onClick={section.loadMore}
              className="w-full px-3 py-2 text-center text-xs text-accent transition-colors hover:bg-og-50/40"
            >
              {t.taskPanel.loadMore}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function DoneBody({ state }: { state: DoneState }) {
  const t = useT();
  const showEmpty = state.loaded && !state.error && state.items.length === 0;
  return (
    <div className="divide-y divide-hairline">
      {state.items.map((task) => <TaskRow key={task.id} task={task} />)}
      {state.error && <div className="px-3 py-2 text-xs text-accent">{t.common.loadFailed(state.error)}</div>}
      {showEmpty && <div className="px-3 pb-3 pt-1 text-xs text-og-400">{t.taskPanel.emptyDone}</div>}
      {state.loading && state.items.length === 0 && (
        <div className="px-3 py-3 text-center text-xs text-og-400">{t.common.loading}</div>
      )}
      {state.hasMore && (
        <button
          type="button"
          onClick={() => state.load('more')}
          disabled={state.loading}
          className="w-full px-3 py-2 text-center text-xs text-accent transition-colors hover:bg-og-50/40 disabled:opacity-50"
        >
          {state.loading ? t.common.loading : t.taskPanel.loadMore}
        </button>
      )}
    </div>
  );
}

function TaskRow({ task }: { task: TaskState }) {
  const t = useT();
  const navigate = useNavigate();
  const { show } = useToast();
  const [advancing, setAdvancing] = useState(false);
  const round = isSpecStagePhase(task.phase) ? (task.specReviewRound ?? 0) : task.reviewRound;
  const isUnassignedPending = task.status === 'pending' && task.preferredAgentId === '';
  const advanceLabel = isUnassignedPending
    ? t.taskDetail.editTask
    : task.status === 'pending'
      ? t.taskDetail.startTask
      : task.status === 'review'
        ? t.taskDetail.restartReview
        : task.status === 'approved'
          ? t.taskDetail.retryPreMergeCheck
          : t.taskDetail.retryCurrentStep;
  const attentionCopy = task.attention ? getTaskAttentionCopy(t, task.attention) : null;
  const openTask = () => navigate(taskDetailPath(task.projectId, task.id));
  const advance = async () => {
    if (isUnassignedPending
      || task.postApproveRevoked
      || (task.status === 'review' && needsGitReviewRecovery(task))) {
      openTask();
      return;
    }
    setAdvancing(true);
    try {
      await api.tasks.advance(task.id);
      show({ kind: 'success', title: t.taskDetail.advanceSucceededTitle });
    } catch (err) {
      show({
        kind: 'error',
        title: t.taskDetail.advanceFailedTitle,
        body: t.taskDetail.actionFailedBody,
        details: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setAdvancing(false);
    }
  };
  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <button type="button" onClick={openTask} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span className="shrink-0 font-mono text-xs text-og-500" title={task.id}>{shortTaskId(task.id)}</span>
          <span className="min-w-0 flex-1 truncate text-og-1000" title={task.title}>{task.title}</span>
          {round > 0 && (
            <span aria-label={t.agents.round(round)} className="shrink-0 text-xs text-og-400">
              {t.taskPanel.round(round)}
            </span>
          )}
          <TaskStatusBadge task={task} className="shrink-0" />
        </button>
      </div>
      {task.attention && attentionCopy && (
        <div className="mt-2 rounded border border-accent/25 bg-accent-soft/60 px-2 py-1.5 text-xs text-accent">
          <button type="button" onClick={openTask} className="block w-full text-left">
            <span className="font-medium">{attentionCopy.title}</span>
            <span className="mt-0.5 block text-og-700">{attentionCopy.guidance}</span>
          </button>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {task.attention.recommendedActions.map(action => (
              <button
                key={action}
                type="button"
                disabled={action === 'advance' && advancing}
                onClick={() => action === 'advance' ? void advance() : openTask()}
                className={action === 'advance' ? 'btn-primary' : 'btn-secondary'}
              >
                {action === 'advance'
                  ? advancing ? t.taskDetail.advancing : advanceLabel
                  : action === 'verdict'
                    ? t.taskDetail.handleReview
                    : action === 'cancel'
                      ? t.taskDetail.cancelConfirmLabel
                      : t.taskDetail.retryTask}
              </button>
            ))}
          </div>
          <details className="mt-1.5 text-og-500">
            <summary className="cursor-pointer select-none text-accent">{t.common.technicalDetails}</summary>
            <div className="mt-1 whitespace-pre-wrap break-words font-mono">
              {task.attention.reason}{'\n'}{task.attention.runbook}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
