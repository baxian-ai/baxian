import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
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
        { kind: 'commit', id: 'commitsha1', author: 'dev', body: 'fix: thing', commitSha: 'commitsha1' },
        { kind: 'review', id: '11', author: 'qa', body: 'please fix', verdict: 'request-changes' },
        { kind: 'review', id: '12', author: 'qa', body: 'lgtm', verdict: 'approve' },
      ],
    } as PrReviewConversation);
    renderEntry(task({ reviewMode: 'github' }));
    expect(screen.getByText('Code review')).toBeTruthy();
    expect(await screen.findByText('Round 1')).toBeTruthy();
    expect(screen.getByText('Round 2')).toBeTruthy();
    expect(screen.getByText('Inline comment')).toBeTruthy();
    expect(screen.getByText('Submit code changes')).toBeTruthy();
    expect(screen.getAllByText('Review')).toHaveLength(2);
    expect(screen.getByText('request-changes')).toBeTruthy();
    expect(screen.getByText('approve')).toBeTruthy();
    expect(screen.getByText(/a.ts:12 · nit here/)).toBeTruthy();
    expect(screen.getByText(/commitsha fix: thing/)).toBeTruthy();
  });

  it('marks dev and QA role labels as colored text, not pills', async () => {
    ghMock.mockResolvedValue({
      available: true,
      items: [
        { kind: 'commit', id: 'c1', body: 'fix', commitSha: 'c1' },
        { kind: 'review', id: 'r1', body: 'ok', verdict: 'approve' },
      ],
    } as PrReviewConversation);
    renderEntry(task({ reviewMode: 'github' }));
    const qa = await screen.findByText('QA');
    expect(qa.className).toContain('text-og-600');
    expect(qa.className).not.toContain('pill');
    const dev = screen.getByText('Dev');
    expect(dev.className).toContain('text-og-600');
    expect(dev.className).not.toContain('pill');
  });

  it('renders issue comments as dev-side comments and keeps the author visible', async () => {
    ghMock.mockResolvedValue({
      available: true,
      items: [{ kind: 'issue-comment', id: 'i1', author: 'human-reviewer', body: 'please recheck' }],
    } as PrReviewConversation);
    renderEntry(task({ reviewMode: 'github' }));
    expect(await screen.findByText('In progress')).toBeTruthy();
    expect(screen.getByText('Comment')).toBeTruthy();
    expect(screen.getByText(/human-reviewer · please recheck/)).toBeTruthy();
    expect(screen.getByText('Dev')).toBeTruthy();
    expect(screen.queryByText('QA')).toBeNull();
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
    renderEntry(task({ reviewMode: 'github' }));
    expect(await screen.findByText('Response')).toBeTruthy();
    expect(screen.getByText(/human-reviewer · src\/a\.ts:42 · please recheck this line/)).toBeTruthy();
    expect(screen.getByText('Dev')).toBeTruthy();
  });

  it('styles the Code review title and QA marker like Round x: compact and non-bold', async () => {
    ghMock.mockResolvedValue({
      available: true,
      items: [{ kind: 'review', id: 'r1', body: 'ok', verdict: 'approve' }],
    } as PrReviewConversation);
    renderEntry(task({ reviewMode: 'github' }));
    const title = screen.getByText('Code review');
    expect(title.className).toContain('text-xs');
    expect(title.className).not.toContain('font-medium');
    expect(title.className).not.toContain('font-semibold');
    const qa = await screen.findByText('QA');
    expect(qa.className).toContain('text-xs');
    expect(qa.className).not.toContain('font-semibold');
    expect(qa.className).not.toContain('font-medium');
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
    expect(await screen.findByText(/too many comments/)).toBeTruthy();
    expect(screen.queryByText('Review has not started')).toBeNull();
  });

  it('surfaces the server-side truncation notice in the compact entry', async () => {
    ghMock.mockResolvedValue({
      available: true,
      prNumber: 7,
      truncated: true,
      items: [{ kind: 'issue-comment', id: 'c1', author: 'dev', body: 'note' }],
    } as PrReviewConversation);
    renderEntry(task());
    expect(await screen.findByText(/too many comments/)).toBeTruthy();
  });

  it('navigates to the review page anchored at the clicked record', async () => {
    ghMock.mockResolvedValue({
      available: true,
      items: [
        { kind: 'commit', id: 'c1', body: 'fix: thing', commitSha: 'c1', createdAt: '2026-06-01T10:00:00Z' },
        { kind: 'review-comment', id: '21', body: 'nit', path: 'a.ts', line: 12, createdAt: '2026-06-01T10:05:00Z' },
        { kind: 'review', id: 'r1', body: 'ok', verdict: 'approve', createdAt: '2026-06-01T10:10:00Z' },
      ],
    } as PrReviewConversation);
    renderEntry(task({ id: 'task-42', reviewMode: 'github' }));

    fireEvent.click((await screen.findByText('Submit code changes')).closest('button')!);
    expect(navigateMock).toHaveBeenLastCalledWith('/tasks/task-42/pr-review#pr-commit-c1');

    fireEvent.click(screen.getByText('Inline comment').closest('button')!);
    expect(navigateMock).toHaveBeenLastCalledWith('/tasks/task-42/pr-review#pr-review-comment-21');

    fireEvent.click(screen.getByText('Review').closest('button')!);
    expect(navigateMock).toHaveBeenLastCalledWith('/tasks/task-42/pr-review#pr-review-r1');
  });

  it('shows an empty hint when the PR has no review items', async () => {
    ghMock.mockResolvedValue({ available: true, items: [] } as PrReviewConversation);
    renderEntry(task({ reviewMode: 'github' }));
    expect(await screen.findByText('Review has not started')).toBeTruthy();
  });

  it('renders an ongoing bucket when items arrive after the latest review', async () => {
    ghMock.mockResolvedValue({
      available: true,
      items: [
        { kind: 'review', id: 'r1', body: 'needs work', verdict: 'request-changes' },
        { kind: 'commit', id: 'c2', body: 'fix: follow-up', commitSha: 'c2' },
      ],
    } as PrReviewConversation);
    renderEntry(task({ reviewMode: 'github' }));
    expect(await screen.findByText('Round 1')).toBeTruthy();
    expect(screen.getByText('In progress')).toBeTruthy();
    expect(screen.getByText(/fix: follow-up/)).toBeTruthy();
  });

  it('shows a partial failure banner while rendering available items', async () => {
    ghMock.mockResolvedValue({
      available: true,
      error: 'reviews: rate limited',
      items: [{ kind: 'review', id: 'r1', body: 'ok', verdict: 'approve' }],
    } as PrReviewConversation);
    renderEntry(task({ reviewMode: 'github' }));
    expect(await screen.findByText(/Some review records failed to fetch: reviews: rate limited/)).toBeTruthy();
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
        <PrReviewEntry task={task({ reviewMode: 'github', reviewDispatchedAt: '2026-07-02T09:00:00Z' })} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('old review')).toBeTruthy();
    expect(ghMock).toHaveBeenCalledTimes(1);

    rerender(
      <MemoryRouter>
        <PrReviewEntry task={task({ reviewMode: 'github', reviewDispatchedAt: '2026-07-02T09:10:00Z' })} />
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
        <PrReviewEntry task={task({ reviewMode: 'github', prFeedbackReceivedAt: '2026-07-02T09:00:00Z' })} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('old review')).toBeTruthy();
    expect(ghMock).toHaveBeenCalledTimes(1);

    rerender(
      <MemoryRouter>
        <PrReviewEntry task={task({ reviewMode: 'github', prFeedbackReceivedAt: '2026-07-02T09:10:00Z' })} />
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
        <PrReviewEntry task={task({ reviewMode: 'github', prNumber: 7 })} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('old pr review')).toBeTruthy();
    expect(ghMock).toHaveBeenCalledTimes(1);

    rerender(
      <MemoryRouter>
        <PrReviewEntry task={task({ reviewMode: 'github', prNumber: 9 })} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(ghMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('rebound pr review')).toBeTruthy();
  });

  it('shows unavailable reasons and falls back unknown reasons to no-pr', async () => {
    ghMock.mockResolvedValueOnce({ available: false, reason: 'not-github', items: [] } as PrReviewConversation);
    renderEntry(task({ reviewMode: 'github' }));
    expect(await screen.findByText(/not a GitHub repository/)).toBeTruthy();

    cleanup();
    ghMock.mockResolvedValueOnce({ available: false, reason: 'unexpected', items: [] } as unknown as PrReviewConversation);
    renderEntry(task({ reviewMode: 'github' }));
    expect(await screen.findByText(/has no PR yet/)).toBeTruthy();
  });

  it('shows a fetch failure when github review loading fails', async () => {
    ghMock.mockRejectedValue(new Error('gh failed'));
    renderEntry(task({ reviewMode: 'github' }));
    expect(await screen.findByText(/Failed to load review records: gh failed/)).toBeTruthy();
  });
});
