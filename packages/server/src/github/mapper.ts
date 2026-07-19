import { BRANCH_PREFIX } from '../shared/index.js';

export type { MappedEvent } from '../platform/types.js';

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
  prNumber?: number,
  knownPrNumbers?: ReadonlySet<number>,
): boolean {
  // bx/<taskId> is baxian's own unique namespace, always ours. A custom branch name can be reused, so
  // it is ours only when the PR number itself is one a task already tracks — never by name match alone
  // (else a stale/foreign PR sharing the branch name would be polled and routed onto the task).
  if (branch.startsWith(BRANCH_PREFIX)) return true;
  return prNumber !== undefined && knownPrNumbers?.has(prNumber) === true;
}
