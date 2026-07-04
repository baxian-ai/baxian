import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { ReviewRound } from '../../src/shared/index.js';

vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());
vi.mock('../../src/hooks/use-events.ts', async () => (await import('../helpers/events-mock.ts')).createEventsMock());

import { api } from '../../src/api.ts';
import { useTaskMock } from '../helpers/events-mock.ts';
import { ReviewRoundPage } from '../../src/pages/review-round.tsx';

const reviewsMock = vi.mocked(api.tasks.reviews);

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/tasks/:taskId/rounds/:phase/:round" element={<ReviewRoundPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  reviewsMock.mockReset();
  useTaskMock.mockReset();
  useTaskMock.mockReturnValue({ data: { id: 'task-1', title: 'My Task' }, loaded: true, error: null });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => cleanup());

describe('ReviewRoundPage', () => {
  it('renders code diff, findings and dev responses for a code round', async () => {
    reviewsMock.mockResolvedValue([
      {
        round: 1, phase: 'code', content: '@@ -1 +1 @@\n-old\n+new',
        diffstat: '1 file changed', startedAt: '2026-06-29T10:00:00Z', completedAt: '2026-06-29T10:05:00Z',
        findings: { round: 1, verdict: 'request-changes', findings: [{ id: 'f-1', severity: 'major', message: 'fix this', file: 'a.ts', line: 12 }] },
        response: { round: 1, responses: [{ findingId: 'f-1', action: 'fix', rationale: 'fixed it', commitSha: 'abcdef1234567' }] },
      },
    ] as ReviewRound[]);
    renderAt('/tasks/task-1/rounds/code/1');

    expect(await screen.findByText('My Task')).toBeTruthy();
    expect(screen.getByText('代码改动')).toBeTruthy();
    expect(screen.getByText('a.ts:12')).toBeTruthy();
    expect(screen.getByText('fix this')).toBeTruthy();
    expect(screen.getByText('↳ fix this')).toBeTruthy();
    expect(screen.getByText('fixed it')).toBeTruthy();
    expect(screen.getByText('abcdef123')).toBeTruthy();
    const added = Array.from(document.querySelectorAll('div')).find((d) => d.textContent === '+new');
    expect(added?.className).toContain('text-diff-add-ink');
  });

  it('renders spec content as text and uses location for spec findings', async () => {
    reviewsMock.mockResolvedValue([
      {
        round: 1, phase: 'spec', content: '# Spec\nbody', startedAt: 'now',
        findings: { round: 1, verdict: 'request-changes', findings: [{ id: 'f-1', severity: 'minor', message: 'ambiguous', location: 'Section 2' }] },
      },
    ] as ReviewRound[]);
    renderAt('/tasks/task-1/rounds/spec/1');

    expect(await screen.findByText('规格稿')).toBeTruthy();
    expect(screen.getByText(/# Spec/)).toBeTruthy();
    expect(screen.getByText('Section 2')).toBeTruthy();
  });

  it('shows a not-found message when the round is missing', async () => {
    reviewsMock.mockResolvedValue([] as ReviewRound[]);
    renderAt('/tasks/task-1/rounds/code/9');
    expect(await screen.findByText(/未找到该轮评审/)).toBeTruthy();
  });

  it('surfaces a load error instead of "not found" when the fetch fails', async () => {
    reviewsMock.mockRejectedValue(new Error('boom 500'));
    renderAt('/tasks/task-1/rounds/code/1');
    expect(await screen.findByText(/加载评审记录失败/)).toBeTruthy();
    expect(screen.queryByText(/未找到该轮评审/)).toBeNull();
  });

  it('distinguishes "review not submitted" (findings undefined) from "no findings"', async () => {
    reviewsMock.mockResolvedValue([
      { round: 1, phase: 'code', content: '@@ -1 +1 @@\n+x', startedAt: 'now' },
    ] as ReviewRound[]);
    renderAt('/tasks/task-1/rounds/code/1');
    expect(await screen.findByText('评审尚未提交。')).toBeTruthy();
    expect(screen.queryByText('本轮无 findings。')).toBeNull();
  });

  it('shows "no findings" when QA submitted an empty findings array', async () => {
    reviewsMock.mockResolvedValue([
      { round: 1, phase: 'code', content: 'x', startedAt: 'now', findings: { round: 1, verdict: 'approve', findings: [] } },
    ] as ReviewRound[]);
    renderAt('/tasks/task-1/rounds/code/1');
    expect(await screen.findByText('本轮无 findings。')).toBeTruthy();
    expect(screen.queryByText('评审尚未提交。')).toBeNull();
  });

  it('refetches the round as the task advances (in-progress round updates)', async () => {
    reviewsMock.mockResolvedValue([
      { round: 1, phase: 'code', content: 'x', startedAt: 'now', findings: { round: 1, verdict: 'request-changes', findings: [] } },
    ] as ReviewRound[]);
    const tree = () => (
      <MemoryRouter initialEntries={['/tasks/task-1/rounds/code/1']}>
        <Routes>
          <Route path="/tasks/:taskId/rounds/:phase/:round" element={<ReviewRoundPage />} />
        </Routes>
      </MemoryRouter>
    );
    useTaskMock.mockReturnValue({ data: { id: 'task-1', title: 'T', reviewRound: 1, status: 'review', phase: 'code' }, loaded: true, error: null });
    const { rerender } = render(tree());
    await waitFor(() => expect(reviewsMock).toHaveBeenCalledTimes(1));

    useTaskMock.mockReturnValue({ data: { id: 'task-1', title: 'T', reviewRound: 1, status: 'fixing', phase: 'code' }, loaded: true, error: null });
    rerender(tree());
    await waitFor(() => expect(reviewsMock).toHaveBeenCalledTimes(2));
  });

  it('scrolls to the hash target once the round loads', async () => {
    reviewsMock.mockResolvedValue([
      {
        round: 1, phase: 'code', content: '@@ -1 +1 @@\n+x', startedAt: 'now',
        findings: { round: 1, verdict: 'request-changes', findings: [{ id: 'f-1', severity: 'major', message: 'm' }] },
      },
    ] as ReviewRound[]);
    renderAt('/tasks/task-1/rounds/code/1#review');
    await screen.findByText('QA 评审');
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
  });
});
