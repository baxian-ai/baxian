import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, fireEvent, act, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import type { ProjectConfig, ReviewRound, TaskState } from '../../src/shared/index.js';

const { useProjectsMock } = vi.hoisted(() => ({
  useProjectsMock: vi.fn(),
}));

vi.mock('../../src/hooks/use-events.ts', async () => (await import('../helpers/events-mock.ts')).createEventsMock());
vi.mock('../../src/hooks/use-projects.ts', () => ({
  useProjects: useProjectsMock,
}));

vi.mock('../../src/components/toast.tsx', async () => (await import('../helpers/toast-mock.tsx')).createToastMock());

vi.mock('../../src/components/agent-card.tsx', () => ({
  AgentCard: (props: {
    role: string;
    runtime?: string;
    terminalMode?: string;
    showTaskBinding?: boolean;
    pendingRestart?: boolean;
    terminalLoading?: boolean;
    active?: boolean;
    onActivate?: () => void;
    agent: { id: string; runtimeStatus?: string };
  }) => (
    <div
      data-testid="agent-card"
      data-role={props.role}
      data-agent-id={props.agent?.id}
      data-runtime={props.runtime}
      data-terminal-mode={props.terminalMode}
      data-show-task-binding={String(props.showTaskBinding)}
      data-runtime-status={props.agent?.runtimeStatus}
      data-pending-restart={String(props.pendingRestart)}
      data-terminal-loading={String(props.terminalLoading)}
      data-active={String(props.active)}
      data-agent-card={props.onActivate ? props.agent?.id : undefined}
      onClick={props.onActivate}
    >
      <input aria-label={`focus ${props.agent?.id}`} />
    </div>
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

vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());

import { api } from '../../src/api.ts';
import { useTaskMock, useAgentsMock } from '../helpers/events-mock.ts';
import { makeTask as makeTaskFixture } from '../helpers/fixtures.ts';
import { toastShowMock } from '../helpers/toast-mock.tsx';
import { TaskDetail } from '../../src/pages/task-detail.tsx';

const tasksRetryMock = vi.mocked(api.tasks.retry);
const tasksUpdateMock = vi.mocked(api.tasks.update);
const tasksReviewMock = vi.mocked(api.tasks.review);
const tasksCompleteMock = vi.mocked(api.tasks.complete);
const tasksContinueMock = vi.mocked(api.tasks.continue);
const tasksReviewsMock = vi.mocked(api.tasks.reviews);

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return makeTaskFixture({
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
  });
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
  toastShowMock.mockReset();
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

  it('shows regular-weight Round/Spec counts beside the status pill', () => {
    const { container } = open({ reviewRound: 3, specReviewRound: 2 });
    const status = within(container.querySelector('section')!).getByText('approved').parentElement!;
    expect(within(status).getByText('3').className).not.toContain('font-semibold');
    expect(within(status).getByText('2').className).not.toContain('font-semibold');
  });

  it('keeps status, review rounds, and timestamps at body size', () => {
    const { container } = open({ status: 'max_rounds', reviewRound: 10, specReviewRound: 0 });
    const section = container.querySelector('section')!;
    const row = within(section).getByText('max_rounds').parentElement!;
    const round = within(row).getByText((_, el) => el?.textContent === 'Round 10');
    const spec = within(row).getByText((_, el) => el?.textContent === 'Spec 0');
    const timestamps = within(section).getByText('Created at 2026-05-10 20:00, Updated at 2026-05-10 21:00');

    expect(within(row).getByText('max_rounds').className).toContain('text-sm');
    expect(round.className).toContain('text-sm');
    expect(spec.className).toContain('text-sm');
    expect(timestamps.className).toContain('text-sm');
    expect(timestamps.className).not.toContain('text-xs');
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

  it('activates one task detail agent card at a time and clears it on outside click', () => {
    const { container } = open();
    const cards = Array.from(container.querySelector('aside')!.querySelectorAll('[data-testid="agent-card"]'));
    const devCard = cards[0] as HTMLElement;
    const qaCard = cards[1] as HTMLElement;

    expect(devCard.getAttribute('data-active')).toBe('false');
    expect(qaCard.getAttribute('data-active')).toBe('false');

    fireEvent.click(devCard);
    expect(devCard.getAttribute('data-active')).toBe('true');
    expect(qaCard.getAttribute('data-active')).toBe('false');

    fireEvent.click(qaCard);
    expect(devCard.getAttribute('data-active')).toBe('false');
    expect(qaCard.getAttribute('data-active')).toBe('true');

    fireEvent.click(document.body);
    expect(devCard.getAttribute('data-active')).toBe('false');
    expect(qaCard.getAttribute('data-active')).toBe('false');
  });

  it('clears the active task detail agent card on Escape', () => {
    const { container } = open();
    const devCard = container.querySelector('[data-testid="agent-card"]') as HTMLElement;

    fireEvent.click(devCard);
    expect(devCard.getAttribute('data-active')).toBe('true');

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(devCard.getAttribute('data-active')).toBe('false');
  });

  it('keeps the active task detail agent card when Escape starts from focus inside the card', () => {
    const { container } = open();
    const devCard = container.querySelector('[data-testid="agent-card"]') as HTMLElement;

    fireEvent.click(devCard);
    expect(devCard.getAttribute('data-active')).toBe('true');
    const focusTarget = within(devCard).getByLabelText('focus bx-dev');
    focusTarget.focus();
    expect(document.activeElement).toBe(focusTarget);

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(devCard.getAttribute('data-active')).toBe('true');
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

describe('TaskDetail page — call review', () => {
  it('confirms with the active-task prompt, dispatches, and reports the new round', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    tasksReviewMock.mockResolvedValue(makeTask({ status: 'review', reviewRound: 2, updatedAt: '2026-05-11T00:00:00.000Z' }));
    open({ status: 'review' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Call review' }));
    });

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('请 QA 重审 task task-010'));
    expect(tasksReviewMock).toHaveBeenCalledWith('task-010');
    expect(toastShowMock).toHaveBeenCalledWith({ kind: 'success', title: '已派 QA 重审 (round 2)' });
  });

  it('warns that re-reviewing a terminal task will not feed back into the state machine', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    open({ status: 'merged' });

    fireEvent.click(screen.getByRole('button', { name: 'Call review' }));

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('已是 merged 状态'));
    expect(tasksReviewMock).not.toHaveBeenCalled();
    expect(toastShowMock).not.toHaveBeenCalled();
  });

  it('shows an error toast when review dispatch fails', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    tasksReviewMock.mockRejectedValue(new Error('qa is busy'));
    open({ status: 'review' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Call review' }));
    });

    expect(toastShowMock).toHaveBeenCalledWith({ kind: 'error', title: 'Review 派发失败', body: 'qa is busy' });
  });
});

describe('TaskDetail page — action failures surface error toasts', () => {
  it('Cancel failure shows 取消失败 and re-enables the button', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    tasksUpdateMock.mockRejectedValue(new Error('cancel nope'));
    open({ status: 'in_progress' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });

    expect(toastShowMock).toHaveBeenCalledWith({ kind: 'error', title: '取消失败', body: 'cancel nope' });
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('Retry on a cancelled task uses the fresh-start prompt and reports failure without navigating', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    tasksRetryMock.mockRejectedValue(new Error('retry nope'));
    open({ status: 'cancelled' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('这会新建一个 task 从头开始'));
    expect(toastShowMock).toHaveBeenCalledWith({ kind: 'error', title: 'Retry 失败', body: 'retry nope' });
    expect(screen.getByTestId('loc').textContent).toBe('/project/baxian/task/task-010');
  });

  it('标记完成 failure shows 标记完成失败', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    tasksCompleteMock.mockRejectedValue(new Error('merge conflict'));
    open({ status: 'max_rounds' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '标记完成' }));
    });

    expect(toastShowMock).toHaveBeenCalledWith({ kind: 'error', title: '标记完成失败', body: 'merge conflict' });
  });

  it('继续一轮 failure shows 继续一轮失败', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    tasksContinueMock.mockRejectedValue(new Error('dev is gone'));
    open({ status: 'max_rounds' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '继续一轮' }));
    });

    expect(toastShowMock).toHaveBeenCalledWith({ kind: 'error', title: '继续一轮失败', body: 'dev is gone' });
  });
});

describe('TaskDetail page — human confirmation gates', () => {
  function makeRounds(): ReviewRound[] {
    return [
      {
        round: 1,
        phase: 'code',
        content: 'round 1 review',
        startedAt: '2026-05-10T12:30:00.000Z',
        findings: {
          round: 1,
          verdict: 'request-changes',
          findings: [
            { id: 'f1', severity: 'major', message: 'bug one' },
            { id: 'f2', severity: 'minor', message: 'nit two' },
          ],
        },
      },
      {
        round: 2,
        phase: 'code',
        content: 'round 2 review',
        startedAt: '2026-05-10T13:30:00.000Z',
        findings: { round: 2, verdict: 'approve', findings: [{ id: 'f3', severity: 'minor', message: 'nit three' }] },
      },
    ];
  }

  it('ready gate renders the banner plus review summary, and 确认 completes the task', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    tasksReviewsMock.mockResolvedValue(makeRounds());
    tasksCompleteMock.mockResolvedValue(makeTask({ status: 'done', updatedAt: '2026-05-11T00:00:00.000Z' }));
    const { container } = open({ status: 'ready' });

    expect(screen.getByText('✅ 评审通过 · 等待人工确认')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open PR #55' })).toBeTruthy();
    await waitFor(() => expect(container.textContent).toContain('Review 2 轮'));
    expect(container.textContent).toContain('最终 verdict approve');
    expect(container.textContent).toContain('findings 共 3 条');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确认' }));
    });

    expect(tasksCompleteMock).toHaveBeenCalledWith('task-010');
    expect(toastShowMock).toHaveBeenCalledWith({ kind: 'success', title: '已确认（done）' });
  });

  it('确认 is skipped when the confirm dialog is cancelled and reports failures', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    open({ status: 'merge-ready' });

    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    expect(tasksCompleteMock).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    tasksCompleteMock.mockRejectedValue(new Error('gate says no'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确认' }));
    });

    expect(toastShowMock).toHaveBeenCalledWith({ kind: 'error', title: '确认失败', body: 'gate says no' });
  });

  it('server-mode approved task offers 重试发布 which re-runs the publish step', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    tasksCompleteMock.mockResolvedValue(
      makeTask({ reviewMode: 'server', status: 'ready', updatedAt: '2026-05-11T00:00:00.000Z' }),
    );
    open({ reviewMode: 'server', status: 'approved' });

    expect(screen.queryByRole('button', { name: '确认' })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重试发布' }));
    });

    expect(tasksCompleteMock).toHaveBeenCalledWith('task-010');
    expect(toastShowMock).toHaveBeenCalledWith({ kind: 'success', title: '已确认（ready）' });
  });
});

describe('TaskDetail page — review verdict watchdog', () => {
  it('flags a review dispatched over 10 minutes ago with the missing-verdict banner', () => {
    open({ status: 'review', reviewDispatchedAt: '2026-05-10T12:00:00.000Z' });

    expect(screen.getByText('Review verdict missing')).toBeTruthy();
    expect(screen.getByText(/超过 10 分钟未提交 verdict/)).toBeTruthy();
  });

  it('keeps the banner hidden for a freshly dispatched review', () => {
    open({ status: 'review', reviewDispatchedAt: new Date().toISOString() });
    expect(screen.queryByText('Review verdict missing')).toBeNull();
  });
});

describe('TaskDetail page — legacy tasks', () => {
  it('pending legacy task explains how to assign a dev', () => {
    setTask(makeTask({ status: 'pending', preferredAgentId: '', agentId: '', qaAgentId: undefined }));
    renderPage();
    expect(screen.getByText(/This task has no dev assigned yet/)).toBeTruthy();
  });

  it('terminal legacy task disables Retry with the legacy tooltip', () => {
    setTask(makeTask({ status: 'cancelled', preferredAgentId: '', agentId: '', qaAgentId: undefined }));
    renderPage();
    const retry = screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.title).toBe('Legacy task has no preferred dev to retry against');
  });
});

describe('TaskDetail page — PR/Branch fallbacks', () => {
  it('renders plain mono PR number and branch when the task has no PR url', () => {
    const { container } = open({ prUrl: undefined });
    const section = container.querySelector('section')!;
    expect(within(section).queryByRole('link', { name: '#55' })).toBeNull();
    expect(within(section).getByText('#55').className).toContain('font-mono');
    expect(within(section).queryByRole('link', { name: 'bx/task-010' })).toBeNull();
    expect(within(section).getByText('bx/task-010').className).toContain('font-mono');
  });

  it('renders dashes when the task has neither PR nor branch', () => {
    const { container } = open({ prNumber: undefined, prUrl: undefined, branch: undefined });
    expect(within(container.querySelector('section')!).getAllByText('—')).toHaveLength(2);
  });
});

describe('TaskDetail page — agent snapshot fallbacks', () => {
  it('feeds a synthetic unknown snapshot and pendingRestart when the loaded agent list lacks the agent', () => {
    useAgentsMock.mockReturnValue({ data: [], loaded: true, error: null });
    const { container } = open();
    const cards = Array.from(container.querySelectorAll('[data-testid="agent-card"]'));
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.getAttribute('data-runtime-status')).toBe('unknown');
      expect(card.getAttribute('data-pending-restart')).toBe('true');
      expect(card.getAttribute('data-terminal-loading')).toBe('false');
    }
  });

  it('marks terminals as loading while the agent stream has not produced snapshots yet', () => {
    useAgentsMock.mockReturnValue({ data: null, loaded: false, error: null });
    const { container } = open();
    const card = container.querySelector('[data-testid="agent-card"]')!;
    expect(card.getAttribute('data-pending-restart')).toBe('false');
    expect(card.getAttribute('data-terminal-loading')).toBe('true');
  });

  it('shows the QA slot placeholder when the group has no QA agent', () => {
    setProjects([{ ...PROJECT, agent: [[PROJECT.agent[0][0]]] }]);
    setTask(makeTask({ qaAgentId: undefined }));
    const { container } = renderPage();
    expect(screen.getByText('暂无 QA Agent')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="agent-card"]')).toHaveLength(1);
  });

  it('shows the Dev slot placeholder when only the QA agent resolves via qaAgentId', () => {
    setProjects([{ ...PROJECT, agent: [[PROJECT.agent[0][1]]] }]);
    setTask(makeTask({ agentId: 'ghost-dev', preferredAgentId: 'ghost-dev', qaAgentId: 'bx-qa' }));
    const { container } = renderPage();
    expect(screen.getByText('暂无 Dev Agent')).toBeTruthy();
    const cards = Array.from(container.querySelectorAll('[data-testid="agent-card"]'));
    expect(cards.map((c) => c.getAttribute('data-agent-id'))).toEqual(['bx-qa']);
  });
});
