import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../src/hooks/use-pending-restart.tsx', async () => (await import('../helpers/pending-restart-mock.tsx')).createPendingRestartMock());

import { PendingRestartBanner } from '../../src/components/pending-restart-banner.tsx';
import {
  pendingRestartValue,
  resetPendingRestartValue,
  triggerRestartMock,
} from '../helpers/pending-restart-mock.tsx';

beforeEach(() => {
  resetPendingRestartValue();
  triggerRestartMock.mockClear();
});

describe('PendingRestartBanner', () => {
  it('renders nothing when phase is idle', () => {
    const { container } = render(<PendingRestartBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('pending: shows the dirty-change count and a restart button that triggers the restart', () => {
    Object.assign(pendingRestartValue, { phase: 'pending', count: 3 });
    render(<PendingRestartBanner />);
    expect(screen.getByText(/3 config changes pending/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }));
    expect(triggerRestartMock).toHaveBeenCalledTimes(1);
  });

  it('restarting: shows progress text and offers no action buttons', () => {
    Object.assign(pendingRestartValue, { phase: 'restarting', count: 1 });
    render(<PendingRestartBanner />);
    expect(screen.getByText(/Restarting/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('failed: shows the error message and a retry button that re-triggers the restart', () => {
    Object.assign(pendingRestartValue, { phase: 'failed', count: 1, error: 'Restart timed out (30s with no recovery)' });
    render(<PendingRestartBanner />);
    expect(screen.getByText(/Restart failed: Restart timed out \(30s with no recovery\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(triggerRestartMock).toHaveBeenCalledTimes(1);
  });
});
