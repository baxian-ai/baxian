import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import type { ProjectConfig, TaskState } from '../../src/shared/index.js';

const { useTaskMock, useAgentsMock, useProjectsMock } = vi.hoisted(() => ({
  useTaskMock: vi.fn(),
  useAgentsMock: vi.fn(),
  useProjectsMock: vi.fn(),
}));

vi.mock('../../src/hooks/use-events.ts', () => ({
  useTask: useTaskMock,
  useAgents: useAgentsMock,
}));
vi.mock('../../src/hooks/use-projects.ts', () => ({
  useProjects: useProjectsMock,
}));

vi.mock('../../src/components/toast.tsx', () => ({
  useToast: () => ({ show: vi.fn() }),
}));

vi.mock('../../src/components/agent-card.tsx', () => ({
  AgentCard: (props: {
    role: string;
    runtime?: string;
    terminalMode?: string;
    showTaskBinding?: boolean;
    agent: { id: string };
  }) => (
    <div
      data-testid="agent-card"
      data-role={props.role}
      data-agent-id={props.agent?.id}
      data-runtime={props.runtime}
      data-terminal-mode={props.terminalMode}
      data-show-task-binding={String(props.showTaskBinding)}
    />
  ),
}));

vi.mock('../../src/components/review-conversation.tsx', () => ({
  ReviewConversation: ({ task }: { task: TaskState }) => (
    <div data-testid="review-conversation" data-task={task.id} />
  ),
}));
vi.mock('../../src/components/create-task-modal.tsx', () => ({
  CreateTaskModal: ({ open }: { open: boolean }) => (open ? <div data-testid="edit-modal" /> : null),
}));

const tasksRetryMock = vi.fn();
const tasksUpdateMock = vi.fn();
const tasksReviewMock = vi.fn();
const tasksCompleteMock = vi.fn();
const tasksContinueMock = vi.fn();
const tasksReviewsMock = vi.fn();
vi.mock('../../src/api.ts', () => ({
  api: {
    tasks: {
      retry: (...args: unknown[]) => tasksRetryMock(...args),
      update: (...args: unknown[]) => tasksUpdateMock(...args),
      review: (...args: unknown[]) => tasksReviewMock(...args),
      complete: (...args: unknown[]) => tasksCompleteMock(...args),
      continue: (...args: unknown[]) => tasksContinueMock(...args),
      reviews: (...args: unknown[]) => tasksReviewsMock(...args),
    },
  },
}));

import { TaskDetail } from '../../src/pages/task-detail.tsx';

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'task-010',
    projectId: 'baxian',
    title: 'Clean tests',
    description: 'Task body here',
    preferredAgentId: 'bx-dev',
    agentId: 'bx-dev',
    qaAgentId: 'bx-qa',
    prNumber: 55,
    prUrl: 'https://github.com/baxian-ai/baxian/pull/55',
    branch: 'bx/task-010',
    reviewRound: 1,
    status: 'approved',
    createdAt: '2026-05-10T12:00:00.000Z',
    updatedAt: '2026-05-10T13:00:00.000Z',
    ...overrides,
  };
}

const PROJECT: ProjectConfig = {
  id: 'baxian',
  repo: 'baxian-ai/baxian',
  merge: null,
  agent: [[
    { id: 'bx-dev', runtime: 'claude-code', role: 'dev', mode: 'local' },
    { id: 'bx-qa', runtime: 'codex', role: 'qa', mode: 'local' },
  ]],
};

function setTask(task: TaskState | null, opts: { loaded?: boolean; error?: { code: string; message: string } | null } = {}): void {
  useTaskMock.mockReturnValue({ data: task, loaded: opts.loaded ?? true, error: opts.error ?? null });
}

function setTasks(map: Record<string, TaskState>): void {
  useTaskMock.mockImplementation((id: string) => ({ data: map[id] ?? null, loaded: true, error: null }));
}

function setProjects(projects: ProjectConfig[] | null): void {
  useProjectsMock.mockReturnValue({ projects, error: null, refresh: vi.fn() });
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function GoTo({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(to)}>goto</button>;
}

function renderPage(taskId = 'task-010', opts: { entries?: string[]; index?: number; extra?: ReactNode } = {}) {
  return render(
    <MemoryRouter initialEntries={opts.entries ?? [`/project/baxian/task/${taskId}`]} initialIndex={opts.index}>
      {opts.extra}
      <Routes>
        <Route path="/project/:id/task/:taskId" element={<TaskDetail />} />
        <Route path="*" element={null} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

function open(overrides: Partial<TaskState> = {}) {
  setTask(makeTask(overrides));
  return renderPage();
}

beforeEach(() => {
  cleanup();
  useTaskMock.mockReset();
  useAgentsMock.mockReset();
  useAgentsMock.mockReturnValue({
    data: [
      { id: 'bx-dev', projectId: 'baxian', runtimeStatus: 'idle', tmuxSessionStatus: 'present', stale: false },
      { id: 'bx-qa', projectId: 'baxian', runtimeStatus: 'idle', tmuxSessionStatus: 'present', stale: false },
    ],
    loaded: true,
    error: null,
  });
  useProjectsMock.mockReset();
  setProjects([PROJECT]);
  tasksRetryMock.mockReset();
  tasksUpdateMock.mockReset();
  tasksReviewMock.mockReset();
  tasksCompleteMock.mockReset();
  tasksContinueMock.mockReset();
  tasksReviewsMock.mockReset();
  tasksReviewsMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TaskDetail page — header & info', () => {
  it('renders the task id + title at the top and the full modal-equivalent body', () => {
    const { container } = open({ title: 'Clean tests' });

    const heading = container.querySelector('h1')!;
    expect(within(heading).getByText('task-010').className).toContain('text-og-400');
    expect(within(heading).getByText('Clean tests')).toBeTruthy();

    expect(within(container.querySelector('section')!).getByText('approved').className).toContain('pill');
    expect(container.textContent).toContain('Created at 2026-05-10 20:00, Updated at 2026-05-10 21:00');
    expect(container.textContent).toContain('Task body here');
    expect(container.textContent).toContain('Round 1');
    expect(container.textContent).toContain('Spec 0');
    expect(container.textContent).toContain('Branch:');
    expect(screen.getByTestId('review-conversation').getAttribute('data-task')).toBe('task-010');
  });

  it('shows bold Round/Spec counts beside the status pill', () => {
    const { container } = open({ reviewRound: 3, specReviewRound: 2 });
    const status = within(container.querySelector('section')!).getByText('approved').parentElement!;
    expect(within(status).getByText('3').className).toContain('font-semibold');
    expect(within(status).getByText('2').className).toContain('font-semibold');
  });

  it('keeps status and review round text at body size', () => {
    const { container } = open({ status: 'max_rounds', reviewRound: 10, specReviewRound: 0 });
    const section = container.querySelector('section')!;
    const row = within(section).getByText('max_rounds').parentElement!;

    expect(within(row).getByText('max_rounds').className).toContain('text-sm');
    expect(within(row).getByText('Round').className).toContain('text-sm');
    expect(within(row).getByText('Spec').className).toContain('text-sm');
  });

  it('shows only PR and Branch in the info card, with a branch hyperlink, dropping project/agent rows', () => {
    const { container } = open();
    const section = container.querySelector('section')!;
    expect(within(section).getByRole('link', { name: '#55' }).getAttribute('href'))
      .toBe('https://github.com/baxian-ai/baxian/pull/55');
    expect(within(section).getByRole('link', { name: 'bx/task-010' }).getAttribute('href'))
      .toBe('https://github.com/baxian-ai/baxian/tree/bx/task-010');
    expect(section.textContent).not.toContain('Project:');
    expect(section.textContent).not.toContain('Dev:');
    expect(section.textContent).not.toContain('QA:');
  });

  it('renders timestamps at minute precision and tolerates empty values', () => {
    open({ createdAt: '2026-05-10T12:00:00.000Z', updatedAt: null as unknown as string });
    expect(screen.getByText('Created at 2026-05-10 20:00, Updated at')).toBeTruthy();
  });

  it('places the action buttons on their own row below the status capsule, not in the title', () => {
    const { container } = open({ status: 'pending' });
    const section = container.querySelector('section')!;
    const actionsRow = screen.getByRole('button', { name: 'Edit' }).parentElement!;
    expect(container.querySelector('h1')!.contains(actionsRow)).toBe(false);
    expect(section.contains(actionsRow)).toBe(true);
    const capsuleRow = within(section).getByText('pending').parentElement!;
    expect(capsuleRow.compareDocumentPosition(actionsRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  const QA_BANNER = 'QA approved · verifying feedback';
  const MERGE_BANNER = '✅ PR ready · 等待人工确认';
  it.each([
    { status: 'approved', shown: QA_BANNER, hidden: MERGE_BANNER },
    { status: 'merge-ready', shown: MERGE_BANNER, hidden: QA_BANNER },
  ])('shows the $status banner with a working PR link', ({ status, shown, hidden }) => {
    open({ status: status as TaskState['status'] });
    expect(screen.getByText(shown)).toBeTruthy();
    expect(screen.queryByText(hidden)).toBeNull();
    expect(screen.getByRole('link', { name: 'Open PR #55' }).getAttribute('href'))
      .toBe('https://github.com/baxian-ai/baxian/pull/55');
  });
});

describe('TaskDetail page — layout & agent cards', () => {
  it('splits info and agents into two equal columns aligned to the top', () => {
    const { container } = open();
    const grid = container.querySelector('.lg\\:grid-cols-2')!;
    expect(grid).toBeTruthy();
    // items-start keeps agent cards at their natural height (no bottom blank at narrow widths)
    expect(grid.className).toContain('items-start');
    expect(grid.querySelector('section')).toBeTruthy();
    expect(grid.querySelector('aside')).toBeTruthy();
    expect(container.querySelector('.lg\\:grid-cols-3')).toBeNull();
  });

  it('renders the dev card above the qa card, styled like dashboard/project cards', () => {
    const { container } = open();
    const cards = Array.from(container.querySelector('aside')!.querySelectorAll('[data-testid="agent-card"]'));
    expect(cards).toHaveLength(2);
    expect(cards[0].getAttribute('data-role')).toBe('dev');
    expect(cards[0].getAttribute('data-agent-id')).toBe('bx-dev');
    expect(cards[0].getAttribute('data-runtime')).toBe('claude-code');
    expect(cards[1].getAttribute('data-role')).toBe('qa');
    expect(cards[1].getAttribute('data-agent-id')).toBe('bx-qa');
    expect(cards[1].getAttribute('data-runtime')).toBe('codex');
    for (const card of cards) {
      expect(card.getAttribute('data-terminal-mode')).toBe('embedded-full');
      expect(card.getAttribute('data-show-task-binding')).toBe('false');
    }
  });

  it('resolves the dev/qa pair from the project group even before agentId is assigned', () => {
    setTask(makeTask({ status: 'pending', agentId: '', qaAgentId: undefined, preferredAgentId: 'bx-dev' }));
    const { container } = renderPage();
    const cards = Array.from(container.querySelector('aside')!.querySelectorAll('[data-testid="agent-card"]'));
    expect(cards.map((c) => c.getAttribute('data-agent-id'))).toEqual(['bx-dev', 'bx-qa']);
  });

  it('shows a placeholder when projects are still loading', () => {
    setProjects(null);
    open();
    expect(screen.getByText('加载中…')).toBeTruthy();
    expect(screen.queryByTestId('agent-card')).toBeNull();
  });

  it('shows a placeholder for a legacy task with no resolvable agent group', () => {
    setTask(makeTask({ agentId: '', preferredAgentId: '', qaAgentId: undefined }));
    renderPage();
    expect(screen.getByText('暂无关联 Agent')).toBeTruthy();
    expect(screen.queryByTestId('agent-card')).toBeNull();
  });
});

describe('TaskDetail page — actions & states', () => {
  it('Loading / not-found / error states', () => {
    setTask(null, { loaded: false });
    const { unmount } = renderPage();
    expect(screen.getByText('Loading…')).toBeTruthy();
    unmount();

    setTask(null, { loaded: true });
    const r2 = renderPage();
    expect(screen.getByText('Task not found: task-010')).toBeTruthy();
    r2.unmount();

    setTask(null, { loaded: true, error: { code: 'x', message: 'boom' } });
    renderPage();
    expect(screen.getByText('Error: boom')).toBeTruthy();
  });

  it('the back button navigates to the previous history entry', () => {
    setTask(makeTask());
    renderPage('task-010', { entries: ['/elsewhere', '/project/baxian/task/task-010'], index: 1 });
    fireEvent.click(screen.getByRole('button', { name: '← 返回' }));
    expect(screen.getByTestId('loc').textContent).toBe('/elsewhere');
  });

  it('Edit opens the edit modal overlay', () => {
    open({ status: 'pending' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByTestId('edit-modal')).toBeTruthy();
  });

  it('Retry creates a fresh task and navigates to its detail page', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    setTasks({
      'task-010': makeTask({ id: 'task-010', status: 'merged' }),
      'task-011': makeTask({ id: 'task-011', status: 'pending' }),
    });
    tasksRetryMock.mockResolvedValue(makeTask({ id: 'task-011', projectId: 'baxian', status: 'pending' }));
    renderPage('task-010');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    expect(tasksRetryMock).toHaveBeenCalledWith('task-010');
    expect(screen.getByTestId('loc').textContent).toBe('/project/baxian/task/task-011');
  });

  it('Cancel confirms and calls the update api', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    tasksUpdateMock.mockResolvedValue(makeTask({ status: 'cancelled' }));
    open({ status: 'in_progress' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(tasksUpdateMock).toHaveBeenCalledWith('task-010', { status: 'cancelled' });
  });

  it('does not leak an optimistic override when switching tasks on the same route', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    // Cancel resolves to a NEWER updatedAt than task-011 — the stale-override guard
    // by updatedAt alone would keep showing task-010 on the new URL; remount must win.
    tasksUpdateMock.mockResolvedValue(
      makeTask({ id: 'task-010', title: 'AAA', status: 'cancelled', updatedAt: '2026-05-12T00:00:00.000Z' }),
    );
    setTasks({
      'task-010': makeTask({ id: 'task-010', title: 'AAA', status: 'in_progress', updatedAt: '2026-05-10T00:00:00.000Z' }),
      'task-011': makeTask({ id: 'task-011', title: 'BBB', status: 'pending', updatedAt: '2026-05-09T00:00:00.000Z' }),
    });
    renderPage('task-010', { extra: <GoTo to="/project/baxian/task/task-011" /> });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(screen.getByText('AAA')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'goto' }));
    });
    expect(screen.getByText('BBB')).toBeTruthy();
    expect(screen.queryByText('AAA')).toBeNull();
  });

  describe('max_rounds actions', () => {
    function openMaxRounds(overrides: Partial<TaskState> = {}) {
      open({ status: 'max_rounds', reviewRound: 10, ...overrides });
    }

    it('code-phase shows 标记完成 / 继续一轮 / Call review and the warning, hides Retry', () => {
      openMaxRounds();
      expect(screen.getByRole('button', { name: '标记完成' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '继续一轮' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Call review' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
      expect(screen.getByText(/已达 review 轮次上限/)).toBeTruthy();
    });

    it.each([
      { button: '继续一轮', mock: tasksContinueMock, resolved: makeTask({ status: 'fixing', reviewRound: 11 }) },
      { button: '标记完成', mock: tasksCompleteMock, resolved: makeTask({ status: 'merged' }) },
    ])('$button confirms and calls its api', async ({ button, mock, resolved }) => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      mock.mockResolvedValue(resolved);
      openMaxRounds();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: button }));
      });
      expect(mock).toHaveBeenCalledWith('task-010');
    });

    it('spec-phase shows Retry, hides the code actions, disables Call review', () => {
      openMaxRounds({ phase: 'spec' });
      expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: '标记完成' })).toBeNull();
      expect((screen.getByRole('button', { name: 'Call review' }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText(/已达 spec review 轮次上限/)).toBeTruthy();
    });
  });
});
