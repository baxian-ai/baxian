import { usePollers } from '../hooks/use-pollers.ts';
import { useT } from '../i18n/index.tsx';
import type { PollerSnapshot } from '../shared/types.ts';

function worst(pollers: PollerSnapshot[]): PollerSnapshot | null {
  const failed = pollers.find((p) => p.health === 'failed');
  if (failed) return failed;
  return pollers.find((p) => p.health === 'degraded') ?? null;
}

export function GithubConnectivityBanner() {
  const t = useT();
  const { data } = usePollers();
  if (!data) return null;
  const affected = worst(data);
  if (!affected) return null;

  const text = affected.health === 'failed'
    ? t.banner.githubUnreachable(affected.repo)
    : t.banner.githubDegraded(affected.repo);

  return (
    <div
      className="border-b border-accent/25 bg-accent-soft/60 px-4 py-2 text-sm text-accent"
      title={affected.lastErrorMessage ?? ''}
    >
      {text}
    </div>
  );
}
