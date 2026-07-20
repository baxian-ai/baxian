import type { GithubReviewItem, GithubReviewVerdict, TaskState } from './types.js';

export interface GithubReviewRound {
  items: GithubReviewItem[];
  review?: GithubReviewItem;
}

export const GITHUB_REVIEW_VERDICT_CLASS: Record<GithubReviewVerdict, string> = {
  approve: 'pill pill-live',
  'request-changes': 'pill pill-warn',
  comment: 'pill',
};

export function groupGithubReviewRounds(items: GithubReviewItem[]): GithubReviewRound[] {
  const rounds: GithubReviewRound[] = [];
  let bucket: GithubReviewItem[] = [];
  for (const item of items) {
    if (item.kind === 'review') {
      rounds.push({ items: bucket, review: item });
      bucket = [];
    } else {
      bucket.push(item);
    }
  }
  if (bucket.length > 0) rounds.push({ items: bucket });
  return rounds;
}

export function githubReviewItemKey(item: GithubReviewItem, fallback: string): string {
  return `${item.kind}-${item.id || item.commitSha || item.createdAt || item.body || fallback}`;
}

export function githubReviewItemAnchor(item: GithubReviewItem): string | undefined {
  return item.id ? `gh-${item.kind}-${item.id}` : undefined;
}

export function githubReviewRoundKey(round: GithubReviewRound, fallback: string): string {
  if (round.review) return `round-${githubReviewItemKey(round.review, fallback)}`;
  return `round-in-progress-${round.items[0] ? githubReviewItemKey(round.items[0], fallback) : fallback}`;
}

// 字段必须保持 server/src/github/pr-conversation-cache.ts 服务端 revision 的前缀子集：
// 这里任何触发重拉的变化在服务端缓存必然 miss。prNumber 在列，PR 重绑定即重拉。
export function githubReviewRevision(task: Pick<TaskState, 'reviewRound' | 'latestHeadSha' | 'status' | 'reviewDispatchedAt' | 'prFeedbackReceivedAt' | 'prNumber'>): string {
  return `${task.reviewRound}:${task.latestHeadSha ?? ''}:${task.status}:${task.reviewDispatchedAt ?? ''}:${task.prFeedbackReceivedAt ?? ''}:${task.prNumber ?? ''}`;
}
