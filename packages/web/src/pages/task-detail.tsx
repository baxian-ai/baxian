import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.ts';
import { AgentCard } from '../components/agent-card.tsx';
import { inputCls } from '../components/form-styles.ts';
import { CreateTaskModal } from '../components/create-task-modal.tsx';
import { ReviewConversation } from '../components/review-conversation.tsx';
import { useToast } from '../components/toast.tsx';
import { useConfirm } from '../components/confirm-dialog.tsx';
import { STATUS_BADGE_COLORS, formatTaskTimestamp, taskDetailPath } from '../components/task-status.tsx';
import { useActiveAgentCard } from '../hooks/use-active-agent-card.ts';
import { useAgents, useTask } from '../hooks/use-events.ts';
import { useProjects } from '../hooks/use-projects.ts';
import { useT } from '../i18n/index.tsx';
import {
  isSpecStagePhase,
  REVIEW_VERDICT_TIMEOUT_MS,
  TASK_TERMINAL_STATUS_SET,
  safeExternalHref,
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
  const t = useT();
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
  const [codeSubmitting, setCodeSubmitting] = useState(false);
  const [codeComments, setCodeComments] = useState('');
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
    const isTerminal = TASK_TERMINAL_STATUS_SET.has(task.status);
    const ok = await confirmDialog({
      title: t.taskDetail.cancelConfirmTitle(task.id),
      ...(isTerminal ? { body: t.taskDetail.cancelConfirmBodyTerminal } : {}),
      confirmLabel: t.taskDetail.cancelConfirmLabel,
      cancelLabel: t.common.backText,
    });
    if (!ok) return;
    setCancelling(true);
    try {
      const updated = await api.tasks.update(task.id, { status: 'cancelled' });
      commitTaskExternal(updated);
      show({
        kind: 'success',
        title: updated.status === 'cancelled' ? t.taskDetail.cancelledToastTitle : t.taskDetail.cancelCleanupToastTitle,
      });
    } catch (err) {
      show({ kind: 'error', title: t.taskDetail.cancelFailedTitle, body: err instanceof Error ? err.message : String(err) });
    } finally {
      setCancelling(false);
    }
  };

  const handleReview = async () => {
    if (!task) return;
    const isTerminal = TASK_TERMINAL_STATUS_SET.has(task.status);
    const ok = await (isTerminal
      ? confirmDialog({
          title: t.taskDetail.reReviewTerminalConfirmTitle,
          body: t.taskDetail.reReviewTerminalConfirmBody(task.id, t.status[task.status] ?? task.status),
          confirmLabel: t.agents.confirmReReviewLabel,
        })
      : confirmDialog({
          title: t.agents.confirmReReviewTitle,
          body: t.agents.confirmReReviewBody(task.id),
          confirmLabel: t.agents.confirmReReviewLabel,
        }));
    if (!ok) return;
    setReviewing(true);
    try {
      const updated = await api.tasks.review(task.id);
      commitTaskExternal(updated);
      const round = isSpecStagePhase(updated.phase) ? (updated.specReviewRound ?? 0) : updated.reviewRound;
      show({ kind: 'success', title: t.agents.reReviewStarted(round) });
    } catch (err) {
      show({ kind: 'error', title: t.agents.reReviewStartFailed, body: err instanceof Error ? err.message : String(err) });
    } finally {
      setReviewing(false);
    }
  };

  const handleRetry = async () => {
    if (!task) return;
    const ok = await confirmDialog({
      title: t.taskDetail.retryConfirmTitle(task.id),
      body: task.status === 'merged'
        ? t.taskDetail.retryConfirmBodyMerged
        : t.taskDetail.retryConfirmBodyDefault,
      confirmLabel: t.common.retry,
    });
    if (!ok) return;
    setRetrying(true);
    try {
      const fresh = await api.tasks.retry(task.id);
      show({ kind: 'success', title: t.taskDetail.retryCreatedToastTitle(fresh.id) });
      navigate(taskDetailPath(fresh.projectId, fresh.id));
    } catch (err) {
      show({ kind: 'error', title: t.taskDetail.retryFailedTitle, body: err instanceof Error ? err.message : String(err) });
    } finally {
      setRetrying(false);
    }
  };

  const handleComplete = async () => {
    if (!task) return;
    if (!(await confirmDialog({ title: t.taskDetail.markCompleteConfirmTitle, body: t.taskDetail.markCompleteConfirmBody(task.prNumber ?? 0), confirmLabel: t.taskDetail.markComplete }))) return;
    setCompleting(true);
    try {
      const updated = await api.tasks.complete(task.id);
      commitTaskExternal(updated);
      show({ kind: 'success', title: t.taskDetail.markCompleteToastTitle });
    } catch (err) {
      show({ kind: 'error', title: t.taskDetail.markCompleteFailedTitle, body: err instanceof Error ? err.message : String(err) });
    } finally {
      setCompleting(false);
    }
  };

  const handleContinue = async () => {
    if (!task) return;
    if (!(await confirmDialog({ title: t.taskDetail.continueConfirmTitle, body: t.taskDetail.continueConfirmBody(task.reviewRound + 1), confirmLabel: t.taskDetail.continueRound }))) return;
    setContinuing(true);
    try {
      const updated = await api.tasks.continue(task.id);
      commitTaskExternal(updated);
      show({ kind: 'success', title: t.taskDetail.continuedToastTitle(updated.reviewRound) });
    } catch (err) {
      show({ kind: 'error', title: t.taskDetail.continueFailedTitle, body: err instanceof Error ? err.message : String(err) });
    } finally {
      setContinuing(false);
    }
  };

  const submitSpecVerdict = async (
    body: { verdict: 'approve' | 'request-changes' | 'archive'; comments?: string },
    toast: { success: string; failure: string },
  ) => {
    if (!task) return;
    setSpecSubmitting(true);
    try {
      const updated = await api.tasks.spec(task.id, body);
      commitTaskExternal(updated);
      setSpecComments('');
      show({ kind: 'success', title: toast.success });
    } catch (err) {
      show({ kind: 'error', title: toast.failure, body: err instanceof Error ? err.message : String(err) });
    } finally {
      setSpecSubmitting(false);
    }
  };

  const handleSpecApprove = async () => {
    if (!task) return;
    if (!(await confirmDialog({ title: t.taskDetail.specApproveConfirmTitle, body: t.taskDetail.specApproveConfirmBody(task.id), confirmLabel: t.taskDetail.specApprove }))) return;
    await submitSpecVerdict(
      { verdict: 'approve' },
      { success: t.taskDetail.specApprovedToastTitle, failure: t.taskDetail.specApproveFailedTitle },
    );
  };

  const handleSpecReject = async () => {
    const comments = specComments.trim();
    if (!comments) return;
    await submitSpecVerdict(
      { verdict: 'request-changes', comments },
      {
        success: task?.researchAgentId
          ? t.taskDetail.specRejectedToastTitleResearch
          : t.taskDetail.specRejectedToastTitle,
        failure: t.taskDetail.specRejectFailedTitle,
      },
    );
  };

  const handleSpecArchive = async () => {
    if (!task) return;
    const confirmed = await confirmDialog({
      title: t.taskDetail.specArchiveConfirmTitle,
      body: t.taskDetail.specArchiveConfirmBody(task.id),
      confirmLabel: t.taskDetail.specArchive,
    });
    if (!confirmed) return;
    await submitSpecVerdict(
      { verdict: 'archive' },
      { success: t.taskDetail.specArchivedToastTitle, failure: t.taskDetail.specArchiveFailedTitle },
    );
  };

  const handleCodeReject = async () => {
    if (!task) return;
    const comments = codeComments.trim();
    if (!comments) return;
    setCodeSubmitting(true);
    try {
      const updated = await api.tasks.code(task.id, { verdict: 'request-changes', comments });
      commitTaskExternal(updated);
      setCodeComments('');
      show({ kind: 'success', title: t.taskDetail.codeRejectedToastTitle });
    } catch (err) {
      show({ kind: 'error', title: t.taskDetail.codeRejectFailedTitle, body: err instanceof Error ? err.message : String(err) });
    } finally {
      setCodeSubmitting(false);
    }
  };

  const handleConfirmGate = async () => {
    if (!task) return;
    if (!(await confirmDialog({ title: t.taskDetail.confirmGateConfirmTitle(task.id), body: t.taskDetail.confirmGateConfirmBody, confirmLabel: t.taskDetail.confirmComplete }))) return;
    setCompleting(true);
    try {
      const updated = await api.tasks.complete(task.id);
      commitTaskExternal(updated);
      show({ kind: 'success', title: t.taskDetail.confirmedToastTitle(updated.status) });
    } catch (err) {
      show({ kind: 'error', title: t.taskDetail.confirmFailedTitle, body: err instanceof Error ? err.message : String(err) });
    } finally {
      setCompleting(false);
    }
  };

  return (
    <div>
      <button type="button" onClick={() => navigate(-1)} className="btn-ghost mb-3">
        {t.common.back}
      </button>
      {error && !task && <div className="text-sm text-accent">{t.common.loadFailed(error)}</div>}
      {loaded && !task && !error && <div className="text-sm text-accent">{t.taskDetail.taskNotFound(taskId)}</div>}
      {!task && !error && !loaded && <div className="text-sm text-og-500">{t.common.loading}</div>}
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
    const showCodeMaxRounds = task.status === 'max_rounds' && !isSpecStagePhase(task.phase);
    const showSpecMaxRounds = task.status === 'max_rounds' && isSpecStagePhase(task.phase);
    const prHref = safeExternalHref(task.prUrl);
    const branchUrl = branchTreeUrl(prHref ?? undefined, task.branch ?? '');

    return (
      <div>
        {error && <div className="mb-4 text-sm text-accent">{t.common.loadFailed(error)}</div>}
        {task.branchCleanupPending && (
          <div className="mb-4 rounded-md border border-accent/25 bg-accent-soft/60 px-3 py-2.5 text-xs text-accent">
            <div className="font-semibold">{t.taskDetail.branchCleanupPendingTitle}</div>
            <div className="mt-1 text-og-700">{task.branchCleanupPending.reason}</div>
          </div>
        )}
        {task.branchCleanupSkipped && (
          <div className="mb-4 rounded-md border border-hairline bg-og-25 px-3 py-2.5 text-xs text-og-700">
            <div className="font-semibold">{t.taskDetail.branchCleanupSkippedTitle}</div>
            <div className="mt-1">{task.branchCleanupSkipped.reason}</div>
          </div>
        )}
        {isLegacy && (
          <div className="mb-4 rounded-md border border-accent/25 bg-accent-soft/60 px-3 py-2.5 text-xs text-accent">
            {task.status === 'pending'
              ? t.taskDetail.legacyPendingNotice
              : t.taskDetail.legacyReadonlyNotice(t.status[task.status] ?? task.status)}
          </div>
        )}

        <div className="mb-3 flex flex-wrap items-center gap-3">
          <span className={`${STATUS_BADGE_COLORS[task.status]} text-sm`} title={task.status}>{t.status[task.status] ?? task.status}</span>
          <span className="text-sm text-og-500">{t.taskDetail.reviewRoundPrefix}<span className="text-og-800">{task.reviewRound}</span>{t.taskDetail.reviewRoundSuffix}</span>
          <span className="text-sm text-og-500">{t.taskDetail.specRoundPrefix}<span className="text-og-800">{task.specReviewRound ?? 0}</span>{t.taskDetail.specRoundSuffix}</span>
        </div>
        <div className="mb-4 flex flex-wrap items-center gap-2">{renderActions(task)}</div>
        <div className="mb-4 text-sm text-og-500">
          {t.taskDetail.createdAtPrefix}{formatTaskTimestamp(task.createdAt, false)}{t.taskDetail.updatedAtPrefix}{formatTaskTimestamp(task.updatedAt, false)}
        </div>

        {verdictOverdue && (
          <div className="mb-4 rounded-lg border border-accent/25 bg-accent-soft p-4 text-sm text-accent">
            <div className="font-semibold">{t.taskDetail.verdictOverdueTitle}</div>
            <div className="mt-1 text-og-700">
              {t.taskDetail.verdictOverduePrefix}{formatTaskTimestamp(task.reviewDispatchedAt)}{t.taskDetail.verdictOverdueSuffix}
            </div>
          </div>
        )}

        {showApprovedAction && (
          <div className="mb-4 rounded-lg border border-hairline bg-og-25 p-4 text-sm text-og-800">
            <div className="font-semibold">{t.taskDetail.approvedBannerTitle}</div>
            <div className="mt-1 text-og-700">
              {t.taskDetail.approvedBannerBody}
            </div>
            {prHref && (
              <a
                href={prHref}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary mt-3"
              >
                {t.taskDetail.viewPr(task.prNumber ?? 0)}
              </a>
            )}
          </div>
        )}

        {showReadyGate && (
          <div className="mb-4 rounded-lg border border-accent/25 bg-accent-soft p-4 text-sm text-accent">
            <div className="font-semibold">{t.taskDetail.readyGateBannerTitle}</div>
            <div className="mt-1 text-og-700">
              {t.taskDetail.readyGateBannerBody(task.reviewRound)}
            </div>
            <ReviewSummary taskId={task.id} />
            {prHref && (
              <a
                href={prHref}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary mt-3"
              >
                {t.taskDetail.viewPr(task.prNumber ?? 0)}
              </a>
            )}
            {task.reviewMode === 'server' && !isSpecStagePhase(task.phase) && (
              <div className="mt-3 flex flex-col gap-2">
                <div className="text-og-700">{t.taskDetail.readyGateRejectHint}</div>
                <textarea
                  value={codeComments}
                  onChange={e => setCodeComments(e.target.value)}
                  placeholder={t.taskDetail.codeRejectCommentsPlaceholder}
                  rows={3}
                  disabled={codeSubmitting}
                  className={inputCls}
                />
                <div>
                  <button
                    type="button"
                    disabled={codeSubmitting || completing || codeComments.trim() === ''}
                    onClick={handleCodeReject}
                    title={codeComments.trim() === '' ? t.taskDetail.codeRejectTitleEmpty : t.taskDetail.codeRejectTitleReady}
                    className="btn-secondary"
                  >
                    {codeSubmitting ? t.taskDetail.submitting : t.taskDetail.codeReject}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {showMergeReadyAction && (
          <div className="mb-4 rounded-lg border border-accent/25 bg-accent-soft p-4 text-sm text-accent">
            <div className="font-semibold">{t.taskDetail.mergeReadyBannerTitle}</div>
            <div className="mt-1 text-og-700">
              {t.taskDetail.mergeReadyBannerBody}
            </div>
            {prHref && (
              <a
                href={prHref}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary mt-3"
              >
                {t.taskDetail.viewPr(task.prNumber ?? 0)}
              </a>
            )}
          </div>
        )}

        {showSpecReadyAction && (
          <div className="mb-4 rounded-lg border border-accent-soft bg-accent-soft/40 p-4 text-sm text-accent">
            <div className="font-semibold">{t.taskDetail.specReadyBannerTitle}</div>
            <div className="mt-1 text-og-700">
              {task.researchAgentId
                ? t.taskDetail.specReadyNoticeResearch(task.specReviewRound ?? 0)
                : t.taskDetail.specReadyNotice(task.specReviewRound ?? 0)}
            </div>
            {renderSpecVerdictControls(task)}
          </div>
        )}

        {showCodeMaxRounds && (
          <div className="mb-4 rounded-lg border border-accent/25 bg-accent-soft/60 p-4 text-sm text-accent">
            <div className="font-semibold">{t.taskDetail.codeMaxRoundsTitle(task.reviewRound)}</div>
            <div className="mt-1 text-og-700">
              {t.taskDetail.codeMaxRoundsBody}
            </div>
          </div>
        )}

        {showSpecMaxRounds && (
          <div className="mb-4 rounded-lg border border-accent/25 bg-accent-soft/60 p-4 text-sm text-accent">
            <div className="font-semibold">{t.taskDetail.specMaxRoundsTitle(task.specReviewRound ?? 0)}</div>
            <div className="mt-1 text-og-700">
              {t.taskDetail.specMaxRoundsBody}
            </div>
            <ReviewSummary taskId={task.id} />
            {renderSpecVerdictControls(task)}
          </div>
        )}

        <div className="card mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 p-4 text-sm">
          <span className="text-og-500">
            PR:{' '}
            {task.prNumber ? (
              prHref ? (
                <a href={prHref} target="_blank" rel="noopener noreferrer" className="text-accent hover:text-accent-hover">#{task.prNumber}</a>
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
          {task.description || <span className="text-og-400">{t.taskDetail.noDescription}</span>}
        </pre>

        <ReviewConversation task={task} />
      </div>
    );
  }

  function renderSpecVerdictControls(task: TaskState) {
    return (
      <div className="mt-3 flex flex-col gap-2">
        <textarea
          value={specComments}
          onChange={e => setSpecComments(e.target.value)}
          placeholder={t.taskDetail.specCommentsPlaceholder}
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
            {specSubmitting ? t.taskDetail.submitting : t.taskDetail.specApproveButton}
          </button>
          <button
            type="button"
            disabled={specSubmitting || specComments.trim() === ''}
            onClick={handleSpecReject}
            title={specComments.trim() === ''
              ? t.taskDetail.specRejectTitleEmpty
              : t.taskDetail.specRejectTitleReady(task.researchAgentId ? 'Research' : 'Dev')}
            className="btn-secondary"
          >
            {specSubmitting ? t.taskDetail.submitting : t.taskDetail.specReject}
          </button>
          {task.researchAgentId && (
            <button
              type="button"
              disabled={specSubmitting}
              onClick={handleSpecArchive}
              className="btn-secondary"
            >
              {specSubmitting ? t.taskDetail.submitting : t.taskDetail.specArchiveButton}
            </button>
          )}
        </div>
      </div>
    );
  }

  function renderAgents(task: TaskState) {
    if (projects === null) {
      return <div className="rounded-lg border border-hairline bg-surface px-3 py-6 text-center text-sm text-og-400">{t.common.loading}</div>;
    }
    const project = projects.find((p) => p.id === task.projectId);
    const group = project?.agent.find((g) => g.some((a) => a.id === task.devAgentId))
      ?? (task.qaAgentId ? project?.agent.find((g) => g.some((a) => a.id === task.qaAgentId)) : undefined)
      ?? (task.researchAgentId ? project?.agent.find((g) => g.some((a) => a.id === task.researchAgentId)) : undefined);
    const devConfig = group?.find((a) => a.role === 'dev' && a.id === task.devAgentId);
    const qaConfig = task.qaAgentId
      ? group?.find((a) => a.role === 'qa' && a.id === task.qaAgentId)
      : undefined;
    const researchConfig = task.researchAgentId
      ? group?.find((a) => a.role === 'research' && a.id === task.researchAgentId)
      : undefined;

    if (!devConfig && !qaConfig && !researchConfig) {
      return <div className="rounded-lg border border-hairline bg-surface px-3 py-6 text-center text-sm text-og-400">{t.taskDetail.noLinkedAgent}</div>;
    }

    return (
      <>
        {researchConfig ? renderAgentCard(task, researchConfig) : null}
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
        model={cfg.model}
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
    const isCodeMaxRounds = isMaxRounds && !isSpecStagePhase(task.phase);
    const isSpecMaxRounds = isMaxRounds && isSpecStagePhase(task.phase);
    const isGate = task.status === 'ready' || task.status === 'merge-ready';
    const editEnabled = task.status === 'pending';
    const retryEnabled =
      (RETRYABLE_STATUSES.has(task.status) || isSpecMaxRounds) && !!task.preferredAgentId;
    const isServerMode = task.reviewMode === 'server';
    const serverStyleReview = isServerMode || isSpecStagePhase(task.phase);
    const serverReviewUnphased = task.status === 'in_progress' && task.phase === undefined;
    const serverReviewableNow = !serverReviewUnphased && (task.status === 'in_progress'
      || task.status === 'review' || task.status === 'fixing');
    const reviewEnabled = serverStyleReview ? serverReviewableNow : !!task.prNumber;
    const completeEnabled = isCodeMaxRounds && (!!task.prNumber || isServerMode);
    const continueEnabled = isCodeMaxRounds && (!!task.prNumber || isServerMode) && !!task.agentId;
    const serverPublishRetry = isServerMode && task.status === 'approved';
    const isLegacy = task.preferredAgentId === '';

    return (
      <>
        <button type="button" disabled={!editEnabled} onClick={() => setEditOpen(true)} className="btn-secondary">
          {t.common.edit}
        </button>
        <button
          type="button"
          disabled={cancelling}
          onClick={handleCancel}
          title={t.taskDetail.cancelForceTitle}
          className="btn-secondary"
        >
          {cancelling ? t.taskDetail.cancelling : t.common.cancel}
        </button>
        {!isCodeMaxRounds && (
          <button
            type="button"
            disabled={!retryEnabled || retrying}
            onClick={handleRetry}
            title={
              !(RETRYABLE_STATUSES.has(task.status) || isSpecMaxRounds)
                ? t.taskDetail.retryDisabledStatusTitle(t.status[task.status] ?? task.status)
                : isLegacy
                  ? t.taskDetail.retryDisabledLegacyTitle
                  : t.taskDetail.retryEnabledTitle
            }
            className="btn-secondary"
          >
            {retrying ? t.common.retrying : t.common.retry}
          </button>
        )}
        <button
          type="button"
          disabled={!reviewEnabled || reviewing}
          onClick={handleReview}
          title={
            serverStyleReview
              ? (reviewEnabled
                ? t.taskDetail.reviewButtonTitle
                : serverReviewUnphased ? t.taskDetail.reviewUnphasedTitle : t.taskDetail.reviewServerStatusTitle)
              : (task.prNumber ? t.taskDetail.reviewButtonTitle : t.taskDetail.reviewNoPrTitle)
          }
          className="btn-secondary"
        >
          {reviewing ? t.agents.callingReview : t.agents.callReview}
        </button>
        {isCodeMaxRounds && (
          <>
            <button
              type="button"
              disabled={!continueEnabled || continuing}
              onClick={handleContinue}
              title={t.taskDetail.continueButtonTitle}
              className="btn-secondary"
            >
              {continuing ? t.taskDetail.continuing : t.taskDetail.continueRound}
            </button>
            <button
              type="button"
              disabled={!completeEnabled || completing}
              onClick={handleComplete}
              title={t.taskDetail.completeButtonTitle}
              className="btn-primary"
            >
              {completing ? t.taskDetail.completing : t.taskDetail.markComplete}
            </button>
          </>
        )}
        {isGate && (
          <button
            type="button"
            disabled={completing || codeSubmitting}
            onClick={handleConfirmGate}
            title={t.taskDetail.confirmButtonTitle}
            className="btn-primary"
          >
            {completing ? t.taskDetail.confirming : t.common.confirm}
          </button>
        )}
        {serverPublishRetry && (
          <button
            type="button"
            disabled={completing}
            onClick={handleConfirmGate}
            title={t.taskDetail.retryPublishButtonTitle}
            className="btn-primary"
          >
            {completing ? t.common.retrying : t.taskDetail.retryPublish}
          </button>
        )}
      </>
    );
  }
}

function AgentSlotPlaceholder({ role }: { role: 'dev' | 'qa' }) {
  const t = useT();
  return (
    <div className="rounded-lg border border-hairline bg-surface px-3 py-6 text-center text-sm text-og-400">
      {t.taskDetail.noAgentSlot(role === 'dev' ? 'Dev' : 'QA')}
    </div>
  );
}

function ReviewSummary({ taskId }: { taskId: string }) {
  const t = useT();
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
      {t.taskDetail.reviewSummaryPrefix}{rounds.length}{t.taskDetail.reviewSummaryMid}<span className="font-mono">{last.findings?.verdict ?? '—'}</span>
      {t.taskDetail.reviewSummaryFindingsPrefix}{findingsCount}{t.taskDetail.reviewSummaryFindingsSuffix}
    </div>
  );
}
