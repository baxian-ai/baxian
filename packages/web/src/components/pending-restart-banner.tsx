import { usePendingRestart } from '../hooks/use-pending-restart.tsx';

export function PendingRestartBanner() {
  const { phase, count, error, triggerRestart } = usePendingRestart();
  if (phase === 'idle') return null;

  if (phase === 'failed') {
    return (
      <div className="flex items-center justify-between border-b border-[#fecaca] bg-[#fef2f2] px-4 py-2">
        <div className="text-[13px] text-danger">❌ 重启失败：{error}</div>
        <button onClick={() => { void triggerRestart(); }} className="btn-ghost !text-danger hover:!bg-[#fef2f2]">
          重试
        </button>
      </div>
    );
  }

  if (phase === 'restarting') {
    return (
      <div className="border-b border-accent-soft bg-accent-soft/40 px-4 py-2 text-[13px] text-accent">
        🔄 重启中…
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between border-b border-[#fde68a] bg-[#fef3c7]/60 px-4 py-2">
      <div className="text-[13px] text-warn">⚠️ 有 {count} 项配置变更待重启 baxian server 才生效</div>
      <button onClick={() => { void triggerRestart(); }} className="btn-secondary !border-warn !text-warn hover:!bg-[#fef3c7] hover:!border-warn hover:!text-warn">
        现在重启
      </button>
    </div>
  );
}
