import { useEffect, useRef, useState } from 'react';
import type { PrReviewConversation } from '../shared/index.js';
import { api } from '../api.ts';

const PARTIAL_RETRY_MS = 4_000;
const RATE_LIMIT_RETRY_MS = 60_000;

export interface PrReviewResult {
  data: PrReviewConversation | null;
  loaded: boolean;
  error: string | null;
}

export function usePrReview(taskId: string, revision?: string | number): PrReviewResult {
  const [data, setData] = useState<PrReviewConversation | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const taskIdRef = useRef(taskId);
  const revisionRef = useRef(revision);
  const reqRef = useRef(0);
  const retriesRef = useRef(0);
  useEffect(() => {
    if (taskIdRef.current !== taskId) {
      taskIdRef.current = taskId;
      setData(null);
      setLoaded(false);
      retriesRef.current = 0;
    }
    if (revisionRef.current !== revision) {
      revisionRef.current = revision;
      retriesRef.current = 0;
    }
    const req = ++reqRef.current;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
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
          retryTimer = setTimeout(() => setRetryNonce((n) => n + 1), delay);
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
    return () => clearTimeout(retryTimer);
  }, [taskId, revision, retryNonce]);
  return { data, loaded, error };
}
