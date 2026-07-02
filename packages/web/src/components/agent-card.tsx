import type { AgentRole, AgentRuntime, AgentSnapshot } from '../shared/index.js';
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.ts';
import { useToast } from './toast.tsx';
import { usePendingRestart } from '../hooks/use-pending-restart.tsx';
import { PaneTerminal } from './pane-terminal.tsx';
import { AgentPet } from './agent-pet.tsx';
import { AgentPetConfigModal } from './agent-pet-config-modal.tsx';
import { agentRuntimeLabel, agentRuntimeTitle } from '../shared/index.js';

export type TerminalMode = 'activity-preview' | 'embedded-full';

const RUNTIME_BADGES: Record<AgentSnapshot['runtimeStatus'], { label: string; cls: string }> = {
  unknown: { label: 'Unknown', cls: 'pill pill-idle' },
  idle: { label: 'Idle', cls: 'pill pill-idle' },
  pending: { label: 'Pending user', cls: 'pill pill-warn' },
  working: { label: 'Working', cls: 'pill pill-live' },
  waiting: { label: 'Waiting', cls: 'pill pill-review' },
  error: { label: 'Error', cls: 'pill pill-warn' },
};

const AGENT_CARD_PET_HEIGHT = 72;

type TmuxDotState = AgentSnapshot['tmuxSessionStatus'] | 'starting';

const TMUX_DOTS: Record<Exclude<TmuxDotState, 'present'>, { label: string; modifier: string }> = {
  absent: { label: 'No session', modifier: 'status-dot--warn' },
  unreachable: { label: 'Host unreachable', modifier: 'status-dot--danger' },
  unknown: { label: 'Session unknown', modifier: 'status-dot--warn' },
  starting: { label: 'Starting session', modifier: 'status-dot--info' },
};

function StatusDot({ state }: { state: TmuxDotState }) {
  if (state === 'present') return null;
  const { label, modifier } = TMUX_DOTS[state];
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
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const { show } = useToast();
  const { flagDirty } = usePendingRestart();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [retryingBootstrap, setRetryingBootstrap] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [petModalOpen, setPetModalOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const menuTriggerId = useId();

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointer = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (menuButtonRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const firstItem = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])');
    firstItem?.focus();
  }, [menuOpen]);
  const taskId = agent.binding?.taskId;
  const isAwaitingHuman = agent.binding?.status === 'awaiting_human';
  const needsRegreet = isAwaitingHuman && agent.binding?.awaitingPhase === 'greeting_failed';
  const isBootstrapping = !!agent.binding?.creationToken
    && !agent.binding?.paneId
    && !isAwaitingHuman
    && agent.reason !== 'PENDING_HUMAN';
  const bootstrapBlocksTerminal = isBootstrapping && agent.tmuxSessionStatus !== 'present';
  const runtimeBadge = isBootstrapping
    ? { label: 'Starting', cls: 'pill pill-review' }
    : RUNTIME_BADGES[agent.runtimeStatus];
  const tmuxDotState: TmuxDotState = isBootstrapping ? 'starting' : agent.tmuxSessionStatus;
  const showTerminalPreview = terminalMode === 'activity-preview' &&
    !bootstrapBlocksTerminal && (agent.runtimeStatus === 'working' || agent.runtimeStatus === 'pending');
  const showEmbeddedTerminal = terminalMode === 'embedded-full';
  const isSelectableEmbedded = showEmbeddedTerminal && typeof onActivate === 'function';
  const isActiveSelected = isSelectableEmbedded && active === true;
  const terminalDisabled = terminalLoading || pendingRestart || bootstrapBlocksTerminal;
  const terminalDisabledMessage = terminalLoading
    ? 'Agent 状态加载中'
    : pendingRestart
      ? '重启 baxian server 后可用'
      : 'Agent 正在启动';
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
    if (!window.confirm(`请 QA 对 task ${taskId} 重审？这会让 QA agent 立即开始新一轮 review（reviewRound +1）。`)) {
      return;
    }
    setReviewing(true);
    try {
      const updated = await api.tasks.review(taskId);
      show({ kind: 'success', title: `已派 QA 重审 (round ${updated.reviewRound})` });
    } catch (err) {
      show({ kind: 'error', title: 'Review 派发失败', body: err instanceof Error ? err.message : String(err) });
    } finally {
      setReviewing(false);
    }
  };

  const handleRetryBootstrap = async () => {
    setRetryingBootstrap(true);
    try {
      const result = await api.projects.bootstrap(projectId);
      if (result.ok) {
        show({ kind: 'success', title: 'Bootstrap retry 完成', body: 'agent 状态将在下一次刷新生效。' });
      } else {
        show({ kind: 'warn', title: 'Bootstrap retry 仍失败', body: '看一下红色错误卡的最新原因，按提示修复后再试。' });
      }
    } catch (err) {
      show({ kind: 'error', title: 'Bootstrap retry 失败', body: err instanceof Error ? err.message : String(err) });
    } finally {
      setRetryingBootstrap(false);
    }
  };

  const handleResume = async () => {
    const confirmMsg = needsRegreet
      ? `确认 Resume Agent ${agent.id}？greeting 能力未通过，baxian 会重跑能力握手（会话存活则重启 REPL，已丢失则重建）；握手通过才解除 Held。`
      : `确认 Resume Agent ${agent.id}？baxian 会清除 awaiting_human 状态，agent 重新可派遣。`;
    if (!window.confirm(confirmMsg)) return;
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
          title: `Agent ${agent.id} 正在重跑能力握手`,
          body: '握手通过后 Held 会在下一次刷新自动解除，仍失败则按提示修复 runtime 后再试。',
        });
        return;
      }
      const result = await api.projects.resumeAgent(projectId, agent.id);
      show({
        kind: 'success',
        title: `Agent ${agent.id} 已 Resume`,
        body: result.releasedBinding ? '原任务已释放，agent 可接新任务。' : '保留绑定（原任务仍 active）。',
      });
    } catch (err) {
      show({ kind: 'error', title: 'Resume 失败', body: err instanceof Error ? err.message : String(err) });
    } finally {
      setResuming(false);
    }
  };

  const handleCompact = async () => {
    setCompacting(true);
    try {
      await api.agents.compact(agent.id);
      show({ kind: 'success', title: `已向 Agent ${agent.id} 发送 /compact` });
    } catch (err) {
      show({
        kind: 'error',
        title: 'Compact 失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setCompacting(false);
    }
  };

  const handleClear = async () => {
    if (!window.confirm(`确认向 Agent ${agent.id} 发送 /clear？这会清空整个会话上下文，不可恢复。`)) return;
    setClearing(true);
    try {
      await api.agents.clear(agent.id);
      show({ kind: 'success', title: `已向 Agent ${agent.id} 发送 /clear` });
    } catch (err) {
      show({
        kind: 'error',
        title: 'Clear 失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setClearing(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`确认删除 Agent ${agent.id}？此操作不可撤销`)) return;
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
          title: `已删除 Agent ${agent.id}`,
          body: `配对的 QA Agent ${others} 也被一并移除。`,
        });
      } else {
        show({
          kind: 'success',
          title: `Agent ${agent.id} 已删除`,
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
          <span className="shrink-0 font-mono text-xs font-medium uppercase tracking-[0.05em] text-og-500">{role}</span>
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
            <span className="pill pill-warn" title={agent.binding?.awaitingReason ?? '需人工处理'}>Held</span>
          )}
          {!agent.petId && (
            <span className={runtimeBadge.cls}>{runtimeBadge.label}</span>
          )}
          {agent.stale && (
            <span className="pill pill-warn" title={agent.observedAt ? `Last observed at ${agent.observedAt}` : undefined}>
              Stale
            </span>
          )}
          <StatusDot state={tmuxDotState} />
        </div>
      </div>
      {bootstrapBlocksTerminal && (
        <div className="mb-2 rounded-md border border-accent-soft bg-accent-soft/40 px-2.5 py-2 text-xs text-accent">
          Agent 正在启动，终端可用后会自动刷新。
        </div>
      )}
      {isAwaitingHuman && (
        <div className="mb-2 rounded-md border border-[#fde68a] bg-[#fef3c7]/60 px-2.5 py-2 text-xs text-warn">
          <span className="font-mono">{agent.binding?.awaitingPhase}</span>
          {agent.binding?.awaitingReason && <span> · {agent.binding.awaitingReason}</span>}
        </div>
      )}
      {!isBootstrapping && agent.runtimeStatus === 'pending' && (
        <div className="mb-2 space-y-1 rounded-md border border-[#fde68a] bg-[#fef3c7]/60 px-2.5 py-2 text-xs text-warn">
          <div className="font-medium">等待人工介入</div>
          <div>
            Agent 正在等待人工输入。请打开 <Link to={`/terminal/${agent.id}`} className="text-accent hover:text-accent-hover underline">Terminal</Link> 处理；
            处理完后状态会随下一次观测刷新。
          </div>
        </div>
      )}
      {agent.latestError && (
        <div className="mb-2 space-y-1 rounded-md border border-[#fecaca] bg-[#fef2f2] px-2.5 py-2 text-xs text-danger">
          <div className="break-words font-medium">{agent.latestError.message}</div>
          <div className="font-mono text-xs opacity-80">{agent.latestError.reason} · {agent.latestError.occurredAt}</div>
        </div>
      )}
      {agent.latestBootstrapError && (
        <div className="mb-2 space-y-1 rounded-md border border-[#fecaca] bg-[#fef2f2] px-2.5 py-2 text-xs text-danger">
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
              className="btn-secondary shrink-0 !border-[#fecaca] !text-danger hover:!bg-[#fef2f2] hover:!border-danger hover:!text-danger"
            >
              {retryingBootstrap ? 'Retrying…' : 'Retry bootstrap'}
            </button>
          </div>
        </div>
      )}
      {showTaskBinding && taskId && (
        <div className="mb-2 text-xs text-og-500">
          Task: <span className="font-mono text-og-700">{taskId}</span>
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
          aria-label={allowSelection ? `激活 ${agent.id} 终端` : undefined}
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
        <div className="mb-2 rounded-md border border-[#fde68a] bg-[#fef3c7]/60 px-2.5 py-1.5 text-xs text-warn">
          ⚠️ 重启 baxian server 后生效
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto scrollbar-none">
          {terminalDisabled ? (
            <span className="shrink-0 cursor-not-allowed text-sm text-og-400" title={terminalDisabledMessage}>
              Terminal
            </span>
          ) : (
            <Link to={`/terminal/${agent.id}`} className="btn-secondary shrink-0">Terminal</Link>
          )}
          {!pendingRestart && agent.runtimeStatus === 'working' && (
            <button
              onClick={handleStop}
              disabled={stopping}
              className="btn-ghost shrink-0 !text-danger hover:!bg-[#fef2f2]"
            >
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          )}
          {isAwaitingHuman && (
            <button
              type="button"
              onClick={handleResume}
              disabled={resuming}
              title={needsRegreet
                ? '重跑 greeting 能力握手以恢复（会话存活则重启 REPL，已丢失则重建；greeting_failed 无法靠清状态解除）'
                : '清除 awaiting_human 状态，让 agent 重新可派遣'}
              className="btn-ghost shrink-0 !text-warn hover:!bg-[#fef3c7]/60"
            >
              {resuming ? 'Resuming…' : 'Resume'}
            </button>
          )}
        </div>
        <div className="relative shrink-0">
          <button
            ref={menuButtonRef}
            id={menuTriggerId}
            type="button"
            onClick={() => setMenuOpen(open => !open)}
            disabled={deleting}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            aria-label={`Agent ${agent.id} 操作菜单`}
            className="flex h-8 w-8 items-center justify-center rounded text-og-500 transition-colors hover:bg-og-50 hover:text-og-1000 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="1" />
              <circle cx="12" cy="5" r="1" />
              <circle cx="12" cy="19" r="1" />
            </svg>
          </button>
          {menuOpen && (
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-labelledby={menuTriggerId}
              className="absolute right-0 bottom-full z-10 mb-1 min-w-[140px] rounded-md border border-hairline bg-surface py-1 shadow-md"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => { setMenuOpen(false); setPetModalOpen(true); }}
                disabled={compacting || clearing || deleting}
                title="配置 Agent Pet（在状态位置显示动画宠物）"
                className="block w-full px-3 py-1.5 text-left text-sm text-og-1000 hover:bg-og-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Agent Pet
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => { setMenuOpen(false); void handleCompact(); }}
                disabled={compacting || clearing || deleting}
                title="向 agent runtime 发送 /compact 压缩上下文"
                className="block w-full px-3 py-1.5 text-left text-sm text-og-1000 hover:bg-og-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {compacting ? 'Compacting…' : 'Compact'}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => { setMenuOpen(false); void handleClear(); }}
                disabled={clearing || compacting || deleting}
                title="向 agent runtime 发送 /clear 清空上下文"
                className="block w-full px-3 py-1.5 text-left text-sm text-og-1000 hover:bg-og-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {clearing ? 'Clearing…' : 'Clear'}
              </button>
              {!pendingRestart && taskId && role === 'dev' && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setMenuOpen(false); void handleRequestReview(); }}
                  disabled={reviewing || deleting}
                  title={`让 QA 立即对 task ${taskId} 跑一轮 review（需要该 task 已有 PR）`}
                  className="block w-full px-3 py-1.5 text-left text-sm text-og-1000 hover:bg-og-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {reviewing ? 'Dispatching…' : 'Call review'}
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => { setMenuOpen(false); void handleDelete(); }}
                disabled={deleting || compacting || clearing}
                className="block w-full px-3 py-1.5 text-left text-sm text-danger hover:bg-[#fef2f2] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          )}
        </div>
      </div>
      {stopError && <div className="mt-1.5 break-words text-xs text-danger">{stopError}</div>}
      {deleteError && <div className="mt-1.5 break-words text-xs text-danger">{deleteError}</div>}
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
