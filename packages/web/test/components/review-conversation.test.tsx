import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { ReviewRound, TaskState } from '../../src/shared/index.js';

vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());

import { api } from '../../src/api.ts';
import { ReviewConversation } from '../../src/components/review-conversation.tsx';
import { makeTask as makeTaskFixture } from '../helpers/fixtures.ts';

const reviewsMock = vi.mocked(api.tasks.reviews);
const githubReviewMock = vi.mocked(api.tasks.githubReview);

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.hash}</div>;
}

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  const now = '2026-06-29T10:00:00Z';
  return makeTaskFixture({
    id: 'task-1', projectId: 'p', title: 't', description: 'd',
    preferredAgentId: 'dev', agentId: 'dev', reviewRound: 1,
    status: 'review', reviewMode: 'server', createdAt: now, updatedAt: now,
    ...overrides,
  });
}

function codeRound(round: number, extra: Partial<ReviewRound> = {}): ReviewRound {
  return {
    round, phase: 'code', content: '@@ -1 +1 @@\n-a\n+b',
    diffstat: '1 file changed, 1 insertion(+), 1 deletion(-)', startedAt: 'now', ...extra,
  };
}

function renderConv(task: TaskState) {
  render(
    <MemoryRouter initialEntries={['/start']}>
      <ReviewConversation task={task} />
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  reviewsMock.mockReset();
  githubReviewMock.mockReset();
});
afterEach(() => cleanup());

describe('ReviewConversation gating', () => {
  it('renders nothing and does not fetch in github mode', () => {
    reviewsMock.mockResolvedValue([]);
    render(
      <MemoryRouter>
        <ReviewConversation task={makeTask({ reviewMode: 'github' })} />
      </MemoryRouter>,
    );
    expect(screen.queryByText('评审记录')).toBeNull();
    expect(reviewsMock).not.toHaveBeenCalled();
  });

  it('renders nothing and does not fetch when reviewMode is undefined', () => {
    reviewsMock.mockResolvedValue([]);
    render(
      <MemoryRouter>
        <ReviewConversation task={makeTask({ reviewMode: undefined })} />
      </MemoryRouter>,
    );
    expect(screen.queryByText('评审记录')).toBeNull();
    expect(reviewsMock).not.toHaveBeenCalled();
  });

  it('still renders for a github-mode SDD task that has spec rounds (specReviewRound > 0)', async () => {
    reviewsMock.mockResolvedValue([
      { round: 1, phase: 'spec', content: 'spec', startedAt: 'now', findings: { round: 1, verdict: 'approve', findings: [] } },
    ] as ReviewRound[]);
    renderConv(makeTask({ reviewMode: 'github', specReviewRound: 1 }));
    expect(await screen.findByText('Spec 评审')).toBeTruthy();
    expect(reviewsMock).toHaveBeenCalled();
  });
});

describe('ReviewConversation github code-review group', () => {
  it('renders the 代码评审 process under 评审记录 without fetching server rounds', async () => {
    githubReviewMock.mockResolvedValue({
      available: true,
      prNumber: 7,
      items: [
        { kind: 'review-comment', id: '21', body: 'nit', path: 'a.ts', line: 12 },
        { kind: 'commit', id: 'c1', body: 'fix: thing', commitSha: 'c1' },
        { kind: 'review', id: '11', body: 'please fix', verdict: 'request-changes' },
      ],
    });
    renderConv(makeTask({ reviewMode: 'github', prNumber: 7, specReviewRound: 0 }));
    expect(screen.getByText('评审记录')).toBeTruthy();
    expect(await screen.findByText('第 1 轮')).toBeTruthy();
    expect(screen.getByText('代码评审')).toBeTruthy();
    expect(screen.getByText('行内评论')).toBeTruthy();
    expect(screen.getByText('提交代码改动')).toBeTruthy();
    expect(screen.getByText('request-changes')).toBeTruthy();
    expect(reviewsMock).not.toHaveBeenCalled();
    expect(githubReviewMock).toHaveBeenCalledWith('task-1');
  });

  it('shows Spec 评审 and 代码评审 together for a github SDD task with spec rounds + PR', async () => {
    reviewsMock.mockResolvedValue([
      { round: 1, phase: 'spec', content: 'spec', startedAt: 'now', findings: { round: 1, verdict: 'approve', findings: [] } },
    ] as ReviewRound[]);
    githubReviewMock.mockResolvedValue({
      available: true,
      prNumber: 7,
      items: [{ kind: 'review', id: '11', body: 'lgtm', verdict: 'approve' }],
    });
    renderConv(makeTask({ reviewMode: 'github', prNumber: 7, specReviewRound: 1 }));
    expect(await screen.findByText('Spec 评审')).toBeTruthy();
    expect(screen.getByText('代码评审')).toBeTruthy();
    expect(await screen.findAllByText('approve')).toHaveLength(2);
  });
});

describe('ReviewConversation server mode', () => {
  it('shows an empty hint when there are no rounds', async () => {
    reviewsMock.mockResolvedValue([]);
    renderConv(makeTask());
    expect(await screen.findByText('评审尚未开始')).toBeTruthy();
  });

  it('groups rounds by phase and renders dev/QA/dev turns', async () => {
    reviewsMock.mockResolvedValue([
      {
        round: 1, phase: 'spec', content: 'spec body\nline2', startedAt: 'now',
        findings: { round: 1, verdict: 'request-changes', findings: [{ id: 'f-1', severity: 'major', message: 'm', location: 'Section 1' }] },
        response: { round: 1, responses: [{ findingId: 'f-1', action: 'fix', rationale: 'done' }] },
      },
      codeRound(1, { findings: { round: 1, verdict: 'approve', findings: [] } }),
    ] as ReviewRound[]);
    renderConv(makeTask());
    expect(await screen.findByText('Spec 评审')).toBeTruthy();
    expect(screen.getByText('评审记录')).toBeTruthy();
    expect(screen.getByText('代码评审')).toBeTruthy();
    expect(screen.getByText('提交规格稿')).toBeTruthy();
    expect(screen.getByText('提交代码改动')).toBeTruthy();
    expect(screen.getByText('approve')).toBeTruthy();
    expect(screen.getByText('request-changes')).toBeTruthy();
    expect(screen.getByText('反馈')).toBeTruthy();
  });

  it('renders dev/QA role markers as colored text, not pills', async () => {
    reviewsMock.mockResolvedValue([
      codeRound(1, { findings: { round: 1, verdict: 'approve', findings: [] } }),
    ] as ReviewRound[]);
    renderConv(makeTask({ reviewRound: 1 }));
    const qa = await screen.findByText('QA');
    expect(qa.className).toContain('text-[#c2410c]');
    expect(qa.className).not.toContain('pill');
    const dev = screen.getByText('dev');
    expect(dev.className).toContain('text-accent');
    expect(dev.className).not.toContain('pill');
  });

  it('keeps review turn hover borders in the neutral card style', async () => {
    reviewsMock.mockResolvedValue([
      codeRound(1, { findings: { round: 1, verdict: 'approve', findings: [] } }),
    ] as ReviewRound[]);
    renderConv(makeTask({ reviewRound: 1 }));
    const row = (await screen.findByText('提交代码改动')).closest('button')!;
    expect(row.className).toContain('card');
    expect(row.className).not.toContain('hover:border-accent');
  });

  it('navigates to the round detail (with hash) on click', async () => {
    reviewsMock.mockResolvedValue([
      codeRound(2, { findings: { round: 2, verdict: 'request-changes', findings: [{ id: 'f-1', severity: 'critical', message: 'x', file: 'a.ts', line: 3 }] } }),
    ] as ReviewRound[]);
    renderConv(makeTask({ reviewRound: 2 }));
    const qaRow = await screen.findByText('评审');
    fireEvent.click(qaRow.closest('button')!);
    expect(screen.getByTestId('loc').textContent).toBe('/tasks/task-1/rounds/code/2#review');
  });

  it('refetches and grows as reviewRound advances', async () => {
    reviewsMock.mockResolvedValueOnce([codeRound(1, { findings: { round: 1, verdict: 'request-changes', findings: [] } })] as ReviewRound[]);
    const { rerender } = render(
      <MemoryRouter><ReviewConversation task={makeTask({ reviewRound: 1 })} /></MemoryRouter>,
    );
    await screen.findByText('第 1 轮');
    expect(reviewsMock).toHaveBeenCalledTimes(1);

    reviewsMock.mockResolvedValueOnce([
      codeRound(1, { findings: { round: 1, verdict: 'request-changes', findings: [] } }),
      codeRound(2, { findings: { round: 2, verdict: 'approve', findings: [] } }),
    ] as ReviewRound[]);
    rerender(
      <MemoryRouter><ReviewConversation task={makeTask({ reviewRound: 2 })} /></MemoryRouter>,
    );
    await waitFor(() => expect(reviewsMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('第 2 轮')).toBeTruthy();
  });

  it('shows an error message when the fetch fails', async () => {
    reviewsMock.mockRejectedValue(new Error('boom'));
    renderConv(makeTask());
    expect(await screen.findByText(/加载评审记录失败/)).toBeTruthy();
  });

  it('never renders NaN when severity/action values are unexpected', async () => {
    reviewsMock.mockResolvedValue([
      {
        round: 1, phase: 'code', content: 'x', startedAt: 'now',
        findings: { round: 1, verdict: 'request-changes', findings: [{ id: 'f-1', severity: 'blocker', message: 'm' }] },
        response: { round: 1, responses: [{ findingId: 'f-1', action: 'maybe', rationale: 'r' }] },
      },
    ] as unknown as ReviewRound[]);
    renderConv(makeTask());
    expect(await screen.findByText('评审')).toBeTruthy();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });
});
