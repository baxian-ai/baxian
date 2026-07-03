import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup, screen, within, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ProjectConfig, AgentSnapshot, TaskState } from '../../src/shared/index.js';

vi.mock('../../src/components/pane-terminal.tsx', async () => (await import('../helpers/pane-terminal-mock.tsx')).createPaneTerminalMock());

vi.mock('../../src/components/toast.tsx', async () => (await import('../helpers/toast-mock.tsx')).createToastMock());

vi.mock('../../src/hooks/use-pending-restart.tsx', async () => (await import('../helpers/pending-restart-mock.tsx')).createPendingRestartMock());

vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());

vi.mock('../../src/components/create-agent-modal.tsx', () => ({
  CreateAgentModal: ({ open, projectId }: { open: boolean; projectId: string }) =>
    open ? <div data-testid="agent-modal">agent:{projectId}</div> : null,
}));

const projectsHookState = {
  projects: null as ProjectConfig[] | null,
  error: null as string | null,
};
vi.mock('../../src/hooks/use-projects.ts', () => ({
  useProjects: () => ({
    projects: projectsHookState.projects,
    error: projectsHookState.error,
    refresh: vi.fn(),
  }),
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
import { Dashboard } from '../../src/pages/dashboard.tsx';
import { TOPBAR_ACTIONS_ID } from '../../src/components/topbar-actions.tsx';

function seed(projects: ProjectConfig[], agents: AgentSnapshot[] = []): void {
  projectsHookState.projects = projects;
  agentsHookState.data = agents;
  agentsHookState.loaded = true;
}

function renderDashboard() {
  return render(
    <MemoryRouter>
      <div id={TOPBAR_ACTIONS_ID} data-testid="topbar-actions" />
      <Dashboard />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cleanup();
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
  projectsHookState.projects = null;
  projectsHookState.error = null;
  agentsHookState.data = null;
  agentsHookState.loaded = false;
  agentsHookState.error = null;
  projectTasksHookState.data = [];
  projectTasksHookState.loaded = true;
  projectTasksHookState.error = null;
});

describe('Dashboard layout', () => {
  it('keeps an sr-only h1 "Dashboard" so screen readers see the page heading even though the visible title is removed', () => {
    seed([]);
    renderDashboard();

    const h1 = screen.getByRole('heading', { level: 1, name: 'Dashboard' });
    expect(h1.className).toContain('sr-only');
  });

  it('renders each project\'s agent groups in a full-width vertical stack (no xl:grid-cols-2 split)', () => {
    seed([
      makeProject({
        id: 'demo',
        repo: '/tmp/demo',
        agent: [
          [
            { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local' },
            { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local' },
          ],
        ],
      }),
    ]);

    const { container } = renderDashboard();

    const groupWrapper = container.querySelector('[role="group"]')?.parentElement;
    expect(groupWrapper).toBeTruthy();
    expect(groupWrapper!.className).toContain('space-y-3');
    expect(groupWrapper!.className).not.toContain('xl:grid-cols-2');
    expect(groupWrapper!.className).not.toContain('grid-cols-1');
  });

  it('project header row exposes two narrow click targets (project id + Details) and the surrounding row is not clickable, to avoid mis-taps', () => {
    seed([makeProject({ id: 'demo', repo: '/tmp/demo' })]);
    renderDashboard();

    const heading = screen.getByRole('heading', { level: 2, name: 'demo' });
    const idLink = within(heading).getByRole('link', { name: 'demo' });
    expect(idLink.getAttribute('href')).toBe('/project/demo');

    const detailsLink = screen.getByRole('link', { name: /Details/ });
    expect(detailsLink.getAttribute('href')).toBe('/project/demo');
    expect(detailsLink.getAttribute('aria-label')).toMatch(/demo/);

    const row = heading.parentElement!;
    expect(row.tagName).toBe('DIV');
    expect(row.className).not.toContain('hover:bg-og-25');
    expect(within(row).getByText('/tmp/demo').closest('a')).toBeNull();
  });

  it('multi-project Dashboard gives each Details link a unique accessible name so SR/voice-control users can distinguish destinations', () => {
    seed([
      makeProject({ id: 'alpha', repo: '/tmp/alpha' }),
      makeProject({ id: 'beta', repo: '/tmp/beta' }),
    ]);
    renderDashboard();

    const alphaDetails = screen.getByRole('link', { name: /Details.*alpha/ });
    const betaDetails = screen.getByRole('link', { name: /Details.*beta/ });
    expect(alphaDetails.getAttribute('href')).toBe('/project/alpha');
    expect(betaDetails.getAttribute('href')).toBe('/project/beta');
    expect(alphaDetails).not.toBe(betaDetails);
  });

  it('hides the repo path on narrow viewports (mobile) — uses hidden sm:inline-block so 640px+ shows it', () => {
    seed([makeProject({ id: 'demo', repo: '/tmp/demo-repo' })]);
    renderDashboard();

    const repoSpan = screen.getByText('/tmp/demo-repo');
    expect(repoSpan.className).toContain('hidden');
    expect(repoSpan.className).toContain('sm:inline-block');
  });

  it('row keeps a single-line layout via truncate + title so a long repo path can not blow up row height', () => {
    seed([
      makeProject({ id: 'very-long-project-id', repo: '/some/very/long/repo/path/that/should/not/wrap' }),
    ]);
    renderDashboard();

    const heading = screen.getByRole('heading', { level: 2, name: 'very-long-project-id' });
    expect(heading.className).toContain('truncate');
    expect(heading.className).not.toContain('break-words');
    expect(heading.getAttribute('title')).toBe('very-long-project-id');

    const repoSpan = screen.getByText('/some/very/long/repo/path/that/should/not/wrap');
    expect(repoSpan.className).toContain('truncate');
    expect(repoSpan.className).not.toContain('break-words');
    expect(repoSpan.getAttribute('title')).toBe('/some/very/long/repo/path/that/should/not/wrap');
  });

  it('multi-group project lays groups out in a 2-column grid at xl so one row holds up to 2 task areas', () => {
    seed([
      makeProject({
        id: 'demo',
        repo: '/tmp/demo',
        agent: [
          [
            { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local' },
            { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local' },
          ],
          [
            { id: 'dev-2', runtime: 'claude-code', role: 'dev', mode: 'local' },
            { id: 'qa-2', runtime: 'codex', role: 'qa', mode: 'local' },
          ],
        ],
      }),
    ]);

    const { container } = renderDashboard();

    const groups = container.querySelectorAll('[role="group"]');
    expect(groups.length).toBe(2);
    const groupWrapper = groups[0].parentElement!;
    expect(groupWrapper.className).toContain('grid');
    expect(groupWrapper.className).toContain('grid-cols-1');
    expect(groupWrapper.className).toContain('xl:grid-cols-2');
    expect(groupWrapper.className).toContain('gap-3');
    expect(groupWrapper.className).not.toContain('space-y-3');
  });

  it('renders "新建 Task" as a low-key text-style button and demotes "新建项目" into the right-edge "更多" kebab menu', () => {
    seed([makeProject({ id: 'demo', repo: '/tmp/demo' })]);
    renderDashboard();

    const topbarActions = screen.getByTestId('topbar-actions');
    const taskBtn = screen.getByRole('button', { name: '+ 新建 Task' });
    expect(taskBtn.className).toContain('btn-ghost');
    expect(taskBtn.className).not.toContain('btn-primary');
    expect(topbarActions.contains(taskBtn)).toBe(true);

    expect(screen.queryByRole('button', { name: '新建项目' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '新建项目' })).toBeNull();

    const moreTrigger = screen.getByRole('button', { name: '更多操作' });
    expect(moreTrigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(moreTrigger.getAttribute('aria-expanded')).toBe('false');

    const toolbar = taskBtn.parentElement!;
    const triggerWrapper = moreTrigger.parentElement!;
    expect(toolbar).toBe(topbarActions);
    expect(
      toolbar.compareDocumentPosition(triggerWrapper) & Node.DOCUMENT_POSITION_CONTAINED_BY,
    ).toBeTruthy();
    expect(toolbar.lastElementChild).toBe(triggerWrapper);
  });

  it('keeps the disabled Dashboard "新建 Task" action in the topbar when there is no project yet', () => {
    seed([]);
    renderDashboard();

    const topbarActions = screen.getByTestId('topbar-actions');
    const taskBtn = within(topbarActions).getByRole('button', { name: '+ 新建 Task' }) as HTMLButtonElement;
    expect(taskBtn.disabled).toBe(true);
    expect(taskBtn.getAttribute('title')).toBeNull();
    expect(taskBtn.parentElement?.getAttribute('title')).toBe('请先创建项目');
    expect(taskBtn.parentElement?.className).toContain('inline-flex');

    const hint = within(topbarActions).getByText('请先创建项目');
    expect(hint.className).toContain('sr-only');
  });

  it('only sets aria-controls on the 更多 kebab while its menu is open', () => {
    seed([makeProject({ id: 'demo', repo: '/tmp/demo' })]);
    renderDashboard();

    const moreTrigger = screen.getByRole('button', { name: '更多操作' });
    expect(moreTrigger.getAttribute('aria-controls')).toBeNull();

    fireEvent.click(moreTrigger);
    const menu = screen.getByRole('menu');
    expect(menu.id).toBeTruthy();
    expect(moreTrigger.getAttribute('aria-controls')).toBe(menu.id);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(moreTrigger.getAttribute('aria-controls')).toBeNull();
  });

  it('opens the kebab menu on click and exposes a "新建项目" menuitem that opens the CreateProject modal', () => {
    seed([makeProject({ id: 'demo', repo: '/tmp/demo' })]);
    renderDashboard();

    const moreTrigger = screen.getByRole('button', { name: '更多操作' });
    fireEvent.click(moreTrigger);

    expect(moreTrigger.getAttribute('aria-expanded')).toBe('true');
    const createProjectItem = screen.getByRole('menuitem', { name: '新建项目' });
    fireEvent.click(createProjectItem);

    expect(screen.queryByRole('menuitem', { name: '新建项目' })).toBeNull();
    expect(screen.getByRole('dialog', { name: /新建项目|Create/ })).toBeTruthy();
  });

  it('kebab menuitem opens neutral (no default bg, no auto-focus) and only changes text color on hover', () => {
    seed([makeProject({ id: 'demo', repo: '/tmp/demo' })]);
    renderDashboard();

    const moreTrigger = screen.getByRole('button', { name: '更多操作' });
    fireEvent.click(moreTrigger);

    const item = screen.getByRole('menuitem', { name: '新建项目' });
    expect(item.textContent).toBe('新建项目');
    expect(item.className).not.toMatch(/(^|\s)bg-/);
    expect(item.className).not.toMatch(/focus:bg-/);
    expect(item.className).not.toMatch(/hover:bg-/);
    expect(item.className).toMatch(/hover:text-/);
    expect(document.activeElement).not.toBe(item);
  });

  it('closes the kebab menu when Escape is pressed or an outside click happens', () => {
    seed([makeProject({ id: 'demo', repo: '/tmp/demo' })]);
    renderDashboard();

    const moreTrigger = screen.getByRole('button', { name: '更多操作' });
    fireEvent.click(moreTrigger);
    expect(screen.getByRole('menuitem', { name: '新建项目' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menuitem', { name: '新建项目' })).toBeNull();
    expect(document.activeElement).toBe(moreTrigger);

    fireEvent.click(moreTrigger);
    expect(screen.getByRole('menuitem', { name: '新建项目' })).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menuitem', { name: '新建项目' })).toBeNull();
  });

  it('surfaces a per-project task-feed error so a broken realtime+REST feed is not silently empty', () => {
    seed([makeProject({ id: 'demo', repo: '/tmp/demo' })]);
    projectTasksHookState.data = null;
    projectTasksHookState.error = { code: 'connection_failed', message: 'realtime down' };

    renderDashboard();

    expect(screen.getByText(/任务列表加载失败：realtime down/)).toBeTruthy();
  });

  it('agent cards render the embedded terminal up front (no need to wait for the agent to start working)', () => {
    seed(
      [
        makeProject({
          id: 'demo',
          repo: '/tmp/demo',
          agent: [
            [
              { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local' },
              { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local' },
            ],
          ],
        }),
      ],
      [
        { id: 'dev-1', projectId: 'demo', runtimeStatus: 'idle', tmuxSessionStatus: 'present', stale: false },
        { id: 'qa-1', projectId: 'demo', runtimeStatus: 'idle', tmuxSessionStatus: 'present', stale: false },
      ],
    );

    const { getAllByTestId } = renderDashboard();

    const terminals = getAllByTestId('pane-terminal');
    expect(terminals.length).toBe(2);
  });
});

describe('Dashboard 项目已创建 follow-up modal', () => {
  async function reachContinueDialog(): Promise<HTMLElement> {
    seed([makeProject({ id: 'demo', repo: '/tmp/demo' })]);
    renderDashboard();

    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '新建项目' }));

    const createDialog = screen.getByRole('dialog', { name: /新建项目/ });
    fireEvent.change(within(createDialog).getByLabelText('项目 ID'), { target: { value: 'newproj' } });
    fireEvent.change(within(createDialog).getByLabelText('Git 仓库地址'), { target: { value: 'https://github.com/o/r.git' } });
    await act(async () => {
      fireEvent.click(within(createDialog).getByRole('button', { name: '创建' }));
    });

    return screen.findByRole('dialog', { name: '项目已创建' });
  }

  it('pins both follow-up buttons in the footer region and "继续添加 Agent" enters the add-agent flow', async () => {
    const dialog = await reachContinueDialog();

    const continueBtn = within(dialog).getByRole('button', { name: '继续添加 Agent' });
    const laterBtn = within(dialog).getByRole('button', { name: '稍后再加' });
    const footer = continueBtn.parentElement!;
    expect(footer.className).toContain('border-t');
    expect(footer.className).toContain('shrink-0');
    expect(laterBtn.parentElement).toBe(footer);

    fireEvent.click(continueBtn);
    expect(screen.getByTestId('agent-modal').textContent).toContain('newproj');
  });

  it('"稍后再加" closes the follow-up modal without entering the add-agent flow', async () => {
    const dialog = await reachContinueDialog();

    fireEvent.click(within(dialog).getByRole('button', { name: '稍后再加' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '项目已创建' })).toBeNull());
    expect(screen.queryByTestId('agent-modal')).toBeNull();
  });
});
