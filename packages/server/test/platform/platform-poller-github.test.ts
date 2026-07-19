import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlatformPoller, type PlatformTaskView } from '../../src/platform/platform-poller.js';
import { platformPollerStatePath } from '../../src/platform/comment-cursor.js';
import { GitDriver, buildDriverRunContext, type DriverExec } from '../../src/platform/git-driver.js';
import { parseDriverSpec } from '../../src/platform/driver-spec.js';
import { buildReviewTokenLine, buildAckMarker } from '../../src/platform/markers.js';
import { bodyDigest } from '../../src/platform/body-digest.js';
import type { MappedEvent } from '../../src/github/mapper.js';

const DRIVER_JSON = join(dirname(fileURLToPath(import.meta.url)), '../../src/platform/plugins/github/driver.json');
const SHA = 'd'.repeat(40);
const ANCHOR = SHA;
const PASS = 'ffffffffffff';
const FAIL = 'eeeeeeeeeeee';
const T0 = Date.parse('2026-07-17T12:00:00Z');
const OLD_TS = '2026-07-17T11:50:00Z';

const ghPull = {
  number: 42, html_url: 'https://github.com/owner/repo/pull/42', state: 'open', draft: false,
  merged_at: null, updated_at: OLD_TS, title: 'feat: something',
  head: { ref: 'bx/task-1', sha: SHA, repo: { id: 1001 } },
  base: { ref: 'main', repo: { id: 1001 } },
  user: { login: 'devbot', id: 77 },
};
const ghIssueComment = (id: number, body: string, user = { login: 'human', id: 55 }) => ({
  id, body, user, created_at: OLD_TS, updated_at: OLD_TS,
});
const ghReview = (id: number, body: string, state: string) => ({
  id, body, user: { login: 'qa', id: 88 }, submitted_at: OLD_TS, state, commit_id: SHA,
});

describe('PlatformPoller over the real github driver.json (fake gh)', () => {
  let dir = '';
  const events: MappedEvent[] = [];
  const world = {
    pulls: [ghPull] as unknown[],
    prView: ghPull as unknown,
    issueComments: [] as unknown[],
    inlineComments: [] as unknown[],
    reviews: [] as unknown[],
  };
  let clockNow = T0;
  let poller: PlatformPoller;
  const tasks: PlatformTaskView[] = [{ taskId: 'task-1', terminal: false, branch: 'bx/task-1' }];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bx-gh-poller-'));
    const parsed = parseDriverSpec(await readFile(DRIVER_JSON, 'utf8'), DRIVER_JSON);
    if ('errors' in parsed) throw new Error(parsed.errors.map(e => e.message).join('\n'));
    const exec: DriverExec = async (cmd) => {
      const page = Number(/[?&]page=(\d+)/.exec(cmd)?.[1] ?? '1');
      const body = (rows: unknown[]) => ({ stdout: JSON.stringify(page === 1 ? rows : []), stderr: '', exitCode: 0 });
      if (cmd.includes('pulls?state=all')) return body(world.pulls);
      if (cmd.includes('/pulls/42/reviews')) return body(world.reviews);
      if (cmd.includes('/pulls/42/comments')) return body(world.inlineComments);
      if (cmd.includes('/issues/42/comments')) return body(world.issueComments);
      if (cmd.endsWith("'repos/owner/repo/pulls/42'")) return { stdout: JSON.stringify(world.prView), stderr: '', exitCode: 0 };
      if (cmd.endsWith("'repos/owner/repo'")) return { stdout: JSON.stringify({ default_branch: 'main', permissions: { push: true } }), stderr: '', exitCode: 0 };
      throw new Error(`no gh fixture for: ${cmd}`);
    };
    const driver = new GitDriver({ spec: parsed.spec }, buildDriverRunContext('git@github.com:owner/repo.git', 'gh'), exec);
    poller = new PlatformPoller({
      onEvent: (_p, event) => { events.push(event); },
      tasks: async () => tasks,
      now: () => clockNow,
    });
    poller.add({ projectId: 'p1', repoUrl: 'git@github.com:owner/repo.git', driver, statePath: platformPollerStatePath(dir, 'git@github.com:owner/repo.git') });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('discovers and adopts the bx branch PR from raw gh JSON', async () => {
    await poller.poll();
    const created = events.filter(e => e.type === 'pr.created');
    expect(created).toHaveLength(1);
    expect(created[0]!.data).toMatchObject({
      prNumber: 42, branch: 'bx/task-1', headSha: SHA, targetBranch: 'main',
      prUrl: 'https://github.com/owner/repo/pull/42',
    });
  });

  it('turns a fail-token native review into REQUEST_CHANGES and human feedback into comment events', async () => {
    Object.assign(tasks[0]!, {
      prNumber: 42, latestHeadSha: SHA, anchorSha: ANCHOR,
      passToken: PASS, failToken: FAIL, signalToken: 'signal-tok-1',
      replyActorId: '77', replyActorStatus: 'verified',
    });
    world.reviews = [ghReview(900, `findings body\n${buildReviewTokenLine({ kind: 'fail', anchorSha: ANCHOR, token: FAIL })}`, 'CHANGES_REQUESTED')];
    world.issueComments = [ghIssueComment(300, 'please also fix naming')];
    events.length = 0;
    await poller.poll();

    const verdicts = events.filter(e => e.type === 'review.submitted');
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.data).toMatchObject({
      action: 'REQUEST_CHANGES', prNumber: 42, headSha: ANCHOR, currentHeadSha: SHA,
      reviewPassToken: 'signal-tok-1',
    });
    const feedback = events.filter(e => e.type === 'pr.updated' && e.data.kind === 'comment');
    expect(feedback).toHaveLength(1);
    expect(feedback[0]!.data.revision).toMatchObject({ sourceKey: 'issue-comments', id: '300' });
  });

  it('filters the dev ack reply and confirms the recheck pass across two cycles', async () => {
    const ack = buildAckMarker({ sourceKey: 'issue-comments', commentId: '300', bodyDigest: bodyDigest('please also fix naming') });
    world.issueComments = [
      ghIssueComment(300, 'please also fix naming'),
      ghIssueComment(301, `Fixed.\n${ack}`, { login: 'devbot', id: 77 }),
    ];
    world.reviews = [
      ...world.reviews,
      ghReview(901, `recheck LGTM\n${buildReviewTokenLine({ kind: 'pass', anchorSha: ANCHOR, token: PASS })}`, 'COMMENTED'),
    ];
    // 同 head 复检轮换新令牌对：旧轮 fail 属旧 pair、不参与本轮比较（spec §7）。
    Object.assign(tasks[0]!, { passToken: PASS, failToken: 'cccccccccccc' });
    events.length = 0;
    clockNow = T0 + 30_000;
    await poller.poll();
    expect(events.filter(e => e.type === 'review.submitted')).toHaveLength(0);
    expect(events.filter(e => e.type === 'pr.updated' && e.data.kind === 'comment')).toHaveLength(0);

    clockNow = T0 + 60_000;
    await poller.poll();
    const verdicts = events.filter(e => e.type === 'review.submitted');
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.data).toMatchObject({ action: 'APPROVE', reviewPassToken: 'signal-tok-1' });
  });

  it('detects the merge through prView', async () => {
    world.prView = { ...ghPull, state: 'closed', merged_at: '2026-07-17T12:05:00Z' };
    events.length = 0;
    await poller.poll();
    expect(events.filter(e => e.type === 'pr.merged')).toHaveLength(1);
  });
});
