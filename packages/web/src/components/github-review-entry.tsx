import { useNavigate } from 'react-router-dom';
import type { TaskState } from '../shared/index.js';

interface Props {
  task: TaskState;
}

export function GithubReviewEntry({ task }: Props) {
  const navigate = useNavigate();

  function open() {
    navigate(`/tasks/${encodeURIComponent(task.id)}/github-review`);
  }

  return (
    <div>
      <div className="mb-1.5 text-[12px] text-og-700">代码评审</div>
      <button
        type="button"
        onClick={open}
        className="card flex w-full items-center gap-2 px-3 py-2 text-left text-[14px] hover:border-accent"
      >
        <span className="shrink-0 min-w-[1.75rem] text-[12px] uppercase tracking-wide text-[#c2410c]">
          QA
        </span>
        <span className="min-w-0 flex-1 truncate text-og-700">
          查看 PR 评审过程（QA review、行内评论、dev 修复 commit）
        </span>
        <span aria-hidden className="shrink-0 text-og-300">›</span>
      </button>
    </div>
  );
}
