import { useEffect, useRef, type ReactNode } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  titleContent?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  dismissOnBackdrop?: boolean;
}

const SIZE_CLASS: Record<NonNullable<Props['size']>, string> = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
};

const FOCUSABLE_SELECTOR =
  'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function Modal({ open, onClose, title, titleContent, children, footer, size = 'md', dismissOnBackdrop = true }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const pointerDownOnBackdropRef = useRef(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;

    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = containerRef.current;
      if (!root) return;
      const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter(el => el.offsetParent !== null || el === document.activeElement);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !root.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const root = containerRef.current;
    if (root) {
      const first = root.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      first?.focus();
    }

    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = prevOverflow;
      previouslyFocusedRef.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-og-1000/45 px-3 sm:px-4"
      onMouseDown={dismissOnBackdrop ? e => { pointerDownOnBackdropRef.current = e.target === e.currentTarget; } : undefined}
      onClick={dismissOnBackdrop ? e => { if (e.target === e.currentTarget && pointerDownOnBackdropRef.current) onCloseRef.current(); } : undefined}
      role="presentation"
    >
      <div
        ref={containerRef}
        className={`flex w-full ${SIZE_CLASS[size]} max-h-[90dvh] flex-col overflow-hidden rounded-lg border border-og-100 bg-surface shadow-modal`}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline px-5 py-3">
          <h2 title={title} className="min-w-0 truncate font-display text-[15px] font-semibold tracking-tight text-og-1000">
            {titleContent ?? title}
          </h2>
          <button
            type="button"
            onClick={() => onCloseRef.current()}
            className="-mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-og-400 transition-colors hover:bg-og-50 hover:text-og-800"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-hairline px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
