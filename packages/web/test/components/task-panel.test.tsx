import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TaskState } from '../../src/shared/index.js';
import { REVIEW_VERDICT_TIMEOUT_MS } from '../../src/shared/index.js';

const { pageMock, navigateMock } = vi.hoisted(() => ({
  pageMock: vi.fn(),
  navigateMock: vi.fn(),
}));
vi.mock('../../src/api.ts', () => ({
  UNAUTHORIZED_EVENT: 'baxian:unauthorized',
  api: { tasks: { page: pageMock } },
}));

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigateMock,
}));

import { TaskPanel } from '../../src/components/task-panel.tsx';

const NOW = '2026-05-16T00:00:00.000Z';

function task(overrides: Partial<TaskState> = {}): TaskState {
  return {
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
  } as TaskState;
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
  fireEvent.click(screen.getByRole('button', { name: /DONE/ }));
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
  pageMock.mockReset();
  pageMock.mockResolvedValue(emptyPage());
  navigateMock.mockReset();
});

describe('TaskPanel', () => {
  it('splits live tasks into ordered in-progress and pending sections without any REST call', () => {
    renderPanel([
      task({ id: 'task-010', status: 'in_progress', title: 'active one' }),
      task({ id: 'task-020', status: 'pending', title: 'pending one' }),
    ]);

    const activeSection = screen.getByRole('region', { name: 'IN PROGRESS' });
    const pendingSection = screen.getByRole('region', { name: 'PENDING' });
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
    const pending = screen.getByRole('region', { name: 'PENDING' });
    expect(within(pending).getAllByText(/^\d+$/).map((el) => el.textContent)).toEqual([
      '001', '002', '003',
    ]);
    const active = screen.getByRole('region', { name: 'IN PROGRESS' });
    expect(within(active).getAllByText(/^(hotfix-x|\d+)$/).map((el) => el.textContent)).toEqual([
      'hotfix-x', '051', '050',
    ]);
  });

  it('reflects live task updates and removes tasks that leave the open frame', () => {
    const { rerender } = renderPanel([
      task({ id: 'task-007', status: 'in_progress', reviewRound: 0, title: 'evolving' }),
    ]);
    const active = screen.getByRole('region', { name: 'IN PROGRESS' });
    const initialRow = within(active).getByRole('button', { name: /evolving/ });
    const initialRound = within(initialRow).getByText('R0');
    const initialDot = within(initialRow).getByRole('img', { name: 'in_progress' });
    expect(initialRound.compareDocumentPosition(initialDot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(initialDot.nextElementSibling).toBeNull();

    rerender(
      <MemoryRouter>
        <TaskPanel
          projectId="proj"
          openTasks={[task({ id: 'task-007', status: 'review', reviewRound: 1, title: 'evolving' })]}
        />
      </MemoryRouter>,
    );
    const activeAfter = screen.getByRole('region', { name: 'IN PROGRESS' });
    const updatedRow = within(activeAfter).getByRole('button', { name: /evolving/ });
    const updatedRound = within(updatedRow).getByText('R1');
    const updatedDot = within(updatedRow).getByRole('img', { name: 'review' });
    expect(updatedRound.compareDocumentPosition(updatedDot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(updatedDot.nextElementSibling).toBeNull();
    expect(within(activeAfter).queryByRole('img', { name: 'in_progress' })).toBeNull();

    rerender(
      <MemoryRouter>
        <TaskPanel projectId="proj" openTasks={[]} />
      </MemoryRouter>,
    );
    expect(screen.queryByText('evolving')).toBeNull();
  });

  it('shows zero spec review round before the rightmost status dot', () => {
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

    const active = screen.getByRole('region', { name: 'IN PROGRESS' });
    const row = within(active).getByRole('button', { name: /spec flow/ });
    const round = within(row).getByText('R0');
    const dot = within(row).getByRole('img', { name: 'review' });
    expect(within(row).getByText('spec')).toBeTruthy();
    expect(within(row).queryByText('R4')).toBeNull();
    expect(round.compareDocumentPosition(dot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dot.nextElementSibling).toBeNull();
  });

  it('client-paginates a long section: shows 20 + 加载更多, then reveals the rest', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      task({ id: `task-${String(i + 1).padStart(3, '0')}`, status: 'pending' }),
    );
    renderPanel(many);
    const pending = screen.getByRole('region', { name: 'PENDING' });
    expect(within(pending).getAllByText(/^\d+$/).length).toBe(20);

    fireEvent.click(within(pending).getByRole('button', { name: '加载更多' }));
    expect(within(pending).getAllByText(/^\d+$/).length).toBe(25);
    expect(within(pending).queryByRole('button', { name: '加载更多' })).toBeNull();
  });

  it('does NOT query 已处理 until expanded, then fetches and renders it', async () => {
    mockDoneOnly(donePage([task({ id: 'task-090', status: 'merged', title: 'shipped' })], { nextOffset: 1 }));
    renderPanel([task({ id: 'task-001', status: 'in_progress' })]);
    expect(pageMock).not.toHaveBeenCalled();

    clickDone();
    expect(await screen.findByText('shipped')).toBeTruthy();
    expect(doneCalls().some((c) => (c[1]?.offset ?? 0) === 0)).toBe(true);
  });

  it('paginates 已处理 via 加载更多 using the server nextOffset', async () => {
    pageMock.mockImplementation(async (_p: string, opts?: { category?: string; offset?: number }) => {
      if (opts?.category !== 'done') return emptyPage();
      return (opts.offset ?? 0) === 0
        ? { tasks: [task({ id: 'task-090', status: 'merged' })], hasMore: true, nextOffset: 20 }
        : { tasks: [task({ id: 'task-070', status: 'failed' })], hasMore: false, nextOffset: 40 };
    });
    renderPanel([]);

    clickDone();
    await screen.findByText('090');
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    expect(await screen.findByText('070')).toBeTruthy();
    await waitFor(() =>
      expect(doneCalls().some((c) => c[1]?.offset === 20)).toBe(true),
    );
  });

  it('re-expanding 已处理 re-queries the first page (acts as a refresh)', async () => {
    pageMock.mockResolvedValue(donePage([task({ id: 'task-090', status: 'merged', title: 'shipped' })], { nextOffset: 1 }));
    renderPanel([]);

    clickDone();
    await screen.findByText('shipped');
    clickDone();
    expect(screen.queryByText('shipped')).toBeNull();
    clickDone();
    await waitFor(() => expect(doneCalls().length).toBe(2));
  });

  it('surfaces a 已处理 load error instead of failing silently', async () => {
    pageMock.mockImplementation(async (_p: string, opts?: { category?: string }) => {
      if (opts?.category === 'done') throw new Error('boom');
      return emptyPage();
    });
    renderPanel([]);
    clickDone();
    expect(await screen.findByText(/加载失败：boom/)).toBeTruthy();
  });

  it('uses the compact panel chrome and keeps the header/close control outside the panel', () => {
    renderPanel([task({ id: 'task-001', status: 'in_progress' })]);
    expect(screen.getByRole('region', { name: 'IN PROGRESS' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'PENDING' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /DONE/ })).toBeTruthy();
    expect(screen.queryByRole('region', { name: '正在处理' })).toBeNull();
    expect(screen.queryByRole('region', { name: '待处理' })).toBeNull();
    expect(screen.queryByRole('button', { name: '刷新 Task 列表' })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ 新建 Task' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Tasks' })).toBeNull();
    expect(screen.queryByRole('button', { name: '关闭 Task 面板' })).toBeNull();
  });

  it('renders the section titles in normal weight, not bold', () => {
    renderPanel([task({ id: 'task-001', status: 'in_progress' })]);
    for (const name of ['IN PROGRESS', 'PENDING']) {
      const title = screen.getByRole('region', { name }).firstElementChild as HTMLElement;
      expect(title.textContent).toContain(name);
      expect(title.className).toContain('font-normal');
      expect(title.className).not.toContain('font-semibold');
    }
    const done = screen.getByRole('button', { name: /DONE/ });
    expect(done.className).toContain('font-normal');
    expect(done.className).not.toContain('font-semibold');
  });

  it('renders each live status as a colored dot whose label is the status (hover text)', () => {
    renderPanel([
      task({ id: 'task-001', status: 'in_progress' }),
      task({ id: 'task-002', status: 'review' }),
      task({ id: 'task-003', status: 'fixing' }),
      task({ id: 'task-004', status: 'approved' }),
      task({ id: 'task-005', status: 'pending' }),
    ]);
    expect(screen.queryByText('in_progress')).toBeNull();
    expect(screen.getByRole('img', { name: 'in_progress' }).className).toContain('bg-success');
    expect(screen.getByRole('img', { name: 'review' }).className).toContain('bg-accent');
    expect(screen.getByRole('img', { name: 'fixing' }).className).toContain('bg-warn');
    expect(screen.getByRole('img', { name: 'approved' }).className).toContain('bg-success');
    const pendingDot = screen.getByRole('img', { name: 'pending' });
    expect(pendingDot.className).toContain('bg-og-300');
    expect(pendingDot.getAttribute('title')).toBe('pending');
  });

  it('colors terminal DONE status dots by outcome', async () => {
    mockDoneOnly(donePage([
      task({ id: 'task-090', status: 'merged' }),
      task({ id: 'task-091', status: 'max_rounds' }),
      task({ id: 'task-092', status: 'failed' }),
      task({ id: 'task-093', status: 'cancelled' }),
    ]));
    renderPanel([]);
    clickDone();
    expect((await screen.findByRole('img', { name: 'merged' })).className).toContain('bg-success');
    expect(screen.getByRole('img', { name: 'max_rounds' }).className).toContain('bg-warn');
    expect(screen.getByRole('img', { name: 'failed' }).className).toContain('bg-warn');
    expect(screen.getByRole('img', { name: 'cancelled' }).className).toContain('bg-og-300');
  });

  it('gives the DONE divider the same hairline as the live sections', () => {
    renderPanel([task({ id: 'task-001', status: 'in_progress' })]);
    const doneWrapper = screen.getByRole('button', { name: /DONE/ }).parentElement!;
    expect(doneWrapper.className).not.toContain('border-t-2');
    const pending = screen.getByRole('region', { name: 'PENDING' });
    expect(pending.className).toContain('border-b');
    expect(pending.className).toContain('border-hairline');
  });

  it('grows with content instead of painting its own vertical scrollbar', () => {
    const panel = renderPanel([task({ id: 'task-001', status: 'in_progress' })])
      .getByRole('complementary', { name: 'Task 面板' });
    expect(panel.className).not.toContain('overflow-y-auto');
    expect(panel.className).not.toContain('max-h-');
    expect(panel.querySelector('.overflow-y-auto')).toBeNull();
  });

  it('clicking a task row navigates to its detail page', () => {
    renderPanel([task({ id: 'task-042', status: 'in_progress', title: 'pick me' })]);
    const active = screen.getByRole('region', { name: 'IN PROGRESS' });
    fireEvent.click(within(active).getByRole('button', { name: /pick me/ }));
    expect(navigateMock).toHaveBeenCalledWith('/project/proj/task/task-042');
  });

  it('shortens the task id to its number and keeps the full id as hover text', () => {
    renderPanel([task({ id: 'task-042', status: 'in_progress', title: 'pick me' })]);
    const active = screen.getByRole('region', { name: 'IN PROGRESS' });
    const idCell = within(active).getByText('042');
    expect(idCell.getAttribute('title')).toBe('task-042');
    expect(within(active).queryByText('task-042')).toBeNull();
  });

  describe('verdict overdue indicator', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    function renderVerdictTask(dispatchOffset: number, overrides: Partial<TaskState>): void {
      const now = new Date('2026-06-19T12:00:00Z').getTime();
      vi.setSystemTime(now);
      renderPanel([task({
        ...overrides,
        reviewDispatchedAt: new Date(now + dispatchOffset).toISOString(),
      })]);
    }

    it('shows ! after the timeout threshold elapses via interval tick', () => {
      renderVerdictTask(-REVIEW_VERDICT_TIMEOUT_MS + 60_000, {
        id: 'task-100', status: 'review', title: 'stuck', qaAgentId: 'qa-1',
      });

      expect(screen.queryByTitle('Review verdict missing')).toBeNull();

      act(() => { vi.advanceTimersByTime(90_000); });

      expect(screen.getByTitle('Review verdict missing')).toBeTruthy();
    });

    it.each([
      { name: 'within the timeout window', dispatchOffset: -60_000, overrides: { id: 'task-101', status: 'review', title: 'fresh', qaAgentId: 'qa-1' } },
      { name: 'non-review status even if dispatched long ago', dispatchOffset: -REVIEW_VERDICT_TIMEOUT_MS - 60_000, overrides: { id: 'task-102', status: 'in_progress', title: 'not reviewing', qaAgentId: 'qa-1' } },
      { name: 'qaAgentId is missing', dispatchOffset: -REVIEW_VERDICT_TIMEOUT_MS - 60_000, overrides: { id: 'task-103', status: 'review', title: 'no qa' } },
    ])('stays hidden when $name', ({ dispatchOffset, overrides }) => {
      renderVerdictTask(dispatchOffset, overrides as Partial<TaskState>);

      act(() => { vi.advanceTimersByTime(30_000); });

      expect(screen.queryByTitle('Review verdict missing')).toBeNull();
    });
  });
});
