import { type ReactNode, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export const TOPBAR_ACTIONS_ID = 'topbar-actions';

function readTopbarActionsTarget(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.getElementById(TOPBAR_ACTIONS_ID);
}

export function TopbarActions({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(readTopbarActionsTarget);

  useEffect(() => {
    if (!target) setTarget(readTopbarActionsTarget());
  }, [target]);

  if (!target) return null;

  return createPortal(children, target);
}
