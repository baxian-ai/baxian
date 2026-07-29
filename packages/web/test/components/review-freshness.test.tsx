import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import type { PrReviewConversation } from '../../src/shared/index.js';
import { ReviewFreshness } from '../../src/components/review-freshness.tsx';

function data(overrides: Partial<PrReviewConversation> = {}): PrReviewConversation {
  return { available: true, items: [], ...overrides };
}

function renderFreshness(
  conversation: PrReviewConversation,
  overrides: Partial<{ onRefresh: () => void; refreshing: boolean; refreshError: string | null }> = {},
) {
  return render(
    <ReviewFreshness
      data={conversation}
      onRefresh={overrides.onRefresh ?? (() => {})}
      refreshing={overrides.refreshing ?? false}
      refreshError={overrides.refreshError ?? null}
    />,
  );
}

afterEach(() => cleanup());

describe('ReviewFreshness', () => {
  it('shows the fetch time and a countdown for an auto-refreshing task', () => {
    renderFreshness(data({
      fetchedAt: '2026-07-29T00:00:00.000Z',
      autoRefresh: true,
      autoRefreshIntervalMs: 30_000,
    }));
    expect(screen.getByText(/Fetched at/)).toBeTruthy();
    expect(screen.getByText(/next check in ≤\d+s/)).toBeTruthy();
    expect(screen.queryByText('Auto-refresh stopped (task finished)')).toBeNull();
  });

  it('counts down towards the next poll cycle', () => {
    vi.useFakeTimers();
    try {
      renderFreshness(data({ autoRefresh: true, autoRefreshIntervalMs: 30_000 }));
      expect(screen.getByText('next check in ≤30s')).toBeTruthy();
      act(() => { vi.advanceTimersByTime(2_000); });
      expect(screen.getByText('next check in ≤28s')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the stopped notice instead of a countdown when auto-refresh is off', () => {
    renderFreshness(data({ fetchedAt: '2026-07-29T00:00:00.000Z', autoRefresh: false }));
    expect(screen.getByText('Auto-refresh stopped')).toBeTruthy();
    expect(screen.queryByText(/next check in/)).toBeNull();
  });

  it('renders the full local date so a days-old fetchedAt is unambiguous', () => {
    const iso = '2026-07-25T15:04:05.000Z';
    const date = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    const expected = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    renderFreshness(data({ fetchedAt: iso, autoRefresh: false }));
    expect(screen.getByText(`Fetched at ${expected}`)).toBeTruthy();
    expect(expected).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('fires onRefresh from the button and disables it while refreshing', () => {
    const onRefresh = vi.fn();
    renderFreshness(data(), { onRefresh });
    fireEvent.click(screen.getByText('Refresh'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    cleanup();
    renderFreshness(data(), { onRefresh, refreshing: true });
    const button = screen.getByText('Refreshing…') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('surfaces a refresh failure next to the button', () => {
    renderFreshness(data(), { refreshError: 'rate limited' });
    expect(screen.getByText('Refresh failed: rate limited')).toBeTruthy();
  });

  it('renders nothing when the conversation is unavailable', () => {
    const { container } = renderFreshness({ available: false, items: [] });
    expect(container.firstChild).toBeNull();
  });
});
