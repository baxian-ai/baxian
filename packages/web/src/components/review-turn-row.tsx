import { type ReactNode } from 'react';
import { useT } from '../i18n/index.tsx';

export function TurnRow({
  role,
  label,
  summary,
  badge,
  onClick,
}: {
  role: 'dev' | 'qa' | 'user';
  label: string;
  summary: string;
  badge?: ReactNode;
  onClick: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      className="card flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
    >
      <span className="shrink-0 min-w-[1.75rem] text-xs tracking-wide text-og-600">
        {role === 'qa' ? t.review.roleQa : role === 'user' ? t.review.roleUser : t.review.roleDev}
      </span>
      <span className="shrink-0 text-og-800">{label}</span>
      {badge}
      <span className="min-w-0 flex-1 truncate text-og-500">{summary}</span>
      <span aria-hidden className="shrink-0 text-og-300">›</span>
    </button>
  );
}
