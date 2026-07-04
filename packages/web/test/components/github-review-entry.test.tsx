import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { GithubReviewConversation, TaskState } from '../../src/shared/index.js';

const navigateMock = vi.fn();
vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigateMock,
}));

import { api } from '../../src/api.ts';
import { GithubReviewEntry } from '../../src/components/github-review-entry.tsx';
import { makeTask } from '../helpers/fixtures.ts';

const ghMock = vi.mocked(api.tasks.githubReview);

function task(overrides: Partial<TaskState> = {}): TaskState {
  return makeTask({ id: 'task-9', reviewRound: 0, status: 'review', prNumber: 7, ...overrides });
}

function renderEntry(t: TaskState) {
  render(
    <MemoryRouter>
      <GithubReviewEntry task={t} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  ghMock.mockReset();
  navigateMock.mockReset();
});
afterEach(() => cleanup());

describe('GithubReviewEntry', () => {
  it('renders the 代码评审 process split into rounds and turns', async () => {
    ghMock.mockResolvedValue({
      available: true,
      prNumber: 7,
      items: [
        { kind: 'review-comment', id: '21', author: 'qa', body: 'nit here', path: 'a.ts', line: 12 },
        { kind: 'commit', id: 'commitsha1', author: 'dev', body: 'fix: thing', commitSha: 'commitsha1' },
        { kind: 'review', id: '11', author: 'qa', body: 'please fix', verdict: 'request-changes' },
        { kind: 'review', id: '12', author: 'qa', body: 'lgtm', verdict: 'approve' },
      ],
    } as GithubReviewConversation);
    renderEntry(task({ reviewMode: 'github' }));
    expect(screen.getByText('代码评审')).toBeTruthy();
    expect(await screen.findByText('第 1 轮')).toBeTruthy();
    expect(screen.getByText('第 2 轮')).toBeTruthy();
    expect(screen.getByText('行内评论')).toBeTruthy();
    expect(screen.getByText('提交代码改动')).toBeTruthy();
    expect(screen.getAllByText('评审')).toHaveLength(2);
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
    } as GithubReviewConversation);
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
    } as GithubReviewConversation);
    renderEntry(task({ reviewMode: 'github' }));
    expect(await screen.findByText('进行中')).toBeTruthy();
    expect(screen.getByText('评论')).toBeTruthy();
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
    } as GithubReviewConversation);
    renderEntry(task({ reviewMode: 'github' }));
    expect(await screen.findByText('反馈')).toBeTruthy();
    expect(screen.getByText(/human-reviewer · src\/a\.ts:42 · please recheck this line/)).toBeTruthy();
    expect(screen.getByText('Dev')).toBeTruthy();
  });

  it('styles the 代码评审 title and QA marker like 第 x 轮: compact and non-bold', async () => {
    ghMock.mockResolvedValue({
      available: true,
      items: [{ kind: 'review', id: 'r1', body: 'ok', verdict: 'approve' }],
    } as GithubReviewConversation);
    renderEntry(task({ reviewMode: 'github' }));
    const title = screen.getByText('代码评审');
    expect(title.className).toContain('text-xs');
    expect(title.className).not.toContain('font-medium');
    expect(title.className).not.toContain('font-semibold');
    const qa = await screen.findByText('QA');
    expect(qa.className).toContain('text-xs');
    expect(qa.className).not.toContain('font-semibold');
    expect(qa.className).not.toContain('font-medium');
  });

  it('navigates to the review page on click', async () => {
    ghMock.mockResolvedValue({
      available: true,
      items: [{ kind: 'review', id: 'r1', body: 'ok', verdict: 'approve' }],
    } as GithubReviewConversation);
    renderEntry(task({ id: 'task-42', reviewMode: 'github' }));
    const row = await screen.findByText('评审');
    fireEvent.click(row.closest('button')!);
    expect(navigateMock).toHaveBeenCalledWith('/tasks/task-42/github-review');
  });

  it('shows an empty hint when the PR has no review items', async () => {
    ghMock.mockResolvedValue({ available: true, items: [] } as GithubReviewConversation);
    renderEntry(task({ reviewMode: 'github' }));
    expect(await screen.findByText('评审尚未开始')).toBeTruthy();
  });

  it('renders an ongoing bucket when items arrive after the latest review', async () => {
    ghMock.mockResolvedValue({
      available: true,
      items: [
        { kind: 'review', id: 'r1', body: 'needs work', verdict: 'request-changes' },
        { kind: 'commit', id: 'c2', body: 'fix: follow-up', commitSha: 'c2' },
      ],
    } as GithubReviewConversation);
    renderEntry(task({ reviewMode: 'github' }));
    expect(await screen.findByText('第 1 轮')).toBeTruthy();
    expect(screen.getByText('进行中')).toBeTruthy();
    expect(screen.getByText(/fix: follow-up/)).toBeTruthy();
  });

  it('shows a partial failure banner while rendering available items', async () => {
    ghMock.mockResolvedValue({
      available: true,
      error: 'reviews: rate limited',
      items: [{ kind: 'review', id: 'r1', body: 'ok', verdict: 'approve' }],
    } as GithubReviewConversation);
    renderEntry(task({ reviewMode: 'github' }));
    expect(await screen.findByText(/部分评审记录拉取失败：reviews: rate limited/)).toBeTruthy();
    expect(screen.getByText('approve')).toBeTruthy();
  });

  it('refetches when reviewDispatchedAt changes without a round/head/status change', async () => {
    ghMock
      .mockResolvedValueOnce({
        available: true,
        items: [{ kind: 'review', id: 'r1', body: 'old review', verdict: 'comment' }],
      } as GithubReviewConversation)
      .mockResolvedValueOnce({
        available: true,
        items: [{ kind: 'review-comment', id: 'c2', body: 'new comment', path: 'a.ts', line: 7 }],
      } as GithubReviewConversation);

    const { rerender } = render(
      <MemoryRouter>
        <GithubReviewEntry task={task({ reviewMode: 'github', reviewDispatchedAt: '2026-07-02T09:00:00Z' })} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('old review')).toBeTruthy();
    expect(ghMock).toHaveBeenCalledTimes(1);

    rerender(
      <MemoryRouter>
        <GithubReviewEntry task={task({ reviewMode: 'github', reviewDispatchedAt: '2026-07-02T09:10:00Z' })} />
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
      } as GithubReviewConversation)
      .mockResolvedValueOnce({
        available: true,
        items: [{ kind: 'review-comment', id: 'c2', body: 'new inline reply', author: 'human', path: 'a.ts', line: 7, inReplyTo: true }],
      } as GithubReviewConversation);

    const { rerender } = render(
      <MemoryRouter>
        <GithubReviewEntry task={task({ reviewMode: 'github', prFeedbackReceivedAt: '2026-07-02T09:00:00Z' })} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('old review')).toBeTruthy();
    expect(ghMock).toHaveBeenCalledTimes(1);

    rerender(
      <MemoryRouter>
        <GithubReviewEntry task={task({ reviewMode: 'github', prFeedbackReceivedAt: '2026-07-02T09:10:00Z' })} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(ghMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/human · a.ts:7 · new inline reply/)).toBeTruthy();
  });

  it('shows unavailable reasons and falls back unknown reasons to no-pr', async () => {
    ghMock.mockResolvedValueOnce({ available: false, reason: 'not-github', items: [] } as GithubReviewConversation);
    renderEntry(task({ reviewMode: 'github' }));
    expect(await screen.findByText(/不是 GitHub 仓库/)).toBeTruthy();

    cleanup();
    ghMock.mockResolvedValueOnce({ available: false, reason: 'unexpected', items: [] } as unknown as GithubReviewConversation);
    renderEntry(task({ reviewMode: 'github' }));
    expect(await screen.findByText(/还没有 PR/)).toBeTruthy();
  });

  it('shows a fetch failure when github review loading fails', async () => {
    ghMock.mockRejectedValue(new Error('gh failed'));
    renderEntry(task({ reviewMode: 'github' }));
    expect(await screen.findByText(/加载评审记录失败：gh failed/)).toBeTruthy();
  });
});
