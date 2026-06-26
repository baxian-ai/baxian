export type ArrowKey = 'up' | 'down' | 'left' | 'right';

interface ArrowDef {
  key: ArrowKey;
  label: string;
  path: string;
}

const ARROWS: ArrowDef[] = [
  { key: 'up',    label: '上', path: 'M12 5l-6 6m6-6l6 6m-6-6v14' },
  { key: 'down',  label: '下', path: 'M12 19l6-6m-6 6l-6-6m6 6V5' },
  { key: 'left',  label: '左', path: 'M5 12l6-6m-6 6l6 6m-6-6h14' },
  { key: 'right', label: '右', path: 'M19 12l-6-6m6 6l-6 6m6-6H5' },
];

const ARROW_BY_KEY: Record<ArrowKey, ArrowDef> = Object.fromEntries(
  ARROWS.map((a) => [a.key, a]),
) as Record<ArrowKey, ArrowDef>;

interface ArrowButtonProps {
  arrow: ArrowDef;
  onPress: (key: ArrowKey) => void;
}

function ArrowButton({ arrow, onPress }: ArrowButtonProps) {
  return (
    <button
      type="button"
      aria-label={`方向键 ${arrow.label}`}
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
  className?: string;
}

export function TerminalKeyPad({ onKey, className }: TerminalKeyPadProps) {
  return (
    <div
      role="group"
      aria-label="终端方向键"
      className={
        className ??
        'flex flex-none items-center justify-center gap-1 border-t border-hairline bg-page px-3 py-2'
      }
    >
      <ArrowButton arrow={ARROW_BY_KEY.left} onPress={onKey} />
      <ArrowButton arrow={ARROW_BY_KEY.up} onPress={onKey} />
      <ArrowButton arrow={ARROW_BY_KEY.down} onPress={onKey} />
      <ArrowButton arrow={ARROW_BY_KEY.right} onPress={onKey} />
    </div>
  );
}
