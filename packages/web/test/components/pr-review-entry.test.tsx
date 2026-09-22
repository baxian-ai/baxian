import { enUS } from '../../src/i18n/en-us.ts';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PrReviewConversation, TaskState } from '../../src/shared/index.js';

const navigateMock = vi.fn();
vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigateMock,
}));

import { api } from '../../src/api.ts';
import { PrReviewEntry } from '../../src/components/pr-review-entry.tsx';
import { makeTask } from '../helpers/fixtures.ts';

const ghMock = vi.mocked(api.tasks.prReview);

function task(overrides: Partial<TaskState> = {}): TaskState {
  return makeTask({ id: 'task-9', reviewRound: 0, status: 'review', prNumber: 7, ...overrides });
}

function renderEntry(t: TaskState) {
  render(
    <MemoryRouter>
      <PrReviewEntry task={t} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  ghMock.mockReset();
  navigateMock.mockReset();
});
afterEach(() => cleanup());

describe('PrReviewEntry', () => {
  it('renders the Code review process split into rounds and turns', async () => {
    ghMock.mockResolvedValue({
      available: true,
      prNumber: 7,
      items: [
        { kind: 'review-comment', id: '21', author: 'qa', body: 'nit here', path: 'a.ts', line: 12 },
        { kind: 'issue-comment', id: 'dev-fix', author: 'dev', body: 'fix: thing' },
        { kind: 'review', id: '11', author: 'qa', body: 'please fix', verdict: 'request-changes' },
        { kind: 'review', id: '12', author: 'qa', body: 'lgtm', verdict: 'approve' },
      ],
    } as PrReviewConversation);
    renderEntry(task());
    expect(screen.getByText(enUS.prReview.codeReviewHeading)).toBeTruthy();
    expect(await screen.findByText(enUS.agents.round(1))).toBeTruthy();
    expect(screen.getByText(enUS.agents.round(2))).toBeTruthy();
    expect(screen.getByText(enUS.prReview.inlineComment)).toBeTruthy();
    expect(screen.getByText(enUS.prReview.comment)).toBeTruthy();
    expect(screen.getAllByText(enUS.review.reviewTurnLabel)).toHaveLength(2);
    expect(screen.getByText('request-changes')).toBeTruthy();
    expect(screen.getByText('approve')).toBeTruthy();
    expect(screen.getByText(/a.ts:12 · nit here/)).toBeTruthy();
    expect(screen.getByText(/dev · fix: thing/)).toBeTruthy();
  });

  it('labels a git spec-phase timeline as Plan review', async () => {
    ghMock.mockResolvedValue({
      available: true,
      prNumber: 7,
      items: [{ kind: 'review', id: '11', body: 'spec approved', verdict: 'approve' }],
    } as PrReviewConversation);

    renderEntry(task({ phase: 'spec', specReviewRound: 1 }));

    expect(await screen.findByText(enUS.prReview.specReviewHeading)).toBeTruthy();
    expect(screen.queryByText(enUS.prReview.codeReviewHeading)).toBeNull();
  });

  it('labels both sides when dev comments and QA reviews appear in the same timeline', async () => {
    ghMock.mockResolvedValue({
      available: true,
      items: [
        { kind: 'issue-comment', id: 'c1', body: 'fix' },
        { kind: 'review', id: 'r1', body: 'ok', verdict: 'approve' },
      ],
    } as PrReviewConversation);
    renderEntry(task());
    expect(await screen.findByText(enUS.review.roleQa)).toBeTruthy();
    expect(screen.getByText(enUS.review.roleDev)).toBeTruthy();
  });

  it('renders issue comments as dev-side comments and keeps the author visible', async () => {
    ghMock.mockResolvedValue({
      available: true,
      items: [{ kind: 'issue-comment', id: 'i1', author: 'human-reviewer', body: 'please recheck' }],
    } as PrReviewConversation);
    renderEntry(task());
    expect(await screen.findByText(/human-reviewer · please recheck/)).toBeTruthy();
    expect(screen.getByText(enUS.prReview.comment)).toBeTruthy();
    expect(screen.getByText(enUS.review.roleDev)).toBeTruthy();
    expect(screen.queryByText(enUS.review.roleQa)).toBeNull();
  });

  it('keeps the author visible for inline replies', async () => {
    ghMock.mockResolvedValue({
      available: true,
      items: [
        {
          kind: 'review-comment',
          id: 'rc1',
          author: 'human-reviewer',
          body: 'please recheck this line',
          path: 'src/a.ts',
          line: 42,
          inReplyTo: true,
        },
      ],
    } as PrReviewConversation);
    renderEntry(task());
    expect(await screen.findByText(enUS.review.responseTurnLabel)).toBeTruthy();
    expect(screen.getByText(/human-reviewer · src\/a\.ts:42 · please recheck this line/)).toBeTruthy();
    expect(screen.getByText(enUS.review.roleDev)).toBeTruthy();
  });

  it('badges a token verdict carried by a non-review comment as the QA round verdict', async () => {
    ghMock.mockResolvedValue({
      available: true,
      prNumber: 7,
      items: [
        { kind: 'issue-comment', id: 'c1', author: 'dev', body: 'progress note', createdAt: '2026-06-01T10:00:00Z' },
        {
          kind: 'issue-comment', id: 'c9', author: 'qa', body: 'needs work', createdAt: '2026-06-01T10:05:00Z',
          verdict: 'request-changes', roundToken: '123456abcdef',
        },
      ],
    } as PrReviewConversation);
    renderEntry(task());
    expect(await screen.findByText('request-changes')).toBeTruthy();
    const row = screen.getByText('request-changes').closest('button, [role], div');
    expect(row).toBeTruthy();
  });

  it('says the history was truncated rather than "not started" for an empty truncated result', async () => {
    ghMock.mockResolvedValue({ available: true, prNumber: 7, truncated: true, items: [] } as PrReviewConversation);
    renderEntry(task());
    expect(await screen.findByText(enUS.prReview.listTruncated)).toBeTruthy();
    expect(screen.queryByText(enUS.review.notStarted)).toBeNull();
  });

  it('surfaces the server-side truncation notice in the compact entry', async () => {
    ghMock.mockResolvedValue({
      available: true,
      prNumber: 7,
      truncated: true,
      items: [{ kind: 'issue-comment', id: 'c1', author: 'dev', body: 'note' }],
    } as PrReviewConversation);
    renderEntry(task());
    expect(await screen.findByText(enUS.prReview.listTruncated)).toBeTruthy();
  });

  it('navigates to the review page anchored at the clicked record', async () => {
    ghMock.mockResolvedValue({
      available: true,
      items: [
        { kind: 'issue-comment', id: 'c1', body: 'fix: thing', createdAt: '2026-06-01T10:00:00Z' },
        { kind: 'review-comment', id: '21', body: 'nit', path: 'a.ts', line: 12, createdAt: '2026-06-01T10:05:00Z' },
        { kind: 'review', id: 'r1', body: 'ok', verdict: 'approve', createdAt: '2026-06-01T10:10:00Z' },
      ],
    } as PrReviewConversation);
    renderEntry(task({ id: 'task-42' }));

    fireEvent.click((await screen.findByText(enUS.prReview.comment)).closest('button')!);
    expect(navigateMock).toHaveBeenLastCalledWith('/tasks/task-42/pr-review#pr-issue-comment-c1');

    fireEvent.click(screen.getByText(enUS.prReview.inlineComment).closest('button')!);
    expect(navigateMock).toHaveBeenLastCalledWith('/tasks/task-42/pr-review#pr-review-comment-21');

    fireEvent.click(screen.getByText(enUS.review.reviewTurnLabel).closest('button')!);
    expect(navigateMock).toHaveBeenLastCalledWith('/tasks/task-42/pr-review#pr-review-r1');
  });

  it('shows an empty hint when the PR has no review items', async () => {
    ghMock.mockResolvedValue({ available: true, items: [] } as PrReviewConversation);
    renderEntry(task());
    expect(await screen.findByText(enUS.review.notStarted)).toBeTruthy();
  });

  it('renders an ongoing bucket when items arrive after the latest review', async () => {
    ghMock.mockResolvedValue({
      available: true,
      items: [
        { kind: 'review', id: 'r1', body: 'needs work', verdict: 'request-changes' },
        { kind: 'issue-comment', id: 'c2', body: 'fix: follow-up' },
      ],
    } as PrReviewConversation);
    renderEntry(task());
    const completed = (await screen.findByText(enUS.agents.round(1))).parentElement!;
    expect(within(completed).getByRole('button', { name: /needs work/ })).toBeTruthy();
    expect(within(completed).queryByRole('button', { name: /fix: follow-up/ })).toBeNull();
    const ongoing = completed.nextElementSibling as HTMLElement;
    const followUp = within(ongoing).getByRole('button', { name: /fix: follow-up/ });
    fireEvent.click(followUp);
    expect(navigateMock).toHaveBeenCalledWith('/tasks/task-9/pr-review#pr-issue-comment-c2');
  });

  it('shows a partial failure banner while rendering available items', async () => {
    ghMock.mockResolvedValue({
      available: true,
      error: 'reviews: rate limited',
      items: [{ kind: 'review', id: 'r1', body: 'ok', verdict: 'approve' }],
    } as PrReviewConversation);
    renderEntry(task());
    expect(await screen.findByText(enUS.prReview.partialFetchFailed('reviews: rate limited'))).toBeTruthy();
    expect(screen.getByText('approve')).toBeTruthy();
  });

  it('refetches when reviewDispatchedAt changes without a round/head/status change', async () => {
    ghMock
      .mockResolvedValueOnce({
        available: true,
        items: [{ kind: 'review', id: 'r1', body: 'old review', verdict: 'comment' }],
      } as PrReviewConversation)
      .mockResolvedValueOnce({
        available: true,
        items: [{ kind: 'review-comment', id: 'c2', body: 'new comment', path: 'a.ts', line: 7 }],
      } as PrReviewConversation);

    const { rerender } = render(
      <MemoryRouter>
        <PrReviewEntry task={task({ reviewDispatchedAt: '2026-07-02T09:00:00Z' })} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('old review')).toBeTruthy();
    expect(ghMock).toHaveBeenCalledTimes(1);

    rerender(
      <MemoryRouter>
        <PrReviewEntry task={task({ reviewDispatchedAt: '2026-07-02T09:10:00Z' })} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(ghMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/a.ts:7 · new comment/)).toBeTruthy();
  });

  it('refetches when prFeedbackReceivedAt changes without a round/head/status change', async () => {
    ghMock
      .mockResolvedValueOnce({
        available: true,
        items: [{ kind: 'review', id: 'r1', body: 'old review', verdict: 'comment' }],
      } as PrReviewConversation)
      .mockResolvedValueOnce({
        available: true,
        items: [{ kind: 'review-comment', id: 'c2', body: 'new inline reply', author: 'human', path: 'a.ts', line: 7, inReplyTo: true }],
      } as PrReviewConversation);

    const { rerender } = render(
      <MemoryRouter>
        <PrReviewEntry task={task({ prFeedbackReceivedAt: '2026-07-02T09:00:00Z' })} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('old review')).toBeTruthy();
    expect(ghMock).toHaveBeenCalledTimes(1);

    rerender(
      <MemoryRouter>
        <PrReviewEntry task={task({ prFeedbackReceivedAt: '2026-07-02T09:10:00Z' })} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(ghMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/human · a.ts:7 · new inline reply/)).toBeTruthy();
  });

  it('refetches when only prNumber changes (PR rebind)', async () => {
    ghMock
      .mockResolvedValueOnce({
        available: true,
        prNumber: 7,
        items: [{ kind: 'review', id: 'r1', body: 'old pr review', verdict: 'comment' }],
      } as PrReviewConversation)
      .mockResolvedValueOnce({
        available: true,
        prNumber: 9,
        items: [{ kind: 'review', id: 'r2', body: 'rebound pr review', verdict: 'comment' }],
      } as PrReviewConversation);

    const { rerender } = render(
      <MemoryRouter>
        <PrReviewEntry task={task({ prNumber: 7 })} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('old pr review')).toBeTruthy();
    expect(ghMock).toHaveBeenCalledTimes(1);

    rerender(
      <MemoryRouter>
        <PrReviewEntry task={task({ prNumber: 9 })} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(ghMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('rebound pr review')).toBeTruthy();
  });

  it('shows unavailable reasons and falls back unknown reasons to no-pr', async () => {
    ghMock.mockResolvedValueOnce({ available: false, reason: 'driver-unavailable', items: [] } as PrReviewConversation);
    renderEntry(task());
    expect(await screen.findByText(enUS.prReview.reasonDriverUnavailable)).toBeTruthy();

    cleanup();
    ghMock.mockResolvedValueOnce({ available: false, reason: 'unexpected', items: [] } as unknown as PrReviewConversation);
    renderEntry(task());
    expect(await screen.findByText(enUS.prReview.reasonNoPr)).toBeTruthy();
  });

  it('shows a fetch failure when github review loading fails', async () => {
    ghMock.mockRejectedValue(new Error('gh failed'));
    renderEntry(task());
    expect(await screen.findByText(enUS.review.loadFailed('gh failed'))).toBeTruthy();
  });

  it('shows freshness metadata and reloads through the manual refresh button', async () => {
    const refreshMock = vi.mocked(api.tasks.prReviewRefresh);
    refreshMock.mockReset();
    ghMock.mockResolvedValue({
      available: true,
      items: [{ kind: 'issue-comment', id: 'c1', author: 'dev', body: 'before refresh' }],
      fetchedAt: '2026-07-29T00:00:00.000Z',
      autoRefresh: false,
    } as PrReviewConversation);
    refreshMock.mockResolvedValue({
      available: true,
      items: [{ kind: 'issue-comment', id: 'c2', author: 'dev', body: 'after refresh' }],
      fetchedAt: '2026-07-29T00:05:00.000Z',
      autoRefresh: false,
    } as PrReviewConversation);
    renderEntry(task({ status: 'merged' }));
    expect(await screen.findByText(/before refresh/)).toBeTruthy();
    expect(screen.getByText(enUS.prReview.autoRefreshStopped)).toBeTruthy();
    expect(screen.getByText(enUS.prReview.fetchedAtLabel('2026-07-29 08:00:00'))).toBeTruthy();

    fireEvent.click(screen.getByText(enUS.prReview.refresh));
    expect(refreshMock).toHaveBeenCalledWith('task-9');
    expect(await screen.findByText(/after refresh/)).toBeTruthy();
  });
});
