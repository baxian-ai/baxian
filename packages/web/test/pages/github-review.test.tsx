import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { GithubReviewConversation } from '../../src/shared/index.js';

const ghMock = vi.fn();
const useTaskMock = vi.fn();
vi.mock('../../src/api.ts', () => ({
  api: { tasks: { githubReview: (...args: unknown[]) => ghMock(...args) } },
}));
vi.mock('../../src/hooks/use-events.ts', () => ({
  useTask: (...args: unknown[]) => useTaskMock(...args),
}));

import { GithubReviewPage } from '../../src/pages/github-review.tsx';

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/tasks/:taskId/github-review" element={<GithubReviewPage />} />
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

describe('GithubReviewPage', () => {
  it('renders the PR review timeline grouped into rounds', async () => {
    const data: GithubReviewConversation = {
      available: true,
      prNumber: 7,
      prUrl: 'https://github.com/user/repo/pull/7',
      items: [
        { kind: 'review-comment', id: '21', author: 'qa', body: 'nit', path: 'a.ts', line: 12, createdAt: '2026-06-01T10:00:00Z' },
        { kind: 'commit', id: 'sha12345678', author: 'dev', body: 'fix: thing', commitSha: 'sha12345678', createdAt: '2026-06-01T10:05:00Z' },
        { kind: 'review', id: '11', author: 'qa', body: 'please fix', verdict: 'request-changes', createdAt: '2026-06-01T10:10:00Z' },
        { kind: 'review', id: '12', author: 'qa', body: 'lgtm', verdict: 'approve', createdAt: '2026-06-01T10:20:00Z' },
      ],
    };
    ghMock.mockResolvedValue(data);
    renderAt('/tasks/task-1/github-review');

    expect(await screen.findByText('My Task')).toBeTruthy();
    expect(screen.getByText('Open PR #7')).toBeTruthy();
    expect(screen.getByText('第 1 轮')).toBeTruthy();
    expect(screen.getByText('第 2 轮')).toBeTruthy();
    expect(screen.getByText('a.ts:12')).toBeTruthy();
    expect(screen.getByText('nit')).toBeTruthy();
    expect(screen.getByText('fix: thing')).toBeTruthy();
    expect(screen.getByText('sha123456')).toBeTruthy();
    expect(screen.getByText('please fix')).toBeTruthy();
    expect(screen.getByText('request-changes')).toBeTruthy();
    expect(screen.getByText('approve')).toBeTruthy();
  });

  it('shows a reason message when records are unavailable', async () => {
    ghMock.mockResolvedValue({ available: false, reason: 'no-pr', items: [] } as GithubReviewConversation);
    renderAt('/tasks/task-1/github-review');
    expect(await screen.findByText(/还没有 PR/)).toBeTruthy();
  });

  it('shows an empty state when the conversation has no items', async () => {
    ghMock.mockResolvedValue({ available: true, prNumber: 7, items: [] } as GithubReviewConversation);
    renderAt('/tasks/task-1/github-review');
    expect(await screen.findByText('评审尚未开始')).toBeTruthy();
  });

  it('shows a degradation hint (not 评审尚未开始) when all sources failed with no items', async () => {
    ghMock.mockResolvedValue({
      available: true,
      prNumber: 7,
      error: 'reviews: gh: not found',
      items: [],
    } as GithubReviewConversation);
    renderAt('/tasks/task-1/github-review');
    expect(await screen.findByText(/评审记录拉取失败：reviews: gh: not found/)).toBeTruthy();
    expect(screen.queryByText('评审尚未开始')).toBeNull();
  });

  it('shows a partial-failure banner but still renders fetched items', async () => {
    ghMock.mockResolvedValue({
      available: true,
      prNumber: 7,
      error: 'reviews: rate limited',
      items: [{ kind: 'commit', id: 'c1', body: 'fix', commitSha: 'c1', createdAt: '2026-06-01T10:00:00Z' }],
    } as GithubReviewConversation);
    renderAt('/tasks/task-1/github-review');
    expect(await screen.findByText(/部分评审记录拉取失败/)).toBeTruthy();
    expect(screen.getByText('fix')).toBeTruthy();
  });

  it('renders a load error', async () => {
    ghMock.mockRejectedValue(new Error('network down'));
    renderAt('/tasks/task-1/github-review');
    expect(await screen.findByText(/加载评审记录失败：network down/)).toBeTruthy();
  });
});
