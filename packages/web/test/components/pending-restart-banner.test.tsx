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
    expect(screen.getByText(/有 3 项配置变更待重启/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '现在重启' }));
    expect(triggerRestartMock).toHaveBeenCalledTimes(1);
  });

  it('restarting: shows progress text and offers no action buttons', () => {
    Object.assign(pendingRestartValue, { phase: 'restarting', count: 1 });
    render(<PendingRestartBanner />);
    expect(screen.getByText(/重启中/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('failed: shows the error message and a retry button that re-triggers the restart', () => {
    Object.assign(pendingRestartValue, { phase: 'failed', count: 1, error: '重启超时（30s 未恢复）' });
    render(<PendingRestartBanner />);
    expect(screen.getByText(/重启失败：重启超时（30s 未恢复）/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(triggerRestartMock).toHaveBeenCalledTimes(1);
  });
});
