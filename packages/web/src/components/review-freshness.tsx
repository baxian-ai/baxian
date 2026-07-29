import { useEffect, useRef, useState } from 'react';
import type { PrReviewConversation } from '../shared/index.js';
import { useT } from '../i18n/index.tsx';

interface Props {
  data: PrReviewConversation;
  onRefresh: () => void;
  refreshing: boolean;
  refreshError: string | null;
}

function formatFetchedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function ReviewFreshness({ data, onRefresh, refreshing, refreshError }: Props) {
  const t = useT();
  const intervalMs = data.autoRefresh === true ? data.autoRefreshIntervalMs : undefined;
  const [remainingS, setRemainingS] = useState<number | undefined>(undefined);
  const baseRef = useRef(Date.now());
  useEffect(() => {
    baseRef.current = Date.now();
  }, [data]);
  useEffect(() => {
    if (intervalMs === undefined || intervalMs <= 0) {
      setRemainingS(undefined);
      return;
    }
    const tick = () => {
      const elapsed = Date.now() - baseRef.current;
      setRemainingS(Math.ceil((intervalMs - (elapsed % intervalMs)) / 1000));
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [intervalMs, data]);
  if (!data.available) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-og-400">
      {data.fetchedAt && <span>{t.prReview.fetchedAtLabel(formatFetchedAt(data.fetchedAt))}</span>}
      {data.autoRefresh === false && <span>{t.prReview.autoRefreshStopped}</span>}
      {data.autoRefresh === true && remainingS !== undefined && (
        <span>{t.prReview.nextCheck(remainingS)}</span>
      )}
      <button
        type="button"
        className="text-accent hover:text-accent-hover disabled:opacity-60"
        onClick={onRefresh}
        disabled={refreshing}
      >
        {refreshing ? t.prReview.refreshing : t.prReview.refresh}
      </button>
      {refreshError && <span className="text-accent">{t.prReview.refreshFailed(refreshError)}</span>}
    </div>
  );
}
