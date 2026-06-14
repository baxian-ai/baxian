import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TaskState } from '../../src/shared/index.js';

const { pageMock, openTaskMock } = vi.hoisted(() => ({
  pageMock: vi.fn(),
  openTaskMock: vi.fn(),
}));
vi.mock('../../src/api.ts', () => ({
  UNAUTHORIZED_EVENT: 'baxian:unauthorized',
  api: { tasks: { page: pageMock } },
}));

vi.mock('../../src/components/task-detail-modal.tsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/components/task-detail-modal.tsx')>();
  return { ...actual, useTaskDetail: () => ({ openTask: openTaskMock }) };
});

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

function renderPanel(
  openTasks: TaskState[],
  handlers: { onClose?: () => void } = {},
  projectId = 'proj',
) {
  return render(
    <MemoryRouter>
      <TaskPanel
        projectId={projectId}
        openTasks={openTasks}
        onClose={handlers.onClose ?? vi.fn()}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cleanup();
  pageMock.mockReset();
  pageMock.mockResolvedValue(emptyPage());
  openTaskMock.mockReset();
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

    // Simulate a WS frame: same task advanced to review, round 1.
    rerender(
      <MemoryRouter>
        <TaskPanel
          projectId="proj"
          openTasks={[task({ id: 'task-007', status: 'review', reviewRound: 1, title: 'evolving' })]}
          onClose={vi.fn()}
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
        <TaskPanel projectId="proj" openTasks={[]} onClose={vi.fn()} />
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
    pageMock.mockImplementation(async (_p: string, opts?: { category?: string }) =>
      opts?.category === 'done'
        ? { tasks: [task({ id: 'task-090', status: 'merged', title: 'shipped' })], hasMore: false, nextOffset: 1 }
        : emptyPage(),
    );
    renderPanel([task({ id: 'task-001', status: 'in_progress' })]);
    expect(pageMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /DONE/ }));
    expect(await screen.findByText('shipped')).toBeTruthy();
    expect(pageMock.mock.calls.some((c) => c[1]?.category === 'done' && (c[1]?.offset ?? 0) === 0)).toBe(true);
  });

  it('paginates 已处理 via 加载更多 using the server nextOffset', async () => {
    pageMock.mockImplementation(async (_p: string, opts?: { category?: string; offset?: number }) => {
      if (opts?.category !== 'done') return emptyPage();
      return (opts.offset ?? 0) === 0
        ? { tasks: [task({ id: 'task-090', status: 'merged' })], hasMore: true, nextOffset: 20 }
        : { tasks: [task({ id: 'task-070', status: 'failed' })], hasMore: false, nextOffset: 40 };
    });
    renderPanel([]);

    fireEvent.click(screen.getByRole('button', { name: /DONE/ }));
    await screen.findByText('090');
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    expect(await screen.findByText('070')).toBeTruthy();
    await waitFor(() =>
      expect(pageMock.mock.calls.some((c) => c[1]?.category === 'done' && c[1]?.offset === 20)).toBe(true),
    );
  });

  it('re-expanding 已处理 re-queries the first page (acts as a refresh)', async () => {
    pageMock.mockResolvedValue({
      tasks: [task({ id: 'task-090', status: 'merged', title: 'shipped' })],
      hasMore: false,
      nextOffset: 1,
    });
    renderPanel([]);

    fireEvent.click(screen.getByRole('button', { name: /DONE/ }));
    await screen.findByText('shipped');
    fireEvent.click(screen.getByRole('button', { name: /DONE/ })); // collapse
    expect(screen.queryByText('shipped')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /DONE/ })); // expand again
    await waitFor(() =>
      expect(pageMock.mock.calls.filter((c) => c[1]?.category === 'done').length).toBe(2),
    );
  });

  it('surfaces a 已处理 load error instead of failing silently', async () => {
    pageMock.mockImplementation(async (_p: string, opts?: { category?: string }) => {
      if (opts?.category === 'done') throw new Error('boom');
      return emptyPage();
    });
    renderPanel([]);
    fireEvent.click(screen.getByRole('button', { name: /DONE/ }));
    expect(await screen.findByText(/加载失败：boom/)).toBeTruthy();
  });

  it('uses the compact panel chrome and wires the close control', () => {
    const onClose = vi.fn();
    renderPanel([task({ id: 'task-001', status: 'in_progress' })]);
    expect(screen.getByRole('region', { name: 'IN PROGRESS' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'PENDING' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /DONE/ })).toBeTruthy();
    expect(screen.queryByRole('region', { name: '正在处理' })).toBeNull();
    expect(screen.queryByRole('region', { name: '待处理' })).toBeNull();
    expect(screen.queryByRole('button', { name: '刷新 Task 列表' })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ 新建 Task' })).toBeNull();

    cleanup();
    renderPanel([], { onClose });
    fireEvent.click(screen.getByRole('button', { name: '关闭 Task 面板' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders each live status as a colored dot whose label is the status (hover text)', () => {
    renderPanel([
      task({ id: 'task-001', status: 'in_progress' }),
      task({ id: 'task-002', status: 'review' }),
      task({ id: 'task-003', status: 'fixing' }),
      task({ id: 'task-004', status: 'approved' }),
      task({ id: 'task-005', status: 'pending' }),
    ]);
    // No status text in the row anymore — the pill collapsed to a dot, status moved to hover.
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
    pageMock.mockImplementation(async (_p: string, opts?: { category?: string }) =>
      opts?.category === 'done'
        ? {
            tasks: [
              task({ id: 'task-090', status: 'merged' }),
              task({ id: 'task-091', status: 'max_rounds' }),
              task({ id: 'task-092', status: 'failed' }),
              task({ id: 'task-093', status: 'cancelled' }),
            ],
            hasMore: false,
            nextOffset: 4,
          }
        : emptyPage(),
    );
    renderPanel([]);
    fireEvent.click(screen.getByRole('button', { name: /DONE/ }));
    expect((await screen.findByRole('img', { name: 'merged' })).className).toContain('bg-success');
    expect(screen.getByRole('img', { name: 'max_rounds' }).className).toContain('bg-warn');
    expect(screen.getByRole('img', { name: 'failed' }).className).toContain('bg-warn');
    expect(screen.getByRole('img', { name: 'cancelled' }).className).toContain('bg-og-300');
  });

  it('gives the DONE divider the same hairline as the live sections', () => {
    renderPanel([task({ id: 'task-001', status: 'in_progress' })]);
    // The DONE wrapper no longer carries its own thick 2px rule; the divider above
    // it is PENDING's bottom hairline — identical to the one above PENDING.
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

  it('clicking a task row opens its detail modal instead of navigating', () => {
    renderPanel([task({ id: 'task-042', status: 'in_progress', title: 'pick me' })]);
    const active = screen.getByRole('region', { name: 'IN PROGRESS' });
    fireEvent.click(within(active).getByRole('button', { name: /pick me/ }));
    expect(openTaskMock).toHaveBeenCalledWith('task-042');
  });

  it('shortens the task id to its number and keeps the full id as hover text', () => {
    renderPanel([task({ id: 'task-042', status: 'in_progress', title: 'pick me' })]);
    const active = screen.getByRole('region', { name: 'IN PROGRESS' });
    const idCell = within(active).getByText('042');
    expect(idCell.getAttribute('title')).toBe('task-042');
    expect(within(active).queryByText('task-042')).toBeNull();
  });
});
