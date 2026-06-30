import { useEffect, useRef, useState } from 'react';
import type { GithubReviewConversation } from '../shared/index.js';
import { api } from '../api.ts';

export interface GithubReviewResult {
  data: GithubReviewConversation | null;
  loaded: boolean;
  error: string | null;
}

// revision lets a caller force a refetch on meaningful task transitions (new QA
// review / dev push). A taskId change drops to loading first so a previous task's
// conversation never renders under the new one. The first task load resolves
// revision undefined→value for the same task; that refetch is skipped ONLY when the
// mount fetch already produced usable data (available AND error-free), to drop a
// duplicate request. If it returned no-pr or any error (e.g. gh not logged in / rate
// limited / PR inaccessible, or opened mid-transition via a cold URL), the refetch
// must run so the page recovers rather than stranding on the stale unavailable/error
// state. A request token (not a mounted flag) discards stale/out-of-order responses:
// React 18 no-ops a setState after unmount, and a mounted flag gets stranded false by
// StrictMode's mount→unmount→remount.
export function useGithubReview(taskId: string, revision?: string | number): GithubReviewResult {
  const [data, setData] = useState<GithubReviewConversation | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taskIdRef = useRef(taskId);
  const revisionRef = useRef(revision);
  const reqRef = useRef(0);
  const availableRef = useRef(false);
  useEffect(() => {
    const taskChanged = taskIdRef.current !== taskId;
    if (taskChanged) {
      taskIdRef.current = taskId;
      availableRef.current = false;
      setData(null);
      setLoaded(false);
    } else if (revisionRef.current === undefined && revision !== undefined && availableRef.current) {
      revisionRef.current = revision;
      return;
    }
    revisionRef.current = revision;
    const req = ++reqRef.current;
    setError(null);
    api.tasks
      .githubReview(taskId)
      .then((result) => {
        if (reqRef.current !== req) return;
        availableRef.current = result.available === true && !result.error;
        setData(result);
        setLoaded(true);
      })
      .catch((err) => {
        if (reqRef.current !== req) return;
        availableRef.current = false;
        setError(err instanceof Error ? err.message : String(err));
        setData(null);
        setLoaded(true);
      });
  }, [taskId, revision]);
  return { data, loaded, error };
}
