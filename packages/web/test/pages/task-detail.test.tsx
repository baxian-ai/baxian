import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import type { ProjectConfig, TaskState } from '../../src/shared/index.js';

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
import { ConfirmProvider } from '../../src/components/confirm-dialog.tsx';
import { TaskDetail } from '../../src/pages/task-detail.tsx';

const tasksRetryMock = vi.mocked(api.tasks.retry);
const tasksUpdateMock = vi.mocked(api.tasks.update);
const tasksAdvanceMock = vi.mocked(api.tasks.advance);
const tasksVerdictMock = vi.mocked(api.tasks.verdict);

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  const task = makeTaskFixture({
    id: 'task-010',
    projectId: 'baxian',
    title: 'Clean tests',
    description: 'Task body here',
    preferredAgentId: 'bx-dev',
    agentId: 'bx-dev',
    devAgentId: 'bx-dev',
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
  if (task.phase !== undefined) {
    if (!Object.hasOwn(overrides, 'deliveryConfirmation')) {
      task.deliveryConfirmation = {
        phase: task.phase,
        source: 'signal',
        at: '2026-05-10T12:30:00.000Z',
      };
    }
    if (!Object.hasOwn(overrides, 'replyActorId')) task.replyActorId = '77';
    if (!Object.hasOwn(overrides, 'replyActorStatus')) task.replyActorStatus = 'verified';
  }
  return task;
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
      <ConfirmProvider>
        {opts.extra}
        <Routes>
          <Route path="/project/:id/task/:taskId" element={<TaskDetail />} />
          <Route path="*" element={null} />
        </Routes>
        <LocationProbe />
      </ConfirmProvider>
    </MemoryRouter>,
  );
}

async function findConfirmDialog(): Promise<HTMLElement> {
  return screen.findByRole('dialog');
}

async function settleConfirmDialog(buttonName: string): Promise<void> {
  const dialog = await findConfirmDialog();
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: buttonName }));
  });
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
  tasksAdvanceMock.mockReset();
  tasksVerdictMock.mockReset();
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

    expect(within(container.querySelector('section')!).getByText('Approved').className).toContain('pill');
    expect(container.textContent).toContain('Created 2026-05-10 20:00 · Updated 2026-05-10 21:00');
    expect(container.textContent).toContain('Task body here');
    expect(container.textContent).toContain('Review round 1');
    expect(container.textContent).toContain('Spec round 0');
    expect(container.textContent).toContain('Branch:');
    expect(screen.getByTestId('review-conversation').getAttribute('data-task')).toBe('task-010');
  });

  it('shows regular-weight Round/Spec counts beside the status pill', () => {
    const { container } = open({ reviewRound: 3, specReviewRound: 2 });
    const status = within(container.querySelector('section')!).getByText('Approved').parentElement!;
    expect(within(status).getByText('3').className).not.toContain('font-semibold');
    expect(within(status).getByText('2').className).not.toContain('font-semibold');
  });

  it('keeps status, review rounds, and timestamps at body size', () => {
    const { container } = open({ status: 'max_rounds', reviewRound: 10, specReviewRound: 0 });
    const section = container.querySelector('section')!;
    const row = within(section).getByText('Max rounds reached').parentElement!;
    const round = within(row).getByText((_, el) => el?.textContent === 'Review round 10');
    const spec = within(row).getByText((_, el) => el?.textContent === 'Spec round 0');
    const timestamps = within(section).getByText('Created 2026-05-10 20:00 · Updated 2026-05-10 21:00');

    expect(within(row).getByText('Max rounds reached').className).toContain('text-sm');
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
    expect(screen.getByText('Created 2026-05-10 20:00 · Updated')).toBeTruthy();
  });

  it('shows why local branch cleanup is pending', () => {
    open({
      branchCleanupPending: {
        agentId: 'bx-dev',
        reason: 'runtime is not idle; local branch cleanup deferred',
        updatedAt: '2026-05-10T13:05:00.000Z',
      },
    });

    expect(screen.getByText('Local branch cleanup is pending')).toBeTruthy();
    expect(screen.getByText('runtime is not idle; local branch cleanup deferred')).toBeTruthy();
  });

  it('shows when baxian deliberately preserves a local branch', () => {
    open({
      branchCleanupSkipped: {
        agentId: 'bx-dev',
        reason: 'remote branch is absent; preserving the local branch without retry',
        updatedAt: '2026-05-10T13:05:00.000Z',
      },
    });

    expect(screen.getByText('Local branch was preserved')).toBeTruthy();
    expect(screen.getByText('remote branch is absent; preserving the local branch without retry')).toBeTruthy();
  });

  it('places the action buttons on their own row below the status capsule, not in the title', () => {
    const { container } = open({ status: 'pending' });
    const section = container.querySelector('section')!;
    const actionsRow = screen.getByRole('button', { name: 'Edit' }).parentElement!;
    expect(container.querySelector('h1')!.contains(actionsRow)).toBe(false);
    expect(section.contains(actionsRow)).toBe(true);
    const capsuleRow = within(section).getByText('Pending').parentElement!;
    expect(capsuleRow.compareDocumentPosition(actionsRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  const QA_BANNER = 'QA agent approved · Confirming feedback';
  const MERGE_BANNER = 'PR ready · Awaiting your confirmation';
  it.each([
    { status: 'approved', shown: QA_BANNER, hidden: MERGE_BANNER },
    { status: 'merge-ready', shown: MERGE_BANNER, hidden: QA_BANNER },
  ])('shows the $status banner with a working PR link', ({ status, shown, hidden }) => {
    open({ status: status as TaskState['status'] });
    expect(screen.getByText(shown)).toBeTruthy();
    expect(screen.queryByText(hidden)).toBeNull();
    expect(screen.getByRole('link', { name: 'View PR #55' }).getAttribute('href'))
      .toBe('https://github.com/baxian-ai/baxian/pull/55');
  });
});

describe('TaskDetail page — layout & agent cards', () => {
  it('splits info and agents into two equal columns aligned to the top', () => {
    const { container } = open();
    const grid = container.querySelector('.lg\\:grid-cols-2')!;
    expect(grid).toBeTruthy();
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

  it('resolves the snapshotted dev and QA participants before agentId is assigned', () => {
    setTask(makeTask({ status: 'pending', agentId: '', preferredAgentId: 'bx-dev' }));
    const { container } = renderPage();
    const cards = Array.from(container.querySelector('aside')!.querySelectorAll('[data-testid="agent-card"]'));
    expect(cards.map((c) => c.getAttribute('data-agent-id'))).toEqual(['bx-dev', 'bx-qa']);
  });

  it('shows a placeholder when projects are still loading', () => {
    setProjects(null);
    open();
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.queryByTestId('agent-card')).toBeNull();
  });

  it('shows a placeholder for an unassigned task with no participant team', () => {
    setTask(makeTask({ agentId: '', devAgentId: 'unassigned', preferredAgentId: '', qaAgentId: undefined }));
    renderPage();
    expect(screen.getByText('No linked agent')).toBeTruthy();
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
    expect(screen.getByText('Failed to load: boom')).toBeTruthy();
  });

  it('the back button navigates to the previous history entry', () => {
    setTask(makeTask());
    renderPage('task-010', { entries: ['/elsewhere', '/project/baxian/task/task-010'], index: 1 });
    fireEvent.click(screen.getByRole('button', { name: '← Back' }));
    expect(screen.getByTestId('loc').textContent).toBe('/elsewhere');
  });

  it('Edit opens the edit modal overlay', () => {
    open({ status: 'pending' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByTestId('edit-modal')).toBeTruthy();
  });

  it('Retry creates a fresh task and navigates to its detail page', async () => {
    setTasks({
      'task-010': makeTask({ id: 'task-010', status: 'merged' }),
      'task-011': makeTask({ id: 'task-011', status: 'pending' }),
    });
    tasksRetryMock.mockResolvedValue(makeTask({ id: 'task-011', projectId: 'baxian', status: 'pending' }));
    renderPage('task-010');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const dialog = await findConfirmDialog();
    expect(within(dialog).getByText('Retry task task-010?')).toBeTruthy();
    expect(within(dialog).getByText('The task is merged. Retrying creates a new task from scratch with the same title/description.')).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
    });

    expect(tasksRetryMock).toHaveBeenCalledWith('task-010');
    expect(screen.getByTestId('loc').textContent).toBe('/project/baxian/task/task-011');
  });

  it('does not offer another Retry after the terminal task records its replacement', () => {
    open({ status: 'failed', replacementTaskId: 'task-011' });

    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('Cancel confirms and calls the update api', async () => {
    tasksUpdateMock.mockResolvedValue(makeTask({ status: 'cancelled' }));
    open({ status: 'in_progress' });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const dialog = await findConfirmDialog();
    expect(within(dialog).getByText('Cancel task task-010?')).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel task' }));
    });
    expect(tasksUpdateMock).toHaveBeenCalledWith('task-010', { status: 'cancelled' });
  });

  it.each(['in_progress', 'review', 'fixing', 'approved', 'spec-ready', 'max_rounds', 'merge-ready', 'pending'] as const)(
    'Cancel stays clickable at non-terminal status %s with the force-cancel tooltip',
    (status) => {
      open({ status });
      const cancel = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
      expect(cancel.disabled).toBe(false);
      expect(cancel.title).toBe('Force-cancels the task from any state; interrupts and releases its agents');
    },
  );

  it.each(['merged', 'done', 'failed', 'cancelled'] as const)(
    'Cancel stays clickable at terminal status %s for stale-binding cleanup',
    (status) => {
      open({ status });
      const cancel = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
      expect(cancel.disabled).toBe(false);
      expect(cancel.title).toBe('Force-cancels the task from any state; interrupts and releases its agents');
    },
  );

  it('Cancel on a terminal task explains the cleanup semantics and reports the cleanup toast', async () => {
    tasksUpdateMock.mockResolvedValue(makeTask({ status: 'merged' }));
    open({ status: 'merged' });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const dialog = await findConfirmDialog();
    expect(within(dialog).getByText(/its status will not change/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel task' }));
    });

    expect(tasksUpdateMock).toHaveBeenCalledWith('task-010', { status: 'cancelled' });
    expect(toastShowMock).toHaveBeenCalledWith({ kind: 'success', title: 'Cleaned up stale agent bindings for the task' });
  });

  it('Cancel force-cancels a task that is under review', async () => {
    tasksUpdateMock.mockResolvedValue(makeTask({ status: 'cancelled' }));
    open({ status: 'review' });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await settleConfirmDialog('Cancel task');
    expect(tasksUpdateMock).toHaveBeenCalledWith('task-010', { status: 'cancelled' });
  });

  it('does not leak an optimistic override when switching tasks on the same route', async () => {
    tasksUpdateMock.mockResolvedValue(
      makeTask({ id: 'task-010', title: 'AAA', status: 'cancelled', updatedAt: '2026-05-12T00:00:00.000Z' }),
    );
    setTasks({
      'task-010': makeTask({ id: 'task-010', title: 'AAA', status: 'in_progress', updatedAt: '2026-05-10T00:00:00.000Z' }),
      'task-011': makeTask({ id: 'task-011', title: 'BBB', status: 'pending', updatedAt: '2026-05-09T00:00:00.000Z' }),
    });
    renderPage('task-010', { extra: <GoTo to="/project/baxian/task/task-011" /> });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await settleConfirmDialog('Cancel task');
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

    it('code-phase shows the two human verdicts and the warning without legacy actions', () => {
      openMaxRounds();
      expect(screen.getByRole('button', { name: 'Pass and merge' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Fix another round' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Call review' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
      expect(screen.getByText(/Review round limit reached \(round 10\)/)).toBeTruthy();
    });

    it.each([
      {
        button: 'Fix another round',
        confirm: 'Fix another round',
        action: 'continue',
        resolved: makeTask({ status: 'fixing', reviewRound: 11 }),
      },
      {
        button: 'Pass and merge',
        confirm: 'Pass and merge',
        action: 'complete',
        resolved: makeTask({ status: 'merged' }),
      },
    ] as const)('$button confirms and submits a unified verdict', async ({ button, confirm, action, resolved }) => {
      tasksVerdictMock.mockResolvedValue(resolved);
      openMaxRounds();

      fireEvent.click(screen.getByRole('button', { name: button }));
      await settleConfirmDialog(confirm);
      expect(tasksVerdictMock).toHaveBeenCalledWith('task-010', { action });
    });

    it('spec-phase hides code and legacy review actions', () => {
      openMaxRounds({ phase: 'spec' });
      expect(screen.queryByRole('button', { name: 'Pass and merge' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Call review' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
      expect(screen.getByText(/Spec review round limit reached \(round 0\)/)).toBeTruthy();
    });

    it('spec-phase renders the verdict controls: approve starts coding', async () => {
      tasksVerdictMock.mockResolvedValue(makeTask({ status: 'in_progress', phase: 'code' }));
      openMaxRounds({ phase: 'spec', specReviewRound: 10 });

      fireEvent.click(screen.getByRole('button', { name: 'Approve Spec and start coding' }));
      await settleConfirmDialog('Approve Spec');
      expect(tasksVerdictMock).toHaveBeenCalledWith('task-010', { action: 'approve' });
    });

    it('spec-phase reject submits request-changes for one more round', async () => {
      tasksVerdictMock.mockResolvedValue(makeTask({ status: 'fixing', phase: 'spec', maxRoundsContinues: 1 }));
      openMaxRounds({ phase: 'spec', specReviewRound: 10 });

      const reject = screen.getByRole('button', { name: 'Reject Spec' }) as HTMLButtonElement;
      expect(reject.disabled).toBe(true);
      fireEvent.change(screen.getByPlaceholderText(/[Rr]ejection comments/), { target: { value: '按分歧点再收敛一轮' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Reject Spec' }));
      });

      expect(tasksVerdictMock).toHaveBeenCalledWith('task-010', {
        action: 'request-changes',
        comments: '按分歧点再收敛一轮',
      });
    });

  });

  describe('spec-ready actions', () => {
    function openSpecReady(overrides: Partial<TaskState> = {}) {
      open({ status: 'spec-ready', phase: 'spec', specReviewRound: 1, prNumber: undefined, prUrl: undefined, ...overrides });
    }

    it('shows the Spec requires human review card with both actions; Reject disabled until comments filled', () => {
      openSpecReady();
      expect(screen.getByText('Spec requires human review')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Approve Spec and start coding' })).toBeTruthy();
      const reject = screen.getByRole('button', { name: 'Reject Spec' }) as HTMLButtonElement;
      expect(reject.disabled).toBe(true);
      fireEvent.change(screen.getByPlaceholderText(/[Rr]ejection comments/), { target: { value: '补充回滚方案' } });
      expect((screen.getByRole('button', { name: 'Reject Spec' }) as HTMLButtonElement).disabled).toBe(false);
      expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(false);
    });

    it('Approve Spec confirms and submits an approve verdict', async () => {
      tasksVerdictMock.mockResolvedValue(makeTask({ status: 'in_progress', phase: 'code' }));
      openSpecReady();

      fireEvent.click(screen.getByRole('button', { name: 'Approve Spec and start coding' }));
      const dialog = await findConfirmDialog();
      expect(within(dialog).getByText('Approve Spec and start coding?')).toBeTruthy();
      expect(within(dialog).getByText('Task task-010 will move into the coding phase.')).toBeTruthy();
      await act(async () => {
        fireEvent.click(within(dialog).getByRole('button', { name: 'Approve Spec' }));
      });

      expect(tasksVerdictMock).toHaveBeenCalledWith('task-010', { action: 'approve' });
      expect(toastShowMock).toHaveBeenCalledWith({ kind: 'success', title: 'Spec approved; coding started' });
    });

    it('Reject Spec submits request-changes with the comments', async () => {
      tasksVerdictMock.mockResolvedValue(makeTask({ status: 'fixing' }));
      openSpecReady();

      fireEvent.change(screen.getByPlaceholderText(/[Rr]ejection comments/), { target: { value: ' 边界场景没有覆盖 ' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Reject Spec' }));
      });

      expect(tasksVerdictMock).toHaveBeenCalledWith('task-010', {
        action: 'request-changes',
        comments: '边界场景没有覆盖',
      });
      expect(toastShowMock).toHaveBeenCalledWith({ kind: 'success', title: 'Spec rejected; Dev agent is revising' });
    });

    it('verdict failure surfaces an error toast', async () => {
      tasksVerdictMock.mockRejectedValue(new Error('task-010 is fixing'));
      openSpecReady();

      fireEvent.click(screen.getByRole('button', { name: 'Approve Spec and start coding' }));
      await settleConfirmDialog('Approve Spec');

      expect(toastShowMock).toHaveBeenCalledWith({ kind: 'error', title: 'Failed to approve Spec', body: 'task-010 is fixing' });
    });
  });

});

describe('TaskDetail page — advance', () => {
  it('dispatches a pending task to its selected Dev agent through the unified endpoint', async () => {
    tasksAdvanceMock.mockResolvedValue(makeTask({ status: 'in_progress' }));
    open({ status: 'pending' });

    fireEvent.click(screen.getByRole('button', { name: 'Advance' }));
    await settleConfirmDialog('Advance');

    expect(tasksAdvanceMock).toHaveBeenCalledWith('task-010', {
      executor: 'dev',
      agentId: 'bx-dev',
    });
    expect(toastShowMock).toHaveBeenCalledWith({ kind: 'success', title: 'Task advanced' });
  });

  it('replays a review instruction to QA through the unified endpoint', async () => {
    tasksAdvanceMock.mockResolvedValue(makeTask({ status: 'review', reviewRound: 2 }));
    open({ status: 'review' });

    fireEvent.click(screen.getByRole('button', { name: 'Advance' }));
    const dialog = await findConfirmDialog();
    expect(within(dialog).getByText(/current review instruction to QA/)).toBeTruthy();
    await settleConfirmDialog('Advance');

    expect(tasksAdvanceMock).toHaveBeenCalledWith('task-010', { executor: 'qa' });
  });

  it('collects delivery proof before advancing an unconfirmed delivery to QA', async () => {
    tasksAdvanceMock.mockResolvedValue(makeTask({ status: 'review', phase: 'code' }));
    open({
      status: 'in_progress',
      phase: undefined,
      deliveryConfirmation: undefined,
      replyActorId: '99',
      replyActorStatus: 'provisional',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Advance to QA' }));
    const dialog = await screen.findByRole('dialog', { name: 'Advance to QA with delivery proof' });
    const stage = within(dialog).getByLabelText('Delivered stage (required)') as HTMLSelectElement;
    const actor = within(dialog).getByLabelText('Platform actor ID (required)') as HTMLInputElement;
    expect(stage.value).toBe('spec');
    expect(actor.value).toBe('99');
    fireEvent.change(stage, { target: { value: 'code' } });
    fireEvent.change(actor, { target: { value: ' 77 ' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm delivery and advance' }));
    });

    expect(tasksAdvanceMock).toHaveBeenCalledWith('task-010', {
      executor: 'qa',
      stage: 'code',
      actorId: '77',
    });
  });

  it('does not submit delivery recovery without a platform actor', async () => {
    open({
      status: 'in_progress',
      phase: undefined,
      deliveryConfirmation: undefined,
      replyActorId: undefined,
      replyActorStatus: undefined,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Advance to QA' }));
    const dialog = await screen.findByRole('dialog', { name: 'Advance to QA with delivery proof' });
    const submit = within(dialog).getByRole('button', {
      name: 'Confirm delivery and advance',
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Platform actor ID (required)'), {
      target: { value: '   ' },
    });
    expect(submit.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(tasksAdvanceMock).not.toHaveBeenCalled();
  });

  it('collects a PR number when a custom-branch task lost its initial signal', async () => {
    tasksAdvanceMock.mockResolvedValue(makeTask({ status: 'review', prNumber: 73, phase: 'code' }));
    open({
      status: 'in_progress',
      prNumber: undefined,
      prUrl: undefined,
      branch: 'feature/manual-review',
      phase: undefined,
      deliveryConfirmation: undefined,
      replyActorId: undefined,
      replyActorStatus: undefined,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Advance to QA' }));
    const dialog = await screen.findByRole('dialog', { name: 'Advance to QA with delivery proof' });
    const submit = within(dialog).getByRole('button', {
      name: 'Confirm delivery and advance',
    }) as HTMLButtonElement;
    fireEvent.change(within(dialog).getByLabelText('PR number (required)'), { target: { value: '73' } });
    fireEvent.change(within(dialog).getByLabelText('Delivered stage (required)'), { target: { value: 'code' } });
    fireEvent.change(within(dialog).getByLabelText('Platform actor ID (required)'), { target: { value: '77' } });
    await act(async () => {
      fireEvent.click(submit);
    });

    expect(tasksAdvanceMock).toHaveBeenCalledWith('task-010', {
      executor: 'qa',
      prNumber: 73,
      stage: 'code',
      actorId: '77',
    });
  });

  it('requires an explicit confirmation before lifting a revoked post-approve gate', async () => {
    tasksAdvanceMock.mockResolvedValue(makeTask({ status: 'approved' }));
    open({
      status: 'approved',
      postApproveRevoked: {
        generation: 'post-approve-1',
        reason: 'request-changes',
        at: '2026-05-10T13:00:00.000Z',
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Advance' }));
    const dialog = await findConfirmDialog();
    expect(within(dialog).getByText('Lift the post-approve gate and advance?')).toBeTruthy();
    await settleConfirmDialog('Advance');

    expect(tasksAdvanceMock).toHaveBeenCalledWith('task-010', {
      executor: 'dev',
      confirmRevoked: true,
    });
  });

  it('shows an error toast when advance fails', async () => {
    tasksAdvanceMock.mockRejectedValue(new Error('qa is busy'));
    open({ status: 'review' });

    fireEvent.click(screen.getByRole('button', { name: 'Advance' }));
    await settleConfirmDialog('Advance');

    expect(toastShowMock).toHaveBeenCalledWith({
      kind: 'error',
      title: 'Failed to advance',
      body: 'qa is busy',
    });
  });

  it.each(['merged', 'done', 'failed', 'cancelled'] as const)(
    'does not offer Advance for terminal status %s',
    (status) => {
      open({ status });
      expect(screen.queryByRole('button', { name: 'Advance' })).toBeNull();
    },
  );
});

describe('TaskDetail page — action failures surface error toasts', () => {
  it('Cancel failure shows Cancel failed and re-enables the button', async () => {
    tasksUpdateMock.mockRejectedValue(new Error('cancel nope'));
    open({ status: 'in_progress' });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await settleConfirmDialog('Cancel task');

    expect(toastShowMock).toHaveBeenCalledWith({ kind: 'error', title: 'Failed to cancel', body: 'cancel nope' });
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('Retry on a cancelled task uses the fresh-start prompt and reports failure without navigating', async () => {
    tasksRetryMock.mockRejectedValue(new Error('retry nope'));
    open({ status: 'cancelled' });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const dialog = await findConfirmDialog();
    expect(within(dialog).getByText('Retry task task-010?')).toBeTruthy();
    expect(within(dialog).getByText('This creates a new task from scratch; the old task is kept as history.')).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
    });

    expect(toastShowMock).toHaveBeenCalledWith({ kind: 'error', title: 'Failed to retry', body: 'retry nope' });
    expect(screen.getByTestId('loc').textContent).toBe('/project/baxian/task/task-010');
  });

  it('Pass and merge failure reports the verdict action', async () => {
    tasksVerdictMock.mockRejectedValue(new Error('merge conflict'));
    open({ status: 'max_rounds' });

    fireEvent.click(screen.getByRole('button', { name: 'Pass and merge' }));
    await settleConfirmDialog('Pass and merge');

    expect(toastShowMock).toHaveBeenCalledWith({ kind: 'error', title: 'Failed to pass and merge', body: 'merge conflict' });
  });

  it('Fix another round failure reports the verdict action', async () => {
    tasksVerdictMock.mockRejectedValue(new Error('dev is gone'));
    open({ status: 'max_rounds' });

    fireEvent.click(screen.getByRole('button', { name: 'Fix another round' }));
    await settleConfirmDialog('Fix another round');

    expect(toastShowMock).toHaveBeenCalledWith({ kind: 'error', title: 'Failed to start another fix round', body: 'dev is gone' });
  });
});

describe('TaskDetail page — human confirmation gates', () => {
  it('merge-ready gate renders the PR banner and submits a confirm-merge verdict', async () => {
    tasksVerdictMock.mockResolvedValue(makeTask({ status: 'done', updatedAt: '2026-05-11T00:00:00.000Z' }));
    open({ status: 'merge-ready' });

    expect(screen.getByText('PR ready · Awaiting your confirmation')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View PR #55' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm merge' }));
    const dialog = await findConfirmDialog();
    expect(within(dialog).getByText('Confirm task task-010 is complete?')).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm complete' }));
    });

    expect(tasksVerdictMock).toHaveBeenCalledWith('task-010', { action: 'confirm-merge' });
    expect(toastShowMock).toHaveBeenCalledWith({ kind: 'success', title: 'Confirmed (done)' });
  });

  it('Confirm is skipped when the confirm dialog is cancelled and reports failures', async () => {
    open({ status: 'merge-ready' });

    fireEvent.click(screen.getByRole('button', { name: 'Confirm merge' }));
    await settleConfirmDialog('Cancel');
    expect(tasksVerdictMock).not.toHaveBeenCalled();

    tasksVerdictMock.mockRejectedValue(new Error('gate says no'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm merge' }));
    await settleConfirmDialog('Confirm complete');

    expect(toastShowMock).toHaveBeenCalledWith({ kind: 'error', title: 'Failed to confirm', body: 'gate says no' });
  });

});

describe('TaskDetail page — human attention and code verdict', () => {
  it('renders persisted attention with the recommended task operations', () => {
    open({
      status: 'review',
      attention: {
        reason: 'review-verdict-overdue',
        runbook: 'Inspect the QA review and submit a verdict.',
        occurredAt: '2026-05-10T12:00:00.000Z',
        recommendedActions: ['verdict', 'cancel'],
      },
    });

    expect(screen.getByText('review-verdict-overdue')).toBeTruthy();
    expect(screen.getByText('Inspect the QA review and submit a verdict.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Verdict' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Cancel' }).length).toBeGreaterThan(0);
  });

  it('submits a code-review pass with the optional comments through the unified endpoint', async () => {
    tasksVerdictMock.mockResolvedValue(makeTask({ status: 'review' }));
    open({ status: 'review' });

    fireEvent.change(screen.getByPlaceholderText(/Change request/), {
      target: { value: 'Validated the edge case' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Pass' }));
    await settleConfirmDialog('Pass');

    expect(tasksVerdictMock).toHaveBeenCalledWith('task-010', {
      action: 'pass',
      comments: 'Validated the edge case',
    });
  });

  it('requires comments before submitting code-review changes', () => {
    open({ status: 'review' });
    expect((screen.getByRole('button', { name: 'Request changes' }) as HTMLButtonElement).disabled).toBe(true);
    expect(tasksVerdictMock).not.toHaveBeenCalled();
  });
});

describe('TaskDetail page — legacy tasks', () => {
  it('pending legacy task explains how to assign a dev', () => {
    setTask(makeTask({ status: 'pending', preferredAgentId: '', agentId: '', qaAgentId: undefined }));
    renderPage();
    expect(screen.getByText(/This task has no Dev agent assigned/)).toBeTruthy();
  });

  it('terminal legacy task disables Retry with the legacy tooltip', () => {
    setTask(makeTask({ status: 'cancelled', preferredAgentId: '', agentId: '', qaAgentId: undefined }));
    renderPage();
    const retry = screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.title).toBe('Legacy task has no Dev agent assigned; cannot retry');
  });

  it('terminal legacy task explains the current status is read-only', () => {
    setTask(makeTask({ status: 'cancelled', preferredAgentId: '', agentId: '', qaAgentId: undefined }));
    renderPage();
    expect(screen.getByText('Legacy task with no Dev agent assigned. Current status: "Cancelled". Read-only.')).toBeTruthy();
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

  it.each(['javascript:alert(1)', 'not a url'])(
    'renders untrusted PR URL input as plain text: %s',
    (prUrl) => {
      const { container } = open({ prUrl });
      const section = container.querySelector('section')!;
      expect(within(section).queryByRole('link', { name: '#55' })).toBeNull();
      expect(within(section).queryByRole('link', { name: 'bx/task-010' })).toBeNull();
      expect(screen.queryByRole('link', { name: 'View PR #55' })).toBeNull();
    },
  );

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

  it('shows the QA slot placeholder when the snapshotted QA no longer belongs to the team', () => {
    setProjects([{
      ...PROJECT,
      agent: [[
        PROJECT.agent[0][0],
        { ...PROJECT.agent[0][1], id: 'replacement-qa' },
      ]],
    }]);
    setTask(makeTask({ qaAgentId: 'retired-qa' }));
    const { container } = renderPage();
    expect(screen.getByText('No QA agent')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="agent-card"]')).toHaveLength(1);
  });

  it('does not attach a team QA that was not snapshotted on the task', () => {
    setTask(makeTask({ qaAgentId: 'retired-qa' }));
    const { container } = renderPage();
    expect(screen.getByText('No QA agent')).toBeTruthy();
    const cards = Array.from(container.querySelectorAll('[data-testid="agent-card"]'));
    expect(cards.map((card) => card.getAttribute('data-role'))).toEqual(['dev']);
  });

  it('shows the Dev slot placeholder when only the QA agent resolves via qaAgentId', () => {
    setProjects([{ ...PROJECT, agent: [[PROJECT.agent[0][1]]] }]);
    setTask(makeTask({ agentId: 'ghost-dev', preferredAgentId: 'ghost-dev', qaAgentId: 'bx-qa' }));
    const { container } = renderPage();
    expect(screen.getByText('No Dev agent')).toBeTruthy();
    const cards = Array.from(container.querySelectorAll('[data-testid="agent-card"]'));
    expect(cards.map((c) => c.getAttribute('data-agent-id'))).toEqual(['bx-qa']);
  });
});
