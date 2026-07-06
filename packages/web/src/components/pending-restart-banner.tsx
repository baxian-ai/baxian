import { usePendingRestart } from '../hooks/use-pending-restart.tsx';
import { useT } from '../i18n/index.tsx';

export function PendingRestartBanner() {
  const t = useT();
  const { phase, count, error, triggerRestart } = usePendingRestart();
  if (phase === 'idle') return null;

  if (phase === 'failed') {
    return (
      <div className="flex items-center justify-between border-b border-accent/25 bg-accent-soft px-4 py-2">
        <div className="text-sm text-accent">{t.banner.restartFailed(error ?? '')}</div>
        <button onClick={() => { void triggerRestart(); }} className="btn-ghost">
          {t.common.retry}
        </button>
      </div>
    );
  }

  if (phase === 'restarting') {
    return (
      <div className="border-b border-accent-soft bg-accent-soft/40 px-4 py-2 text-sm text-accent">
        {t.banner.restarting}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between border-b border-accent/25 bg-accent-soft/60 px-4 py-2">
      <div className="text-sm text-accent">{t.banner.pendingNotice(count)}</div>
      <button onClick={() => { void triggerRestart(); }} className="btn-primary">
        {t.banner.restartNow}
      </button>
    </div>
  );
}
