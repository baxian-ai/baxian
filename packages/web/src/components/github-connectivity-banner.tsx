import { usePollers } from '../hooks/use-pollers.ts';
import { useT } from '../i18n/index.tsx';
import type { PollerSnapshot } from '../shared/types.ts';

function isRateLimited(poller: PollerSnapshot): boolean {
  return poller.lastErrorClass === 'RATE_LIMIT'
    && poller.rateLimitedUntil !== undefined
    && Date.parse(poller.rateLimitedUntil) > Date.now();
}

function worst(pollers: PollerSnapshot[]): { poller: PollerSnapshot; kind: 'failed' | 'rate-limited' | 'degraded' } | null {
  const failed = pollers.find((p) => p.health === 'failed');
  if (failed) return { poller: failed, kind: 'failed' };
  const rateLimited = pollers.find(isRateLimited);
  if (rateLimited) return { poller: rateLimited, kind: 'rate-limited' };
  const degraded = pollers.find((p) => p.health === 'degraded');
  return degraded ? { poller: degraded, kind: 'degraded' } : null;
}

export function GithubConnectivityBanner() {
  const t = useT();
  const { data } = usePollers();
  if (!data) return null;
  const affected = worst(data);
  if (!affected) return null;
  const { poller, kind } = affected;

  const text = kind === 'failed'
    ? t.banner.githubUnreachable(poller.repo)
    : kind === 'rate-limited'
      ? t.banner.githubRateLimited(poller.repo, poller.rateLimitedUntil!)
      : t.banner.githubDegraded(poller.repo);

  return (
    <div
      className="border-b border-accent/25 bg-accent-soft/60 px-4 py-2 text-sm text-accent"
      title={poller.lastErrorMessage ?? ''}
    >
      {text}
    </div>
  );
}
