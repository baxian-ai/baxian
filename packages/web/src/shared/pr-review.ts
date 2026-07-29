import type { PrReviewItem, PrReviewVerdict, TaskState } from './types.js';

export interface PrReviewRound {
  items: PrReviewItem[];
  review?: PrReviewItem;
}

export const PR_REVIEW_VERDICT_CLASS: Record<PrReviewVerdict, string> = {
  approve: 'pill pill-live',
  'request-changes': 'pill pill-warn',
  comment: 'pill',
};

export function groupPrReviewRounds(items: PrReviewItem[]): PrReviewRound[] {
  const tokenDriven = items.some(i => i.roundToken !== undefined);
  const closesRound = (item: PrReviewItem): boolean =>
    tokenDriven ? item.roundToken !== undefined : item.kind === 'review';
  const rounds: PrReviewRound[] = [];
  let bucket: PrReviewItem[] = [];
  for (const item of items) {
    if (closesRound(item)) {
      rounds.push({ items: bucket, review: item });
      bucket = [];
    } else {
      bucket.push(item);
    }
  }
  if (bucket.length > 0) rounds.push({ items: bucket });
  return rounds;
}

export function prReviewItemKey(item: PrReviewItem, fallback: string): string {
  const idPart = item.id || item.commitSha || item.createdAt || item.body || fallback;
  return item.sourceKey !== undefined
    ? JSON.stringify([item.kind, item.sourceKey, idPart])
    : `${item.kind}-${idPart}`;
}

export function prReviewItemAnchor(item: PrReviewItem): string | undefined {
  if (!item.id) return undefined;
  return item.sourceKey !== undefined
    ? `pr-${item.kind}.${item.sourceKey}.${item.id}`
    : `pr-${item.kind}-${item.id}`;
}

export function prReviewRoundKey(round: PrReviewRound, fallback: string): string {
  if (round.review) return `round-${prReviewItemKey(round.review, fallback)}`;
  return `round-in-progress-${round.items[0] ? prReviewItemKey(round.items[0], fallback) : fallback}`;
}

export function prReviewRevision(task: Pick<TaskState, 'reviewRound' | 'latestHeadSha' | 'status' | 'reviewDispatchedAt' | 'prFeedbackReceivedAt' | 'prNumber' | 'reviewConversationUpdatedAt' | 'closedUnmergedAnchor'>): string {
  const anchor = task.closedUnmergedAnchor;
  return [
    task.reviewRound,
    task.latestHeadSha ?? '',
    task.status,
    task.reviewDispatchedAt ?? '',
    task.prFeedbackReceivedAt ?? '',
    task.prNumber ?? '',
    task.reviewConversationUpdatedAt ?? '',
    anchor === undefined ? '' : `${anchor.generation}/${anchor.cleared === true ? 'reopened' : 'closed'}`,
  ].join(':');
}
