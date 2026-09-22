import { enUS } from '../../src/i18n/en-us.ts';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { PrReviewConversation } from '../../src/shared/index.js';

vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());
vi.mock('../../src/hooks/use-events.ts', async () => (await import('../helpers/events-mock.ts')).createEventsMock());

import { api } from '../../src/api.ts';
import { useTaskMock } from '../helpers/events-mock.ts';
import { PrReviewPage } from '../../src/pages/pr-review.tsx';

const ghMock = vi.mocked(api.tasks.prReview);

function flashedIds(): string[] {
  return Array.from(document.querySelectorAll('.ring-2'), (el) => el.id);
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/tasks/:taskId/pr-review" element={<PrReviewPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  ghMock.mockReset();
  useTaskMock.mockReset();
  useTaskMock.mockReturnValue({ data: { id: 'task-1', title: 'My Task', reviewRound: 1, status: 'review' }, loaded: true, error: null });
});
afterEach(() => cleanup());

describe('PrReviewPage', () => {
  it('renders the PR review timeline grouped into rounds', async () => {
    const data: PrReviewConversation = {
      available: true,
      prNumber: 7,
      prUrl: 'https://github.com/user/repo/pull/7',
      items: [
        { kind: 'review-comment', id: '21', author: 'qa', body: 'nit', path: 'a.ts', line: 12, createdAt: '2026-06-01T10:00:00Z' },
        { kind: 'issue-comment', id: 'dev-fix', author: 'dev', body: 'fix: thing', createdAt: '2026-06-01T10:05:00Z' },
        { kind: 'review', id: '11', author: 'qa', body: 'please fix', verdict: 'request-changes', createdAt: '2026-06-01T10:10:00Z' },
        { kind: 'review', id: '12', author: 'qa', body: 'lgtm', verdict: 'approve', createdAt: '2026-06-01T10:20:00Z' },
      ],
    };
    ghMock.mockResolvedValue(data);
    renderAt('/tasks/task-1/pr-review');

    expect((await screen.findByText(enUS.taskDetail.viewPr(7))).getAttribute('href'))
      .toBe('https://github.com/user/repo/pull/7');
    expect(screen.getByText('My Task')).toBeTruthy();
    expect(screen.getByText(enUS.agents.round(1))).toBeTruthy();
    expect(screen.getByText(enUS.agents.round(2))).toBeTruthy();
    expect(screen.getByText('a.ts:12')).toBeTruthy();
    expect(screen.getByText('nit')).toBeTruthy();
    expect(screen.getByText('fix: thing')).toBeTruthy();
    expect(screen.getByText('please fix')).toBeTruthy();
    expect(screen.getByText('request-changes')).toBeTruthy();
    expect(screen.getByText('approve')).toBeTruthy();
  });

  it('labels the full PR timeline from the current spec phase', async () => {
    useTaskMock.mockReturnValue({
      data: {
        id: 'task-1',
        title: 'My Task',
        reviewRound: 0,
        specReviewRound: 1,
        phase: 'spec',
        status: 'review',
      },
      loaded: true,
      error: null,
    });
    ghMock.mockResolvedValue({
      available: true,
      prNumber: 7,
      items: [{ kind: 'review', id: '11', body: 'spec approved', verdict: 'approve' }],
    });

    renderAt('/tasks/task-1/pr-review');

    expect(await screen.findByText(enUS.prReview.specReviewHeading)).toBeTruthy();
    expect(screen.queryByText(enUS.prReview.codeReviewHeading)).toBeNull();
  });

  it('does not create a link for a non-HTTP PR URL supplied by the API', async () => {
    ghMock.mockResolvedValue({
      available: true,
      prNumber: 7,
      prUrl: 'javascript:alert(1)',
      items: [
        { kind: 'issue-comment', id: 'c1', body: 'loaded comment', createdAt: '2026-06-01T10:00:00Z' },
      ],
    });
    renderAt('/tasks/task-1/pr-review');

    await screen.findByText('loaded comment');
    expect(screen.queryByRole('link', { name: enUS.taskDetail.viewPr(7) })).toBeNull();
  });

  it('renders a ghost placeholder for author-less comments, replies, and reviews', async () => {
    ghMock.mockResolvedValue({
      available: true,
      prNumber: 7,
      items: [
        { kind: 'issue-comment', id: 'c1', body: 'orphan comment', createdAt: '2026-06-01T10:00:00Z' },
        { kind: 'review-comment', id: 'c2', body: 'orphan reply', inReplyTo: true, createdAt: '2026-06-01T10:01:00Z' },
        { kind: 'review', id: 'r1', body: 'orphan verdict', verdict: 'approve', createdAt: '2026-06-01T10:02:00Z' },
      ],
    } as PrReviewConversation);
    renderAt('/tasks/task-1/pr-review');
    expect(await screen.findByText('orphan comment')).toBeTruthy();
    expect(screen.getAllByText(enUS.prReview.ghostAuthor)).toHaveLength(3);
  });

  it('anchors every item card with a stable DOM id', async () => {
    ghMock.mockResolvedValue({
      available: true,
      prNumber: 7,
      items: [
        { kind: 'review-comment', id: '21', body: 'nit', path: 'a.ts', line: 12, createdAt: '2026-06-01T10:00:00Z' },
        { kind: 'issue-comment', id: 'dev-fix', body: 'fix: thing', createdAt: '2026-06-01T10:05:00Z' },
        { kind: 'review', id: '11', body: 'please fix', verdict: 'request-changes', createdAt: '2026-06-01T10:10:00Z' },
      ],
    } as PrReviewConversation);
    renderAt('/tasks/task-1/pr-review');
    await screen.findByText('please fix');
    expect(document.getElementById('pr-review-comment-21')).not.toBeNull();
    expect(document.getElementById('pr-issue-comment-dev-fix')).not.toBeNull();
    expect(document.getElementById('pr-review-11')).not.toBeNull();
  });

  it('scrolls to and flashes the item targeted by the location hash', async () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    ghMock.mockResolvedValue({
      available: true,
      prNumber: 7,
      items: [
        { kind: 'issue-comment', id: 'c1', body: 'fix', createdAt: '2026-06-01T10:00:00Z' },
        { kind: 'review', id: '11', body: 'please fix', verdict: 'request-changes', createdAt: '2026-06-01T10:10:00Z' },
      ],
    } as PrReviewConversation);
    renderAt('/tasks/task-1/pr-review#pr-review-11');
    await screen.findByText('please fix');
    await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
    expect(flashedIds()).toEqual(['pr-review-11']);
  });

  it('retries the anchor when a same-task refetch adds the target record', async () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    ghMock
      .mockResolvedValueOnce({
        available: true,
        prNumber: 7,
        items: [{ kind: 'issue-comment', id: 'c1', body: 'fix', createdAt: '2026-06-01T10:00:00Z' }],
      } as PrReviewConversation)
      .mockResolvedValueOnce({
        available: true,
        prNumber: 7,
        items: [
          { kind: 'issue-comment', id: 'c1', body: 'fix', createdAt: '2026-06-01T10:00:00Z' },
          { kind: 'review', id: '11', body: 'late review', verdict: 'approve', createdAt: '2026-06-01T10:10:00Z' },
        ],
      } as PrReviewConversation);

    const tree = () => (
      <MemoryRouter initialEntries={['/tasks/task-1/pr-review#pr-review-11']}>
        <Routes>
          <Route path="/tasks/:taskId/pr-review" element={<PrReviewPage />} />
        </Routes>
      </MemoryRouter>
    );
    const view = render(tree());
    await screen.findByText('fix');
    expect(scrollSpy).not.toHaveBeenCalled();

    useTaskMock.mockReturnValue({
      data: { id: 'task-1', title: 'My Task', reviewRound: 2, status: 'review' },
      loaded: true,
      error: null,
    });
    view.rerender(tree());

    await screen.findByText('late review');
    await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
    expect(flashedIds()).toEqual(['pr-review-11']);
  });

  it('treats a malformed percent-encoded hash as an anchor miss instead of crashing', async () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    ghMock.mockResolvedValue({
      available: true,
      prNumber: 7,
      items: [{ kind: 'review', id: '11', body: 'ok', verdict: 'approve', createdAt: '2026-06-01T10:10:00Z' }],
    } as PrReviewConversation);
    renderAt('/tasks/task-1/pr-review#%E0%A4%A');
    expect(await screen.findByText('ok')).toBeTruthy();
    expect(scrollSpy).not.toHaveBeenCalled();
    expect(document.querySelector('.ring-2')).toBeNull();
  });

  it('stays at the top without error when the hash matches no item', async () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    ghMock.mockResolvedValue({
      available: true,
      prNumber: 7,
      items: [{ kind: 'review', id: '11', body: 'ok', verdict: 'approve', createdAt: '2026-06-01T10:10:00Z' }],
    } as PrReviewConversation);
    renderAt('/tasks/task-1/pr-review#gh-review-gone');
    await screen.findByText('ok');
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('renders review and comment bodies as basic markdown', async () => {
    ghMock.mockResolvedValue({
      available: true,
      prNumber: 7,
      items: [
        { kind: 'issue-comment', id: 'i1', body: 'see `path/file` please', createdAt: '2026-06-01T10:05:00Z' },
        { kind: 'review', id: '11', body: '# Verdict\n**needs** work', verdict: 'request-changes', createdAt: '2026-06-01T10:10:00Z' },
      ],
    } as PrReviewConversation);
    renderAt('/tasks/task-1/pr-review');
    await screen.findByText(/needs/);
    expect(document.querySelector('code')?.textContent).toBe('path/file');
    const h1 = document.querySelector('h1.text-\\[18px\\]');
    expect(h1?.textContent).toBe('# Verdict');
    expect(Array.from(document.querySelectorAll('strong')).some((el) => el.textContent === 'needs')).toBe(true);
  });

  it('reports truncation instead of an empty review state when the budget dropped everything', async () => {
    ghMock.mockResolvedValue({ available: true, prNumber: 7, truncated: true, items: [] } as PrReviewConversation);
    renderAt('/tasks/task-1/pr-review');
    expect(await screen.findByText(enUS.prReview.listTruncated)).toBeTruthy();
    expect(screen.queryByText(enUS.review.notStarted)).toBeNull();
  });

  it('shows a reason message when records are unavailable', async () => {
    ghMock.mockResolvedValue({ available: false, reason: 'no-pr', items: [] } as PrReviewConversation);
    renderAt('/tasks/task-1/pr-review');
    expect(await screen.findByText(enUS.prReview.reasonNoPr)).toBeTruthy();
  });

  it('shows an empty state when the conversation has no items', async () => {
    ghMock.mockResolvedValue({ available: true, prNumber: 7, items: [] } as PrReviewConversation);
    renderAt('/tasks/task-1/pr-review');
    expect(await screen.findByText(enUS.review.notStarted)).toBeTruthy();
  });

  it('shows a degradation hint (not "Review has not started") when all sources failed with no items', async () => {
    ghMock.mockResolvedValue({
      available: true,
      prNumber: 7,
      error: 'reviews: gh: not found',
      items: [],
    } as PrReviewConversation);
    renderAt('/tasks/task-1/pr-review');
    expect(await screen.findByText(enUS.prReview.fetchFailed('reviews: gh: not found'))).toBeTruthy();
    expect(screen.queryByText(enUS.review.notStarted)).toBeNull();
  });

  it('shows a partial-failure banner but still renders fetched items', async () => {
    ghMock.mockResolvedValue({
      available: true,
      prNumber: 7,
      error: 'reviews: rate limited',
      items: [{ kind: 'issue-comment', id: 'c1', body: 'fix', createdAt: '2026-06-01T10:00:00Z' }],
    } as PrReviewConversation);
    renderAt('/tasks/task-1/pr-review');
    expect(await screen.findByText(enUS.prReview.partialFetchFailed('reviews: rate limited'))).toBeTruthy();
    expect(screen.getByText('fix')).toBeTruthy();
  });

  it('renders a load error', async () => {
    ghMock.mockRejectedValue(new Error('network down'));
    renderAt('/tasks/task-1/pr-review');
    expect(await screen.findByText(enUS.review.loadFailed('network down'))).toBeTruthy();
  });
});
