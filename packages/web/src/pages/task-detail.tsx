import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.ts';
import { AgentCard } from '../components/agent-card.tsx';
import { CreateTaskModal } from '../components/create-task-modal.tsx';
import { ReviewConversation } from '../components/review-conversation.tsx';
import { useToast } from '../components/toast.tsx';
import { STATUS_BADGE_COLORS, formatTaskTimestamp, taskDetailPath } from '../components/task-status.tsx';
import { useAgents, useTask } from '../hooks/use-events.ts';
import { useProjects } from '../hooks/use-projects.ts';
import {
  REVIEW_VERDICT_TIMEOUT_MS,
  TASK_TERMINAL_STATUS_SET,
  type AgentConfig,
  type AgentSnapshot,
  type ReviewRound,
  type TaskState,
} from '../shared/index.js';

const RETRYABLE_STATUSES = TASK_TERMINAL_STATUS_SET;

function useVerdictOverdue(task: TaskState | null): boolean {
  const [overdue, setOverdue] = useState(false);
  useEffect(() => {
    function check() {
      if (!task || task.status !== 'review' || !task.reviewDispatchedAt || !task.qaAgentId) {
        setOverdue(false);
        return;
      }
      const elapsed = Date.now() - Date.parse(task.reviewDispatchedAt);
      setOverdue(elapsed >= REVIEW_VERDICT_TIMEOUT_MS);
    }
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, [task?.status, task?.reviewDispatchedAt, task?.qaAgentId]);
  return overdue;
}

function branchTreeUrl(prUrl: string | undefined, branch: string): string | null {
  if (!prUrl || !branch) return null;
  const base = prUrl.match(/^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/\d+/);
  if (!base) return null;
  const path = branch.split('/').map(encodeURIComponent).join('/');
  return `${base[1]}/tree/${path}`;
}

export function TaskDetail() {
  const { taskId = '' } = useParams<{ id: string; taskId: string }>();
  // key on taskId so switching tasks on this shared route remounts with fresh
  // per-task state (override/edit/busy) instead of leaking the previous task's.
  return <TaskDetailView key={taskId} taskId={taskId} />;
}

function TaskDetailView({ taskId }: { taskId: string }) {
  const navigate = useNavigate();
  const { show } = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [override, setOverride] = useState<TaskState | null>(null);
  const { data: streamed, loaded, error: errorPayload } = useTask(taskId);
  const { projects } = useProjects();
  const { data: agents, loaded: agentsLoaded, error: agentsErrorPayload } = useAgents();
  const task = override ?? streamed;
  const verdictOverdue = useVerdictOverdue(task);
  const error = errorPayload?.message ?? null;
  const agentsById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent])),
    [agents],
  );

  useEffect(() => {
    if (override && streamed && streamed.updatedAt >= override.updatedAt) {
      setOverride(null);
    }
  }, [override, streamed]);

  const commitTaskExternal = (updated: TaskState) => {
    setOverride(updated);
  };

  const handleCancel = async () => {
    if (!task) return;
    if (!confirm(`确定取消 task ${task.id}？`)) return;
    setCancelling(true);
    try {
      const updated = await api.tasks.update(task.id, { status: 'cancelled' });
      commitTaskExternal(updated);
      show({ kind: 'success', title: '任务已取消' });
    } catch (err) {
      show({ kind: 'error', title: '取消失败', body: err instanceof Error ? err.message : String(err) });
    } finally {
      setCancelling(false);
    }
  };

  const handleReview = async () => {
    if (!task) return;
    const isTerminal = TASK_TERMINAL_STATUS_SET.has(task.status);
    const prompt = isTerminal
      ? `task ${task.id} 已是 ${task.status} 状态。手动请 QA 重审会再跑一轮 review，但状态机不会把 QA 结果带回主流程。继续？`
      : `请 QA 重审 task ${task.id}？这会让 QA agent 立即开始新一轮 review（reviewRound +1）。`;
    if (!confirm(prompt)) return;
    setReviewing(true);
    try {
      const updated = await api.tasks.review(task.id);
      commitTaskExternal(updated);
      show({ kind: 'success', title: `已派 QA 重审 (round ${updated.reviewRound})` });
    } catch (err) {
      show({ kind: 'error', title: 'Review 派发失败', body: err instanceof Error ? err.message : String(err) });
    } finally {
      setReviewing(false);
    }
  };

  const handleRetry = async () => {
    if (!task) return;
    const prompt = task.status === 'merged'
      ? `task ${task.id} 已 merged。Retry 会用同样的标题/描述新建一个 task 从头跑，确定继续？`
      : `Retry task ${task.id}？这会新建一个 task 从头开始，旧 task 保留为历史。`;
    if (!confirm(prompt)) return;
    setRetrying(true);
    try {
      const fresh = await api.tasks.retry(task.id);
      show({ kind: 'success', title: `已新建 task ${fresh.id}` });
      navigate(taskDetailPath(fresh.projectId, fresh.id));
    } catch (err) {
      show({ kind: 'error', title: 'Retry 失败', body: err instanceof Error ? err.message : String(err) });
    } finally {
      setRetrying(false);
    }
  };

  const handleComplete = async () => {
    if (!task) return;
    if (!confirm(`将合并 PR #${task.prNumber} 并收尾（删本地分支 + 压缩 agent 上下文），确定？`)) return;
    setCompleting(true);
    try {
      const updated = await api.tasks.complete(task.id);
      commitTaskExternal(updated);
      show({ kind: 'success', title: '已标记完成，开始收尾' });
    } catch (err) {
      show({ kind: 'error', title: '标记完成失败', body: err instanceof Error ? err.message : String(err) });
    } finally {
      setCompleting(false);
    }
  };

  const handleContinue = async () => {
    if (!task) return;
    if (!confirm(`派 dev 再修一轮（round → ${task.reviewRound + 1}），完成后自动转 QA review？`)) return;
    setContinuing(true);
    try {
      const updated = await api.tasks.continue(task.id);
      commitTaskExternal(updated);
      show({ kind: 'success', title: `已继续一轮 (round ${updated.reviewRound})` });
    } catch (err) {
      show({ kind: 'error', title: '继续一轮失败', body: err instanceof Error ? err.message : String(err) });
    } finally {
      setContinuing(false);
    }
  };

  const handleConfirmGate = async () => {
    if (!task) return;
    if (!confirm(`确认完成 task ${task.id}？project.merge 为 auto 时由 baxian 自动执行合并。`)) return;
    setCompleting(true);
    try {
      const updated = await api.tasks.complete(task.id);
      commitTaskExternal(updated);
      show({ kind: 'success', title: `已确认（${updated.status}）` });
    } catch (err) {
      show({ kind: 'error', title: '确认失败', body: err instanceof Error ? err.message : String(err) });
    } finally {
      setCompleting(false);
    }
  };

  return (
    <div>
      <button type="button" onClick={() => navigate(-1)} className="btn-ghost mb-3">
        ← 返回
      </button>
      {error && !task && <div className="text-sm text-danger">Error: {error}</div>}
      {loaded && !task && !error && <div className="text-sm text-danger">Task not found: {taskId}</div>}
      {!task && !error && !loaded && <div className="text-sm text-og-500">Loading…</div>}
      {task && (
        <>
          <div className="mb-4">
            <h1 className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 font-mono text-base text-og-400">{task.id}</span>
              <span className="min-w-0 truncate font-display text-base font-semibold tracking-tight text-og-1000" title={task.title}>
                {task.title}
              </span>
            </h1>
          </div>

          <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
            <section className="min-w-0">{renderInfo(task)}</section>
            <aside className="min-w-0 space-y-4">{renderAgents(task)}</aside>
          </div>
        </>
      )}

      {editOpen && task && (
        <CreateTaskModal
          mode="edit"
          open
          onClose={() => setEditOpen(false)}
          task={task}
          onUpdated={commitTaskExternal}
        />
      )}
    </div>
  );

  function renderInfo(task: TaskState) {
    const isLegacy = task.preferredAgentId === '';
    const showApprovedAction = task.status === 'approved' && task.prNumber !== undefined;
    const showMergeReadyAction = task.status === 'merge-ready' && task.prNumber !== undefined;
    const showReadyGate = task.status === 'ready';
    const showCodeMaxRounds = task.status === 'max_rounds' && task.phase !== 'spec';
    const showSpecMaxRounds = task.status === 'max_rounds' && task.phase === 'spec';
    const branchUrl = branchTreeUrl(task.prUrl, task.branch ?? '');

    return (
      <div>
        {error && <div className="mb-4 text-sm text-danger">Error: {error}</div>}
        {isLegacy && (
          <div className="mb-4 rounded-md border border-[#fde68a] bg-[#fef3c7]/60 px-3 py-2.5 text-xs text-warn">
            {task.status === 'pending'
              ? <>This task has no dev assigned yet — click <b className="font-semibold">Edit</b> to choose one, or use the Start button on any idle dev card.</>
              : <>This is a legacy task with no preferred dev (read-only in status <b className="font-semibold">{task.status}</b>).</>}
          </div>
        )}

        <div className="mb-3 flex flex-wrap items-center gap-3">
          <span className={`${STATUS_BADGE_COLORS[task.status]} text-sm`}>{task.status}</span>
          <span className="text-sm text-og-500">Round <span className="font-semibold text-og-800">{task.reviewRound}</span></span>
          <span className="text-sm text-og-500">Spec <span className="font-semibold text-og-800">{task.specReviewRound ?? 0}</span></span>
        </div>
        <div className="mb-4 flex flex-wrap items-center gap-2">{renderActions(task)}</div>
        <div className="mb-4 text-xs text-og-500">
          Created at {formatTaskTimestamp(task.createdAt, false)}, Updated at {formatTaskTimestamp(task.updatedAt, false)}
        </div>

        {verdictOverdue && (
          <div className="mb-4 rounded-lg border border-[#fecaca] bg-[#fef2f2] p-4 text-sm text-danger">
            <div className="font-semibold">Review verdict missing</div>
            <div className="mt-1 text-og-700">
              QA dispatched at {formatTaskTimestamp(task.reviewDispatchedAt)} 超过 10 分钟未提交 verdict。
              可能原因：QA agent 上下文压缩后误报已完成、agent 卡住、或 GitHub API 异常。
            </div>
            <div className="mt-2 text-og-700">
              建议：打开 QA terminal 检查实际状态，或手动 Call review 重新派发。
            </div>
          </div>
        )}

        {showApprovedAction && (
          <div className="mb-4 rounded-lg border border-[#bbf7d0] bg-[#f0fdf4] p-4 text-sm text-success">
            <div className="font-semibold">QA approved · verifying feedback</div>
            <div className="mt-1 text-og-700">
              Dev keeps the task reserved while it checks whether all human or agent feedback has been handled.
            </div>
            {task.prUrl && (
              <a
                href={task.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary mt-3 !border-[#bbf7d0] !text-success hover:!bg-[#dcfce7] hover:!border-success"
              >
                Open PR #{task.prNumber}
              </a>
            )}
          </div>
        )}

        {showReadyGate && (
          <div className="mb-4 rounded-lg border border-[#bbf7d0] bg-[#f0fdf4] p-4 text-sm text-success">
            <div className="font-semibold">✅ 评审通过 · 等待人工确认</div>
            <div className="mt-1 text-og-700">
              Server review 完成（{task.reviewRound} 轮）。点击「确认」收尾
              {task.prNumber ? '（merge:auto 时自动合并 PR）' : ''}，或「Cancel」丢弃。
            </div>
            <ReviewSummary taskId={task.id} />
            {task.prUrl && (
              <a
                href={task.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary mt-3 !border-[#bbf7d0] !text-success hover:!bg-[#dcfce7] hover:!border-success"
              >
                Open PR #{task.prNumber}
              </a>
            )}
          </div>
        )}

        {showMergeReadyAction && (
          <div className="mb-4 rounded-lg border border-[#bbf7d0] bg-[#f0fdf4] p-4 text-sm text-success">
            <div className="font-semibold">✅ PR ready · 等待人工确认</div>
            <div className="mt-1 text-og-700">
              Dev finished its post-approve checks — 点击「确认」收尾（merge:auto 时由 baxian 执行合并）。
            </div>
            {task.prUrl && (
              <a
                href={task.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary mt-3 !border-[#bbf7d0] !text-success hover:!bg-[#dcfce7] hover:!border-success"
              >
                Open PR #{task.prNumber}
              </a>
            )}
          </div>
        )}

        {showCodeMaxRounds && (
          <div className="mb-4 rounded-lg border border-[#fde68a] bg-[#fef3c7]/60 p-4 text-sm text-warn">
            <div className="font-semibold">已达 review 轮次上限（round {task.reviewRound}）</div>
            <div className="mt-1 text-og-700">
              可「标记完成」合并收尾，或「继续一轮」由 dev 再修一轮（完成后自动转 QA review）。
            </div>
            <div className="mt-2 text-og-700">
              轮次越多，Agent 越容易偏离重点。若无严重问题，建议先合并本次成果，剩余问题另开任务跟进。
            </div>
          </div>
        )}

        {showSpecMaxRounds && (
          <div className="mb-4 rounded-lg border border-[#fde68a] bg-[#fef3c7]/60 p-4 text-sm text-warn">
            <div className="font-semibold">已达 spec review 轮次上限（round {task.specReviewRound ?? 0}）</div>
            <div className="mt-1 text-og-700">
              Spec 评审多轮未达成一致，任务已暂停。spec 是过程产物、没有可合并的成果，
              可「Retry」新建任务从头跑（丢弃当前 worktree），或「Cancel」取消。
            </div>
            <div className="mt-2 text-og-700">
              建议先查看下方评审记录定位分歧，细化任务描述后再 Retry。
            </div>
            <ReviewSummary taskId={task.id} />
          </div>
        )}

        <div className="card mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 p-4 text-sm">
          <span className="text-og-500">
            PR:{' '}
            {task.prNumber ? (
              task.prUrl ? (
                <a href={task.prUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:text-accent-hover">#{task.prNumber}</a>
              ) : (
                <span className="font-mono text-og-800">#{task.prNumber}</span>
              )
            ) : (
              <span className="text-og-400">—</span>
            )}
          </span>
          <span className="text-og-500">
            Branch:{' '}
            {task.branch ? (
              branchUrl ? (
                <a href={branchUrl} target="_blank" rel="noopener noreferrer" className="font-mono text-accent hover:text-accent-hover">{task.branch}</a>
              ) : (
                <span className="font-mono text-og-800">{task.branch}</span>
              )
            ) : (
              <span className="text-og-400">—</span>
            )}
          </span>
        </div>

        <pre className="card mb-4 whitespace-pre-wrap p-4 text-sm text-og-800">
          {task.description || <span className="text-og-400">（无描述）</span>}
        </pre>

        <ReviewConversation task={task} />
      </div>
    );
  }

  function renderAgents(task: TaskState) {
    if (projects === null) {
      return <div className="rounded-lg border border-hairline bg-surface px-3 py-6 text-center text-sm text-og-400">加载中…</div>;
    }
    const project = projects.find((p) => p.id === task.projectId);
    const devId = task.agentId || task.preferredAgentId;
    const group = project?.agent.find((g) => g.some((a) => a.id === devId))
      ?? (task.qaAgentId ? project?.agent.find((g) => g.some((a) => a.id === task.qaAgentId)) : undefined);
    const devConfig = group?.find((a) => a.role === 'dev');
    const qaConfig = group?.find((a) => a.role === 'qa');

    if (!devConfig && !qaConfig) {
      return <div className="rounded-lg border border-hairline bg-surface px-3 py-6 text-center text-sm text-og-400">暂无关联 Agent</div>;
    }

    return (
      <>
        {devConfig ? renderAgentCard(task, devConfig) : <AgentSlotPlaceholder role="dev" />}
        {qaConfig ? renderAgentCard(task, qaConfig) : <AgentSlotPlaceholder role="qa" />}
      </>
    );
  }

  function renderAgentCard(task: TaskState, cfg: AgentConfig) {
    const snapshot = agentsById.get(cfg.id);
    const state: AgentSnapshot = snapshot ?? {
      id: cfg.id,
      projectId: task.projectId,
      runtimeStatus: 'unknown',
      tmuxSessionStatus: 'unknown',
      stale: true,
    };
    return (
      <AgentCard
        key={cfg.id}
        agent={state}
        projectId={task.projectId}
        role={cfg.role}
        runtime={cfg.runtime}
        pendingRestart={agentsLoaded && !snapshot}
        terminalLoading={!agentsLoaded && !snapshot && !agentsErrorPayload}
        showTaskBinding={false}
        terminalMode="embedded-full"
      />
    );
  }

  function renderActions(task: TaskState) {
    const isMaxRounds = task.status === 'max_rounds';
    const isCodeMaxRounds = isMaxRounds && task.phase !== 'spec';
    const isSpecMaxRounds = isMaxRounds && task.phase === 'spec';
    const isGate = task.status === 'ready' || task.status === 'merge-ready';
    const isServerApprovedGate = task.reviewMode === 'server' && task.status === 'approved';
    const editEnabled = task.status === 'pending';
    const cancelEnabled = task.status === 'pending' || task.status === 'in_progress'
      || isMaxRounds || isGate || isServerApprovedGate;
    const retryEnabled =
      (RETRYABLE_STATUSES.has(task.status) || isSpecMaxRounds) && !!task.preferredAgentId;
    const reviewEnabled = !!task.prNumber && !isSpecMaxRounds && task.reviewMode !== 'server';
    const isServerMode = task.reviewMode === 'server';
    const completeEnabled = isCodeMaxRounds && (!!task.prNumber || isServerMode);
    const continueEnabled = isCodeMaxRounds && (!!task.prNumber || isServerMode) && !!task.agentId;
    const serverPublishRetry = isServerMode && task.status === 'approved';
    const isLegacy = task.preferredAgentId === '';

    return (
      <>
        <button type="button" disabled={!editEnabled} onClick={() => setEditOpen(true)} className="btn-secondary">
          Edit
        </button>
        <button
          type="button"
          disabled={!cancelEnabled || cancelling}
          onClick={handleCancel}
          className="btn-secondary !border-[#fecaca] !text-danger hover:!bg-[#fef2f2] hover:!border-danger"
        >
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </button>
        {!isCodeMaxRounds && (
          <button
            type="button"
            disabled={!retryEnabled || retrying}
            onClick={handleRetry}
            title={
              !(RETRYABLE_STATUSES.has(task.status) || isSpecMaxRounds)
                ? `Cannot retry in status ${task.status}`
                : isLegacy
                  ? 'Legacy task has no preferred dev to retry against'
                  : '新建一个 task 从头跑，丢弃当前 worktree/branch'
            }
            className="btn-secondary"
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        )}
        <button
          type="button"
          disabled={!reviewEnabled || reviewing}
          onClick={handleReview}
          title={
            !task.prNumber
              ? '该 task 还没有 PR，无法派 review'
              : isSpecMaxRounds
                ? 'spec 阶段达上限不支持 Call review'
                : '让 QA agent 立即开始新一轮 review（reviewRound +1）'
          }
          className="btn-secondary !border-accent-soft !text-accent hover:!bg-accent-soft hover:!border-accent"
        >
          {reviewing ? 'Dispatching…' : 'Call review'}
        </button>
        {isCodeMaxRounds && (
          <>
            <button
              type="button"
              disabled={!continueEnabled || continuing}
              onClick={handleContinue}
              title="派 dev 再修一轮，完成后自动转 QA review"
              className="btn-secondary !border-accent-soft !text-accent hover:!bg-accent-soft hover:!border-accent"
            >
              {continuing ? 'Continuing…' : '继续一轮'}
            </button>
            <button
              type="button"
              disabled={!completeEnabled || completing}
              onClick={handleComplete}
              title="合并 PR 并收尾（删本地分支 + 压缩上下文）"
              className="btn-secondary !border-[#bbf7d0] !text-success hover:!bg-[#dcfce7] hover:!border-success"
            >
              {completing ? 'Completing…' : '标记完成'}
            </button>
          </>
        )}
        {isGate && (
          <button
            type="button"
            disabled={completing}
            onClick={handleConfirmGate}
            title="确认完成；merge:auto 时由 baxian 执行合并"
            className="btn-secondary !border-[#bbf7d0] !text-success hover:!bg-[#dcfce7] hover:!border-success"
          >
            {completing ? 'Confirming…' : '确认'}
          </button>
        )}
        {serverPublishRetry && (
          <button
            type="button"
            disabled={completing}
            onClick={handleConfirmGate}
            title="发布派发失败后重试 push/PR 步骤"
            className="btn-secondary !border-accent-soft !text-accent hover:!bg-accent-soft hover:!border-accent"
          >
            {completing ? 'Retrying…' : '重试发布'}
          </button>
        )}
      </>
    );
  }
}

function AgentSlotPlaceholder({ role }: { role: 'dev' | 'qa' }) {
  return (
    <div className="rounded-lg border border-hairline bg-surface px-3 py-6 text-center text-sm text-og-400">
      暂无 {role === 'dev' ? 'Dev' : 'QA'} Agent
    </div>
  );
}

function ReviewSummary({ taskId }: { taskId: string }) {
  const [rounds, setRounds] = useState<ReviewRound[] | null>(null);
  useEffect(() => {
    let alive = true;
    api.tasks.reviews(taskId)
      .then(data => { if (alive) setRounds(data); })
      .catch(() => { if (alive) setRounds([]); });
    return () => { alive = false; };
  }, [taskId]);
  if (!rounds || rounds.length === 0) return null;
  const last = rounds[rounds.length - 1];
  const findingsCount = rounds.reduce((n, r) => n + (r.findings?.findings.length ?? 0), 0);
  return (
    <div className="mt-2 text-xs text-og-700">
      Review {rounds.length} 轮 · 最终 verdict <span className="font-mono">{last.findings?.verdict ?? '—'}</span>
      {' '}· findings 共 {findingsCount} 条
    </div>
  );
}
