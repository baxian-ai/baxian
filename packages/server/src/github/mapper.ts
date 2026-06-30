import type { EventType } from '../shared/index.js';
import { BRANCH_PREFIX } from '../shared/index.js';
import { BAXIAN_PR_CLAIM } from '../agent/prompt.js';

export interface MappedEvent {
  type: EventType;
  repo: string;
  data: Record<string, unknown>;
}

export interface GitHubWebhookPayload {
  action?: string;
  repository?: { full_name?: string };
  issue?: {
    number?: number;
    html_url?: string;
    pull_request?: {
      html_url?: string;
      url?: string;
    };
  };
  pull_request?: {
    head?: { ref?: string; sha?: string };
    body?: string | null;
    number?: number;
    html_url?: string;
    merged?: boolean;
  };
  comment?: { id?: number; body?: string; in_reply_to_id?: number | null };
  review?: { state?: string; body?: string | null; commit_id?: string | null; submitted_at?: string | null };
  ref?: string;
}

export function reviewVerdict(args: {
  state: string;
}): { action: 'APPROVE' | 'REQUEST_CHANGES' } | undefined {
  const upper = args.state.toUpperCase();
  if (upper === 'APPROVED') return { action: 'APPROVE' };
  if (upper === 'CHANGES_REQUESTED') return { action: 'REQUEST_CHANGES' };
  return undefined;
}

const REVIEW_PASS_RE = /<!--\s*baxian:(?:pr-approved|pr-changes-requested):([A-Za-z0-9_-]{6,64})\s*-->/;
export function extractReviewPassToken(body: string | null | undefined): string | undefined {
  if (typeof body !== 'string') return undefined;
  const m = REVIEW_PASS_RE.exec(body);
  return m ? m[1] : undefined;
}

export function isManagedPr(
  branch: string,
  body: string | null | undefined,
  knownBranches?: ReadonlySet<string>,
): boolean {
  if (body === null) return false;
  if (typeof body === 'string' && !body.includes(BAXIAN_PR_CLAIM)) return false;
  if (branch.startsWith(BRANCH_PREFIX)) return true;
  if (knownBranches?.has(branch) === true) return true;
  return false;
}

export function mapGitHubEvent(
  eventType: string,
  payload: GitHubWebhookPayload,
): MappedEvent | null {
  const repo: string = payload.repository?.full_name ?? '';
  const action: string = payload.action ?? '';

  switch (eventType) {
    case 'pull_request': {
      const branch: string = payload.pull_request?.head?.ref ?? '';
      const body: string | null | undefined = payload.pull_request?.body;
      if (!isManagedPr(branch, body)) return null;

      if (action === 'opened') {
        return {
          type: 'pr.created',
          repo,
          data: {
            prNumber: payload.pull_request?.number,
            prUrl: payload.pull_request?.html_url,
            branch,
            ...(payload.pull_request?.head?.sha ? { headSha: payload.pull_request.head.sha } : {}),
          },
        };
      }

      if (action === 'synchronize') {
        return {
          type: 'pr.updated',
          repo,
          data: {
            prNumber: payload.pull_request?.number,
            prUrl: payload.pull_request?.html_url,
            branch,
            ...(payload.pull_request?.head?.sha ? { headSha: payload.pull_request.head.sha } : {}),
            kind: 'push',
          },
        };
      }

      if (action === 'edited') {
        return {
          type: 'pr.updated',
          repo,
          data: {
            prNumber: payload.pull_request?.number,
            prUrl: payload.pull_request?.html_url,
            branch,
            kind: 'pr-edit',
          },
        };
      }

      if (action === 'closed' && payload.pull_request?.merged === true) {
        return {
          type: 'pr.merged',
          repo,
          data: {
            prNumber: payload.pull_request?.number,
            prUrl: payload.pull_request?.html_url,
            branch,
          },
        };
      }

      return null;
    }

    case 'pull_request_review_comment': {
      if (action !== 'created') return null;
      const branch: string = payload.pull_request?.head?.ref ?? '';
      const body: string | null | undefined = payload.pull_request?.body;
      if (!isManagedPr(branch, body)) return null;
      return {
        type: 'pr.updated',
        repo,
        data: {
          prNumber: payload.pull_request?.number,
          prUrl: payload.pull_request?.html_url,
          branch,
          commentId: payload.comment?.id,
          kind: 'review-comment',
          ...(payload.pull_request?.head?.sha ? { headSha: payload.pull_request.head.sha } : {}),
          ...(payload.comment?.in_reply_to_id !== undefined && payload.comment.in_reply_to_id !== null
            ? { reviewCommentReply: true }
            : {}),
        },
      };
    }

    case 'pull_request_review': {
      if (action !== 'submitted') return null;
      const branch: string = payload.pull_request?.head?.ref ?? '';
      const body: string | null | undefined = payload.pull_request?.body;
      if (!isManagedPr(branch, body)) return null;

      const state: string = payload.review?.state ?? '';
      const verdict = reviewVerdict({ state });
      if (!verdict) return null;
      const reviewedHeadSha = payload.review?.commit_id ?? undefined;
      const currentHeadSha = payload.pull_request?.head?.sha;
      const submittedAt = payload.review?.submitted_at ?? undefined;
      const reviewPassToken = extractReviewPassToken(payload.review?.body);
      return {
        type: 'review.submitted',
        repo,
        data: {
          action: verdict.action,
          prNumber: payload.pull_request?.number,
          prUrl: payload.pull_request?.html_url,
          branch,
          ...(reviewedHeadSha ? { headSha: reviewedHeadSha } : {}),
          ...(currentHeadSha ? { currentHeadSha } : {}),
          ...(submittedAt ? { submittedAt } : {}),
          ...(reviewPassToken ? { reviewPassToken } : {}),
        },
      };
    }

    case 'push': {
      return null;
    }

    case 'issue_comment': {
      if (action !== 'created') return null;
      const issuePr = payload.issue?.pull_request;
      if (!issuePr) return null;

      const prNumber = payload.issue?.number;
      if (!prNumber) return null;

      const prUrl = issuePr.html_url ?? payload.issue?.html_url;

      return {
        type: 'pr.updated',
        repo,
        data: { prNumber, prUrl, branch: undefined, kind: 'comment' },
      };
    }

    default:
      return null;
  }
}
