import { type ReactNode } from 'react';

export function TurnRow({
  role,
  label,
  summary,
  badge,
  onClick,
}: {
  role: 'dev' | 'qa';
  label: string;
  summary: string;
  badge?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="card flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:border-accent"
    >
      <span
        className={`shrink-0 min-w-[1.75rem] text-xs uppercase tracking-wide ${role === 'qa' ? 'text-[#c2410c]' : 'text-accent'}`}
      >
        {role === 'qa' ? 'QA' : 'dev'}
      </span>
      <span className="shrink-0 text-og-800">{label}</span>
      {badge}
      <span className="min-w-0 flex-1 truncate text-og-500">{summary}</span>
      <span aria-hidden className="shrink-0 text-og-300">›</span>
    </button>
  );
}
