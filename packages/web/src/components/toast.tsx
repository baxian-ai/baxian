import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

export type ToastKind = 'success' | 'warn' | 'error';

interface ToastInput {
  kind: ToastKind;
  title: string;
  body?: string;
  durationMs?: number;
}

interface ToastItem extends ToastInput {
  id: number;
}

interface ToastContextValue {
  show: (toast: ToastInput) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const KIND_CLASS: Record<ToastKind, string> = {
  success: 'border-[#bbf7d0] bg-[#f0fdf4] text-success',
  warn: 'border-[#fde68a] bg-[#fef3c7] text-warn',
  error: 'border-[#fecaca] bg-[#fef2f2] text-danger',
};

const KIND_ICON: Record<ToastKind, string> = {
  success: '✅',
  warn: '⚠️',
  error: '❌',
};

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems(prev => prev.filter(t => t.id !== id));
  }, []);

  const show = useCallback((input: ToastInput) => {
    const id = nextId++;
    const duration = input.durationMs ?? 3000;
    setItems(prev => [...prev, { ...input, id }]);
    setTimeout(() => dismiss(id), duration);
  }, [dismiss]);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="pointer-events-none fixed inset-x-4 top-4 z-[60] flex flex-col items-end gap-2">
        {items.map(t => (
          <div
            key={t.id}
            className={`pointer-events-auto w-full max-w-xs rounded-lg border px-4 py-3 shadow-toast ${KIND_CLASS[t.kind]}`}
            role="status"
          >
            <div className="flex items-start gap-2">
              <span aria-hidden className="text-base">{KIND_ICON[t.kind]}</span>
              <div className="flex-1">
                <div className="text-sm font-semibold">{t.title}</div>
                {t.body && <div className="mt-1 whitespace-pre-line text-xs text-og-700">{t.body}</div>}
              </div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="text-current opacity-50 transition-opacity hover:opacity-100"
                aria-label="Dismiss"
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
