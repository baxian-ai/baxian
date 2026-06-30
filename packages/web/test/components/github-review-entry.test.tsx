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

function renderEntry(t: TaskState, onClose = vi.fn()) {
  render(
    <MemoryRouter>
      <GithubReviewEntry task={t} onClose={onClose} />
    </MemoryRouter>,
  );
  return onClose;
}

beforeEach(() => navigateMock.mockReset());
afterEach(() => cleanup());

describe('GithubReviewEntry', () => {
  it('renders the entry for a github-mode task with a PR', () => {
    renderEntry(task({ reviewMode: 'github' }));
    expect(screen.getByText(/查看 PR 评审过程/)).toBeTruthy();
  });

  it('renders nothing for a server-mode task', () => {
    const { container } = render(
      <MemoryRouter><GithubReviewEntry task={task({ reviewMode: 'server' })} onClose={vi.fn()} /></MemoryRouter>,
    );
    expect(container.querySelector('section')).toBeNull();
  });

  it('renders nothing when the task has no PR', () => {
    const { container } = render(
      <MemoryRouter><GithubReviewEntry task={task({ prNumber: undefined })} onClose={vi.fn()} /></MemoryRouter>,
    );
    expect(container.querySelector('section')).toBeNull();
  });

  it('closes the modal and navigates to the review page on click', () => {
    const onClose = renderEntry(task({ id: 'task-42', reviewMode: 'github' }));
    fireEvent.click(screen.getByRole('button'));
    expect(onClose).toHaveBeenCalledOnce();
    expect(navigateMock).toHaveBeenCalledWith('/tasks/task-42/github-review');
  });
});
