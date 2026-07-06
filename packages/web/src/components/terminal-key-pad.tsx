import { useT } from '../i18n/index.tsx';

export type ArrowKey = 'up' | 'down' | 'left' | 'right';

interface ArrowDef {
  key: ArrowKey;
  path: string;
}

const ARROWS: ArrowDef[] = [
  { key: 'up',    path: 'M12 5l-6 6m6-6l6 6m-6-6v14' },
  { key: 'down',  path: 'M12 19l6-6m-6 6l-6-6m6 6V5' },
  { key: 'left',  path: 'M5 12l6-6m-6 6l6 6m-6-6h14' },
  { key: 'right', path: 'M19 12l-6-6m6 6l-6 6m6-6H5' },
];

const ARROW_BY_KEY: Record<ArrowKey, ArrowDef> = Object.fromEntries(
  ARROWS.map((a) => [a.key, a]),
) as Record<ArrowKey, ArrowDef>;

interface ArrowButtonProps {
  arrow: ArrowDef;
  ariaLabel: string;
  onPress: (key: ArrowKey) => void;
}

function ArrowButton({ arrow, ariaLabel, onPress }: ArrowButtonProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      data-arrow={arrow.key}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onPress(arrow.key)}
      className="flex h-8 w-8 items-center justify-center rounded border border-hairline bg-surface text-og-700 transition-colors hover:bg-og-50 hover:text-og-1000 active:bg-og-200"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={arrow.path} />
      </svg>
    </button>
  );
}

export interface TerminalKeyPadProps {
  onKey: (key: ArrowKey) => void;
  onEscape?: () => void;
  className?: string;
}

export function TerminalKeyPad({ onKey, onEscape, className }: TerminalKeyPadProps) {
  const t = useT();
  return (
    <div
      role="group"
      aria-label={t.terminal.keyPadAriaLabel}
      className={
        className ??
        'flex flex-none items-center justify-center gap-1 border-t border-hairline bg-page px-3 py-2'
      }
    >
      {onEscape && (
        <button
          type="button"
          aria-label={t.terminal.escKeyAriaLabel}
          data-key="escape"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onEscape}
          className="mr-2 flex h-8 items-center justify-center rounded border border-hairline bg-surface px-2.5 font-mono text-xs text-og-700 transition-colors hover:bg-og-50 hover:text-og-1000 active:bg-og-200"
        >
          ESC
        </button>
      )}
      <ArrowButton arrow={ARROW_BY_KEY.left} ariaLabel={t.terminal.arrowAriaLabel(t.terminal.arrowLabel.left)} onPress={onKey} />
      <ArrowButton arrow={ARROW_BY_KEY.up} ariaLabel={t.terminal.arrowAriaLabel(t.terminal.arrowLabel.up)} onPress={onKey} />
      <ArrowButton arrow={ARROW_BY_KEY.down} ariaLabel={t.terminal.arrowAriaLabel(t.terminal.arrowLabel.down)} onPress={onKey} />
      <ArrowButton arrow={ARROW_BY_KEY.right} ariaLabel={t.terminal.arrowAriaLabel(t.terminal.arrowLabel.right)} onPress={onKey} />
    </div>
  );
}
