import type { CommandRunner } from '../agent/runner.js';
import { shellQuote } from '../agent/runner.js';
import type { GithubReviewItem, GithubReviewItemKind, GithubReviewVerdict } from '../shared/index.js';
import { MAX_INLINE_CONTENT_BYTES } from '../shared/index.js';

const GH_TIMEOUT_MS = 20_000;

// Project each REST object down to the fields we render so the runner buffers
// only those, not the full review/comment payloads, before bodies get truncated.
// gh applies --jq per page (--slurp is incompatible with --jq), so each filter
// emits one projected object per item → JSONL across all pages.
const REVIEW_JQ = '.[] | {id, login: .user.login, state, body, commit_id, submitted_at}';
const REVIEW_COMMENT_JQ =
  '.[] | {id, login: .user.login, body, path, line, original_line, created_at, in_reply_to_id}';
const ISSUE_COMMENT_JQ = '.[] | {id, login: .user.login, body, created_at}';
// committer date (not author date) places a commit on the timeline, so rebased/
// cherry-picked fixes still sort after the review they address.
const COMMIT_JQ = '.[] | {sha, message: .commit.message, date: .commit.committer.date, login: .author.login}';

interface RawReview {
  id: number;
  login?: string | null;
  state?: string | null;
  body?: string | null;
  commit_id?: string | null;
  submitted_at?: string | null;
}

interface RawReviewComment {
  id: number;
  login?: string | null;
  body?: string | null;
  path?: string | null;
  line?: number | null;
  original_line?: number | null;
  created_at?: string | null;
  in_reply_to_id?: number | null;
}

interface RawIssueComment {
  id: number;
  login?: string | null;
  body?: string | null;
  created_at?: string | null;
}

interface RawCommit {
  sha: string;
  message?: string | null;
  date?: string | null;
  login?: string | null;
}

// gh emits one compact projected object per line (JSONL) across all pages. Real
// newlines inside bodies stay escaped within each JSON string, so a line split is safe.
function parseJsonl<T>(stdout: string): T[] | null {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const out: T[] = [];
  try {
    for (const line of lines) out.push(JSON.parse(line) as T);
  } catch {
    return null;
  }
  return out;
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  let cut = maxBytes;
  while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--;
  return { text: buf.subarray(0, cut).toString('utf8'), truncated: true };
}

function verdictFromState(state: string): GithubReviewVerdict | undefined {
  switch (state.toUpperCase()) {
    case 'APPROVED':
      return 'approve';
    case 'CHANGES_REQUESTED':
      return 'request-changes';
    case 'COMMENTED':
      return 'comment';
    default:
      return undefined;
  }
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0] ?? '';
}

function sizedBody(raw: string | null | undefined): { body?: string; bodyTruncated?: boolean } {
  const { text, truncated } = truncateUtf8(raw ?? '', MAX_INLINE_CONTENT_BYTES);
  return { ...(text ? { body: text } : {}), ...(truncated ? { bodyTruncated: true } : {}) };
}

async function ghJson(runner: CommandRunner, apiPath: string, jq: string): Promise<string> {
  const result = await runner.exec(`gh api ${apiPath} --paginate --jq ${shellQuote(jq)}`, {
    timeout: GH_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(stderr.length > 200 ? `${stderr.slice(0, 200)}…` : stderr || `exit ${result.exitCode}`);
  }
  return result.stdout;
}

function mapReviews(rows: RawReview[]): GithubReviewItem[] {
  const out: GithubReviewItem[] = [];
  for (const r of rows) {
    const verdict = verdictFromState(r.state ?? '');
    if (!verdict) continue;
    if (verdict === 'comment' && !(r.body ?? '').trim()) continue;
    out.push({
      kind: 'review',
      id: String(r.id),
      ...(r.login ? { author: r.login } : {}),
      ...sizedBody(r.body),
      ...(r.submitted_at ? { createdAt: r.submitted_at } : {}),
      verdict,
      ...(r.commit_id ? { commitSha: r.commit_id } : {}),
    });
  }
  return out;
}

function mapReviewComments(rows: RawReviewComment[]): GithubReviewItem[] {
  return rows.map((c) => {
    const line = c.line ?? c.original_line ?? undefined;
    return {
      kind: 'review-comment' as const,
      id: String(c.id),
      ...(c.login ? { author: c.login } : {}),
      ...sizedBody(c.body),
      ...(c.created_at ? { createdAt: c.created_at } : {}),
      ...(c.path ? { path: c.path } : {}),
      ...(typeof line === 'number' ? { line } : {}),
      ...(c.in_reply_to_id != null ? { inReplyTo: true } : {}),
    };
  });
}

function mapIssueComments(rows: RawIssueComment[]): GithubReviewItem[] {
  return rows.map((c) => ({
    kind: 'issue-comment' as const,
    id: String(c.id),
    ...(c.login ? { author: c.login } : {}),
    ...sizedBody(c.body),
    ...(c.created_at ? { createdAt: c.created_at } : {}),
  }));
}

function mapCommits(rows: RawCommit[]): GithubReviewItem[] {
  return rows.map((c) => {
    const message = firstLine(c.message ?? '');
    return {
      kind: 'commit' as const,
      id: c.sha,
      ...(c.login ? { author: c.login } : {}),
      ...(message ? { body: message } : {}),
      ...(c.date ? { createdAt: c.date } : {}),
      commitSha: c.sha,
    };
  });
}

async function fetchSource<T>(
  runner: CommandRunner,
  label: string,
  apiPath: string,
  jq: string,
  map: (rows: T[]) => GithubReviewItem[],
): Promise<{ items: GithubReviewItem[]; error?: string }> {
  try {
    const rows = parseJsonl<T>(await ghJson(runner, apiPath, jq));
    if (!rows) return { items: [], error: `${label}: failed to parse response` };
    return { items: map(rows) };
  } catch (err) {
    return { items: [], error: `${label}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// Same createdAt → comments/commits sort before a review (rank 0 < 1).
const KIND_ORDER: Record<GithubReviewItemKind, number> = {
  'review-comment': 0,
  'issue-comment': 0,
  commit: 0,
  review: 1,
};

export async function buildGithubReviewConversation(
  runner: CommandRunner,
  repo: string,
  prNumber: number,
): Promise<{ items: GithubReviewItem[]; error?: string }> {
  // The four GitHub queries are independent; run them concurrently so the
  // endpoint's latency is the slowest single call, not their sum.
  const sources = await Promise.all([
    fetchSource<RawReview>(runner, 'reviews', `repos/${repo}/pulls/${prNumber}/reviews`, REVIEW_JQ, mapReviews),
    fetchSource<RawReviewComment>(
      runner,
      'review-comments',
      `repos/${repo}/pulls/${prNumber}/comments`,
      REVIEW_COMMENT_JQ,
      mapReviewComments,
    ),
    fetchSource<RawIssueComment>(
      runner,
      'issue-comments',
      `repos/${repo}/issues/${prNumber}/comments`,
      ISSUE_COMMENT_JQ,
      mapIssueComments,
    ),
    // GitHub caps this endpoint at 250 commits; baxian's managed PRs carry a handful
    // per review cycle, so the cap is not reachable for the conversations we render.
    fetchSource<RawCommit>(runner, 'commits', `repos/${repo}/pulls/${prNumber}/commits`, COMMIT_JQ, mapCommits),
  ]);

  const items = sources.flatMap((s) => s.items);
  const error = sources.find((s) => s.error)?.error;

  // GitHub REST timestamps are second-precision: a QA review and the inline
  // comments submitted with it usually share createdAt. Ordering comments/commits
  // before the review keeps groupRounds from spilling them into the next round.
  items.sort((a, b) => {
    const at = a.createdAt;
    const bt = b.createdAt;
    if (at && bt) {
      if (at < bt) return -1;
      if (at > bt) return 1;
      return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    }
    if (at) return -1;
    if (bt) return 1;
    return 0;
  });

  return { items, ...(error ? { error } : {}) };
}
