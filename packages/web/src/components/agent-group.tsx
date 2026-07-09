import type { AgentConfig, AgentSnapshot, TaskState } from '../shared/index.js';
import { TASK_ACTIVE_STATUS_SET } from '../shared/index.js';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AgentCard, type TerminalMode } from './agent-card.tsx';
import { api } from '../api.ts';
import { useActiveAgentCard } from '../hooks/use-active-agent-card.ts';
import { useToast } from './toast.tsx';
import { STATUS_BADGE_COLORS, shortTaskId, taskDetailPath } from './task-status.tsx';
import { useT } from '../i18n/index.tsx';

interface AgentGroupProps {
  group: AgentConfig[];
  projectId: string;
  agentsById: Map<string, AgentSnapshot>;
  agentsLoaded: boolean;
  agentsError?: boolean;
  tasks: TaskState[];
  onDeleted?: () => void;
  terminalMode?: TerminalMode;
}

export function AgentGroup({
  group,
  projectId,
  agentsById,
  agentsLoaded,
  agentsError = false,
  tasks,
  onDeleted,
  terminalMode = 'activity-preview',
}: AgentGroupProps) {
  const t = useT();
  const dev = group.find(agent => agent.role === 'dev') ?? group[0];
  const qa = group.find(agent => agent.role === 'qa');
  const activeTasks = tasks.filter(task => taskBelongsToGroup(task, dev?.id, qa?.id));
  const claimableTasks = dev
    ? tasks
        .filter(task => claimableForDev(task, projectId, dev.id))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    : [];
  const devSnapshot = dev ? agentsById.get(dev.id) : undefined;
  const devDispatchReady = !!devSnapshot
    && devSnapshot.runtimeStatus === 'idle'
    && devSnapshot.binding?.status !== 'awaiting_human'
    && !devSnapshot.binding?.creationToken
    && !devSnapshot.binding?.taskId;

  const label = `Agent group ${group.map(agent => agent.id).join(' / ')}`;
  const navigate = useNavigate();

  const selectableTerminals = terminalMode === 'embedded-full';
  const { activeAgentId, activateAgentCard } = useActiveAgentCard({
    coordinateAcrossInstances: selectableTerminals,
  });

  const agentGridCols = terminalMode === 'embedded-full'
    ? group.length <= 1
      ? 'lg:grid-cols-1'
      : group.length === 2
        ? 'lg:grid-cols-2'
        : group.length === 3
          ? 'lg:grid-cols-3'
          : 'lg:grid-cols-4'
    : 'sm:grid-cols-2';

  const showClaimable = !!dev && claimableTasks.length > 0;
  const showEmpty = activeTasks.length === 0 && !showClaimable;
  return (
    <div role="group" aria-label={label} className="min-w-0">
      {showClaimable && dev && (
        <ClaimableList
          tasks={claimableTasks}
          devId={dev.id}
          dispatchReady={devDispatchReady}
          label={label}
        />
      )}
      {activeTasks.length > 0 && (
        <div className="card mb-2 max-h-28 overflow-y-auto divide-y divide-hairline">
          {activeTasks.map(task => {
            const round = task.phase === 'spec' ? (task.specReviewRound ?? 0) : task.reviewRound;
            return (
              <button
                key={task.id}
                type="button"
                onClick={() => navigate(taskDetailPath(task.projectId, task.id))}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-og-50/60"
              >
                <div className="min-w-0 flex-1 flex items-center gap-2">
                  <span className="shrink-0 font-mono text-xs text-og-500" title={task.id}>{shortTaskId(task.id)}</span>
                  <span className="truncate text-og-1000">{task.title}</span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="shrink-0 text-xs text-og-500">{t.agents.round(round)}</span>
                  <span className={`${STATUS_BADGE_COLORS[task.status]} shrink-0`} title={task.status}>{t.status[task.status] ?? task.status}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
      {showEmpty && (
        <div
          className="mb-2 rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-og-400"
          aria-label={t.agents.noActiveTaskAriaLabel(label)}
        >
          {t.agents.noActiveTask}
        </div>
      )}
      <div className={`grid grid-cols-1 ${agentGridCols} gap-4`}>
        {group.map(cfg => {
          const snapshot = agentsById.get(cfg.id);
          const state: AgentSnapshot = snapshot ?? {
            id: cfg.id,
            projectId,
            runtimeStatus: 'unknown',
            tmuxSessionStatus: 'unknown',
            stale: true,
          };
          return (
            <AgentCard
              key={cfg.id}
              agent={state}
              projectId={projectId}
              role={cfg.role}
              runtime={cfg.runtime}
              model={cfg.model}
              pendingRestart={agentsLoaded && !snapshot}
              terminalLoading={!agentsLoaded && !snapshot && !agentsError}
              onDeleted={onDeleted}
              showTaskBinding={false}
              terminalMode={terminalMode}
              {...(selectableTerminals
                ? { active: activeAgentId === cfg.id, onActivate: () => activateAgentCard(cfg.id) }
                : {})}
            />
          );
        })}
      </div>
    </div>
  );
}

interface ClaimableListProps {
  tasks: TaskState[];
  devId: string;
  dispatchReady: boolean;
  label: string;
}

function ClaimableList({ tasks, devId, dispatchReady, label }: ClaimableListProps) {
  const t = useT();
  const { show } = useToast();
  const navigate = useNavigate();
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  const handleDispatch = async (taskId: string) => {
    setBusyTaskId(taskId);
    try {
      await api.tasks.dispatch(taskId, { agentId: devId });
      show({ kind: 'success', title: t.agents.taskHandedTo(taskId, devId) });
    } catch (err) {
      show({
        kind: 'error',
        title: t.agents.startFailed,
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyTaskId(null);
    }
  };

  return (
    <div
      role="group"
      className="card mb-2 max-h-28 overflow-y-auto divide-y divide-hairline"
      aria-label={`${label} claimable tasks for ${devId}`}
    >
      {tasks.map(task => {
        const unassigned = task.preferredAgentId === '';
        const busy = busyTaskId !== null;
        return (
          <div
            key={task.id}
            className="flex items-center gap-3 px-3 py-2 text-sm"
          >
            <button
              type="button"
              onClick={() => navigate(taskDetailPath(task.projectId, task.id))}
              className="min-w-0 flex-1 flex items-center gap-2 text-left transition-colors hover:text-accent-hover"
            >
              <span className="shrink-0 font-mono text-xs text-og-500" title={task.id}>{shortTaskId(task.id)}</span>
              <span className="truncate text-og-1000" title={task.title}>{task.title}</span>
              {unassigned && <span className="pill shrink-0">{t.agents.unassigned}</span>}
            </button>
            <button
              type="button"
              onClick={() => void handleDispatch(task.id)}
              disabled={!dispatchReady || busy}
              title={dispatchReady ? t.agents.handToAndStart(devId) : t.agents.devAgentUnavailable}
              className="shrink-0 text-sm font-medium text-accent transition-colors hover:text-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busyTaskId === task.id ? t.agents.starting : t.agents.start}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function taskBelongsToGroup(task: TaskState, devId: string | undefined, qaId: string | undefined): boolean {
  if (!devId || !TASK_ACTIVE_STATUS_SET.has(task.status)) return false;
  const devMatches = task.agentId === devId || task.preferredAgentId === devId;
  if (!devMatches) return false;
  if (qaId && task.qaAgentId && task.qaAgentId !== qaId) return false;
  return true;
}

function claimableForDev(task: TaskState, projectId: string, devId: string): boolean {
  if (task.projectId !== projectId) return false;
  if (task.status !== 'pending') return false;
  return task.preferredAgentId === devId || task.preferredAgentId === '';
}
