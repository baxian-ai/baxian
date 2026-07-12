import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import type { ReviewRound } from '../../src/shared/index.js';

vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());
vi.mock('../../src/hooks/use-events.ts', async () => (await import('../helpers/events-mock.ts')).createEventsMock());

import { api, ApiError } from '../../src/api.ts';
import { useTaskMock } from '../helpers/events-mock.ts';
import { ReviewRoundPage } from '../../src/pages/review-round.tsx';

const reviewsMock = vi.mocked(api.tasks.reviews);
const interdiffMock = vi.mocked(api.tasks.interdiff);

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/tasks/:taskId/rounds/:phase/:round" element={<ReviewRoundPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function NavTo({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(to)}>nav</button>;
}

function renderWithNav(start: string, to: string) {
  render(
    <MemoryRouter initialEntries={[start]}>
      <NavTo to={to} />
      <Routes>
        <Route path="/tasks/:taskId/rounds/:phase/:round" element={<ReviewRoundPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  reviewsMock.mockReset();
  interdiffMock.mockReset();
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
    expect(screen.getByText('Code changes')).toBeTruthy();
    expect(screen.getByText('a.ts:12')).toBeTruthy();
    expect(screen.getByText('fix this')).toBeTruthy();
    expect(screen.getByText('↳ fix this')).toBeTruthy();
    expect(screen.getByText('fixed it')).toBeTruthy();
    expect(screen.getByText('abcdef123')).toBeTruthy();
    const added = Array.from(document.querySelectorAll('div')).find((d) => d.textContent === '+new');
    expect(added?.className).toContain('text-diff-add-ink');
  });

  it('tags a u- (user) finding with a User badge', async () => {
    reviewsMock.mockResolvedValue([
      {
        round: 1, phase: 'code', content: '@@ -1 +1 @@\n-old\n+new', startedAt: '2026-06-29T10:00:00Z',
        findings: { round: 1, verdict: 'request-changes', findings: [
          { id: 'f-1', severity: 'major', message: 'qa finding' },
          { id: 'u-1', severity: 'major', message: 'user asked for changes' },
        ] },
      },
    ] as ReviewRound[]);
    renderAt('/tasks/task-1/rounds/code/1');

    expect(await screen.findByText('user asked for changes')).toBeTruthy();
    expect(screen.getByText('u-1')).toBeTruthy();
    expect(screen.getByText('User')).toBeTruthy();
  });

  it('renders spec content as text and uses location for spec findings', async () => {
    reviewsMock.mockResolvedValue([
      {
        round: 1, phase: 'spec', content: '# Spec\nbody', startedAt: 'now',
        findings: { round: 1, verdict: 'request-changes', findings: [{ id: 'f-1', severity: 'minor', message: 'ambiguous', location: 'Section 2' }] },
      },
    ] as ReviewRound[]);
    renderAt('/tasks/task-1/rounds/spec/1');

    expect(await screen.findByText('Spec draft')).toBeTruthy();
    expect(screen.getByText(/# Spec/)).toBeTruthy();
    expect(screen.getByText('Section 2')).toBeTruthy();
  });

  it('shows a not-found message when the round is missing', async () => {
    reviewsMock.mockResolvedValue([] as ReviewRound[]);
    renderAt('/tasks/task-1/rounds/code/9');
    expect(await screen.findByText(/Review round not found/)).toBeTruthy();
  });

  it('surfaces a load error instead of "not found" when the fetch fails', async () => {
    reviewsMock.mockRejectedValue(new Error('boom 500'));
    renderAt('/tasks/task-1/rounds/code/1');
    expect(await screen.findByText(/Failed to load review records/)).toBeTruthy();
    expect(screen.queryByText(/Review round not found/)).toBeNull();
  });

  it('distinguishes "review not submitted" (findings undefined) from "no findings"', async () => {
    reviewsMock.mockResolvedValue([
      { round: 1, phase: 'code', content: '@@ -1 +1 @@\n+x', startedAt: 'now' },
    ] as ReviewRound[]);
    renderAt('/tasks/task-1/rounds/code/1');
    expect(await screen.findByText('Review not submitted yet.')).toBeTruthy();
    expect(screen.queryByText('No findings this round.')).toBeNull();
  });

  it('shows "no findings" when QA submitted an empty findings array', async () => {
    reviewsMock.mockResolvedValue([
      { round: 1, phase: 'code', content: 'x', startedAt: 'now', findings: { round: 1, verdict: 'approve', findings: [] } },
    ] as ReviewRound[]);
    renderAt('/tasks/task-1/rounds/code/1');
    expect(await screen.findByText('No findings this round.')).toBeTruthy();
    expect(screen.queryByText('Review not submitted yet.')).toBeNull();
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
    await screen.findByText('QA review');
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
  });

  it('renders a finding location as a jump button when the file is in the diff', async () => {
    reviewsMock.mockResolvedValue([
      {
        round: 1, phase: 'code',
        content: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new',
        startedAt: 'now',
        findings: { round: 1, verdict: 'request-changes', findings: [{ id: 'f-1', severity: 'major', message: 'fix', file: 'a.ts', line: 1 }] },
      },
    ] as ReviewRound[]);
    renderAt('/tasks/task-1/rounds/code/1');
    const loc = await screen.findByText('a.ts:1');
    expect(loc.closest('button')).not.toBeNull();
    fireEvent.click(loc);
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
  });

  it('degrades a finding location to plain text when the file is not in the diff', async () => {
    reviewsMock.mockResolvedValue([
      {
        round: 1, phase: 'code', content: '@@ -1 +1 @@\n-old\n+new', startedAt: 'now',
        findings: { round: 1, verdict: 'request-changes', findings: [{ id: 'f-1', severity: 'major', message: 'fix', file: 'missing.ts', line: 12 }] },
      },
    ] as ReviewRound[]);
    renderAt('/tasks/task-1/rounds/code/1');
    const loc = await screen.findByText('missing.ts:12');
    expect(loc.closest('button')).toBeNull();
  });

  it('renders per-batch partial findings when the round is mid-batch (findings undefined)', async () => {
    reviewsMock.mockResolvedValue([
      {
        round: 1, phase: 'code',
        content: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new',
        startedAt: 'now',
        batchFindings: [
          { round: 1, verdict: 'request-changes', findings: [{ id: 'b0-1', severity: 'major', message: 'batch0 msg' }] },
          { round: 1, verdict: 'approve', findings: [{ id: 'b1-1', severity: 'minor', message: 'batch1 msg' }] },
        ],
      },
    ] as ReviewRound[]);
    renderAt('/tasks/task-1/rounds/code/1');
    expect(await screen.findByText('Batch 1 (partial)')).toBeTruthy();
    expect(screen.getByText('Batch 2 (partial)')).toBeTruthy();
    expect(screen.getByText('batch0 msg')).toBeTruthy();
    expect(screen.getByText('batch1 msg')).toBeTruthy();
    expect(screen.queryByText('Review not submitted yet.')).toBeNull();
  });

  it('code round ≥2: toggle switches to the incremental diff and drops the finding gutter', async () => {
    reviewsMock.mockResolvedValue([
      {
        round: 2, phase: 'code',
        content: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new',
        startedAt: '2026-06-29T10:00:00Z',
        findings: { round: 2, verdict: 'request-changes', findings: [
          { id: 'f-9', severity: 'major', message: 'gutter finding', file: 'a.ts', line: 1 },
        ] },
      },
    ] as ReviewRound[]);
    interdiffMock.mockResolvedValue({ diff: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old2\n+incremental' });
    renderAt('/tasks/task-1/rounds/code/2');

    expect(await screen.findByLabelText('Finding f-9')).toBeTruthy();

    fireEvent.click(screen.getByText('This round only'));

    await waitFor(() => {
      expect(Array.from(document.querySelectorAll('div')).find((d) => d.textContent === '+incremental')).toBeTruthy();
    });
    expect(interdiffMock).toHaveBeenCalledWith('task-1', 2);
    expect(screen.queryByLabelText('Finding f-9')).toBeNull();
    expect(Array.from(document.querySelectorAll('div')).find((d) => d.textContent === '+new')).toBeUndefined();
  });

  it('does not offer the incremental toggle for round 1', async () => {
    reviewsMock.mockResolvedValue([
      { round: 1, phase: 'code', content: '@@ -1 +1 @@\n-a\n+b', startedAt: '2026-06-29T10:00:00Z' },
    ] as ReviewRound[]);
    renderAt('/tasks/task-1/rounds/code/1');
    await screen.findByText('Code changes');
    expect(screen.queryByText('This round only')).toBeNull();
    expect(interdiffMock).not.toHaveBeenCalled();
  });

  it('disables the incremental toggle with a reason when interdiff is unavailable (409)', async () => {
    reviewsMock.mockResolvedValue([
      {
        round: 2, phase: 'code',
        content: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new',
        startedAt: '2026-06-29T10:00:00Z',
      },
    ] as ReviewRound[]);
    interdiffMock.mockRejectedValue(new ApiError(409, 'released'));
    renderAt('/tasks/task-1/rounds/code/2');

    fireEvent.click(await screen.findByText('This round only'));

    const btn = screen.getByText('This round only') as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(true));
    expect(btn.title).toMatch(/no longer bound to this task/i);
    expect(Array.from(document.querySelectorAll('div')).find((d) => d.textContent === '+new')).toBeTruthy();
  });

  it('switching rounds within the page resets to full view — no stale interdiff, no auto-fetch', async () => {
    reviewsMock.mockResolvedValue([
      { round: 2, phase: 'code', content: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new', startedAt: '2026-06-29T10:00:00Z' },
      { round: 3, phase: 'code', content: 'diff --git a/b.ts b/b.ts\n@@ -1 +1 @@\n-old3\n+new3', startedAt: '2026-06-29T10:00:00Z' },
    ] as ReviewRound[]);
    interdiffMock.mockResolvedValue({ diff: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old2\n+r2inc' });
    renderWithNav('/tasks/task-1/rounds/code/2', '/tasks/task-1/rounds/code/3');

    fireEvent.click(await screen.findByText('This round only'));
    await waitFor(() => {
      expect(Array.from(document.querySelectorAll('div')).find((d) => d.textContent === '+r2inc')).toBeTruthy();
    });
    expect(interdiffMock).toHaveBeenCalledWith('task-1', 2);
    interdiffMock.mockClear();

    fireEvent.click(screen.getByText('nav'));

    await waitFor(() => {
      expect(Array.from(document.querySelectorAll('div')).find((d) => d.textContent === '+new3')).toBeTruthy();
    });
    // round 3 opens in full view: the round-2 interdiff must not leak, and round 3 is not auto-fetched
    expect(Array.from(document.querySelectorAll('div')).find((d) => d.textContent === '+r2inc')).toBeUndefined();
    expect(interdiffMock).not.toHaveBeenCalledWith('task-1', 3);
  });

  it('gives batch findings unique DOM anchors when batches reuse the same raw id', async () => {
    reviewsMock.mockResolvedValue([
      {
        round: 1, phase: 'code',
        content: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new',
        startedAt: 'now',
        batchFindings: [
          { round: 1, verdict: 'request-changes', findings: [{ id: 'f-1', severity: 'major', message: 'from batch 0' }] },
          { round: 1, verdict: 'request-changes', findings: [{ id: 'f-1', severity: 'minor', message: 'from batch 1' }] },
        ],
      },
    ] as ReviewRound[]);
    renderAt('/tasks/task-1/rounds/code/1');
    await screen.findByText('from batch 0');
    expect(document.getElementById('finding-b0-f-1')).not.toBeNull();
    expect(document.getElementById('finding-b1-f-1')).not.toBeNull();
    expect(document.querySelectorAll('[id="finding-f-1"]')).toHaveLength(0);
  });
});
