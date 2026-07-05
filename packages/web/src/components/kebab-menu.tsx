import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type MutableRefObject, type ReactNode } from 'react';

export function MenuItem({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`block w-full px-3 py-1.5 text-left text-sm text-og-1000 hover:bg-og-50 disabled:opacity-50 disabled:cursor-not-allowed ${className ?? ''}`}
      {...rest}
    />
  );
}

export interface KebabMenuProps {
  ariaLabel: string;
  children: (close: () => void) => ReactNode;
  placement?: 'down' | 'up';
  autoFocusFirstItem?: boolean;
  menuClassName?: string;
  className?: string;
  disabled?: boolean;
  triggerRef?: MutableRefObject<HTMLButtonElement | null>;
}

export function KebabMenu({
  ariaLabel,
  children,
  placement = 'down',
  autoFocusFirstItem = false,
  menuClassName = 'min-w-[140px]',
  className,
  disabled = false,
  triggerRef,
}: KebabMenuProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const triggerId = useId();

  useEffect(() => {
    if (!open) return;
    const handlePointer = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !autoFocusFirstItem) return;
    const firstItem = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])');
    firstItem?.focus();
  }, [open, autoFocusFirstItem]);

  return (
    <div className={`relative ${className ?? ''}`}>
      <button
        ref={(el) => {
          buttonRef.current = el;
          if (triggerRef) triggerRef.current = el;
        }}
        id={triggerId}
        type="button"
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        className="flex h-8 w-8 items-center justify-center rounded text-og-500 transition-colors hover:bg-og-50 hover:text-og-1000 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="1" />
          <circle cx="12" cy="5" r="1" />
          <circle cx="12" cy="19" r="1" />
        </svg>
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-labelledby={triggerId}
          className={`absolute right-0 z-10 rounded-md border border-hairline bg-surface py-1 shadow-md ${placement === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'} ${menuClassName}`}
        >
          {children(() => {
            setOpen(false);
            buttonRef.current?.focus();
          })}
        </div>
      )}
    </div>
  );
}
