import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.ts';
import { AgentGroup } from '../components/agent-group.tsx';
import { TaskPanel } from '../components/task-panel.tsx';
import { CreateAgentModal } from '../components/create-agent-modal.tsx';
import { CreateTaskModal } from '../components/create-task-modal.tsx';
import { Modal } from '../components/modal.tsx';
import { useTaskDetail } from '../components/task-detail-modal.tsx';
import { useToast } from '../components/toast.tsx';
import { TopbarActions } from '../components/topbar-actions.tsx';
import { useAgents, useProjectTasks } from '../hooks/use-events.ts';
import { useProjects } from '../hooks/use-projects.ts';
import type { ProjectConfig, TaskState } from '../shared/index.js';

// Stable empty ref: while tasks are unloaded the panel keys "fresh WS frame" off
// openTasks identity, so a per-render `?? []` would masquerade as a new frame.
const NO_TASKS: TaskState[] = [];

// Persist the panel-visible preference so it survives a refresh (a global UI choice,
// not per-project — the user either wants the task list alongside agents or not).
const TASK_PANEL_OPEN_KEY = 'baxian.taskPanel.open';

function readTaskPanelOpen(): boolean {
  try {
    return localStorage.getItem(TASK_PANEL_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function Project() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { show } = useToast();
  const { openTask } = useTaskDetail();
  const { refresh: refreshProjectsList } = useProjects();
  const [project, setProject] = useState<ProjectConfig | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  const [createTaskOpen, setCreateTaskOpen] = useState(false);
  const [taskPanelOpen, setTaskPanelOpen] = useState(readTaskPanelOpen);
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const menuTriggerId = useId();
  const projectTokenRef = useRef(0);
  const { data: agents, loaded: agentsLoaded, error: agentsErrorPayload } = useAgents();
  const { data: tasksData, error: tasksErrorPayload } = useProjectTasks(id);
  const agentsError = agentsErrorPayload?.message ?? null;
  const tasksError = tasksErrorPayload?.message ?? null;
  const tasks = tasksData ?? NO_TASKS;
  const agentsById = new Map((agents ?? []).map((agent) => [agent.id, agent]));
  const error = projectError ?? agentsError ?? tasksError;

  const loadProject = useCallback(async (projectId: string) => {
    const token = ++projectTokenRef.current;
    try {
      const p = await api.projects.get(projectId);
      if (token !== projectTokenRef.current) return;
      setProject(p);
      setProjectError(null);
    } catch (err) {
      if (token !== projectTokenRef.current) return;
      setProjectError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!id) return;
    setProject(null);
    setProjectError(null);
    loadProject(id);
  }, [id, loadProject]);

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
    if (!deleteOpen) {
      setDeleteConfirm('');
      setDeleteError(null);
    }
  }, [deleteOpen]);

  useEffect(() => {
    try {
      localStorage.setItem(TASK_PANEL_OPEN_KEY, taskPanelOpen ? '1' : '0');
    } catch {
      /* storage unavailable (private mode) — preference just won't persist */
    }
  }, [taskPanelOpen]);

  const agentCount = project?.agent.flat().length ?? 0;
  const canDelete = agentCount === 0;
  const deleteConfirmed = !!project && deleteConfirm.trim() === project.id;

  const handleDeleteProject = async () => {
    if (!project || !deleteConfirmed || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.projects.delete(project.id);
      // Refresh the shared useProjects cache so Dashboard does not render the just-deleted project.
      await refreshProjectsList();
      show({ kind: 'success', title: `项目 ${project.id} 已删除` });
      setDeleteOpen(false);
      navigate('/');
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  if (!project) {
    if (projectError) return <div className="text-[13px] text-danger">Error: {projectError}</div>;
    return <div className="text-[13px] text-og-500">Loading…</div>;
  }

  return (
    <div>
      <TopbarActions>
        <button type="button" onClick={() => setCreateTaskOpen(true)} className="btn-primary">+ 新建 Task</button>
        <div className="relative">
          <button
            ref={menuButtonRef}
            id={menuTriggerId}
            type="button"
            onClick={() => setMenuOpen(open => !open)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            aria-label={`项目 ${project.id} 操作菜单`}
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
          {menuOpen && (
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-labelledby={menuTriggerId}
              className="absolute right-0 top-full z-10 mt-1 min-w-[180px] rounded-md border border-hairline bg-surface py-1 shadow-md"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => { setMenuOpen(false); setCreateAgentOpen(true); }}
                className="block w-full px-3 py-1.5 text-left text-[13px] text-og-800 hover:bg-og-100 hover:text-og-1000"
              >
                添加 Agent
              </button>
              <div role="none" className="my-1 border-t border-hairline" />
              <button
                type="button"
                role="menuitem"
                onClick={() => { setMenuOpen(false); setDeleteOpen(true); }}
                disabled={!canDelete}
                title={canDelete ? undefined : `请先删除项目下的 ${agentCount} 个 Agent`}
                className="block w-full px-3 py-1.5 text-left text-[13px] text-danger hover:bg-[#fef2f2] disabled:cursor-not-allowed disabled:text-og-400 disabled:hover:bg-transparent"
              >
                删除项目…
              </button>
            </div>
          )}
        </div>
      </TopbarActions>
      {error && <div className="mb-4 text-[13px] text-danger">Error: {error}</div>}
      <div className="mb-6 flex items-baseline gap-x-3">
        <h1 className="min-w-0 truncate font-display text-[17px] font-semibold tracking-tight text-og-1000" title={project.id}>{project.id}</h1>
        <span className="hidden min-w-0 truncate font-mono text-[12px] text-og-500 sm:inline-block" title={project.repo}>{project.repo}</span>
        {!taskPanelOpen && (
          <button
            type="button"
            onClick={() => setTaskPanelOpen(true)}
            aria-label="打开 Task 面板"
            className="btn-ghost ml-auto self-center"
          >
            Tasks
          </button>
        )}
      </div>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          <div className="mb-3 flex flex-wrap items-baseline gap-2">
            <h2 className="font-display text-[12px] font-semibold uppercase tracking-[0.06em] text-og-500">Agents</h2>
          </div>
          {project.agent.flat().length === 0 ? (
            <div className="mb-8 rounded-lg border border-hairline bg-surface py-6 text-center text-[13px] text-og-500">
              还没有 Agent，点击右上角菜单添加。
            </div>
          ) : (
            <div className="mb-8 space-y-5">
              {project.agent.map((group, index) => (
                <AgentGroup
                  key={group.map(agent => agent.id).join(':') || index}
                  group={group}
                  projectId={project.id}
                  agentsById={agentsById}
                  agentsLoaded={agentsLoaded}
                  agentsError={!!agentsErrorPayload}
                  tasks={tasks}
                  onDeleted={() => { loadProject(project.id); }}
                  terminalMode="embedded-full"
                />
              ))}
            </div>
          )}
        </div>

        {taskPanelOpen && (
          <TaskPanel
            projectId={project.id}
            openTasks={tasks}
            onClose={() => setTaskPanelOpen(false)}
            className="w-full lg:w-[340px] lg:shrink-0 xl:w-[380px]"
          />
        )}
      </div>

      <CreateAgentModal
        open={createAgentOpen}
        projectId={project.id}
        onClose={() => setCreateAgentOpen(false)}
        onCreated={() => { loadProject(project.id); }}
      />

      <CreateTaskModal
        open={createTaskOpen}
        projectId={project.id}
        onClose={() => setCreateTaskOpen(false)}
        onCreated={(task) => openTask(task.id)}
      />

      <Modal
        open={deleteOpen}
        onClose={() => { if (!deleting) setDeleteOpen(false); }}
        title="删除项目"
        size="sm"
        footer={
          <>
            <button
              type="button"
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
              className="btn-secondary"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void handleDeleteProject()}
              disabled={!deleteConfirmed || deleting}
              className="btn-secondary !text-danger hover:!bg-[#fef2f2] hover:!text-danger disabled:!text-og-300"
            >
              {deleting ? '删除中…' : '确认删除'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-[13px] text-og-700">
            将从 <code className="font-mono text-og-1000">baxian.json</code> 中移除项目{' '}
            <span className="font-mono text-og-1000">{project.id}</span>。此操作不可撤销，且不会删除 Git 仓库本身。
          </p>
          <p className="text-[13px] text-og-700">
            如需确认，请在下方输入项目 ID <span className="font-mono text-og-1000">{project.id}</span>：
          </p>
          <input
            type="text"
            value={deleteConfirm}
            onChange={e => setDeleteConfirm(e.target.value)}
            placeholder={project.id}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={deleting}
            aria-label="输入项目 ID 以确认删除"
            className="w-full rounded border border-hairline bg-surface px-3 py-2 font-mono text-[13px] text-og-1000 focus:border-accent focus:outline-none"
          />
          {deleteError && (
            <div className="rounded-md border border-[#fecaca] bg-[#fef2f2] px-3 py-2 text-[12px] text-danger">
              {deleteError}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
