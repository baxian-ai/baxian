import { describe, it, expect } from 'vitest';
import { buildAckCarrierRows, collectPendingFeedback, feedbackEventTarget, scanCommentSourcesOnce } from '../../src/platform/feedback.js';
import { buildAckMarker, buildReviewTokenLine, collectValidAcks, projectCommentRow, rowBodyDigest } from '../../src/platform/markers.js';
import { TimelineCollector } from '../../src/platform/review-timeline.js';
import { sha256Hex } from '../../src/platform/body-digest.js';
import type { NormalizedRow } from '../../src/platform/row-schema.js';
import type { CommentSource } from '../../src/platform/types.js';
import type { FeedbackSourceScan } from '../../src/platform/feedback.js';

const SHA = 'a'.repeat(40);
const TS = '2026-07-17T01:02:03Z';

function row(id: string, body: string | null, extra: Record<string, unknown> = {}): NormalizedRow {
  const r: NormalizedRow = { id, body, createdAt: TS, updatedAt: TS, ...extra };
  projectCommentRow(r);
  return r;
}

function scan(key: string, sourceClass: FeedbackSourceScan['sourceClass'], rows: NormalizedRow[], ok = true): FeedbackSourceScan {
  return { key, sourceClass, ok, rows };
}

const failLine = buildReviewTokenLine({ kind: 'fail', anchorSha: SHA, token: 'cafebabe5678' });
const passLine = buildReviewTokenLine({ kind: 'pass', anchorSha: SHA, token: 'deadbeef1234' });

describe('collectPendingFeedback', () => {
  it('keeps human comments and fail verdict bodies pending until validly acked', () => {
    const failBody = `blocking findings\n${failLine}`;
    const humanBody = 'please also fix the tests';
    const result = collectPendingFeedback([
      scan('reviews', 'reviews', [row('r1', failBody)]),
      scan('issue-comments', 'top-level', [row('c1', humanBody)]),
    ]);
    expect(result.allSourcesOk).toBe(true);
    expect([...result.pending.keys()].sort()).toEqual([
      `issue-comments:c1:${sha256Hex(humanBody)}`,
      `reviews:r1:${sha256Hex(failBody)}`,
    ]);
  });

  it('clears a revision only through a valid ack and ignores pass-only verdict rows', () => {
    const failBody = `findings\n${failLine}`;
    const ack = `done\n${buildAckMarker({ sourceKey: 'reviews', commentId: 'r1', bodyDigest: sha256Hex(failBody) })}`;
    const result = collectPendingFeedback([
      scan('reviews', 'reviews', [row('r1', failBody), row('r2', `lgtm\n${passLine}`)]),
      scan('issue-comments', 'top-level', [row('c9', ack)]),
    ]);
    expect(result.pending.size).toBe(0);
  });

  it('treats a sole fail verdict with no ack as pending (no-op fix cannot pass on an empty set)', () => {
    const failBody = `findings\n${failLine}`;
    const result = collectPendingFeedback([
      scan('reviews', 'reviews', [row('r1', failBody)]),
      scan('issue-comments', 'top-level', []),
    ]);
    expect(result.pending.size).toBe(1);
  });

  it('does not let ack-carrying replies count as feedback', () => {
    const result = collectPendingFeedback([
      scan('issue-comments', 'top-level', [
        row('c1', 'third-party feedback'),
        row('c2', `on it\n${buildAckMarker({ sourceKey: 'issue-comments', commentId: 'c1', bodyDigest: sha256Hex('third-party feedback') })}`),
      ]),
    ]);
    expect(result.pending.size).toBe(0);
  });

  it('skips undated rows from the pending set', () => {
    const pendingReview: NormalizedRow = { id: 'p1', body: 'draft findings' };
    projectCommentRow(pendingReview);
    const result = collectPendingFeedback([
      scan('reviews', 'reviews', [pendingReview]),
    ]);
    expect(result.pending.size).toBe(0);
  });

  it('reports a failed source so callers stay fail closed', () => {
    const result = collectPendingFeedback([
      scan('reviews', 'reviews', [], false),
      scan('issue-comments', 'top-level', [row('c1', 'feedback')]),
    ]);
    expect(result.allSourcesOk).toBe(false);
    expect(result.pending.size).toBe(1);
  });

  it('keeps an edited revision pending after its stale ack digest mismatches', () => {
    const edited = 'updated requirement';
    const staleAck = buildAckMarker({ sourceKey: 'issue-comments', commentId: 'c1', bodyDigest: sha256Hex('original requirement') });
    const result = collectPendingFeedback([
      scan('issue-comments', 'top-level', [
        row('c1', edited),
        row('c2', `handled\n${staleAck}`),
      ]),
    ]);
    expect([...result.pending.keys()]).toEqual([`issue-comments:c1:${sha256Hex(edited)}`]);
  });
});

describe('feedbackEventTarget', () => {
  it('mirrors the poller synthesis matrix: token rows and carrier rows never become feedback events', () => {
    const humanRow = row('c1', 'feedback');
    const ackRow = row('c2', `ok\n${buildAckMarker({ sourceKey: 'issue-comments', commentId: 'c1', bodyDigest: sha256Hex('feedback') })}`);
    const failRow = row('r1', `no\n${failLine}`);
    const scans = [
      scan('issue-comments', 'top-level', [humanRow, ackRow]),
      scan('reviews', 'reviews', [failRow]),
    ];
    const acks = collectValidAcks(buildAckCarrierRows(scans));
    expect(feedbackEventTarget(failRow, 'reviews', acks)).toBeUndefined();
    expect(feedbackEventTarget(ackRow, 'issue-comments', acks)).toBeUndefined();
    expect(feedbackEventTarget(humanRow, 'issue-comments', acks)).toBeUndefined();
    const fresh = row('c3', 'new feedback');
    expect(feedbackEventTarget(fresh, 'issue-comments', acks))
      .toEqual({ id: 'c3', digest: sha256Hex('new feedback') });
  });
});

describe('scanCommentSourcesOnce with a timeline collector', () => {
  const sources: CommentSource[] = [
    { key: 'issue-comments', category: 'top-level' },
    { key: 'reviews', category: 'reviews' },
  ];

  function pagedDriver(rowsByKey: Record<string, NormalizedRow[] | Error>) {
    return {
      commentSources: sources,
      async listComments(
        source: CommentSource,
        _prNumber: number,
        projectPage?: (pageRows: NormalizedRow[]) => NormalizedRow[],
      ): Promise<NormalizedRow[]> {
        const rows = rowsByKey[source.key] ?? [];
        if (rows instanceof Error) throw rows;
        return projectPage ? projectPage(rows) : rows;
      },
    };
  }

  it('feeds the collector raw bodies while the scan rows stay projected for digesting', async () => {
    const collector = new TimelineCollector(sources);
    const scans = await scanCommentSourcesOnce(
      pagedDriver({
        'issue-comments': [{ id: 'c1', body: 'hello world', createdAt: TS, updatedAt: TS }],
        reviews: [],
      }),
      7,
      () => Date.now(),
      undefined,
      collector,
    );
    const payload = collector.assemble();
    expect(payload.items).toEqual([
      expect.objectContaining({ kind: 'issue-comment', id: 'c1', body: 'hello world' }),
    ]);
    expect(payload.error).toBeUndefined();
    const scanned = scans.find(s => s.key === 'issue-comments')!.rows[0]!;
    expect(scanned.body).toBeUndefined();
    expect(rowBodyDigest(scanned)).toBe(sha256Hex('hello world'));
  });

  it('projects rows even when the driver never calls projectPage', async () => {
    const source: CommentSource = { key: 'issue-comments', category: 'top-level' };
    const collector = new TimelineCollector([source]);
    const scans = await scanCommentSourcesOnce(
      {
        commentSources: [source],
        listComments: async () => [{ id: 'c1', body: 'plain return', createdAt: TS, updatedAt: TS }],
      },
      7,
      () => Date.now(),
      undefined,
      collector,
    );
    const scanned = scans[0]!.rows[0]!;
    expect(scanned.body).toBeUndefined();
    expect(rowBodyDigest(scanned)).toBe(sha256Hex('plain return'));
    expect(collector.assemble().items).toEqual([
      expect.objectContaining({ id: 'c1', body: 'plain return' }),
    ]);
  });

  it('reports a failing source to the collector while the scan itself stays fail-closed', async () => {
    const collector = new TimelineCollector(sources);
    const scans = await scanCommentSourcesOnce(
      pagedDriver({
        'issue-comments': [{ id: 'c1', body: 'ok', createdAt: TS, updatedAt: TS }],
        reviews: new Error('boom'),
      }),
      7,
      () => Date.now(),
      undefined,
      collector,
    );
    expect(scans.find(s => s.key === 'reviews')!.ok).toBe(false);
    expect(collector.assemble().error).toContain('reviews');
  });
});

describe('dismissed fail tokens', () => {
  it('drops a dismissed fail verdict and its cross-source copies from the pending set', () => {
    const failBody = `findings\n${failLine}`;
    const result = collectPendingFeedback([
      scan('reviews', 'reviews', [row('r1', failBody, { reviewState: 'DISMISSED' })]),
      scan('issue-comments', 'top-level', [row('c1', `quoted\n${failLine}`)]),
    ]);
    expect(result.pending.size).toBe(0);
  });
});
