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

export function githubReviewRoundKey(round: GithubReviewRound, fallback: string): string {
  if (round.review) return `round-${githubReviewItemKey(round.review, fallback)}`;
  return `round-in-progress-${round.items[0] ? githubReviewItemKey(round.items[0], fallback) : fallback}`;
}

export function githubReviewRevision(task: Pick<TaskState, 'reviewRound' | 'latestHeadSha' | 'status' | 'reviewDispatchedAt' | 'prFeedbackReceivedAt'>): string {
  return `${task.reviewRound}:${task.latestHeadSha ?? ''}:${task.status}:${task.reviewDispatchedAt ?? ''}:${task.prFeedbackReceivedAt ?? ''}`;
}
