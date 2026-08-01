import { type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { isSpecStagePhase, type PrReviewItem, type TaskState } from '../shared/index.js';
import {
  PR_REVIEW_VERDICT_CLASS,
  groupPrReviewRounds,
  prReviewItemAnchor,
  prReviewItemKey,
  prReviewRevision,
  prReviewRoundKey,
  type PrReviewRound,
} from '../shared/pr-review.js';
import { usePrReview } from '../hooks/use-pr-review.ts';
import { ReviewFreshness } from './review-freshness.tsx';
import { TurnRow } from './review-turn-row.tsx';
import { useT, type Messages } from '../i18n/index.tsx';

interface Props {
  task: TaskState;
}

function reasonText(t: Messages): Record<string, string> {
  return {
    'no-pr': t.prReview.reasonNoPr,
    'driver-unavailable': t.prReview.reasonDriverUnavailable,
  };
}

function firstLine(value?: string): string {
  return value?.trim().split('\n', 1)[0] ?? '';
}

function inlineLocation(item: PrReviewItem): string | undefined {
  if (item.kind !== 'review-comment' || !item.path) return undefined;
  return item.line !== undefined ? `${item.path}:${item.line}` : item.path;
}

function truncatedSuffix(t: Messages, item: PrReviewItem): string {
  return item.bodyTruncated ? t.prReview.truncatedSuffix : '';
}

function itemSummary(t: Messages, item: PrReviewItem): string {
  const body = firstLine(item.body);
  const suffix = truncatedSuffix(t, item);
  if (item.kind === 'review-comment') {
    const loc = inlineLocation(item);
    if (item.inReplyTo) {
      const parts = [item.author, loc, body].filter((part): part is string => !!part);
      if (parts.length > 0) return `${parts.join(' · ')}${suffix}`;
    }
    if (loc && body) return `${loc} · ${body}${suffix}`;
    return `${body || loc || t.prReview.inlineComment}${suffix}`;
  }
  if (item.kind === 'issue-comment') {
    if (item.author && body) return `${item.author} · ${body}${suffix}`;
    return `${body || item.author || t.prReview.comment}${suffix}`;
  }
  return `${body || t.prReview.noReviewBodyFallback}${suffix}`;
}

function itemLabel(t: Messages, item: PrReviewItem): string {
  if (item.verdict !== undefined || item.kind === 'review') return t.review.reviewTurnLabel;
  if (item.kind === 'review-comment') return item.inReplyTo ? t.review.responseTurnLabel : t.prReview.inlineComment;
  return t.prReview.comment;
}

function itemRole(item: PrReviewItem): 'dev' | 'qa' {
  if (item.verdict !== undefined) return 'qa';
  return item.kind === 'issue-comment' || item.inReplyTo ? 'dev' : 'qa';
}

export function PrReviewEntry({ task }: Props) {
  const t = useT();
  const navigate = useNavigate();
  const revision = prReviewRevision(task);
  const { data, loaded, error, refresh, refreshing, refreshError } = usePrReview(task.id, revision);
  const heading = isSpecStagePhase(task.phase)
    ? t.prReview.specReviewHeading
    : t.prReview.codeReviewHeading;

  function open(anchor?: string) {
    navigate(`/tasks/${encodeURIComponent(task.id)}/pr-review${anchor ? `#${anchor}` : ''}`);
  }

  if (error) {
    return (
      <ReviewGroup title={heading}>
        <div className="text-sm text-accent">{t.review.loadFailed(error)}</div>
      </ReviewGroup>
    );
  }

  if (!loaded) {
    return (
      <ReviewGroup title={heading}>
        <div className="text-sm text-og-400">{t.review.loadingRecords}</div>
      </ReviewGroup>
    );
  }

  if (!data?.available) {
    const reasons = reasonText(t);
    return (
      <ReviewGroup title={heading}>
        <div className="text-sm text-og-400">{reasons[data?.reason ?? 'no-pr'] ?? reasons['no-pr']}</div>
      </ReviewGroup>
    );
  }

  const freshness = (
    <ReviewFreshness data={data} onRefresh={refresh} refreshing={refreshing} refreshError={refreshError} />
  );

  if (data.items.length === 0) {
    return (
      <ReviewGroup title={heading}>
        {freshness}
        {data.truncated ? (
          <div className="text-sm text-accent">{t.prReview.listTruncated}</div>
        ) : data.error ? (
          <div className="text-sm text-accent">{t.prReview.fetchFailed(data.error)}</div>
        ) : (
          <div className="text-sm text-og-400">{t.review.notStarted}</div>
        )}
      </ReviewGroup>
    );
  }

  const rounds = groupPrReviewRounds(data.items);

  return (
    <ReviewGroup title={heading}>
      {freshness}
      {data.error && (
        <div className="text-xs text-accent">{t.prReview.partialFetchFailed(data.error)}</div>
      )}
      {data.truncated && <div className="text-xs text-accent">{t.prReview.listTruncated}</div>}
      {rounds.map((round, index) => (
        <RoundBlock key={prReviewRoundKey(round, String(index))} round={round} index={index} onOpen={open} />
      ))}
    </ReviewGroup>
  );
}

function ReviewGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-xs text-og-700">{title}</div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function RoundBlock({
  round,
  index,
  onOpen,
}: {
  round: PrReviewRound;
  index: number;
  onOpen: (anchor?: string) => void;
}) {
  const t = useT();
  const label = round.review ? t.agents.round(index + 1) : t.status.in_progress;
  return (
    <div>
      <div className="mb-1 text-xs text-og-400">{label}</div>
      <div className="space-y-1.5">
        {round.items.map((item, itemIndex) => (
          <PlatformTurnRow key={prReviewItemKey(item, `${index}-${itemIndex}`)} item={item} onOpen={onOpen} />
        ))}
        {round.review && <PlatformTurnRow item={round.review} onOpen={onOpen} />}
      </div>
    </div>
  );
}

function PlatformTurnRow({ item, onOpen }: { item: PrReviewItem; onOpen: (anchor?: string) => void }) {
  const t = useT();
  const verdict = item.verdict;
  const badge = verdict
    ? <span className={PR_REVIEW_VERDICT_CLASS[verdict]}>{verdict}</span>
    : item.kind === 'review' && item.reviewState
      ? <span className="pill">{item.reviewState}</span>
      : undefined;
  return (
    <TurnRow
      role={itemRole(item)}
      label={itemLabel(t, item)}
      badge={badge}
      summary={itemSummary(t, item)}
      onClick={() => onOpen(prReviewItemAnchor(item))}
    />
  );
}
