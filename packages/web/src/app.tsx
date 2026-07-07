import { useEffect, useMemo, useRef } from 'react';
import { BrowserRouter, Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom';
import { Dashboard } from './pages/dashboard.tsx';
import { Project } from './pages/project.tsx';
import { TaskDetail } from './pages/task-detail.tsx';
import { Terminal } from './pages/terminal.tsx';
import { ReviewRoundPage } from './pages/review-round.tsx';
import { GithubReviewPage } from './pages/github-review.tsx';
import { BrandToggle } from './components/brand-toggle.tsx';
import { GithubConnectivityBanner } from './components/github-connectivity-banner.tsx';
import { PendingRestartBanner } from './components/pending-restart-banner.tsx';
import { taskDetailPath, taskStatusLabel } from './components/task-status.tsx';
import { TOPBAR_ACTIONS_ID } from './components/topbar-actions.tsx';
import { api } from './api.ts';
import { useProjects } from './hooks/use-projects.ts';
import { notificationApi, TaskNotificationsProvider, useTaskNotifications } from './hooks/use-task-notifications.tsx';
import { getEventsClient } from './stores/events-store.ts';
import { getMessages, useLocaleConfigSync } from './i18n/index.tsx';
import type { ProjectConfig, TaskState, TaskStatus } from './shared/index.js';

const TASK_COMPLETION_STATUSES: ReadonlySet<TaskStatus> = new Set(['done', 'merged']);

function compactText(value: string, max: number): string {
  const text = value.trim().replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function projectBrief(project: ProjectConfig | undefined, fallbackId: string): string {
  if (!project) return fallbackId;
  return project.repo ? `${project.id} · ${project.repo}` : project.id;
}

function taskBrief(task: TaskState): string {
  return task.title ? `${task.id} · ${task.title}` : task.id;
}

function isTaskCompletionStatus(status: TaskStatus): boolean {
  return TASK_COMPLETION_STATUSES.has(status);
}

function showTaskCompletionNotification(
  task: TaskState,
  projectLabel: string,
  onOpen: () => void,
): void {
  const apiRef = notificationApi();
  if (!apiRef || apiRef.permission !== 'granted') return;
  try {
    const messages = getMessages();
    const notification = new apiRef(messages.notification.taskDone(compactText(task.title || task.id, 80)), {
      body: [
        messages.notification.bodyProject(compactText(projectLabel, 120)),
        messages.notification.bodyTask(compactText(taskBrief(task), 120)),
        messages.notification.bodyStatus(taskStatusLabel(task.status)),
      ].join('\n'),
      icon: '/baxian-logo.png',
      tag: `baxian-task-${task.id}`,
    });
    notification.onclick = () => {
      window.focus();
      onOpen();
      notification.close();
    };
  } catch (err) {
    console.warn('[task-notifications] failed to show notification:', err);
  }
}

function useTaskCompletionNotifications(
  projects: ProjectConfig[] | null,
  openTask: (task: TaskState) => void,
  enabled: boolean,
): void {
  const previousByProject = useRef(new Map<string, Map<string, TaskState>>());
  const notifiedTaskIds = useRef(new Set<string>());
  const pendingConfirmationByProject = useRef(new Map<string, Set<string>>());
  const confirmationInFlight = useRef(new Set<string>());
  const activeProjectsRef = useRef<ReadonlySet<string>>(new Set());
  const projectEpochs = useRef(new Map<string, number>());
  const openTaskRef = useRef(openTask);
  const projectLabelsRef = useRef(new Map<string, string>());
  const projectIdsKey = useMemo(
    () => enabled ? (projects ?? []).map(project => project.id).sort().join('\u0000') : '',
    [enabled, projects],
  );

  useEffect(() => {
    openTaskRef.current = openTask;
  }, [openTask]);

  useEffect(() => {
    projectLabelsRef.current = new Map(
      (projects ?? []).map(project => [project.id, projectBrief(project, project.id)]),
    );
  }, [projects]);

  useEffect(() => {
    // 取消不可恢复:关闭通知/项目移除后,同一项目重回集合也不能复活此前在途的确认
    const bumpProjectEpoch = (projectId: string) => {
      projectEpochs.current.set(projectId, (projectEpochs.current.get(projectId) ?? 0) + 1);
    };
    if (projectIdsKey === '') {
      for (const projectId of activeProjectsRef.current) bumpProjectEpoch(projectId);
      activeProjectsRef.current = new Set();
      previousByProject.current.clear();
      pendingConfirmationByProject.current.clear();
      confirmationInFlight.current.clear();
      return;
    }
    const projectIds = projectIdsKey.split('\u0000');
    const activeProjects = new Set(projectIds);
    for (const projectId of activeProjectsRef.current) {
      if (!activeProjects.has(projectId)) bumpProjectEpoch(projectId);
    }
    activeProjectsRef.current = activeProjects;
    for (const projectId of previousByProject.current.keys()) {
      if (!activeProjects.has(projectId)) previousByProject.current.delete(projectId);
    }
    for (const projectId of pendingConfirmationByProject.current.keys()) {
      if (!activeProjects.has(projectId)) pendingConfirmationByProject.current.delete(projectId);
    }

    const unsubs = projectIds.map(projectId => getEventsClient().subscribe<TaskState[]>(
      `project-tasks:${projectId}`,
      (tasks) => {
        const previous = previousByProject.current.get(projectId);
        const next = new Map(tasks.map(task => [task.id, task]));
        previousByProject.current.set(projectId, next);
        const pending = pendingConfirmationByProject.current.get(projectId) ?? new Set<string>();
        pendingConfirmationByProject.current.set(projectId, pending);

        if (!previous) {
          for (const taskId of next.keys()) pending.delete(taskId);
          return;
        }

        for (const [taskId] of previous) {
          if (next.has(taskId) || notifiedTaskIds.current.has(taskId)) continue;
          pending.add(taskId);
        }

        for (const taskId of [...pending]) {
          if (next.has(taskId)) {
            pending.delete(taskId);
            continue;
          }
          const epochAtIssue = projectEpochs.current.get(projectId) ?? 0;
          // epoch 入 key:项目移除再加回后,残留的旧代次 in-flight 不能压住新一轮确认
          const confirmationKey = `${projectId}:${epochAtIssue}:${taskId}`;
          if (confirmationInFlight.current.has(confirmationKey)) continue;
          confirmationInFlight.current.add(confirmationKey);
          void api.tasks.get(taskId).then((task) => {
            if ((projectEpochs.current.get(projectId) ?? 0) !== epochAtIssue) return;
            if (!task || task.projectId !== projectId || !isTaskCompletionStatus(task.status)) {
              pending.delete(taskId);
              return;
            }
            pending.delete(taskId);
            notifiedTaskIds.current.add(task.id);
            const projectLabel = projectLabelsRef.current.get(projectId) ?? projectId;
            showTaskCompletionNotification(task, projectLabel, () => openTaskRef.current(task));
          }).catch((err) => {
            console.warn(`[task-notifications] failed to confirm completed task ${taskId}:`, err);
          }).finally(() => {
            confirmationInFlight.current.delete(confirmationKey);
          });
        }
      },
      (err) => {
        console.warn(`[task-notifications] project task stream failed for ${projectId}:`, err);
      },
    ));

    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [projectIdsKey]);
}

function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const { projects } = useProjects();
  const { enabled: taskNotificationsEnabled } = useTaskNotifications();
  const showBottomBrand = !location.pathname.startsWith('/terminal/');

  useLocaleConfigSync();

  useTaskCompletionNotifications(
    projects,
    (task) => navigate(taskDetailPath(task.projectId, task.id)),
    taskNotificationsEnabled,
  );

  return (
    <div className="flex h-dvh flex-col bg-page">
      <nav className="flex h-12 flex-none items-center border-b border-hairline bg-surface px-3 sm:px-6">
        <Link
          to="/"
          className="flex shrink-0 items-center gap-2 font-display text-sm font-semibold tracking-tight text-og-1000"
        >
          <span aria-hidden className="block h-2.5 w-2.5 rounded-full bg-accent" />
          baxian
        </Link>
        <div
          id={TOPBAR_ACTIONS_ID}
          className="ml-auto flex min-w-0 items-center justify-end gap-2"
        />
      </nav>
      <PendingRestartBanner />
      <GithubConnectivityBanner />
      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-6 sm:px-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/project/:id" element={<Project />} />
          <Route path="/project/:id/task/:taskId" element={<TaskDetail />} />
          <Route path="/terminal/:agentId" element={<Terminal />} />
          <Route path="/tasks/:taskId/rounds/:phase/:round" element={<ReviewRoundPage />} />
          <Route path="/tasks/:taskId/github-review" element={<GithubReviewPage />} />
        </Routes>
        {showBottomBrand && (
          <footer className="mt-auto flex justify-center pb-4 pt-24">
            <BrandToggle />
          </footer>
        )}
      </main>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <TaskNotificationsProvider>
        <AppShell />
      </TaskNotificationsProvider>
    </BrowserRouter>
  );
}
