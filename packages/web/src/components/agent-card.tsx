import {
  TASK_ACTIVE_STATUS_SET,
  type AgentRole,
  type AgentRuntime,
  type AgentSnapshot,
  type TaskState,
} from '../shared/index.js';
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
import { useT, type Messages } from '../i18n/index.tsx';
import { taskDetailPath } from './task-status.tsx';

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

export type AgentHoldRecovery = 'resume' | 'restart-runtime' | 'terminal' | 'task' | 'delete-agent';

export function agentHoldRecovery(
  awaitingPhase: string | undefined,
  role: AgentRole,
  task?: Pick<TaskState, 'status'>,
): AgentHoldRecovery {
  const activeTask = task !== undefined && TASK_ACTIVE_STATUS_SET.has(task.status);
  if (awaitingPhase === 'greeting_failed') return 'restart-runtime';
  if (awaitingPhase === 'agent_dialog_pending') return 'terminal';
  if (activeTask && (awaitingPhase === 'agent_dialog_resolved_runtime'
    || awaitingPhase?.startsWith('signal-arm-failed'))) return 'task';
  if (activeTask && (awaitingPhase === 'dispatch-failed:ack_unknown'
    || awaitingPhase === 'dev-wait-gate-failed-after-qa-started')) return 'task';
  if (activeTask
    && task.status !== 'spec-ready'
    && task.status !== 'max_rounds'
    && (awaitingPhase === 'dirty-workdir' || awaitingPhase === 'checkout-preparation-failed')
    && role === 'dev') return 'task';
  return 'resume';
}

export interface AgentBadge {
  kind: 'alert' | 'runtime';
  label: string;
  cls: string;
  title?: string;
  stale: boolean;
}

function isAgentBootstrapping(agent: AgentSnapshot): boolean {
  return !!agent.binding?.creationToken
    && !agent.binding.paneId
    && agent.binding.status !== 'awaiting_human'
    && agent.reason !== 'PENDING_HUMAN';
}

function baseBadge(agent: AgentSnapshot, t: Messages['agents']): Omit<AgentBadge, 'stale'> {
  if (agent.tmuxSessionStatus === 'unreachable') {
    return { kind: 'alert', label: t.sessionStatus.unreachable, cls: 'pill pill-danger' };
  }
  if (isAgentBootstrapping(agent)) {
    return { kind: 'runtime', label: t.bootstrappingBadge, cls: 'pill pill-review' };
  }
  if (agent.tmuxSessionStatus === 'absent') {
    return { kind: 'alert', label: t.sessionStatus.absent, cls: 'pill pill-warn' };
  }
  if (agent.runtimeStatus === 'error') {
    return { kind: 'alert', label: t.runtimeStatus.error, cls: RUNTIME_BADGE_CLASSES.error };
  }
  if (agent.binding?.status === 'awaiting_human') {
    return {
      kind: 'alert',
      label: t.heldBadge,
      cls: 'pill pill-warn',
      title: agent.binding.awaitingReason ?? t.heldDefaultReason,
    };
  }
  if (agent.binding?.needInput?.at) {
    return {
      kind: 'alert',
      label: t.needInputBadge,
      cls: 'pill pill-warn',
      title: t.needInputTitle(new Date(agent.binding.needInput.at).toLocaleString()),
    };
  }
  if (agent.runtimeStatus === 'pending') {
    return { kind: 'alert', label: t.runtimeStatus.pending, cls: RUNTIME_BADGE_CLASSES.pending };
  }
  return {
    kind: 'runtime',
    label: t.runtimeStatus[agent.runtimeStatus],
    cls: RUNTIME_BADGE_CLASSES[agent.runtimeStatus],
  };
}

export function resolveAgentBadge(agent: AgentSnapshot, t: Messages['agents']): AgentBadge {
  const base = baseBadge(agent, t);
  if (!agent.stale) return { ...base, stale: false };
  const staleNote = t.staleTitle(agent.observedAt ? new Date(agent.observedAt).toLocaleString() : undefined);
  return {
    ...base,
    stale: true,
    title: base.title ? `${base.title} · ${staleNote}` : staleNote,
  };
}

interface AgentCardProps {
  agent: AgentSnapshot;
  projectId: string;
  role: AgentRole;
  runtime?: AgentRuntime;
  model?: string;
  onDeleted?: () => void;
  pendingRestart?: boolean;
  terminalLoading?: boolean;
  showTaskBinding?: boolean;
  terminalMode?: TerminalMode;
  active?: boolean;
  onActivate?: () => void;
  task?: TaskState;
}

export function AgentCard({
  agent,
  projectId,
  role,
  runtime,
  model,
  onDeleted,
  pendingRestart = false,
  terminalLoading = false,
  showTaskBinding = true,
  terminalMode = 'activity-preview',
  active,
  onActivate,
  task,
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
  const [resuming, setResuming] = useState(false);
  const [retryingBootstrap, setRetryingBootstrap] = useState(false);
  const [petModalOpen, setPetModalOpen] = useState(false);

  const taskId = agent.binding?.taskId;
  const boundTask = task?.id === taskId ? task : undefined;
  const isAwaitingHuman = agent.binding?.status === 'awaiting_human';
  const needInputAt = agent.binding?.needInput?.at;
  const needsRegreet = isAwaitingHuman && agent.binding?.awaitingPhase === 'greeting_failed';
  const holdRecovery = agentHoldRecovery(agent.binding?.awaitingPhase, role, boundTask);
  const isBootstrapping = isAgentBootstrapping(agent);
  const bootstrapBlocksTerminal = isBootstrapping && agent.tmuxSessionStatus !== 'present';
  const badge = resolveAgentBadge(agent, t.agents);
  const petLabel = isBootstrapping
    ? t.agents.bootstrappingBadge
    : t.agents.runtimeStatus[agent.runtimeStatus];
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
  const runtimeTypeLabel = agentRuntimeLabel(runtime, model);

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
      const warningLines = [...(result?.warnings ?? [])];
      if (removed.length > 1) {
        const others = removed.filter(id => id !== agent.id).join(', ');
        warningLines.unshift(t.agents.deletedWithTeamBody(others));
      }
      if (warningLines.length > 0) {
        show({
          kind: 'warn',
          title: removed.length > 1
            ? t.agents.deletedWithTeamTitle(agent.id)
            : t.agents.deletedTitle(agent.id),
          body: warningLines.join('\n'),
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
            label={petLabel}
            displayHeight={AGENT_CARD_PET_HEIGHT}
          />
        </div>
      )}
      <div className={headerClassName}>
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-xs font-medium tracking-[0.05em] text-og-500">
            {role === 'qa' ? 'QA' : 'Dev'}
          </span>
          <span
            className="min-w-0 truncate whitespace-nowrap font-display text-sm font-semibold text-og-1000"
            title={agentRuntimeTitle(agent.id, runtime, model)}
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
        {(!agent.petId || badge.kind === 'alert' || badge.stale) && (
          <>
            <span
              className={badge.stale ? `${badge.cls} pill--stale shrink-0` : `${badge.cls} shrink-0`}
              title={badge.title}
            >
              {badge.label}
            </span>
            {badge.stale && <span className="sr-only">{badge.title}</span>}
          </>
        )}
      </div>
      {bootstrapBlocksTerminal && (
        <div className="mb-2 rounded-md border border-accent-soft bg-accent-soft/40 px-2.5 py-2 text-xs text-accent">
          {t.agents.bootstrappingNotice}
        </div>
      )}
      {isAwaitingHuman && (
        <div className="mb-2 space-y-1 rounded-md border border-accent/25 bg-accent-soft/60 px-2.5 py-2 text-xs text-accent">
          <div>
            <span className="font-mono">{agent.binding?.awaitingPhase}</span>
            {agent.binding?.awaitingReason && <span> · {agent.binding.awaitingReason}</span>}
          </div>
          <div className="text-og-700">{t.agents.holdRecovery[holdRecovery]}</div>
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
          {isAwaitingHuman && (holdRecovery === 'resume' || holdRecovery === 'restart-runtime') && (
            <button
              type="button"
              onClick={handleResume}
              disabled={resuming}
              title={needsRegreet
                ? t.agents.resumeGreetingButtonTitle
                : t.agents.resumeDefaultButtonTitle}
              className="btn-primary shrink-0"
            >
              {resuming
                ? t.agents.resuming
                : holdRecovery === 'restart-runtime'
                  ? t.agents.restartRuntime
                  : t.agents.resume}
            </button>
          )}
          {isAwaitingHuman && holdRecovery === 'terminal' && (
            <Link to={`/terminal/${agent.id}`} className="btn-primary shrink-0">
              {t.agents.openTerminalAction}
            </Link>
          )}
          {isAwaitingHuman && holdRecovery === 'task' && taskId && (
            <Link to={taskDetailPath(projectId, taskId)} className="btn-primary shrink-0">
              {t.agents.openTaskActions}
            </Link>
          )}
          {isAwaitingHuman && holdRecovery === 'delete-agent' && (
            <button type="button" onClick={() => void handleDelete()} disabled={deleting} className="btn-primary shrink-0">
              {deleting ? t.common.deleting : t.agents.deleteToRecover}
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
