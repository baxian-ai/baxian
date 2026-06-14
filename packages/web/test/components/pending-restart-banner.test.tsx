import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { PendingRestartBanner } from '../../src/components/pending-restart-banner.tsx';
import {
  PendingRestartProvider,
  usePendingRestart,
} from '../../src/hooks/use-pending-restart.tsx';

const wrapper = ({ children }: { children: ReactNode }) => (
  <PendingRestartProvider>{children}</PendingRestartProvider>
);

function Driver({ action }: { action: 'flag' | 'noop' }) {
  const { flagDirty } = usePendingRestart();
  useEffect(() => {
    if (action === 'flag') flagDirty();
  }, []);
  return null;
}

describe('PendingRestartBanner', () => {
  it('renders nothing when phase is idle', () => {
    const { container } = render(<PendingRestartBanner />, { wrapper });
    expect(container.firstChild).toBeNull();
  });

  it('shows count + restart button in pending phase', () => {
    render(
      <>
        <Driver action="flag" />
        <PendingRestartBanner />
      </>,
      { wrapper },
    );
    expect(screen.getByText(/有 1 项配置变更/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /现在重启/ })).toBeTruthy();
  });
});
