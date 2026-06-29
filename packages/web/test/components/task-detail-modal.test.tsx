import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TaskState, TaskStatus } from '../../src/shared/index.js';

const { useProjectsMock, useTaskMock } = vi.hoisted(() => ({
  useProjectsMock: vi.fn(),
  useTaskMock: vi.fn(),
}));

vi.mock('../../src/hooks/use-events.ts', () => ({
  useTask: useTaskMock,
}));

vi.mock('../../src/hooks/use-projects.ts', () => ({
  useProjects: useProjectsMock,
}));

vi.mock('../../src/components/toast.tsx', () => ({
  useToast: () => ({ show: vi.fn() }),
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

import {
  TaskDetailProvider,
  TaskStatusDot,
  shortTaskId,
  useTaskDetail,
} from '../../src/components/task-detail-modal.tsx';

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

function Opener({ taskId }: { taskId: string }) {
  const { openTask } = useTaskDetail();
  return <button type="button" onClick={() => openTask(taskId)}>open-{taskId}</button>;
}

function setTasks(tasks: Record<string, TaskState>): void {
  useTaskMock.mockImplementation((id: string) => ({
    data: tasks[id] ?? null,
    loaded: true,
    error: null,
  }));
}

function openDetail(overrides: Partial<TaskState> = {}): void {
  setTasks({ 'task-010': makeTask(overrides) });
  render(
    <MemoryRouter>
      <TaskDetailProvider><Opener taskId="task-010" /></TaskDetailProvider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'open-task-010' }));
}

beforeEach(() => {
  cleanup();
  useProjectsMock.mockReset();
  useProjectsMock.mockReturnValue({
    projects: [{
      id: 'baxian',
      repo: 'baxian-ai/baxian',
      merge: null,
      agent: [[
        { id: 'bx-dev', runtime: 'claude-code', role: 'dev', mode: 'local' },
        { id: 'bx-qa', runtime: 'codex', role: 'qa', mode: 'local' },
      ]],
    }],
    error: null,
    refresh: vi.fn(),
  });
  useTaskMock.mockReset();
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

describe('TaskDetailProvider / useTaskDetail', () => {
  it('throws a helpful error when useTaskDetail is used without a provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Opener taskId="task-001" />)).toThrow(/TaskDetailProvider/);
    spy.mockRestore();
  });

  it('does not render any dialog until a task is opened', () => {
    setTasks({ 'task-010': makeTask() });
    render(<TaskDetailProvider><Opener taskId="task-010" /></TaskDetailProvider>);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens a modal with the task title, status, description and meta when openTask fires', () => {
    openDetail({ title: 'Clean tests' });

    const dialog = screen.getByRole('dialog', { name: 'task-010 Clean tests' });
    const titleId = within(dialog).getByText('task-010');
    expect(titleId.className).toContain('text-og-400');
    expect(dialog.textContent).toContain('approved');
    expect(within(dialog).getByText('approved').className).toContain('pill');
    expect(dialog.textContent).toContain('Created at 2026-05-10 12:00:00, Updated at 2026-05-10 13:00:00');
    expect(dialog.textContent).toContain('Task body here');
    expect(dialog.textContent).toContain('Project: baxian');
    expect(dialog.textContent).toContain('Round: 1 spec: 0');
    expect(dialog.textContent).not.toContain('Preferred:');
    expect(dialog.textContent).toContain('Branch:');
  });

  it('shows runtime labels next to task agent names and exposes runtime hover text', () => {
    openDetail();

    const devNames = screen.getAllByText('bx-dev');
    expect(devNames.map(el => el.parentElement?.getAttribute('title'))).toEqual(['bx-dev (Claude Code)']);
    expect(screen.getByText('bx-qa').parentElement?.getAttribute('title')).toBe('bx-qa (Codex)');
    expect(screen.getAllByText('(Claude Code)')).toHaveLength(1);
    expect(screen.getByText('(Codex)').className).toContain('text-og-400');
    expect(screen.getByText('(Codex)').className).toContain('sm:inline');
  });

  it('keeps Round and spec metadata visually consistent when specReviewRound is present', async () => {
    openDetail({ specReviewRound: 3 });
    await act(async () => {});

    const dialog = screen.getByRole('dialog', { name: 'task-010 Clean tests' });
    const roundMeta = within(dialog).getByText((_, el) => el?.textContent === 'Round: 1 spec: 3');
    expect(roundMeta.className).toContain('text-og-500');
    expect(within(roundMeta).getByText('1').className).toBe(within(roundMeta).getByText('3').className);
  });

  it('falls back to the raw timestamp when the task timestamp is not parseable', () => {
    openDetail({ createdAt: 'not-a-date', updatedAt: '2026-05-10T13:00:00Z' });

    expect(screen.getByText('Created at not-a-date, Updated at 2026-05-10 13:00:00')).toBeTruthy();
  });

  it('formats timestamps without seconds without applying timezone conversion', () => {
    openDetail({ createdAt: '2026-05-10T13:00+08:00', updatedAt: '2026-05-10 14:30+08:00' });

    expect(screen.getByText('Created at 2026-05-10 13:00:00, Updated at 2026-05-10 14:30:00')).toBeTruthy();
  });

  it('does not crash when timestamp fields are empty at runtime', () => {
    openDetail({ createdAt: null as unknown as string, updatedAt: undefined as unknown as string });

    expect(screen.getByText('Created at , Updated at')).toBeTruthy();
  });

  const QA_BANNER = 'QA approved · verifying feedback';
  const MERGE_BANNER = '✅ PR ready · 等待人工确认';
  it.each([
    { name: 'QA-approved (verifying feedback)', status: 'approved', shown: QA_BANNER, hidden: MERGE_BANNER },
    { name: 'ready-to-merge', status: 'merge-ready', shown: MERGE_BANNER, hidden: QA_BANNER },
  ])('shows the $name banner with a working PR link', ({ status, shown, hidden }) => {
    openDetail({ status: status as TaskState['status'] });

    expect(screen.getByText(shown)).toBeTruthy();
    expect(screen.queryByText(hidden)).toBeNull();
    const link = screen.getByRole('link', { name: 'Open PR #55' });
    expect(link.getAttribute('href')).toBe('https://github.com/baxian-ai/baxian/pull/55');
  });

  it('closes the modal via the close button', () => {
    openDetail();
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Retry creates a fresh task and switches the modal to it', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    setTasks({
      'task-010': makeTask({ id: 'task-010', status: 'merged', title: 'old one' }),
      'task-011': makeTask({ id: 'task-011', status: 'pending', title: 'new one' }),
    });
    tasksRetryMock.mockResolvedValue(makeTask({ id: 'task-011', status: 'pending', title: 'new one' }));

    render(<TaskDetailProvider><Opener taskId="task-010" /></TaskDetailProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'open-task-010' }));
    expect(screen.getByRole('dialog', { name: 'task-010 old one' })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    expect(tasksRetryMock).toHaveBeenCalledWith('task-010');
    expect(await screen.findByRole('dialog', { name: 'task-011 new one' })).toBeTruthy();
  });

  it('opening Edit swaps to the edit form so the two modals never stack', () => {
    openDetail({ status: 'pending' });

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByTestId('edit-modal')).toBeTruthy();
    // The detail dialog is unmounted while editing — only one focus trap at a time.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  describe('max_rounds actions', () => {
    function openMaxRounds(overrides: Partial<TaskState> = {}): void {
      openDetail({ status: 'max_rounds', reviewRound: 10, ...overrides });
    }

    it('code-phase max_rounds shows 标记完成 / 继续一轮 / Call review and the warning, hides Retry', () => {
      openMaxRounds();
      expect(screen.getByRole('button', { name: '标记完成' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '继续一轮' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Call review' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
      expect(screen.getByRole('dialog').textContent).toContain('已达 review 轮次上限');
      expect(screen.getByRole('dialog').textContent).toContain('建议先合并本次成果');
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

    it('spec-phase max_rounds shows Retry, hides the new actions and Call review', () => {
      openMaxRounds({ phase: 'spec' });
      expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: '标记完成' })).toBeNull();
      expect(screen.queryByRole('button', { name: '继续一轮' })).toBeNull();
      const review = screen.getByRole('button', { name: 'Call review' }) as HTMLButtonElement;
      expect(review.disabled).toBe(true);
    });

    it('spec-phase max_rounds shows the spec banner (not the code one) with round + review digest', async () => {
      tasksReviewsMock.mockResolvedValue([
        { round: 1, phase: 'spec', findings: { round: 1, verdict: 'request-changes', findings: [{ id: 'f-1', severity: 'major', location: 'S1', message: 'gap' }] } },
        { round: 2, phase: 'spec', findings: { round: 2, verdict: 'request-changes', findings: [] } },
      ]);
      openMaxRounds({ phase: 'spec', specReviewRound: 2 });
      await act(async () => {});
      const text = screen.getByRole('dialog').textContent ?? '';
      expect(text).toContain('已达 spec review 轮次上限（round 2）');
      expect(text).toContain('细化任务描述后再 Retry');
      expect(text).not.toContain('已达 review 轮次上限');
      expect(text).toContain('Review 2 轮');
      expect(text).toContain('request-changes');
    });

    it('code-phase max_rounds does not show the spec banner', () => {
      openMaxRounds();
      const text = screen.getByRole('dialog').textContent ?? '';
      expect(text).toContain('已达 review 轮次上限');
      expect(text).not.toContain('已达 spec review 轮次上限');
    });

    it('max_rounds is cancellable', () => {
      openMaxRounds();
      const cancel = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
      expect(cancel.disabled).toBe(false);
    });
  });
});

describe('shortTaskId', () => {
  it('strips the task- prefix down to the number, preserving zero padding', () => {
    expect(shortTaskId('task-001')).toBe('001');
    expect(shortTaskId('task-42')).toBe('42');
  });

  it('leaves ids that are not the canonical task-<number> form untouched', () => {
    expect(shortTaskId('hotfix-x')).toBe('hotfix-x');
    expect(shortTaskId('task-abc')).toBe('task-abc');
    expect(shortTaskId('task-12a')).toBe('task-12a');
    expect(shortTaskId('')).toBe('');
  });

  it('returns "" instead of crashing on malformed (null/undefined) ids', () => {
    expect(shortTaskId(null as unknown as string)).toBe('');
    expect(shortTaskId(undefined as unknown as string)).toBe('');
  });
});

describe('TaskStatusDot', () => {
  it('renders an img-role dot whose label and title are the status (hover text)', () => {
    render(<TaskStatusDot status="review" />);
    const dot = screen.getByRole('img', { name: 'review' });
    expect(dot.getAttribute('title')).toBe('review');
    expect(dot.className).toContain('rounded-full');
  });

  it('maps every status to a color, sharing one color across same-semantic statuses', () => {
    const cases: Array<[Parameters<typeof TaskStatusDot>[0]['status'], string]> = [
      ['pending', 'bg-og-300'],
      ['cancelled', 'bg-og-300'],
      ['in_progress', 'bg-success'],
      ['approved', 'bg-success'],
      ['merge-ready', 'bg-success'],
      ['merged', 'bg-success'],
      ['review', 'bg-accent'],
      ['fixing', 'bg-warn'],
      ['failed', 'bg-warn'],
      ['max_rounds', 'bg-warn'],
    ];
    for (const [status, cls] of cases) {
      cleanup();
      render(<TaskStatusDot status={status} />);
      expect(screen.getByRole('img', { name: status }).className).toContain(cls);
    }
  });

  it('falls back to a visible grey dot for an unknown status (still labeled via hover)', () => {
    render(<TaskStatusDot status={'whatever' as TaskStatus} />);
    const dot = screen.getByRole('img', { name: 'whatever' });
    expect(dot.className).toContain('bg-og-300');
    expect(dot.getAttribute('title')).toBe('whatever');
  });
});
