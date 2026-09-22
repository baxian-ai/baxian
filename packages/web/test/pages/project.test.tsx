import { enUS } from '../../src/i18n/en-us.ts';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ProjectConfig, AgentSnapshot, TaskState } from '../../src/shared/index.js';
import { __resetProjectsCacheForTests, useProjects } from '../../src/hooks/use-projects.ts';

vi.mock('../../src/components/pane-terminal.tsx', async () => (await import('../helpers/pane-terminal-mock.tsx')).createPaneTerminalMock());

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
  CreateTaskModal: ({ open }: { open: boolean }) => (open ? <div role="dialog" aria-label={enUS.createTask.titleCreate} /> : null),
}));

vi.mock('../../src/components/create-agent-modal.tsx', () => ({
  CreateAgentModal: ({ open }: { open: boolean }) => (open ? <div role="dialog" aria-label={enUS.projectPage.addAgent} /> : null),
}));

import { api } from '../../src/api.ts';
import { useAgentsMock, useProjectTasksMock, useTaskMock } from '../helpers/events-mock.ts';
import { makeProject } from '../helpers/fixtures.ts';
import { ConfirmProvider } from '../../src/components/confirm-dialog.tsx';
import { ToastProvider } from '../../src/components/toast.tsx';
import { Project } from '../../src/pages/project.tsx';
import { TOPBAR_ACTIONS_ID } from '../../src/components/topbar-actions.tsx';

const projectsGet = vi.mocked(api.projects.get);
const projectsList = vi.mocked(api.projects.list);
const projectsDelete = vi.mocked(api.projects.delete);

function LocationProbe() {
  const loc = useLocation();
  return <div role="region" aria-label="location">{loc.pathname}</div>;
}

function topbarActions(): HTMLElement {
  return document.getElementById(TOPBAR_ACTIONS_ID)!;
}

function renderProjectPage() {
  return render(
    <MemoryRouter initialEntries={['/project/demo']}>
      <ToastProvider>
        <ConfirmProvider>
          <div id={TOPBAR_ACTIONS_ID} />
          <Routes>
            <Route path="/project/:id" element={<Project />} />
            <Route path="/" element={<LocationProbe />} />
          </Routes>
        </ConfirmProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

async function openProjectMenu(): Promise<void> {
  fireEvent.click(await waitFor(() => screen.getByRole('button', { name: enUS.projectPage.menuAriaLabel('demo') })));
}

async function openDeleteDialog(): Promise<HTMLElement> {
  await openProjectMenu();
  fireEvent.click(await waitFor(() => screen.getByRole('menuitem', { name: enUS.projectPage.deleteProjectMenuItem })));
  return waitFor(() => screen.getByRole('dialog', { name: enUS.projectPage.deleteModalTitle }));
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  __resetProjectsCacheForTests();
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
  it('lists the project id and repo, each exposing its full text as hover title', async () => {
    renderProjectPage();

    const heading = await waitFor(() => screen.getByRole('heading', { level: 1, name: 'demo' }));
    expect(heading.getAttribute('title')).toBe('demo');

    const repo = screen.getByText('/tmp/demo-repo');
    expect(repo.getAttribute('title')).toBe('/tmp/demo-repo');
    // jsdom does no text layout: the truncate token is the only guard that long values keep the header one line
    for (const el of [heading, repo]) expect(el.className.split(/\s+/)).toContain('truncate');
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

    const taskBtn = within(topbarActions()).getByRole('button', { name: enUS.projectPage.newTaskButton });
    expect(screen.getAllByRole('button', { name: enUS.projectPage.newTaskButton })).toHaveLength(1);
    expect(screen.queryByRole('dialog', { name: enUS.createTask.titleCreate })).toBeNull();
    fireEvent.click(taskBtn);
    expect(await screen.findByRole('dialog', { name: enUS.createTask.titleCreate })).toBeTruthy();
  });

  it('only sets aria-controls on the project three-dot menu while it is open', async () => {
    renderProjectPage();
    const trigger = await waitFor(() => screen.getByRole('button', { name: enUS.projectPage.menuAriaLabel('demo') }));
    expect(trigger.getAttribute('aria-controls')).toBeNull();

    fireEvent.click(trigger);
    const menu = await waitFor(() => screen.getByRole('menu'));
    expect(menu.id).toBeTruthy();
    expect(trigger.getAttribute('aria-controls')).toBe(menu.id);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(trigger.getAttribute('aria-controls')).toBeNull();
  });

  it('moves the project three-dot menu into the topbar and keeps "Add Agent Team" inside it', async () => {
    renderProjectPage();
    await waitFor(() => screen.getByRole('heading', { level: 1, name: 'demo' }));

    expect(screen.queryByRole('button', { name: enUS.projectPage.addAgent })).toBeNull();
    expect(within(topbarActions()).getByRole('button', { name: enUS.projectPage.menuAriaLabel('demo') })).toBeTruthy();

    await openProjectMenu();
    const item = await screen.findByRole('menuitem', { name: enUS.projectPage.addAgent });

    expect(screen.queryByRole('dialog', { name: enUS.projectPage.addAgent })).toBeNull();
    fireEvent.click(item);
    expect(await screen.findByRole('dialog', { name: enUS.projectPage.addAgent })).toBeTruthy();
  });
});

describe('Project Task panel', () => {
  it('opens the Task panel by default and renders its title/close control outside the panel', async () => {
    renderProjectPage();
    const panel = await waitFor(() => screen.getByRole('complementary', { name: enUS.taskPanel.ariaLabel }));
    const heading = screen.getByRole('heading', { name: 'Tasks' });
    expect(screen.getByRole('heading', { name: 'Agents' })).toBeTruthy();
    const closeBtn = screen.getByRole('button', { name: enUS.projectPage.closeTaskPanel });
    expect(panel.contains(heading)).toBe(false);
    expect(panel.contains(closeBtn)).toBe(false);
    expect(screen.queryByRole('menuitem', { name: enUS.projectPage.showTaskPanel })).toBeNull();
  });

  it('closes via the header button and reopens from the three-dot menu', async () => {
    renderProjectPage();
    await waitFor(() => screen.getByRole('complementary', { name: enUS.taskPanel.ariaLabel }));
    const menuBtn = screen.getByRole('button', { name: enUS.projectPage.menuAriaLabel('demo') });

    fireEvent.click(screen.getByRole('button', { name: enUS.projectPage.closeTaskPanel }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: enUS.taskPanel.ariaLabel })).toBeNull());
    expect(document.activeElement).toBe(menuBtn);

    await openProjectMenu();
    const reopen = await waitFor(() => screen.getByRole('menuitem', { name: enUS.projectPage.showTaskPanel }));
    fireEvent.click(reopen);

    expect(await waitFor(() => screen.getByRole('complementary', { name: enUS.taskPanel.ariaLabel }))).toBeTruthy();
    expect(document.activeElement).toBe(menuBtn);
    await openProjectMenu();
    expect(screen.queryByRole('menuitem', { name: enUS.projectPage.showTaskPanel })).toBeNull();
  });

  it('persists and restores the Task panel closed state', async () => {
    renderProjectPage();
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: enUS.projectPage.closeTaskPanel })));
    await waitFor(() => expect(localStorage.getItem('baxian.taskPanel.open')).toBe('0'));

    cleanup();
    renderProjectPage();
    await waitFor(() => screen.getByRole('button', { name: enUS.projectPage.menuAriaLabel('demo') }));
    expect(screen.queryByRole('complementary', { name: enUS.taskPanel.ariaLabel })).toBeNull();

    await openProjectMenu();
    fireEvent.click(await waitFor(() => screen.getByRole('menuitem', { name: enUS.projectPage.showTaskPanel })));
    await waitFor(() => expect(localStorage.getItem('baxian.taskPanel.open')).toBe('1'));
    expect(await waitFor(() => screen.getByRole('complementary', { name: enUS.taskPanel.ariaLabel }))).toBeTruthy();
  });
});

describe('Project delete entry', () => {
  it('keeps delete inside the project menu, enabled when the project has no agents', async () => {
    renderProjectPage();
    const menuButton = await waitFor(() => screen.getByRole('button', { name: enUS.projectPage.menuAriaLabel('demo') }));

    expect(screen.queryByRole('menuitem')).toBeNull();
    expect(screen.queryByText(enUS.projectPage.deleteProjectMenuItem)).toBeNull();
    fireEvent.click(menuButton);

    const item = await waitFor(() => screen.getByRole('menuitem', { name: enUS.projectPage.deleteProjectMenuItem }));
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
    const item = await waitFor(() => screen.getByRole('menuitem', { name: enUS.projectPage.deleteProjectMenuItem }));
    expect((item as HTMLButtonElement).disabled).toBe(true);
    expect(item.getAttribute('title')).toBe(enUS.projectPage.deleteAgentsFirstHint(1));
  });

  it('validates exact project id before delete and resets confirmation on cancel', async () => {
    renderProjectPage();
    const dialog = await openDeleteDialog();
    const confirm = within(dialog).getByRole('button', { name: enUS.projectPage.confirmDeleteButton }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    const input = within(dialog).getByLabelText(enUS.projectPage.confirmInputAriaLabel) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'wrong' } });
    expect(confirm.disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'demo' } });
    expect(confirm.disabled).toBe(false);

    fireEvent.click(within(dialog).getByRole('button', { name: enUS.common.cancel }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: enUS.projectPage.deleteModalTitle })).toBeNull());

    const reopened = await openDeleteDialog();
    const reopenedInput = within(reopened).getByLabelText(enUS.projectPage.confirmInputAriaLabel) as HTMLInputElement;
    expect(reopenedInput.value).toBe('');
  });

  it('confirming delete calls the API, refreshes cache, shows success, and navigates home', async () => {
    projectsListPayload = [makeProject({ id: 'demo', repo: '/tmp/demo-repo' })];
    function ProjectIdsProbe() {
      const { projects } = useProjects();
      return <div role="region" aria-label="cached project ids">{(projects ?? []).map(p => p.id).join(',')}</div>;
    }
    render(
      <MemoryRouter initialEntries={['/project/demo']}>
        <ToastProvider>
          <ConfirmProvider>
            <div id={TOPBAR_ACTIONS_ID} />
            <Routes>
              <Route path="/project/:id" element={<Project />} />
              <Route path="/" element={<><LocationProbe /><ProjectIdsProbe /></>} />
            </Routes>
          </ConfirmProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    const dialog = await openDeleteDialog();
    fireEvent.change(within(dialog).getByLabelText(enUS.projectPage.confirmInputAriaLabel), {
      target: { value: 'demo' },
    });
    projectsListPayload = [];
    fireEvent.click(within(dialog).getByRole('button', { name: enUS.projectPage.confirmDeleteButton }));

    await waitFor(() => expect(projectsDelete).toHaveBeenCalledWith('demo'));
    await waitFor(() => expect(projectsList).toHaveBeenCalled());
    expect((await screen.findByRole('status')).textContent).toMatch(/deleted/);
    await waitFor(() => expect(screen.getByRole('region', { name: 'location' }).textContent).toBe('/'));
    expect(screen.getByRole('region', { name: 'cached project ids' }).textContent).toBe('');
  });

  it('surfaces server error in the modal and keeps the user on the project page', async () => {
    projectsDelete.mockRejectedValueOnce(new Error('boom — config locked'));
    renderProjectPage();
    const dialog = await openDeleteDialog();
    fireEvent.change(within(dialog).getByLabelText(enUS.projectPage.confirmInputAriaLabel), {
      target: { value: 'demo' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: enUS.projectPage.confirmDeleteButton }));

    await waitFor(() => expect(within(dialog).getByText(/boom — config locked/)).toBeTruthy());
    expect(screen.queryByRole('region', { name: 'location' })).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
