import { enUS } from '../../src/i18n/en-us.ts';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TaskState } from '../../src/shared/index.js';

const { navigateMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
}));
vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigateMock,
}));

import { api } from '../../src/api.ts';
import { TaskPanel } from '../../src/components/task-panel.tsx';
import { ToastProvider } from '../../src/components/toast.tsx';
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
  fireEvent.click(screen.getByRole('button', { name: name => name.includes(enUS.taskPanel.doneTitle) }));
}

function doneCalls() {
  return pageMock.mock.calls.filter((c) => c[1]?.category === 'done');
}

function renderPanel(openTasks: TaskState[], projectId = 'proj') {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <TaskPanel projectId={projectId} openTasks={openTasks} />
      </ToastProvider>
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

    const activeSection = screen.getByRole('region', { name: enUS.taskPanel.inProgressTitle });
    const pendingSection = screen.getByRole('region', { name: enUS.taskPanel.pendingTitle });
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
    const pending = screen.getByRole('region', { name: enUS.taskPanel.pendingTitle });
    expect(within(pending).getAllByText(/^\d+$/).map((el) => el.textContent)).toEqual([
      '001', '002', '003',
    ]);
    const active = screen.getByRole('region', { name: enUS.taskPanel.inProgressTitle });
    expect(within(active).getAllByText(/^(hotfix-x|\d+)$/).map((el) => el.textContent)).toEqual([
      'hotfix-x', '051', '050',
    ]);
  });

  it('reflects live task updates and removes tasks that leave the open frame', () => {
    const { rerender } = renderPanel([
      task({ id: 'task-007', status: 'in_progress', reviewRound: 0, title: 'evolving' }),
    ]);
    const active = screen.getByRole('region', { name: enUS.taskPanel.inProgressTitle });
    const initialRow = within(active).getByRole('button', { name: /evolving/ });
    const initialStatus = initialRow.querySelector('[data-status="in_progress"]') as HTMLElement;
    expect(within(initialRow).queryByText(enUS.taskPanel.round(0))).toBeNull();
    expect(initialStatus.nextElementSibling).toBeNull();

    rerender(
      <MemoryRouter>
        <ToastProvider>
          <TaskPanel
            projectId="proj"
            openTasks={[task({ id: 'task-007', status: 'review', reviewRound: 1, title: 'evolving' })]}
          />
        </ToastProvider>
      </MemoryRouter>,
    );
    const activeAfter = screen.getByRole('region', { name: enUS.taskPanel.inProgressTitle });
    const updatedRow = within(activeAfter).getByRole('button', { name: /evolving/ });
    const updatedRound = within(updatedRow).getByText(enUS.taskPanel.round(1));
    const updatedStatus = updatedRow.querySelector('[data-status="review"]') as HTMLElement;
    expect(updatedRound.compareDocumentPosition(updatedStatus) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(updatedStatus.nextElementSibling).toBeNull();
    expect(activeAfter.querySelector('[data-status="in_progress"]')).toBeNull();

    rerender(
      <MemoryRouter>
        <ToastProvider>
          <TaskPanel projectId="proj" openTasks={[]} />
        </ToastProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByText('evolving')).toBeNull();
  });

  it('hides a zero plan-review round and the code-review round on a spec task', () => {
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

    const active = screen.getByRole('region', { name: enUS.taskPanel.inProgressTitle });
    const row = within(active).getByRole('button', { name: /spec flow/ });
    expect(within(row).queryByText(enUS.taskPanel.round(0))).toBeNull();
    expect(within(row).queryByText(enUS.taskPanel.round(4))).toBeNull();
  });

  it('client-paginates a long section: shows 20 + Load more, then reveals the rest', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      task({ id: `task-${String(i + 1).padStart(3, '0')}`, status: 'pending' }),
    );
    renderPanel(many);
    const pending = screen.getByRole('region', { name: enUS.taskPanel.pendingTitle });
    expect(within(pending).getAllByText(/^\d+$/).length).toBe(20);

    fireEvent.click(within(pending).getByRole('button', { name: enUS.taskPanel.loadMore }));
    expect(within(pending).getAllByText(/^\d+$/).length).toBe(25);
    expect(within(pending).queryByRole('button', { name: enUS.taskPanel.loadMore })).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: enUS.taskPanel.loadMore }));
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

    expect(screen.getByRole('button', { name: name => name.includes(enUS.taskPanel.doneTitle) }).getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findByText('shipped')).toBeTruthy();
    expect(doneCalls().some((c) => (c[1]?.offset ?? 0) === 0)).toBe(true);
  });

  it('keeps the DONE section collapsed by default without querying', () => {
    renderPanel([]);
    expect(screen.getByRole('button', { name: name => name.includes(enUS.taskPanel.doneTitle) }).getAttribute('aria-expanded')).toBe('false');
    expect(pageMock).not.toHaveBeenCalled();
  });

  it('surfaces a DONE section load error instead of failing silently', async () => {
    pageMock.mockImplementation(async (_p: string, opts?: { category?: string }) => {
      if (opts?.category === 'done') throw new Error('boom');
      return emptyPage();
    });
    renderPanel([]);
    clickDone();
    expect(await screen.findByText(enUS.common.loadFailed('boom'))).toBeTruthy();
  });

  it('uses the compact panel chrome and keeps the header/close control outside the panel', () => {
    renderPanel([task({ id: 'task-001', status: 'in_progress' })]);
    expect(screen.getByRole('region', { name: enUS.taskPanel.inProgressTitle })).toBeTruthy();
    expect(screen.getByRole('region', { name: enUS.taskPanel.pendingTitle })).toBeTruthy();
    expect(screen.getByRole('button', { name: name => name.includes(enUS.taskPanel.doneTitle) })).toBeTruthy();
    expect(screen.queryByRole('button', { name: enUS.dashboard.newTask })).toBeNull();
    expect(screen.queryByRole('button', { name: enUS.projectPage.closeTaskPanel })).toBeNull();
  });

  it('clicking a task row navigates to its detail page', () => {
    renderPanel([task({ id: 'task-042', status: 'in_progress', title: 'pick me' })]);
    const active = screen.getByRole('region', { name: enUS.taskPanel.inProgressTitle });
    fireEvent.click(within(active).getByRole('button', { name: /pick me/ }));
    expect(navigateMock).toHaveBeenCalledWith('/project/proj/task/task-042');
  });

  it('shortens the task id to its number and keeps the full id as hover text', () => {
    renderPanel([task({ id: 'task-042', status: 'in_progress', title: 'pick me' })]);
    const active = screen.getByRole('region', { name: enUS.taskPanel.inProgressTitle });
    const idCell = within(active).getByText('042');
    expect(idCell.getAttribute('title')).toBe('task-042');
    expect(within(active).queryByText('task-042')).toBeNull();
  });

  describe('persistent attention', () => {
    it.each(['in_progress', 'fixing', 'approved'] as const)('opens uncertain %s delivery for inspection without retrying old advance actions', (status) => {
      const held = attentiveTask(['advance', 'cancel']);
      renderPanel([{
        ...held, status,
        attention: { ...held.attention!, reason: 'dispatch-failed:ack_unknown' },
      }]);

      const details = screen.getByText(enUS.common.technicalDetails).closest('details')!;
      expect(details.open).toBe(true);
      expect(screen.queryByRole('button', { name: enUS.taskDetail.retryCurrentStep })).toBeNull();
      expect(screen.queryByRole('button', { name: enUS.taskDetail.retryPreMergeCheck })).toBeNull();
      expect(screen.queryByText(enUS.taskDetail.attentionAdvanceGuidance, { exact: false })).toBeNull();
      fireEvent.click(screen.getByText(enUS.taskDetail.attentionDeliveryUnknownGuidance, { exact: false }));
      expect(navigateMock).toHaveBeenCalledWith('/project/proj/task/task-100');
      expect(advanceMock).not.toHaveBeenCalled();
    });

    it.each([{ actions: ['cancel'] }, { actions: ['advance', 'cancel'] }] as const)(
      'opens task detail to verify a delivered bootstrap without retrying persisted actions $actions', ({ actions }) => {
        const held = attentiveTask([...actions]);
        renderPanel([{
          ...held, status: 'in_progress',
          attention: { ...held.attention!, reason: 'bootstrap-marker-clear-failed' },
        }]);

        const details = screen.getByText(enUS.common.technicalDetails).closest('details')!;
        expect(details.open).toBe(true);
        expect(screen.queryByRole('button', { name: enUS.taskDetail.retryCurrentStep })).toBeNull();
        expect(screen.queryByText(enUS.taskDetail.attentionAdvanceGuidance, { exact: false })).toBeNull();
        fireEvent.click(screen.getByText(enUS.taskDetail.attentionBootstrapDeliveredGuidance, { exact: false }));
        expect(navigateMock).toHaveBeenCalledWith('/project/proj/task/task-100');
        expect(advanceMock).not.toHaveBeenCalled();
      },
    );

    it.each(['dirty-workdir', 'checkout-preparation-failed', 'restart-redispatch-failed'])(
      'expands %s details without requiring a click', (reason) => {
        const held = attentiveTask(['advance', 'cancel']);
        renderPanel([{ ...held, status: 'in_progress', attention: { ...held.attention!, reason } }]);

        const details = screen.getByText(enUS.common.technicalDetails).closest('details')!;
        expect(details.open).toBe(true);
        expect(screen.getByText(enUS.taskDetail.attentionAdvanceGuidance, { exact: false })).toBeTruthy();
      },
    );

    describe.each(['dirty-workdir', 'checkout-preparation-failed', 'restart-redispatch-failed', 'bootstrap-marker-clear-failed'])(
      '%s recovery actions', (reason) => {
        it.each([
          { status: 'review', actions: ['verdict', 'cancel'], guidance: enUS.taskDetail.attentionVerdictGuidance, button: enUS.taskDetail.handleReview },
          { status: 'in_progress', actions: ['cancel'], guidance: enUS.taskDetail.attentionCancelGuidance, button: enUS.taskDetail.cancelConfirmLabel },
          { status: 'cancelled', actions: ['retry'], guidance: enUS.taskDetail.attentionRetryGuidance, button: enUS.taskDetail.retryTask },
        ] as const)('matches guidance and navigation to $actions on $status tasks', async ({ status, actions, guidance, button }) => {
          const held = attentiveTask([...actions]);
          const item = { ...held, status, attention: { ...held.attention!, reason } };
          if (status === 'cancelled') mockDoneOnly(donePage([item]));
          renderPanel([item]);
          if (status === 'cancelled') clickDone();

          expect(await screen.findByText(guidance, { exact: false })).toBeTruthy();
          expect(screen.queryByRole('button', { name: enUS.taskDetail.retryCurrentStep })).toBeNull();
          expect(screen.queryByText(enUS.taskDetail.attentionAdvanceGuidance, { exact: false })).toBeNull();
          fireEvent.click(screen.getByRole('button', { name: button }));
          expect(navigateMock).toHaveBeenCalledWith('/project/proj/task/task-100');
          expect(advanceMock).not.toHaveBeenCalled();
        });
      },
    );

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

      const details = screen.getByText(enUS.common.technicalDetails).closest('details')!;
      expect(details.hasAttribute('open')).toBe(false);
      expect(within(details).getByText(/review-verdict-overdue/)).toBeTruthy();
      expect(within(details).getByText(/Inspect the current QA review/)).toBeTruthy();
      expect(screen.getByRole('button', { name: enUS.taskDetail.restartReview })).toBeTruthy();
      expect(screen.getByRole('button', { name: enUS.taskDetail.handleReview })).toBeTruthy();
      expect(screen.getByRole('button', { name: enUS.taskDetail.cancelConfirmLabel })).toBeTruthy();
      expect(screen.getByRole('button', { name: enUS.taskDetail.retryTask })).toBeTruthy();
    });

    it('runs Advance directly and keeps the task detail route for the other operations', async () => {
      advanceMock.mockResolvedValue(attentiveTask(['advance', 'verdict']));
      renderPanel([attentiveTask(['advance', 'verdict'])]);

      fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.restartReview }));
      await waitFor(() => expect(advanceMock).toHaveBeenCalledWith('task-100'));
      expect(navigateMock).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.handleReview }));
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

      fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.retryPreMergeCheck }));

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

      fireEvent.click(screen.getByRole('button', { name: enUS.taskDetail.editTask }));

      expect(advanceMock).not.toHaveBeenCalled();
      expect(navigateMock).toHaveBeenCalledWith('/project/proj/task/task-100');
    });
  });
});
