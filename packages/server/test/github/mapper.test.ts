import { describe, it, expect } from 'vitest';
import { mapGitHubEvent } from '../../src/github/mapper.js';

const REPO = 'user/repo';

describe('mapGitHubEvent', () => {
  it('maps pull_request.opened with bx/ branch to pr.created', () => {
    const payload = {
      action: 'opened',
      repository: { full_name: REPO },
      pull_request: {
        number: 7,
        html_url: 'https://github.com/user/repo/pull/7',
        head: { ref: 'bx/task-123' },
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
        head: { ref: 'bx/task-123', sha: 'abc1234567890123456789012345678901234567' },
      },
    };
    const result = mapGitHubEvent('pull_request', payload);
    expect(result?.data.headSha).toBe('abc1234567890123456789012345678901234567');
  });

  it('returns null for pull_request.opened with bx/ branch but null body (no marker)', () => {
    const payload = {
      action: 'opened',
      repository: { full_name: REPO },
      pull_request: {
        number: 7,
        html_url: 'https://github.com/user/repo/pull/7',
        head: { ref: 'bx/task-123' },
        body: null,
      },
    };
    expect(mapGitHubEvent('pull_request', payload)).toBeNull();
  });

  it('returns null for pull_request.opened with bx/ branch but body lacking marker', () => {
    const payload = {
      action: 'opened',
      repository: { full_name: REPO },
      pull_request: {
        number: 7,
        html_url: 'https://github.com/user/repo/pull/7',
        head: { ref: 'bx/task-123' },
        body: 'Just a regular PR description with no marker.',
      },
    };
    expect(mapGitHubEvent('pull_request', payload)).toBeNull();
  });

  it('accepts pull_request.opened with bx/ branch and body containing the marker', () => {
    const payload = {
      action: 'opened',
      repository: { full_name: REPO },
      pull_request: {
        number: 7,
        html_url: 'https://github.com/user/repo/pull/7',
        head: { ref: 'bx/task-123' },
        body: '<!-- baxian:managed -->\n\nAdds login fix',
      },
    };
    expect(mapGitHubEvent('pull_request', payload)).not.toBeNull();
  });

  it('returns null for pull_request.opened without bx/ prefix', () => {
    const payload = {
      action: 'opened',
      repository: { full_name: REPO },
      pull_request: {
        number: 7,
        html_url: 'https://github.com/user/repo/pull/7',
        head: { ref: 'feature/other' },
      },
    };
    expect(mapGitHubEvent('pull_request', payload)).toBeNull();
  });

  it('maps pull_request.edited with bx/ branch to pr.updated with kind=pr-edit', () => {
    const payload = {
      action: 'edited',
      repository: { full_name: REPO },
      pull_request: {
        number: 7,
        html_url: 'https://github.com/user/repo/pull/7',
        head: { ref: 'bx/task-123' },
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

  it('returns null for pull_request.edited without bx/ prefix', () => {
    const payload = {
      action: 'edited',
      repository: { full_name: REPO },
      pull_request: {
        number: 7,
        html_url: 'https://github.com/user/repo/pull/7',
        head: { ref: 'main' },
      },
    };
    expect(mapGitHubEvent('pull_request', payload)).toBeNull();
  });

  it('maps pull_request.closed merged with bx/ to pr.merged with prUrl', () => {
    const payload = {
      action: 'closed',
      repository: { full_name: REPO },
      pull_request: {
        number: 7,
        html_url: 'https://github.com/user/repo/pull/7',
        head: { ref: 'bx/task-123' },
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
        head: { ref: 'bx/task-123' },
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
        head: { ref: 'bx/task-123' },
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
    // Idempotency during post-approve is now enforced by the pr-feedback
    // skill scanning each thread for its own reply, not by a token-bearing
    // marker. The mapper must not surface postApproveReplyAgentId/Token
    // even if a legacy comment still contains the marker text.
    const payload = {
      action: 'created',
      repository: { full_name: REPO },
      pull_request: {
        number: 7,
        html_url: 'https://github.com/user/repo/pull/7',
        head: { ref: 'bx/task-123' },
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
        head: { ref: 'bx/task-123' },
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

  it('returns null for pull_request_review without bx/ prefix', () => {
    const payload = {
      action: 'submitted',
      repository: { full_name: REPO },
      pull_request: {
        number: 7,
        head: { ref: 'main' },
      },
      review: { state: 'approved' },
    };
    expect(mapGitHubEvent('pull_request_review', payload)).toBeNull();
  });

  it('returns null for pull_request_review with unrecognized state', () => {
    const payload = {
      action: 'submitted',
      repository: { full_name: REPO },
      pull_request: {
        number: 7,
        head: { ref: 'bx/task-123' },
      },
      review: { state: 'commented' },
    };
    expect(mapGitHubEvent('pull_request_review', payload)).toBeNull();
  });


  it('returns null for push event (synchronize covers it; avoid double emit)', () => {
    const payload = {
      repository: { full_name: REPO },
      ref: 'refs/heads/bx/task-123',
    };
    expect(mapGitHubEvent('push', payload)).toBeNull();
  });

  it('returns null for push to non-bx/ branch', () => {
    const payload = {
      repository: { full_name: REPO },
      ref: 'refs/heads/main',
    };
    expect(mapGitHubEvent('push', payload)).toBeNull();
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
    // Completion route retired (pane signal now); a comment containing the marker is plain feedback.
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

  it('returns null for issue_comment.created on a real Issue (no issue.pull_request)', () => {
    const payload = {
      action: 'created',
      repository: { full_name: REPO },
      issue: { number: 42, html_url: 'https://github.com/user/repo/issues/42' },
      comment: { id: 999, body: 'real issue comment' },
    };
    expect(mapGitHubEvent('issue_comment', payload)).toBeNull();
  });

  it('returns null for issue_comment.edited (only created is mapped)', () => {
    const payload = {
      action: 'edited',
      repository: { full_name: REPO },
      issue: {
        number: 42,
        pull_request: { html_url: 'https://github.com/user/repo/pull/42' },
      },
      comment: { id: 999, body: 'LGTM!' },
    };
    expect(mapGitHubEvent('issue_comment', payload)).toBeNull();
  });

  it('returns null for issue_comment.deleted (only created is mapped)', () => {
    const payload = {
      action: 'deleted',
      repository: { full_name: REPO },
      issue: {
        number: 42,
        pull_request: { html_url: 'https://github.com/user/repo/pull/42' },
      },
      comment: { id: 999, body: 'LGTM!' },
    };
    expect(mapGitHubEvent('issue_comment', payload)).toBeNull();
  });

  it('returns null for unrecognized event type', () => {
    const payload = {
      repository: { full_name: REPO },
    };
    expect(mapGitHubEvent('deployment', payload)).toBeNull();
  });
});
