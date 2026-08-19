import { usePollers } from '../hooks/use-pollers.ts';
import { useT } from '../i18n/index.tsx';
import type { PollerSnapshot } from '../shared/types.ts';

function isRateLimited(poller: PollerSnapshot): boolean {
  return poller.lastErrorClass === 'RATE_LIMIT'
    && poller.rateLimitedUntil !== undefined
    && Date.parse(poller.rateLimitedUntil) > Date.now();
}

type BannerKind = 'access-denied' | 'failed' | 'rate-limited' | 'degraded';

// Access denied needs a human; it must never be masked by a self-healing failure listed earlier.
function worst(pollers: PollerSnapshot[]): { poller: PollerSnapshot; kind: BannerKind } | null {
  const refused = pollers.find((p) => p.lastErrorClass === 'ACCESS_DENIED');
  if (refused) return { poller: refused, kind: 'access-denied' };
  const failed = pollers.find((p) => p.health === 'failed');
  if (failed) return { poller: failed, kind: 'failed' };
  const rateLimited = pollers.find(isRateLimited);
  if (rateLimited) return { poller: rateLimited, kind: 'rate-limited' };
  const degraded = pollers.find((p) => p.health === 'degraded');
  return degraded ? { poller: degraded, kind: 'degraded' } : null;
}

export function PlatformConnectivityBanner() {
  const t = useT();
  const { data } = usePollers();
  if (!data) return null;
  const affected = worst(data);
  if (!affected) return null;
  const { poller, kind } = affected;

  const text = kind === 'access-denied'
    ? t.banner.platformAccessDenied(poller.repo, poller.lastErrorMessage)
    : kind === 'failed'
      ? t.banner.platformUnreachable(poller.repo)
      : kind === 'rate-limited'
        ? t.banner.platformRateLimited(poller.repo, poller.rateLimitedUntil!)
        : t.banner.platformDegraded(poller.repo);

  return (
    <div
      className="border-b border-accent/25 bg-accent-soft/60 px-4 py-2 text-sm text-accent"
      title={poller.lastErrorMessage ?? ''}
    >
      {text}
    </div>
  );
}
