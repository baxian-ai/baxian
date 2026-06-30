import { useNavigate } from 'react-router-dom';
import type { TaskState } from '../shared/index.js';

interface Props {
  task: TaskState;
}

export function GithubReviewEntry({ task }: Props) {
  const navigate = useNavigate();
  if (task.reviewMode === 'server' || task.prNumber === undefined) return null;

  function open() {
    navigate(`/tasks/${encodeURIComponent(task.id)}/github-review`);
  }

  return (
    <section className="mt-4" aria-label="Dev ↔ QA 代码评审">
      <div className="mb-2 text-[11px] font-normal uppercase tracking-[0.05em] text-og-500">
        Dev ↔ QA 代码评审 (GitHub PR)
      </div>
      <button
        type="button"
        onClick={open}
        className="card flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:border-accent"
      >
        <span className="pill pill-review shrink-0">QA</span>
        <span className="min-w-0 flex-1 truncate text-og-700">
          查看 PR 评审过程（QA review、行内评论、dev 修复 commit）
        </span>
        <span aria-hidden className="shrink-0 text-og-300">›</span>
      </button>
    </section>
  );
}
