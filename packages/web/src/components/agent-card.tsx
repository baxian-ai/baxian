import type { AgentRole, AgentRuntime, AgentSnapshot } from '../shared/index.js';
import { type KeyboardEvent as ReactKeyboardEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { KebabMenu, MenuItem } from './kebab-menu.tsx';
import { api } from '../api.ts';
import { useToast } from './toast.tsx';
import { useConfirm } from './confirm-dialog.tsx';
import { usePendingRestart } from '../hooks/use-pending-restart.tsx';
import { PaneTerminal } from './pane-terminal.tsx';
import { AgentPet } from './agent-pet.tsx';
import { AgentPetConfigModal } from './agent-pet-config-modal.tsx';
import { agentRuntimeLabel, agentRuntimeTitle } from '../shared/index.js';
import { useT } from '../i18n/index.tsx';

export type TerminalMode = 'activity-preview' | 'embedded-full';

const RUNTIME_BADGE_CLASSES: Record<AgentSnapshot['runtimeStatus'], string> = {
  unknown: 'pill pill-idle',
  idle: 'pill pill-idle',
  pending: 'pill pill-warn',
  working: 'pill pill-live',
  waiting: 'pill pill-review',
  error: 'pill pill-warn',
};

const AGENT_CARD_PET_HEIGHT = 72;

type TmuxDotState = AgentSnapshot['tmuxSessionStatus'] | 'starting';

const TMUX_DOT_CLASSES: Record<Exclude<TmuxDotState, 'present'>, string> = {
  absent: 'status-dot--warn',
  unreachable: 'status-dot--danger',
  unknown: 'status-dot--warn',
  starting: 'status-dot--info',
};

function StatusDot({ state }: { state: TmuxDotState }) {
  const t = useT();
  if (state === 'present') return null;
  const label = t.agents.sessionStatus[state];
  const modifier = TMUX_DOT_CLASSES[state];
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`status-dot ml-2 ${modifier}`}
    />
  );
}

interface AgentCardProps {
  agent: AgentSnapshot;
  projectId: string;
  role: AgentRole;
  runtime?: AgentRuntime;
  onDeleted?: () => void;
  pendingRestart?: boolean;
  terminalLoading?: boolean;
  showTaskBinding?: boolean;
  terminalMode?: TerminalMode;
  active?: boolean;
  onActivate?: () => void;
}

export function AgentCard({
  agent,
  projectId,
  role,
  runtime,
  onDeleted,
  pendingRestart = false,
  terminalLoading = false,
  showTaskBinding = true,
  terminalMode = 'activity-preview',
  active,
  onActivate,
}: AgentCardProps) {
  const t = useT();
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const { show } = useToast();
  const confirmDialog = useConfirm();
  const { flagDirty } = usePendingRestart();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [retryingBootstrap, setRetryingBootstrap] = useState(false);
  const [petModalOpen, setPetModalOpen] = useState(false);

  const taskId = agent.binding?.taskId;
  const isAwaitingHuman = agent.binding?.status === 'awaiting_human';
  const needInputAt = agent.binding?.needInputAt;
  const needInputTitle = needInputAt
    ? t.agents.needInputTitle(new Date(needInputAt).toLocaleString())
    : undefined;
  const needsRegreet = isAwaitingHuman && agent.binding?.awaitingPhase === 'greeting_failed';
  const isBootstrapping = !!agent.binding?.creationToken
    && !agent.binding?.paneId
    && !isAwaitingHuman
    && agent.reason !== 'PENDING_HUMAN';
  const bootstrapBlocksTerminal = isBootstrapping && agent.tmuxSessionStatus !== 'present';
  const runtimeBadge = isBootstrapping
    ? { label: t.agents.bootstrappingBadge, cls: 'pill pill-review' }
    : { label: t.agents.runtimeStatus[agent.runtimeStatus], cls: RUNTIME_BADGE_CLASSES[agent.runtimeStatus] };
  const tmuxDotState: TmuxDotState = isBootstrapping ? 'starting' : agent.tmuxSessionStatus;
  const showTerminalPreview = terminalMode === 'activity-preview' &&
    !bootstrapBlocksTerminal && (agent.runtimeStatus === 'working' || agent.runtimeStatus === 'pending');
  const showEmbeddedTerminal = terminalMode === 'embedded-full';
  const isSelectableEmbedded = showEmbeddedTerminal && typeof onActivate === 'function';
  const isActiveSelected = isSelectableEmbedded && active === true;
  const terminalDisabled = terminalLoading || pendingRestart || bootstrapBlocksTerminal;
  const terminalDisabledMessage = terminalLoading
    ? t.agents.agentStatusLoading
    : pendingRestart
      ? t.agents.terminalNeedsRestart
      : t.agents.bootstrappingTerminalDisabled;
  const runtimeTypeLabel = agentRuntimeLabel(runtime);

  const handleStop = async () => {
    setStopping(true);
    setStopError(null);
    try {
      await api.agents.stop(agent.id);
    } catch (err) {
      setStopError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  };

  const handleRequestReview = async () => {
    if (!taskId) return;
    const ok = await confirmDialog({
      title: t.agents.confirmReReviewTitle,
      body: t.agents.confirmReReviewBody(taskId),
      confirmLabel: t.agents.confirmReReviewLabel,
    });
    if (!ok) return;
    setReviewing(true);
    try {
      const updated = await api.tasks.review(taskId);
      const round = updated.phase === 'spec' ? (updated.specReviewRound ?? 0) : updated.reviewRound;
      show({ kind: 'success', title: t.agents.reReviewStarted(round) });
    } catch (err) {
      show({ kind: 'error', title: t.agents.reReviewStartFailed, body: err instanceof Error ? err.message : String(err) });
    } finally {
      setReviewing(false);
    }
  };

  const handleRetryBootstrap = async () => {
    setRetryingBootstrap(true);
    try {
      const result = await api.projects.bootstrap(projectId);
      if (result.ok) {
        show({ kind: 'success', title: t.agents.retryBootstrapSucceededTitle, body: t.agents.retryBootstrapSucceededBody });
      } else {
        show({ kind: 'warn', title: t.agents.retryBootstrapStillFailingTitle, body: t.agents.retryBootstrapStillFailingBody });
      }
    } catch (err) {
      show({ kind: 'error', title: t.agents.retryBootstrapFailedTitle, body: err instanceof Error ? err.message : String(err) });
    } finally {
      setRetryingBootstrap(false);
    }
  };

  const handleResume = async () => {
    const ok = await confirmDialog({
      title: t.agents.resumeConfirmTitle(agent.id),
      body: needsRegreet ? t.agents.resumeGreetingBody : t.agents.resumeDefaultBody,
      confirmLabel: t.agents.resume,
    });
    if (!ok) return;
    setResuming(true);
    try {
      if (needsRegreet) {
        if (agent.tmuxSessionStatus === 'present') {
          await api.projects.restartRepl(projectId, agent.id);
        } else {
          await api.projects.retryAgent(projectId, agent.id);
        }
        show({
          kind: 'success',
          title: t.agents.regreetingStartedTitle(agent.id),
          body: t.agents.regreetingStartedBody,
        });
        return;
      }
      const result = await api.projects.resumeAgent(projectId, agent.id);
      show({
        kind: 'success',
        title: t.agents.resumedTitle(agent.id),
        body: result.releasedBinding ? t.agents.resumedReleasedBody : t.agents.resumedKeptBody,
      });
    } catch (err) {
      show({ kind: 'error', title: t.agents.resumeFailedTitle, body: err instanceof Error ? err.message : String(err) });
    } finally {
      setResuming(false);
    }
  };

  const handleCompact = async () => {
    setCompacting(true);
    try {
      await api.agents.compact(agent.id);
      show({ kind: 'success', title: t.agents.compactSentTitle(agent.id) });
    } catch (err) {
      show({
        kind: 'error',
        title: t.agents.compactFailedTitle,
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setCompacting(false);
    }
  };

  const handleClear = async () => {
    if (!(await confirmDialog({ title: t.agents.clearConfirmTitle(agent.id), body: t.agents.clearConfirmBody, confirmLabel: t.agents.clearConfirmLabel }))) return;
    setClearing(true);
    try {
      await api.agents.clear(agent.id);
      show({ kind: 'success', title: t.agents.clearSentTitle(agent.id) });
    } catch (err) {
      show({
        kind: 'error',
        title: t.agents.clearFailedTitle,
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setClearing(false);
    }
  };

  const handleDelete = async () => {
    if (!(await confirmDialog({ title: t.agents.deleteConfirmTitle(agent.id), body: t.agents.deleteConfirmBody, confirmLabel: t.common.delete }))) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await api.projects.deleteAgent(projectId, agent.id);
      if (result?.restartRequired) flagDirty();
      const removed = result?.removed ?? [agent.id];
      if (removed.length > 1) {
        const others = removed.filter(id => id !== agent.id).join(', ');
        show({
          kind: 'warn',
          title: t.agents.deletedWithPairTitle(agent.id),
          body: t.agents.deletedWithPairBody(others),
        });
      } else {
        show({
          kind: 'success',
          title: t.agents.deletedTitle(agent.id),
        });
      }
      onDeleted?.();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };
  const allowSelection = isSelectableEmbedded && !terminalDisabled && !isActiveSelected;
  const cardClassName = [
    'card relative flex h-full min-w-0 flex-col overflow-visible p-4',
    isActiveSelected ? 'ring-2 ring-accent' : '',
  ].filter(Boolean).join(' ');
  const headerClassName = [
    'mb-3 flex items-start justify-between gap-2',
    agent.petId ? 'pr-28' : '',
  ].filter(Boolean).join(' ');
  const terminalContainerClassName = [
    'mb-2 mt-3 h-80 min-h-0 overflow-hidden border border-hairline bg-surface',
    allowSelection ? 'cursor-pointer' : '',
  ].filter(Boolean).join(' ');
  const onTerminalContainerClick = allowSelection ? () => onActivate?.() : undefined;
  const onTerminalContainerKeyDown = allowSelection
    ? (e: ReactKeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate?.();
        }
      }
    : undefined;
  return (
    <div
      className={cardClassName}
      data-agent-card={isSelectableEmbedded ? agent.id : undefined}
    >
      {agent.petId && (
        <div className="absolute -top-4 right-7 z-10">
          <AgentPet
            petId={agent.petId}
            status={agent.runtimeStatus}
            bootstrapping={isBootstrapping}
            label={runtimeBadge.label}
            displayHeight={AGENT_CARD_PET_HEIGHT}
          />
        </div>
      )}
      <div className={headerClassName}>
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-xs font-medium tracking-[0.05em] text-og-500">{role === 'qa' ? 'QA' : 'Dev'}</span>
          <span
            className="min-w-0 truncate whitespace-nowrap font-display text-sm font-semibold text-og-1000"
            title={agentRuntimeTitle(agent.id, runtime)}
          >
            {agent.id}
          </span>
          {runtimeTypeLabel && (
            <span
              className="hidden shrink-0 whitespace-nowrap text-xs text-og-400 sm:inline"
              title={runtimeTypeLabel}
            >
              ({runtimeTypeLabel})
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1">
          {isAwaitingHuman && (
            <span className="pill pill-warn" title={agent.binding?.awaitingReason ?? t.agents.heldDefaultReason}>{t.agents.heldBadge}</span>
          )}
          {needInputAt && (
            <span className="pill pill-warn" title={needInputTitle}>{t.agents.needInputBadge}</span>
          )}
          {!agent.petId && (
            <span className={runtimeBadge.cls}>{runtimeBadge.label}</span>
          )}
          {agent.stale && (
            <span className="pill pill-warn" title={agent.observedAt ? `Last observed at ${agent.observedAt}` : undefined}>
              {t.agents.staleBadge}
            </span>
          )}
          <StatusDot state={tmuxDotState} />
        </div>
      </div>
      {bootstrapBlocksTerminal && (
        <div className="mb-2 rounded-md border border-accent-soft bg-accent-soft/40 px-2.5 py-2 text-xs text-accent">
          {t.agents.bootstrappingNotice}
        </div>
      )}
      {isAwaitingHuman && (
        <div className="mb-2 rounded-md border border-accent/25 bg-accent-soft/60 px-2.5 py-2 text-xs text-accent">
          <span className="font-mono">{agent.binding?.awaitingPhase}</span>
          {agent.binding?.awaitingReason && <span> · {agent.binding.awaitingReason}</span>}
        </div>
      )}
      {!isBootstrapping && agent.runtimeStatus === 'pending' && (
        <div className="mb-2 space-y-1 rounded-md border border-accent/25 bg-accent-soft/60 px-2.5 py-2 text-xs text-accent">
          <div className="font-medium">{t.agents.awaitingHumanIntervention}</div>
          <div>
            {t.agents.openTerminalPrefix}
            <Link to={`/terminal/${agent.id}`} className="text-accent hover:text-accent-hover underline">{t.agents.terminal}</Link>
            {t.agents.openTerminalSuffix}
          </div>
        </div>
      )}
      {needInputAt && (
        <div className="mb-2 space-y-1 rounded-md border border-accent/25 bg-accent-soft/60 px-2.5 py-2 text-xs text-accent">
          <div className="font-medium">{t.agents.needInputNoticeTitle}</div>
          <div>
            {t.agents.needInputPrefix}
            <Link to={`/terminal/${agent.id}`} className="text-accent hover:text-accent-hover underline">{t.agents.terminal}</Link>
            {t.agents.needInputSuffix}
          </div>
        </div>
      )}
      {agent.latestError && (
        <div className="mb-2 space-y-1 rounded-md border border-accent/25 bg-accent-soft px-2.5 py-2 text-xs text-accent">
          <div className="break-words font-medium">{agent.latestError.message}</div>
          <div className="font-mono text-xs opacity-80">{agent.latestError.reason} · {agent.latestError.occurredAt}</div>
        </div>
      )}
      {agent.latestBootstrapError && (
        <div className="mb-2 space-y-1 rounded-md border border-accent/25 bg-accent-soft px-2.5 py-2 text-xs text-accent">
          <div className="break-words font-medium">{agent.latestBootstrapError.message}</div>
          {agent.latestBootstrapError.recommendation && (
            <div className="break-words">{agent.latestBootstrapError.recommendation}</div>
          )}
          <div className="flex items-center justify-between gap-2">
            <div className="truncate font-mono text-xs opacity-80">
              {agent.latestBootstrapError.reason} · {agent.latestBootstrapError.occurredAt}
            </div>
            <button
              type="button"
              onClick={handleRetryBootstrap}
              disabled={retryingBootstrap}
              className="btn-primary shrink-0"
            >
              {retryingBootstrap ? t.common.retrying : t.agents.retryBootstrap}
            </button>
          </div>
        </div>
      )}
      {showTaskBinding && taskId && (
        <div className="mb-2 text-xs text-og-500">
          {t.agents.taskLabel}<span className="font-mono text-og-700">{taskId}</span>
        </div>
      )}
      {showTerminalPreview && (
        <div className="mb-2 overflow-hidden border border-hairline bg-surface">
          <PaneTerminal agentId={agent.id} mode="preview" maxLines={6} interactive={false} />
        </div>
      )}
      {showEmbeddedTerminal && (
        <div
          className={terminalContainerClassName}
          role={allowSelection ? 'button' : undefined}
          tabIndex={allowSelection ? 0 : undefined}
          aria-label={allowSelection ? t.agents.activateTerminal(agent.id) : undefined}
          onClick={onTerminalContainerClick}
          onKeyDown={onTerminalContainerKeyDown}
        >
          {terminalDisabled ? (
            <div className="flex h-full items-center justify-center px-3 text-sm text-og-500">
              {terminalDisabledMessage}
            </div>
          ) : isSelectableEmbedded ? (
            isActiveSelected ? (
              <PaneTerminal agentId={agent.id} mode="full" interactive autoFocus />
            ) : (
              <PaneTerminal agentId={agent.id} mode="preview" interactive={false} />
            )
          ) : (
            <PaneTerminal agentId={agent.id} mode="full" interactive autoFocus={false} deferFullUntilFocus />
          )}
        </div>
      )}
      {pendingRestart && (
        <div className="mb-2 rounded-md border border-accent/25 bg-accent-soft/60 px-2.5 py-1.5 text-xs text-accent">
          {t.agents.pendingRestartNotice}
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto scrollbar-none">
          {terminalDisabled ? (
            <span className="shrink-0 cursor-not-allowed text-sm text-og-400" title={terminalDisabledMessage}>
              {t.agents.terminal}
            </span>
          ) : (
            <Link to={`/terminal/${agent.id}`} className="btn-secondary shrink-0">{t.agents.terminal}</Link>
          )}
          {!pendingRestart && agent.runtimeStatus === 'working' && (
            <button
              onClick={handleStop}
              disabled={stopping}
              className="btn-ghost shrink-0"
            >
              {stopping ? t.agents.stopping : t.agents.stop}
            </button>
          )}
          {isAwaitingHuman && (
            <button
              type="button"
              onClick={handleResume}
              disabled={resuming}
              title={needsRegreet
                ? t.agents.resumeGreetingButtonTitle
                : t.agents.resumeDefaultButtonTitle}
              className="btn-primary shrink-0"
            >
              {resuming ? t.agents.resuming : t.agents.resume}
            </button>
          )}
        </div>
        <KebabMenu ariaLabel={t.agents.actionsMenu(agent.id)} className="shrink-0" placement="up" autoFocusFirstItem disabled={deleting}>
          {close => (
            <>
              <MenuItem
                onClick={() => { close(); setPetModalOpen(true); }}
                disabled={compacting || clearing || deleting}
                title={t.agents.agentPetMenuItemTitle}
              >
                Agent Pet
              </MenuItem>
              <MenuItem
                onClick={() => { close(); void handleCompact(); }}
                disabled={compacting || clearing || deleting}
                title={t.agents.compactMenuItemTitle}
              >
                {compacting ? t.agents.compacting : t.agents.compact}
              </MenuItem>
              <MenuItem
                onClick={() => { close(); void handleClear(); }}
                disabled={clearing || compacting || deleting}
                title={t.agents.clearMenuItemTitle}
              >
                {clearing ? t.agents.clearing : t.agents.clear}
              </MenuItem>
              {!pendingRestart && taskId && role === 'dev' && (
                <MenuItem
                  onClick={() => { close(); void handleRequestReview(); }}
                  disabled={reviewing || deleting}
                  title={t.agents.callReviewMenuItemTitle(taskId)}
                >
                  {reviewing ? t.agents.callingReview : t.agents.callReview}
                </MenuItem>
              )}
              <MenuItem
                onClick={() => { close(); void handleDelete(); }}
                disabled={deleting || compacting || clearing}
              >
                {deleting ? t.common.deleting : t.common.delete}
              </MenuItem>
            </>
          )}
        </KebabMenu>
      </div>
      {stopError && <div className="mt-1.5 break-words text-xs text-accent">{stopError}</div>}
      {deleteError && <div className="mt-1.5 break-words text-xs text-accent">{deleteError}</div>}
      {petModalOpen && (
        <AgentPetConfigModal
          agentId={agent.id}
          currentPetId={agent.petId ?? null}
          onClose={() => setPetModalOpen(false)}
        />
      )}
    </div>
  );
}
