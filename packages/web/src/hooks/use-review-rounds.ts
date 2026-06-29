import { useEffect, useRef, useState } from 'react';
import type { ReviewRound } from '../shared/index.js';
import { api } from '../api.ts';

export interface ReviewRoundsResult {
  rounds: ReviewRound[] | null;
  loaded: boolean;
  error: string | null;
}

// revision lets a caller force a refetch on meaningful task transitions (round/
// status/phase) without resubscribing to every WS frame. On a same-task revision
// bump old rounds stay visible (flicker-free growth); when taskId itself changes
// (React Router reuses the page component) we drop to a loading state first so a
// previous task's rounds never render under the new task.
export function useReviewRounds(taskId: string, revision?: string | number): ReviewRoundsResult {
  const [rounds, setRounds] = useState<ReviewRound[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taskIdRef = useRef(taskId);
  useEffect(() => {
    let alive = true;
    if (taskIdRef.current !== taskId) {
      taskIdRef.current = taskId;
      setRounds(null);
      setLoaded(false);
    }
    setError(null);
    api.tasks
      .reviews(taskId)
      .then((data) => {
        if (!alive) return;
        setRounds(data);
        setLoaded(true);
      })
      .catch((err) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
        setRounds([]);
        setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [taskId, revision]);
  return { rounds, loaded, error };
}
