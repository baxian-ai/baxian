import { useEffect, useState } from 'react';
import type { PollerSnapshot } from '../shared/types.ts';
import { getEventsClient } from '../stores/events-store.ts';
import type { EventsResult } from './use-events.ts';

export function usePollers(): EventsResult<PollerSnapshot[]> {
  const [data, setData] = useState<PollerSnapshot[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  useEffect(() => {
    const unsub = getEventsClient().subscribe<PollerSnapshot[]>(
      'pollers',
      (next) => {
        setError(null);
        setData(next);
        setLoaded(true);
      },
      (err) => setError(err),
    );
    return unsub;
  }, []);
  return { data, loaded, error };
}
