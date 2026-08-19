import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { PollerSnapshot } from '../../src/shared/types.ts';

const pollersState: { data: PollerSnapshot[] | null } = { data: null };

vi.mock('../../src/hooks/use-pollers.ts', () => ({
  usePollers: () => ({ data: pollersState.data, loaded: pollersState.data !== null, error: null }),
}));

import { PlatformConnectivityBanner } from '../../src/components/platform-connectivity-banner.tsx';

function snapshot(overrides: Partial<PollerSnapshot> = {}): PollerSnapshot {
  return {
    repo: 'https://github.com/user/repo.git',
    projectId: 'proj',
    intervalMs: 15000,
    isPolling: false,
    consecutiveFailures: 0,
    health: 'healthy',
    ...overrides,
  };
}

describe('PlatformConnectivityBanner', () => {
  beforeEach(() => {
    pollersState.data = null;
  });

  it('renders nothing before poller data arrives', () => {
    const { container } = render(<PlatformConnectivityBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when every poller is healthy', () => {
    pollersState.data = [snapshot(), snapshot({ repo: 'https://github.com/user/other.git' })];
    const { container } = render(<PlatformConnectivityBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing for unknown health (poller has not run yet)', () => {
    pollersState.data = [snapshot({ health: 'unknown' })];
    const { container } = render(<PlatformConnectivityBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('shows a degraded notice naming the repo', () => {
    pollersState.data = [
      snapshot(),
      snapshot({ repo: 'https://github.com/user/flaky.git', health: 'degraded', consecutiveFailures: 1 }),
    ];
    render(<PlatformConnectivityBanner />);
    expect(screen.getByText(/Platform polling degraded/)).not.toBeNull();
    expect(screen.getByText(/user\/flaky/)).not.toBeNull();
  });

  it('reports unreachable when any poller is failed, even if another is merely degraded', () => {
    pollersState.data = [
      snapshot({ repo: 'https://github.com/user/flaky.git', health: 'degraded' }),
      snapshot({ repo: 'https://github.com/user/down.git', health: 'failed', consecutiveFailures: 4 }),
    ];
    render(<PlatformConnectivityBanner />);
    expect(screen.getByText(/Platform unreachable/)).not.toBeNull();
    expect(screen.getByText(/user\/down/)).not.toBeNull();
  });

  it('shows an active rate limit even while poller health remains healthy', () => {
    pollersState.data = [snapshot({
      repo: 'https://github.com/user/throttled.git',
      lastErrorClass: 'RATE_LIMIT',
      rateLimitedUntil: '2099-01-01T00:00:00.000Z',
    })];
    render(<PlatformConnectivityBanner />);
    expect(screen.getByText(/Platform polling rate-limited/)).not.toBeNull();
    expect(screen.getByText(/user\/throttled/)).not.toBeNull();
  });

  it('ignores an expired rate-limit window', () => {
    pollersState.data = [snapshot({
      lastErrorClass: 'RATE_LIMIT',
      rateLimitedUntil: '2000-01-01T00:00:00.000Z',
    })];
    const { container } = render(<PlatformConnectivityBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('reports a failed poller ahead of a concurrently rate-limited one', () => {
    pollersState.data = [
      snapshot({
        repo: 'https://github.com/user/throttled.git',
        lastErrorClass: 'RATE_LIMIT',
        rateLimitedUntil: '2099-01-01T00:00:00.000Z',
      }),
      snapshot({ repo: 'https://github.com/user/down.git', health: 'failed', consecutiveFailures: 3 }),
    ];
    render(<PlatformConnectivityBanner />);
    expect(screen.getByText(/Platform unreachable/)).not.toBeNull();
    expect(screen.getByText(/user\/down/)).not.toBeNull();
  });

  it('reports access denied instead of unreachable when the failed poller was refused by the platform', () => {
    pollersState.data = [snapshot({
      repo: 'https://github.com/user/locked.git',
      health: 'failed',
      consecutiveFailures: 3,
      lastErrorClass: 'ACCESS_DENIED',
      lastErrorMessage: 'github-auth: GitHub CLI has no valid credentials for the user running baxian on this host.',
    })];
    render(<PlatformConnectivityBanner />);
    expect(screen.getByText(/Platform access denied/)).not.toBeNull();
    expect(screen.getByText(/user\/locked/)).not.toBeNull();
    expect(screen.queryByText(/Platform unreachable/)).toBeNull();
  });

  it('reports access denied as soon as a degraded poller is refused, before it reaches failed', () => {
    pollersState.data = [snapshot({
      repo: 'https://github.com/user/locked.git',
      health: 'degraded',
      consecutiveFailures: 1,
      lastErrorClass: 'ACCESS_DENIED',
    })];
    render(<PlatformConnectivityBanner />);
    expect(screen.getByText(/Platform access denied/)).not.toBeNull();
    expect(screen.queryByText(/Platform polling degraded/)).toBeNull();
  });

  it('prefers a refused poller over an earlier unreachable one so the manual fix is never masked', () => {
    pollersState.data = [
      snapshot({ repo: 'https://github.com/user/down.git', health: 'failed', consecutiveFailures: 5 }),
      snapshot({ repo: 'https://github.com/user/locked.git', health: 'failed', consecutiveFailures: 3, lastErrorClass: 'ACCESS_DENIED' }),
    ];
    render(<PlatformConnectivityBanner />);
    expect(screen.getByText(/Platform access denied/)).not.toBeNull();
    expect(screen.getByText(/user\/locked/)).not.toBeNull();
    expect(screen.queryByText(/Platform unreachable/)).toBeNull();
  });

  it('shows the driver-supplied recovery instruction instead of a hard-coded platform command', () => {
    pollersState.data = [snapshot({
      repo: 'https://corp.example/team/repo.git',
      health: 'failed',
      consecutiveFailures: 3,
      lastErrorClass: 'ACCESS_DENIED',
      lastErrorMessage: 'corp-auth: run corp-cli login on the server host',
    })];
    render(<PlatformConnectivityBanner />);
    const banner = screen.getByText(/Platform access denied/);
    expect(banner.textContent).toContain('corp-cli login on the server host');
    expect(banner.textContent).not.toContain('gh auth login');
  });

  it('surfaces the last poll error as a tooltip for diagnosis', () => {
    pollersState.data = [
      snapshot({
        repo: 'https://github.com/user/down.git',
        health: 'failed',
        lastErrorMessage: 'pollPullRequests failed (exit=1): dial tcp: i/o timeout',
      }),
    ];
    render(<PlatformConnectivityBanner />);
    const banner = screen.getByText(/Platform unreachable/).closest('div');
    expect(banner?.getAttribute('title')).toContain('i/o timeout');
  });
});
