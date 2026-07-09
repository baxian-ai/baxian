import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';

export type InterdiffUnavailableReason = 'historical' | 'released' | 'generic';

export type InterdiffState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; diff: string }
  | { status: 'unavailable'; reason: InterdiffUnavailableReason };

function reasonFor(err: unknown): InterdiffUnavailableReason {
  if (err instanceof ApiError) {
    if (err.status === 404) return 'historical';
    if (err.status === 409) return 'released';
  }
  return 'generic';
}

export function useInterdiff(taskId: string, round: number, enabled: boolean): InterdiffState {
  const [state, setState] = useState<InterdiffState>({ status: 'idle' });
  useEffect(() => {
    if (!enabled) {
      setState({ status: 'idle' });
      return;
    }
    let alive = true;
    setState({ status: 'loading' });
    api.tasks
      .interdiff(taskId, round)
      .then((data) => {
        if (alive) setState({ status: 'ready', diff: data.diff });
      })
      .catch((err) => {
        if (alive) setState({ status: 'unavailable', reason: reasonFor(err) });
      });
    return () => {
      alive = false;
    };
  }, [taskId, round, enabled]);
  return state;
}
