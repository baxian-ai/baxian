import type { AgentConfig, AgentSnapshot, TaskState } from '../shared/index.js';
import { TASK_ACTIVE_STATUS_SET } from '../shared/index.js';
import { useEffect, useId, useState } from 'react';
import { AgentCard, type TerminalMode } from './agent-card.tsx';
import { api } from '../api.ts';
import { useToast } from './toast.tsx';
import { STATUS_BADGE_COLORS, shortTaskId, useTaskDetail } from './task-detail-modal.tsx';

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

const TERMINAL_ACTIVATED_EVENT = 'baxian:terminal-activated';

interface TerminalActivatedDetail {
  groupId: string;
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
  const dev = group.find(agent => agent.role === 'dev') ?? group[0];
  const qa = group.find(agent => agent.role === 'qa');
  const activeTasks = tasks.filter(task => taskBelongsToGroup(task, dev?.id, qa?.id));
  const claimableTasks = dev
    ? tasks
        .filter(t => claimableForDev(t, projectId, dev.id))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    : [];
  const devSnapshot = dev ? agentsById.get(dev.id) : undefined;
  const devDispatchReady = !!devSnapshot
    && devSnapshot.runtimeStatus === 'idle'
    && devSnapshot.binding?.status !== 'awaiting_human'
    && !devSnapshot.binding?.creationToken
    && !devSnapshot.binding?.taskId;

  const label = `Agent group ${group.map(agent => agent.id).join(' / ')}`;
  const { openTask } = useTaskDetail();

  const selectableTerminals = terminalMode === 'embedded-full';
  const groupId = useId();
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectableTerminals) return;
    const onDocClick = (e: MouseEvent) => {
      // React 18 commits the re-render before the native event finishes bubbling, so
      // by the time we run, the click target may already be detached (e.g. PaneTerminal
      // swapped its preview/full subtree). composedPath() is a dispatch-time snapshot and
      // survives that mutation; target.closest() would not.
      const path = e.composedPath();
      const insideCard = path.some(node => node instanceof Element && node.hasAttribute('data-agent-card'));
      if (!insideCard) setActiveAgentId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Esc inside any card belongs to the terminal app (vim/less/Claude TUI etc.) or to a
      // focused control inside the card (its own onKeyDown should win). Only demote when
      // focus has moved entirely outside the card grid.
      const focused = document.activeElement;
      if (focused instanceof Element && focused.closest('[data-agent-card]')) return;
      setActiveAgentId(null);
    };
    const onOtherActivated = (e: Event) => {
      const detail = (e as CustomEvent<TerminalActivatedDetail>).detail;
      if (detail?.groupId !== groupId) setActiveAgentId(null);
    };
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKey);
    document.addEventListener(TERMINAL_ACTIVATED_EVENT, onOtherActivated as EventListener);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener(TERMINAL_ACTIVATED_EVENT, onOtherActivated as EventListener);
    };
  }, [selectableTerminals, groupId]);

  const activate = (agentId: string) => {
    setActiveAgentId(agentId);
    document.dispatchEvent(new CustomEvent<TerminalActivatedDetail>(TERMINAL_ACTIVATED_EVENT, {
      detail: { groupId },
    }));
  };

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
                onClick={() => openTask(task.id)}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] transition-colors hover:bg-og-50/60"
              >
                <div className="min-w-0 flex-1 flex items-center gap-2">
                  <span className="shrink-0 font-mono text-[11px] text-og-500" title={task.id}>{shortTaskId(task.id)}</span>
                  <span className="truncate text-og-1000">{task.title}</span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="shrink-0 text-[12px] text-og-500">Round {round}</span>
                  <span className={`${STATUS_BADGE_COLORS[task.status]} shrink-0`}>{task.status}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
      {showEmpty && (
        <div
          className="mb-2 rounded-lg border border-hairline bg-surface px-3 py-2 text-[13px] text-og-400"
          aria-label={`${label} no active task`}
        >
          暂无任务
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
              pendingRestart={agentsLoaded && !snapshot}
              terminalLoading={!agentsLoaded && !snapshot && !agentsError}
              onDeleted={onDeleted}
              showTaskBinding={false}
              terminalMode={terminalMode}
              {...(selectableTerminals
                ? { active: activeAgentId === cfg.id, onActivate: () => activate(cfg.id) }
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
  const { show } = useToast();
  const { openTask } = useTaskDetail();
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  const handleDispatch = async (taskId: string) => {
    setBusyTaskId(taskId);
    try {
      await api.tasks.dispatch(taskId, { agentId: devId });
      show({ kind: 'success', title: `Task ${taskId} 已派给 ${devId}` });
    } catch (err) {
      show({
        kind: 'error',
        title: '派遣失败',
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
            className="flex items-center gap-3 px-3 py-2 text-[13px]"
          >
            <button
              type="button"
              onClick={() => openTask(task.id)}
              className="min-w-0 flex-1 flex items-center gap-2 text-left transition-colors hover:text-accent-hover"
            >
              <span className="shrink-0 font-mono text-[11px] text-og-500" title={task.id}>{shortTaskId(task.id)}</span>
              <span className="truncate text-og-1000" title={task.title}>{task.title}</span>
              {unassigned && <span className="pill shrink-0">未分配</span>}
            </button>
            <button
              type="button"
              onClick={() => void handleDispatch(task.id)}
              disabled={!dispatchReady || busy}
              title={dispatchReady ? `派给 ${devId} 并立即开始` : 'Dev 当前不可派遣'}
              className="shrink-0 text-[13px] font-medium text-accent transition-colors hover:text-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busyTaskId === task.id ? 'Starting…' : 'Start'}
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
