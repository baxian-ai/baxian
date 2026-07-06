import {useCallback, useEffect, useRef, useState} from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { KebabMenu, MenuItem } from '../components/kebab-menu.tsx';
import { api } from '../api.ts';
import { AgentGroup } from '../components/agent-group.tsx';
import { TaskPanel } from '../components/task-panel.tsx';
import { CreateAgentModal } from '../components/create-agent-modal.tsx';
import { CreateTaskModal } from '../components/create-task-modal.tsx';
import { Modal } from '../components/modal.tsx';
import { taskDetailPath } from '../components/task-status.tsx';
import { useToast } from '../components/toast.tsx';
import { TopbarActions } from '../components/topbar-actions.tsx';
import { useAgents, useProjectTasks } from '../hooks/use-events.ts';
import { useProjects } from '../hooks/use-projects.ts';
import { useT } from '../i18n/index.tsx';
import type { ProjectConfig, TaskState } from '../shared/index.js';

const NO_TASKS: TaskState[] = [];

const TASK_PANEL_OPEN_KEY = 'baxian.taskPanel.open';

function readTaskPanelOpen(): boolean {
  try {
    return localStorage.getItem(TASK_PANEL_OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

export function Project() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const t = useT();
  const { show } = useToast();
  const { refresh: refreshProjectsList } = useProjects();
  const [project, setProject] = useState<ProjectConfig | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  const [createTaskOpen, setCreateTaskOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const [taskPanelOpen, setTaskPanelOpen] = useState(readTaskPanelOpen);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
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
    if (!deleteOpen) {
      setDeleteConfirm('');
      setDeleteError(null);
    }
  }, [deleteOpen]);

  useEffect(() => {
    try {
      localStorage.setItem(TASK_PANEL_OPEN_KEY, taskPanelOpen ? '1' : '0');
    } catch {
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
      await refreshProjectsList();
      show({ kind: 'success', title: t.projectPage.deletedToastTitle(project.id) });
      setDeleteOpen(false);
      navigate('/');
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  if (!project) {
    if (projectError) return <div className="text-sm text-accent">{t.common.loadFailed(projectError)}</div>;
    return <div className="text-sm text-og-500">{t.common.loading}</div>;
  }

  return (
    <div>
      <TopbarActions>
        <button type="button" onClick={() => setCreateTaskOpen(true)} className="btn-ghost">{t.projectPage.newTaskButton}</button>
        <KebabMenu ariaLabel={t.projectPage.menuAriaLabel(project.id)} menuClassName="min-w-[180px]" triggerRef={menuButtonRef}>
          {close => (
            <>
              {!taskPanelOpen && (
                <MenuItem onClick={() => { close(); setTaskPanelOpen(true); }}>
                  {t.projectPage.showTaskPanel}
                </MenuItem>
              )}
              <MenuItem onClick={() => { close(); setCreateAgentOpen(true); }}>
                {t.projectPage.addAgent}
              </MenuItem>
              <div role="none" className="my-1 border-t border-hairline" />
              <MenuItem
                onClick={() => { close(); setDeleteOpen(true); }}
                disabled={!canDelete}
                title={canDelete ? undefined : t.projectPage.deleteAgentsFirstHint(agentCount)}
              >
                {t.projectPage.deleteProjectMenuItem}
              </MenuItem>
            </>
          )}
        </KebabMenu>
      </TopbarActions>
      {error && <div className="mb-4 text-sm text-accent">{t.common.loadFailed(error)}</div>}
      <div className="mb-6 flex items-baseline gap-x-3">
        <h1 className="min-w-0 truncate font-display text-sm font-semibold tracking-tight text-og-1000" title={project.id}>{project.id}</h1>
        <span className="hidden min-w-0 truncate font-mono text-xs text-og-500 sm:inline-block" title={project.repo}>{project.repo}</span>
      </div>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          <div className="mb-3 flex h-8 items-center gap-2">
            <h2 className="font-display text-xs font-semibold uppercase tracking-[0.06em] text-og-500">Agents</h2>
          </div>
          {project.agent.flat().length === 0 ? (
            <div className="mb-8 rounded-lg border border-hairline bg-surface py-6 text-center text-sm text-og-500">
              {t.projectPage.noAgentsYet}
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
          <div className="w-full lg:w-[340px] lg:shrink-0 xl:w-[380px]">
            <div className="mb-3 flex h-8 items-center justify-between gap-2">
              <h2 className="font-display text-xs font-semibold uppercase tracking-[0.06em] text-og-500">Tasks</h2>
              <button
                type="button"
                onClick={() => { setTaskPanelOpen(false); menuButtonRef.current?.focus(); }}
                aria-label={t.projectPage.closeTaskPanel}
                className="flex h-7 w-7 items-center justify-center rounded text-og-500 transition-colors hover:bg-og-50 hover:text-og-1000"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <TaskPanel projectId={project.id} openTasks={tasks} />
          </div>
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
        onCreated={(task) => navigate(taskDetailPath(task.projectId, task.id))}
      />

      <Modal
        open={deleteOpen}
        onClose={() => { if (!deleting) setDeleteOpen(false); }}
        title={t.projectPage.deleteModalTitle}
        size="sm"
        footer={
          <>
            <button
              type="button"
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
              className="btn-secondary"
            >
              {t.common.cancel}
            </button>
            <button
              type="button"
              onClick={() => void handleDeleteProject()}
              disabled={!deleteConfirmed || deleting}
              className="btn-primary"
            >
              {deleting ? t.common.deleting : t.projectPage.confirmDeleteButton}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-og-700">
            {t.projectPage.deleteBodyLead}<code className="font-mono text-og-1000">baxian.json</code>{t.projectPage.deleteBodyMid}
            <span className="font-mono text-og-1000">{project.id}</span>{t.projectPage.deleteBodySuffix}
          </p>
          <p className="text-sm text-og-700">
            {t.projectPage.confirmInputLead}<span className="font-mono text-og-1000">{project.id}</span>{t.projectPage.confirmInputSuffix}
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
            aria-label={t.projectPage.confirmInputAriaLabel}
            className="w-full rounded border border-hairline bg-surface px-3 py-2 font-mono text-sm text-og-1000 focus:border-accent focus:outline-none"
          />
          {deleteError && (
            <div className="rounded-md border border-accent/25 bg-accent-soft px-3 py-2 text-xs text-accent">
              {deleteError}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
