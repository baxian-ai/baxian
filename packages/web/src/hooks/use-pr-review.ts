import { useCallback, useEffect, useRef, useState } from 'react';
import type { PrReviewConversation } from '../shared/index.js';
import { api } from '../api.ts';

const PARTIAL_RETRY_MS = 4_000;
const RATE_LIMIT_RETRY_MS = 60_000;

export interface PrReviewResult {
  data: PrReviewConversation | null;
  loaded: boolean;
  error: string | null;
  refresh: () => void;
  refreshing: boolean;
  refreshError: string | null;
}

export function usePrReview(taskId: string, revision?: string | number): PrReviewResult {
  const [data, setData] = useState<PrReviewConversation | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const taskIdRef = useRef(taskId);
  const revisionRef = useRef(revision);
  const reqRef = useRef(0);
  const retriesRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshSeqRef = useRef(0);
  const activeRefreshRef = useRef<number | null>(null);
  useEffect(() => {
    // 上下文切换即废弃旧锁；旧请求的 then/catch/finally 因 owner 不匹配全部失效
    const voidRefreshLock = () => {
      if (activeRefreshRef.current === null) return;
      activeRefreshRef.current = null;
      setRefreshing(false);
      setRefreshError(null);
    };
    if (taskIdRef.current !== taskId) {
      taskIdRef.current = taskId;
      setData(null);
      setLoaded(false);
      setRefreshError(null);
      retriesRef.current = 0;
      voidRefreshLock();
    }
    if (revisionRef.current !== revision) {
      revisionRef.current = revision;
      retriesRef.current = 0;
      voidRefreshLock();
    }
    const req = ++reqRef.current;
    setError(null);
    api.tasks
      .prReview(taskId)
      .then((result) => {
        if (reqRef.current !== req) return;
        setData(result);
        setLoaded(true);
        if (result.available && result.error && retriesRef.current < 3) {
          retriesRef.current += 1;
          const delay = result.rateLimited
            ? RATE_LIMIT_RETRY_MS * 2 ** (retriesRef.current - 1)
            : PARTIAL_RETRY_MS * retriesRef.current;
          retryTimerRef.current = setTimeout(() => setRetryNonce((n) => n + 1), delay);
        } else if (!result.error) {
          retriesRef.current = 0;
        }
      })
      .catch((err) => {
        if (reqRef.current !== req) return;
        setError(err instanceof Error ? err.message : String(err));
        setData(null);
        setLoaded(true);
      });
    return () => {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = undefined;
    };
  }, [taskId, revision, retryNonce]);
  const refresh = useCallback(() => {
    if (activeRefreshRef.current !== null) return;
    const owner = ++refreshSeqRef.current;
    activeRefreshRef.current = owner;
    setRefreshing(true);
    setRefreshError(null);
    api.tasks
      .prReviewRefresh(taskIdRef.current)
      .then((result) => {
        if (activeRefreshRef.current !== owner) return;
        if (result.available && (result.error !== undefined || result.rateLimited === true)) {
          setRefreshError(result.error ?? 'rate limited');
          return;
        }
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = undefined;
        reqRef.current += 1;
        retriesRef.current = 0;
        setData(result);
        setLoaded(true);
        setError(null);
      })
      .catch((err) => {
        if (activeRefreshRef.current !== owner) return;
        setRefreshError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (activeRefreshRef.current !== owner) return;
        activeRefreshRef.current = null;
        setRefreshing(false);
      });
  }, []);
  return { data, loaded, error, refresh, refreshing, refreshError };
}
