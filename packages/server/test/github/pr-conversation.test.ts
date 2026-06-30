import { describe, it, expect } from 'vitest';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';
import { MAX_INLINE_CONTENT_BYTES } from '../../src/shared/index.js';
import { buildGithubReviewConversation } from '../../src/github/pr-conversation.js';

type Resp = { stdout?: string; exitCode?: number; stderr?: string };

function runnerOf(responses: Record<string, Resp>): CommandRunner {
  return {
    exec: async (cmd: string): Promise<ExecResult> => {
      for (const [key, r] of Object.entries(responses)) {
        if (cmd.includes(key)) {
          return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 };
        }
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    writeFile: async () => undefined,
    execWithStdin: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  };
}

// Mirrors the `--paginate --jq '.[] | …'` output: one compact projected object per line.
function projected(...items: unknown[]): string {
  return items.map((i) => JSON.stringify(i)).join('\n');
}

const PATHS = {
  reviews: 'pulls/5/reviews',
  reviewComments: 'pulls/5/comments',
  issueComments: 'issues/5/comments',
  commits: 'pulls/5/commits',
};

describe('buildGithubReviewConversation', () => {
  it('merges all four sources sorted by time with correct kinds and verdicts', async () => {
    const runner = runnerOf({
      [PATHS.reviews]: {
        stdout: projected(
          { id: 11, login: 'qa', state: 'CHANGES_REQUESTED', body: 'please fix', commit_id: 'sha-aaaaaaaa', submitted_at: '2026-06-01T10:10:00Z' },
          { id: 12, login: 'qa', state: 'APPROVED', body: 'lgtm', commit_id: 'sha-bbbbbbbb', submitted_at: '2026-06-01T10:20:00Z' },
        ),
      },
      [PATHS.reviewComments]: {
        stdout: projected({ id: 21, login: 'qa', body: 'nit here', path: 'a.ts', line: 12, created_at: '2026-06-01T10:00:00Z' }),
      },
      [PATHS.issueComments]: {
        stdout: projected({ id: 31, login: 'dev', body: 'addressed', created_at: '2026-06-01T10:15:00Z' }),
      },
      [PATHS.commits]: {
        stdout: projected({ sha: 'commitsha1', message: 'fix: thing', date: '2026-06-01T10:05:00Z', login: 'dev' }),
      },
    });

    const { items, error } = await buildGithubReviewConversation(runner, 'owner/repo', 5);
    expect(error).toBeUndefined();
    expect(items.map((i) => i.kind)).toEqual(['review-comment', 'commit', 'review', 'issue-comment', 'review']);
    expect(items.map((i) => i.verdict)).toEqual([undefined, undefined, 'request-changes', undefined, 'approve']);
    expect(items.find((i) => i.kind === 'commit')?.body).toBe('fix: thing');
    expect(items.find((i) => i.kind === 'commit')?.commitSha).toBe('commitsha1');
    expect(items.find((i) => i.kind === 'review-comment')?.path).toBe('a.ts');
    expect(items.find((i) => i.kind === 'review-comment')?.line).toBe(12);
  });

  it('orders same-second comments and commits before the review so they fold into its round', async () => {
    const ts = '2026-06-01T10:00:00Z';
    const runner = runnerOf({
      [PATHS.reviews]: { stdout: projected({ id: 11, login: 'qa', state: 'CHANGES_REQUESTED', body: 'fix', submitted_at: ts }) },
      [PATHS.reviewComments]: { stdout: projected({ id: 21, login: 'qa', body: 'nit', path: 'a.ts', line: 5, created_at: ts }) },
      [PATHS.commits]: { stdout: projected({ sha: 'c1', message: 'wip', date: ts, login: 'dev' }) },
    });
    const { items } = await buildGithubReviewConversation(runner, 'owner/repo', 5);
    expect(items.map((i) => i.kind)).toEqual(['review-comment', 'commit', 'review']);
    expect(items[items.length - 1].kind).toBe('review');
  });

  it('skips empty COMMENTED review shells but keeps commented reviews with a body', async () => {
    const runner = runnerOf({
      [PATHS.reviews]: {
        stdout: projected(
          { id: 41, state: 'COMMENTED', body: '', submitted_at: '2026-06-01T10:00:00Z' },
          { id: 42, state: 'COMMENTED', body: '  ', submitted_at: '2026-06-01T10:01:00Z' },
          { id: 43, state: 'DISMISSED', body: 'x', submitted_at: '2026-06-01T10:02:00Z' },
          { id: 44, state: 'COMMENTED', body: 'real comment', submitted_at: '2026-06-01T10:03:00Z' },
        ),
      },
    });
    const { items } = await buildGithubReviewConversation(runner, 'owner/repo', 5);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: '44', verdict: 'comment', body: 'real comment' });
  });

  it('marks inline-comment replies and falls back to original_line', async () => {
    const runner = runnerOf({
      [PATHS.reviewComments]: {
        stdout: projected(
          { id: 51, body: 'reply', path: 'b.ts', line: null, original_line: 7, in_reply_to_id: 50, created_at: '2026-06-01T10:00:00Z' },
          { id: 52, body: 'top', path: 'c.ts', line: 3, created_at: '2026-06-01T10:01:00Z' },
        ),
      },
    });
    const { items } = await buildGithubReviewConversation(runner, 'owner/repo', 5);
    expect(items[0]).toMatchObject({ id: '51', line: 7, inReplyTo: true });
    expect(items[1].inReplyTo).toBeUndefined();
    expect(items[1].line).toBe(3);
  });

  it('truncates oversized bodies', async () => {
    const big = 'x'.repeat(MAX_INLINE_CONTENT_BYTES + 500);
    const runner = runnerOf({
      [PATHS.reviews]: { stdout: projected({ id: 61, state: 'APPROVED', body: big, submitted_at: '2026-06-01T10:00:00Z' }) },
    });
    const { items } = await buildGithubReviewConversation(runner, 'owner/repo', 5);
    expect(items[0].bodyTruncated).toBe(true);
    expect(Buffer.byteLength(items[0].body ?? '', 'utf8')).toBeLessThanOrEqual(MAX_INLINE_CONTENT_BYTES);
  });

  it('degrades on a single failing source: records error, returns the rest', async () => {
    const runner = runnerOf({
      [PATHS.reviews]: { exitCode: 1, stderr: 'gh: rate limited' },
      [PATHS.commits]: { stdout: projected({ sha: 'c1', message: 'fix', date: '2026-06-01T10:00:00Z' }) },
    });
    const { items, error } = await buildGithubReviewConversation(runner, 'owner/repo', 5);
    expect(error).toContain('reviews');
    expect(error).toContain('rate limited');
    expect(items.map((i) => i.kind)).toEqual(['commit']);
  });

  it('records a parse error when projected output is malformed', async () => {
    const runner = runnerOf({
      [PATHS.reviews]: { stdout: 'not json' },
      [PATHS.issueComments]: { stdout: projected({ id: 71, body: 'hi', created_at: '2026-06-01T10:00:00Z' }) },
    });
    const { items, error } = await buildGithubReviewConversation(runner, 'owner/repo', 5);
    expect(error).toContain('reviews: failed to parse response');
    expect(items.map((i) => i.kind)).toEqual(['issue-comment']);
  });
});
