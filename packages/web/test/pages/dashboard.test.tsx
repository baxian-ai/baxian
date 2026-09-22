import { enUS } from '../../src/i18n/en-us.ts';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup, screen, within, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ProjectConfig, AgentSnapshot, TaskState } from '../../src/shared/index.js';

vi.mock('../../src/components/pane-terminal.tsx', async () => (await import('../helpers/pane-terminal-mock.tsx')).createPaneTerminalMock());

vi.mock('../../src/hooks/use-pending-restart.tsx', async () => (await import('../helpers/pending-restart-mock.tsx')).createPendingRestartMock());

vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());

vi.mock('../../src/components/create-agent-modal.tsx', () => ({
  CreateAgentModal: ({ open, projectId }: { open: boolean; projectId: string }) =>
    open ? <div role="dialog" aria-label={enUS.projectPage.addAgent}>agent:{projectId}</div> : null,
}));

const agentsHookState = {
  data: null as AgentSnapshot[] | null,
  loaded: false,
  error: null as { message: string } | null,
};
const projectTasksHookState = {
  data: [] as TaskState[] | null,
  loaded: true,
  error: null as { code: string; message: string } | null,
};
vi.mock('../../src/hooks/use-events.ts', async () => (await import('../helpers/events-mock.ts')).createEventsMock());

import { api } from '../../src/api.ts';
import { useAgentsMock, useProjectTasksMock, useTaskMock } from '../helpers/events-mock.ts';
import { makeProject } from '../helpers/fixtures.ts';
import { ConfirmProvider } from '../../src/components/confirm-dialog.tsx';
import { ToastProvider } from '../../src/components/toast.tsx';
import { Dashboard } from '../../src/pages/dashboard.tsx';
import { __resetProjectsCacheForTests } from '../../src/hooks/use-projects.ts';
import { TaskNotificationsProvider } from '../../src/hooks/use-task-notifications.tsx';
import { TOPBAR_ACTIONS_ID } from '../../src/components/topbar-actions.tsx';

function seed(projects: ProjectConfig[], agents: AgentSnapshot[] = []): void {
  vi.mocked(api.projects.list).mockResolvedValue(projects);
  agentsHookState.data = agents;
  agentsHookState.loaded = true;
}

function topbarActions(): HTMLElement {
  return document.getElementById(TOPBAR_ACTIONS_ID)!;
}

function renderDashboard() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <TaskNotificationsProvider>
          <ConfirmProvider>
            <div id={TOPBAR_ACTIONS_ID} />
            <Dashboard />
          </ConfirmProvider>
        </TaskNotificationsProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

const TEAM = [
  { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local' },
  { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local' },
] as const;
const SECOND_TEAM = [
  { id: 'dev-2', runtime: 'claude-code', role: 'dev', mode: 'local' },
  { id: 'qa-2', runtime: 'codex', role: 'qa', mode: 'local' },
] as const;

function demoProject(agent: ProjectConfig['agent'] = []): ProjectConfig {
  return makeProject({ id: 'demo', repo: '/tmp/demo', agent });
}

async function findMoreActions(): Promise<HTMLElement> {
  return screen.findByRole('button', { name: enUS.dashboard.moreActions });
}

beforeEach(() => {
  cleanup();
  __resetProjectsCacheForTests();
  useAgentsMock.mockImplementation(() => agentsHookState);
  useProjectTasksMock.mockImplementation(() => projectTasksHookState);
  useTaskMock.mockReturnValue({ data: null, loaded: true, error: null });
  vi.mocked(api.projects.list).mockResolvedValue([]);
  vi.mocked(api.projects.create).mockResolvedValue({
    project: makeProject({ id: 'newproj' }),
    restartRequired: false,
  });
  vi.mocked(api.config.get).mockResolvedValue({
    review: { rounds: 3 },
    server: { port: 0 },
    host: [],
    project: [],
  });
  agentsHookState.data = null;
  agentsHookState.loaded = false;
  agentsHookState.error = null;
  projectTasksHookState.data = [];
  projectTasksHookState.loaded = true;
  projectTasksHookState.error = null;
  localStorage.clear();
});

describe('Dashboard layout', () => {
  it('exposes a level-1 "Dashboard" heading to screen readers even though no visible title is shown', async () => {
    seed([]);
    renderDashboard();

    const h1 = await screen.findByRole('heading', { level: 1, name: 'Dashboard' });
    // visually-hidden contract: jsdom cannot evaluate the utility, so the class itself is the guard
    expect(h1.className.split(/\s+/)).toContain('sr-only');
  });

  it.each([
    ['a single team stacks full width', [TEAM], false],
    ['two teams share a two-column grid on wide screens', [TEAM, SECOND_TEAM], true],
  ] as const)('%s', async (_name, teams, twoColumns) => {
    seed([demoProject(teams.map(team => [...team]))]);
    renderDashboard();

    const teamRegions = await screen.findAllByRole('group');
    expect(teamRegions).toHaveLength(teams.length);
    const teamWrapper = teamRegions[0].parentElement!;
    // layout contract (jsdom computes no media queries): the grid needs its base class and both column steps
    const tokens = teamWrapper.className.split(/\s+/);
    for (const cls of ['grid', 'grid-cols-1', 'xl:grid-cols-2']) {
      expect(tokens.includes(cls), cls).toBe(twoColumns);
    }
  });

  it('project header row exposes two narrow click targets (project id + Details) and the repo path is not a link, to avoid mis-taps', async () => {
    seed([demoProject()]);
    renderDashboard();

    const heading = await screen.findByRole('heading', { level: 2, name: 'demo' });
    const idLink = within(heading).getByRole('link', { name: 'demo' });
    expect(idLink.getAttribute('href')).toBe('/project/demo');

    const detailsLink = screen.getByRole('link', { name: enUS.dashboard.detailsAriaLabel('demo') });
    expect(detailsLink.getAttribute('href')).toBe('/project/demo');
    expect(detailsLink.getAttribute('aria-label')).toMatch(/demo/);

    const row = heading.parentElement!;
    expect(within(row).getByText('/tmp/demo').closest('a')).toBeNull();
  });

  it('multi-project Dashboard gives each Details link a unique accessible name so SR/voice-control users can distinguish destinations', async () => {
    seed([
      makeProject({ id: 'alpha', repo: '/tmp/alpha' }),
      makeProject({ id: 'beta', repo: '/tmp/beta' }),
    ]);
    renderDashboard();

    const alphaDetails = await screen.findByRole('link', { name: enUS.dashboard.detailsAriaLabel('alpha') });
    const betaDetails = screen.getByRole('link', { name: enUS.dashboard.detailsAriaLabel('beta') });
    expect(alphaDetails.getAttribute('href')).toBe('/project/alpha');
    expect(betaDetails.getAttribute('href')).toBe('/project/beta');
    expect(alphaDetails).not.toBe(betaDetails);
  });

  it('hides the repo path on narrow viewports (mobile) — uses hidden sm:inline-block so 640px+ shows it', async () => {
    seed([makeProject({ id: 'demo', repo: '/tmp/demo-repo' })]);
    renderDashboard();

    const repoSpan = await screen.findByText('/tmp/demo-repo');
    expect(repoSpan.className).toContain('hidden');
    expect(repoSpan.className).toContain('sm:inline-block');
  });

  it('exposes the full project id and repo path as hover titles so a truncated row stays readable', async () => {
    seed([
      makeProject({ id: 'very-long-project-id', repo: '/some/very/long/repo/path/that/should/not/wrap' }),
    ]);
    renderDashboard();

    const heading = await screen.findByRole('heading', { level: 2, name: 'very-long-project-id' });
    expect(heading.getAttribute('title')).toBe('very-long-project-id');

    const repoSpan = screen.getByText('/some/very/long/repo/path/that/should/not/wrap');
    expect(repoSpan.getAttribute('title')).toBe('/some/very/long/repo/path/that/should/not/wrap');
    // jsdom does no text layout: the truncate token is the only guard that long values keep the row one line
    for (const el of [heading, repoSpan]) expect(el.className.split(/\s+/)).toContain('truncate');
  });

  it('renders "+ New task" in the topbar and demotes "New project" into the right-edge "More actions" kebab menu', async () => {
    seed([demoProject()]);
    renderDashboard();

    await screen.findByRole('heading', { level: 2, name: 'demo' });
    const taskBtn = screen.getByRole('button', { name: enUS.dashboard.newTask });
    expect(topbarActions().contains(taskBtn)).toBe(true);

    expect(screen.queryByRole('button', { name: enUS.dashboard.newProject })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: enUS.dashboard.newProject })).toBeNull();

    const moreTrigger = screen.getByRole('button', { name: enUS.dashboard.moreActions });
    expect(moreTrigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(moreTrigger.getAttribute('aria-expanded')).toBe('false');

    const toolbar = taskBtn.parentElement!;
    const triggerWrapper = moreTrigger.parentElement!;
    expect(toolbar).toBe(topbarActions());
    expect(
      toolbar.compareDocumentPosition(triggerWrapper) & Node.DOCUMENT_POSITION_CONTAINED_BY,
    ).toBeTruthy();
    expect(toolbar.lastElementChild).toBe(triggerWrapper);
  });

  it('keeps the disabled Dashboard "+ New task" action in the topbar, explained by a hint, when there is no project yet', async () => {
    seed([]);
    renderDashboard();

    const taskBtn = await within(topbarActions()).findByRole('button', { name: enUS.dashboard.newTask }) as HTMLButtonElement;
    expect(taskBtn.disabled).toBe(true);
    expect(taskBtn.getAttribute('title')).toBeNull();
    expect(taskBtn.parentElement?.getAttribute('title')).toBe(enUS.dashboard.createProjectFirst);
    // jsdom cannot tell sr-only text from visible text: keep the token so the hint never renders twice
    const hint = within(topbarActions()).getByText(enUS.dashboard.createProjectFirst);
    expect(hint.className.split(/\s+/)).toContain('sr-only');
  });

  it('only sets aria-controls on the More actions kebab while its menu is open', async () => {
    seed([demoProject()]);
    renderDashboard();

    const moreTrigger = await findMoreActions();
    expect(moreTrigger.getAttribute('aria-controls')).toBeNull();

    fireEvent.click(moreTrigger);
    const menu = screen.getByRole('menu');
    expect(menu.id).toBeTruthy();
    expect(moreTrigger.getAttribute('aria-controls')).toBe(menu.id);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(moreTrigger.getAttribute('aria-controls')).toBeNull();
  });

  it('opens the kebab menu on click and exposes a "New project" menuitem that opens the CreateProject modal', async () => {
    seed([demoProject()]);
    renderDashboard();

    const moreTrigger = await findMoreActions();
    fireEvent.click(moreTrigger);

    expect(moreTrigger.getAttribute('aria-expanded')).toBe('true');
    const createProjectItem = screen.getByRole('menuitem', { name: enUS.dashboard.newProject });
    fireEvent.click(createProjectItem);

    expect(screen.queryByRole('menuitem', { name: enUS.dashboard.newProject })).toBeNull();
    expect(screen.getByRole('dialog', { name: enUS.createProject.title })).toBeTruthy();
  });

  it('kebab menuitem opens without stealing focus', async () => {
    seed([demoProject()]);
    renderDashboard();

    fireEvent.click(await findMoreActions());

    const item = screen.getByRole('menuitem', { name: enUS.dashboard.newProject });
    expect(document.activeElement).not.toBe(item);
  });

  it('closes the kebab menu when Escape is pressed or an outside click happens', async () => {
    seed([demoProject()]);
    renderDashboard();

    const moreTrigger = await findMoreActions();
    fireEvent.click(moreTrigger);
    expect(screen.getByRole('menuitem', { name: enUS.dashboard.newProject })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menuitem', { name: enUS.dashboard.newProject })).toBeNull();
    expect(document.activeElement).toBe(moreTrigger);

    fireEvent.click(moreTrigger);
    expect(screen.getByRole('menuitem', { name: enUS.dashboard.newProject })).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menuitem', { name: enUS.dashboard.newProject })).toBeNull();
  });

  it('exposes a "Settings" menuitem that opens the SystemSettingsModal', async () => {
    seed([demoProject()]);
    renderDashboard();

    fireEvent.click(await findMoreActions());
    fireEvent.click(screen.getByRole('menuitem', { name: enUS.settings.entry }));

    expect(screen.queryByRole('menuitem', { name: enUS.settings.entry })).toBeNull();
    expect(screen.getByRole('dialog', { name: enUS.settings.title })).toBeTruthy();
  });

  it('surfaces a per-project task-feed error so a broken realtime+REST feed is not silently empty', async () => {
    seed([demoProject()]);
    projectTasksHookState.data = null;
    projectTasksHookState.error = { code: 'connection_failed', message: 'realtime down' };

    renderDashboard();

    expect(await screen.findByText(enUS.dashboard.tasksLoadFailed('realtime down'))).toBeTruthy();
  });

  it('agent cards render the embedded terminal up front (no need to wait for the agent to start working)', async () => {
    seed(
      [demoProject([[...TEAM]])],
      [
        { id: 'dev-1', projectId: 'demo', runtimeStatus: 'idle', tmuxSessionStatus: 'present', stale: false },
        { id: 'qa-1', projectId: 'demo', runtimeStatus: 'idle', tmuxSessionStatus: 'present', stale: false },
      ],
    );

    renderDashboard();

    expect(await screen.findAllByTestId('pane-terminal')).toHaveLength(2);
  });
});

describe('Dashboard "Project created" follow-up modal', () => {
  async function reachContinueDialog(): Promise<HTMLElement> {
    seed([demoProject()]);
    renderDashboard();

    fireEvent.click(await findMoreActions());
    fireEvent.click(screen.getByRole('menuitem', { name: enUS.dashboard.newProject }));

    const createDialog = screen.getByRole('dialog', { name: enUS.createProject.title });
    fireEvent.change(within(createDialog).getByLabelText(enUS.createProject.idLabel), { target: { value: 'newproj' } });
    fireEvent.change(within(createDialog).getByLabelText(enUS.createProject.repoLabel), { target: { value: 'https://github.com/o/r.git' } });
    await act(async () => {
      fireEvent.click(within(createDialog).getByRole('button', { name: enUS.common.create }));
    });

    return screen.findByRole('dialog', { name: enUS.dashboard.projectCreatedTitle });
  }

  it('offers both follow-ups and "Continue adding an Agent Team" enters the add-agent flow for the new project', async () => {
    const dialog = await reachContinueDialog();

    expect(within(dialog).getByRole('button', { name: enUS.dashboard.later })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: enUS.dashboard.continueAddingAgent }));
    expect(screen.getByRole('dialog', { name: enUS.projectPage.addAgent }).textContent).toContain('newproj');
  });

  it('"Later" closes the follow-up modal without entering the add-agent flow', async () => {
    const dialog = await reachContinueDialog();

    fireEvent.click(within(dialog).getByRole('button', { name: enUS.dashboard.later }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: enUS.dashboard.projectCreatedTitle })).toBeNull());
    expect(screen.queryByRole('dialog', { name: enUS.projectPage.addAgent })).toBeNull();
  });
});
