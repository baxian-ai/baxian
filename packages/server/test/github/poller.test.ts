import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitHubPoller, pollerStatePathFor, type PollerOptions } from '../../src/github/poller.js';
import type { MappedEvent } from '../../src/github/mapper.js';
import type { CommandRunner } from '../../src/agent/runner.js';
import type { BaxianConfig, ProjectConfig } from '../../src/shared/index.js';

function makeRunner(responses: Record<string, string>) {
  return {
    exec: vi.fn(async (cmd: string) => {
      const slurped = cmd.includes('--slurp');
      for (const [pattern, output] of Object.entries(responses)) {
        if (cmd.includes(pattern)) {
          if (!slurped) {
            return { stdout: output, stderr: '', exitCode: 0 };
          }
          const wrapped = output === '[]' ? '[[]]' : `[${output}]`;
          return { stdout: wrapped, stderr: '', exitCode: 0 };
        }
      }
      return {
        stdout: slurped ? '[[]]' : '[]',
        stderr: '',
        exitCode: 0,
      };
    }),
  };
}

const REPO = 'user/repo';

function makeOptions(runner: CommandRunner, onEvent: (e: MappedEvent) => void): PollerOptions {
  return { runner, onEvent: (_projectId, e) => onEvent(e) };
}

function makePoller(runner: CommandRunner, onEvent: (e: MappedEvent) => void) {
  const poller = new GitHubPoller(makeOptions(runner, onEvent));
  const entry = poller.add({ projectId: 'test-proj', repo: REPO });
  return { poller, entry };
}

describe('GitHubPoller', () => {
  describe('gh exec failures: silent error swallow', () => {
    function makeFailingRunner(stderr: string) {
      return {
        exec: vi.fn(async () => ({ stdout: '', stderr, exitCode: 1 })),
      };
    }

    it('pollPullRequests: throws with stderr context when gh exits non-zero (so poll() counts it as a failure)', async () => {
      const runner = makeFailingRunner('gh: not authenticated');
      const { poller, entry } = makePoller(runner, () => undefined);
      await expect(poller.pollPullRequests(entry)).rejects.toThrow(
        /pollPullRequests failed \(exit=1\).*gh: not authenticated/,
      );
    });

    it('pollReviewsForPr: throws with stderr context when gh exits non-zero', async () => {
      const runner = makeFailingRunner('rate limited');
      const { poller, entry } = makePoller(runner, () => undefined);
      await expect(
        poller.pollReviewsForPr(entry, 7, 'bx/task-1', 'https://example.com/pr/7'),
      ).rejects.toThrow(/pollReviewsForPr #7 failed.*rate limited/);
    });

    it('pollReviewCommentsForPr: throws with stderr context when gh exits non-zero', async () => {
      const runner = makeFailingRunner('connection reset');
      const { poller, entry } = makePoller(runner, () => undefined);
      await expect(
        poller.pollReviewCommentsForPr(entry, 7, 'bx/task-1', 'https://example.com/pr/7'),
      ).rejects.toThrow(/pollReviewCommentsForPr #7 failed.*connection reset/);
    });

    it('pollIssueCommentsForPr: throws with stderr context when gh exits non-zero', async () => {
      const runner = makeFailingRunner('boom');
      const { poller, entry } = makePoller(runner, () => undefined);
      await expect(
        poller.pollIssueCommentsForPr(entry, 7, 'bx/task-1', 'https://example.com/pr/7'),
      ).rejects.toThrow(/pollIssueCommentsForPr #7 failed.*boom/);
    });

    it('pollPullRequests: throws when stdout is not valid JSON', async () => {
      const runner = {
        exec: vi.fn(async () => ({ stdout: 'not json', stderr: '', exitCode: 0 })),
      };
      const { poller, entry } = makePoller(runner, () => undefined);
      await expect(poller.pollPullRequests(entry)).rejects.toThrow(
        /pollPullRequests JSON parse failed/,
      );
    });

    it('pollPullRequests: throws when response is not an array', async () => {
      const runner = {
        exec: vi.fn(async () => ({ stdout: '{"message":"oops"}', stderr: '', exitCode: 0 })),
      };
      const { poller, entry } = makePoller(runner, () => undefined);
      await expect(poller.pollPullRequests(entry)).rejects.toThrow(
        /expected array, got object/,
      );
    });

    it('truncates over-long stderr in the thrown error to keep logs readable', async () => {
      const longStderr = 'x'.repeat(2000);
      const runner = makeFailingRunner(longStderr);
      const { poller, entry } = makePoller(runner, () => undefined);
      const err = await poller.pollPullRequests(entry).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toContain('(truncated)');
      expect(msg.length).toBeLessThan(longStderr.length);
    });

  });

  it('polls PR reviews and emits review.submitted for approved reviews with prUrl', async () => {
    const prData = JSON.stringify([
      {
        number: 7,
        head: { ref: 'bx/task-123', sha: '23dbc7f76b130f3fa35b4777eb938fbf23dbc7f7' },
        html_url: 'https://github.com/user/repo/pull/7',
        state: 'open',
        merged_at: null,
        updated_at: '2026-04-30T00:00:00Z',
      },
    ]);
    const reviewData = JSON.stringify([
      { id: 101, state: 'APPROVED' },
    ]);
    const runner = makeRunner({
      '/pulls?': prData,
      '/reviews': reviewData,
    });
    const emitted: MappedEvent[] = [];
    const { poller, entry } = makePoller(runner, (e) => emitted.push(e));

    await poller.pollPullRequests(entry);

    const reviewEvents = emitted.filter((e) => e.type === 'review.submitted');
    expect(reviewEvents).toHaveLength(1);
    expect(reviewEvents[0].data.action).toBe('APPROVE');
    expect(reviewEvents[0].data.prNumber).toBe(7);
    expect(reviewEvents[0].data.prUrl).toBe('https://github.com/user/repo/pull/7');
    expect(reviewEvents[0].data.branch).toBe('bx/task-123');
  });

  it('skips already-seen reviews', async () => {
    const prData = JSON.stringify([
      {
        number: 7,
        head: { ref: 'bx/task-123', sha: '23dbc7f76b130f3fa35b4777eb938fbf23dbc7f7' },
        html_url: 'https://github.com/user/repo/pull/7',
        state: 'open',
        merged_at: null,
        updated_at: '2026-04-30T00:00:00Z',
      },
    ]);
    const reviewData = JSON.stringify([
      { id: 101, state: 'APPROVED' },
    ]);
    const runner = makeRunner({
      '/pulls?': prData,
      '/reviews': reviewData,
    });
    const emitted: MappedEvent[] = [];
    const { poller, entry } = makePoller(runner, (e) => emitted.push(e));

    await poller.pollPullRequests(entry);
    await poller.pollPullRequests(entry);

    const reviewEvents = emitted.filter((e) => e.type === 'review.submitted');
    expect(reviewEvents).toHaveLength(1);
  });

  it('ignores PRs without bx/ prefix', async () => {
    const prData = JSON.stringify([
      {
        number: 3,
        head: { ref: 'main', sha: '2757cb736f9f03bba7d74bf3ef1f833b2757cb73' },
        html_url: 'https://github.com/user/repo/pull/3',
        state: 'open',
        merged_at: null,
        updated_at: '2026-04-30T00:00:00Z',
      },
    ]);
    const runner = makeRunner({ '/pulls?': prData });
    const emitted: MappedEvent[] = [];
    const { poller, entry } = makePoller(runner, (e) => emitted.push(e));

    await poller.pollPullRequests(entry);

    expect(emitted).toHaveLength(0);
  });

  it('ignores CHANGES_REQUESTED reviews as REQUEST_CHANGES', async () => {
    const prData = JSON.stringify([
      {
        number: 7,
        head: { ref: 'bx/task-123', sha: '23dbc7f76b130f3fa35b4777eb938fbf23dbc7f7' },
        html_url: 'https://github.com/user/repo/pull/7',
        state: 'open',
        merged_at: null,
        updated_at: '2026-04-30T00:00:00Z',
      },
    ]);
    const reviewData = JSON.stringify([
      {
        id: 202,
        state: 'CHANGES_REQUESTED',
        commit_id: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        submitted_at: '2026-05-30T04:02:50Z',
        body: 'CI fails at foo.test.ts:10\n\n<!-- baxian:pr-changes-requested:passtok123456 -->',
      },
    ]);
    const runner = makeRunner({
      '/pulls?': prData,
      '/reviews': reviewData,
    });
    const emitted: MappedEvent[] = [];
    const { poller, entry } = makePoller(runner, (e) => emitted.push(e));

    await poller.pollPullRequests(entry);

    const reviewEvents = emitted.filter((e) => e.type === 'review.submitted');
    expect(reviewEvents).toHaveLength(1);
    expect(reviewEvents[0].data.action).toBe('REQUEST_CHANGES');
    expect(reviewEvents[0].data.headSha).toBe('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
    expect(reviewEvents[0].data.currentHeadSha).toBe('23dbc7f76b130f3fa35b4777eb938fbf23dbc7f7');
    expect(reviewEvents[0].data.submittedAt).toBe('2026-05-30T04:02:50Z');
    expect(reviewEvents[0].data.reviewPassToken).toBe('passtok123456');
  });


  it('emits pr.merged for newly merged PRs with prUrl', async () => {
    const prData = JSON.stringify([
      {
        number: 9,
        head: { ref: 'bx/task-9', sha: 'aeb006906e70c6502e308610eef046d0aeb00690' },
        html_url: 'https://github.com/user/repo/pull/9',
        state: 'closed',
        merged_at: '2026-04-30T05:00:00Z',
        updated_at: '2026-04-30T05:00:00Z',
      },
    ]);
    const runner = makeRunner({ '/pulls?': prData });
    const emitted: MappedEvent[] = [];
    const { poller, entry } = makePoller(runner, (e) => emitted.push(e));

    await poller.pollPullRequests(entry);
    await poller.pollPullRequests(entry);

    const merges = emitted.filter((e) => e.type === 'pr.merged');
    expect(merges).toHaveLength(1);
    expect(merges[0].data.prNumber).toBe(9);
    expect(merges[0].data.prUrl).toBe('https://github.com/user/repo/pull/9');
    expect(merges[0].data.branch).toBe('bx/task-9');
  });

  it('emits pr.created with prUrl for newly observed open PRs', async () => {
    const prData = JSON.stringify([
      {
        number: 11,
        head: { ref: 'bx/task-11', sha: '2f5fc37b67970bb3afdf43fbe7178b332f5fc37b' },
        html_url: 'https://github.com/user/repo/pull/11',
        state: 'open',
        merged_at: null,
        updated_at: '2026-04-30T00:00:00Z',
      },
    ]);
    const runner = makeRunner({ '/pulls?': prData });
    const emitted: MappedEvent[] = [];
    const { poller, entry } = makePoller(runner, (e) => emitted.push(e));

    await poller.pollPullRequests(entry);

    const created = emitted.filter((e) => e.type === 'pr.created');
    expect(created).toHaveLength(1);
    expect(created[0].data.prNumber).toBe(11);
    expect(created[0].data.prUrl).toBe('https://github.com/user/repo/pull/11');
    expect(created[0].data.branch).toBe('bx/task-11');
    expect(created[0].data.headSha).toBe('2f5fc37b67970bb3afdf43fbe7178b332f5fc37b');
  });

  it('emits pr.updated kind=push when PR.head.sha changes (real code update)', async () => {
    const prDataInitial = JSON.stringify([
      {
        number: 12,
        head: { ref: 'bx/task-12', sha: 'a8f6885e68b6481e287608dee836c89ea8f6885e' },
        html_url: 'https://github.com/user/repo/pull/12',
        state: 'open',
        merged_at: null,
        updated_at: '2026-04-30T00:00:00Z',
      },
    ]);
    const prDataAdvanced = JSON.stringify([
      {
        number: 12,
        head: { ref: 'bx/task-12', sha: '219d4d3169d58579a11dcdb1e95505f9219d4d31' },
        html_url: 'https://github.com/user/repo/pull/12',
        state: 'open',
        merged_at: null,
        updated_at: '2026-05-01T00:00:00Z',
      },
    ]);
    const runner = {
      exec: vi
        .fn<(cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>>()
        .mockImplementation(async (cmd: string) => {
          const slurped = cmd.includes('--slurp');
          if (cmd.includes('/pulls?')) {
            const callIdx = runner.exec.mock.calls.filter((c) => c[0].includes('/pulls?')).length;
            return { stdout: callIdx <= 1 ? prDataInitial : prDataAdvanced, stderr: '', exitCode: 0 };
          }
          return { stdout: slurped ? '[[]]' : '[]', stderr: '', exitCode: 0 };
        }),
    };
    const emitted: MappedEvent[] = [];
    const { poller, entry } = makePoller(runner, (e) => emitted.push(e));

    await poller.pollPullRequests(entry);
    await poller.pollPullRequests(entry);

    const updates = emitted.filter((e) => e.type === 'pr.updated');
    expect(updates).toHaveLength(1);
    expect(updates[0].data.prNumber).toBe(12);
    expect(updates[0].data.prUrl).toBe('https://github.com/user/repo/pull/12');
    expect(updates[0].data.branch).toBe('bx/task-12');
    expect(updates[0].data.kind).toBe('push');
    expect(updates[0].data.headSha).toBe('219d4d3169d58579a11dcdb1e95505f9219d4d31');
  });

  it('does NOT emit pr.updated when updated_at advances but head.sha unchanged', async () => {
    const sha = 'cafef00dcafef00dcafef00dcafef00dcafef00d';
    const prDataInitial = JSON.stringify([
      {
        number: 14,
        head: { ref: 'bx/task-14', sha },
        html_url: 'https://github.com/user/repo/pull/14',
        state: 'open',
        merged_at: null,
        updated_at: '2026-04-30T00:00:00Z',
      },
    ]);
    const prDataMetadataBumped = JSON.stringify([
      {
        number: 14,
        head: { ref: 'bx/task-14', sha },
        html_url: 'https://github.com/user/repo/pull/14',
        state: 'open',
        merged_at: null,
        updated_at: '2026-05-01T00:00:00Z',
      },
    ]);
    const runner = {
      exec: vi
        .fn<(cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>>()
        .mockImplementation(async (cmd: string) => {
          const slurped = cmd.includes('--slurp');
          if (cmd.includes('/pulls?')) {
            const callIdx = runner.exec.mock.calls.filter((c) => c[0].includes('/pulls?')).length;
            return { stdout: callIdx <= 1 ? prDataInitial : prDataMetadataBumped, stderr: '', exitCode: 0 };
          }
          return { stdout: slurped ? '[[]]' : '[]', stderr: '', exitCode: 0 };
        }),
    };
    const emitted: MappedEvent[] = [];
    const { poller, entry } = makePoller(runner, (e) => emitted.push(e));

    await poller.pollPullRequests(entry);
    await poller.pollPullRequests(entry);

    expect(emitted.filter((e) => e.type === 'pr.created')).toHaveLength(1);
    expect(emitted.filter((e) => e.type === 'pr.updated')).toHaveLength(0);
  });

  it('ignores PRs lacking baxian:managed marker even on bx/ branch', async () => {
    const prData = JSON.stringify([
      {
        number: 15,
        head: { ref: 'bx/task-15', sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
        html_url: 'https://github.com/user/repo/pull/15',
        body: 'manually opened on a bx/ branch with no marker',
        state: 'open',
        merged_at: null,
        updated_at: '2026-04-30T00:00:00Z',
      },
    ]);
    const runner = makeRunner({ '/pulls?': prData });
    const emitted: MappedEvent[] = [];
    const { poller, entry } = makePoller(runner, (e) => emitted.push(e));

    await poller.pollPullRequests(entry);

    expect(emitted).toHaveLength(0);
    const reviewCalls = runner.exec.mock.calls.filter((c) => c[0].includes('/pulls/15'));
    expect(reviewCalls).toHaveLength(0);
  });

  it('emits pr.updated for review-line comments with prUrl', async () => {
    const prData = JSON.stringify([
      {
        number: 13,
        head: { ref: 'bx/task-13', sha: '219d4d3169d58579a11dcdb1e95505f9219d4d31' },
        html_url: 'https://github.com/user/repo/pull/13',
        state: 'open',
        merged_at: null,
        updated_at: '2026-04-30T00:00:00Z',
      },
    ]);
    const reviewCommentData = JSON.stringify([{ id: 7001 }]);
    const runner = makeRunner({
      '/pulls?': prData,
      '/pulls/13/comments': reviewCommentData,
    });
    const emitted: MappedEvent[] = [];
    const { poller, entry } = makePoller(runner, (e) => emitted.push(e));

    await poller.pollPullRequests(entry);

    const reviewLineUpdates = emitted.filter(
      (e) => e.type === 'pr.updated' && e.data.commentId === 7001,
    );
    expect(reviewLineUpdates).toHaveLength(1);
    expect(reviewLineUpdates[0].data.prUrl).toBe('https://github.com/user/repo/pull/13');
    expect(reviewLineUpdates[0].data.branch).toBe('bx/task-13');
  });

  it('marks review-line comment replies without treating every reply as a dev acknowledgement', async () => {
    const prData = JSON.stringify([
      {
        number: 14,
        head: { ref: 'bx/task-14', sha: '319d4d3169d58579a11dcdb1e95505f9219d4d31' },
        html_url: 'https://github.com/user/repo/pull/14',
        state: 'open',
        merged_at: null,
        updated_at: '2026-04-30T00:00:00Z',
      },
    ]);
    const reviewCommentData = JSON.stringify([{ id: 7002, in_reply_to_id: 7001 }]);
    const runner = makeRunner({
      '/pulls?': prData,
      '/pulls/14/comments': reviewCommentData,
    });
    const emitted: MappedEvent[] = [];
    const { poller, entry } = makePoller(runner, (e) => emitted.push(e));

    await poller.pollPullRequests(entry);

    const reviewLineUpdates = emitted.filter(
      (e) => e.type === 'pr.updated' && e.data.commentId === 7002,
    );
    expect(reviewLineUpdates).toHaveLength(1);
    expect(reviewLineUpdates[0].data.reviewCommentReply).toBe(true);
  });

  it('ignores any reply-marker text in a review-line comment body (post-approve-reply marker is retired)', async () => {
    const prData = JSON.stringify([
      {
        number: 15,
        head: { ref: 'bx/task-15', sha: '419d4d3169d58579a11dcdb1e95505f9219d4d31' },
        html_url: 'https://github.com/user/repo/pull/15',
        state: 'open',
        merged_at: null,
        updated_at: '2026-04-30T00:00:00Z',
      },
    ]);
    const reviewCommentData = JSON.stringify([
      {
        id: 7003,
        in_reply_to_id: 7001,
        body: "Won't fix: this is intentional.\n<!-- baxian:dev-1:post-approve-reply:post-token-42 -->",
      },
    ]);
    const runner = makeRunner({
      '/pulls?': prData,
      '/pulls/15/comments': reviewCommentData,
    });
    const emitted: MappedEvent[] = [];
    const { poller, entry } = makePoller(runner, (e) => emitted.push(e));

    await poller.pollPullRequests(entry);

    const ev = emitted.find((e) => e.data.commentId === 7003);
    expect(ev).toBeTruthy();
    expect(ev?.data.reviewCommentReply).toBe(true);
    expect(ev?.data).not.toHaveProperty('postApproveReplyAgentId');
    expect(ev?.data).not.toHaveProperty('postApproveReplyToken');
  });

  describe('pollIssueCommentsForPr (PR conversation comment polling)', () => {
    it('fetches /issues/{prNumber}/comments with --paginate --slurp and emits pr.updated for each new comment', async () => {
      const prData = JSON.stringify([
        {
          number: 21,
          head: { ref: 'bx/task-21', sha: 'a8f6885e68b6481e287608dee836c89ea8f6885e' },
          html_url: 'https://github.com/user/repo/pull/21',
          state: 'open',
          merged_at: null,
          updated_at: '2026-04-30T00:00:00Z',
        },
      ]);
      const issueCommentData = JSON.stringify([
        { id: 8001, body: 'first' },
        { id: 8002, body: 'second' },
      ]);
      const runner = makeRunner({
        '/pulls?': prData,
        '/issues/21/comments': issueCommentData,
      });
      const emitted: MappedEvent[] = [];
      const { poller, entry } = makePoller(runner, (e) => emitted.push(e));

      await poller.pollPullRequests(entry);

      const issueCommentCalls = runner.exec.mock.calls.filter((c) =>
        c[0].includes('/issues/21/comments'),
      );
      expect(issueCommentCalls).toHaveLength(1);
      expect(issueCommentCalls[0][0]).toContain('--paginate');
      expect(issueCommentCalls[0][0]).toContain('--slurp');
      expect(issueCommentCalls[0][0]).toBe(
        'gh api repos/user/repo/issues/21/comments --paginate --slurp',
      );

      const conversationEvents = emitted.filter(
        (e) => e.type === 'pr.updated' && (e.data.commentId === 8001 || e.data.commentId === 8002),
      );
      expect(conversationEvents).toHaveLength(2);
      for (const ev of conversationEvents) {
        expect(ev.data.prNumber).toBe(21);
        expect(ev.data.prUrl).toBe('https://github.com/user/repo/pull/21');
        expect(ev.data.branch).toBe('bx/task-21');
      }
    });

    it('does not poll issue comments for non-baxian PRs (branch lacks bx/ prefix)', async () => {
      const prData = JSON.stringify([
        {
          number: 30,
          head: { ref: 'feature/other', sha: '2f5fc37b67970bb3afdf43fbe7178b332f5fc37b' },
          html_url: 'https://github.com/user/repo/pull/30',
          state: 'open',
          merged_at: null,
          updated_at: '2026-04-30T00:00:00Z',
        },
      ]);
      const runner = makeRunner({ '/pulls?': prData });
      const emitted: MappedEvent[] = [];
      const { poller, entry } = makePoller(runner, (e) => emitted.push(e));

      await poller.pollPullRequests(entry);

      const issueCommentCalls = runner.exec.mock.calls.filter((c) =>
        c[0].includes('/issues/30/comments'),
      );
      expect(issueCommentCalls).toHaveLength(0);
      expect(emitted).toHaveLength(0);
    });

    it('dedupes already-seen issue comments via cursor (5 comments → 5 emits then 0)', async () => {
      const prData = JSON.stringify([
        {
          number: 22,
          head: { ref: 'bx/task-22', sha: '219d4d3169d58579a11dcdb1e95505f9219d4d31' },
          html_url: 'https://github.com/user/repo/pull/22',
          state: 'open',
          merged_at: null,
          updated_at: '2026-04-30T00:00:00Z',
        },
      ]);
      const issueCommentData = JSON.stringify([
        { id: 9001 }, { id: 9002 }, { id: 9003 }, { id: 9004 }, { id: 9005 },
      ]);
      const runner = makeRunner({
        '/pulls?': prData,
        '/issues/22/comments': issueCommentData,
      });
      const emitted: MappedEvent[] = [];
      const { poller, entry } = makePoller(runner, (e) => emitted.push(e));

      await poller.pollPullRequests(entry);
      const firstRound = emitted.filter((e) => typeof e.data.commentId === 'number').length;
      expect(firstRound).toBe(5);

      const before = emitted.length;
      await poller.pollPullRequests(entry);
      const secondRound = emitted.length - before;
      expect(secondRound).toBe(0);
    });

    it('treats (retired) completion marker comment as a plain comment', async () => {
      const prData = JSON.stringify([
        {
          number: 26,
          head: { ref: 'bx/task-26', sha: '26dbc7f76b130f3fa35b4777eb938fbf26dbc7f7' },
          html_url: 'https://github.com/user/repo/pull/26',
          state: 'open',
          merged_at: null,
          updated_at: '2026-04-30T00:00:00Z',
        },
      ]);
      const issueCommentData = JSON.stringify([
        {
          id: 26001,
          body: 'All feedback handled.\n<!-- baxian:dev-1:post-approved:post-token-26 -->',
        },
      ]);
      const runner = makeRunner({
        '/pulls?': prData,
        '/issues/26/comments': issueCommentData,
      });
      const emitted: MappedEvent[] = [];
      const { poller, entry } = makePoller(runner, (e) => emitted.push(e));

      await poller.pollPullRequests(entry);

      const ev = emitted.find(e => e.data.commentId === 26001);
      expect(ev?.data.kind).toBe('comment');
      expect(ev?.data).not.toHaveProperty('signalToken');
      expect(ev?.data).not.toHaveProperty('verdictAgentId');
    });

    it('staged cursor partial-success: third comment emit throws → cursor still records 1/2/4/5', async () => {
      const prData = JSON.stringify([
        {
          number: 23,
          head: { ref: 'bx/task-23', sha: 'aa3402146af4c2d42ab48294ea744254aa340214' },
          html_url: 'https://github.com/user/repo/pull/23',
          state: 'open',
          merged_at: null,
          updated_at: '2026-04-30T00:00:00Z',
        },
      ]);
      const issueCommentData = JSON.stringify([
        { id: 10001 }, { id: 10002 }, { id: 10003 }, { id: 10004 }, { id: 10005 },
      ]);
      const runner = makeRunner({
        '/pulls?': prData,
        '/issues/23/comments': issueCommentData,
      });
      let throwOnce = true;
      const onEvent = vi.fn(async (e: MappedEvent) => {
        if (e.data.commentId === 10003 && throwOnce) {
          throwOnce = false;
          throw new Error('boom on third');
        }
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { poller, entry } = makePoller(runner, onEvent);

      await expect(poller.pollPullRequests(entry)).rejects.toThrow(/pollPullRequests: \d+ failure/);
      const firstRoundConvCalls = onEvent.mock.calls.filter(
        (c) => typeof (c[0] as MappedEvent).data.commentId === 'number',
      );
      expect(firstRoundConvCalls).toHaveLength(5);

      onEvent.mockClear();
      await poller.pollPullRequests(entry);
      const secondRoundConvCalls = onEvent.mock.calls.filter(
        (c) => typeof (c[0] as MappedEvent).data.commentId === 'number',
      );
      expect(secondRoundConvCalls).toHaveLength(1);
      expect(secondRoundConvCalls[0][0].data.commentId).toBe(10003);
      errSpy.mockRestore();
    });

    it('skips entire batch when gh api fails (exitCode != 0); cursor unchanged for retry', async () => {
      const prData = JSON.stringify([
        {
          number: 24,
          head: { ref: 'bx/task-24', sha: '23dbc7f76b130f3fa35b4777eb938fbf23dbc7f7' },
          html_url: 'https://github.com/user/repo/pull/24',
          state: 'open',
          merged_at: null,
          updated_at: '2026-04-30T00:00:00Z',
        },
      ]);
      const issueCommentData = JSON.stringify([{ id: 11001 }]);
      let attemptCount = 0;
      const runner = {
        exec: vi.fn(async (cmd: string) => {
          if (cmd.includes('/pulls?')) {
            return { stdout: prData, stderr: '', exitCode: 0 };
          }
          if (cmd.includes('/issues/24/comments')) {
            attemptCount += 1;
            if (attemptCount === 1) {
              return { stdout: '', stderr: 'boom', exitCode: 1 };
            }
            return { stdout: `[${issueCommentData}]`, stderr: '', exitCode: 0 };
          }
          return { stdout: cmd.includes('--slurp') ? '[[]]' : '[]', stderr: '', exitCode: 0 };
        }),
      };
      const emitted: MappedEvent[] = [];
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { poller, entry } = makePoller(runner, (e) => emitted.push(e));

      await expect(poller.pollPullRequests(entry)).rejects.toThrow(/pollPullRequests: \d+ failure/);
      expect(emitted.filter((e) => e.data.commentId === 11001)).toHaveLength(0);

      await poller.pollPullRequests(entry);
      expect(emitted.filter((e) => e.data.commentId === 11001)).toHaveLength(1);
      errSpy.mockRestore();
    });

    it('skips entire batch when gh api stdout is unparseable; cursor unchanged for retry', async () => {
      const prData = JSON.stringify([
        {
          number: 25,
          head: { ref: 'bx/task-25', sha: 'ac728cda6c324c9a2cf20c5aecb2cc1aac728cda' },
          html_url: 'https://github.com/user/repo/pull/25',
          state: 'open',
          merged_at: null,
          updated_at: '2026-04-30T00:00:00Z',
        },
      ]);
      const runner = {
        exec: vi.fn(async (cmd: string) => {
          if (cmd.includes('/pulls?')) {
            return { stdout: prData, stderr: '', exitCode: 0 };
          }
          if (cmd.includes('/issues/25/comments')) {
            return { stdout: 'not-json', stderr: '', exitCode: 0 };
          }
          return { stdout: cmd.includes('--slurp') ? '[[]]' : '[]', stderr: '', exitCode: 0 };
        }),
      };
      const emitted: MappedEvent[] = [];
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { poller, entry } = makePoller(runner, (e) => emitted.push(e));

      await expect(poller.pollPullRequests(entry)).rejects.toThrow(/pollPullRequests: \d+ failure/);
      expect(emitted.filter((e) => typeof e.data.commentId === 'number')).toHaveLength(0);
      errSpy.mockRestore();
    });
  });

  describe('staged cursor promotion across mergedPrs / reviews / reviewComments / pullsByHead', () => {
    it('mergedPrs: emit throws → cursor.mergedPrs not stamped → next poll re-emits', async () => {
      const prData = JSON.stringify([
        {
          number: 50,
          head: { ref: 'bx/task-50', sha: 'aa3402146af4c2d42ab48294ea744254aa340214' },
          html_url: 'https://github.com/user/repo/pull/50',
          state: 'closed',
          merged_at: '2026-04-30T05:00:00Z',
          updated_at: '2026-04-30T05:00:00Z',
        },
      ]);
      const runner = makeRunner({ '/pulls?': prData });
      let throwOnce = true;
      const onEvent = vi.fn(async (e: MappedEvent) => {
        if (e.type === 'pr.merged' && throwOnce) {
          throwOnce = false;
          throw new Error('emit pr.merged failed');
        }
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { poller, entry } = makePoller(runner, onEvent);

      await expect(poller.pollPullRequests(entry)).rejects.toThrow(/pollPullRequests: \d+ failure/);
      await poller.pollPullRequests(entry);

      const mergedEmits = onEvent.mock.calls.filter(
        (c) => (c[0] as MappedEvent).type === 'pr.merged',
      );
      expect(mergedEmits).toHaveLength(2);
      errSpy.mockRestore();
    });

    it('reviews: emit throws → cursor.reviews not stamped → next poll re-emits', async () => {
      const prData = JSON.stringify([
        {
          number: 51,
          head: { ref: 'bx/task-51', sha: '23dbc7f76b130f3fa35b4777eb938fbf23dbc7f7' },
          html_url: 'https://github.com/user/repo/pull/51',
          state: 'open',
          merged_at: null,
          updated_at: '2026-04-30T00:00:00Z',
        },
      ]);
      const reviewData = JSON.stringify([{ id: 12001, state: 'APPROVED' }]);
      const runner = makeRunner({
        '/pulls?': prData,
        '/reviews': reviewData,
      });
      let throwOnce = true;
      const onEvent = vi.fn(async (e: MappedEvent) => {
        if (e.type === 'review.submitted' && throwOnce) {
          throwOnce = false;
          throw new Error('emit review.submitted failed');
        }
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { poller, entry } = makePoller(runner, onEvent);

      await expect(poller.pollPullRequests(entry)).rejects.toThrow(/pollPullRequests: \d+ failure/);
      await poller.pollPullRequests(entry);

      const reviewEmits = onEvent.mock.calls.filter(
        (c) => (c[0] as MappedEvent).type === 'review.submitted',
      );
      expect(reviewEmits).toHaveLength(2);
      errSpy.mockRestore();
    });

    it('reviewComments: emit throws → cursor.reviewComments not stamped → next poll re-emits', async () => {
      const prData = JSON.stringify([
        {
          number: 52,
          head: { ref: 'bx/task-52', sha: 'ac728cda6c324c9a2cf20c5aecb2cc1aac728cda' },
          html_url: 'https://github.com/user/repo/pull/52',
          state: 'open',
          merged_at: null,
          updated_at: '2026-04-30T00:00:00Z',
        },
      ]);
      const reviewCommentData = JSON.stringify([{ id: 13001 }]);
      const runner = makeRunner({
        '/pulls?': prData,
        '/pulls/52/comments': reviewCommentData,
      });
      let throwOnce = true;
      const onEvent = vi.fn(async (e: MappedEvent) => {
        if (e.type === 'pr.updated' && e.data.commentId === 13001 && throwOnce) {
          throwOnce = false;
          throw new Error('emit pr.updated review-comment failed');
        }
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { poller, entry } = makePoller(runner, onEvent);

      await expect(poller.pollPullRequests(entry)).rejects.toThrow(/pollPullRequests: \d+ failure/);
      await poller.pollPullRequests(entry);

      const reviewCommentEmits = onEvent.mock.calls.filter(
        (c) =>
          (c[0] as MappedEvent).type === 'pr.updated' &&
          (c[0] as MappedEvent).data.commentId === 13001,
      );
      expect(reviewCommentEmits).toHaveLength(2);
      errSpy.mockRestore();
    });

    it('pullsByHead: pr.created emit throws → branch lastSeen not stamped → next poll re-emits pr.created', async () => {
      const prData = JSON.stringify([
        {
          number: 53,
          head: { ref: 'bx/task-53', sha: '251941bd6d5189f5a599c13dedd10975251941bd' },
          html_url: 'https://github.com/user/repo/pull/53',
          state: 'open',
          merged_at: null,
          updated_at: '2026-04-30T00:00:00Z',
        },
      ]);
      const runner = makeRunner({ '/pulls?': prData });
      let throwOnce = true;
      const onEvent = vi.fn(async (e: MappedEvent) => {
        if (e.type === 'pr.created' && throwOnce) {
          throwOnce = false;
          throw new Error('emit pr.created failed');
        }
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { poller, entry } = makePoller(runner, onEvent);

      await expect(poller.pollPullRequests(entry)).rejects.toThrow(/pollPullRequests: \d+ failure/);
      await poller.pollPullRequests(entry);

      const createdEmits = onEvent.mock.calls.filter(
        (c) => (c[0] as MappedEvent).type === 'pr.created',
      );
      expect(createdEmits).toHaveLength(2);
      errSpy.mockRestore();
    });

    it('pr.merged emit fail does NOT abort other PRs in same poll cycle', async () => {
      const prData = JSON.stringify([
        {
          number: 60,
          head: { ref: 'bx/task-60', sha: 'a'.repeat(40) },
          html_url: 'https://github.com/user/repo/pull/60',
          state: 'closed',
          merged_at: '2026-04-30T05:00:00Z',
          updated_at: '2026-04-30T05:00:00Z',
        },
        {
          number: 61,
          head: { ref: 'bx/task-61', sha: 'b'.repeat(40) },
          html_url: 'https://github.com/user/repo/pull/61',
          state: 'open',
          merged_at: null,
          updated_at: '2026-04-30T05:00:00Z',
        },
      ]);
      const runner = makeRunner({ '/pulls?': prData });
      const onEvent = vi.fn(async (e: MappedEvent) => {
        if (e.type === 'pr.merged') throw new Error('boom on merged');
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { poller, entry } = makePoller(runner, onEvent);

      await expect(poller.pollPullRequests(entry)).rejects.toThrow(/pollPullRequests: \d+ failure/);

      const createdFor61 = onEvent.mock.calls.filter(
        (c) => (c[0] as MappedEvent).type === 'pr.created'
          && (c[0] as MappedEvent).data.prNumber === 61,
      );
      expect(createdFor61).toHaveLength(1);
      errSpy.mockRestore();
    });

    it('sub-poll exec hang/throw on PR #X does NOT abort PR #Y in same cycle', async () => {
      const prData = JSON.stringify([
        {
          number: 70,
          head: { ref: 'bx/task-70', sha: 'a'.repeat(40) },
          html_url: 'https://github.com/user/repo/pull/70',
          state: 'open',
          merged_at: null,
          updated_at: '2026-04-30T05:00:00Z',
        },
        {
          number: 71,
          head: { ref: 'bx/task-71', sha: 'b'.repeat(40) },
          html_url: 'https://github.com/user/repo/pull/71',
          state: 'open',
          merged_at: null,
          updated_at: '2026-04-30T05:00:00Z',
        },
      ]);
      const runner: CommandRunner = {
        exec: vi.fn(async (cmd: string) => {
          if (cmd.includes('/pulls?')) {
            return { stdout: prData, stderr: '', exitCode: 0 };
          }
          if (cmd.includes('/pulls/70/reviews')) {
            throw new Error('Command timed out after 60000ms');
          }
          return { stdout: cmd.includes('--slurp') ? '[[]]' : '[]', stderr: '', exitCode: 0 };
        }),
        writeFile: async () => {},
      };
      const emitted: MappedEvent[] = [];
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { poller, entry } = makePoller(runner, (e) => emitted.push(e));

      await expect(poller.pollPullRequests(entry)).rejects.toThrow(/pollPullRequests: \d+ failure/);

      const created70 = emitted.find(e => e.type === 'pr.created' && e.data.prNumber === 70);
      const created71 = emitted.find(e => e.type === 'pr.created' && e.data.prNumber === 71);
      expect(created70).toBeTruthy();
      expect(created71).toBeTruthy();

      const matched = errSpy.mock.calls.some(args =>
        typeof args[0] === 'string' && args[0].includes('pollReviewsForPr for #70 failed'),
      );
      expect(matched).toBe(true);
      errSpy.mockRestore();
    });
  });

  it('start/stop controls the interval', async () => {
    vi.useFakeTimers();
    const runner = makeRunner({ '/pulls?': '[]' });
    const emitted: MappedEvent[] = [];
    const { poller } = makePoller(runner, (e) => emitted.push(e));

    poller.start(1000);
    await vi.advanceTimersByTimeAsync(3000);
    poller.stop();

    expect(runner.exec).toHaveBeenCalled();

    vi.useRealTimers();
  });

  describe('legacy cursor migration (one-shot adoption)', () => {
    it('adopts legacy updated_at value: stamps current head.sha without emitting on first poll', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'baxian-poller-legacy-'));
      const statePath = join(dir, 'cursor.json');
      try {
        await writeFile(statePath, JSON.stringify({
          pullsByHead: { 'bx/task-legacy': '2026-04-30T00:00:00Z' },
          reviews: [],
          reviewComments: [],
          issueComments: [],
          mergedPrs: [],
        }));

        const sha = 'cafef00dcafef00dcafef00dcafef00dcafef00d';
        const prData = JSON.stringify([
          {
            number: 200,
            head: { ref: 'bx/task-legacy', sha },
            html_url: 'https://github.com/user/repo/pull/200',
            state: 'open',
            merged_at: null,
            updated_at: '2026-05-04T00:00:00Z',
          },
        ]);
        const runner = makeRunner({ '/pulls?': prData });
        const emitted: MappedEvent[] = [];
        const poller = new GitHubPoller({
          runner,
          onEvent: (_pid, e) => emitted.push(e),
        });
        poller.add({ projectId: 'test-proj', repo: REPO, statePath });

        await poller.poll();

        expect(emitted.filter(e => e.type === 'pr.created')).toHaveLength(0);
        expect(emitted.filter(e => e.type === 'pr.updated' && e.data.kind === 'push')).toHaveLength(0);

        await poller.poll();
        expect(emitted.filter(e => e.type === 'pr.created')).toHaveLength(0);
        expect(emitted.filter(e => e.type === 'pr.updated' && e.data.kind === 'push')).toHaveLength(0);
      } finally {
        await rm(dir, { recursive: true });
      }
    });

    it('legacy adoption then real new commit: emits pr.updated kind=push', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'baxian-poller-legacy2-'));
      const statePath = join(dir, 'cursor.json');
      try {
        await writeFile(statePath, JSON.stringify({
          pullsByHead: { 'bx/task-legacy2': '2026-04-30T00:00:00Z' },
          reviews: [], reviewComments: [], issueComments: [], mergedPrs: [],
        }));

        const sha1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const sha2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const mkPr = (sha: string) => JSON.stringify([
          {
            number: 201,
            head: { ref: 'bx/task-legacy2', sha },
            html_url: 'https://github.com/user/repo/pull/201',
            state: 'open',
            merged_at: null,
            updated_at: '2026-05-04T00:00:00Z',
          },
        ]);
        let stage: 1 | 2 = 1;
        const runner: CommandRunner = {
          exec: vi.fn(async (cmd: string) => {
            if (cmd.includes('/pulls?')) {
              return { stdout: stage === 1 ? mkPr(sha1) : mkPr(sha2), stderr: '', exitCode: 0 };
            }
            return { stdout: cmd.includes('--slurp') ? '[[]]' : '[]', stderr: '', exitCode: 0 };
          }),
          writeFile: async () => {},
        };
        const emitted: MappedEvent[] = [];
        const poller = new GitHubPoller({
          runner, onEvent: (_pid, e) => emitted.push(e),
        });
        poller.add({ projectId: 'test-proj', repo: REPO, statePath });

        await poller.poll();
        expect(emitted.filter(e => e.type === 'pr.created' || e.type === 'pr.updated')).toHaveLength(0);

        stage = 2;
        await poller.poll();
        const pushEvents = emitted.filter(
          e => e.type === 'pr.updated' && e.data.kind === 'push' && e.data.prNumber === 201,
        );
        expect(pushEvents).toHaveLength(1);
      } finally {
        await rm(dir, { recursive: true });
      }
    });
  });

  describe('corrupted state file', () => {
    it('does NOT overwrite a corrupted cursor file with an empty cursor; cycle is skipped instead', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'baxian-poller-corrupt-'));
      const statePath = join(dir, 'cursor.json');
      try {
        const corrupted = '{ this is not valid JSON';
        await writeFile(statePath, corrupted);

        const sha = 'd'.repeat(40);
        const prData = JSON.stringify([
          {
            number: 999,
            head: { ref: 'bx/should-not-replay', sha },
            html_url: 'https://github.com/user/repo/pull/999',
            state: 'open',
            merged_at: null,
            updated_at: '2026-04-30T00:00:00Z',
          },
        ]);
        const runner = makeRunner({ '/pulls?': prData });
        const emitted: MappedEvent[] = [];
        const poller = new GitHubPoller({
          runner,
          onEvent: (_pid, e) => emitted.push(e),
        });
        poller.add({ projectId: 'test-proj', repo: REPO, statePath });

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
          await poller.poll();
        } finally {
          warnSpy.mockRestore();
        }

        const onDisk = await readFile(statePath, 'utf-8');
        expect(onDisk).toBe(corrupted);
        expect(emitted).toHaveLength(0);
      } finally {
        await rm(dir, { recursive: true });
      }
    });

    it('treats missing state file (ENOENT) as legitimate first-boot; proceeds with empty cursor', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'baxian-poller-firstboot-'));
      const statePath = join(dir, 'cursor.json');
      try {
        const sha = 'e'.repeat(40);
        const prData = JSON.stringify([
          {
            number: 1000,
            head: { ref: 'bx/first-boot', sha },
            html_url: 'https://github.com/user/repo/pull/1000',
            state: 'open',
            merged_at: null,
            updated_at: '2026-04-30T00:00:00Z',
          },
        ]);
        const runner = makeRunner({ '/pulls?': prData });
        const emitted: MappedEvent[] = [];
        const poller = new GitHubPoller({
          runner,
          onEvent: (_pid, e) => emitted.push(e),
        });
        poller.add({ projectId: 'test-proj', repo: REPO, statePath });

        await poller.poll();

        expect(emitted.filter(e => e.type === 'pr.created')).toHaveLength(1);
      } finally {
        await rm(dir, { recursive: true });
      }
    });
  });

  describe('isPolling guard against overlapping cycles', () => {
    it('skips a tick while previous poll is still running', async () => {
      vi.useFakeTimers();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      let resolveFirst: (() => void) | undefined;
      const firstPollHang = new Promise<void>((r) => { resolveFirst = r; });
      let pollNumber = 0;

      const runner: CommandRunner = {
        exec: vi.fn(async () => {
          pollNumber += 1;
          if (pollNumber === 1) await firstPollHang;
          return { stdout: '[]', stderr: '', exitCode: 0 };
        }),
        writeFile: async () => {},
      };
      const emitted: MappedEvent[] = [];
      const { poller } = makePoller(runner, (e) => emitted.push(e));

      poller.start(1000);

      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
      await Promise.resolve();
      expect(pollNumber).toBe(1);

      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
      expect(pollNumber).toBe(1);
      const skipped = warnSpy.mock.calls.some(args =>
        typeof args[0] === 'string' && args[0].includes('previous cycle still running'),
      );
      expect(skipped).toBe(true);

      resolveFirst?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
      expect(pollNumber).toBeGreaterThanOrEqual(2);

      poller.stop();
      warnSpy.mockRestore();
      vi.useRealTimers();
    });

    it('keeps the in-flight guard when stopped and restarted mid-cycle', async () => {
      vi.useFakeTimers();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      let resolveFirst: (() => void) | undefined;
      const firstPollHang = new Promise<void>((r) => { resolveFirst = r; });
      let pollNumber = 0;

      const runner: CommandRunner = {
        exec: vi.fn(async () => {
          pollNumber += 1;
          if (pollNumber === 1) await firstPollHang;
          return { stdout: '[]', stderr: '', exitCode: 0 };
        }),
        writeFile: async () => {},
      };
      const emitted: MappedEvent[] = [];
      const { poller } = makePoller(runner, (e) => emitted.push(e));

      try {
        poller.start(1000);
        await vi.advanceTimersByTimeAsync(1000);
        await Promise.resolve();
        expect(pollNumber).toBe(1);

        poller.stop();
        poller.start(1000);
        await vi.advanceTimersByTimeAsync(1000);
        await Promise.resolve();
        expect(pollNumber).toBe(1);
        expect(warnSpy.mock.calls.some(args =>
          typeof args[0] === 'string' && args[0].includes('previous cycle still running'),
        )).toBe(true);

        resolveFirst?.();
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1000);
        await Promise.resolve();
        expect(pollNumber).toBeGreaterThanOrEqual(2);
      } finally {
        poller.stop();
        warnSpy.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  describe('multi-repo poll iteration', () => {
    it('iterates all registered repos in declaration order; events from later repos are attributed to their projectId', async () => {
      const prDataA = JSON.stringify([
        { number: 11, head: { ref: 'bx/a-1', sha: 'a'.repeat(40) },
          html_url: 'https://github.com/owner/repo-a/pull/11',
          state: 'open', merged_at: null, updated_at: '2026-04-30T00:00:00Z' },
      ]);
      const prDataB = JSON.stringify([
        { number: 22, head: { ref: 'bx/b-1', sha: 'b'.repeat(40) },
          html_url: 'https://github.com/owner/repo-b/pull/22',
          state: 'open', merged_at: null, updated_at: '2026-04-30T00:00:00Z' },
      ]);
      const runner: CommandRunner = {
        exec: vi.fn(async (cmd: string) => {
          if (cmd.includes('repos/owner/repo-a/pulls?')) return { stdout: prDataA, stderr: '', exitCode: 0 };
          if (cmd.includes('repos/owner/repo-b/pulls?')) return { stdout: prDataB, stderr: '', exitCode: 0 };
          return { stdout: cmd.includes('--slurp') ? '[[]]' : '[]', stderr: '', exitCode: 0 };
        }),
        writeFile: async () => {},
      };
      const emitted: Array<{ projectId: string; event: MappedEvent }> = [];
      const poller = new GitHubPoller({
        runner,
        onEvent: (projectId, event) => { emitted.push({ projectId, event }); },
      });
      poller.add({ projectId: 'proj-a', repo: 'owner/repo-a' });
      poller.add({ projectId: 'proj-b', repo: 'owner/repo-b' });

      await poller.poll();

      const created = emitted.filter(e => e.event.type === 'pr.created');
      expect(created).toHaveLength(2);
      expect(created[0].projectId).toBe('proj-a');
      expect(created[0].event.data.prNumber).toBe(11);
      expect(created[1].projectId).toBe('proj-b');
      expect(created[1].event.data.prNumber).toBe(22);
    });

    it('a failing repo does NOT abort the cycle; subsequent repos still get polled', async () => {
      const prDataB = JSON.stringify([
        { number: 33, head: { ref: 'bx/b-only', sha: 'c'.repeat(40) },
          html_url: 'https://github.com/owner/repo-b2/pull/33',
          state: 'open', merged_at: null, updated_at: '2026-04-30T00:00:00Z' },
      ]);
      const runner: CommandRunner = {
        exec: vi.fn(async (cmd: string) => {
          if (cmd.includes('repos/owner/repo-fail/pulls?')) {
            throw new Error('gh: rate-limited');
          }
          if (cmd.includes('repos/owner/repo-b2/pulls?')) return { stdout: prDataB, stderr: '', exitCode: 0 };
          return { stdout: cmd.includes('--slurp') ? '[[]]' : '[]', stderr: '', exitCode: 0 };
        }),
        writeFile: async () => {},
      };
      const emitted: MappedEvent[] = [];
      const poller = new GitHubPoller({
        runner,
        onEvent: (_pid, event) => { emitted.push(event); },
      });
      poller.add({ projectId: 'proj-fail', repo: 'owner/repo-fail' });
      poller.add({ projectId: 'proj-b2', repo: 'owner/repo-b2' });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await poller.poll();
      } finally {
        warnSpy.mockRestore();
      }

      const created = emitted.filter(e => e.type === 'pr.created');
      expect(created).toHaveLength(1);
      expect(created[0].data.prNumber).toBe(33);
    });
  });

  describe('hot-reload (replaceConfig / remove)', () => {
    function makeProject(id: string, repo: string): ProjectConfig {
      return { id, repo, merge: null, agent: [] };
    }

    function makeConfig(projects: ProjectConfig[], githubPollIntervalMs?: number): BaxianConfig {
      return {
        review: { rounds: 1 },
        server: { port: 3000, ...(githubPollIntervalMs ? { githubPollIntervalMs } : {}) },
        project: projects,
      };
    }

    function makeBarePoller() {
      const runner = makeRunner({});
      return new GitHubPoller({ runner, onEvent: () => undefined });
    }

    it('remove(projectId): drops the matching entry and is a no-op when absent', () => {
      const poller = makeBarePoller();
      poller.add({ projectId: 'p1', repo: 'owner/r1' });
      poller.add({ projectId: 'p2', repo: 'owner/r2' });

      expect(poller.remove('p1')).toBe(true);
      expect(poller.snapshots().map(s => s.projectId)).toEqual(['p2']);
      expect(poller.remove('missing')).toBe(false);
    });

    it('replaceConfig adds entries for newly-added projects (using statePathFor)', () => {
      const poller = makeBarePoller();
      poller.add({ projectId: 'p1', repo: 'owner/r1', statePath: '/state/p1.json' });

      const statePathFor = vi.fn((project: ProjectConfig) => `/state/${project.id}.json`);
      poller.replaceConfig(
        makeConfig([makeProject('p1', 'owner/r1'), makeProject('p2', 'owner/r2')]),
        { statePathFor },
      );

      expect(poller.snapshots().map(s => s.projectId).sort()).toEqual(['p1', 'p2']);
      expect(statePathFor).toHaveBeenCalledTimes(1);
      expect(statePathFor.mock.calls[0][0].id).toBe('p2');
    });

    it('replaceConfig skips non-github projects (no poller entry — they never produce a pollable PR)', () => {
      const poller = makeBarePoller();
      poller.replaceConfig(makeConfig([
        makeProject('gh', 'owner/repo'),
        makeProject('gl', 'https://gitlab.example.com/group/proj.git'),
        makeProject('glssh', 'git@gitlab.example.com:group/proj.git'),
      ]));
      expect(poller.snapshots().map(s => s.projectId)).toEqual(['gh']);
    });

    it('replaceConfig removes entries whose repo is no longer in config', () => {
      const poller = makeBarePoller();
      poller.add({ projectId: 'p1', repo: 'owner/r1' });
      poller.add({ projectId: 'p2', repo: 'owner/r2' });

      poller.replaceConfig(makeConfig([makeProject('p1', 'owner/r1')]));
      expect(poller.snapshots().map(s => s.projectId)).toEqual(['p1']);
    });

    it('replaceConfig dedups by repo (case-insensitive) and reassigns owner without losing entry', () => {
      const poller = makeBarePoller();
      poller.add({ projectId: 'old-owner', repo: 'Owner/Repo' });

      poller.replaceConfig(makeConfig([
        makeProject('new-owner', 'owner/repo'),
        makeProject('other', 'owner/repo'),
      ]));

      const snaps = poller.snapshots();
      expect(snaps).toHaveLength(1);
      expect(snaps[0].projectId).toBe('new-owner');
    });

    it('add() normalizes a git-URL repo to its slug (gh API path + snapshot)', async () => {
      const runner = makeRunner({});
      const poller = new GitHubPoller({ runner, onEvent: () => undefined });
      const entry = poller.add({ projectId: 'p1', repo: 'https://github.com/user/repo.git' });

      expect(poller.snapshots()[0].repo).toBe('user/repo');
      await poller.pollPullRequests(entry);
      expect(runner.exec).toHaveBeenCalledWith(
        expect.stringContaining('repos/user/repo/pulls'),
        expect.anything(),
      );
    });

    it('replaceConfig treats URL and legacy spellings of one repo as the same entry', () => {
      const poller = makeBarePoller();
      poller.add({ projectId: 'p1', repo: 'owner/r1' });

      poller.replaceConfig(makeConfig([
        makeProject('p1', 'https://github.com/owner/r1.git'),
        makeProject('p2', 'git@github.com:owner/r1.git'),
      ]));

      const snaps = poller.snapshots();
      expect(snaps).toHaveLength(1);
      expect(snaps[0].projectId).toBe('p1');
      expect(snaps[0].repo).toBe('owner/r1');
    });

    it('pollerStatePathFor yields the same state file for URL and legacy spellings (cursor survives a config rewrite)', () => {
      const base = pollerStatePathFor('/sd', 'Owner/Repo');
      expect(pollerStatePathFor('/sd', 'https://github.com/Owner/Repo.git')).toBe(base);
      expect(pollerStatePathFor('/sd', 'git@github.com:owner/repo')).toBe(base);
      expect(pollerStatePathFor('/sd', 'ssh://git@github.com/owner/repo.git')).toBe(base);
    });

    it('replaceConfig preserves the cursor when project.repo is rewritten from slug to URL form', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'gh-poller-url-'));
      try {
        const statePath = join(tempDir, 'state.json');
        const prData = JSON.stringify([
          { number: 1, html_url: 'https://example.com/pr/1', body: '<!-- baxian:managed -->', head: { ref: 'bx/task-1', sha: 'a'.repeat(40) }, state: 'open', merged_at: null, updated_at: '2026-05-25T10:00:00Z' },
        ]);
        const runner = makeRunner({ '/pulls?': prData });
        const emitted: MappedEvent[] = [];
        const poller = new GitHubPoller({ runner, onEvent: (_pid, e) => { emitted.push(e); } });
        poller.add({ projectId: 'p1', repo: 'owner/repo', statePath });

        await poller.poll();
        expect(emitted.filter(e => e.type === 'pr.created')).toHaveLength(1);

        poller.replaceConfig(makeConfig([makeProject('p1', 'https://github.com/owner/repo.git')]));

        emitted.length = 0;
        await poller.poll();
        expect(emitted.filter(e => e.type === 'pr.created')).toHaveLength(0);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('replaceConfig preserves cursor when owner changes for the same repo', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'gh-poller-hot-'));
      try {
        const statePath = join(tempDir, 'state.json');
        const prData = JSON.stringify([
          { number: 1, html_url: 'https://example.com/pr/1', body: '<!-- baxian:managed -->', head: { ref: 'bx/task-1', sha: 'a'.repeat(40) }, state: 'open', merged_at: null, updated_at: '2026-05-25T10:00:00Z' },
        ]);
        const runner = makeRunner({ '/pulls?': prData });
        const emitted: MappedEvent[] = [];
        const poller = new GitHubPoller({ runner, onEvent: (_pid, e) => { emitted.push(e); } });
        poller.add({ projectId: 'owner-old', repo: 'owner/repo', statePath });

        await poller.poll();
        expect(emitted.filter(e => e.type === 'pr.created')).toHaveLength(1);

        poller.replaceConfig(makeConfig([makeProject('owner-new', 'owner/repo')]));

        emitted.length = 0;
        await poller.poll();
        expect(emitted.filter(e => e.type === 'pr.created')).toHaveLength(0);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('replaceConfig reschedules the periodic timer when githubPollIntervalMs changes', async () => {
      vi.useFakeTimers();
      const runner = makeRunner({});
      const poller = new GitHubPoller({ runner, onEvent: () => undefined });
      poller.add({ projectId: 'p1', repo: 'owner/r1' });
      poller.start(2000);

      await vi.advanceTimersByTimeAsync(2000);
      const callsAt2s = runner.exec.mock.calls.length;
      expect(callsAt2s).toBeGreaterThan(0);

      poller.replaceConfig(makeConfig([makeProject('p1', 'owner/r1')], 5000));
      expect(poller.snapshots()[0].intervalMs).toBe(5000);

      await vi.advanceTimersByTimeAsync(4999);
      expect(runner.exec.mock.calls.length).toBe(callsAt2s);
      await vi.advanceTimersByTimeAsync(1);
      expect(runner.exec.mock.calls.length).toBeGreaterThan(callsAt2s);

      poller.stop();
      vi.useRealTimers();
    });

    it('replaceConfig keeps the default 30s interval when githubPollIntervalMs is unset', async () => {
      vi.useFakeTimers();
      const runner = makeRunner({});
      const poller = new GitHubPoller({ runner, onEvent: () => undefined });
      poller.add({ projectId: 'p1', repo: 'owner/r1' });
      poller.start(30_000);

      poller.replaceConfig(makeConfig([makeProject('p1', 'owner/r1')]));
      expect(poller.snapshots()[0].intervalMs).toBe(30_000);

      poller.stop();
      vi.useRealTimers();
    });
  });
});
