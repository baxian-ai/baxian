import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { useLayoutEffect } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import type { ProjectConfig, TaskState } from '../src/shared/index.js';

const appMockState = vi.hoisted(() => {
  const subscribers = new Map<string, Set<(data: unknown) => void>>();
  return {
    projects: null as unknown,
    refreshProjects: vi.fn(),
    taskGet: vi.fn(),
    subscribers,
    subscribe: vi.fn((topic: string, onData: (data: unknown) => void) => {
      let handlers = subscribers.get(topic);
      if (!handlers) {
        handlers = new Set();
        subscribers.set(topic, handlers);
      }
      handlers.add(onData);
      return () => {
        handlers?.delete(onData);
      };
    }),
  };
});

vi.mock('../src/api.ts', () => ({
  api: {
    tasks: {
      get: appMockState.taskGet,
    },
  },
}));

vi.mock('../src/hooks/use-projects.ts', () => ({
  useProjects: () => ({
    projects: appMockState.projects as ProjectConfig[] | null,
    error: null,
    refresh: appMockState.refreshProjects,
  }),
}));

vi.mock('../src/stores/events-store.ts', () => ({
  getEventsClient: () => ({
    subscribe: appMockState.subscribe,
  }),
}));

vi.mock('../src/pages/dashboard.tsx', () => ({
  Dashboard: () => <div data-testid="page-dashboard" />,
}));
vi.mock('../src/pages/project.tsx', () => ({
  Project: () => <div data-testid="page-project" />,
}));
vi.mock('../src/pages/task-detail.tsx', () => ({
  TaskDetail: () => <div data-testid="page-task-detail" />,
}));
vi.mock('../src/pages/terminal.tsx', () => ({
  Terminal: () => <div data-testid="page-terminal" />,
}));
vi.mock('../src/components/pending-restart-banner.tsx', () => ({
  PendingRestartBanner: () => null,
}));

import { App } from '../src/app.tsx';
import { TOPBAR_ACTIONS_ID, TopbarActions } from '../src/components/topbar-actions.tsx';

const originalNotification = window.Notification;

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  const now = '2026-07-04T10:00:00Z';
  return {
    id: 'task-188',
    projectId: 'proj',
    title: 'Ship notifications',
    description: '',
    preferredAgentId: 'dev-1',
    agentId: 'dev-1',
    reviewRound: 0,
    status: 'in_progress',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: 'proj',
    repo: 'https://github.com/acme/demo.git',
    merge: null,
    agent: [],
    ...overrides,
  };
}

function emitProjectTasks(projectId: string, tasks: TaskState[]): void {
  const handlers = appMockState.subscribers.get(`project-tasks:${projectId}`) ?? new Set();
  act(() => {
    for (const handler of handlers) handler(tasks);
  });
}

// The app shell always subscribes to topics like 'pollers'; notification gating
// is only about project task streams.
function taskSubscribeCalls(): unknown[][] {
  return appMockState.subscribe.mock.calls.filter(
    (call) => typeof call[0] === 'string' && call[0].startsWith('project-tasks:'),
  );
}

function installNotificationMock(permission: NotificationPermission) {
  const instances: Array<{ title: string; options?: NotificationOptions; close: ReturnType<typeof vi.fn> }> = [];
  const requestPermission = vi.fn<() => Promise<NotificationPermission>>();
  class MockNotification {
    static permission = permission;
    static requestPermission = requestPermission;
    title: string;
    options?: NotificationOptions;
    onclick: (() => void) | null = null;
    close = vi.fn();

    constructor(title: string, options?: NotificationOptions) {
      this.title = title;
      this.options = options;
      instances.push(this);
    }
  }
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: MockNotification,
  });
  return { instances, requestPermission, MockNotification };
}

function restoreNotification(): void {
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: originalNotification,
  });
}

beforeEach(() => {
  window.history.pushState({}, '', '/');
  localStorage.clear();
  appMockState.projects = null;
  appMockState.refreshProjects.mockReset();
  appMockState.taskGet.mockReset();
  appMockState.subscribe.mockClear();
  appMockState.subscribers.clear();
  restoreNotification();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  restoreNotification();
});

describe('App shell layout', () => {
  it('renders a compact top navigation with a brand-only Home link', () => {
    const { container } = render(<App />);

    const homeLink = screen.getByRole('link', { name: 'baxian' });
    expect(homeLink.getAttribute('href')).toBe('/');
    expect(homeLink.textContent).toContain('baxian');
    expect(homeLink.getAttribute('aria-label')).toBeNull();

    const dot = homeLink.querySelector('span[aria-hidden]');
    expect(dot).toBeTruthy();
    expect(dot!.className).toContain('bg-accent');
    expect(dot!.className).toContain('h-2.5');
    expect(dot!.className).toContain('w-2.5');
    expect(dot!.className).toContain('rounded-full');
    expect(dot!.className).not.toContain('rounded-sm');

    const nav = container.querySelector('nav')!;
    expect(screen.queryByRole('link', { name: 'Dashboard' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Tasks' })).toBeNull();
    expect(container.querySelector('a[href="/tasks"]')).toBeNull();
    expect(nav.querySelector('button[aria-label^="Switch to logo"]')).toBeNull();

    const actions = nav.querySelector(`#${TOPBAR_ACTIONS_ID}`);
    expect(actions).toBeTruthy();
    expect(actions!.className).toContain('ml-auto');
    expect(actions!.className).toContain('justify-end');

    const navLinks = nav.querySelectorAll('a');
    expect(navLinks.length).toBe(1);
    expect(navLinks[0]).toBe(homeLink);
  });

  it('still routes "/" to the Dashboard page even though its nav link was removed', () => {
    render(<App />);
    expect(screen.getByTestId('page-dashboard')).toBeTruthy();
  });

  it('routes /project/:id/task/:taskId to the TaskDetail page', () => {
    window.history.pushState({}, '', '/project/baxian/task/task-172');
    render(<App />);
    expect(screen.getByTestId('page-task-detail')).toBeTruthy();
    expect(screen.queryByTestId('page-project')).toBeNull();
  });

  it('uses dynamic viewport sizing and aligned nav/main padding', () => {
    const { container } = render(<App />);

    const nav = container.querySelector('nav');
    const main = container.querySelector('main');
    expect(nav).toBeTruthy();
    expect(main).toBeTruthy();

    const shell = container.querySelector('nav')!.parentElement!;
    expect(shell.className).toContain('h-dvh');
    expect(shell.className).not.toContain('h-screen');

    const getHorizontalPadding = (el: HTMLElement) => {
      const padding = Array.from(el.classList).filter((c) => /(?:^|:)px-/.test(c)).sort();
      expect(padding.length).toBeGreaterThan(0);
      return padding;
    };

    expect(getHorizontalPadding(main!)).toEqual(getHorizontalPadding(nav!));
    expect(main!.classList.contains('py-6')).toBe(true);
    expect(main!.classList.contains('p-6')).toBe(false);
  });

  it('renders the bottom BrandToggle on non-terminal routes and keeps its toggle behavior', () => {
    const { container } = render(<App />);

    const footer = container.querySelector('footer');
    expect(footer).toBeTruthy();
    expect(footer!.className).toContain('mt-auto');
    expect(footer!.className).toContain('justify-center');
    expect(footer!.className).toContain('pt-24');
    expect(footer!.className).toContain('pb-4');

    const toggleBtn = footer!.querySelector('button[aria-label^="Switch to logo"]') as HTMLButtonElement | null;
    expect(toggleBtn).toBeTruthy();
    expect(toggleBtn!.getAttribute('aria-label')).toBe('Switch to logo text');

    expect(footer!.querySelector('img')?.getAttribute('src')).toBe('/baxian-logo.png');

    fireEvent.click(toggleBtn!);
    expect(footer!.querySelector('img')).toBeNull();
    expect(footer!.textContent).toContain('baxian');
    expect(toggleBtn!.getAttribute('aria-label')).toBe('Switch to logo icon');

    fireEvent.click(toggleBtn!);
    expect(footer!.querySelector('img')?.getAttribute('src')).toBe('/baxian-logo.png');

    cleanup();
    window.history.pushState({}, '', '/project/demo');
    const projectRoute = render(<App />);
    const projectFooter = projectRoute.container.querySelector('footer');
    expect(projectFooter).toBeTruthy();
    expect(projectFooter!.querySelector('button[aria-label^="Switch to logo"]')).toBeTruthy();
  });

  it('hides the bottom BrandToggle footer on /terminal/:agentId so the full-height terminal pane is not pushed up by the footer', () => {
    window.history.pushState({}, '', '/terminal/dev-1');
    const { container } = render(<App />);

    expect(container.querySelector('footer')).toBeNull();
    expect(screen.getByTestId('page-terminal')).toBeTruthy();
  });
});

describe('Task completion notifications', () => {
  it('renders no notification toggle in the topbar — the entry lives in the Settings modal', () => {
    installNotificationMock('default');
    appMockState.projects = [makeProject()];

    render(<App />);

    expect(screen.queryByText('Task completion notifications')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Task completion notifications' })).toBeNull();
    expect(taskSubscribeCalls()).toHaveLength(0);
  });

  it('does not subscribe to project task streams when notifications are turned off via the stored preference', async () => {
    installNotificationMock('granted');
    localStorage.setItem('baxian.taskNotifications.enabled', '0');
    appMockState.projects = [makeProject()];

    render(<App />);

    await act(async () => { await Promise.resolve(); });
    expect(taskSubscribeCalls()).toHaveLength(0);
  });

  it('drops an in-flight completion confirmation when notifications are disabled before it resolves', async () => {
    const notification = installNotificationMock('granted');
    appMockState.projects = [makeProject()];
    let resolveGet: (task: TaskState) => void = () => {};
    appMockState.taskGet.mockImplementation(
      () => new Promise<TaskState>((resolve) => { resolveGet = resolve; }),
    );

    render(<App />);

    await waitFor(() => expect(appMockState.subscribe).toHaveBeenCalled());
    emitProjectTasks('proj', [makeTask({ status: 'review' })]);
    emitProjectTasks('proj', []);
    await waitFor(() => expect(appMockState.taskGet).toHaveBeenCalledWith('task-188'));

    act(() => {
      localStorage.setItem('baxian.taskNotifications.enabled', '0');
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'baxian.taskNotifications.enabled', newValue: '0' }),
      );
    });

    await act(async () => {
      resolveGet(makeTask({ status: 'merged' }));
      await Promise.resolve();
    });
    expect(notification.instances).toHaveLength(0);
  });

  it('keeps a pre-disable confirmation dead even when notifications are re-enabled before it resolves', async () => {
    const notification = installNotificationMock('granted');
    appMockState.projects = [makeProject()];
    let resolveGet: (task: TaskState) => void = () => {};
    appMockState.taskGet.mockImplementation(
      () => new Promise<TaskState>((resolve) => { resolveGet = resolve; }),
    );

    render(<App />);

    await waitFor(() => expect(appMockState.subscribe).toHaveBeenCalled());
    emitProjectTasks('proj', [makeTask({ status: 'review' })]);
    emitProjectTasks('proj', []);
    await waitFor(() => expect(appMockState.taskGet).toHaveBeenCalledWith('task-188'));
    const subscribeCallsBefore = appMockState.subscribe.mock.calls.length;

    act(() => {
      localStorage.setItem('baxian.taskNotifications.enabled', '0');
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'baxian.taskNotifications.enabled', newValue: '0' }),
      );
    });
    act(() => {
      localStorage.setItem('baxian.taskNotifications.enabled', '1');
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'baxian.taskNotifications.enabled', newValue: '1' }),
      );
    });
    await waitFor(() => {
      expect(appMockState.subscribe.mock.calls.length).toBeGreaterThan(subscribeCallsBefore);
    });

    await act(async () => {
      resolveGet(makeTask({ status: 'merged' }));
      await Promise.resolve();
    });
    expect(notification.instances).toHaveLength(0);
  });

  it('keeps an in-flight completion confirmation alive across an unrelated project-list change', async () => {
    const notification = installNotificationMock('granted');
    appMockState.projects = [makeProject()];
    let resolveGet: (task: TaskState) => void = () => {};
    appMockState.taskGet.mockImplementation(
      () => new Promise<TaskState>((resolve) => { resolveGet = resolve; }),
    );

    const view = render(<App />);

    await waitFor(() => expect(appMockState.subscribe).toHaveBeenCalled());
    emitProjectTasks('proj', [makeTask({ status: 'review' })]);
    emitProjectTasks('proj', []);
    await waitFor(() => expect(appMockState.taskGet).toHaveBeenCalledWith('task-188'));

    appMockState.projects = [makeProject(), makeProject({ id: 'other' })];
    view.rerender(<App />);
    await waitFor(() => {
      expect(appMockState.subscribe).toHaveBeenCalledWith(
        'project-tasks:other',
        expect.any(Function),
        expect.any(Function),
      );
    });

    await act(async () => {
      resolveGet(makeTask({ status: 'merged' }));
      await Promise.resolve();
    });
    expect(notification.instances).toHaveLength(1);
    expect(notification.instances[0].options?.body).toContain('Status: Merged');
  });

  it('drops an in-flight completion confirmation when its own project is removed', async () => {
    const notification = installNotificationMock('granted');
    appMockState.projects = [makeProject()];
    let resolveGet: (task: TaskState) => void = () => {};
    appMockState.taskGet.mockImplementation(
      () => new Promise<TaskState>((resolve) => { resolveGet = resolve; }),
    );

    const view = render(<App />);

    await waitFor(() => expect(appMockState.subscribe).toHaveBeenCalled());
    emitProjectTasks('proj', [makeTask({ status: 'review' })]);
    emitProjectTasks('proj', []);
    await waitFor(() => expect(appMockState.taskGet).toHaveBeenCalledWith('task-188'));

    appMockState.projects = [makeProject({ id: 'other' })];
    view.rerender(<App />);
    await waitFor(() => {
      expect(appMockState.subscribe).toHaveBeenCalledWith(
        'project-tasks:other',
        expect.any(Function),
        expect.any(Function),
      );
    });

    await act(async () => {
      resolveGet(makeTask({ status: 'merged' }));
      await Promise.resolve();
    });
    expect(notification.instances).toHaveLength(0);
  });

  it('keeps a removed project\'s pre-removal confirmation dead even when the project returns before it resolves', async () => {
    const notification = installNotificationMock('granted');
    appMockState.projects = [makeProject()];
    let resolveGet: (task: TaskState) => void = () => {};
    appMockState.taskGet.mockImplementation(
      () => new Promise<TaskState>((resolve) => { resolveGet = resolve; }),
    );

    const view = render(<App />);

    await waitFor(() => expect(appMockState.subscribe).toHaveBeenCalled());
    emitProjectTasks('proj', [makeTask({ status: 'review' })]);
    emitProjectTasks('proj', []);
    await waitFor(() => expect(appMockState.taskGet).toHaveBeenCalledWith('task-188'));

    appMockState.projects = [makeProject({ id: 'other' })];
    view.rerender(<App />);
    await waitFor(() => {
      expect(appMockState.subscribe).toHaveBeenCalledWith(
        'project-tasks:other',
        expect.any(Function),
        expect.any(Function),
      );
    });

    appMockState.projects = [makeProject(), makeProject({ id: 'other' })];
    view.rerender(<App />);
    await waitFor(() => {
      const projSubscribes = appMockState.subscribe.mock.calls
        .filter(call => call[0] === 'project-tasks:proj');
      expect(projSubscribes.length).toBe(2);
    });

    await act(async () => {
      resolveGet(makeTask({ status: 'merged' }));
      await Promise.resolve();
    });
    expect(notification.instances).toHaveLength(0);
  });

  it('re-confirms a new completion after remove/re-add instead of being starved by the stale in-flight key', async () => {
    const notification = installNotificationMock('granted');
    appMockState.projects = [makeProject()];
    const resolvers: Array<(task: TaskState) => void> = [];
    appMockState.taskGet.mockImplementation(
      () => new Promise<TaskState>((resolve) => { resolvers.push(resolve); }),
    );

    const view = render(<App />);

    await waitFor(() => expect(appMockState.subscribe).toHaveBeenCalled());
    emitProjectTasks('proj', [makeTask({ status: 'review' })]);
    emitProjectTasks('proj', []);
    await waitFor(() => expect(appMockState.taskGet).toHaveBeenCalledTimes(1));

    appMockState.projects = [makeProject({ id: 'other' })];
    view.rerender(<App />);
    await waitFor(() => {
      expect(appMockState.subscribe).toHaveBeenCalledWith(
        'project-tasks:other',
        expect.any(Function),
        expect.any(Function),
      );
    });

    appMockState.projects = [makeProject(), makeProject({ id: 'other' })];
    view.rerender(<App />);
    await waitFor(() => {
      const projSubscribes = appMockState.subscribe.mock.calls
        .filter(call => call[0] === 'project-tasks:proj');
      expect(projSubscribes.length).toBe(2);
    });

    emitProjectTasks('proj', [makeTask({ status: 'review' })]);
    emitProjectTasks('proj', []);
    await waitFor(() => expect(appMockState.taskGet).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolvers[1](makeTask({ status: 'merged' }));
      await Promise.resolve();
    });
    expect(notification.instances).toHaveLength(1);
    expect(notification.instances[0].options?.body).toContain('Status: Merged');

    await act(async () => {
      resolvers[0](makeTask({ status: 'merged' }));
      await Promise.resolve();
    });
    expect(notification.instances).toHaveLength(1);
  });

  it('a queued stale disable storage event still kills in-flight confirmations even when storage already reads enabled', async () => {
    const notification = installNotificationMock('granted');
    appMockState.projects = [makeProject()];
    let resolveGet: (task: TaskState) => void = () => {};
    appMockState.taskGet.mockImplementation(
      () => new Promise<TaskState>((resolve) => { resolveGet = resolve; }),
    );

    render(<App />);

    await waitFor(() => expect(appMockState.subscribe).toHaveBeenCalled());
    emitProjectTasks('proj', [makeTask({ status: 'review' })]);
    emitProjectTasks('proj', []);
    await waitFor(() => expect(appMockState.taskGet).toHaveBeenCalledWith('task-188'));

    act(() => {
      localStorage.setItem('baxian.taskNotifications.enabled', '1');
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'baxian.taskNotifications.enabled', newValue: '0' }),
      );
    });
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'baxian.taskNotifications.enabled', newValue: '1' }),
      );
    });
    await waitFor(() => {
      const projSubscribes = appMockState.subscribe.mock.calls
        .filter(call => call[0] === 'project-tasks:proj');
      expect(projSubscribes.length).toBe(2);
    });

    await act(async () => {
      resolveGet(makeTask({ status: 'merged' }));
      await Promise.resolve();
    });
    expect(notification.instances).toHaveLength(0);
  });

  it('subscribes without a focus event once another tab finishes granting and broadcasts the preference', async () => {
    const notification = installNotificationMock('default');
    appMockState.projects = [makeProject()];

    render(<App />);

    await act(async () => { await Promise.resolve(); });
    expect(taskSubscribeCalls()).toHaveLength(0);

    notification.MockNotification.permission = 'granted';
    act(() => {
      localStorage.setItem('baxian.taskNotifications.enabled', '1');
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'baxian.taskNotifications.enabled', newValue: '1' }),
      );
    });

    await waitFor(() => {
      expect(appMockState.subscribe).toHaveBeenCalledWith(
        'project-tasks:proj',
        expect.any(Function),
        expect.any(Function),
      );
    });
  });

  it('re-subscribes when another tab turns the preference back on', async () => {
    installNotificationMock('granted');
    localStorage.setItem('baxian.taskNotifications.enabled', '0');
    appMockState.projects = [makeProject()];

    render(<App />);

    await act(async () => { await Promise.resolve(); });
    expect(taskSubscribeCalls()).toHaveLength(0);

    act(() => {
      localStorage.setItem('baxian.taskNotifications.enabled', '1');
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'baxian.taskNotifications.enabled', newValue: '1' }),
      );
    });

    await waitFor(() => {
      expect(appMockState.subscribe).toHaveBeenCalledWith(
        'project-tasks:proj',
        expect.any(Function),
        expect.any(Function),
      );
    });
  });

  it('shows a system notification when an observed task reaches merged', async () => {
    const notification = installNotificationMock('granted');
    const active = makeTask({ id: 'task-188', status: 'in_progress' });
    const completed = makeTask({ id: 'task-188', status: 'merged' });
    appMockState.projects = [makeProject()];
    appMockState.taskGet.mockResolvedValue(completed);

    render(<App />);

    await waitFor(() => {
      expect(appMockState.subscribe).toHaveBeenCalledWith(
        'project-tasks:proj',
        expect.any(Function),
        expect.any(Function),
      );
    });
    emitProjectTasks('proj', [active]);
    expect(notification.instances).toHaveLength(0);

    emitProjectTasks('proj', []);

    await waitFor(() => expect(appMockState.taskGet).toHaveBeenCalledWith('task-188'));
    await waitFor(() => expect(notification.instances).toHaveLength(1));
    expect(notification.instances[0].title).toContain('Task completed: Ship notifications');
    expect(notification.instances[0].options?.body).toContain('Project: proj · https://github.com/acme/demo.git');
    expect(notification.instances[0].options?.body).toContain('Task: task-188 · Ship notifications');
    expect(notification.instances[0].options?.body).toContain('Status: Merged');
  });

  it('does not notify when the disappeared task is terminal but not completed', async () => {
    const notification = installNotificationMock('granted');
    appMockState.projects = [makeProject()];
    appMockState.taskGet.mockResolvedValue(makeTask({ status: 'failed' }));

    render(<App />);

    await waitFor(() => expect(appMockState.subscribe).toHaveBeenCalled());
    emitProjectTasks('proj', [makeTask({ status: 'review' })]);
    emitProjectTasks('proj', []);

    await waitFor(() => expect(appMockState.taskGet).toHaveBeenCalledWith('task-188'));
    await act(async () => { await Promise.resolve(); });
    expect(notification.instances).toHaveLength(0);
  });

  it('retries completion confirmation on a later project task frame after a transient GET failure', async () => {
    const notification = installNotificationMock('granted');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    appMockState.projects = [makeProject()];
    appMockState.taskGet
      .mockRejectedValueOnce(new Error('server restarting'))
      .mockResolvedValueOnce(makeTask({ status: 'done' }));

    try {
      render(<App />);

      await waitFor(() => expect(appMockState.subscribe).toHaveBeenCalled());
      emitProjectTasks('proj', [makeTask({ status: 'review' })]);
      emitProjectTasks('proj', []);

      await waitFor(() => expect(appMockState.taskGet).toHaveBeenCalledTimes(1));
      await act(async () => { await Promise.resolve(); });
      expect(warn).toHaveBeenCalledWith(
        '[task-notifications] failed to confirm completed task task-188:',
        expect.any(Error),
      );
      expect(notification.instances).toHaveLength(0);

      emitProjectTasks('proj', []);

      await waitFor(() => expect(appMockState.taskGet).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(notification.instances).toHaveLength(1));
      expect(notification.instances[0].options?.body).toContain('Status: Done');
    } finally {
      warn.mockRestore();
    }
  });

  it('ignores an empty task confirmation response without throwing or notifying', async () => {
    const notification = installNotificationMock('granted');
    appMockState.projects = [makeProject()];
    appMockState.taskGet.mockResolvedValue(null);

    render(<App />);

    await waitFor(() => expect(appMockState.subscribe).toHaveBeenCalled());
    emitProjectTasks('proj', [makeTask({ status: 'review' })]);
    emitProjectTasks('proj', []);

    await waitFor(() => expect(appMockState.taskGet).toHaveBeenCalledWith('task-188'));
    await act(async () => { await Promise.resolve(); });
    expect(notification.instances).toHaveLength(0);
  });
});

describe('TopbarActions', () => {
  it('portals into an existing topbar container before layout effects run', () => {
    document.body.innerHTML = `<div id="${TOPBAR_ACTIONS_ID}"></div>`;
    const layoutSnapshots: string[] = [];

    function LayoutProbe() {
      useLayoutEffect(() => {
        layoutSnapshots.push(document.getElementById(TOPBAR_ACTIONS_ID)?.textContent ?? '');
      }, []);
      return null;
    }

    render(
      <>
        <TopbarActions><button type="button">first-pass action</button></TopbarActions>
        <LayoutProbe />
      </>,
    );

    expect(layoutSnapshots).toEqual(['first-pass action']);
    expect(screen.getByRole('button', { name: 'first-pass action' })).toBeTruthy();
  });

  it('falls back after mount when the topbar container is created in the same React commit', async () => {
    render(
      <>
        <div id={TOPBAR_ACTIONS_ID} />
        <TopbarActions><button type="button">same-commit action</button></TopbarActions>
      </>,
    );

    expect(await screen.findByRole('button', { name: 'same-commit action' })).toBeTruthy();
  });
});

describe('index.html', () => {
  const indexHtml = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'),
    'utf8',
  );

  it('declares the brand PNG for browser and iOS icons', () => {
    expect(indexHtml).toMatch(
      /<link\s+rel="icon"\s+type="image\/png"\s+href="\/baxian-logo\.png"\s*\/?>/,
    );
    expect(indexHtml).toMatch(
      /<link\s+rel="apple-touch-icon"\s+href="\/baxian-logo\.png"\s*\/?>/,
    );
  });
});
