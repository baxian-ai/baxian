import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.ts';
import { TaskStatusDot, shortTaskId, taskDetailPath } from './task-status.tsx';
import { TASK_ACTIVE_STATUS_SET, REVIEW_VERDICT_TIMEOUT_MS, TASK_LIST_PAGE_SIZE, type TaskState } from '../shared/index.js';

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
      aria-label="Task 面板"
      className={`flex flex-col rounded-lg border border-hairline bg-surface ${className}`}
    >
      <div>
        <LiveSection title="IN PROGRESS" section={active} emptyHint="暂无正在处理的任务" />
        <LiveSection title="PENDING" section={pending} emptyHint="暂无待处理的任务" />

        <div>
          <button
            type="button"
            onClick={toggleDone}
            aria-expanded={doneExpanded}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-[12px] font-normal uppercase tracking-[0.05em] text-og-500 transition-colors hover:bg-og-50/40"
          >
            <span>DONE</span>
            <span className="font-normal normal-case text-accent">{doneExpanded ? '收起' : '查看'}</span>
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
  return (
    <section aria-label={title} className="border-b border-hairline">
      <div className="px-3 py-2 text-[12px] font-normal uppercase tracking-[0.05em] text-og-500">
        {title} <span className="text-og-400">({section.total})</span>
      </div>
      {section.items.length === 0 ? (
        <div className="px-3 pb-3 text-[13px] text-og-400">{emptyHint}</div>
      ) : (
        <div className="divide-y divide-hairline">
          {section.items.map((task) => <TaskRow key={task.id} task={task} />)}
          {section.hasMore && (
            <button
              type="button"
              onClick={section.loadMore}
              className="w-full px-3 py-2 text-center text-[13px] text-accent transition-colors hover:bg-og-50/40"
            >
              加载更多
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function DoneBody({ state }: { state: DoneState }) {
  const showEmpty = state.loaded && !state.error && state.items.length === 0;
  return (
    <div className="divide-y divide-hairline">
      {state.items.map((task) => <TaskRow key={task.id} task={task} />)}
      {state.error && <div className="px-3 py-2 text-[13px] text-danger">加载失败：{state.error}</div>}
      {showEmpty && <div className="px-3 pb-3 pt-1 text-[13px] text-og-400">暂无已处理的任务</div>}
      {state.loading && state.items.length === 0 && (
        <div className="px-3 py-3 text-center text-[13px] text-og-400">加载中…</div>
      )}
      {state.hasMore && (
        <button
          type="button"
          onClick={() => state.load('more')}
          disabled={state.loading}
          className="w-full px-3 py-2 text-center text-[13px] text-accent transition-colors hover:bg-og-50/40 disabled:opacity-50"
        >
          {state.loading ? '加载中…' : '加载更多'}
        </button>
      )}
    </div>
  );
}

function useVerdictOverdue(task: TaskState): boolean {
  const [overdue, setOverdue] = useState(false);
  useEffect(() => {
    function check() {
      if (task.status !== 'review' || !task.reviewDispatchedAt || !task.qaAgentId) {
        setOverdue(false);
        return;
      }
      setOverdue(Date.now() - Date.parse(task.reviewDispatchedAt) >= REVIEW_VERDICT_TIMEOUT_MS);
    }
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, [task.status, task.reviewDispatchedAt, task.qaAgentId]);
  return overdue;
}

function TaskRow({ task }: { task: TaskState }) {
  const navigate = useNavigate();
  const round = task.phase === 'spec' ? (task.specReviewRound ?? 0) : task.reviewRound;
  const overdue = useVerdictOverdue(task);
  return (
    <button
      type="button"
      onClick={() => navigate(taskDetailPath(task.projectId, task.id))}
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-[14px] transition-colors hover:bg-og-50/60"
    >
      <span className="shrink-0 font-mono text-[12px] text-og-500" title={task.id}>{shortTaskId(task.id)}</span>
      <span className="min-w-0 flex-1 truncate text-og-1000" title={task.title}>{task.title}</span>
      {task.phase === 'spec' && <span className="pill pill-review shrink-0">spec</span>}
      {overdue && <span className="pill pill-warn shrink-0" title="Review verdict missing">!</span>}
      <span aria-label={`Round ${round}`} className="shrink-0 text-[12px] text-og-400">R{round}</span>
      <TaskStatusDot status={task.status} />
    </button>
  );
}
