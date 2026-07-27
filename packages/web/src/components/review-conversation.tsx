import type { TaskState } from '../shared/index.js';
import { useT } from '../i18n/index.tsx';
import { PrReviewEntry } from './pr-review-entry.tsx';

interface Props {
  task: TaskState;
}

export function ReviewConversation({ task }: Props) {
  const t = useT();
  if (task.prNumber === undefined) return null;
  return (
    <section className="mt-4" aria-label={t.review.sectionTitle}>
      <div className="mb-2 text-sm text-og-700">{t.review.sectionTitle}</div>
      <PrReviewEntry task={task} />
    </section>
  );
}
