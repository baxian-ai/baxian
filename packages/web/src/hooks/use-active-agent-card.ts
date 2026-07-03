import { useCallback, useEffect, useId, useState } from 'react';

const TERMINAL_ACTIVATED_EVENT = 'baxian:terminal-activated';

interface TerminalActivatedDetail {
  ownerId: string;
}

interface UseActiveAgentCardOptions {
  coordinateAcrossInstances?: boolean;
}

export function useActiveAgentCard({
  coordinateAcrossInstances = true,
}: UseActiveAgentCardOptions = {}) {
  const ownerId = useId();
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);

  useEffect(() => {
    if (activeAgentId === null) return;

    const onDocClick = (e: MouseEvent) => {
      const path = e.composedPath();
      const insideCard = path.some(node => node instanceof Element && node.hasAttribute('data-agent-card'));
      if (!insideCard) setActiveAgentId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const focused = document.activeElement;
      if (focused instanceof Element && focused.closest('[data-agent-card]')) return;
      setActiveAgentId(null);
    };
    const onOtherActivated = (e: Event) => {
      const detail = (e as CustomEvent<TerminalActivatedDetail>).detail;
      if (detail?.ownerId !== ownerId) setActiveAgentId(null);
    };

    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKey);
    if (coordinateAcrossInstances) {
      document.addEventListener(TERMINAL_ACTIVATED_EVENT, onOtherActivated as EventListener);
    }
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
      if (coordinateAcrossInstances) {
        document.removeEventListener(TERMINAL_ACTIVATED_EVENT, onOtherActivated as EventListener);
      }
    };
  }, [activeAgentId, coordinateAcrossInstances, ownerId]);

  const activateAgentCard = useCallback((agentId: string) => {
    setActiveAgentId(agentId);
    if (coordinateAcrossInstances) {
      document.dispatchEvent(new CustomEvent<TerminalActivatedDetail>(TERMINAL_ACTIVATED_EVENT, {
        detail: { ownerId },
      }));
    }
  }, [coordinateAcrossInstances, ownerId]);

  return { activeAgentId, activateAgentCard };
}
