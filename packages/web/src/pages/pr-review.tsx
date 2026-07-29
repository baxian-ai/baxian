import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  isSpecStagePhase,
  safeExternalHref,
  type PrReviewItem,
  type PrReviewVerdict,
} from '../shared/index.js';
import {
  PR_REVIEW_VERDICT_CLASS,
  groupPrReviewRounds,
  prReviewItemAnchor,
  prReviewItemKey,
  prReviewRevision,
  prReviewRoundKey,
  type PrReviewRound,
} from '../shared/pr-review.js';
import { useTask } from '../hooks/use-events.ts';
import { usePrReview } from '../hooks/use-pr-review.ts';
import { MarkdownLite } from '../components/markdown-lite.tsx';
import { useT, type Messages } from '../i18n/index.tsx';

const VERDICT_LABEL: Record<PrReviewVerdict, string> = {
  approve: 'approve',
  'request-changes': 'request-changes',
  comment: 'comment',
};

function reasonOf(reason?: string): 'no-pr' | 'driver-unavailable' | undefined {
  return reason === 'no-pr' || reason === 'driver-unavailable'
    ? reason
    : undefined;
}

function reasonText(t: Messages): Record<NonNullable<ReturnType<typeof reasonOf>>, string> {
  return {
    'no-pr': t.prReview.reasonNoPr,
    'driver-unavailable': t.prReview.reasonDriverUnavailable,
  };
}

function fmt(ts?: string): string {
  if (!ts) return '';
  const m = ts.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : ts;
}

export function PrReviewPage() {
  const t = useT();
  const { taskId = '' } = useParams();
  const navigate = useNavigate();
  const { hash } = useLocation();
  const { data: task } = useTask(taskId);
  const revision = task ? prReviewRevision(task) : undefined;
  const { data, loaded, error } = usePrReview(taskId, revision);
  const [flashId, setFlashId] = useState<string | null>(null);

  const prNumber = data?.prNumber ?? task?.prNumber;
  const prUrl = data?.prUrl ?? task?.prUrl;
  const prHref = safeExternalHref(prUrl);
  const rounds = data ? groupPrReviewRounds(data.items) : [];
  const itemsReady = loaded && !error && data?.available === true && data.items.length > 0;
  const heading = isSpecStagePhase(task?.phase)
    ? t.prReview.specReviewHeading
    : t.prReview.codeReviewHeading;

  const landedRef = useRef<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(flashTimerRef.current), []);

  useEffect(() => {
    let anchor: string | null = null;
    if (hash) {
      try {
        anchor = decodeURIComponent(hash.slice(1));
      } catch {
        anchor = null;
      }
    }
    if (!anchor) {
      landedRef.current = null;
      setFlashId(null);
      return;
    }
    if (landedRef.current === anchor) return;
    if (!itemsReady || !data) return;
    const el = document.getElementById(anchor);
    if (!el) return;
    landedRef.current = anchor;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlashId(anchor);
    clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashId(null), 2000);
  }, [itemsReady, data, hash]);

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
        <span className="pill">{heading}</span>
        {prHref && prNumber !== undefined && (
          <a href={prHref} target="_blank" rel="noopener noreferrer" className="text-accent hover:text-accent-hover">
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
          data.truncated ? (
            <div className="text-sm text-accent">{t.prReview.listTruncated}</div>
          ) : data.error ? (
            <div className="text-sm text-accent">{t.prReview.fetchFailed(data.error)}</div>
          ) : (
            <div className="text-sm text-og-400">{t.review.notStarted}</div>
          )
        ) : (
          <>
            {data.error && (
              <div className="mb-3 text-xs text-accent">{t.prReview.partialFetchFailed(data.error)}</div>
            )}
            {data.truncated && <div className="mb-3 text-xs text-accent">{t.prReview.listTruncated}</div>}
            <div className="space-y-5">
              {rounds.map((round, i) => (
                <RoundBlock key={prReviewRoundKey(round, String(i))} round={round} index={i} flashId={flashId} />
              ))}
            </div>
          </>
        ))}
    </div>
  );
}

function RoundBlock({ round, index, flashId }: { round: PrReviewRound; index: number; flashId: string | null }) {
  const t = useT();
  const label = round.review ? t.agents.round(index + 1) : t.status.in_progress;
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-og-700">{label}</div>
      <div className="space-y-2">
        {round.items.map((it, itemIndex) => (
          it.kind === 'review'
            ? <ReviewBlock key={prReviewItemKey(it, `${index}-${itemIndex}`)} item={it} flashId={flashId} />
            : <ItemRow key={prReviewItemKey(it, `${index}-${itemIndex}`)} item={it} flashId={flashId} />
        ))}
        {round.review && <ReviewBlock item={round.review} flashId={flashId} />}
      </div>
    </div>
  );
}

function itemCardClass(item: PrReviewItem, flashId: string | null): string {
  const anchor = prReviewItemAnchor(item);
  return `card p-3 text-sm${anchor && anchor === flashId ? ' ring-2 ring-accent' : ''}`;
}

function ItemRow({ item, flashId }: { item: PrReviewItem; flashId: string | null }) {
  const t = useT();
  const isInline = item.kind === 'review-comment';
  return (
    <div id={prReviewItemAnchor(item)} className={itemCardClass(item, flashId)}>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="pill shrink-0">{isInline ? t.prReview.inlineComment : t.prReview.comment}</span>
        {item.author
          ? <span className="font-medium text-og-700">{item.author}</span>
          : <span className="text-xs italic text-og-400">{t.prReview.ghostAuthor}</span>}
        {isInline && item.path && (
          <span className="min-w-0 break-all font-mono text-xs text-og-500">
            {item.line !== undefined ? `${item.path}:${item.line}` : item.path}
          </span>
        )}
        {item.inReplyTo && <span className="text-xs text-og-400">{t.prReview.replyIndicator}</span>}
        {item.createdAt && <span className="text-xs text-og-400">{fmt(item.createdAt)}</span>}
      </div>
      <Body item={item} />
    </div>
  );
}

function ReviewBlock({ item, flashId }: { item: PrReviewItem; flashId: string | null }) {
  const t = useT();
  const verdict = item.verdict ?? 'comment';
  return (
    <div id={prReviewItemAnchor(item)} className={itemCardClass(item, flashId)}>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="shrink-0 min-w-[1.75rem] text-xs font-semibold tracking-wide text-og-600">
          {t.review.roleQa}
        </span>
        <span className={PR_REVIEW_VERDICT_CLASS[verdict]}>{VERDICT_LABEL[verdict]}</span>
        {item.reviewState && <span className="pill shrink-0">{item.reviewState}</span>}
        {item.author
          ? <span className="text-xs text-og-400">{item.author}</span>
          : <span className="text-xs italic text-og-400">{t.prReview.ghostAuthor}</span>}
        {item.commitSha && <span className="font-mono text-xs text-og-500">{item.commitSha.slice(0, 9)}</span>}
        {!item.commitSha && item.anchorSha && (
          <span className="font-mono text-xs text-og-500">{item.anchorSha.slice(0, 9)}</span>
        )}
        {item.createdAt && <span className="text-xs text-og-400">{fmt(item.createdAt)}</span>}
      </div>
      <Body item={item} placeholder={t.prReview.noReviewBody} />
    </div>
  );
}

function Body({ item, placeholder }: { item: PrReviewItem; placeholder?: string }) {
  const t = useT();
  return (
    <>
      {item.body ? (
        <div className="text-og-800">
          <MarkdownLite text={item.body} />
        </div>
      ) : placeholder ? (
        <div className="text-og-400">{placeholder}</div>
      ) : null}
      {item.bodyTruncated && <div className="mt-1 text-xs text-accent">{t.prReview.bodyTruncated}</div>}
    </>
  );
}
