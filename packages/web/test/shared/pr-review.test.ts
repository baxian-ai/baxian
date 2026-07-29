import { describe, it, expect } from 'vitest';
import { groupPrReviewRounds, prReviewItemAnchor, prReviewItemKey, prReviewRevision } from '../../src/shared/pr-review.ts';
import type { PrReviewItem, TaskState } from '../../src/shared/index.js';

const item = (over: Partial<PrReviewItem>): PrReviewItem =>
  ({ kind: 'issue-comment', id: 'x', ...over });

describe('groupPrReviewRounds', () => {
  it('closes rounds on token comments when any item carries a round token', () => {
    const rounds = groupPrReviewRounds([
      item({ id: 'c1', body: 'inline note', kind: 'review-comment' }),
      item({ id: 'r-plain', kind: 'review', reviewState: 'COMMENTED', body: 'no token native review' }),
      item({ id: 'r-verdict', kind: 'review', verdict: 'request-changes', roundToken: '123456abcdef' }),
      item({ id: 'c2', body: 'follow-up' }),
      item({ id: 'c2-verdict', verdict: 'approve', roundToken: 'abcdef123456' }),
    ]);
    expect(rounds).toHaveLength(2);
    expect(rounds[0]?.review?.id).toBe('r-verdict');
    expect(rounds[0]?.items.map(i => i.id)).toEqual(['c1', 'r-plain']);
    expect(rounds[1]?.review?.id).toBe('c2-verdict');
  });

  it('keeps the legacy native-review grouping when no token is present', () => {
    const rounds = groupPrReviewRounds([
      item({ id: 'c1' }),
      item({ id: 'r1', kind: 'review', verdict: 'approve' }),
      item({ id: 'c2' }),
    ]);
    expect(rounds).toHaveLength(2);
    expect(rounds[0]?.review?.id).toBe('r1');
    expect(rounds[1]?.review).toBeUndefined();
  });
});

describe('prReviewItemKey', () => {
  it('keeps same-kind same-id items from different sources distinct', () => {
    const a = item({ id: '7', sourceKey: 'issue-comments' });
    const b = item({ id: '7', sourceKey: 'announcements' });
    expect(prReviewItemKey(a, 'f')).not.toBe(prReviewItemKey(b, 'f'));
  });

  it('stays injective when dash placement moves between sourceKey and id', () => {
    const a = item({ id: 'c', sourceKey: 'a-b' });
    const b = item({ id: 'b-c', sourceKey: 'a' });
    expect(prReviewItemKey(a, 'f')).not.toBe(prReviewItemKey(b, 'f'));
  });

  it('leaves legacy items without a sourceKey on the old key shape', () => {
    expect(prReviewItemKey(item({ id: '7' }), 'f')).toBe('issue-comment-7');
  });
});

describe('prReviewItemAnchor', () => {
  it('keeps same-id items from different sources on distinct DOM ids', () => {
    const a = prReviewItemAnchor(item({ id: '7', sourceKey: 'issue-comments' }));
    const b = prReviewItemAnchor(item({ id: '7', sourceKey: 'announcements' }));
    expect(a).toBeDefined();
    expect(a).not.toBe(b);
  });

  it('stays injective across dash placement and keeps the legacy anchor shape without a sourceKey', () => {
    const a = prReviewItemAnchor(item({ id: 'c', sourceKey: 'a-b' }));
    const b = prReviewItemAnchor(item({ id: 'b-c', sourceKey: 'a' }));
    expect(a).not.toBe(b);
    expect(prReviewItemAnchor(item({ id: '7' }))).toBe('pr-issue-comment-7');
  });
});

describe('prReviewRevision', () => {
  const base: Pick<TaskState, 'reviewRound' | 'latestHeadSha' | 'status' | 'reviewDispatchedAt' | 'prFeedbackReceivedAt' | 'reviewConversationUpdatedAt'> = {
    reviewRound: 1,
    latestHeadSha: 'a'.repeat(40),
    status: 'review',
    reviewDispatchedAt: '2026-07-19T01:00:00Z',
    prFeedbackReceivedAt: undefined,
    reviewConversationUpdatedAt: undefined,
  };

  it('changes when the conversation display revision moves and stays stable for legacy tasks', () => {
    const before = prReviewRevision(base);
    expect(prReviewRevision({ ...base })).toBe(before);
    const after = prReviewRevision({ ...base, reviewConversationUpdatedAt: '2026-07-19T02:00:00Z' });
    expect(after).not.toBe(before);
  });

  it('changes on closed-unmerged and reopened transitions so the page refetches its state', () => {
    const open = prReviewRevision(base);
    const closed = prReviewRevision({ ...base, closedUnmergedAnchor: { prNumber: 7, generation: 1 } });
    const reopened = prReviewRevision({ ...base, closedUnmergedAnchor: { prNumber: 7, generation: 1, cleared: true } });
    const closedAgain = prReviewRevision({ ...base, closedUnmergedAnchor: { prNumber: 7, generation: 2 } });
    expect(new Set([open, closed, reopened, closedAgain]).size).toBe(4);
  });
});
