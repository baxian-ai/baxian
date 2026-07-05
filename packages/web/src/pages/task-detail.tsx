import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.ts';
import { AgentCard } from '../components/agent-card.tsx';
import { inputCls } from '../components/form-styles.ts';
import { CreateTaskModal } from '../components/create-task-modal.tsx';
import { ReviewConversation } from '../components/review-conversation.tsx';
import { useToast } from '../components/toast.tsx';
import { useConfirm } from '../components/confirm-dialog.tsx';
import { STATUS_BADGE_COLORS, formatTaskTimestamp, taskDetailPath, taskStatusLabel } from '../components/task-status.tsx';
import { useActiveAgentCard } from '../hooks/use-active-agent-card.ts';
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
  const confirmDialog = useConfirm();
  const [editOpen, setEditOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [specSubmitting, setSpecSubmitting] = useState(false);
  const [specComments, setSpecComments] = useState('');
  const [override, setOverride] = useState<TaskState | null>(null);
  const { data: streamed, loaded, error: errorPayload } = useTask(taskId);
  const { projects } = useProjects();
  const { data: agents, loaded: agentsLoaded, error: agentsErrorPayload } = useAgents();
  const { activeAgentId, activateAgentCard } = useActiveAgentCard();
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
    if (!(await confirmDialog({ title: `取消任务 ${task.id}？`, confirmLabel: '取消任务', cancelLabel: '返回' }))) return;
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
    const ok = await (isTerminal
      ? confirmDialog({
          title: '重审已结束的任务？',
          body: `任务 ${task.id} 已是「${taskStatusLabel(task.status)}」状态。手动请 QA agent 重审会再跑一轮 review，但状态机不会把 QA agent 的结果带回主流程。`,
          confirmLabel: '发起重审',
        })
      : confirmDialog({
          title: `发起 QA 重审？`,
          body: `QA agent 将对任务 ${task.id} 立即开始新一轮 review（reviewRound +1）。`,
          confirmLabel: '发起重审',
        }));
    if (!ok) return;
    setReviewing(true);
    try {
      const updated = await api.tasks.review(task.id);
      commitTaskExternal(updated);
      show({ kind: 'success', title: `已发起 QA 重审（第 ${updated.reviewRound} 轮）` });
    } catch (err) {
      show({ kind: 'error', title: '发起评审失败', body: err instanceof Error ? err.message : String(err) });
    } finally {
      setReviewing(false);
    }
  };

  const handleRetry = async () => {
    if (!task) return;
    const ok = await confirmDialog({
      title: `重试任务 ${task.id}？`,
      body: task.status === 'merged'
        ? '任务已合并。重试会用同样的标题/描述新建一个任务从头跑。'
        : '会新建一个任务从头开始，旧任务保留为历史。',
      confirmLabel: '重试',
    });
    if (!ok) return;
    setRetrying(true);
    try {
      const fresh = await api.tasks.retry(task.id);
      show({ kind: 'success', title: `已新建 task ${fresh.id}` });
      navigate(taskDetailPath(fresh.projectId, fresh.id));
    } catch (err) {
      show({ kind: 'error', title: '重试失败', body: err instanceof Error ? err.message : String(err) });
    } finally {
      setRetrying(false);
    }
  };

  const handleComplete = async () => {
    if (!task) return;
    if (!(await confirmDialog({ title: '标记完成并合并？', body: `将合并 PR #${task.prNumber} 并收尾：删本地分支、压缩 agent 上下文。`, confirmLabel: '标记完成' }))) return;
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
    if (!(await confirmDialog({ title: '继续一轮？', body: `让 Dev agent 再修一轮（第 ${task.reviewRound + 1} 轮），完成后自动转 QA review。`, confirmLabel: '继续一轮' }))) return;
    setContinuing(true);
    try {
      const updated = await api.tasks.continue(task.id);
      commitTaskExternal(updated);
      show({ kind: 'success', title: `已继续一轮（第 ${updated.reviewRound} 轮）` });
    } catch (err) {
      show({ kind: 'error', title: '继续一轮失败', body: err instanceof Error ? err.message : String(err) });
    } finally {
      setContinuing(false);
    }
  };

  const handleSpecApprove = async () => {
    if (!task) return;
    if (!(await confirmDialog({ title: `通过 Spec 并开始编码？`, body: `任务 ${task.id} 将进入编码阶段。`, confirmLabel: '通过 Spec' }))) return;
    setSpecSubmitting(true);
    try {
      const updated = await api.tasks.spec(task.id, { verdict: 'approve' });
      commitTaskExternal(updated);
      setSpecComments('');
      show({ kind: 'success', title: 'Spec 已通过，已发起编码' });
    } catch (err) {
      show({ kind: 'error', title: 'Spec 通过失败', body: err instanceof Error ? err.message : String(err) });
    } finally {
      setSpecSubmitting(false);
    }
  };

  const handleSpecReject = async () => {
    if (!task) return;
    const comments = specComments.trim();
    if (!comments) return;
    setSpecSubmitting(true);
    try {
      const updated = await api.tasks.spec(task.id, { verdict: 'request-changes', comments });
      commitTaskExternal(updated);
      setSpecComments('');
      show({ kind: 'success', title: 'Spec 已打回，Dev agent 开始修订' });
    } catch (err) {
      show({ kind: 'error', title: 'Spec 打回失败', body: err instanceof Error ? err.message : String(err) });
    } finally {
      setSpecSubmitting(false);
    }
  };

  const handleConfirmGate = async () => {
    if (!task) return;
    if (!(await confirmDialog({ title: `确认完成任务 ${task.id}？`, body: 'project.merge 为 auto 时由 baxian 自动执行合并。', confirmLabel: '确认完成' }))) return;
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
      {error && !task && <div className="text-sm text-accent">加载失败：{error}</div>}
      {loaded && !task && !error && <div className="text-sm text-accent">任务不存在：{taskId}</div>}
      {!task && !error && !loaded && <div className="text-sm text-og-500">Loading…</div>}
      {task && (
        <>
          <div className="mb-4">
            <h1 className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 font-mono text-sm text-og-400">{task.id}</span>
              <span className="min-w-0 truncate font-display text-sm font-semibold tracking-tight text-og-1000" title={task.title}>
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
    const showSpecReadyAction = task.status === 'spec-ready';
    const showReadyGate = task.status === 'ready';
    const showCodeMaxRounds = task.status === 'max_rounds' && task.phase !== 'spec';
    const showSpecMaxRounds = task.status === 'max_rounds' && task.phase === 'spec';
    const branchUrl = branchTreeUrl(task.prUrl, task.branch ?? '');

    return (
      <div>
        {error && <div className="mb-4 text-sm text-accent">加载失败：{error}</div>}
        {isLegacy && (
          <div className="mb-4 rounded-md border border-accent/25 bg-accent-soft/60 px-3 py-2.5 text-xs text-accent">
            {task.status === 'pending'
              ? <>任务还没有指定 Dev agent：点「编辑」选择，或在任一空闲 Dev agent 卡片上点「发起」。</>
              : <>历史任务，无指定 Dev agent，当前状态 <b className="font-semibold">{taskStatusLabel(task.status)}</b>，只读。</>}
          </div>
        )}

        <div className="mb-3 flex flex-wrap items-center gap-3">
          <span className={`${STATUS_BADGE_COLORS[task.status]} text-sm`} title={task.status}>{taskStatusLabel(task.status)}</span>
          <span className="text-sm text-og-500">评审 <span className="text-og-800">{task.reviewRound}</span> 轮</span>
          <span className="text-sm text-og-500">Spec <span className="text-og-800">{task.specReviewRound ?? 0}</span> 轮</span>
        </div>
        <div className="mb-4 flex flex-wrap items-center gap-2">{renderActions(task)}</div>
        <div className="mb-4 text-sm text-og-500">
          创建于 {formatTaskTimestamp(task.createdAt, false)} · 更新于 {formatTaskTimestamp(task.updatedAt, false)}
        </div>

        {verdictOverdue && (
          <div className="mb-4 rounded-lg border border-accent/25 bg-accent-soft p-4 text-sm text-accent">
            <div className="font-semibold">评审逾期未交</div>
            <div className="mt-1 text-og-700">
              QA agent 于 {formatTaskTimestamp(task.reviewDispatchedAt)} 接单，超过 10 分钟未提交结论。
              可打开 QA agent 终端查看，或点「发起评审」重新发起。
            </div>
          </div>
        )}

        {showApprovedAction && (
          <div className="mb-4 rounded-lg border border-hairline bg-og-25 p-4 text-sm text-og-800">
            <div className="font-semibold">QA agent 已通过 · 正在核对反馈</div>
            <div className="mt-1 text-og-700">
              Dev agent 正在确认所有评审反馈均已处理，完成后进入收尾。
            </div>
            {task.prUrl && (
              <a
                href={task.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary mt-3"
              >
                查看 PR #{task.prNumber}
              </a>
            )}
          </div>
        )}

        {showReadyGate && (
          <div className="mb-4 rounded-lg border border-accent/25 bg-accent-soft p-4 text-sm text-accent">
            <div className="font-semibold">评审通过 · 等你确认</div>
            <div className="mt-1 text-og-700">
              Server 评审通过，共 {task.reviewRound} 轮。点「确认」收尾，或「取消」丢弃。
            </div>
            <ReviewSummary taskId={task.id} />
            {task.prUrl && (
              <a
                href={task.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary mt-3"
              >
                查看 PR #{task.prNumber}
              </a>
            )}
          </div>
        )}

        {showMergeReadyAction && (
          <div className="mb-4 rounded-lg border border-accent/25 bg-accent-soft p-4 text-sm text-accent">
            <div className="font-semibold">PR 就绪 · 等你确认</div>
            <div className="mt-1 text-og-700">
              Dev agent 已完成收尾自检，点「确认」交由 baxian 收尾。
            </div>
            {task.prUrl && (
              <a
                href={task.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary mt-3"
              >
                查看 PR #{task.prNumber}
              </a>
            )}
          </div>
        )}

        {showSpecReadyAction && (
          <div className="mb-4 rounded-lg border border-accent-soft bg-accent-soft/40 p-4 text-sm text-accent">
            <div className="font-semibold">Spec 需由人类审核</div>
            <div className="mt-1 text-og-700">
              QA agent 已通过第 {task.specReviewRound ?? 0} 轮 Spec，全文见下方评审记录。
              通过即开始编码；打回意见将交 Dev agent 修订后复审。
            </div>
            <div className="mt-3 flex flex-col gap-2">
              <textarea
                value={specComments}
                onChange={e => setSpecComments(e.target.value)}
                placeholder="打回意见（打回时必填）"
                rows={3}
                disabled={specSubmitting}
                className={inputCls}
              />
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={specSubmitting}
                  onClick={handleSpecApprove}
                  className="btn-primary"
                >
                  {specSubmitting ? '提交中…' : '通过 Spec，开始编码'}
                </button>
                <button
                  type="button"
                  disabled={specSubmitting || specComments.trim() === ''}
                  onClick={handleSpecReject}
                  title={specComments.trim() === '' ? '先填写打回意见' : '意见将作为 findings 交 Dev agent 修订'}
                  className="btn-secondary"
                >
                  {specSubmitting ? '提交中…' : '打回 Spec'}
                </button>
              </div>
            </div>
          </div>
        )}

        {showCodeMaxRounds && (
          <div className="mb-4 rounded-lg border border-accent/25 bg-accent-soft/60 p-4 text-sm text-accent">
            <div className="font-semibold">评审已达 {task.reviewRound} 轮上限</div>
            <div className="mt-1 text-og-700">
              可「标记完成」先合并成果，或「继续一轮」再修订。剩余问题建议另开任务，轮次越多 agent 越容易偏题。
            </div>
          </div>
        )}

        {showSpecMaxRounds && (
          <div className="mb-4 rounded-lg border border-accent/25 bg-accent-soft/60 p-4 text-sm text-accent">
            <div className="font-semibold">Spec 评审已达 {task.specReviewRound ?? 0} 轮上限</div>
            <div className="mt-1 text-og-700">
              多轮未达成一致，任务已暂停。可「重试」新建任务从头跑，或「取消」。建议先看评审记录定位分歧、细化描述后再重试。
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
        active={activeAgentId === cfg.id}
        onActivate={() => activateAgentCard(cfg.id)}
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
      || task.status === 'spec-ready' || isMaxRounds || isGate || isServerApprovedGate;
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
          编辑
        </button>
        <button
          type="button"
          disabled={!cancelEnabled || cancelling}
          onClick={handleCancel}
          className="btn-secondary"
        >
          {cancelling ? '取消中…' : '取消'}
        </button>
        {!isCodeMaxRounds && (
          <button
            type="button"
            disabled={!retryEnabled || retrying}
            onClick={handleRetry}
            title={
              !(RETRYABLE_STATUSES.has(task.status) || isSpecMaxRounds)
                ? `当前状态「${taskStatusLabel(task.status)}」不可重试`
                : isLegacy
                  ? '历史任务没有指定 Dev agent，无法重试'
                  : '新建一个任务从头跑，丢弃当前 worktree/branch'
            }
            className="btn-secondary"
          >
            {retrying ? '重试中…' : '重试'}
          </button>
        )}
        <button
          type="button"
          disabled={!reviewEnabled || reviewing}
          onClick={handleReview}
          title={
            !task.prNumber
              ? '该任务还没有 PR，无法发起评审'
              : isSpecMaxRounds
                ? 'spec 阶段达上限不支持 Call review'
                : '让 QA agent 立即开始新一轮 review（reviewRound +1）'
          }
          className="btn-secondary"
        >
          {reviewing ? '发起中…' : '发起评审'}
        </button>
        {isCodeMaxRounds && (
          <>
            <button
              type="button"
              disabled={!continueEnabled || continuing}
              onClick={handleContinue}
              title="让 Dev agent 再修一轮，完成后自动转 QA review"
              className="btn-secondary"
            >
              {continuing ? '继续中…' : '继续一轮'}
            </button>
            <button
              type="button"
              disabled={!completeEnabled || completing}
              onClick={handleComplete}
              title="合并 PR 并收尾（删本地分支 + 压缩上下文）"
              className="btn-primary"
            >
              {completing ? '完成中…' : '标记完成'}
            </button>
          </>
        )}
        {isGate && (
          <button
            type="button"
            disabled={completing}
            onClick={handleConfirmGate}
            title="确认完成；merge:auto 时由 baxian 执行合并"
            className="btn-primary"
          >
            {completing ? '确认中…' : '确认'}
          </button>
        )}
        {serverPublishRetry && (
          <button
            type="button"
            disabled={completing}
            onClick={handleConfirmGate}
            title="发布失败后重试 push/PR 步骤"
            className="btn-primary"
          >
            {completing ? '重试中…' : '重试发布'}
          </button>
        )}
      </>
    );
  }
}

function AgentSlotPlaceholder({ role }: { role: 'dev' | 'qa' }) {
  return (
    <div className="rounded-lg border border-hairline bg-surface px-3 py-6 text-center text-sm text-og-400">
      暂无 {role === 'dev' ? 'Dev' : 'QA'} agent
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
