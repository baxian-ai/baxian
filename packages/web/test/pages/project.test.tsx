import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ProjectConfig, AgentSnapshot, TaskState } from '../../src/shared/index.js';
import { __resetProjectsCacheForTests, useProjects } from '../../src/hooks/use-projects.ts';

vi.mock('../../src/components/pane-terminal.tsx', async () => (await import('../helpers/pane-terminal-mock.tsx')).createPaneTerminalMock());

vi.mock('../../src/components/toast.tsx', async () => (await import('../helpers/toast-mock.tsx')).createToastMock());

vi.mock('../../src/hooks/use-pending-restart.tsx', async () => (await import('../helpers/pending-restart-mock.tsx')).createPendingRestartMock());

let projectPayload: ProjectConfig;
let projectsListPayload: ProjectConfig[];

vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());

const agentsHookState = {
  data: [] as AgentSnapshot[] | null,
  loaded: true,
  error: null as { message: string } | null,
};

const projectTasksState = {
  data: [] as TaskState[] | null,
  error: null as { message: string } | null,
};

vi.mock('../../src/hooks/use-events.ts', async () => (await import('../helpers/events-mock.ts')).createEventsMock());

vi.mock('../../src/components/create-task-modal.tsx', () => ({
  CreateTaskModal: ({ open }: { open: boolean }) => (open ? <div data-testid="create-task-modal" /> : null),
}));

vi.mock('../../src/components/create-agent-modal.tsx', () => ({
  CreateAgentModal: ({ open }: { open: boolean }) => (open ? <div data-testid="create-agent-modal" /> : null),
}));

import { api } from '../../src/api.ts';
import { toastShowMock as toastShow } from '../helpers/toast-mock.tsx';
import { useAgentsMock, useProjectTasksMock, useTaskMock } from '../helpers/events-mock.ts';
import { makeProject } from '../helpers/fixtures.ts';
import { ConfirmProvider } from '../../src/components/confirm-dialog.tsx';
import { Project } from '../../src/pages/project.tsx';
import { TOPBAR_ACTIONS_ID } from '../../src/components/topbar-actions.tsx';

const projectsGet = vi.mocked(api.projects.get);
const projectsList = vi.mocked(api.projects.list);
const projectsDelete = vi.mocked(api.projects.delete);

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname}</div>;
}

function renderProjectPage() {
  return render(
    <MemoryRouter initialEntries={['/project/demo']}>
      <ConfirmProvider>
        <div id={TOPBAR_ACTIONS_ID} data-testid="topbar-actions" />
        <Routes>
          <Route path="/project/:id" element={<Project />} />
          <Route path="/" element={<LocationProbe />} />
        </Routes>
      </ConfirmProvider>
    </MemoryRouter>,
  );
}

async function openProjectMenu(): Promise<void> {
  fireEvent.click(await waitFor(() => screen.getByRole('button', { name: /Project demo actions menu/ })));
}

async function openDeleteDialog(): Promise<HTMLElement> {
  await openProjectMenu();
  fireEvent.click(await waitFor(() => screen.getByRole('menuitem', { name: 'Delete project…' })));
  return waitFor(() => screen.getByRole('dialog', { name: 'Delete project' }));
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  __resetProjectsCacheForTests();
  toastShow.mockClear();
  projectsGet.mockClear();
  projectsList.mockClear();
  projectsDelete.mockClear();
  projectsGet.mockImplementation(async () => projectPayload);
  projectsList.mockImplementation(async () => projectsListPayload);
  projectsDelete.mockResolvedValue({ removed: 'demo', restartRequired: false });
  vi.mocked(api.tasks.page).mockResolvedValue({ tasks: [], hasMore: false, nextOffset: 0 });
  useAgentsMock.mockImplementation(() => agentsHookState);
  useProjectTasksMock.mockImplementation(() => projectTasksState);
  useTaskMock.mockReturnValue({ data: null, loaded: true, error: null });
  projectPayload = makeProject({ id: 'demo', repo: '/tmp/demo-repo' });
  projectsListPayload = [];
  agentsHookState.data = [];
  agentsHookState.loaded = true;
  agentsHookState.error = null;
  projectTasksState.data = [];
  projectTasksState.error = null;
});

describe('Project page header', () => {
  it('lists the project id and repo with compact header styling', async () => {
    renderProjectPage();

    const heading = await waitFor(() => screen.getByRole('heading', { level: 1, name: 'demo' }));
    expect(heading.className).toContain('text-sm');
    expect(heading.className).toContain('font-display');
    expect(heading.className).toContain('font-semibold');

    const repo = screen.getByText('/tmp/demo-repo');
    expect(repo.className).toContain('font-mono');
    expect(repo.className).toContain('text-xs');
    expect(repo.className).toContain('text-og-500');
    expect(repo.className).toContain('truncate');
    expect(repo.className).not.toContain('break-words');
    expect(repo.getAttribute('title')).toBe('/tmp/demo-repo');

    expect(heading.className).toContain('truncate');
    expect(heading.getAttribute('title')).toBe('demo');
  });

  it('hides the repo path below sm so the header stays compact on mobile', async () => {
    renderProjectPage();

    const repo = await waitFor(() => screen.getByText('/tmp/demo-repo'));
    expect(repo.className).toContain('hidden');
    expect(repo.className).toContain('sm:inline-block');
  });
});

describe('Project header actions', () => {
  it('moves the top-level "+ New task" button into the topbar and opens the create-task modal', async () => {
    renderProjectPage();
    await waitFor(() => screen.getByRole('heading', { level: 1, name: 'demo' }));

    const topbarActions = screen.getByTestId('topbar-actions');
    const taskBtn = within(topbarActions).getByRole('button', { name: '+ New task' });
    expect(taskBtn.className).toContain('btn-ghost');
    expect(screen.getAllByRole('button', { name: '+ New task' })).toHaveLength(1);
    expect(screen.queryByTestId('create-task-modal')).toBeNull();
    fireEvent.click(taskBtn);
    expect(await screen.findByTestId('create-task-modal')).toBeTruthy();
  });

  it('only sets aria-controls on the project three-dot menu while it is open', async () => {
    renderProjectPage();
    const trigger = await waitFor(() => screen.getByRole('button', { name: /Project demo actions menu/ }));
    expect(trigger.getAttribute('aria-controls')).toBeNull();

    fireEvent.click(trigger);
    const menu = await waitFor(() => screen.getByRole('menu'));
    expect(menu.id).toBeTruthy();
    expect(trigger.getAttribute('aria-controls')).toBe(menu.id);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(trigger.getAttribute('aria-controls')).toBeNull();
  });

  it('moves the project three-dot menu into the topbar and keeps "Add agent" inside it', async () => {
    renderProjectPage();
    await waitFor(() => screen.getByRole('heading', { level: 1, name: 'demo' }));

    expect(screen.queryByRole('button', { name: /Add agent/ })).toBeNull();
    const topbarActions = screen.getByTestId('topbar-actions');
    expect(within(topbarActions).getByRole('button', { name: /Project demo actions menu/ })).toBeTruthy();

    await openProjectMenu();
    const item = await screen.findByRole('menuitem', { name: 'Add agent' });
    expect(item.className).not.toContain('text-danger');

    expect(screen.queryByTestId('create-agent-modal')).toBeNull();
    fireEvent.click(item);
    expect(await screen.findByTestId('create-agent-modal')).toBeTruthy();
  });
});

describe('Project Task panel', () => {
  it('opens the Task panel by default and renders its title/close control outside the panel', async () => {
    renderProjectPage();
    const panel = await waitFor(() => screen.getByRole('complementary', { name: 'Task panel' }));
    const heading = screen.getByRole('heading', { name: 'Tasks' });
    const agentsHeading = screen.getByRole('heading', { name: 'Agents' });
    const closeBtn = screen.getByRole('button', { name: 'Close task panel' });
    expect(panel.contains(heading)).toBe(false);
    expect(panel.contains(closeBtn)).toBe(false);
    expect(heading.className).toBe(agentsHeading.className);
    expect(screen.queryByRole('menuitem', { name: 'Show task panel' })).toBeNull();
  });

  it('closes via the header button and reopens from the three-dot menu', async () => {
    renderProjectPage();
    await waitFor(() => screen.getByRole('complementary', { name: 'Task panel' }));
    const menuBtn = screen.getByRole('button', { name: /Project demo actions menu/ });

    fireEvent.click(screen.getByRole('button', { name: 'Close task panel' }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Task panel' })).toBeNull());
    expect(document.activeElement).toBe(menuBtn);

    await openProjectMenu();
    const reopen = await waitFor(() => screen.getByRole('menuitem', { name: 'Show task panel' }));
    fireEvent.click(reopen);

    expect(await waitFor(() => screen.getByRole('complementary', { name: 'Task panel' }))).toBeTruthy();
    expect(document.activeElement).toBe(menuBtn);
    await openProjectMenu();
    expect(screen.queryByRole('menuitem', { name: 'Show task panel' })).toBeNull();
  });

  it('persists and restores the Task panel closed state', async () => {
    renderProjectPage();
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Close task panel' })));
    await waitFor(() => expect(localStorage.getItem('baxian.taskPanel.open')).toBe('0'));

    cleanup();
    renderProjectPage();
    await waitFor(() => screen.getByRole('button', { name: /Project demo actions menu/ }));
    expect(screen.queryByRole('complementary', { name: 'Task panel' })).toBeNull();

    await openProjectMenu();
    fireEvent.click(await waitFor(() => screen.getByRole('menuitem', { name: 'Show task panel' })));
    await waitFor(() => expect(localStorage.getItem('baxian.taskPanel.open')).toBe('1'));
    expect(await waitFor(() => screen.getByRole('complementary', { name: 'Task panel' }))).toBeTruthy();
  });
});

describe('Project delete entry', () => {
  it('keeps delete inside the project menu and marks it destructive', async () => {
    renderProjectPage();
    const menuButton = await waitFor(() => screen.getByRole('button', { name: /Project demo actions menu/ }));

    expect(screen.queryByRole('menuitem')).toBeNull();
    expect(screen.queryByText('Delete project…')).toBeNull();
    fireEvent.click(menuButton);

    const item = await waitFor(() => screen.getByRole('menuitem', { name: 'Delete project…' }));
    expect(item.className).toContain('text-og-1000');
    expect(item.hasAttribute('disabled')).toBe(false);
  });

  it('disables the delete menuitem (with hint) when the project still has agents', async () => {
    projectPayload = makeProject({
      id: 'demo',
      repo: '/tmp/demo-repo',
      agent: [[{ id: 'demo-dev', runtime: 'claude-code', role: 'dev', mode: 'local' }]],
    });
    renderProjectPage();

    await openProjectMenu();
    const item = await waitFor(() => screen.getByRole('menuitem', { name: 'Delete project…' }));
    expect((item as HTMLButtonElement).disabled).toBe(true);
    expect(item.getAttribute('title')).toMatch(/Delete the project's 1 agent first/);
  });

  it('validates exact project id before delete and resets confirmation on cancel', async () => {
    renderProjectPage();
    const dialog = await openDeleteDialog();
    const confirm = within(dialog).getByRole('button', { name: 'Confirm delete' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    const input = within(dialog).getByLabelText('Enter the project ID to confirm deletion') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'wrong' } });
    expect(confirm.disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'demo' } });
    expect(confirm.disabled).toBe(false);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete project' })).toBeNull());

    const reopened = await openDeleteDialog();
    const reopenedInput = within(reopened).getByLabelText('Enter the project ID to confirm deletion') as HTMLInputElement;
    expect(reopenedInput.value).toBe('');
  });

  it('confirming delete calls the API, refreshes cache, shows success, and navigates home', async () => {
    projectsListPayload = [makeProject({ id: 'demo', repo: '/tmp/demo-repo' })];
    function ProjectIdsProbe() {
      const { projects } = useProjects();
      return <div data-testid="cached-ids">{(projects ?? []).map(p => p.id).join(',')}</div>;
    }
    render(
      <MemoryRouter initialEntries={['/project/demo']}>
        <ConfirmProvider>
          <div id={TOPBAR_ACTIONS_ID} data-testid="topbar-actions" />
          <Routes>
            <Route path="/project/:id" element={<Project />} />
            <Route path="/" element={<><LocationProbe /><ProjectIdsProbe /></>} />
          </Routes>
        </ConfirmProvider>
      </MemoryRouter>,
    );

    const dialog = await openDeleteDialog();
    fireEvent.change(within(dialog).getByLabelText('Enter the project ID to confirm deletion'), {
      target: { value: 'demo' },
    });
    projectsListPayload = [];
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm delete' }));

    await waitFor(() => expect(projectsDelete).toHaveBeenCalledWith('demo'));
    await waitFor(() => expect(projectsList).toHaveBeenCalled());
    await waitFor(() => expect(toastShow).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'success', title: expect.stringContaining('deleted') }),
    ));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/'));
    expect(screen.getByTestId('cached-ids').textContent).toBe('');
  });

  it('surfaces server error in the modal and keeps the user on the project page', async () => {
    projectsDelete.mockRejectedValueOnce(new Error('boom — config locked'));
    renderProjectPage();
    const dialog = await openDeleteDialog();
    fireEvent.change(within(dialog).getByLabelText('Enter the project ID to confirm deletion'), {
      target: { value: 'demo' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm delete' }));

    await waitFor(() => expect(within(dialog).getByText(/boom — config locked/)).toBeTruthy());
    expect(screen.queryByTestId('location')).toBeNull();
    expect(toastShow).not.toHaveBeenCalled();
  });
});
