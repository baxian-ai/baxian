import { useEffect, useRef, useState } from 'react';
import type { GithubReviewConversation } from '../shared/index.js';
import { api } from '../api.ts';

export interface GithubReviewResult {
  data: GithubReviewConversation | null;
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
export function useGithubReview(taskId: string, revision?: string | number): GithubReviewResult {
  const [data, setData] = useState<GithubReviewConversation | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taskIdRef = useRef(taskId);
  const reqRef = useRef(0);
  useEffect(() => {
    if (taskIdRef.current !== taskId) {
      taskIdRef.current = taskId;
      setData(null);
      setLoaded(false);
    }
    const req = ++reqRef.current;
    setError(null);
    api.tasks
      .githubReview(taskId)
      .then((result) => {
        if (reqRef.current !== req) return;
        setData(result);
        setLoaded(true);
      })
      .catch((err) => {
        if (reqRef.current !== req) return;
        setError(err instanceof Error ? err.message : String(err));
        setData(null);
        setLoaded(true);
      });
  }, [taskId, revision]);
  return { data, loaded, error };
}
