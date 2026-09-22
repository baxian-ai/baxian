import { enUS } from '../../src/i18n/en-us.ts';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import type { ProjectConfig, TaskState } from '../../src/shared/index.js';

vi.mock('../../src/hooks/use-events.ts', async () => (await import('../helpers/events-mock.ts')).createEventsMock());


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
      role="article"
      aria-label={`Agent ${props.agent?.id}`}
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
    <div role="region" aria-label="Review conversation" data-task={task.id} />
  ),
}));
vi.mock('../../src/components/create-task-modal.tsx', () => ({
  CreateTaskModal: ({ open }: { open: boolean }) => (open ? <div role="dialog" aria-label={enUS.taskDetail.editTask} /> : null),
}));

vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());

import { api } from '../../src/api.ts';
import { useTaskMock, useAgentsMock } from '../helpers/events-mock.ts';
import { makeTask as makeTaskFixture } from '../helpers/fixtures.ts';
import { expectToast } from '../helpers/toast.tsx';
import { ConfirmProvider } from '../../src/components/confirm-dialog.tsx';
import { __resetProjectsCacheForTests, refreshProjects } from '../../src/hooks/use-projects.ts';
import { ToastProvider } from '../../src/components/toast.tsx';
import { TaskDetail } from '../../src/pages/task-detail.tsx';

const tasksRetryMock = vi.mocked(api.tasks.retry);
const tasksUpdateMock = vi.mocked(api.tasks.update);
const tasksAdvanceMock = vi.mocked(api.tasks.advance);
const tasksVerdictMock = vi.mocked(api.tasks.verdict);
const projectsListMock = vi.mocked(api.projects.list);

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
  }
  return task;
}

const PROJECT: ProjectConfig = {
  id: 'baxian',
  repo: 'https://github.com/baxian-ai/baxian.git',
  merge: null,
  agent: [[
    { id: 'bx-dev', runtime: 'claude-code', role: 'dev', mode: 'local' },
    { id: 'bx-qa', runtime: 'codex', role: 'qa', mode: 'local' },
  ]],
};

const ACTION_FAILED_BODY = enUS.taskDetail.actionFailedBody;

function setTask(task: TaskState | null, opts: { loaded?: boolean; error?: { code: string; message: string } | null } = {}): void {
  useTaskMock.mockReturnValue({ data: task, loaded: opts.loaded ?? true, error: opts.error ?? null });
}

function setTasks(map: Record<string, TaskState>): void {
  useTaskMock.mockImplementation((id: string) => ({ data: map[id] ?? null, loaded: true, error: null }));
}

// Loaded lists are warmed into the shared cache before mount, mirroring a user arriving from the dashboard;
// error and pending lists are left to the page's own mount fetch.
async function setProjects(projects: ProjectConfig[] | null, error: string | null = null): Promise<void> {
  __resetProjectsCacheForTests();
  projectsListMock.mockReset();
  if (projects) {
    projectsListMock.mockResolvedValue(projects);
    await refreshProjects();
  } else if (error) {
    projectsListMock.mockRejectedValue(new Error(error));
  } else {
    projectsListMock.mockReturnValue(new Promise<ProjectConfig[]>(() => {}));
  }
}

function LocationProbe() {
  const loc = useLocation();
  return <div role="region" aria-label="location">{loc.pathname}</div>;
}

function GoTo({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(to)}>goto</button>;
}

function pageTree(taskId = 'task-010', opts: { entries?: string[]; index?: number; extra?: ReactNode } = {}) {
  return (
    <MemoryRouter initialEntries={opts.entries ?? [`/project/baxian/task/${taskId}`]} initialIndex={opts.index}>
      <ConfirmProvider>
        {opts.extra}
        <Routes>
          <Route path="/project/:id/task/:taskId" element={<TaskDetail />} />
          <Route path="*" element={null} />
        </Routes>
        <LocationProbe />
      </ConfirmProvider>
    </MemoryRouter>
  );
}

function renderPage(taskId = 'task-010', opts: { entries?: string[]; index?: number; extra?: ReactNode } = {}) {
  return render(pageTree(taskId, opts), { wrapper: ToastProvider });
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

const AGENTS = [
  { id: 'bx-dev', projectId: 'baxian', runtimeStatus: 'idle', tmuxSessionStatus: 'present', stale: false },
  { id: 'bx-qa', projectId: 'baxian', runtimeStatus: 'idle', tmuxSessionStatus: 'present', stale: false },
];

beforeEach(async () => {
  cleanup();
  useTaskMock.mockReset();
  useAgentsMock.mockReset();
  useAgentsMock.mockReturnValue({
    data: AGENTS,
    loaded: true,
    error: null,
  });
  await setProjects([PROJECT]);
  tasksRetryMock.mockReset();
  tasksUpdateMock.mockReset();
  tasksAdvanceMock.mockReset();
  tasksVerdictMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TaskDetail page — header & info', () => {
  it('names the task that spawned this one and links to its detail page', () => {
    open({ origin: { taskId: 'task-003', title: 'original wire title' } });
    expect(screen.getByRole('link', { name: 'task-003' }).getAttribute('href')).toBe('/project/baxian/task/task-003');
  });

  it('omits the origin line for tasks created by a human', () => {
    const { container } = open();
    expect(container.querySelector('a[href*="/task/task-"]')).toBeNull();
  });

  it('renders the task id + title at the top and the full modal-equivalent body', () => {
    const { container } = open({ title: 'Clean tests' });

    const heading = container.querySelector('h1')!;
    expect(within(heading).getByText('task-010')).toBeTruthy();
    expect(within(heading).getByText('Clean tests')).toBeTruthy();

    expect(container.textContent).toContain('2026-05-10 20:00');
    expect(container.textContent).toContain('2026-05-10 21:00');
    expect(container.textContent).toContain('Task body here');
    expect(container.textContent).toContain(enUS.taskDetail.codeReviewRound(1));
    expect(container.textContent).not.toContain(enUS.taskDetail.specReviewRound(0));
    expect(screen.getByRole('region', { name: 'Review conversation' }).getAttribute('data-task')).toBe('task-010');
  });

  it('shows both the plan and code review counts beside the status, hiding a zero plan round', () => {
    const { container } = open({ reviewRound: 3, specReviewRound: 2 });
    const status = container.querySelector('[data-status="approved"]')!.parentElement!;
    expect(within(status).getByText(enUS.taskDetail.codeReviewRound(3))).toBeTruthy();
    expect(within(status).getByText(enUS.taskDetail.specReviewRound(2))).toBeTruthy();

    cleanup();
    const maxRounds = open({ status: 'max_rounds', reviewRound: 10, specReviewRound: 0 });
    const row = maxRounds.container.querySelector('[data-status="max_rounds"]')!.parentElement!;
    expect(within(row).getByText(enUS.taskDetail.codeReviewRound(10))).toBeTruthy();
    expect(within(row).queryByText(enUS.taskDetail.specReviewRound(0))).toBeNull();
  });

  it('shows only PR and Branch in the info card, with a branch hyperlink, dropping project/agent rows', () => {
    const { container } = open();
    const section = container.querySelector('section')!;
    expect(within(section).getByRole('link', { name: '#55' }).getAttribute('href'))
      .toBe('https://github.com/baxian-ai/baxian/pull/55');
    expect(within(section).getByRole('link', { name: 'bx/task-010' }).getAttribute('href'))
      .toBe('https://github.com/baxian-ai/baxian/tree/bx/task-010');
  });

  it('renders timestamps at minute precision and tolerates empty values', () => {
    open({ createdAt: '2026-05-10T12:00:00.000Z', updatedAt: null as unknown as string });
    expect(screen.getByText(/2026-05-10 20:00/)).toBeTruthy();
  });

  it('shows why local branch cleanup is pending', () => {
    open({
      branchCleanupPending: {
        agentId: 'bx-dev',
        reason: 'runtime is not idle; local branch cleanup deferred',
        updatedAt: '2026-05-10T13:05:00.000Z',
      },
    });

    expect(screen.getByText(enUS.taskDetail.branchCleanupPendingTitle)).toBeTruthy();
    expect(screen.getByText(enUS.taskDetail.branchCleanupPendingBody)).toBeTruthy();
    expect(screen.getByText(enUS.common.technicalDetails)).toBeTruthy();
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

    expect(screen.getByText(enUS.taskDetail.branchCleanupSkippedTitle)).toBeTruthy();
    expect(screen.getByText(enUS.taskDetail.branchCleanupSkippedBody)).toBeTruthy();
    expect(screen.getByText(enUS.common.technicalDetails)).toBeTruthy();
    expect(screen.getByText('remote branch is absent; preserving the local branch without retry')).toBeTruthy();
  });

  it('places the action buttons on their own row below the status capsule, not in the title', () => {
    const { container } = open({ status: 'pending' });
    const section = container.querySelector('section')!;
    const actionsRow = screen.getByRole('button', { name: enUS.taskDetail.editTask }).parentElement!;
    expect(container.querySelector('h1')!.contains(actionsRow)).toBe(false);
    expect(section.contains(actionsRow)).toBe(true);
    const capsuleRow = section.querySelector('[data-status="pending"]')!.parentElement!;
    expect(capsuleRow.compareDocumentPosition(actionsRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each(['approved', 'merge-ready'] as const)('provides a working PR link for %s tasks', (status) => {
    open({ status });
    expect(screen.getByRole('link', { name: enUS.taskDetail.viewPr(55) }).getAttribute('href'))
      .toBe('https://github.com/baxian-ai/baxian/pull/55');
  });
});

describe('TaskDetail page — layout & agent cards', () => {
  it('places info and agents side by side in a two-column grid on large screens', () => {
    const { container } = open();
    const grid = container.querySelector('.lg\\:grid-cols-2')!;
    expect(grid).toBeTruthy();
    expect(grid.querySelector('section')).toBeTruthy();
    expect(grid.querySelector('aside')).toBeTruthy();
  });

  it('renders the dev card above the qa card, styled like dashboard/project cards', () => {
    const { container } = open();
    const cards = Array.from(container.querySelector('aside')!.querySelectorAll('[role="article"]'));
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
    const cards = Array.from(container.querySelector('aside')!.querySelectorAll('[role="article"]'));
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
    const devCard = container.querySelector('[role="article"]') as HTMLElement;

    fireEvent.click(devCard);
    expect(devCard.getAttribute('data-active')).toBe('true');

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(devCard.getAttribute('data-active')).toBe('false');
  });

  it('keeps the active task detail agent card when Escape starts from focus inside the card', () => {
    const { container } = open();
    const devCard = container.querySelector('[role="article"]') as HTMLElement;

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
    const cards = Array.from(container.querySelector('aside')!.querySelectorAll('[role="article"]'));
    expect(cards.map((c) => c.getAttribute('data-agent-id'))).toEqual(['bx-dev', 'bx-qa']);
  });

  it('shows a placeholder when projects are still loading', async () => {
    await setProjects(null);
    open();
    expect(screen.getByText(enUS.common.loading)).toBeTruthy();
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('shows a placeholder for an unassigned task with no participant team', () => {
    setTask(makeTask({ agentId: '', devAgentId: 'unassigned', preferredAgentId: '', qaAgentId: undefined }));
    renderPage();
    expect(screen.getByText(enUS.taskDetail.noLinkedAgent)).toBeTruthy();
    expect(screen.queryByRole('article')).toBeNull();
  });
});

describe('TaskDetail page — actions & states', () => {
  it('Loading / not-found / error states', () => {
    setTask(null, { loaded: false });
    const { unmount } = renderPage();
    expect(screen.getByText(enUS.common.loading)).toBeTruthy();
    unmount();

    setTask(null, { loaded: true });
    const r2 = renderPage();
    expect(screen.getByText(enUS.taskDetail.taskNotFound('task-010'))).toBeTruthy();
    r2.unmount();

    setTask(null, { loaded: true, error: { code: 'x', message: 'boom' } });
    renderPage();
    expect(screen.getByText(enUS.common.loadFailed('boom'))).toBeTruthy();
  });

  it('the back button navigates to the previous history entry', () => {
    setTask(makeTask());
    renderPage('task-010', { entries: ['/elsewhere', '/project/baxian/task/task-010'], index: 1 });
    fireEvent.click(screen.getByRole('button', { name: enUS.common.back }));
    expect(screen.getByRole('region', { name: 'location' }).textContent).toBe('/elsewhere');
  });

  it('Edit task opens the edit modal overlay', () => {
    open({ status: 'pending' });
    fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.editTask }));
    expect(screen.getByRole('dialog', { name: enUS.taskDetail.editTask })).toBeTruthy();
  });

  it('Run task again creates a fresh task and navigates to its detail page', async () => {
    setTasks({
      'task-010': makeTask({ id: 'task-010', status: 'merged' }),
      'task-011': makeTask({ id: 'task-011', status: 'pending' }),
    });
    tasksRetryMock.mockResolvedValue(makeTask({ id: 'task-011', projectId: 'baxian', status: 'pending' }));
    renderPage('task-010');

    fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.retryTask }));
    const dialog = await findConfirmDialog();
    expect(within(dialog).getByText(enUS.taskDetail.retryConfirmTitle('task-010'))).toBeTruthy();
    expect(within(dialog).getByText(enUS.taskDetail.retryConfirmBodyMerged)).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: enUS.taskDetail.retryTask }));
    });

    expect(tasksRetryMock).toHaveBeenCalledWith('task-010');
    expect(screen.getByRole('region', { name: 'location' }).textContent).toBe('/project/baxian/task/task-011');
  });

  it('does not offer another run after the terminal task records its replacement', () => {
    open({ status: 'failed', replacementTaskId: 'task-011' });

    expect(screen.queryByRole('button', { name: enUS.taskDetail.retryTask })).toBeNull();
  });

  it('Cancel confirms and calls the update api', async () => {
    tasksUpdateMock.mockResolvedValue(makeTask({ status: 'cancelled' }));
    open({ status: 'in_progress' });

    fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.cancelConfirmLabel }));
    const dialog = await findConfirmDialog();
    expect(within(dialog).getByText(enUS.taskDetail.cancelConfirmTitle('task-010'))).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: enUS.taskDetail.cancelConfirmLabel }));
    });
    expect(tasksUpdateMock).toHaveBeenCalledWith('task-010', { status: 'cancelled' });
  });

  it.each(['in_progress', 'review', 'fixing', 'approved', 'spec-ready', 'max_rounds', 'merge-ready', 'pending'] as const)(
    'Cancel stays clickable at non-terminal status %s with the force-cancel tooltip',
    (status) => {
      open({ status });
      const cancel = screen.getByRole('button', { name: enUS.taskDetail.cancelConfirmLabel }) as HTMLButtonElement;
      expect(cancel.disabled).toBe(false);
      expect(cancel.title).toBe(enUS.taskDetail.cancelForceTitle);
    },
  );

  it.each(['merged', 'done', 'failed', 'cancelled'] as const)(
    'Cancel stays clickable at terminal status %s for stale-binding cleanup',
    (status) => {
      open({ status });
      const cancel = screen.getByRole('button', { name: enUS.taskDetail.cancelConfirmLabel }) as HTMLButtonElement;
      expect(cancel.disabled).toBe(false);
      expect(cancel.title).toBe(enUS.taskDetail.cancelForceTitle);
    },
  );

  it('Cancel on a terminal task explains the cleanup semantics and reports the cleanup toast', async () => {
    tasksUpdateMock.mockResolvedValue(makeTask({ status: 'merged' }));
    open({ status: 'merged' });

    fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.cancelConfirmLabel }));
    const dialog = await findConfirmDialog();
    expect(within(dialog).getByText(enUS.taskDetail.cancelConfirmBodyTerminal)).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: enUS.taskDetail.cancelConfirmLabel }));
    });

    expect(tasksUpdateMock).toHaveBeenCalledWith('task-010', { status: 'cancelled' });
    await expectToast({ title: enUS.taskDetail.cancelCleanupToastTitle });
  });

  it('Cancel force-cancels a task that is under review', async () => {
    tasksUpdateMock.mockResolvedValue(makeTask({ status: 'cancelled' }));
    open({ status: 'review' });

    fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.cancelConfirmLabel }));
    await settleConfirmDialog(enUS.taskDetail.cancelConfirmLabel);
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

    fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.cancelConfirmLabel }));
    await settleConfirmDialog(enUS.taskDetail.cancelConfirmLabel);
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
      expect(screen.getByRole('button', { name: enUS.taskDetail.verdictComplete })).toBeTruthy();
      expect(screen.getByRole('button', { name: enUS.taskDetail.verdictContinue })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Call review' })).toBeNull();
      expect(screen.queryByRole('button', { name: enUS.taskDetail.retryTask })).toBeNull();
      expect(screen.getByText(enUS.taskDetail.codeMaxRoundsTitle(10))).toBeTruthy();
    });

    it.each([
      {
        button: enUS.taskDetail.verdictContinue,
        confirm: enUS.taskDetail.verdictContinue,
        action: 'continue',
        resolved: makeTask({ status: 'fixing', reviewRound: 11 }),
      },
      {
        button: enUS.taskDetail.verdictComplete,
        confirm: enUS.taskDetail.verdictComplete,
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
      expect(screen.queryByRole('button', { name: enUS.taskDetail.verdictComplete })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Call review' })).toBeNull();
      expect(screen.queryByRole('button', { name: enUS.taskDetail.retryTask })).toBeNull();
      expect(screen.getByText(enUS.taskDetail.specMaxRoundsTitle(0))).toBeTruthy();
    });

    it('spec-phase renders the verdict controls: approve starts coding', async () => {
      tasksVerdictMock.mockResolvedValue(makeTask({ status: 'in_progress', phase: 'code' }));
      openMaxRounds({ phase: 'spec', specReviewRound: 10 });

      fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.specApproveButton }));
      await settleConfirmDialog(enUS.taskDetail.specApprove);
      expect(tasksVerdictMock).toHaveBeenCalledWith('task-010', { action: 'approve' });
    });

    it('spec-phase reject submits request-changes for one more round', async () => {
      tasksVerdictMock.mockResolvedValue(makeTask({ status: 'fixing', phase: 'spec', maxRoundsContinues: 1 }));
      openMaxRounds({ phase: 'spec', specReviewRound: 10 });

      const reject = screen.getByRole('button', { name: enUS.taskDetail.specReject }) as HTMLButtonElement;
      expect(reject.disabled).toBe(true);
      fireEvent.change(screen.getByPlaceholderText(enUS.taskDetail.specCommentsPlaceholder), { target: { value: '按分歧点再收敛一轮' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.specReject }));
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

    it('shows the plan approval card with both actions; change request is disabled until comments are filled', () => {
      openSpecReady();
      expect(screen.getByText(enUS.taskDetail.specReadyBannerTitle)).toBeTruthy();
      expect(screen.getByRole('button', { name: enUS.taskDetail.specApproveButton })).toBeTruthy();
      const reject = screen.getByRole('button', { name: enUS.taskDetail.specReject }) as HTMLButtonElement;
      expect(reject.disabled).toBe(true);
      fireEvent.change(screen.getByPlaceholderText(enUS.taskDetail.specCommentsPlaceholder), { target: { value: '补充回滚方案' } });
      expect((screen.getByRole('button', { name: enUS.taskDetail.specReject }) as HTMLButtonElement).disabled).toBe(false);
      expect((screen.getByRole('button', { name: enUS.taskDetail.cancelConfirmLabel }) as HTMLButtonElement).disabled).toBe(false);
    });

    it('Approve plan confirms and submits an approve verdict', async () => {
      tasksVerdictMock.mockResolvedValue(makeTask({ status: 'in_progress', phase: 'code' }));
      openSpecReady();

      fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.specApproveButton }));
      const dialog = await findConfirmDialog();
      expect(within(dialog).getByText(enUS.taskDetail.specApproveConfirmTitle)).toBeTruthy();
      expect(within(dialog).getByText(enUS.taskDetail.specApproveConfirmBody('task-010'))).toBeTruthy();
      await act(async () => {
        fireEvent.click(within(dialog).getByRole('button', { name: enUS.taskDetail.specApprove }));
      });

      expect(tasksVerdictMock).toHaveBeenCalledWith('task-010', { action: 'approve' });
      await expectToast({ title: enUS.taskDetail.specApprovedToastTitle });
    });

    it('Request plan changes submits request-changes with the comments', async () => {
      tasksVerdictMock.mockResolvedValue(makeTask({ status: 'fixing' }));
      openSpecReady();

      fireEvent.change(screen.getByPlaceholderText(enUS.taskDetail.specCommentsPlaceholder), { target: { value: ' 边界场景没有覆盖 ' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.specReject }));
      });

      expect(tasksVerdictMock).toHaveBeenCalledWith('task-010', {
        action: 'request-changes',
        comments: '边界场景没有覆盖',
      });
      await expectToast({ title: enUS.taskDetail.specRejectedToastTitle });
    });

    it('verdict failure surfaces an error toast', async () => {
      tasksVerdictMock.mockRejectedValue(new Error('task-010 is fixing'));
      openSpecReady();

      fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.specApproveButton }));
      await settleConfirmDialog(enUS.taskDetail.specApprove);

      await expectToast({
        title: enUS.taskDetail.specApproveFailedTitle,
        body: ACTION_FAILED_BODY,
        details: 'task-010 is fixing',
      });
    });
  });

});

describe('TaskDetail page — advance', () => {
  it('starts a pending task with its selected development agent through the unified endpoint', async () => {
    tasksAdvanceMock.mockResolvedValue(makeTask({ status: 'in_progress' }));
    open({ status: 'pending' });

    fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.startTask }));
    await settleConfirmDialog(enUS.taskDetail.startTask);

    expect(tasksAdvanceMock).toHaveBeenCalledWith('task-010', {
      executor: 'dev',
      agentId: 'bx-dev',
    });
    await expectToast({ title: enUS.taskDetail.advanceSucceededTitle });
  });

  it('restarts review through the unified endpoint', async () => {
    tasksAdvanceMock.mockResolvedValue(makeTask({ status: 'review', reviewRound: 2 }));
    open({ status: 'review' });

    fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.restartReview }));
    const dialog = await findConfirmDialog();
    expect(within(dialog).getByText(enUS.taskDetail.restartReviewConfirmBody('task-010'))).toBeTruthy();
    await settleConfirmDialog(enUS.taskDetail.restartReview);

    expect(tasksAdvanceMock).toHaveBeenCalledWith('task-010', { executor: 'qa' });
  });

  it('collects PR details before starting an unconfirmed review', async () => {
    tasksAdvanceMock.mockResolvedValue(makeTask({ status: 'review', phase: 'code' }));
    open({
      status: 'in_progress',
      phase: undefined,
      deliveryConfirmation: undefined,
    });

    fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.startReview }));
    const dialog = await screen.findByRole('dialog', { name: enUS.taskDetail.reviewRecoveryTitle });
    const stage = within(dialog).getByLabelText(enUS.taskDetail.reviewRecoveryStageLabel) as HTMLSelectElement;
    expect(stage.value).toBe('spec');
    expect(within(dialog).queryByLabelText(/platform user ID/i)).toBeNull();
    fireEvent.change(stage, { target: { value: 'code' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: enUS.taskDetail.reviewRecoverySubmit }));
    });

    expect(tasksAdvanceMock).toHaveBeenCalledWith('task-010', {
      executor: 'qa',
      stage: 'code',
    });
  });

  it('starts review directly when the delivery is already confirmed', async () => {
    tasksAdvanceMock.mockResolvedValue(makeTask({ status: 'review', phase: 'code' }));
    open({ status: 'in_progress', phase: 'code' });

    fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.startReview }));
    await settleConfirmDialog(enUS.taskDetail.startReview);

    expect(screen.queryByRole('dialog', { name: enUS.taskDetail.reviewRecoveryTitle })).toBeNull();
    expect(tasksAdvanceMock).toHaveBeenCalledWith('task-010', { executor: 'qa' });
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
    });

    fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.startReview }));
    const dialog = await screen.findByRole('dialog', { name: enUS.taskDetail.reviewRecoveryTitle });
    const submit = within(dialog).getByRole('button', {
      name: enUS.taskDetail.reviewRecoverySubmit,
    }) as HTMLButtonElement;
    fireEvent.change(within(dialog).getByLabelText(enUS.taskDetail.reviewRecoveryPrNumberLabel), { target: { value: '73' } });
    fireEvent.change(within(dialog).getByLabelText(enUS.taskDetail.reviewRecoveryStageLabel), { target: { value: 'code' } });
    await act(async () => {
      fireEvent.click(submit);
    });

    expect(tasksAdvanceMock).toHaveBeenCalledWith('task-010', {
      executor: 'qa',
      prNumber: 73,
      stage: 'code',
    });
  });

  it('requires an explicit confirmation before retrying revoked pre-merge checks', async () => {
    tasksAdvanceMock.mockResolvedValue(makeTask({ status: 'approved' }));
    open({
      status: 'approved',
      postApproveRevoked: {
        generation: 'post-approve-1',
        reason: 'request-changes',
        at: '2026-05-10T13:00:00.000Z',
      },
    });

    fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.retryPreMergeCheck }));
    const dialog = await findConfirmDialog();
    expect(within(dialog).getByText(enUS.taskDetail.advanceRevokedConfirmTitle)).toBeTruthy();
    expect(within(dialog).getByText(enUS.taskDetail.advanceRevokedRequestChangesBody)).toBeTruthy();
    await settleConfirmDialog(enUS.taskDetail.retryPreMergeCheck);

    expect(tasksAdvanceMock).toHaveBeenCalledWith('task-010', {
      executor: 'dev',
      confirmRevoked: true,
    });
  });

  it('shows an error toast when advance fails', async () => {
    tasksAdvanceMock.mockRejectedValue(new Error('qa is busy'));
    open({ status: 'review' });

    fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.restartReview }));
    await settleConfirmDialog(enUS.taskDetail.restartReview);

    await expectToast({
      title: enUS.taskDetail.advanceFailedTitle,
      body: ACTION_FAILED_BODY,
      details: 'qa is busy',
    });
  });

  it.each(['merged', 'done', 'failed', 'cancelled'] as const)(
    'does not offer a current-step action for terminal status %s',
    (status) => {
      open({ status });
      expect(screen.queryByRole('button', { name: /^(Start task|Start review|Restart review|Retry current step|Retry pre-merge checks)$/ })).toBeNull();
    },
  );
});

describe('TaskDetail page — action failures surface error toasts', () => {
  it('Cancel failure shows a friendly error and re-enables the button', async () => {
    tasksUpdateMock.mockRejectedValue(new Error('cancel nope'));
    open({ status: 'in_progress' });

    fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.cancelConfirmLabel }));
    await settleConfirmDialog(enUS.taskDetail.cancelConfirmLabel);

    await expectToast({
      title: enUS.taskDetail.cancelFailedTitle,
      body: ACTION_FAILED_BODY,
      details: 'cancel nope',
    });
    expect((screen.getByRole('button', { name: enUS.taskDetail.cancelConfirmLabel }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('Run task again on a cancelled task uses the fresh-start prompt and reports failure without navigating', async () => {
    tasksRetryMock.mockRejectedValue(new Error('retry nope'));
    open({ status: 'cancelled' });

    fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.retryTask }));
    const dialog = await findConfirmDialog();
    expect(within(dialog).getByText(enUS.taskDetail.retryConfirmTitle('task-010'))).toBeTruthy();
    expect(within(dialog).getByText(enUS.taskDetail.retryConfirmBodyDefault)).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: enUS.taskDetail.retryTask }));
    });

    await expectToast({
      title: enUS.taskDetail.retryFailedTitle,
      body: ACTION_FAILED_BODY,
      details: 'retry nope',
    });
    expect(screen.getByRole('region', { name: 'location' }).textContent).toBe('/project/baxian/task/task-010');
  });

  it('Accept current version failure reports the verdict action', async () => {
    tasksVerdictMock.mockRejectedValue(new Error('merge conflict'));
    open({ status: 'max_rounds' });

    fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.verdictComplete }));
    await settleConfirmDialog(enUS.taskDetail.verdictComplete);

    await expectToast({
      title: enUS.taskDetail.markCompleteFailedTitle,
      body: ACTION_FAILED_BODY,
      details: 'merge conflict',
    });
  });

  it('Continue revising failure reports the verdict action', async () => {
    tasksVerdictMock.mockRejectedValue(new Error('dev is gone'));
    open({ status: 'max_rounds' });

    fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.verdictContinue }));
    await settleConfirmDialog(enUS.taskDetail.verdictContinue);

    await expectToast({
      title: enUS.taskDetail.continueFailedTitle,
      body: ACTION_FAILED_BODY,
      details: 'dev is gone',
    });
  });
});

describe('TaskDetail page — human confirmation gates', () => {
  it('waits for project settings before enabling confirmation', async () => {
    await setProjects(null);
    open({ status: 'merge-ready' });

    expect(screen.getByText(enUS.taskDetail.mergeReadyLoadingBody)).toBeTruthy();
    const button = screen.getByRole('button', { name: enUS.taskDetail.loadingMergeSetting }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe(enUS.taskDetail.confirmLoadingTitle);
    fireEvent.click(button);
    expect(tasksVerdictMock).not.toHaveBeenCalled();
  });

  it('warns that confirmation may merge the PR when project settings are unavailable', async () => {
    await setProjects(null, 'project settings request failed');
    open({ status: 'merge-ready' });

    expect(await screen.findByText(enUS.taskDetail.mergeReadyUnknownBody)).toBeTruthy();
    const details = screen.getByText(enUS.common.technicalDetails).closest('details')!;
    expect(within(details).getByText('project settings request failed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.confirmResult }));
    const dialog = await findConfirmDialog();
    expect(within(dialog).getByText(enUS.taskDetail.confirmResultBody)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: enUS.common.cancel }));
    expect(tasksVerdictMock).not.toHaveBeenCalled();
  });

  it('manual merge mode explains that the PR stays open and submits a confirm-merge verdict', async () => {
    tasksVerdictMock.mockResolvedValue(makeTask({ status: 'done', updatedAt: '2026-05-11T00:00:00.000Z' }));
    open({ status: 'merge-ready' });

    expect(screen.getByText(enUS.taskDetail.mergeReadyBannerTitle)).toBeTruthy();
    expect(screen.getByText(enUS.taskDetail.mergeReadyManualBody(55))).toBeTruthy();
    expect(screen.getByRole('link', { name: enUS.taskDetail.viewPr(55) })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.confirmComplete }));
    const dialog = await findConfirmDialog();
    expect(within(dialog).getByText(enUS.taskDetail.confirmManualCompleteTitle)).toBeTruthy();
    expect(within(dialog).getByText(enUS.taskDetail.confirmManualCompleteBody(55))).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: enUS.taskDetail.confirmComplete }));
    });

    expect(tasksVerdictMock).toHaveBeenCalledWith('task-010', { action: 'confirm-merge' });
    await expectToast({ title: enUS.taskDetail.confirmedCompleteToastTitle });
  });

  it('automatic merge mode clearly confirms and merges the PR', async () => {
    await setProjects([{ ...PROJECT, merge: 'auto' }]);
    tasksVerdictMock.mockResolvedValue(makeTask({ status: 'merged', updatedAt: '2026-05-11T00:00:00.000Z' }));
    open({ status: 'merge-ready' });

    expect(screen.getByText(enUS.taskDetail.mergeReadyAutoBody(55))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.confirmAndMerge }));
    const dialog = await findConfirmDialog();
    expect(within(dialog).getByText(enUS.taskDetail.confirmAutoMergeTitle(55))).toBeTruthy();
    expect(within(dialog).getByText(enUS.taskDetail.confirmAutoMergeBody(55))).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: enUS.taskDetail.confirmAndMerge }));
    });

    expect(tasksVerdictMock).toHaveBeenCalledWith('task-010', { action: 'confirm-merge' });
    await expectToast({ title: enUS.taskDetail.confirmedMergedToastTitle });
  });

  it('Confirm is skipped when the confirm dialog is cancelled and reports failures', async () => {
    open({ status: 'merge-ready' });

    fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.confirmComplete }));
    await settleConfirmDialog(enUS.common.cancel);
    expect(tasksVerdictMock).not.toHaveBeenCalled();

    tasksVerdictMock.mockRejectedValue(new Error('gate says no'));
    fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.confirmComplete }));
    await settleConfirmDialog(enUS.taskDetail.confirmComplete);

    await expectToast({
      title: enUS.taskDetail.confirmFailedTitle,
      body: ACTION_FAILED_BODY,
      details: 'gate says no',
    });
  });

});

describe('TaskDetail page — human attention and code verdict', () => {
  it.each(['in_progress', 'fixing', 'approved'] as const)('does not recommend Dev retry for uncertain %s delivery with persisted advance', (status) => {
    open({
      status,
      attention: {
        reason: 'dispatch-failed:ack_unknown', runbook: 'Verify whether the prompt started.',
        occurredAt: '2026-05-10T12:00:00.000Z', recommendedActions: ['advance', 'cancel'],
      },
    });

    const details = screen.getByText(enUS.common.technicalDetails).closest('details')!;
    expect(details.open).toBe(true);
    expect(screen.getByText(enUS.taskDetail.attentionDeliveryUnknownTitle)).toBeTruthy();
    expect(screen.getByText(enUS.taskDetail.attentionDeliveryUnknownGuidance, { exact: false })).toBeTruthy();
    expect(screen.queryByRole('button', { name: enUS.taskDetail.retryCurrentStep })).toBeNull();
    expect(screen.queryByRole('button', { name: enUS.taskDetail.retryPreMergeCheck })).toBeNull();
    expect(screen.queryByText(enUS.taskDetail.attentionAdvanceGuidance, { exact: false })).toBeNull();
    expect(tasksAdvanceMock).not.toHaveBeenCalled();
  });

  it('keeps the explicit QA confirmation action for uncertain review delivery', async () => {
    tasksAdvanceMock.mockResolvedValue(makeTask({ status: 'review', phase: 'code' }));
    open({
      status: 'review', phase: 'code', prNumber: 42,
      deliveryConfirmation: { phase: 'code', source: 'signal', at: '2026-05-10T12:00:00.000Z' },
      attention: {
        reason: 'dispatch-failed:ack_unknown', runbook: 'Confirm review delivery.',
        occurredAt: '2026-05-10T12:00:00.000Z', recommendedActions: ['advance', 'cancel'],
      },
    });

    const banner = screen.getByText(enUS.common.technicalDetails).closest('details')!.parentElement!;
    fireEvent.click(within(banner).getByRole('button', { name: enUS.taskDetail.restartReview }));
    await settleConfirmDialog(enUS.taskDetail.restartReview);
    expect(tasksAdvanceMock).toHaveBeenCalledWith('task-010', { executor: 'qa' });
  });

  it.each([{ actions: ['cancel'] }, { actions: ['advance', 'cancel'] }] as const)(
    'shows a delivered bootstrap hold without Dev retry even with persisted actions $actions', ({ actions }) => {
      open({
        status: 'in_progress',
        attention: {
          reason: 'bootstrap-marker-clear-failed',
          runbook: 'The initial prompt was already delivered; verify the task outcome.',
          occurredAt: '2026-05-10T12:00:00.000Z',
          recommendedActions: [...actions],
        },
      });

      const details = screen.getByText(enUS.common.technicalDetails).closest('details')!;
      expect(details.open).toBe(true);
      const banner = details.parentElement!;
      expect(within(banner).getByText(enUS.taskDetail.attentionBootstrapDeliveredGuidance, { exact: false })).toBeTruthy();
      expect(within(banner).getByRole('button', { name: enUS.taskDetail.cancelConfirmLabel })).toBeTruthy();
      expect(screen.queryByRole('button', { name: enUS.taskDetail.retryCurrentStep })).toBeNull();
      expect(within(banner).queryByText(enUS.taskDetail.attentionAdvanceGuidance, { exact: false })).toBeNull();
      expect(screen.getByRole('article', { name: 'Agent bx-dev' })).toBeTruthy();
      expect(tasksAdvanceMock).not.toHaveBeenCalled();
    },
  );

  it.each(['dirty-workdir', 'checkout-preparation-failed', 'restart-redispatch-failed'])(
    'exposes the %s cause before the user retries the task', async (reason) => {
      tasksAdvanceMock.mockResolvedValue(makeTask({ status: 'in_progress' }));
      open({
        status: 'in_progress',
        attention: {
          reason,
          runbook: 'Workdir /work/agent-repo has uncommitted changes.',
          occurredAt: '2026-05-10T12:00:00.000Z',
          recommendedActions: ['advance', 'cancel'],
        },
      });

      const details = screen.getByText(enUS.common.technicalDetails).closest('details')!;
      expect(details.open).toBe(true);
      const banner = details.parentElement!;
      expect(within(banner).getByText(enUS.taskDetail.attentionAdvanceGuidance, { exact: false })).toBeTruthy();
      fireEvent.click(within(banner).getByRole('button', { name: enUS.taskDetail.retryCurrentStep }));
      await settleConfirmDialog(enUS.taskDetail.retryCurrentStep);

      expect(tasksAdvanceMock).toHaveBeenCalledWith('task-010', { executor: 'dev' });
    },
  );

  describe.each(['dirty-workdir', 'checkout-preparation-failed', 'restart-redispatch-failed', 'bootstrap-marker-clear-failed'])(
    '%s recovery actions', (reason) => {
      it.each([
        { status: 'review', actions: ['verdict', 'cancel'], guidance: enUS.taskDetail.attentionVerdictGuidance, button: enUS.taskDetail.handleReview },
        { status: 'in_progress', actions: ['cancel'], guidance: enUS.taskDetail.attentionCancelGuidance, button: enUS.taskDetail.cancelConfirmLabel },
        { status: 'cancelled', actions: ['retry'], guidance: enUS.taskDetail.attentionRetryGuidance, button: enUS.taskDetail.retryTask },
      ] as const)('matches guidance to $actions on $status tasks', ({ status, actions, guidance, button }) => {
        open({
          status,
          attention: { reason, runbook: 'Inspect the failure.', occurredAt: '2026-05-10T12:00:00.000Z', recommendedActions: [...actions] },
        });

        const details = screen.getByText(enUS.common.technicalDetails).closest('details')!;
        const banner = details.parentElement!;
        expect(details.open).toBe(true);
        expect(within(banner).getByText(guidance, { exact: false })).toBeTruthy();
        expect(within(banner).getByRole('button', { name: button })).toBeTruthy();
        expect(within(banner).queryByRole('button', { name: enUS.taskDetail.retryCurrentStep })).toBeNull();
        expect(within(banner).queryByText(enUS.taskDetail.attentionAdvanceGuidance, { exact: false })).toBeNull();
      });
    },
  );

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

    const details = screen.getByText(enUS.common.technicalDetails).closest('details')!;
    expect(within(details).getByText(/review-verdict-overdue/)).toBeTruthy();
    expect(within(details).getByText(/Inspect the QA review and submit a verdict/)).toBeTruthy();
    expect(screen.getByRole('button', { name: enUS.taskDetail.handleReview })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: enUS.taskDetail.cancelConfirmLabel }).length).toBeGreaterThan(0);
    expect(screen.getByText(enUS.taskDetail.codeVerdictTitle)).toBeTruthy();
    expect(screen.getByRole('button', { name: enUS.taskDetail.codePass })).toBeTruthy();
  });

  it('starts an assigned pending task from its attention action', async () => {
    tasksAdvanceMock.mockResolvedValue(makeTask({ status: 'in_progress' }));
    open({
      status: 'pending',
      attention: {
        reason: 'delivery-not-confirmed',
        runbook: 'Retry task delivery.',
        occurredAt: '2026-05-10T12:00:00.000Z',
        recommendedActions: ['advance'],
      },
    });

    const attention = screen.getByText(enUS.taskDetail.attentionHandoffTitle).parentElement!;
    fireEvent.click(within(attention).getByRole('button', { name: enUS.taskDetail.startTask }));
    await settleConfirmDialog(enUS.taskDetail.startTask);

    expect(tasksAdvanceMock).toHaveBeenCalledWith('task-010', {
      executor: 'dev',
      agentId: 'bx-dev',
    });
  });

  it('keeps the code verdict panel collapsed while QA is still reviewing', () => {
    open({ status: 'review', phase: 'code' });
    expect(screen.queryByText(enUS.taskDetail.codeVerdictTitle)).toBeNull();
    expect(screen.queryByRole('button', { name: enUS.taskDetail.codePass })).toBeNull();
    expect(screen.getByRole('button', { name: enUS.taskDetail.handleReview })).toBeTruthy();
  });

  it('opens the code verdict panel from the Handle review action', () => {
    open({ status: 'review', phase: 'code' });
    fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.handleReview }));
    expect(screen.getByText(enUS.taskDetail.codeVerdictTitle)).toBeTruthy();
    expect(screen.getByRole('button', { name: enUS.taskDetail.codePass })).toBeTruthy();
    expect(screen.queryByRole('button', { name: enUS.taskDetail.handleReview })).toBeNull();
  });

  it('collapses the code verdict panel again when the next review round starts', () => {
    const { rerender } = open({ status: 'review', phase: 'code', reviewRound: 1 });
    fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.handleReview }));
    expect(screen.getByRole('button', { name: enUS.taskDetail.codePass })).toBeTruthy();

    setTask(makeTask({ status: 'fixing', phase: 'code', reviewRound: 1 }));
    rerender(pageTree());
    setTask(makeTask({ status: 'review', phase: 'code', reviewRound: 2 }));
    rerender(pageTree());

    expect(screen.queryByRole('button', { name: enUS.taskDetail.codePass })).toBeNull();
    expect(screen.getByRole('button', { name: enUS.taskDetail.handleReview })).toBeTruthy();
  });

  it('does not offer Handle review during plan review', () => {
    open({ status: 'review', phase: 'spec' });
    expect(screen.queryByRole('button', { name: enUS.taskDetail.handleReview })).toBeNull();
    expect(screen.queryByText(enUS.taskDetail.codeVerdictTitle)).toBeNull();
  });

  it('submits a code-review pass with the optional comments through the unified endpoint', async () => {
    tasksVerdictMock.mockResolvedValue(makeTask({ status: 'review' }));
    open({ status: 'review' });
    fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.handleReview }));

    fireEvent.change(screen.getByPlaceholderText(enUS.taskDetail.codeCommentsPlaceholder), {
      target: { value: 'Validated the edge case' },
    });
    fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.codePass }));
    await settleConfirmDialog(enUS.taskDetail.codePass);

    expect(tasksVerdictMock).toHaveBeenCalledWith('task-010', {
      action: 'pass',
      comments: 'Validated the edge case',
    });
  });

  it('requires comments before submitting code-review changes', () => {
    open({ status: 'review' });
    fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.handleReview }));
    expect((screen.getByRole('button', { name: enUS.taskDetail.codeRequestChanges }) as HTMLButtonElement).disabled).toBe(true);
    expect(tasksVerdictMock).not.toHaveBeenCalled();
  });
});

describe('TaskDetail page — unassigned tasks', () => {
  it('pending unassigned task explains how to assign a dev', () => {
    setTask(makeTask({ status: 'pending', preferredAgentId: '', agentId: '', qaAgentId: undefined }));
    renderPage();
    expect(screen.getByText(enUS.taskDetail.unassignedPendingNotice)).toBeTruthy();
    expect(screen.queryByRole('button', { name: enUS.taskDetail.startTask })).toBeNull();
    expect((screen.getByRole('button', { name: enUS.taskDetail.editTask }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('opens editing instead of advancing from an unassigned pending attention action', () => {
    open({
      status: 'pending',
      preferredAgentId: '',
      agentId: '',
      qaAgentId: undefined,
      attention: {
        reason: 'delivery-not-confirmed',
        runbook: 'Retry task delivery.',
        occurredAt: '2026-05-10T12:00:00.000Z',
        recommendedActions: ['advance'],
      },
    });

    const attention = screen.getByText(enUS.taskDetail.attentionHandoffTitle).parentElement!;
    fireEvent.click(within(attention).getByRole('button', { name: enUS.taskDetail.editTask }));

    expect(screen.getByRole('dialog', { name: enUS.taskDetail.editTask })).toBeTruthy();
    expect(tasksAdvanceMock).not.toHaveBeenCalled();
  });

  it('terminal unassigned task disables running again with the unassigned tooltip', () => {
    setTask(makeTask({ status: 'cancelled', preferredAgentId: '', agentId: '', qaAgentId: undefined }));
    renderPage();
    const retry = screen.getByRole('button', { name: enUS.taskDetail.retryTask }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.title).toBe(enUS.taskDetail.retryDisabledUnassignedTitle);
  });

  it('terminal unassigned task explains the current status is read-only', () => {
    setTask(makeTask({ status: 'cancelled', preferredAgentId: '', agentId: '', qaAgentId: undefined }));
    renderPage();
    expect(screen.getByText(enUS.taskDetail.unassignedReadonlyNotice)).toBeTruthy();
  });
});

describe('TaskDetail page — PR/Branch fallbacks', () => {
  it('renders the PR number and branch as plain text when the task has no PR url', () => {
    const { container } = open({ prUrl: undefined });
    const section = container.querySelector('section')!;
    expect(within(section).queryByRole('link', { name: '#55' })).toBeNull();
    expect(within(section).getByText('#55')).toBeTruthy();
    expect(within(section).queryByRole('link', { name: 'bx/task-010' })).toBeNull();
    expect(within(section).getByText('bx/task-010')).toBeTruthy();
  });

  it.each(['javascript:alert(1)', 'not a url'])(
    'renders untrusted PR URL input as plain text: %s',
    (prUrl) => {
      const { container } = open({ prUrl });
      const section = container.querySelector('section')!;
      expect(within(section).queryByRole('link', { name: '#55' })).toBeNull();
      expect(within(section).queryByRole('link', { name: 'bx/task-010' })).toBeNull();
      expect(screen.queryByRole('link', { name: enUS.taskDetail.viewPr(55) })).toBeNull();
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
    const cards = Array.from(container.querySelectorAll('[role="article"]'));
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
    const card = container.querySelector('[role="article"]')!;
    expect(card.getAttribute('data-pending-restart')).toBe('false');
    expect(card.getAttribute('data-terminal-loading')).toBe('true');
  });

  it('shows the QA slot placeholder when the snapshotted QA no longer belongs to the team', async () => {
    await setProjects([{
      ...PROJECT,
      agent: [[
        PROJECT.agent[0][0],
        { ...PROJECT.agent[0][1], id: 'replacement-qa' },
      ]],
    }]);
    setTask(makeTask({ qaAgentId: 'retired-qa' }));
    const { container } = renderPage();
    expect(screen.getByText(enUS.taskDetail.noAgentSlot('qa'))).toBeTruthy();
    expect(container.querySelectorAll('[role="article"]')).toHaveLength(1);
  });

  it('does not attach a team QA that was not snapshotted on the task', () => {
    setTask(makeTask({ qaAgentId: 'retired-qa' }));
    const { container } = renderPage();
    expect(screen.getByText(enUS.taskDetail.noAgentSlot('qa'))).toBeTruthy();
    const cards = Array.from(container.querySelectorAll('[role="article"]'));
    expect(cards.map((card) => card.getAttribute('data-role'))).toEqual(['dev']);
  });

  it('shows the Dev slot placeholder when only the QA agent resolves via qaAgentId', async () => {
    await setProjects([{ ...PROJECT, agent: [[PROJECT.agent[0][1]]] }]);
    setTask(makeTask({ agentId: 'ghost-dev', preferredAgentId: 'ghost-dev', qaAgentId: 'bx-qa' }));
    const { container } = renderPage();
    expect(screen.getByText(enUS.taskDetail.noAgentSlot('dev'))).toBeTruthy();
    const cards = Array.from(container.querySelectorAll('[role="article"]'));
    expect(cards.map((c) => c.getAttribute('data-agent-id'))).toEqual(['bx-qa']);
  });
});
