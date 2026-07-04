import { usePendingRestart } from '../hooks/use-pending-restart.tsx';

export function PendingRestartBanner() {
  const { phase, count, error, triggerRestart } = usePendingRestart();
  if (phase === 'idle') return null;

  if (phase === 'failed') {
    return (
      <div className="flex items-center justify-between border-b border-accent/25 bg-accent-soft px-4 py-2">
        <div className="text-sm text-accent">重启失败：{error}</div>
        <button onClick={() => { void triggerRestart(); }} className="btn-ghost">
          重试
        </button>
      </div>
    );
  }

  if (phase === 'restarting') {
    return (
      <div className="border-b border-accent-soft bg-accent-soft/40 px-4 py-2 text-sm text-accent">
        重启中…
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between border-b border-accent/25 bg-accent-soft/60 px-4 py-2">
      <div className="text-sm text-accent">有 {count} 项配置变更待重启 baxian server 才生效</div>
      <button onClick={() => { void triggerRestart(); }} className="btn-primary">
        现在重启
      </button>
    </div>
  );
}
