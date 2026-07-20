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

// 任一 item 携 roundToken 即令牌驱动分轮（降级载体可闭轮）；无令牌沿 native review 分轮。
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
  // JSON tuple 编码保证单射：sourceKey 与 id 都允许 '-'，朴素拼接会让 ('a-b','c') 与 ('a','b-c') 撞 key。
  return item.sourceKey !== undefined
    ? JSON.stringify([item.kind, item.sourceKey, idPart])
    : `${item.kind}-${idPart}`;
}

// driver 时间线项以 '.' 定界纳入 sourceKey（kind 与 sourceKey 形态均禁 '.'，id 居末位故单射）；
// legacy 项保持旧锚形态。
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

// 字段必须保持 server/src/github/pr-conversation-cache.ts 服务端 revision 的前缀子集：
// 这里任何触发重拉的变化在服务端缓存必然 miss。prNumber 在列，PR 重绑定即重拉；
// reviewConversationUpdatedAt 承载 git 时间线的展示刷新。
export function prReviewRevision(task: Pick<TaskState, 'reviewRound' | 'latestHeadSha' | 'status' | 'reviewDispatchedAt' | 'prFeedbackReceivedAt' | 'prNumber' | 'reviewConversationUpdatedAt'>): string {
  return [
    task.reviewRound,
    task.latestHeadSha ?? '',
    task.status,
    task.reviewDispatchedAt ?? '',
    task.prFeedbackReceivedAt ?? '',
    task.prNumber ?? '',
    task.reviewConversationUpdatedAt ?? '',
  ].join(':');
}
