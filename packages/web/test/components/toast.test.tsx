import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
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
