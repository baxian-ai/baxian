import { describe, it, expect } from 'vitest';
import { isManagedPr, mapGitHubEvent } from '../../src/github/mapper.js';

const REPO = 'user/repo';

describe('mapGitHubEvent', () => {
  it('maps pull_request.opened with bx/ branch to pr.created', () => {
    const payload = {
      action: 'opened',
      repository: { full_name: REPO },
      pull_request: {
        number: 7,
        html_url: 'https://github.com/user/repo/pull/7',
        head: { ref: 'bx/task-123', repo: { full_name: REPO } },
      },
    };
    const result = mapGitHubEvent('pull_request', payload);
    expect(result).toEqual({
      type: 'pr.created',
      repo: REPO,
      data: { prNumber: 7, prUrl: 'https://github.com/user/repo/pull/7', branch: 'bx/task-123' },
    });
  });

  it('maps pull_request.opened with head SHA to pr.created including headSha (seeds task.latestHeadSha)', () => {
    const payload = {
      action: 'opened',
      repository: { full_name: REPO },
      pull_request: {
        number: 7,
        html_url: 'https://github.com/user/repo/pull/7',
        head: { ref: 'bx/task-123', sha: 'abc1234567890123456789012345678901234567', repo: { full_name: REPO } },
      },
    };
    const result = mapGitHubEvent('pull_request', payload);
    expect(result?.data.headSha).toBe('abc1234567890123456789012345678901234567');
  });

  it('maps pull_request.edited with bx/ branch to pr.updated with kind=pr-edit', () => {
    const payload = {
      action: 'edited',
      repository: { full_name: REPO },
      pull_request: {
        number: 7,
        html_url: 'https://github.com/user/repo/pull/7',
        head: { ref: 'bx/task-123', repo: { full_name: REPO } },
      },
    };
    const result = mapGitHubEvent('pull_request', payload);
    expect(result).toEqual({
      type: 'pr.updated',
      repo: REPO,
      data: {
        prNumber: 7,
        prUrl: 'https://github.com/user/repo/pull/7',
        branch: 'bx/task-123',
        kind: 'pr-edit',
      },
    });
  });

  it('maps pull_request.synchronize with bx/ branch to pr.updated with kind=push', () => {
    const payload = {
      action: 'synchronize',
      repository: { full_name: REPO },
      pull_request: {
        number: 7,
        html_url: 'https://github.com/user/repo/pull/7',
        head: {
          ref: 'bx/task-123',
          sha: 'cccccccccccccccccccccccccccccccccccccccc',
          repo: { full_name: REPO },
        },
      },
    };
    const result = mapGitHubEvent('pull_request', payload);
    expect(result).toEqual({
      type: 'pr.updated',
      repo: REPO,
      data: {
        prNumber: 7,
        prUrl: 'https://github.com/user/repo/pull/7',
        branch: 'bx/task-123',
        headSha: 'cccccccccccccccccccccccccccccccccccccccc',
        kind: 'push',
      },
    });
  });

  it('maps pull_request.closed merged with bx/ to pr.merged with prUrl', () => {
    const payload = {
      action: 'closed',
      repository: { full_name: REPO },
      pull_request: {
        number: 7,
        html_url: 'https://github.com/user/repo/pull/7',
        head: { ref: 'bx/task-123', repo: { full_name: REPO } },
        merged: true,
      },
    };
    const result = mapGitHubEvent('pull_request', payload);
    expect(result).toEqual({
      type: 'pr.merged',
      repo: REPO,
      data: {
        prNumber: 7,
        prUrl: 'https://github.com/user/repo/pull/7',
        branch: 'bx/task-123',
      },
    });
  });

  it('maps pull_request_review_comment.created to pr.updated with kind=review-comment', () => {
    const payload = {
      action: 'created',
      repository: { full_name: REPO },
      pull_request: {
        number: 7,
        html_url: 'https://github.com/user/repo/pull/7',
        head: { ref: 'bx/task-123', repo: { full_name: REPO } },
      },
      comment: { id: 555, body: 'inline review note' },
    };
    const result = mapGitHubEvent('pull_request_review_comment', payload);
    expect(result).toEqual({
      type: 'pr.updated',
      repo: REPO,
      data: {
        prNumber: 7,
        prUrl: 'https://github.com/user/repo/pull/7',
        branch: 'bx/task-123',
        commentId: 555,
        kind: 'review-comment',
      },
    });
  });

  it('marks pull_request_review_comment replies without treating every reply as a dev acknowledgement', () => {
    const payload = {
      action: 'created',
      repository: { full_name: REPO },
      pull_request: {
        number: 7,
        html_url: 'https://github.com/user/repo/pull/7',
        head: { ref: 'bx/task-123', repo: { full_name: REPO } },
      },
      comment: { id: 556, body: 'Fixed in latest push', in_reply_to_id: 555 },
    };
    const result = mapGitHubEvent('pull_request_review_comment', payload);
    expect(result).toEqual({
      type: 'pr.updated',
      repo: REPO,
      data: {
        prNumber: 7,
        prUrl: 'https://github.com/user/repo/pull/7',
        branch: 'bx/task-123',
        commentId: 556,
        kind: 'review-comment',
        reviewCommentReply: true,
      },
    });
  });

  it('ignores any reply-marker text in a review-comment body (post-approve-reply marker is retired)', () => {
    const payload = {
      action: 'created',
      repository: { full_name: REPO },
      pull_request: {
        number: 7,
        html_url: 'https://github.com/user/repo/pull/7',
        head: { ref: 'bx/task-123', repo: { full_name: REPO } },
      },
      comment: {
        id: 557,
        body: 'Fixed in latest push\n<!-- baxian:dev-1:post-approve-reply:post-token-42 -->',
        in_reply_to_id: 555,
      },
    };
    const result = mapGitHubEvent('pull_request_review_comment', payload);
    expect(result?.data.kind).toBe('review-comment');
    expect(result?.data.reviewCommentReply).toBe(true);
    expect(result?.data).not.toHaveProperty('postApproveReplyAgentId');
    expect(result?.data).not.toHaveProperty('postApproveReplyToken');
  });

  it('maps pull_request_review.submitted (approved) with bx/ to review.submitted with prUrl', () => {
    const payload = {
      action: 'submitted',
      repository: { full_name: REPO },
      pull_request: {
        number: 7,
        html_url: 'https://github.com/user/repo/pull/7',
        head: {
          ref: 'bx/task-123',
          sha: 'dddddddddddddddddddddddddddddddddddddddd',
          repo: { full_name: REPO },
        },
      },
      review: {
        state: 'approved',
        commit_id: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        submitted_at: '2026-05-30T04:06:01Z',
        body: ':+1:\n\n<!-- baxian:pr-approved:passtok123456 -->',
      },
    };
    const result = mapGitHubEvent('pull_request_review', payload);
    expect(result).toEqual({
      type: 'review.submitted',
      repo: REPO,
      data: {
        action: 'APPROVE',
        prNumber: 7,
        prUrl: 'https://github.com/user/repo/pull/7',
        branch: 'bx/task-123',
        headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        currentHeadSha: 'dddddddddddddddddddddddddddddddddddddddd',
        submittedAt: '2026-05-30T04:06:01Z',
        reviewPassToken: 'passtok123456',
      },
    });
  });

  it('maps pull_request_review.submitted (changes_requested) with bx/ to review.submitted with prUrl', () => {
    const payload = {
      action: 'submitted',
      repository: { full_name: REPO },
      pull_request: {
        number: 7,
        html_url: 'https://github.com/user/repo/pull/7',
        head: { ref: 'bx/task-123', repo: { full_name: REPO } },
      },
      review: { state: 'changes_requested' },
    };
    const result = mapGitHubEvent('pull_request_review', payload);
    expect(result).toEqual({
      type: 'review.submitted',
      repo: REPO,
      data: {
        action: 'REQUEST_CHANGES',
        prNumber: 7,
        prUrl: 'https://github.com/user/repo/pull/7',
        branch: 'bx/task-123',
      },
    });
  });

  it('maps issue_comment.created on a PR (issue.pull_request present) to pr.updated with prUrl from html_url', () => {
    const payload = {
      action: 'created',
      repository: { full_name: REPO },
      issue: {
        number: 42,
        html_url: 'https://github.com/user/repo/pull/42',
        pull_request: {
          html_url: 'https://github.com/user/repo/pull/42',
          url: 'https://api.github.com/repos/user/repo/pulls/42',
        },
      },
      comment: { id: 999, body: 'LGTM!' },
    };
    const result = mapGitHubEvent('issue_comment', payload);
    expect(result).toEqual({
      type: 'pr.updated',
      repo: REPO,
      data: {
        prNumber: 42,
        prUrl: 'https://github.com/user/repo/pull/42',
        branch: undefined,
        kind: 'comment',
      },
    });
  });

  it('treats issue_comment containing a (retired) completion marker as a plain comment', () => {
    const payload = {
      action: 'created',
      repository: { full_name: REPO },
      issue: {
        number: 42,
        html_url: 'https://github.com/user/repo/pull/42',
        pull_request: {
          html_url: 'https://github.com/user/repo/pull/42',
          url: 'https://api.github.com/repos/user/repo/pulls/42',
        },
      },
      comment: {
        id: 1001,
        body: 'All PR feedback has been handled.\n<!-- baxian:dev-1:post-approved:post-token-42 -->',
      },
    };
    const result = mapGitHubEvent('issue_comment', payload);
    expect(result?.data.kind).toBe('comment');
    expect(result?.data).not.toHaveProperty('signalToken');
    expect(result?.data).not.toHaveProperty('verdictAgentId');
  });

  it('falls back to issue.html_url when issue.pull_request lacks html_url', () => {
    const payload = {
      action: 'created',
      repository: { full_name: REPO },
      issue: {
        number: 42,
        html_url: 'https://github.com/user/repo/pull/42',
        pull_request: {
          url: 'https://api.github.com/repos/user/repo/pulls/42',
        },
      },
      comment: { id: 999, body: 'LGTM!' },
    };
    const result = mapGitHubEvent('issue_comment', payload);
    expect(result?.data.prUrl).toBe('https://github.com/user/repo/pull/42');
  });

  it('maps a bx/ pull_request.opened to pr.created even when the body lacks the marker', () => {
    const payload = {
      action: 'opened',
      repository: { full_name: REPO },
      pull_request: {
        number: 7,
        html_url: 'https://github.com/user/repo/pull/7',
        head: { ref: 'bx/task-123', repo: { full_name: REPO } },
        body: '-',
      },
    };
    const result = mapGitHubEvent('pull_request', payload);
    expect(result?.type).toBe('pr.created');
    expect(result?.data.branch).toBe('bx/task-123');
  });

  it.each<[string, string, unknown]>([
    [
      'pull_request.opened from a fork whose head branch reused a bx/ name',
      'pull_request',
      {
        action: 'opened',
        repository: { full_name: REPO },
        pull_request: {
          number: 7,
          html_url: 'https://github.com/user/repo/pull/7',
          head: { ref: 'bx/task-123', repo: { full_name: 'attacker/repo' } },
        },
      },
    ],
    [
      'pull_request.opened without bx/ prefix',
      'pull_request',
      {
        action: 'opened',
        repository: { full_name: REPO },
        pull_request: {
          number: 7,
          html_url: 'https://github.com/user/repo/pull/7',
          head: { ref: 'feature/other' },
        },
      },
    ],
    [
      'pull_request.edited without bx/ prefix',
      'pull_request',
      {
        action: 'edited',
        repository: { full_name: REPO },
        pull_request: {
          number: 7,
          html_url: 'https://github.com/user/repo/pull/7',
          head: { ref: 'main' },
        },
      },
    ],
    [
      'pull_request_review without bx/ prefix',
      'pull_request_review',
      {
        action: 'submitted',
        repository: { full_name: REPO },
        pull_request: { number: 7, head: { ref: 'main' } },
        review: { state: 'approved' },
      },
    ],
    [
      'pull_request_review with unrecognized state',
      'pull_request_review',
      {
        action: 'submitted',
        repository: { full_name: REPO },
        pull_request: { number: 7, head: { ref: 'bx/task-123' } },
        review: { state: 'commented' },
      },
    ],
    [
      'push event (synchronize covers it; avoid double emit)',
      'push',
      { repository: { full_name: REPO }, ref: 'refs/heads/bx/task-123' },
    ],
    [
      'push to non-bx/ branch',
      'push',
      { repository: { full_name: REPO }, ref: 'refs/heads/main' },
    ],
    [
      'issue_comment.created on a real Issue (no issue.pull_request)',
      'issue_comment',
      {
        action: 'created',
        repository: { full_name: REPO },
        issue: { number: 42, html_url: 'https://github.com/user/repo/issues/42' },
        comment: { id: 999, body: 'real issue comment' },
      },
    ],
    [
      'issue_comment.edited (only created is mapped)',
      'issue_comment',
      {
        action: 'edited',
        repository: { full_name: REPO },
        issue: { number: 42, pull_request: { html_url: 'https://github.com/user/repo/pull/42' } },
        comment: { id: 999, body: 'LGTM!' },
      },
    ],
    [
      'issue_comment.deleted (only created is mapped)',
      'issue_comment',
      {
        action: 'deleted',
        repository: { full_name: REPO },
        issue: { number: 42, pull_request: { html_url: 'https://github.com/user/repo/pull/42' } },
        comment: { id: 999, body: 'LGTM!' },
      },
    ],
    [
      'unrecognized event type',
      'deployment',
      { repository: { full_name: REPO } },
    ],
  ])('returns null for %s', (_label, eventType, payload) => {
    expect(mapGitHubEvent(eventType, payload)).toBeNull();
  });
});

describe('isManagedPr', () => {
  it('bx/ prefix → true (unique namespace, PR number irrelevant)', () => {
    expect(isManagedPr('bx/task-001')).toBe(true);
  });

  it('custom branch whose PR number is tracked by a task → true', () => {
    expect(isManagedPr('feat/my-feature', 20, new Set([20]))).toBe(true);
  });

  it('custom branch whose PR number is NOT tracked → false (reused branch name)', () => {
    expect(isManagedPr('feat/my-feature', 20, new Set([99]))).toBe(false);
  });

  it('custom branch with no PR number or no tracked set → false', () => {
    expect(isManagedPr('feat/my-feature')).toBe(false);
    expect(isManagedPr('feat/my-feature', 20)).toBe(false);
  });
});
