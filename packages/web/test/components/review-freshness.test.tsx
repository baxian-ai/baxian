import { enUS } from '../../src/i18n/en-us.ts';
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
    expect(screen.getByText(enUS.prReview.fetchedAtLabel('2026-07-29 08:00:00'))).toBeTruthy();
    expect(screen.getByText(enUS.prReview.nextCheck(30))).toBeTruthy();
    expect(screen.queryByText(enUS.prReview.autoRefreshStopped)).toBeNull();
  });

  it('counts down towards the next poll cycle', () => {
    vi.useFakeTimers();
    try {
      renderFreshness(data({ autoRefresh: true, autoRefreshIntervalMs: 30_000 }));
      expect(screen.getByText(enUS.prReview.nextCheck(30))).toBeTruthy();
      act(() => { vi.advanceTimersByTime(2_000); });
      expect(screen.getByText(enUS.prReview.nextCheck(28))).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the stopped notice instead of a countdown when auto-refresh is off', () => {
    renderFreshness(data({ fetchedAt: '2026-07-29T00:00:00.000Z', autoRefresh: false, autoRefreshIntervalMs: 30_000 }));
    expect(screen.getByText(enUS.prReview.autoRefreshStopped)).toBeTruthy();
    expect(screen.queryByText(enUS.prReview.nextCheck(30))).toBeNull();
  });

  it('renders the full local date so a days-old fetchedAt is unambiguous', () => {
    const iso = '2026-07-25T15:04:05.000Z';
    const date = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    const expected = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    renderFreshness(data({ fetchedAt: iso, autoRefresh: false }));
    expect(screen.getByText(enUS.prReview.fetchedAtLabel(expected))).toBeTruthy();
    expect(expected).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('fires onRefresh from the button and disables it while refreshing', () => {
    const onRefresh = vi.fn();
    renderFreshness(data(), { onRefresh });
    fireEvent.click(screen.getByText(enUS.prReview.refresh));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    cleanup();
    renderFreshness(data(), { onRefresh, refreshing: true });
    const button = screen.getByText(enUS.prReview.refreshing) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('surfaces a refresh failure next to the button', () => {
    renderFreshness(data(), { refreshError: 'rate limited' });
    expect(screen.getByText(enUS.prReview.refreshFailed('rate limited'))).toBeTruthy();
  });

  it('renders nothing when the conversation is unavailable', () => {
    const { container } = renderFreshness({ available: false, items: [] });
    expect(container.firstChild).toBeNull();
  });
});
