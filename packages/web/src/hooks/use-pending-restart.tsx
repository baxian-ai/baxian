import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { api, ApiError } from '../api.ts';

const STORAGE_KEY = 'baxian.pendingRestart';
const POLL_INTERVAL_MS = 500;
const RESTART_TIMEOUT_MS = 30_000;

type Phase = 'idle' | 'pending' | 'restarting' | 'failed';

interface Persisted {
  count: number;
  baselineStartedAt: string | null;
}

interface PendingRestartContextValue {
  phase: Phase;
  count: number;
  error?: string;
  flagDirty: () => void;
  triggerRestart: () => Promise<void>;
}

const PendingRestartContext = createContext<PendingRestartContextValue | null>(null);

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { count: 0, baselineStartedAt: null };
    const parsed = JSON.parse(raw);
    return {
      count: typeof parsed.count === 'number' ? parsed.count : 0,
      baselineStartedAt:
        typeof parsed.baselineStartedAt === 'string' ? parsed.baselineStartedAt : null,
    };
  } catch {
    return { count: 0, baselineStartedAt: null };
  }
}

function persist(state: Persisted): void {
  try {
    if (state.count <= 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // quota / disabled
  }
}

export function PendingRestartProvider({ children }: { children: ReactNode }) {
  const initial = loadPersisted();
  const [count, setCount] = useState<number>(initial.count);
  const [baseline, setBaseline] = useState<string | null>(initial.baselineStartedAt);
  const [phase, setPhase] = useState<Phase>(initial.count > 0 ? 'pending' : 'idle');
  const [error, setError] = useState<string | undefined>();
  const countRef = useRef(initial.count);
  const phaseRef = useRef<Phase>(initial.count > 0 ? 'pending' : 'idle');
  const dirtyDuringRestartRef = useRef(0);

  const setCountValue = useCallback((next: number) => {
    countRef.current = next;
    setCount(next);
  }, []);

  const updateCount = useCallback((updater: (current: number) => number) => {
    setCount(current => {
      const next = updater(current);
      countRef.current = next;
      return next;
    });
  }, []);

  const setPhaseValue = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  useEffect(() => {
    persist({ count, baselineStartedAt: baseline });
  }, [count, baseline]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const live = await api.health.get();
        if (cancelled) return;
        setBaseline(b => {
          if (b !== null && live.startedAt !== b) {
            setCountValue(0);
            setPhaseValue('idle');
            return null;
          }
          return b;
        });
      } catch {
        // server unreachable on mount — leave persisted state alone
      }
    })();

    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      if (e.newValue === null) {
        if (phaseRef.current === 'restarting' && dirtyDuringRestartRef.current > 0) {
          setCountValue(dirtyDuringRestartRef.current);
          setBaseline(null);
          return;
        }
        setCountValue(0);
        setBaseline(null);
        if (phaseRef.current !== 'restarting') setPhaseValue('idle');
        return;
      }
      try {
        const parsed = JSON.parse(e.newValue);
        if (typeof parsed.count === 'number') {
          if (phaseRef.current === 'restarting' && parsed.count > countRef.current) {
            dirtyDuringRestartRef.current += parsed.count - countRef.current;
          }
          setCountValue(parsed.count);
          if (phaseRef.current !== 'restarting') {
            setPhaseValue(parsed.count > 0 ? 'pending' : 'idle');
          }
        }
        if (typeof parsed.baselineStartedAt === 'string') {
          setBaseline(parsed.baselineStartedAt);
        } else if (parsed.baselineStartedAt === null) {
          setBaseline(null);
        }
      } catch {
        // corrupt storage from another tab — ignore
      }
    };
    window.addEventListener('storage', onStorage);

    return () => {
      cancelled = true;
      window.removeEventListener('storage', onStorage);
    };
  }, [setCountValue, setPhaseValue]);

  const baselineFetchInFlightRef = useRef(false);

  const flagDirty = useCallback(() => {
    updateCount(c => c + 1);
    if (phaseRef.current === 'restarting') {
      dirtyDuringRestartRef.current += 1;
    } else {
      setPhaseValue('pending');
    }
    setBaseline(b => {
      if (b !== null || baselineFetchInFlightRef.current) return b;
      baselineFetchInFlightRef.current = true;
      void (async () => {
        try {
          const live = await api.health.get();
          setBaseline(latest => latest ?? live.startedAt);
        } catch {
          // health probe failed — baseline stays null
        } finally {
          baselineFetchInFlightRef.current = false;
        }
      })();
      return b;
    });
  }, [setPhaseValue, updateCount]);

  const triggerRestart = useCallback(async () => {
    dirtyDuringRestartRef.current = 0;
    setError(undefined);
    setPhaseValue('restarting');

    let beforeStartedAt: string;
    try {
      const before = await api.health.get();
      beforeStartedAt = before.startedAt;
    } catch (err) {
      setPhaseValue('failed');
      setError(`获取重启前 startedAt 失败: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    try {
      await api.server.restart();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
      } else {
        setPhaseValue('failed');
        setError(`触发重启失败: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }

    const start = Date.now();
    while (Date.now() - start < RESTART_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      try {
        const now = await api.health.get();
        if (now.startedAt !== beforeStartedAt) {
          const remaining = dirtyDuringRestartRef.current;
          dirtyDuringRestartRef.current = 0;
          setBaseline(remaining > 0 ? now.startedAt : null);
          setCountValue(remaining);
          setPhaseValue(remaining > 0 ? 'pending' : 'idle');
          return;
        }
      } catch {
        // server still down, keep polling
      }
    }

    setPhaseValue('failed');
    setError('重启超时（30s 未恢复）。请检查日志或手动 baxian start -c <path>');
  }, [setCountValue, setPhaseValue]);

  return (
    <PendingRestartContext.Provider
      value={{ phase, count, error, flagDirty, triggerRestart }}
    >
      {children}
    </PendingRestartContext.Provider>
  );
}

export function usePendingRestart(): PendingRestartContextValue {
  const ctx = useContext(PendingRestartContext);
  if (!ctx) {
    throw new Error('usePendingRestart must be used inside PendingRestartProvider');
  }
  return ctx;
}
