import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.ts';
import { AgentCard } from '../components/agent-card.tsx';
import { inputCls } from '../components/form-styles.ts';
import { CreateTaskModal } from '../components/create-task-modal.tsx';
import { Modal } from '../components/modal.tsx';
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
  needsGitReviewRecovery,
  TASK_TERMINAL_STATUS_SET,
  safeExternalHref,
  type AgentConfig,
  type AgentSnapshot,
  type TaskPhase,
  type TaskState,
} from '../shared/index.js';

const RETRYABLE_STATUSES = TASK_TERMINAL_STATUS_SET;

function branchTreeUrl(prUrl: string | undefined, branch: string): string | null {
  if (!prUrl || !branch) return null;
  const base = prUrl.match(/^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/\d+/);
  if (!base) return null;
  const path = branch.split('/').map(encodeURIComponent).join('/');
  return `${base[1]}/tree/${path}`;
}

function positivePrNumber(value: string): number | undefined {
  if (!/^[1-9]\d*$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function TaskDetail() {
  const { taskId = '' } = useParams<{ id: string; taskId: string }>();
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
  const [advancing, setAdvancing] = useState(false);
  const [reviewRecoveryOpen, setReviewRecoveryOpen] = useState(false);
  const [reviewRecoveryStage, setReviewRecoveryStage] = useState<TaskPhase>('spec');
  const [reviewRecoveryActorId, setReviewRecoveryActorId] = useState('');
  const [reviewRecoveryPrNumber, setReviewRecoveryPrNumber] = useState('');
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

  const dispatchAdvance = async (
    currentTask: TaskState,
    executor: 'dev' | 'qa',
    body?: { stage?: TaskPhase; actorId?: string; prNumber?: number; confirmRevoked?: boolean },
  ) => {
    setAdvancing(true);
    try {
      const updated = await api.tasks.advance(currentTask.id, {
        executor,
        ...(currentTask.status === 'pending' && currentTask.preferredAgentId
          ? { agentId: currentTask.preferredAgentId }
          : {}),
        ...(body ?? {}),
      });
      commitTaskExternal(updated);
      setReviewRecoveryOpen(false);
      show({ kind: 'success', title: t.taskDetail.advanceSucceededTitle });
    } catch (err) {
      show({ kind: 'error', title: t.taskDetail.advanceFailedTitle, body: err instanceof Error ? err.message : String(err) });
    } finally {
      setAdvancing(false);
    }
  };

  const handleAdvance = async (executor?: 'dev' | 'qa') => {
    if (!task) return;
    const selected = executor ?? (task.status === 'review' ? 'qa' : 'dev');
    if (selected === 'qa' && needsGitReviewRecovery(task)) {
      setReviewRecoveryStage(task.phase ?? 'spec');
      setReviewRecoveryActorId(task.replyActorId ?? '');
      setReviewRecoveryPrNumber(task.prNumber?.toString() ?? '');
      setReviewRecoveryOpen(true);
      return;
    }
    if (task.postApproveRevoked) {
      const confirmed = await confirmDialog({
        title: t.taskDetail.advanceRevokedConfirmTitle,
        body: t.taskDetail.advanceRevokedConfirmBody,
        confirmLabel: t.taskDetail.advance,
      });
      if (!confirmed) return;
      await dispatchAdvance(task, selected, { confirmRevoked: true });
      return;
    }
    const ok = await confirmDialog({
      title: t.taskDetail.advanceConfirmTitle,
      body: selected === 'qa'
        ? t.taskDetail.advanceQaConfirmBody(task.id)
        : t.taskDetail.advanceDevConfirmBody(task.id),
      confirmLabel: t.taskDetail.advance,
    });
    if (!ok) return;
    await dispatchAdvance(task, selected);
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
    if (!(await confirmDialog({ title: t.taskDetail.markCompleteConfirmTitle, body: t.taskDetail.markCompleteConfirmBody(task.prNumber ?? 0), confirmLabel: t.taskDetail.verdictComplete }))) return;
    setCompleting(true);
    try {
      const updated = await api.tasks.verdict(task.id, { action: 'complete' });
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
    if (!(await confirmDialog({ title: t.taskDetail.continueConfirmTitle, body: t.taskDetail.continueConfirmBody(task.reviewRound + 1), confirmLabel: t.taskDetail.verdictContinue }))) return;
    setContinuing(true);
    try {
      const updated = await api.tasks.verdict(task.id, { action: 'continue' });
      commitTaskExternal(updated);
      show({ kind: 'success', title: t.taskDetail.continuedToastTitle(updated.reviewRound) });
    } catch (err) {
      show({ kind: 'error', title: t.taskDetail.continueFailedTitle, body: err instanceof Error ? err.message : String(err) });
    } finally {
      setContinuing(false);
    }
  };

  const submitSpecVerdict = async (
    body: { verdict: 'approve' | 'request-changes'; comments?: string },
    toast: { success: string; failure: string },
  ) => {
    if (!task) return;
    setSpecSubmitting(true);
    try {
      const updated = await api.tasks.verdict(task.id, {
        action: body.verdict,
        ...(body.comments !== undefined ? { comments: body.comments } : {}),
      });
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
        success: t.taskDetail.specRejectedToastTitle,
        failure: t.taskDetail.specRejectFailedTitle,
      },
    );
  };

  const submitCodeVerdict = async (action: 'pass' | 'request-changes') => {
    if (!task) return;
    const comments = codeComments.trim();
    if (action === 'request-changes' && !comments) return;
    const ok = await confirmDialog({
      title: action === 'pass'
        ? t.taskDetail.codePassConfirmTitle
        : t.taskDetail.codeRejectConfirmTitle,
      body: t.taskDetail.codeVerdictConfirmBody,
      confirmLabel: action === 'pass'
        ? t.taskDetail.codePass
        : t.taskDetail.codeRequestChanges,
    });
    if (!ok) return;
    setCodeSubmitting(true);
    try {
      const updated = await api.tasks.verdict(task.id, {
        action,
        ...(comments ? { comments } : {}),
      });
      commitTaskExternal(updated);
      setCodeComments('');
      show({ kind: 'success', title: t.taskDetail.codeVerdictSubmittedTitle });
    } catch (err) {
      show({
        kind: 'error',
        title: t.taskDetail.codeVerdictFailedTitle,
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setCodeSubmitting(false);
    }
  };

  const focusVerdictControls = () => {
    document.getElementById('task-verdict-controls')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const handleConfirmGate = async () => {
    if (!task) return;
    if (!(await confirmDialog({ title: t.taskDetail.confirmGateConfirmTitle(task.id), body: t.taskDetail.confirmGateConfirmBody, confirmLabel: t.taskDetail.confirmComplete }))) return;
    setCompleting(true);
    try {
      const updated = await api.tasks.verdict(task.id, { action: 'confirm-merge' });
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
      {reviewRecoveryOpen && task && (
        <Modal
          open
          title={t.taskDetail.reviewRecoveryTitle}
          onClose={() => {
            if (!advancing) setReviewRecoveryOpen(false);
          }}
          size="sm"
          dismissOnBackdrop={!advancing}
          footer={
            <>
              <button
                type="button"
                disabled={advancing}
                onClick={() => setReviewRecoveryOpen(false)}
                className="btn-secondary"
              >
                {t.common.cancel}
              </button>
              <button
                type="submit"
                form="review-recovery-form"
                disabled={advancing
                  || reviewRecoveryActorId.trim() === ''
                  || (task.prNumber === undefined
                    && positivePrNumber(reviewRecoveryPrNumber) === undefined)}
                className="btn-primary"
              >
                {advancing ? t.taskDetail.advancing : t.taskDetail.reviewRecoverySubmit}
              </button>
            </>
          }
        >
          <form
            id="review-recovery-form"
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              const actorId = reviewRecoveryActorId.trim();
              const prNumber = task.prNumber ?? positivePrNumber(reviewRecoveryPrNumber);
              if (!actorId || prNumber === undefined || advancing) return;
              void dispatchAdvance(task, 'qa', {
                stage: reviewRecoveryStage,
                actorId,
                ...(task.prNumber === undefined ? { prNumber } : {}),
              });
            }}
          >
            <p className="text-sm text-og-700">{t.taskDetail.reviewRecoveryBody}</p>
            {task.prNumber === undefined && (
              <div>
                <label htmlFor="review-recovery-pr-number" className="mb-1 block text-sm text-og-700">
                  {t.taskDetail.reviewRecoveryPrNumberLabel}
                </label>
                <input
                  id="review-recovery-pr-number"
                  type="number"
                  min={1}
                  step={1}
                  value={reviewRecoveryPrNumber}
                  required
                  disabled={advancing}
                  onChange={(event) => setReviewRecoveryPrNumber(event.target.value)}
                  placeholder={t.taskDetail.reviewRecoveryPrNumberPlaceholder}
                  className={inputCls}
                />
              </div>
            )}
            <div>
              <label htmlFor="review-recovery-stage" className="mb-1 block text-sm text-og-700">
                {t.taskDetail.reviewRecoveryStageLabel}
              </label>
              <select
                id="review-recovery-stage"
                value={reviewRecoveryStage}
                required
                disabled={advancing || task.phase !== undefined}
                onChange={(event) => setReviewRecoveryStage(event.target.value as TaskPhase)}
                className={inputCls}
              >
                <option value="spec">{t.review.phaseLabel.spec}</option>
                <option value="code">{t.review.phaseLabel.code}</option>
              </select>
            </div>
            <div>
              <label htmlFor="review-recovery-actor" className="mb-1 block text-sm text-og-700">
                {t.taskDetail.reviewRecoveryActorLabel}
              </label>
              <input
                id="review-recovery-actor"
                value={reviewRecoveryActorId}
                required
                disabled={advancing || (
                  task.replyActorStatus === 'verified' && task.replyActorId !== undefined
                )}
                onChange={(event) => setReviewRecoveryActorId(event.target.value)}
                placeholder={t.taskDetail.reviewRecoveryActorPlaceholder}
                className={inputCls}
              />
            </div>
          </form>
        </Modal>
      )}
    </div>
  );

  function renderInfo(task: TaskState) {
    const isUnassigned = task.preferredAgentId === '';
    const showApprovedAction = task.status === 'approved' && task.prNumber !== undefined;
    const showMergeReadyAction = task.status === 'merge-ready' && task.prNumber !== undefined;
    const showSpecReadyAction = task.status === 'spec-ready';
    const showCodeReviewAction = task.status === 'review' && !isSpecStagePhase(task.phase);
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
        {isUnassigned && (
          <div className="mb-4 rounded-md border border-accent/25 bg-accent-soft/60 px-3 py-2.5 text-xs text-accent">
            {task.status === 'pending'
              ? t.taskDetail.unassignedPendingNotice
              : t.taskDetail.unassignedReadonlyNotice(t.status[task.status] ?? task.status)}
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

        {task.attention && (
          <div className="mb-4 rounded-lg border border-accent/25 bg-accent-soft p-4 text-sm text-accent">
            <div className="font-semibold">{task.attention.reason}</div>
            <div className="mt-1 whitespace-pre-wrap text-og-700">{task.attention.runbook}</div>
            <div className="mt-1 text-xs text-og-500">{formatTaskTimestamp(task.attention.occurredAt)}</div>
            <div className="mt-3 flex flex-wrap gap-2">{renderAttentionActions(task)}</div>
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

        {showMergeReadyAction && (
          <div id="task-verdict-controls" className="mb-4 rounded-lg border border-accent/25 bg-accent-soft p-4 text-sm text-accent">
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
          <div id="task-verdict-controls" className="mb-4 rounded-lg border border-accent-soft bg-accent-soft/40 p-4 text-sm text-accent">
            <div className="font-semibold">{t.taskDetail.specReadyBannerTitle}</div>
            <div className="mt-1 text-og-700">
              {t.taskDetail.specReadyNotice(task.specReviewRound ?? 0)}
            </div>
            {renderSpecVerdictControls()}
          </div>
        )}

        {showCodeReviewAction && (
          <div
            id="task-verdict-controls"
            className={`mb-4 rounded-lg p-4 text-sm ${
              task.attention?.reason === 'review-verdict-overdue'
                ? 'border border-accent/25 bg-accent-soft text-accent'
                : 'border border-hairline bg-og-25 text-og-800'
            }`}
          >
            <div className="font-semibold">{t.taskDetail.codeVerdictTitle}</div>
            <div className="mt-1 text-og-700">{t.taskDetail.codeVerdictBody}</div>
            {renderCodeVerdictControls()}
          </div>
        )}

        {showCodeMaxRounds && (
          <div id="task-verdict-controls" className="mb-4 rounded-lg border border-accent/25 bg-accent-soft/60 p-4 text-sm text-accent">
            <div className="font-semibold">{t.taskDetail.codeMaxRoundsTitle(task.reviewRound)}</div>
            <div className="mt-1 text-og-700">
              {t.taskDetail.codeMaxRoundsBody}
            </div>
          </div>
        )}

        {showSpecMaxRounds && (
          <div id="task-verdict-controls" className="mb-4 rounded-lg border border-accent/25 bg-accent-soft/60 p-4 text-sm text-accent">
            <div className="font-semibold">{t.taskDetail.specMaxRoundsTitle(task.specReviewRound ?? 0)}</div>
            <div className="mt-1 text-og-700">
              {t.taskDetail.specMaxRoundsBody}
            </div>
            {renderSpecVerdictControls()}
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

  function renderSpecVerdictControls() {
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
              : t.taskDetail.specRejectTitleReady('Dev')}
            className="btn-secondary"
          >
            {specSubmitting ? t.taskDetail.submitting : t.taskDetail.specReject}
          </button>
        </div>
      </div>
    );
  }

  function renderCodeVerdictControls() {
    return (
      <div className="mt-3 flex flex-col gap-2">
        <textarea
          value={codeComments}
          onChange={event => setCodeComments(event.target.value)}
          placeholder={t.taskDetail.codeCommentsPlaceholder}
          rows={3}
          disabled={codeSubmitting}
          className={inputCls}
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={codeSubmitting}
            onClick={() => void submitCodeVerdict('pass')}
            className="btn-secondary"
          >
            {codeSubmitting ? t.taskDetail.submitting : t.taskDetail.codePass}
          </button>
          <button
            type="button"
            disabled={codeSubmitting || codeComments.trim() === ''}
            onClick={() => void submitCodeVerdict('request-changes')}
            className="btn-secondary"
          >
            {codeSubmitting ? t.taskDetail.submitting : t.taskDetail.codeRequestChanges}
          </button>
        </div>
      </div>
    );
  }

  function renderAttentionActions(currentTask: TaskState) {
    return currentTask.attention?.recommendedActions.map(action => {
      if (action === 'advance') {
        return (
          <button
            key={action}
            type="button"
            disabled={advancing}
            onClick={() => void handleAdvance()}
            className="btn-primary"
          >
            {advancing ? t.taskDetail.advancing : t.taskDetail.advance}
          </button>
        );
      }
      if (action === 'verdict') {
        return (
          <button key={action} type="button" onClick={focusVerdictControls} className="btn-primary">
            {t.taskDetail.verdict}
          </button>
        );
      }
      if (action === 'cancel') {
        return (
          <button key={action} type="button" disabled={cancelling} onClick={handleCancel} className="btn-secondary">
            {cancelling ? t.taskDetail.cancelling : t.common.cancel}
          </button>
        );
      }
      return (
        <button key={action} type="button" disabled={retrying} onClick={handleRetry} className="btn-secondary">
          {retrying ? t.common.retrying : t.common.retry}
        </button>
      );
    });
  }

  function renderAgents(task: TaskState) {
    if (projects === null) {
      return <div className="rounded-lg border border-hairline bg-surface px-3 py-6 text-center text-sm text-og-400">{t.common.loading}</div>;
    }
    const project = projects.find((p) => p.id === task.projectId);
    const team = project?.agent.find((g) => g.some((a) => a.id === task.devAgentId))
      ?? (task.qaAgentId ? project?.agent.find((g) => g.some((a) => a.id === task.qaAgentId)) : undefined);
    const devConfig = team?.find((a) => a.role === 'dev' && a.id === task.devAgentId);
    const qaConfig = task.qaAgentId
      ? team?.find((a) => a.role === 'qa' && a.id === task.qaAgentId)
      : undefined;

    if (!devConfig && !qaConfig) {
      return <div className="rounded-lg border border-hairline bg-surface px-3 py-6 text-center text-sm text-og-400">{t.taskDetail.noLinkedAgent}</div>;
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
        model={cfg.model}
        pendingRestart={agentsLoaded && !snapshot}
        terminalLoading={!agentsLoaded && !snapshot && !agentsErrorPayload}
        showTaskBinding={false}
        terminalMode="embedded-full"
        active={activeAgentId === cfg.id}
        onActivate={() => activateAgentCard(cfg.id)}
        task={task}
      />
    );
  }

  function renderActions(task: TaskState) {
    const isMaxRounds = task.status === 'max_rounds';
    const isCodeMaxRounds = isMaxRounds && !isSpecStagePhase(task.phase);
    const isGate = task.status === 'merge-ready';
    const editEnabled = task.status === 'pending';
    const terminal = RETRYABLE_STATUSES.has(task.status);
    const retryEnabled = terminal && !!task.preferredAgentId;
    const advanceEnabled = ['pending', 'in_progress', 'fixing', 'review', 'approved'].includes(task.status);
    const qaAdvanceEnabled = (task.status === 'in_progress' || task.status === 'fixing')
      && task.qaAgentId !== undefined;
    const completeEnabled = isCodeMaxRounds && task.prNumber !== undefined;
    const continueEnabled = completeEnabled && !!task.agentId;
    const isUnassigned = task.preferredAgentId === '';

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
        {terminal && task.replacementTaskId === undefined && (
          <button
            type="button"
            disabled={!retryEnabled || retrying}
            onClick={handleRetry}
            title={isUnassigned ? t.taskDetail.retryDisabledUnassignedTitle : t.taskDetail.retryEnabledTitle}
            className="btn-secondary"
          >
            {retrying ? t.common.retrying : t.common.retry}
          </button>
        )}
        {advanceEnabled && (
          <button
            type="button"
            disabled={advancing}
            onClick={() => void handleAdvance()}
            className="btn-primary"
          >
            {advancing ? t.taskDetail.advancing : t.taskDetail.advance}
          </button>
        )}
        {qaAdvanceEnabled && (
          <button
            type="button"
            disabled={advancing}
            onClick={() => void handleAdvance('qa')}
            className="btn-secondary"
          >
            {t.taskDetail.advanceToQa}
          </button>
        )}
        {isCodeMaxRounds && (
          <>
            <button
              type="button"
              disabled={!continueEnabled || continuing}
              onClick={handleContinue}
              title={t.taskDetail.continueButtonTitle}
              className="btn-secondary"
            >
              {continuing ? t.taskDetail.continuing : t.taskDetail.verdictContinue}
            </button>
            <button
              type="button"
              disabled={!completeEnabled || completing}
              onClick={handleComplete}
              title={t.taskDetail.completeButtonTitle}
              className="btn-primary"
            >
              {completing ? t.taskDetail.completing : t.taskDetail.verdictComplete}
            </button>
          </>
        )}
        {isGate && (
          <button
            type="button"
            disabled={completing}
            onClick={handleConfirmGate}
            title={t.taskDetail.confirmButtonTitle}
            className="btn-primary"
          >
            {completing ? t.taskDetail.confirming : t.taskDetail.confirmMerge}
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
