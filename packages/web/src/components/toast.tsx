import { createContext, useCallback, useContext, useEffect, useRef, useState, type ComponentType, type ReactNode, type SVGProps } from 'react';
import { AlertTriangleIcon, CheckCircleIcon, XCircleIcon } from './icons.tsx';
import { useT } from '../i18n/index.tsx';

export type ToastKind = 'success' | 'warn' | 'error';

interface ToastInput {
  kind: ToastKind;
  title: string;
  body?: string;
  durationMs?: number;
}

interface ToastItem extends Omit<ToastInput, 'durationMs'> {
  id: number;
  durationMs: number;
}

type HoldReason = 'hover' | 'focus';

interface ToastContextValue {
  show: (toast: ToastInput) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const KIND_CLASS: Record<ToastKind, string> = {
  success: 'border-hairline bg-surface text-og-800',
  warn: 'border-accent/25 bg-accent-soft text-accent',
  error: 'border-accent/25 bg-accent-soft text-accent',
};

const KIND_ICON: Record<ToastKind, ComponentType<SVGProps<SVGSVGElement>>> = {
  success: CheckCircleIcon,
  warn: AlertTriangleIcon,
  error: XCircleIcon,
};

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [items, setItems] = useState<ToastItem[]>([]);
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const holdsRef = useRef(new Map<number, Set<HoldReason>>());

  useEffect(() => {
    const timers = timersRef.current;
    const holds = holdsRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      holds.clear();
    };
  }, []);

  const clearTimer = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer) clearTimeout(timer);
    timersRef.current.delete(id);
  }, []);

  const dismiss = useCallback((id: number) => {
    clearTimer(id);
    holdsRef.current.delete(id);
    setItems(prev => prev.filter(item => item.id !== id));
  }, [clearTimer]);

  const scheduleDismiss = useCallback((id: number, duration: number) => {
    clearTimer(id);
    timersRef.current.set(id, setTimeout(() => dismiss(id), duration));
  }, [clearTimer, dismiss]);

  // hover 与 focus 是相互独立的暂停原因：只有两者都释放后才恢复倒计时。
  const hold = useCallback((id: number, reason: HoldReason) => {
    const set = holdsRef.current.get(id) ?? new Set<HoldReason>();
    set.add(reason);
    holdsRef.current.set(id, set);
    clearTimer(id);
  }, [clearTimer]);

  const release = useCallback((id: number, reason: HoldReason, duration: number) => {
    const set = holdsRef.current.get(id);
    set?.delete(reason);
    if (!set || set.size === 0) scheduleDismiss(id, duration);
  }, [scheduleDismiss]);

  const show = useCallback((input: ToastInput) => {
    const id = nextId++;
    const duration = input.durationMs ?? 3000;
    setItems(prev => [...prev, { ...input, id, durationMs: duration }]);
    scheduleDismiss(id, duration);
  }, [scheduleDismiss]);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="pointer-events-none fixed inset-x-4 top-4 z-[60] flex flex-col items-end gap-2">
        {items.map(item => (
          <div
            key={item.id}
            className={`pointer-events-auto w-full max-w-xs rounded-lg border px-4 py-3 shadow-toast ${KIND_CLASS[item.kind]}`}
            role="status"
            onMouseEnter={() => hold(item.id, 'hover')}
            onMouseLeave={() => release(item.id, 'hover', item.durationMs)}
            onFocus={() => hold(item.id, 'focus')}
            onBlur={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node)) return;
              release(item.id, 'focus', item.durationMs);
            }}
          >
            <div className="flex items-start gap-2">
              {(() => { const Icon = KIND_ICON[item.kind]; return <Icon className="mt-0.5 shrink-0" width={14} height={14} />; })()}
              <div className="flex-1">
                <div className="text-sm font-semibold">{item.title}</div>
                {item.body && <div className="mt-1 whitespace-pre-line text-xs text-og-700">{item.body}</div>}
              </div>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                className="text-current opacity-50 transition-opacity hover:opacity-100"
                aria-label={t.toast.dismissAriaLabel}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be inside <ToastProvider>');
  return ctx;
}
