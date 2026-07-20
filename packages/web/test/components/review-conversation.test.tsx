import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { CodeReviewRound, ReviewRound, SpecReviewRound, TaskState } from '../../src/shared/index.js';

vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());

import { api } from '../../src/api.ts';
import { ReviewConversation } from '../../src/components/review-conversation.tsx';
import { makeTask as makeTaskFixture } from '../helpers/fixtures.ts';

const reviewsMock = vi.mocked(api.tasks.reviews);
const prReviewMock = vi.mocked(api.tasks.prReview);

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.hash}</div>;
}

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  const now = '2026-06-29T10:00:00Z';
  return makeTaskFixture({
    id: 'task-1', projectId: 'p', title: 't', description: 'd',
    preferredAgentId: 'dev', agentId: 'dev', devAgentId: 'dev', reviewRound: 1,
    status: 'review', reviewMode: 'server', createdAt: now, updatedAt: now,
    ...overrides,
  });
}

function codeRound(round: number, extra: Partial<CodeReviewRound> = {}): CodeReviewRound {
  return {
    round, phase: 'code', content: '@@ -1 +1 @@\n-a\n+b',
    diffstat: '1 file changed, 1 insertion(+), 1 deletion(-)', startedAt: 'now', ...extra,
  };
}

function specRound(round: number, content: string, extra: Partial<SpecReviewRound> = {}): SpecReviewRound {
  return {
    round,
    phase: 'spec',
    content,
    documents: [{ relPath: '.baxian/spec.md', content }],
    startedAt: 'now',
    ...extra,
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
  prReviewMock.mockReset();
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
    expect(screen.queryByText('Review records')).toBeNull();
    expect(reviewsMock).not.toHaveBeenCalled();
  });

  it('renders nothing and does not fetch when reviewMode is undefined', () => {
    reviewsMock.mockResolvedValue([]);
    render(
      <MemoryRouter>
        <ReviewConversation task={makeTask({ reviewMode: undefined })} />
      </MemoryRouter>,
    );
    expect(screen.queryByText('Review records')).toBeNull();
    expect(reviewsMock).not.toHaveBeenCalled();
  });

  it('still renders for a github-mode SDD task that has spec rounds (specReviewRound > 0)', async () => {
    reviewsMock.mockResolvedValue([
      specRound(1, 'spec', { findings: { round: 1, verdict: 'approve', findings: [] } }),
    ]);
    renderConv(makeTask({ reviewMode: 'github', specReviewRound: 1 }));
    expect(await screen.findByText('Spec review')).toBeTruthy();
    expect(reviewsMock).toHaveBeenCalled();
  });
});

describe('ReviewConversation github code-review group', () => {
  it('renders the Code review process under Review records without fetching server rounds', async () => {
    prReviewMock.mockResolvedValue({
      available: true,
      prNumber: 7,
      items: [
        { kind: 'review-comment', id: '21', body: 'nit', path: 'a.ts', line: 12 },
        { kind: 'commit', id: 'c1', body: 'fix: thing', commitSha: 'c1' },
        { kind: 'review', id: '11', body: 'please fix', verdict: 'request-changes' },
      ],
    });
    renderConv(makeTask({ reviewMode: 'github', prNumber: 7, specReviewRound: 0 }));
    expect(screen.getByText('Review records')).toBeTruthy();
    expect(await screen.findByText('Round 1')).toBeTruthy();
    expect(screen.getByText('Code review')).toBeTruthy();
    expect(screen.getByText('Inline comment')).toBeTruthy();
    expect(screen.getByText('Submit code changes')).toBeTruthy();
    expect(screen.getByText('request-changes')).toBeTruthy();
    expect(reviewsMock).not.toHaveBeenCalled();
    expect(prReviewMock).toHaveBeenCalledWith('task-1');
  });

  it('shows Spec review and Code review together for a github SDD task with spec rounds + PR', async () => {
    reviewsMock.mockResolvedValue([
      specRound(1, 'spec', { findings: { round: 1, verdict: 'approve', findings: [] } }),
    ]);
    prReviewMock.mockResolvedValue({
      available: true,
      prNumber: 7,
      items: [{ kind: 'review', id: '11', body: 'lgtm', verdict: 'approve' }],
    });
    renderConv(makeTask({ reviewMode: 'github', prNumber: 7, specReviewRound: 1 }));
    expect(await screen.findByText('Spec review')).toBeTruthy();
    expect(screen.getByText('Code review')).toBeTruthy();
    expect(await screen.findAllByText('approve')).toHaveLength(2);
  });
});

describe('ReviewConversation server mode', () => {
  it('shows an empty hint when there are no rounds', async () => {
    reviewsMock.mockResolvedValue([]);
    renderConv(makeTask());
    expect(await screen.findByText('Review has not started')).toBeTruthy();
  });

  it('groups rounds by phase and renders dev/QA/dev turns', async () => {
    reviewsMock.mockResolvedValue([
      specRound(1, 'spec body\nline2', {
        findings: { round: 1, verdict: 'request-changes', findings: [{ id: 'f-1', severity: 'major', message: 'm', location: 'Section 1' }] },
        response: { round: 1, responses: [{ findingId: 'f-1', action: 'fix', rationale: 'done' }] },
      }),
      codeRound(1, { findings: { round: 1, verdict: 'approve', findings: [] } }),
    ]);
    renderConv(makeTask());
    expect(await screen.findByText('Spec review')).toBeTruthy();
    expect(screen.getByText('Review records')).toBeTruthy();
    expect(screen.getByText('Code review')).toBeTruthy();
    expect(screen.getByText('Submit Spec draft')).toBeTruthy();
    expect(screen.getByText('Submit code changes')).toBeTruthy();
    expect(screen.getByText('approve')).toBeTruthy();
    expect(screen.getByText('request-changes')).toBeTruthy();
    expect(screen.getByText('Response')).toBeTruthy();
  });

  it('renders the User turn when a spec round carries a userDecision', async () => {
    reviewsMock.mockResolvedValue([
      specRound(1, 'spec body', {
        findings: { round: 1, verdict: 'approve', findings: [] },
        userDecision: { verdict: 'request-changes', comments: '边界场景没有覆盖', at: 'now' },
      }),
    ]);
    renderConv(makeTask({ reviewMode: 'github', specReviewRound: 1 }));
    expect(await screen.findByText('User')).toBeTruthy();
    expect(screen.getByText('Reject Spec')).toBeTruthy();
    expect(screen.getByText('边界场景没有覆盖')).toBeTruthy();
    expect(screen.getByText('request-changes')).toBeTruthy();
  });

  it('labels a code-phase userDecision as Request changes, not Reject Spec', async () => {
    reviewsMock.mockResolvedValue([
      codeRound(1, {
        findings: { round: 1, verdict: 'request-changes', findings: [{ id: 'u-1', severity: 'major', message: '这里要改' }] },
        userDecision: { verdict: 'request-changes', comments: '这里要改', at: 'now' },
      }),
    ]);
    renderConv(makeTask());
    expect(await screen.findByText('User')).toBeTruthy();
    expect(screen.getByText('Request changes')).toBeTruthy();
    expect(screen.queryByText('Reject Spec')).toBeNull();
  });

  it('renders dev/QA role markers as colored text, not pills', async () => {
    reviewsMock.mockResolvedValue([
      codeRound(1, { findings: { round: 1, verdict: 'approve', findings: [] } }),
    ] as ReviewRound[]);
    renderConv(makeTask({ reviewRound: 1 }));
    const qa = await screen.findByText('QA');
    expect(qa.className).toContain('text-og-600');
    expect(qa.className).not.toContain('pill');
    const dev = screen.getByText('Dev');
    expect(dev.className).toContain('text-og-600');
    expect(dev.className).not.toContain('pill');
  });

  it('keeps review turn hover borders in the neutral card style', async () => {
    reviewsMock.mockResolvedValue([
      codeRound(1, { findings: { round: 1, verdict: 'approve', findings: [] } }),
    ] as ReviewRound[]);
    renderConv(makeTask({ reviewRound: 1 }));
    const row = (await screen.findByText('Submit code changes')).closest('button')!;
    expect(row.className).toContain('card');
    expect(row.className).not.toContain('hover:border-accent');
  });

  it('navigates to the round detail (with hash) on click', async () => {
    reviewsMock.mockResolvedValue([
      codeRound(2, { findings: { round: 2, verdict: 'request-changes', findings: [{ id: 'f-1', severity: 'critical', message: 'x', file: 'a.ts', line: 3 }] } }),
    ] as ReviewRound[]);
    renderConv(makeTask({ reviewRound: 2 }));
    const qaRow = await screen.findByText('Review');
    fireEvent.click(qaRow.closest('button')!);
    expect(screen.getByTestId('loc').textContent).toBe('/tasks/task-1/rounds/code/2#review');
  });

  it('routes dev submit, response, and user decision rows to their own anchors', async () => {
    reviewsMock.mockResolvedValue([
      codeRound(2, {
        findings: { round: 2, verdict: 'request-changes', findings: [{ id: 'f-1', severity: 'major', message: 'm' }] },
        response: { round: 2, responses: [{ findingId: 'f-1', action: 'fix', rationale: 'done' }] },
        userDecision: { verdict: 'request-changes', comments: '还差一点', at: 'now' },
      }),
    ] as ReviewRound[]);
    renderConv(makeTask({ reviewRound: 2 }));

    fireEvent.click((await screen.findByText('Submit code changes')).closest('button')!);
    expect(screen.getByTestId('loc').textContent).toBe('/tasks/task-1/rounds/code/2#diff');

    fireEvent.click(screen.getByText('Response').closest('button')!);
    expect(screen.getByTestId('loc').textContent).toBe('/tasks/task-1/rounds/code/2#response');

    fireEvent.click(screen.getByText('Request changes').closest('button')!);
    expect(screen.getByTestId('loc').textContent).toBe('/tasks/task-1/rounds/code/2#user-decision');
  });

  it('routes each partial batch row to its own batch anchor', async () => {
    reviewsMock.mockResolvedValue([
      codeRound(1, { batchFindings: [
        { round: 1, verdict: 'request-changes', findings: [{ id: 'b0-1', severity: 'major', message: 'm' }] },
        { round: 1, verdict: 'approve', findings: [] },
      ] }),
    ] as ReviewRound[]);
    renderConv(makeTask({ reviewRound: 1, status: 'review', batchIndex: 1, batchTotal: 2 }));

    fireEvent.click((await screen.findByText('Review (batch 1)')).closest('button')!);
    expect(screen.getByTestId('loc').textContent).toBe('/tasks/task-1/rounds/code/1#batch-0');

    fireEvent.click(screen.getByText('Review (batch 2)').closest('button')!);
    expect(screen.getByTestId('loc').textContent).toBe('/tasks/task-1/rounds/code/1#batch-1');
  });

  it('refetches and grows as reviewRound advances', async () => {
    reviewsMock.mockResolvedValueOnce([codeRound(1, { findings: { round: 1, verdict: 'request-changes', findings: [] } })] as ReviewRound[]);
    const { rerender } = render(
      <MemoryRouter><ReviewConversation task={makeTask({ reviewRound: 1 })} /></MemoryRouter>,
    );
    await screen.findByText('Round 1');
    expect(reviewsMock).toHaveBeenCalledTimes(1);

    reviewsMock.mockResolvedValueOnce([
      codeRound(1, { findings: { round: 1, verdict: 'request-changes', findings: [] } }),
      codeRound(2, { findings: { round: 2, verdict: 'approve', findings: [] } }),
    ] as ReviewRound[]);
    rerender(
      <MemoryRouter><ReviewConversation task={makeTask({ reviewRound: 2 })} /></MemoryRouter>,
    );
    await waitFor(() => expect(reviewsMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Round 2')).toBeTruthy();
  });

  it('shows a batch progress row while QA reviews a large diff in batches', async () => {
    reviewsMock.mockResolvedValue([
      codeRound(1), // findings undefined: QA still reviewing
    ] as ReviewRound[]);
    renderConv(makeTask({ reviewRound: 1, status: 'review', batchIndex: 1, batchTotal: 3 }));
    expect(await screen.findByText('QA reviewing… (batch 2/3)')).toBeTruthy();
  });

  it('shows a plain reviewing row when the review is not batched', async () => {
    reviewsMock.mockResolvedValue([codeRound(1)] as ReviewRound[]);
    renderConv(makeTask({ reviewRound: 1, status: 'review' }));
    expect(await screen.findByText('QA reviewing…')).toBeTruthy();
  });

  it('shows the reviewing row for a direct Dev task whose phase remains undecided', async () => {
    reviewsMock.mockResolvedValue([codeRound(1)] as ReviewRound[]);
    renderConv(makeTask({ phase: undefined, reviewRound: 1, status: 'review' }));
    expect(await screen.findByText('QA reviewing…')).toBeTruthy();
  });

  it('shows a fixing row with the pending finding count', async () => {
    reviewsMock.mockResolvedValue([
      codeRound(1, { findings: { round: 1, verdict: 'request-changes', findings: [
        { id: 'f-1', severity: 'major', message: 'a' },
        { id: 'f-2', severity: 'minor', message: 'b' },
      ] } }),
    ] as ReviewRound[]);
    renderConv(makeTask({ reviewRound: 1, status: 'fixing' }));
    expect(await screen.findByText('Dev fixing… (2 to respond)')).toBeTruthy();
  });

  it('shows the fixing row for a direct Dev task whose phase remains undecided', async () => {
    reviewsMock.mockResolvedValue([
      codeRound(1, { findings: { round: 1, verdict: 'request-changes', findings: [
        { id: 'f-1', severity: 'major', message: 'a' },
      ] } }),
    ] as ReviewRound[]);
    renderConv(makeTask({ phase: undefined, reviewRound: 1, status: 'fixing' }));
    expect(await screen.findByText('Dev fixing… (1 to respond)')).toBeTruthy();
  });

  it('renders per-batch partial review turns before aggregation', async () => {
    reviewsMock.mockResolvedValue([
      codeRound(1, { batchFindings: [
        { round: 1, verdict: 'request-changes', findings: [{ id: 'b0-1', severity: 'major', message: 'm' }] },
        { round: 1, verdict: 'approve', findings: [] },
      ] }),
    ] as ReviewRound[]);
    renderConv(makeTask({ reviewRound: 1, status: 'review', batchIndex: 1, batchTotal: 2 }));
    expect(await screen.findByText('Review (batch 1)')).toBeTruthy();
    expect(screen.getByText('Review (batch 2)')).toBeTruthy();
  });

  it('refetches when the batch index advances', async () => {
    reviewsMock.mockResolvedValue([codeRound(1)] as ReviewRound[]);
    const { rerender } = render(
      <MemoryRouter><ReviewConversation task={makeTask({ reviewRound: 1, status: 'review', batchIndex: 0, batchTotal: 3 })} /></MemoryRouter>,
    );
    await waitFor(() => expect(reviewsMock).toHaveBeenCalledTimes(1));
    rerender(
      <MemoryRouter><ReviewConversation task={makeTask({ reviewRound: 1, status: 'review', batchIndex: 1, batchTotal: 3 })} /></MemoryRouter>,
    );
    await waitFor(() => expect(reviewsMock).toHaveBeenCalledTimes(2));
  });

  it('shows an error message when the fetch fails', async () => {
    reviewsMock.mockRejectedValue(new Error('boom'));
    renderConv(makeTask());
    expect(await screen.findByText(/Failed to load review records/)).toBeTruthy();
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
    expect(await screen.findByText('Review')).toBeTruthy();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });
});
