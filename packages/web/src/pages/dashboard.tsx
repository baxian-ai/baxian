import {useState} from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { KebabMenu, MenuItem } from '../components/kebab-menu.tsx';
import { AgentGroup } from '../components/agent-group.tsx';
import { CreateProjectModal } from '../components/create-project-modal.tsx';
import { CreateAgentModal } from '../components/create-agent-modal.tsx';
import { CreateTaskModal } from '../components/create-task-modal.tsx';
import { HostManagementModal } from '../components/host-management-modal.tsx';
import { Modal } from '../components/modal.tsx';
import { SystemSettingsModal } from '../components/system-settings-modal.tsx';
import { taskDetailPath } from '../components/task-status.tsx';
import { TopbarActions } from '../components/topbar-actions.tsx';
import { useAgents, useProjectTasks } from '../hooks/use-events.ts';
import { useProjects } from '../hooks/use-projects.ts';
import { useT } from '../i18n/index.tsx';
import type { AgentSnapshot, ProjectConfig } from '../shared/index.js';

type ContinueState =
  | { kind: 'closed' }
  | { kind: 'asking'; projectId: string }
  | { kind: 'addingAgent'; projectId: string };

export function Dashboard() {
  const t = useT();
  const navigate = useNavigate();
  const { projects: projectsData, error: projectsError, refresh: refreshProjects } = useProjects();
  const projects = projectsData ?? [];
  const projectsLoaded = projectsData !== null;
  const [createOpen, setCreateOpen] = useState(false);
  const [createTaskOpen, setCreateTaskOpen] = useState(false);
  const [hostMgmtOpen, setHostMgmtOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [continueState, setContinueState] = useState<ContinueState>({ kind: 'closed' });
  const { data: agents, loaded: agentsLoaded, error: agentsErrorPayload } = useAgents();
  const agentsError = agentsErrorPayload?.message ?? null;
  const agentsById = new Map((agents ?? []).map((agent) => [agent.id, agent]));
  const error = projectsError ?? agentsError;

  const createTaskDisabled = projects.length === 0;
  const createTaskButton = (
    <button
      type="button"
      onClick={() => setCreateTaskOpen(true)}
      disabled={createTaskDisabled}
      aria-describedby={createTaskDisabled ? 'create-task-hint' : undefined}
      className="btn-ghost"
    >
      {t.dashboard.newTask}
    </button>
  );

  return (
    <div>
      <TopbarActions>
        {createTaskDisabled ? (
          <span className="inline-flex" title={t.dashboard.createProjectFirst}>
            {createTaskButton}
          </span>
        ) : createTaskButton}
        {createTaskDisabled && (
          <span id="create-task-hint" className="sr-only">{t.dashboard.createProjectFirst}</span>
        )}
        <KebabMenu ariaLabel={t.dashboard.moreActions}>
          {close => (
            <>
              <MenuItem onClick={() => { close(); setCreateOpen(true); }}>{t.dashboard.newProject}</MenuItem>
              <MenuItem onClick={() => { close(); setHostMgmtOpen(true); }}>{t.dashboard.manageHosts}</MenuItem>
              <MenuItem onClick={() => { close(); setSettingsOpen(true); }}>{t.settings.entry}</MenuItem>
            </>
          )}
        </KebabMenu>
      </TopbarActions>
      <h1 className="sr-only">Dashboard</h1>
      {error && <div className="mb-4 text-sm text-accent">{t.common.loadFailed(error)}</div>}
      {projectsLoaded && projects.length === 0 && !projectsError && (
        <div className="rounded-lg border border-hairline bg-surface py-12 text-center text-sm text-og-500">
          {t.dashboard.emptyProjects}
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
        title={t.dashboard.projectCreatedTitle}
        size="sm"
        footer={
          <>
            <button
              type="button"
              onClick={() => setContinueState({ kind: 'closed' })}
              className="btn-secondary"
            >
              {t.dashboard.later}
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
              {t.dashboard.continueAddingAgent}
            </button>
          </>
        }
      >
        <p className="text-sm text-og-700">{t.dashboard.addAgentNowOrLater}</p>
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
        onCreated={(task) => navigate(taskDetailPath(task.projectId, task.id))}
      />

      <SystemSettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
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
  const t = useT();
  const { data: tasksData, error: tasksErrorPayload } = useProjectTasks(project.id);
  const tasks = tasksData ?? [];
  const tasksError = tasksErrorPayload?.message ?? null;

  return (
    <div className="mb-10">
      <div className="mb-3 -mx-2 flex items-baseline gap-x-3 gap-y-1 px-2 py-1">
        <h2 className="min-w-0 truncate font-display text-sm font-semibold tracking-tight text-og-1000" title={project.id}>
          <Link to={`/project/${project.id}`} className="hover:text-accent-hover">{project.id}</Link>
        </h2>
        <span className="hidden min-w-0 truncate font-mono text-xs text-og-500 sm:inline-block" title={project.repo}>{project.repo}</span>
        <Link
          to={`/project/${project.id}`}
          className="ml-auto text-sm text-accent hover:text-accent-hover"
          aria-label={t.dashboard.detailsAriaLabel(project.id)}
        >
          {t.dashboard.detailsLink}
        </Link>
      </div>
      {tasksError && (
        <div className="mb-2 text-xs text-accent">{t.dashboard.tasksLoadFailed(tasksError)}</div>
      )}
      {project.agent.flat().length === 0 ? (
        <div className="rounded-lg border border-hairline bg-surface py-6 text-center text-sm text-og-500">
          {t.dashboard.noAgentsYet}
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
