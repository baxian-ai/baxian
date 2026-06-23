import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AgentGroup } from '../components/agent-group.tsx';
import { CreateProjectModal } from '../components/create-project-modal.tsx';
import { CreateAgentModal } from '../components/create-agent-modal.tsx';
import { CreateTaskModal } from '../components/create-task-modal.tsx';
import { HostManagementModal } from '../components/host-management-modal.tsx';
import { Modal } from '../components/modal.tsx';
import { useTaskDetail } from '../components/task-detail-modal.tsx';
import { TopbarActions } from '../components/topbar-actions.tsx';
import { useAgents, useProjectTasks } from '../hooks/use-events.ts';
import { useProjects } from '../hooks/use-projects.ts';
import type { AgentSnapshot, ProjectConfig } from '../shared/index.js';

type ContinueState =
  | { kind: 'closed' }
  | { kind: 'asking'; projectId: string }
  | { kind: 'addingAgent'; projectId: string };

export function Dashboard() {
  const { openTask } = useTaskDetail();
  const { projects: projectsData, error: projectsError, refresh: refreshProjects } = useProjects();
  const projects = projectsData ?? [];
  const projectsLoaded = projectsData !== null;
  const [createOpen, setCreateOpen] = useState(false);
  const [createTaskOpen, setCreateTaskOpen] = useState(false);
  const [hostMgmtOpen, setHostMgmtOpen] = useState(false);
  const [continueState, setContinueState] = useState<ContinueState>({ kind: 'closed' });
  const { data: agents, loaded: agentsLoaded, error: agentsErrorPayload } = useAgents();
  const agentsError = agentsErrorPayload?.message ?? null;
  const agentsById = new Map((agents ?? []).map((agent) => [agent.id, agent]));
  const error = projectsError ?? agentsError;

  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const moreMenuId = useId();
  const moreTriggerId = useId();

  useEffect(() => {
    if (!moreMenuOpen) return;
    const handlePointer = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (moreMenuRef.current?.contains(target)) return;
      if (moreButtonRef.current?.contains(target)) return;
      setMoreMenuOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMoreMenuOpen(false);
        moreButtonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [moreMenuOpen]);

  const createTaskDisabled = projects.length === 0;
  const createTaskButton = (
    <button
      type="button"
      onClick={() => setCreateTaskOpen(true)}
      disabled={createTaskDisabled}
      aria-describedby={createTaskDisabled ? 'create-task-hint' : undefined}
      className="btn-ghost"
    >
      + 新建 Task
    </button>
  );

  return (
    <div>
      <TopbarActions>
        {createTaskDisabled ? (
          <span className="inline-flex" title="请先创建项目">
            {createTaskButton}
          </span>
        ) : createTaskButton}
        {createTaskDisabled && (
          <span id="create-task-hint" className="sr-only">请先创建项目</span>
        )}
        <div className="relative">
          <button
            ref={moreButtonRef}
            id={moreTriggerId}
            type="button"
            onClick={() => setMoreMenuOpen(open => !open)}
            aria-haspopup="menu"
            aria-expanded={moreMenuOpen}
            aria-controls={moreMenuId}
            aria-label="更多操作"
            className="flex h-8 w-8 items-center justify-center rounded text-og-500 transition-colors hover:bg-og-100 hover:text-og-1000"
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
          {moreMenuOpen && (
            <div
              ref={moreMenuRef}
              id={moreMenuId}
              role="menu"
              aria-labelledby={moreTriggerId}
              className="absolute right-0 top-full z-10 mt-1 min-w-[140px] rounded-md border border-hairline bg-surface py-1 shadow-md"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => { setMoreMenuOpen(false); setCreateOpen(true); }}
                className="block w-full px-3 py-1.5 text-left text-[13px] text-og-800 hover:text-og-1000"
              >
                新建项目
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => { setMoreMenuOpen(false); setHostMgmtOpen(true); }}
                className="block w-full px-3 py-1.5 text-left text-[13px] text-og-800 hover:text-og-1000"
              >
                Host 管理
              </button>
            </div>
          )}
        </div>
      </TopbarActions>
      <h1 className="sr-only">Dashboard</h1>
      {error && <div className="mb-4 text-[13px] text-danger">Error: {error}</div>}
      {projectsLoaded && projects.length === 0 && !projectsError && (
        <div className="rounded-lg border border-hairline bg-surface py-12 text-center text-[13px] text-og-500">
          还没有项目。点击右上角"更多"菜单 → "新建项目"开始。
        </div>
      )}
      {projects.map(project => (
        <DashboardProject
          key={project.id}
          project={project}
          agentsById={agentsById}
          agentsLoaded={agentsLoaded}
          agentsError={!!agentsErrorPayload}
          onAgentDeleted={refreshProjects}
        />
      ))}

      <CreateProjectModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => {
          setCreateOpen(false);
          refreshProjects();
          setContinueState({ kind: 'asking', projectId: id });
        }}
      />

      <HostManagementModal open={hostMgmtOpen} onClose={() => setHostMgmtOpen(false)} />

      <Modal
        open={continueState.kind === 'asking'}
        onClose={() => setContinueState({ kind: 'closed' })}
        title="项目已创建"
        size="sm"
        footer={
          <>
            <button
              type="button"
              onClick={() => setContinueState({ kind: 'closed' })}
              className="btn-secondary"
            >
              稍后再加
            </button>
            <button
              type="button"
              onClick={() => {
                if (continueState.kind === 'asking') {
                  setContinueState({ kind: 'addingAgent', projectId: continueState.projectId });
                }
              }}
              className="btn-primary"
            >
              继续添加 Agent
            </button>
          </>
        }
      >
        <p className="text-[13px] text-og-700">现在添加第一个 Agent，还是稍后再加？</p>
      </Modal>

      {continueState.kind === 'addingAgent' && (
        <CreateAgentModal
          open
          projectId={continueState.projectId}
          onClose={() => setContinueState({ kind: 'closed' })}
          onCreated={() => { refreshProjects(); }}
        />
      )}

      <CreateTaskModal
        open={createTaskOpen}
        onClose={() => setCreateTaskOpen(false)}
        onCreated={(task) => openTask(task.id)}
      />
    </div>
  );
}

interface DashboardProjectProps {
  project: ProjectConfig;
  agentsById: Map<string, AgentSnapshot>;
  agentsLoaded: boolean;
  agentsError: boolean;
  onAgentDeleted: () => void;
}

function DashboardProject({
  project,
  agentsById,
  agentsLoaded,
  agentsError,
  onAgentDeleted,
}: DashboardProjectProps) {
  const { data: tasksData, error: tasksErrorPayload } = useProjectTasks(project.id);
  const tasks = tasksData ?? [];
  const tasksError = tasksErrorPayload?.message ?? null;

  return (
    <div className="mb-10">
      <div className="mb-3 -mx-2 flex items-baseline gap-x-3 gap-y-1 px-2 py-1">
        <h2 className="min-w-0 truncate font-display text-[17px] font-semibold tracking-tight text-og-1000" title={project.id}>
          <Link to={`/project/${project.id}`} className="hover:text-accent-hover">{project.id}</Link>
        </h2>
        <span className="hidden min-w-0 truncate font-mono text-[12px] text-og-500 sm:inline-block" title={project.repo}>{project.repo}</span>
        <Link
          to={`/project/${project.id}`}
          className="ml-auto text-[13px] text-accent hover:text-accent-hover"
          aria-label={`Details — ${project.id}`}
        >
          Details →
        </Link>
      </div>
      {tasksError && (
        <div className="mb-2 text-[12px] text-danger">任务列表加载失败：{tasksError}</div>
      )}
      {project.agent.flat().length === 0 ? (
        <div className="rounded-lg border border-hairline bg-surface py-6 text-center text-[13px] text-og-500">
          还没有 Agent。进入 Details 添加。
        </div>
      ) : (
        <div
          className={
            project.agent.length === 1
              ? 'space-y-3'
              : 'grid grid-cols-1 gap-3 xl:grid-cols-2'
          }
        >
          {project.agent.map((group, index) => (
            <AgentGroup
              key={group.map(agent => agent.id).join(':') || index}
              group={group}
              projectId={project.id}
              agentsById={agentsById}
              agentsLoaded={agentsLoaded}
              agentsError={agentsError}
              tasks={tasks}
              onDeleted={onAgentDeleted}
              terminalMode="embedded-full"
            />
          ))}
        </div>
      )}
    </div>
  );
}
