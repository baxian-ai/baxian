import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { ToastProvider, useToast } from '../../src/components/toast.tsx';

function Trigger() {
  const { show } = useToast();
  return (
    <button type="button" onClick={() => show({ kind: 'success', title: 'hi' })}>
      go
    </button>
  );
}

function renderWithToast() {
  render(
    <ToastProvider>
      <Trigger />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByText('go'));
}

afterEach(cleanup);

describe('Toast layout (mobile)', () => {
  it('renders a fluid, viewport-capped toast (never a fixed w-80) so it cannot overflow a 320px screen', () => {
    renderWithToast();
    const toast = screen.getByRole('status');
    expect(toast.className).toContain('w-full');
    expect(toast.className).toContain('max-w-xs');
    expect(toast.className).not.toContain('w-80');
  });

  it('bounds the toast region on both sides and right-aligns items so narrow screens keep their margins', () => {
    renderWithToast();
    const region = screen.getByRole('status').parentElement!;
    expect(region.className).toContain('inset-x-4');
    expect(region.className).toContain('items-end');
    expect(region.className).not.toContain('right-4');
  });
});

describe('auto-dismiss pause on hover', () => {
  it('pauses the timer on mouseenter and restarts the full duration on mouseleave', async () => {
    vi.useFakeTimers();
    try {
      renderWithToast();
      const toast = screen.getByRole('status');

      fireEvent.mouseEnter(toast);
      await act(async () => { vi.advanceTimersByTime(10_000); });
      expect(screen.queryByRole('status')).not.toBeNull();

      fireEvent.mouseLeave(toast);
      await act(async () => { vi.advanceTimersByTime(2_999); });
      expect(screen.queryByRole('status')).not.toBeNull();
      await act(async () => { vi.advanceTimersByTime(1); });
      expect(screen.queryByRole('status')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('manual dismiss while hovered removes the toast and leaves no timer behind', async () => {
    vi.useFakeTimers();
    try {
      renderWithToast();
      const toast = screen.getByRole('status');
      fireEvent.mouseEnter(toast);
      fireEvent.click(screen.getByRole('button', { name: '关闭通知' }));
      expect(screen.queryByRole('status')).toBeNull();
      await act(async () => { vi.advanceTimersByTime(10_000); });
      expect(screen.queryByRole('status')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('hover and focus hold the timer independently', () => {
  it('mouseleave while the close button still has focus keeps the toast alive until blur', async () => {
    vi.useFakeTimers();
    try {
      renderWithToast();
      const toast = screen.getByRole('status');
      const closeBtn = screen.getByRole('button', { name: '关闭通知' });

      fireEvent.mouseEnter(toast);
      fireEvent.focus(closeBtn);
      fireEvent.mouseLeave(toast);
      await act(async () => { vi.advanceTimersByTime(10_000); });
      expect(screen.queryByRole('status')).not.toBeNull();

      fireEvent.blur(closeBtn);
      await act(async () => { vi.advanceTimersByTime(3_000); });
      expect(screen.queryByRole('status')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('blur while the pointer still hovers keeps the toast alive until mouseleave', async () => {
    vi.useFakeTimers();
    try {
      renderWithToast();
      const toast = screen.getByRole('status');
      const closeBtn = screen.getByRole('button', { name: '关闭通知' });

      fireEvent.focus(closeBtn);
      fireEvent.mouseEnter(toast);
      fireEvent.blur(closeBtn);
      await act(async () => { vi.advanceTimersByTime(10_000); });
      expect(screen.queryByRole('status')).not.toBeNull();

      fireEvent.mouseLeave(toast);
      await act(async () => { vi.advanceTimersByTime(3_000); });
      expect(screen.queryByRole('status')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
