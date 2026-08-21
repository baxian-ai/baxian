import { describe, it, expect } from 'vitest';
import {
  buildReviewTokenLine, extractReviewTokens, buildAckMarker, extractAckMarkers,
  stripBaxianMarkerLines, collectValidAcks,
  projectCommentRow, rowAcks, rowBodyDigest, rowHasBody, rowTokens,
  type AckCarrierRow,
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
    const marker = buildAckMarker({ sourceKey: 'issue-comments', commentId: '100' });
    expect(extractAckMarkers(`done\n${marker}\n${buildAckMarker({ sourceKey: 'reviews', commentId: 'r-1' })}`))
      .toEqual([
        { sourceKey: 'issue-comments', commentId: '100' },
        { sourceKey: 'reviews', commentId: 'r-1' },
      ]);
  });

  it('rejects malformed source keys and ids', () => {
    expect(extractAckMarkers('<!-- baxian:reply:ack:Issue:100 -->')).toEqual([]);
    expect(extractAckMarkers('<!-- baxian:reply:ack:issue:a b -->')).toEqual([]);
    expect(extractAckMarkers('<!-- baxian:reply:ack:issue -->')).toEqual([]);
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
    const body = `note\n${buildReviewTokenLine({ kind: 'pass', anchorSha: SHA, token: 'tokenaaaaaaa' })}\n${buildAckMarker({ sourceKey: 'reviews', commentId: '9' })}`;
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

describe('collectValidAcks', () => {
  const ackTo = (sourceKey: string, commentId: string) => ({ sourceKey, commentId });
  const row = (over: Partial<AckCarrierRow>): AckCarrierRow => ({
    sourceKey: 'issue-comments', id: '1', acks: [ackTo('inline-comments', '55')], ...over,
  });

  it('settles the acked comments and the carrying rows themselves', () => {
    expect(collectValidAcks([row({})]))
      .toEqual(new Set(['inline-comments:55', 'issue-comments:1']));
  });

  it('collects acks from any row and skips rows carrying none', () => {
    expect(collectValidAcks([
      row({ sourceKey: 'reviews', id: 'r-1', acks: [ackTo('issue-comments', '9')] }),
      row({ id: '2', acks: [] }),
    ])).toEqual(new Set(['issue-comments:9', 'reviews:r-1']));
  });
});
