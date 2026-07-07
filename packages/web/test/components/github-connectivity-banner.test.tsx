import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { PollerSnapshot } from '../../src/shared/types.ts';

const pollersState: { data: PollerSnapshot[] | null } = { data: null };

vi.mock('../../src/hooks/use-pollers.ts', () => ({
  usePollers: () => ({ data: pollersState.data, loaded: pollersState.data !== null, error: null }),
}));

import { GithubConnectivityBanner } from '../../src/components/github-connectivity-banner.tsx';

function snapshot(overrides: Partial<PollerSnapshot> = {}): PollerSnapshot {
  return {
    repo: 'user/repo',
    projectId: 'proj',
    intervalMs: 15000,
    isPolling: false,
    consecutiveFailures: 0,
    health: 'healthy',
    ...overrides,
  };
}

describe('GithubConnectivityBanner', () => {
  beforeEach(() => {
    pollersState.data = null;
  });

  it('renders nothing before poller data arrives', () => {
    const { container } = render(<GithubConnectivityBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when every poller is healthy', () => {
    pollersState.data = [snapshot(), snapshot({ repo: 'user/other' })];
    const { container } = render(<GithubConnectivityBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing for unknown health (poller has not run yet)', () => {
    pollersState.data = [snapshot({ health: 'unknown' })];
    const { container } = render(<GithubConnectivityBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('shows a degraded notice naming the repo', () => {
    pollersState.data = [
      snapshot(),
      snapshot({ repo: 'user/flaky', health: 'degraded', consecutiveFailures: 1 }),
    ];
    render(<GithubConnectivityBanner />);
    expect(screen.getByText(/GitHub polling degraded/)).not.toBeNull();
    expect(screen.getByText(/user\/flaky/)).not.toBeNull();
  });

  it('reports unreachable when any poller is failed, even if another is merely degraded', () => {
    pollersState.data = [
      snapshot({ repo: 'user/flaky', health: 'degraded' }),
      snapshot({ repo: 'user/down', health: 'failed', consecutiveFailures: 4 }),
    ];
    render(<GithubConnectivityBanner />);
    expect(screen.getByText(/GitHub unreachable/)).not.toBeNull();
    expect(screen.getByText(/user\/down/)).not.toBeNull();
  });

  it('surfaces the last poll error as a tooltip for diagnosis', () => {
    pollersState.data = [
      snapshot({
        repo: 'user/down',
        health: 'failed',
        lastErrorMessage: 'pollPullRequests failed (exit=1): dial tcp: i/o timeout',
      }),
    ];
    render(<GithubConnectivityBanner />);
    const banner = screen.getByText(/GitHub unreachable/).closest('div');
    expect(banner?.getAttribute('title')).toContain('i/o timeout');
  });
});
