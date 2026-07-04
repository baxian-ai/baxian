import { useEffect, useMemo, useRef, useState } from 'react';
import { BrowserRouter, Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom';
import { Dashboard } from './pages/dashboard.tsx';
import { Project } from './pages/project.tsx';
import { TaskDetail } from './pages/task-detail.tsx';
import { Terminal } from './pages/terminal.tsx';
import { ReviewRoundPage } from './pages/review-round.tsx';
import { GithubReviewPage } from './pages/github-review.tsx';
import { BrandToggle } from './components/brand-toggle.tsx';
import { PendingRestartBanner } from './components/pending-restart-banner.tsx';
import { taskDetailPath } from './components/task-status.tsx';
import { TOPBAR_ACTIONS_ID } from './components/topbar-actions.tsx';
import { api } from './api.ts';
import { useProjects } from './hooks/use-projects.ts';
import { getEventsClient } from './stores/events-store.ts';
import type { ProjectConfig, TaskState, TaskStatus } from './shared/index.js';

const TASK_COMPLETION_STATUSES: ReadonlySet<TaskStatus> = new Set(['done', 'merged']);

function notificationApi(): typeof Notification | null {
  if (typeof window === 'undefined') return null;
  const candidate = (window as Window & { Notification?: typeof Notification }).Notification;
  return typeof candidate === 'function' ? candidate : null;
}

function notificationPermission(): NotificationPermission | 'unsupported' {
  const apiRef = notificationApi();
  return apiRef ? apiRef.permission : 'unsupported';
}

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
    const notification = new apiRef(`Task 完成：${compactText(task.title || task.id, 80)}`, {
      body: [
        `项目：${compactText(projectLabel, 120)}`,
        `Task：${compactText(taskBrief(task), 120)}`,
        `状态：${task.status}`,
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

function NotificationPermissionButton({
  permission,
  onPermissionChange,
}: {
  permission: NotificationPermission | 'unsupported';
  onPermissionChange: (permission: NotificationPermission | 'unsupported') => void;
}) {
  const [requesting, setRequesting] = useState(false);

  if (permission === 'unsupported') return null;

  const granted = permission === 'granted';
  const denied = permission === 'denied';
  const label = granted
    ? '任务完成通知已启用'
    : denied
      ? '浏览器已拒绝任务完成通知'
      : '启用任务完成通知';

  const requestPermission = async () => {
    const apiRef = notificationApi();
    if (!apiRef || requesting || granted || denied) return;
    setRequesting(true);
    try {
      onPermissionChange(await apiRef.requestPermission());
    } catch (err) {
      console.warn('[task-notifications] permission request failed:', err);
      onPermissionChange(notificationPermission());
    } finally {
      setRequesting(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void requestPermission()}
      disabled={requesting || granted || denied}
      aria-label={label}
      title={label}
      className="ml-2 flex h-8 w-8 shrink-0 items-center justify-center rounded text-og-500 transition-colors hover:bg-og-50 hover:text-og-1000 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-og-500"
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
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" />
      </svg>
    </button>
  );
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
    if (projectIdsKey === '') {
      previousByProject.current.clear();
      pendingConfirmationByProject.current.clear();
      confirmationInFlight.current.clear();
      return;
    }
    const projectIds = projectIdsKey.split('\u0000');
    const activeProjects = new Set(projectIds);
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
          const confirmationKey = `${projectId}:${taskId}`;
          if (confirmationInFlight.current.has(confirmationKey)) continue;
          confirmationInFlight.current.add(confirmationKey);
          void api.tasks.get(taskId).then((task) => {
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
  const [taskNotificationPermission, setTaskNotificationPermission] = useState(notificationPermission);
  const showBottomBrand = !location.pathname.startsWith('/terminal/');

  useEffect(() => {
    const sync = () => setTaskNotificationPermission(notificationPermission());
    window.addEventListener('focus', sync);
    return () => window.removeEventListener('focus', sync);
  }, []);

  useTaskCompletionNotifications(
    projects,
    (task) => navigate(taskDetailPath(task.projectId, task.id)),
    taskNotificationPermission === 'granted',
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
        <NotificationPermissionButton
          permission={taskNotificationPermission}
          onPermissionChange={setTaskNotificationPermission}
        />
      </nav>
      <PendingRestartBanner />
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
      <AppShell />
    </BrowserRouter>
  );
}
