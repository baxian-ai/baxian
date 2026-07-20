import { useEffect, useRef, useState } from 'react';
import type { PrReviewConversation } from '../shared/index.js';
import { api } from '../api.ts';

const PARTIAL_RETRY_MS = 4_000;
// GitHub：无 Retry-After 时至少等 1 分钟，持续失败按指数增长（60 / 120 / 240s）。
const RATE_LIMIT_RETRY_MS = 60_000;

export interface PrReviewResult {
  data: PrReviewConversation | null;
  loaded: boolean;
  error: string | null;
}

// revision lets a caller force a refetch on meaningful task transitions (new QA
// review / dev push / PR rebind). A taskId change drops to loading first so a
// previous task's conversation never renders under the new one. Every revision
// change refetches — including the mount-time undefined→value transition: the
// mount fetch can race the first task snapshot (the task may change between the
// server-side read and the snapshot's arrival), so skipping that refetch could
// strand stale data; with the server-side conversation cache the duplicate
// request is a memory hit, so the skip would buy nothing. A request token (not a
// mounted flag) discards stale/out-of-order responses: React 18 no-ops a setState
// after unmount, and a mounted flag gets stranded false by StrictMode's
// mount→unmount→remount.
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
    // 预算按「故障恢复周期」重置：换任务或新 revision（新评审轮/push/会话刷新）都是新周期，
    // 只有重试自身触发的重跑才继续消耗预算（revision 不含 taskId，两任务可同值）。
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
        // 部分失败（部分评论源瞬态挂掉）随成功响应返回：投影摘要可能与故障前相同、
        // 不产生新 revision，不重试就会无限期停在部分数据上。限流走平台要求的 ≥60s 退避
        // （永不重试同样会卡死：poller 恢复后投影不变则 revision 也不动）。
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
