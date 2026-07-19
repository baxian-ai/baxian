import { describe, it, expect } from 'vitest';
import {
  buildReviewTokenLine, extractReviewTokens, buildAckMarker, extractAckMarkers,
  stripBaxianMarkerLines, classifyCommentSource, collectValidAcks,
  projectCommentRow, rowAcks, rowBodyDigest, rowHasBody, rowTokens,
  type AckCarrierRow, type AckActorContext,
} from '../../src/platform/markers.js';

const SHA = 'abc123abc123abc123abc123abc123abc123abc1';
const DIGEST = 'a'.repeat(64);

describe('review token markers', () => {
  it('build and extract round-trip for both directions', () => {
    const body = `LGTM\n${buildReviewTokenLine({ kind: 'pass', anchorSha: SHA, token: 'deadbeef1234' })}`;
    expect(extractReviewTokens(body)).toEqual([{ kind: 'pass', anchorSha: SHA, token: 'deadbeef1234' }]);
    const fail = buildReviewTokenLine({ kind: 'fail', anchorSha: SHA, token: 'cafebabe5678' });
    expect(extractReviewTokens(fail)[0]!.kind).toBe('fail');
  });

  it('extracts multiple markers and normalizes anchor case', () => {
    const body = [
      `<!-- baxian:review:pass:${SHA.toUpperCase()}:tokenaaaaaaa -->`,
      'human text between',
      `<!-- baxian:review:fail:${SHA}:tokenbbbbbbb -->`,
    ].join('\n');
    const tokens = extractReviewTokens(body);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]!.anchorSha).toBe(SHA);
  });

  it('ignores the legacy single-token format and lookalike prefixes', () => {
    expect(extractReviewTokens('<!-- baxian:pr-approved:deadbeef1234 -->')).toEqual([]);
    expect(extractReviewTokens('<!-- baxian:review:pass:nothex:tok -->')).toEqual([]);
    expect(extractReviewTokens('baxian:review:pass:abc:tok')).toEqual([]);
  });
});

describe('ack markers', () => {
  it('build and extract round-trip', () => {
    const marker = buildAckMarker({ sourceKey: 'issue-comments', commentId: '100', bodyDigest: DIGEST });
    expect(extractAckMarkers(`done\n${marker}\n${buildAckMarker({ sourceKey: 'reviews', commentId: 'r-1', bodyDigest: DIGEST })}`))
      .toEqual([
        { sourceKey: 'issue-comments', commentId: '100', bodyDigest: DIGEST },
        { sourceKey: 'reviews', commentId: 'r-1', bodyDigest: DIGEST },
      ]);
  });

  it('rejects malformed source keys, ids, and digests', () => {
    expect(extractAckMarkers(`<!-- baxian:reply:ack:Issue:100:${DIGEST} -->`)).toEqual([]);
    expect(extractAckMarkers(`<!-- baxian:reply:ack:issue:a b:${DIGEST} -->`)).toEqual([]);
    expect(extractAckMarkers('<!-- baxian:reply:ack:issue:100:abcd -->')).toEqual([]);
    expect(extractAckMarkers(`<!-- baxian:reply:ack:issue:100:${'A'.repeat(64)} -->`)).toEqual([]);
  });
});

describe('stripBaxianMarkerLines', () => {
  it('removes marker-only lines and keeps mixed-content lines', () => {
    const body = [
      'first line',
      `<!-- baxian:review:pass:${SHA}:tokenaaaaaaa -->`,
      `trailing text <!-- baxian:reply:ack:issue:1:${DIGEST} -->`,
      `  <!-- baxian:reply:ack:issue:2:${DIGEST} -->  `,
      'last line',
    ].join('\n');
    expect(stripBaxianMarkerLines(body)).toBe(`first line\ntrailing text <!-- baxian:reply:ack:issue:1:${DIGEST} -->\nlast line`);
  });

  it('leaves non-baxian comments alone', () => {
    expect(stripBaxianMarkerLines('<!-- plain html comment -->')).toBe('<!-- plain html comment -->');
  });

  it('keeps a line whose visible text sits between a marker and a second comment', () => {
    const line = `<!-- baxian:review:pass:${SHA}:tokenaaaaaaa --> human-visible blocker <!-- context -->`;
    expect(stripBaxianMarkerLines(`before\n${line}\nafter`)).toBe(`before\n${line}\nafter`);
  });
});

describe('row projection', () => {
  it('projects digest/tokens/acks once, releases the body, and helpers serve both forms', () => {
    const body = `note\n${buildReviewTokenLine({ kind: 'pass', anchorSha: SHA, token: 'tokenaaaaaaa' })}\n${buildAckMarker({ sourceKey: 'reviews', commentId: '9', bodyDigest: DIGEST })}`;
    const projected: Record<string, unknown> = { id: '1', body };
    const raw: Record<string, unknown> = { id: '1', body };
    projectCommentRow(projected);
    expect(projected.body).toBeUndefined();
    expect(rowBodyDigest(projected)).toBe(rowBodyDigest(raw));
    expect(rowTokens(projected)).toEqual(rowTokens(raw));
    expect(rowAcks(projected)).toEqual(rowAcks(raw));
    expect(rowHasBody(projected)).toBe(true);
    const empty: Record<string, unknown> = { id: '2', body: null };
    projectCommentRow(empty);
    expect(rowHasBody(empty)).toBe(false);
    expect(rowBodyDigest(empty)).toBe(rowBodyDigest({ id: '2', body: '' }));
  });
});

describe('classifyCommentSource', () => {
  it('maps declared shape to carrier class', () => {
    expect(classifyCommentSource({ map: { id: 'id', body: 'body', reviewState: { sources: ['state'], optional: true } } })).toBe('reviews');
    expect(classifyCommentSource({ map: { id: 'id', body: 'body', discussionId: { sources: ['in_reply_to_id'], optional: true } } })).toBe('threaded');
    expect(classifyCommentSource({ map: { id: 'id', body: 'body' } })).toBe('top-level');
    expect(classifyCommentSource({})).toBe('top-level');
  });
});

describe('collectValidAcks: carrier matrix', () => {
  const verified: AckActorContext = { replyActorId: '77', replyActorStatus: 'verified' };
  const ackTo = (sourceKey: string, commentId: string) => ({ sourceKey, commentId, bodyDigest: DIGEST });
  const row = (over: Partial<AckCarrierRow>): AckCarrierRow => ({
    sourceKey: 'issue-comments', sourceClass: 'top-level', id: '1', authorId: '77',
    discussionId: null, acks: [ackTo('inline-comments', '55')], carriesToken: false, ...over,
  });
  const key = (sourceKey: string, commentId: string) => `${sourceKey}:${commentId}:${DIGEST}`;

  it('accepts top-level rows from the verified actor for any source and reports the carrier', () => {
    const r = collectValidAcks([row({})], verified);
    expect(r.acks).toEqual(new Set([key('inline-comments', '55')]));
    expect(r.carrierRowKeys).toEqual(new Set(['issue-comments:1']));
  });

  it('is fail-closed for provisional actors and mismatched author ids', () => {
    expect(collectValidAcks([row({})], { replyActorId: '77', replyActorStatus: 'provisional' }).acks.size).toBe(0);
    expect(collectValidAcks([row({ authorId: '78' })], verified).acks.size).toBe(0);
    expect(collectValidAcks([row({ authorId: undefined })], verified).acks.size).toBe(0);
    expect(collectValidAcks([row({})], {}).acks.size).toBe(0);
  });

  it('never accepts reviews-class rows as carriers', () => {
    const r = collectValidAcks([row({ sourceClass: 'reviews', sourceKey: 'reviews' })], verified);
    expect(r.acks.size).toBe(0);
    expect(r.carrierRowKeys.size).toBe(0);
  });

  it('never accepts rows carrying a verdict token', () => {
    expect(collectValidAcks([row({ carriesToken: true })], verified).acks.size).toBe(0);
  });

  it('threaded rows ack any revision of their own thread, root and replies alike', () => {
    const thread = (over: Partial<AckCarrierRow>): AckCarrierRow => ({
      sourceKey: 'inline-comments', sourceClass: 'threaded', id: 'x', authorId: undefined,
      discussionId: null, acks: [], carriesToken: false, ...over,
    });
    const root = thread({ id: '55' });
    const reply = thread({ id: '56', discussionId: '55' });
    const otherThreadRoot = thread({ id: '90' });
    const devAck = thread({
      id: '57', discussionId: '55', authorId: '77',
      acks: [
        ackTo('inline-comments', '55'),
        ackTo('inline-comments', '56'),
        ackTo('inline-comments', '90'),
        ackTo('inline-comments', '404'),
        ackTo('issue-comments', '55'),
      ],
    });
    const r = collectValidAcks([root, reply, otherThreadRoot, devAck], verified);
    expect(r.acks).toEqual(new Set([key('inline-comments', '55'), key('inline-comments', '56')]));
    expect(r.carrierRowKeys).toEqual(new Set(['inline-comments:57']));
  });

  it('threaded top-level rows (no discussionId) are not carriers', () => {
    expect(collectValidAcks([row({ sourceClass: 'threaded', discussionId: null })], verified).acks.size).toBe(0);
  });
});
