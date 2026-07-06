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

export type TerminalMode = 'activity-preview' | 'embedded-full';

const RUNTIME_BADGES: Record<AgentSnapshot['runtimeStatus'], { label: string; cls: string }> = {
  unknown: { label: '未知', cls: 'pill pill-idle' },
  idle: { label: '空闲', cls: 'pill pill-idle' },
  pending: { label: '待人工', cls: 'pill pill-warn' },
  working: { label: '工作中', cls: 'pill pill-live' },
  waiting: { label: '等待中', cls: 'pill pill-review' },
  error: { label: '异常', cls: 'pill pill-warn' },
};

const AGENT_CARD_PET_HEIGHT = 72;

type TmuxDotState = AgentSnapshot['tmuxSessionStatus'] | 'starting';

const TMUX_DOTS: Record<Exclude<TmuxDotState, 'present'>, { label: string; modifier: string }> = {
  absent: { label: '无会话', modifier: 'status-dot--warn' },
  unreachable: { label: '主机不可达', modifier: 'status-dot--danger' },
  unknown: { label: '会话状态未知', modifier: 'status-dot--warn' },
  starting: { label: '会话启动中', modifier: 'status-dot--info' },
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
    ? `Agent 在等你的回答（${new Date(needInputAt).toLocaleString()}）`
    : undefined;
  const needsRegreet = isAwaitingHuman && agent.binding?.awaitingPhase === 'greeting_failed';
  const isBootstrapping = !!agent.binding?.creationToken
    && !agent.binding?.paneId
    && !isAwaitingHuman
    && agent.reason !== 'PENDING_HUMAN';
  const bootstrapBlocksTerminal = isBootstrapping && agent.tmuxSessionStatus !== 'present';
  const runtimeBadge = isBootstrapping
    ? { label: '启动中', cls: 'pill pill-review' }
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
    const ok = await confirmDialog({
      title: '发起 QA 重审？',
      body: `QA agent 将对任务 ${taskId} 立即开始新一轮 review（reviewRound +1）。`,
      confirmLabel: '发起重审',
    });
    if (!ok) return;
    setReviewing(true);
    try {
      const updated = await api.tasks.review(taskId);
      show({ kind: 'success', title: `已发起 QA 重审（第 ${updated.reviewRound} 轮）` });
    } catch (err) {
      show({ kind: 'error', title: '发起评审失败', body: err instanceof Error ? err.message : String(err) });
    } finally {
      setReviewing(false);
    }
  };

  const handleRetryBootstrap = async () => {
    setRetryingBootstrap(true);
    try {
      const result = await api.projects.bootstrap(projectId);
      if (result.ok) {
        show({ kind: 'success', title: '重试 bootstrap 完成', body: 'agent 状态将在下一次刷新生效。' });
      } else {
        show({ kind: 'warn', title: '重试 bootstrap 仍失败', body: '看一下红色错误卡的最新原因，按提示修复后再试。' });
      }
    } catch (err) {
      show({ kind: 'error', title: '重试 bootstrap 失败', body: err instanceof Error ? err.message : String(err) });
    } finally {
      setRetryingBootstrap(false);
    }
  };

  const handleResume = async () => {
    const ok = await confirmDialog({
      title: `恢复 Agent ${agent.id}？`,
      body: needsRegreet
        ? 'greeting 能力未通过，baxian 会重跑能力握手（会话存活则重启 REPL，已丢失则重建）；握手通过才解除挂起。'
        : 'baxian 会清除 awaiting_human 状态，agent 恢复可用。',
      confirmLabel: '恢复',
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
        title: '压缩上下文失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setCompacting(false);
    }
  };

  const handleClear = async () => {
    if (!(await confirmDialog({ title: `清空 Agent ${agent.id} 的上下文？`, body: '将发送 /clear，整个会话上下文不可恢复。', confirmLabel: '清空' }))) return;
    setClearing(true);
    try {
      await api.agents.clear(agent.id);
      show({ kind: 'success', title: `已向 Agent ${agent.id} 发送 /clear` });
    } catch (err) {
      show({
        kind: 'error',
        title: '清空上下文失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setClearing(false);
    }
  };

  const handleDelete = async () => {
    if (!(await confirmDialog({ title: `删除 Agent ${agent.id}？`, body: '此操作不可撤销。', confirmLabel: '删除' }))) return;
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
          body: `配对的 QA agent ${others} 也被一并移除。`,
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
            <span className="pill pill-warn" title={agent.binding?.awaitingReason ?? '需人工处理'}>挂起</span>
          )}
          {needInputAt && (
            <span className="pill pill-warn" title={needInputTitle}>等回答</span>
          )}
          {!agent.petId && (
            <span className={runtimeBadge.cls}>{runtimeBadge.label}</span>
          )}
          {agent.stale && (
            <span className="pill pill-warn" title={agent.observedAt ? `Last observed at ${agent.observedAt}` : undefined}>
              失联
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
        <div className="mb-2 rounded-md border border-accent/25 bg-accent-soft/60 px-2.5 py-2 text-xs text-accent">
          <span className="font-mono">{agent.binding?.awaitingPhase}</span>
          {agent.binding?.awaitingReason && <span> · {agent.binding.awaitingReason}</span>}
        </div>
      )}
      {!isBootstrapping && agent.runtimeStatus === 'pending' && (
        <div className="mb-2 space-y-1 rounded-md border border-accent/25 bg-accent-soft/60 px-2.5 py-2 text-xs text-accent">
          <div className="font-medium">等待人工介入</div>
          <div>
            请打开 <Link to={`/terminal/${agent.id}`} className="text-accent hover:text-accent-hover underline">终端</Link> 处理。
          </div>
        </div>
      )}
      {needInputAt && (
        <div className="mb-2 space-y-1 rounded-md border border-accent/25 bg-accent-soft/60 px-2.5 py-2 text-xs text-accent">
          <div className="font-medium">Agent 在等你的回答</div>
          <div>
            它提了一个问题，请打开 <Link to={`/terminal/${agent.id}`} className="text-accent hover:text-accent-hover underline">终端</Link> 回复。
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
              {retryingBootstrap ? '重试中…' : '重试 bootstrap'}
            </button>
          </div>
        </div>
      )}
      {showTaskBinding && taskId && (
        <div className="mb-2 text-xs text-og-500">
          任务：<span className="font-mono text-og-700">{taskId}</span>
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
        <div className="mb-2 rounded-md border border-accent/25 bg-accent-soft/60 px-2.5 py-1.5 text-xs text-accent">
          重启 baxian server 后生效
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto scrollbar-none">
          {terminalDisabled ? (
            <span className="shrink-0 cursor-not-allowed text-sm text-og-400" title={terminalDisabledMessage}>
              终端
            </span>
          ) : (
            <Link to={`/terminal/${agent.id}`} className="btn-secondary shrink-0">终端</Link>
          )}
          {!pendingRestart && agent.runtimeStatus === 'working' && (
            <button
              onClick={handleStop}
              disabled={stopping}
              className="btn-ghost shrink-0"
            >
              {stopping ? '停止中…' : '停止'}
            </button>
          )}
          {isAwaitingHuman && (
            <button
              type="button"
              onClick={handleResume}
              disabled={resuming}
              title={needsRegreet
                ? '重跑 greeting 能力握手以恢复（会话存活则重启 REPL，已丢失则重建；greeting_failed 无法靠清状态解除）'
                : '清除 awaiting_human 状态，让 agent 恢复可用'}
              className="btn-primary shrink-0"
            >
              {resuming ? '恢复中…' : '恢复'}
            </button>
          )}
        </div>
        <KebabMenu ariaLabel={`Agent ${agent.id} 操作菜单`} className="shrink-0" placement="up" autoFocusFirstItem disabled={deleting}>
          {close => (
            <>
              <MenuItem
                onClick={() => { close(); setPetModalOpen(true); }}
                disabled={compacting || clearing || deleting}
                title="配置 Agent Pet（在状态位置显示动画宠物）"
              >
                Agent Pet
              </MenuItem>
              <MenuItem
                onClick={() => { close(); void handleCompact(); }}
                disabled={compacting || clearing || deleting}
                title="向 agent runtime 发送 /compact 压缩上下文"
              >
                {compacting ? '压缩中…' : '压缩上下文'}
              </MenuItem>
              <MenuItem
                onClick={() => { close(); void handleClear(); }}
                disabled={clearing || compacting || deleting}
                title="向 agent runtime 发送 /clear 清空上下文"
              >
                {clearing ? '清空中…' : '清空上下文'}
              </MenuItem>
              {!pendingRestart && taskId && role === 'dev' && (
                <MenuItem
                  onClick={() => { close(); void handleRequestReview(); }}
                  disabled={reviewing || deleting}
                  title={`让 QA agent 立即对任务 ${taskId} 跑一轮 review（需要该任务已有 PR）`}
                >
                  {reviewing ? '发起中…' : '发起评审'}
                </MenuItem>
              )}
              <MenuItem
                onClick={() => { close(); void handleDelete(); }}
                disabled={deleting || compacting || clearing}
              >
                {deleting ? '删除中…' : '删除'}
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
