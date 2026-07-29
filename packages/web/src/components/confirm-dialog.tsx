import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Modal } from './modal.tsx';
import { useT } from '../i18n/index.tsx';

interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface PendingConfirm extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const pendingRef = useRef<PendingConfirm | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      pendingRef.current?.resolve(false);
      const next = { ...options, resolve };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    const current = pendingRef.current;
    if (!current) return;
    pendingRef.current = null;
    setPending(null);
    current.resolve(value);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <Modal
          open
          title={pending.title}
          onClose={() => settle(false)}
          size="sm"
          footer={
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => settle(false)} className="btn-secondary">
                {pending.cancelLabel ?? t.common.cancel}
              </button>
              <button type="button" onClick={() => settle(true)} className="btn-primary">
                {pending.confirmLabel ?? t.common.confirm}
              </button>
            </div>
          }
        >
          {pending.body ? (
            <p className="whitespace-pre-line text-sm text-og-700">{pending.body}</p>
          ) : null}
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be inside <ConfirmProvider>');
  return ctx;
}
