import { useNavigate, useParams } from 'react-router-dom';
import type { GithubReviewItem, GithubReviewVerdict } from '../shared/index.js';
import {
  GITHUB_REVIEW_VERDICT_CLASS,
  groupGithubReviewRounds,
  githubReviewItemKey,
  githubReviewRevision,
  githubReviewRoundKey,
  type GithubReviewRound,
} from '../shared/github-review.js';
import { useTask } from '../hooks/use-events.ts';
import { useGithubReview } from '../hooks/use-github-review.ts';
import { useT, type Messages } from '../i18n/index.tsx';

const VERDICT_LABEL: Record<GithubReviewVerdict, string> = {
  approve: 'approve',
  'request-changes': 'request-changes',
  comment: 'comment',
};

function reasonOf(reason?: string): 'server-mode' | 'no-pr' | 'not-github' | undefined {
  return reason === 'server-mode' || reason === 'no-pr' || reason === 'not-github' ? reason : undefined;
}

function reasonText(t: Messages): Record<NonNullable<ReturnType<typeof reasonOf>>, string> {
  return {
    'server-mode': t.githubReview.reasonServerMode,
    'no-pr': t.githubReview.reasonNoPr,
    'not-github': t.githubReview.reasonNotGithub,
  };
}

function fmt(ts?: string): string {
  if (!ts) return '';
  const m = ts.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : ts;
}

export function GithubReviewPage() {
  const t = useT();
  const { taskId = '' } = useParams();
  const navigate = useNavigate();
  const { data: task } = useTask(taskId);
  const revision = task ? githubReviewRevision(task) : undefined;
  const { data, loaded, error } = useGithubReview(taskId, revision);

  const prNumber = data?.prNumber ?? task?.prNumber;
  const prUrl = data?.prUrl ?? task?.prUrl;
  const rounds = data ? groupGithubReviewRounds(data.items) : [];

  return (
    <div className="mx-auto w-full max-w-5xl">
      <button type="button" onClick={() => navigate(-1)} className="btn-ghost mb-3">
        {t.common.back}
      </button>
      <div className="mb-1 flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-og-400">{taskId}</span>
        <span className="text-sm font-semibold text-og-1000">{task?.title ?? ''}</span>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-og-500">
        <span className="pill">{t.githubReview.codeReviewHeading}</span>
        {prUrl && prNumber !== undefined && (
          <a href={prUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:text-accent-hover">
            {t.taskDetail.viewPr(prNumber)}
          </a>
        )}
      </div>

      {!loaded && <div className="text-sm text-og-500">{t.common.loading}</div>}
      {loaded && error && <div className="text-sm text-accent">{t.review.loadFailed(error)}</div>}
      {loaded && !error && data && !data.available && (
        <div className="text-sm text-og-500">{reasonText(t)[reasonOf(data.reason) ?? 'no-pr']}</div>
      )}
      {loaded && !error && data?.available &&
        (data.items.length === 0 ? (
          data.error ? (
            <div className="text-sm text-accent">{t.githubReview.fetchFailed(data.error)}</div>
          ) : (
            <div className="text-sm text-og-400">{t.review.notStarted}</div>
          )
        ) : (
          <>
            {data.error && (
              <div className="mb-3 text-xs text-accent">{t.githubReview.partialFetchFailed(data.error)}</div>
            )}
            <div className="space-y-5">
              {rounds.map((round, i) => (
                <RoundBlock key={githubReviewRoundKey(round, String(i))} round={round} index={i} />
              ))}
            </div>
          </>
        ))}
    </div>
  );
}

function RoundBlock({ round, index }: { round: GithubReviewRound; index: number }) {
  const t = useT();
  const label = round.review ? t.agents.round(index + 1) : t.status.in_progress;
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-og-700">{label}</div>
      <div className="space-y-2">
        {round.items.map((it, itemIndex) => (
          <ItemRow key={githubReviewItemKey(it, `${index}-${itemIndex}`)} item={it} />
        ))}
        {round.review && <ReviewBlock item={round.review} />}
      </div>
    </div>
  );
}

function ItemRow({ item }: { item: GithubReviewItem }) {
  const t = useT();
  if (item.kind === 'commit') {
    return (
      <div className="card p-3 text-sm">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="pill shrink-0">{t.githubReview.commitPill}</span>
          {item.commitSha && <span className="font-mono text-xs text-og-500">{item.commitSha.slice(0, 9)}</span>}
          {item.author && <span className="text-xs text-og-400">{item.author}</span>}
          {item.createdAt && <span className="text-xs text-og-400">{fmt(item.createdAt)}</span>}
        </div>
        {item.body && <div className="whitespace-pre-wrap break-words text-og-800">{item.body}</div>}
      </div>
    );
  }
  const isInline = item.kind === 'review-comment';
  return (
    <div className="card p-3 text-sm">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="pill shrink-0">{isInline ? t.githubReview.inlineComment : t.githubReview.comment}</span>
        {item.author && <span className="font-medium text-og-700">{item.author}</span>}
        {isInline && item.path && (
          <span className="min-w-0 break-all font-mono text-xs text-og-500">
            {item.line !== undefined ? `${item.path}:${item.line}` : item.path}
          </span>
        )}
        {item.inReplyTo && <span className="text-xs text-og-400">{t.githubReview.replyIndicator}</span>}
        {item.createdAt && <span className="text-xs text-og-400">{fmt(item.createdAt)}</span>}
      </div>
      <Body item={item} />
    </div>
  );
}

function ReviewBlock({ item }: { item: GithubReviewItem }) {
  const t = useT();
  const verdict = item.verdict ?? 'comment';
  return (
    <div className="card p-3 text-sm">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="shrink-0 min-w-[1.75rem] text-xs font-semibold tracking-wide text-og-600">
          {t.review.roleQa}
        </span>
        <span className={GITHUB_REVIEW_VERDICT_CLASS[verdict]}>{VERDICT_LABEL[verdict]}</span>
        {item.author && <span className="text-xs text-og-400">{item.author}</span>}
        {item.commitSha && <span className="font-mono text-xs text-og-500">{item.commitSha.slice(0, 9)}</span>}
        {item.createdAt && <span className="text-xs text-og-400">{fmt(item.createdAt)}</span>}
      </div>
      <Body item={item} placeholder={t.githubReview.noReviewBody} />
    </div>
  );
}

function Body({ item, placeholder }: { item: GithubReviewItem; placeholder?: string }) {
  const t = useT();
  return (
    <>
      {item.body ? (
        <div className="whitespace-pre-wrap break-words text-og-800">{item.body}</div>
      ) : placeholder ? (
        <div className="text-og-400">{placeholder}</div>
      ) : null}
      {item.bodyTruncated && <div className="mt-1 text-xs text-accent">{t.githubReview.bodyTruncated}</div>}
    </>
  );
}
