import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TaskState } from '../../src/shared/index.js';

const navigateMock = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigateMock,
}));

import { GithubReviewEntry } from '../../src/components/github-review-entry.tsx';

function task(overrides: Partial<TaskState> = {}): TaskState {
  return { id: 'task-9', reviewRound: 0, status: 'review', prNumber: 7, ...overrides } as TaskState;
}

function renderEntry(t: TaskState) {
  render(
    <MemoryRouter>
      <GithubReviewEntry task={t} />
    </MemoryRouter>,
  );
}

beforeEach(() => navigateMock.mockReset());
afterEach(() => cleanup());

describe('GithubReviewEntry', () => {
  it('renders the 代码评审 sub-group with the PR-review link', () => {
    renderEntry(task({ reviewMode: 'github' }));
    expect(screen.getByText('代码评审')).toBeTruthy();
    expect(screen.getByText(/查看 PR 评审过程/)).toBeTruthy();
  });

  it('marks the row with QA as orange text, not a pill', () => {
    renderEntry(task({ reviewMode: 'github' }));
    const qa = screen.getByText('QA');
    expect(qa.className).toContain('text-[#c2410c]');
    expect(qa.className).not.toContain('pill');
  });

  it('styles the 代码评审 title and QA marker like 第 x 轮: 11px and non-bold', () => {
    renderEntry(task({ reviewMode: 'github' }));
    const title = screen.getByText('代码评审');
    expect(title.className).toContain('text-[11px]');
    expect(title.className).not.toContain('font-medium');
    expect(title.className).not.toContain('font-semibold');
    const qa = screen.getByText('QA');
    expect(qa.className).toContain('text-[11px]');
    expect(qa.className).not.toContain('font-semibold');
    expect(qa.className).not.toContain('font-medium');
  });

  it('navigates to the review page on click', () => {
    renderEntry(task({ id: 'task-42', reviewMode: 'github' }));
    fireEvent.click(screen.getByRole('button'));
    expect(navigateMock).toHaveBeenCalledWith('/tasks/task-42/github-review');
  });
});
