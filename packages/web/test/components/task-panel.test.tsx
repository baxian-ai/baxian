import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TaskState } from '../../src/shared/index.js';

const { navigateMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
}));
vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());
vi.mock('../../src/components/toast.tsx', async () => (await import('../helpers/toast-mock.tsx')).createToastMock());

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigateMock,
}));

import { api } from '../../src/api.ts';
import { TaskPanel } from '../../src/components/task-panel.tsx';
import { makeTask as makeTaskFixture } from '../helpers/fixtures.ts';

const pageMock = vi.mocked(api.tasks.page);
const advanceMock = vi.mocked(api.tasks.advance);

const NOW = '2026-05-16T00:00:00.000Z';

function task(overrides: Partial<TaskState> = {}): TaskState {
  return makeTaskFixture({
    id: 'task-001',
    projectId: 'proj',
    title: 'A task',
    description: '',
    status: 'pending',
    agentId: 'dev-1',
    preferredAgentId: 'dev-1',
    reviewRound: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function emptyPage() {
  return { tasks: [], hasMore: false, nextOffset: 0 };
}

function donePage(tasks: TaskState[], extra: { hasMore?: boolean; nextOffset?: number } = {}) {
  return { tasks, hasMore: false, nextOffset: tasks.length, ...extra };
}

function mockDoneOnly(page: ReturnType<typeof donePage>): void {
  pageMock.mockImplementation(async (_p: string, opts?: { category?: string }) =>
    opts?.category === 'done' ? page : emptyPage(),
  );
}

function clickDone(): void {
  fireEvent.click(screen.getByRole('button', { name: /Finished/ }));
}

function doneCalls() {
  return pageMock.mock.calls.filter((c) => c[1]?.category === 'done');
}

function renderPanel(openTasks: TaskState[], projectId = 'proj') {
  return render(
    <MemoryRouter>
      <TaskPanel projectId={projectId} openTasks={openTasks} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  pageMock.mockReset();
  pageMock.mockResolvedValue(emptyPage());
  advanceMock.mockReset();
  navigateMock.mockReset();
});

describe('TaskPanel', () => {
  it('splits live tasks into ordered in-progress and pending sections without any REST call', () => {
    renderPanel([
      task({ id: 'task-010', status: 'in_progress', title: 'active one' }),
      task({ id: 'task-020', status: 'pending', title: 'pending one' }),
    ]);

    const activeSection = screen.getByRole('region', { name: 'In progress' });
    const pendingSection = screen.getByRole('region', { name: 'Waiting to start' });
    expect(within(activeSection).getByText('active one')).toBeTruthy();
    expect(within(pendingSection).getByText('pending one')).toBeTruthy();
    expect(activeSection.compareDocumentPosition(pendingSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pageMock).not.toHaveBeenCalled();
  });

  it('sorts pending tasks by id and in-progress tasks by most-recent update', () => {
    renderPanel([
      task({ id: 'task-003', status: 'pending' }),
      task({ id: 'task-001', status: 'pending' }),
      task({ id: 'task-002', status: 'pending' }),
      task({ id: 'task-050', status: 'in_progress', updatedAt: '2026-05-16T00:00:00Z' }),
      task({ id: 'task-051', status: 'review', updatedAt: '2026-05-18T00:00:00Z' }),
      task({ id: 'hotfix-x', status: 'fixing', updatedAt: '2026-05-20T00:00:00Z' }),
    ]);
    const pending = screen.getByRole('region', { name: 'Waiting to start' });
    expect(within(pending).getAllByText(/^\d+$/).map((el) => el.textContent)).toEqual([
      '001', '002', '003',
    ]);
    const active = screen.getByRole('region', { name: 'In progress' });
    expect(within(active).getAllByText(/^(hotfix-x|\d+)$/).map((el) => el.textContent)).toEqual([
      'hotfix-x', '051', '050',
    ]);
  });

  it('reflects live task updates and removes tasks that leave the open frame', () => {
    const { rerender } = renderPanel([
      task({ id: 'task-007', status: 'in_progress', reviewRound: 0, title: 'evolving' }),
    ]);
    const active = screen.getByRole('region', { name: 'In progress' });
    const initialRow = within(active).getByRole('button', { name: /evolving/ });
    const initialStatus = initialRow.querySelector('[data-status="in_progress"]') as HTMLElement;
    expect(within(initialRow).queryByText('Round 0')).toBeNull();
    expect(initialStatus.textContent).toBe('Developing');
    expect(initialStatus.nextElementSibling).toBeNull();

    rerender(
      <MemoryRouter>
        <TaskPanel
          projectId="proj"
          openTasks={[task({ id: 'task-007', status: 'review', reviewRound: 1, title: 'evolving' })]}
        />
      </MemoryRouter>,
    );
    const activeAfter = screen.getByRole('region', { name: 'In progress' });
    const updatedRow = within(activeAfter).getByRole('button', { name: /evolving/ });
    const updatedRound = within(updatedRow).getByText('Round 1');
    const updatedStatus = updatedRow.querySelector('[data-status="review"]') as HTMLElement;
    expect(updatedRound.compareDocumentPosition(updatedStatus) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(updatedStatus.textContent).toBe('Reviewing code');
    expect(updatedStatus.nextElementSibling).toBeNull();
    expect(activeAfter.querySelector('[data-status="in_progress"]')).toBeNull();

    rerender(
      <MemoryRouter>
        <TaskPanel projectId="proj" openTasks={[]} />
      </MemoryRouter>,
    );
    expect(screen.queryByText('evolving')).toBeNull();
  });

  it('hides a zero plan-review round and still uses the plan status label', () => {
    renderPanel([
      task({
        id: 'task-008',
        phase: 'spec',
        specReviewRound: 0,
        reviewRound: 4,
        status: 'review',
        title: 'spec flow',
      }),
    ]);

    const active = screen.getByRole('region', { name: 'In progress' });
    const row = within(active).getByRole('button', { name: /spec flow/ });
    expect(within(row).queryByText('Round 0')).toBeNull();
    expect(within(row).queryByText('Round 4')).toBeNull();
    expect(within(row).getByText('Reviewing plan')).toBeTruthy();
  });

  it('client-paginates a long section: shows 20 + Load more, then reveals the rest', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      task({ id: `task-${String(i + 1).padStart(3, '0')}`, status: 'pending' }),
    );
    renderPanel(many);
    const pending = screen.getByRole('region', { name: 'Waiting to start' });
    expect(within(pending).getAllByText(/^\d+$/).length).toBe(20);

    fireEvent.click(within(pending).getByRole('button', { name: 'Load more' }));
    expect(within(pending).getAllByText(/^\d+$/).length).toBe(25);
    expect(within(pending).queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('does NOT query the DONE section until expanded, then fetches and renders it', async () => {
    mockDoneOnly(donePage([task({ id: 'task-090', status: 'merged', title: 'shipped' })], { nextOffset: 1 }));
    renderPanel([task({ id: 'task-001', status: 'in_progress' })]);
    expect(pageMock).not.toHaveBeenCalled();

    clickDone();
    expect(await screen.findByText('shipped')).toBeTruthy();
    expect(doneCalls().some((c) => (c[1]?.offset ?? 0) === 0)).toBe(true);
  });

  it('paginates the DONE section via Load more using the server nextOffset', async () => {
    pageMock.mockImplementation(async (_p: string, opts?: { category?: string; offset?: number }) => {
      if (opts?.category !== 'done') return emptyPage();
      return (opts.offset ?? 0) === 0
        ? { tasks: [task({ id: 'task-090', status: 'merged' })], hasMore: true, nextOffset: 20 }
        : { tasks: [task({ id: 'task-070', status: 'failed' })], hasMore: false, nextOffset: 40 };
    });
    renderPanel([]);

    clickDone();
    await screen.findByText('090');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('070')).toBeTruthy();
    await waitFor(() =>
      expect(doneCalls().some((c) => c[1]?.offset === 20)).toBe(true),
    );
  });

  it('re-expanding DONE re-queries the first page (acts as a refresh)', async () => {
    pageMock.mockResolvedValue(donePage([task({ id: 'task-090', status: 'merged', title: 'shipped' })], { nextOffset: 1 }));
    renderPanel([]);

    clickDone();
    await screen.findByText('shipped');
    clickDone();
    expect(screen.queryByText('shipped')).toBeNull();
    clickDone();
    await waitFor(() => expect(doneCalls().length).toBe(2));
  });

  it('persists the DONE expand/collapse state to localStorage', async () => {
    mockDoneOnly(donePage([task({ id: 'task-090', status: 'merged', title: 'shipped' })], { nextOffset: 1 }));
    renderPanel([]);
    expect(localStorage.getItem('baxian.taskPanel.doneOpen')).toBe('0');

    clickDone();
    await waitFor(() => expect(localStorage.getItem('baxian.taskPanel.doneOpen')).toBe('1'));

    clickDone();
    await waitFor(() => expect(localStorage.getItem('baxian.taskPanel.doneOpen')).toBe('0'));
  });

  it('restores the DONE section as expanded from localStorage and auto-loads it', async () => {
    localStorage.setItem('baxian.taskPanel.doneOpen', '1');
    mockDoneOnly(donePage([task({ id: 'task-090', status: 'merged', title: 'shipped' })], { nextOffset: 1 }));
    renderPanel([]);

    expect(screen.getByRole('button', { name: /Finished/ }).getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findByText('shipped')).toBeTruthy();
    expect(doneCalls().some((c) => (c[1]?.offset ?? 0) === 0)).toBe(true);
  });

  it('keeps the DONE section collapsed by default without querying', () => {
    renderPanel([]);
    expect(screen.getByRole('button', { name: /Finished/ }).getAttribute('aria-expanded')).toBe('false');
    expect(pageMock).not.toHaveBeenCalled();
  });

  it('surfaces a DONE section load error instead of failing silently', async () => {
    pageMock.mockImplementation(async (_p: string, opts?: { category?: string }) => {
      if (opts?.category === 'done') throw new Error('boom');
      return emptyPage();
    });
    renderPanel([]);
    clickDone();
    expect(await screen.findByText(/Failed to load: boom/)).toBeTruthy();
  });

  it('uses the compact panel chrome and keeps the header/close control outside the panel', () => {
    renderPanel([task({ id: 'task-001', status: 'in_progress' })]);
    expect(screen.getByRole('region', { name: 'In progress' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Waiting to start' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Finished/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Refresh task list' })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ New task' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Tasks' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close task panel' })).toBeNull();
  });

  it('renders the section titles in normal weight, not bold', () => {
    renderPanel([task({ id: 'task-001', status: 'in_progress' })]);
    for (const name of ['In progress', 'Waiting to start']) {
      const title = screen.getByRole('region', { name }).firstElementChild as HTMLElement;
      expect(title.textContent).toContain(name);
      expect(title.className).toContain('font-normal');
      expect(title.className).not.toContain('font-semibold');
    }
    const done = screen.getByRole('button', { name: /Finished/ });
    expect(done.className).toContain('font-normal');
    expect(done.className).not.toContain('font-semibold');
  });

  it('renders each live status as a readable colored pill', () => {
    const { container } = renderPanel([
      task({ id: 'task-001', status: 'in_progress' }),
      task({ id: 'task-002', status: 'review' }),
      task({ id: 'task-003', status: 'fixing' }),
      task({ id: 'task-004', status: 'approved' }),
      task({ id: 'task-005', status: 'pending' }),
    ]);
    expect((container.querySelector('[data-status="in_progress"]') as HTMLElement).className).toContain('pill-live');
    expect((container.querySelector('[data-status="review"]') as HTMLElement).className).toContain('pill-review');
    expect((container.querySelector('[data-status="fixing"]') as HTMLElement).className).toContain('pill-warn');
    expect((container.querySelector('[data-status="approved"]') as HTMLElement).className).toContain('pill-live');
    const pendingBadge = container.querySelector('[data-status="pending"]') as HTMLElement;
    expect(pendingBadge.className).toContain('pill');
    expect(pendingBadge.textContent).toBe('Waiting to start');
    expect(pendingBadge.getAttribute('title')).toBe('Waiting to start');
  });

  it('colors terminal status pills by outcome', async () => {
    mockDoneOnly(donePage([
      task({ id: 'task-090', status: 'merged' }),
      task({ id: 'task-091', status: 'max_rounds' }),
      task({ id: 'task-092', status: 'failed' }),
      task({ id: 'task-093', status: 'cancelled' }),
    ]));
    renderPanel([]);
    clickDone();
    expect((await screen.findByText('PR merged')).className).toContain('pill-live');
    expect(screen.getByText('Code review needs a decision').className).toContain('pill-warn');
    expect(screen.getByText('Couldn’t complete').className).toContain('pill-danger');
    expect(screen.getByText('Cancelled').className).toContain('pill');
  });

  it('gives the DONE divider the same hairline as the live sections', () => {
    renderPanel([task({ id: 'task-001', status: 'in_progress' })]);
    const doneWrapper = screen.getByRole('button', { name: /Finished/ }).parentElement!;
    expect(doneWrapper.className).not.toContain('border-t-2');
    const pending = screen.getByRole('region', { name: 'Waiting to start' });
    expect(pending.className).toContain('border-b');
    expect(pending.className).toContain('border-hairline');
  });

  it('grows with content instead of painting its own vertical scrollbar', () => {
    const panel = renderPanel([task({ id: 'task-001', status: 'in_progress' })])
      .getByRole('complementary', { name: 'Task panel' });
    expect(panel.className).not.toContain('overflow-y-auto');
    expect(panel.className).not.toContain('max-h-');
    expect(panel.querySelector('.overflow-y-auto')).toBeNull();
  });

  it('clicking a task row navigates to its detail page', () => {
    renderPanel([task({ id: 'task-042', status: 'in_progress', title: 'pick me' })]);
    const active = screen.getByRole('region', { name: 'In progress' });
    fireEvent.click(within(active).getByRole('button', { name: /pick me/ }));
    expect(navigateMock).toHaveBeenCalledWith('/project/proj/task/task-042');
  });

  it('shortens the task id to its number and keeps the full id as hover text', () => {
    renderPanel([task({ id: 'task-042', status: 'in_progress', title: 'pick me' })]);
    const active = screen.getByRole('region', { name: 'In progress' });
    const idCell = within(active).getByText('042');
    expect(idCell.getAttribute('title')).toBe('task-042');
    expect(within(active).queryByText('task-042')).toBeNull();
  });

  describe('persistent attention', () => {
    function attentiveTask(actions: NonNullable<TaskState['attention']>['recommendedActions']) {
      return task({
        id: 'task-100',
        status: 'review',
        title: 'stuck',
        prNumber: 42,
        deliveryConfirmation: { phase: 'code', source: 'signal', at: NOW },
        attention: {
          reason: 'review-verdict-overdue',
          runbook: 'Inspect the current QA review.',
          occurredAt: '2026-06-19T12:00:00Z',
          recommendedActions: actions,
        },
      });
    }

    it('shows friendly guidance while keeping the durable reason and runbook in technical details', () => {
      renderPanel([attentiveTask(['advance', 'verdict', 'cancel', 'retry'])]);

      expect(screen.getByText('Review needs your attention')).toBeTruthy();
      expect(screen.getByText('Review the PR and the discussion below, then confirm the result or request changes.')).toBeTruthy();
      const details = screen.getByText('Technical details').closest('details')!;
      expect(details.hasAttribute('open')).toBe(false);
      expect(within(details).getByText(/review-verdict-overdue/)).toBeTruthy();
      expect(within(details).getByText(/Inspect the current QA review/)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Restart review' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Handle review' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Cancel task' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Run task again' })).toBeTruthy();
    });

    it('runs Advance directly and keeps the task detail route for the other operations', async () => {
      advanceMock.mockResolvedValue(attentiveTask(['advance', 'verdict']));
      renderPanel([attentiveTask(['advance', 'verdict'])]);

      fireEvent.click(screen.getByRole('button', { name: 'Restart review' }));
      await waitFor(() => expect(advanceMock).toHaveBeenCalledWith('task-100'));
      expect(navigateMock).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Handle review' }));
      expect(navigateMock).toHaveBeenCalledWith('/project/proj/task/task-100');
    });

    it('opens task detail when Advance requires revoked-pass confirmation', () => {
      renderPanel([{
        ...attentiveTask(['advance']),
        status: 'approved',
        postApproveRevoked: {
          generation: 'feedfeedfeed',
          reason: 'redispatch-cap',
          at: NOW,
        },
      }]);

      fireEvent.click(screen.getByRole('button', { name: 'Retry pre-merge checks' }));

      expect(advanceMock).not.toHaveBeenCalled();
      expect(navigateMock).toHaveBeenCalledWith('/project/proj/task/task-100');
    });

    it('opens task detail instead of dispatching an unassigned pending task', () => {
      renderPanel([{
        ...attentiveTask(['advance']),
        status: 'pending',
        agentId: '',
        preferredAgentId: '',
      }]);

      fireEvent.click(screen.getByRole('button', { name: 'Edit task' }));

      expect(advanceMock).not.toHaveBeenCalled();
      expect(navigateMock).toHaveBeenCalledWith('/project/proj/task/task-100');
    });
  });
});
