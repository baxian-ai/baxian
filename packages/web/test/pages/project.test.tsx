import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ProjectConfig, AgentSnapshot, TaskState } from '../../src/shared/index.js';
import { __resetProjectsCacheForTests, useProjects } from '../../src/hooks/use-projects.ts';

vi.mock('../../src/components/pane-terminal.tsx', () => ({
  TERMINAL_BG: '#fdfdfd',
  PaneTerminal: () => <div data-testid="pane-terminal" />,
}));

const toastShow = vi.fn();
vi.mock('../../src/components/toast.tsx', () => ({
  useToast: () => ({ show: toastShow }),
}));

vi.mock('../../src/hooks/use-pending-restart.tsx', () => ({
  usePendingRestart: () => ({ flagDirty: vi.fn() }),
}));

let projectPayload: ProjectConfig;
let projectsListPayload: ProjectConfig[];
const projectsGet = vi.fn(async () => projectPayload);
const projectsList = vi.fn(async () => projectsListPayload);
const projectsDelete = vi.fn(async () => ({ removed: 'demo', restartRequired: false }));

vi.mock('../../src/api.ts', () => ({
  UNAUTHORIZED_EVENT: 'baxian:unauthorized',
  api: {
    projects: {
      get: (...args: unknown[]) => projectsGet(...args),
      list: (...args: unknown[]) => projectsList(...args),
      delete: (...args: unknown[]) => projectsDelete(...args),
    },
    tasks: {
      page: vi.fn(async () => ({ tasks: [], hasMore: false, nextOffset: 0 })),
    },
  },
}));

const agentsHookState = {
  data: [] as AgentSnapshot[] | null,
  loaded: true,
  error: null as { message: string } | null,
};

const projectTasksState = {
  data: [] as TaskState[] | null,
  error: null as { message: string } | null,
};

vi.mock('../../src/hooks/use-events.ts', () => ({
  useAgents: () => agentsHookState,
  useProjectTasks: () => projectTasksState,
  // 真实 task-detail-modal（经 importOriginal 透传）顶层导入 useTask，mock 需保持完整。
  useTask: () => ({ data: null, loaded: true, error: null }),
}));

vi.mock('../../src/components/create-task-modal.tsx', () => ({
  CreateTaskModal: ({ open }: { open: boolean }) => (open ? <div data-testid="create-task-modal" /> : null),
}));

vi.mock('../../src/components/create-agent-modal.tsx', () => ({
  CreateAgentModal: ({ open }: { open: boolean }) => (open ? <div data-testid="create-agent-modal" /> : null),
}));

const openTaskMock = vi.fn();
vi.mock('../../src/components/task-detail-modal.tsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/components/task-detail-modal.tsx')>();
  return { ...actual, useTaskDetail: () => ({ openTask: openTaskMock }) };
});

import { Project } from '../../src/pages/project.tsx';

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname}</div>;
}

function renderProjectPage() {
  return render(
    <MemoryRouter initialEntries={['/project/demo']}>
      <Routes>
        <Route path="/project/:id" element={<Project />} />
        <Route path="/" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function openProjectMenu(): Promise<void> {
  fireEvent.click(await waitFor(() => screen.getByRole('button', { name: /项目 demo 操作菜单/ })));
}

async function openDeleteDialog(): Promise<HTMLElement> {
  await openProjectMenu();
  fireEvent.click(await waitFor(() => screen.getByRole('menuitem', { name: '删除项目…' })));
  return waitFor(() => screen.getByRole('dialog', { name: '删除项目' }));
}

beforeEach(() => {
  cleanup();
  __resetProjectsCacheForTests();
  toastShow.mockClear();
  projectsGet.mockClear();
  projectsList.mockClear();
  projectsDelete.mockClear();
  projectPayload = {
    id: 'demo',
    repo: '/tmp/demo-repo',
    agent: [],
  } as ProjectConfig;
  projectsListPayload = [];
  agentsHookState.data = [];
  agentsHookState.loaded = true;
  agentsHookState.error = null;
  projectTasksState.data = [];
  projectTasksState.error = null;
  openTaskMock.mockClear();
});

describe('Project page header', () => {
  it('lists the project id and repo with compact header styling', async () => {
    renderProjectPage();

    const heading = await waitFor(() => screen.getByRole('heading', { level: 1, name: 'demo' }));
    expect(heading.className).toContain('text-[17px]');
    expect(heading.className).toContain('font-display');
    expect(heading.className).toContain('font-semibold');

    const repo = screen.getByText('/tmp/demo-repo');
    expect(repo.className).toContain('font-mono');
    expect(repo.className).toContain('text-[12px]');
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
  it('exposes a top-level "新建 Task" button that opens the create-task modal', async () => {
    renderProjectPage();
    await waitFor(() => screen.getByRole('heading', { level: 1, name: 'demo' }));

    expect(screen.queryByTestId('create-task-modal')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '+ 新建 Task' }));
    expect(await screen.findByTestId('create-task-modal')).toBeTruthy();
  });

  it('moves "添加 Agent" into the three-dot menu — no top-level add-agent button by default', async () => {
    renderProjectPage();
    await waitFor(() => screen.getByRole('heading', { level: 1, name: 'demo' }));

    expect(screen.queryByRole('button', { name: /添加 Agent/ })).toBeNull();

    await openProjectMenu();
    const item = await screen.findByRole('menuitem', { name: '添加 Agent' });
    expect(item.className).not.toContain('text-danger');

    expect(screen.queryByTestId('create-agent-modal')).toBeNull();
    fireEvent.click(item);
    expect(await screen.findByTestId('create-agent-modal')).toBeTruthy();
  });
});

describe('Project Task panel', () => {
  it('toggles the Task panel from the header and keeps the trigger before the project menu', async () => {
    renderProjectPage();
    const openBtn = await waitFor(() => screen.getByRole('button', { name: '打开 Task 面板' }));
    const menu = screen.getByRole('button', { name: /项目 demo 操作菜单/ });
    expect(screen.queryByRole('complementary', { name: 'Task 面板' })).toBeNull();
    expect(openBtn.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(openBtn);

    const panel = await waitFor(() => screen.getByRole('complementary', { name: 'Task 面板' }));
    expect(panel).toBeTruthy();
    expect(screen.queryByRole('button', { name: '打开 Task 面板' })).toBeNull();

    fireEvent.click(within(panel).getByRole('button', { name: '关闭 Task 面板' }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Task 面板' })).toBeNull());
    expect(screen.getByRole('button', { name: '打开 Task 面板' })).toBeTruthy();
  });

  it('persists and restores the Task panel open state', async () => {
    renderProjectPage();
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: '打开 Task 面板' })));
    await waitFor(() => expect(localStorage.getItem('baxian.taskPanel.open')).toBe('1'));

    cleanup();
    renderProjectPage();
    expect(await waitFor(() => screen.getByRole('complementary', { name: 'Task 面板' }))).toBeTruthy();
    expect(screen.queryByRole('button', { name: '打开 Task 面板' })).toBeNull();

    const panel = screen.getByRole('complementary', { name: 'Task 面板' });
    fireEvent.click(within(panel).getByRole('button', { name: '关闭 Task 面板' }));
    await waitFor(() => expect(localStorage.getItem('baxian.taskPanel.open')).toBe('0'));
  });
});

describe('Project delete entry', () => {
  it('keeps delete inside the project menu and marks it destructive', async () => {
    renderProjectPage();
    const menuButton = await waitFor(() => screen.getByRole('button', { name: /项目 demo 操作菜单/ }));

    expect(screen.queryByRole('menuitem')).toBeNull();
    expect(screen.queryByText('删除项目…')).toBeNull();
    fireEvent.click(menuButton);

    const item = await waitFor(() => screen.getByRole('menuitem', { name: '删除项目…' }));
    expect(item.className).toContain('text-danger');
    expect(item.hasAttribute('disabled')).toBe(false);
  });

  it('disables the delete menuitem (with hint) when the project still has agents', async () => {
    projectPayload = {
      id: 'demo',
      repo: '/tmp/demo-repo',
      agent: [[{ id: 'demo-dev' } as never]],
    } as ProjectConfig;
    renderProjectPage();

    await openProjectMenu();
    const item = await waitFor(() => screen.getByRole('menuitem', { name: '删除项目…' }));
    expect((item as HTMLButtonElement).disabled).toBe(true);
    expect(item.getAttribute('title')).toMatch(/请先删除项目下的 1 个 Agent/);
  });

  it('validates exact project id before delete and resets confirmation on cancel', async () => {
    renderProjectPage();
    const dialog = await openDeleteDialog();
    const confirm = within(dialog).getByRole('button', { name: '确认删除' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    const input = within(dialog).getByLabelText('输入项目 ID 以确认删除') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'wrong' } });
    expect(confirm.disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'demo' } });
    expect(confirm.disabled).toBe(false);

    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '删除项目' })).toBeNull());

    const reopened = await openDeleteDialog();
    const reopenedInput = within(reopened).getByLabelText('输入项目 ID 以确认删除') as HTMLInputElement;
    expect(reopenedInput.value).toBe('');
  });

  it('confirming delete calls the API, refreshes cache, shows success, and navigates home', async () => {
    projectsListPayload = [{ id: 'demo', repo: '/tmp/demo-repo', agent: [] } as ProjectConfig];
    function ProjectIdsProbe() {
      const { projects } = useProjects();
      return <div data-testid="cached-ids">{(projects ?? []).map(p => p.id).join(',')}</div>;
    }
    render(
      <MemoryRouter initialEntries={['/project/demo']}>
        <Routes>
          <Route path="/project/:id" element={<Project />} />
          <Route path="/" element={<><LocationProbe /><ProjectIdsProbe /></>} />
        </Routes>
      </MemoryRouter>,
    );

    const dialog = await openDeleteDialog();
    fireEvent.change(within(dialog).getByLabelText('输入项目 ID 以确认删除'), {
      target: { value: 'demo' },
    });
    projectsListPayload = [];
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(projectsDelete).toHaveBeenCalledWith('demo'));
    await waitFor(() => expect(projectsList).toHaveBeenCalled());
    await waitFor(() => expect(toastShow).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'success', title: expect.stringContaining('已删除') }),
    ));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/'));
    expect(screen.getByTestId('cached-ids').textContent).toBe('');
  });

  it('surfaces server error in the modal and keeps the user on the project page', async () => {
    projectsDelete.mockRejectedValueOnce(new Error('boom — config locked'));
    renderProjectPage();
    const dialog = await openDeleteDialog();
    fireEvent.change(within(dialog).getByLabelText('输入项目 ID 以确认删除'), {
      target: { value: 'demo' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(within(dialog).getByText(/boom — config locked/)).toBeTruthy());
    expect(screen.queryByTestId('location')).toBeNull();
    expect(toastShow).not.toHaveBeenCalled();
  });
});
