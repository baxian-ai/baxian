import { describe, it, expect } from 'vitest';
import { buildDriverReviewTimeline } from '../../src/platform/review-timeline.js';
import { buildReviewTokenLine } from '../../src/platform/markers.js';
import { DriverOpError } from '../../src/platform/types.js';
import type { NormalizedRow } from '../../src/platform/row-schema.js';
import type { CommentSource } from '../../src/platform/types.js';

const SHA = 'a'.repeat(40);
const SOURCES: CommentSource[] = [
  { key: 'issue-comments', category: 'top-level' },
  { key: 'inline-comments', category: 'threaded' },
  { key: 'reviews', category: 'reviews' },
];

function driverWith(comments: Record<string, NormalizedRow[] | Error>) {
  return {
    commentSources: SOURCES,
    listComments: async (
      source: CommentSource,
      _prNumber: number,
      projectPage?: (rows: NormalizedRow[]) => NormalizedRow[],
    ) => {
      const rows = comments[source.key] ?? [];
      if (rows instanceof Error) throw rows;
      const copy = rows.map(r => ({ ...r }));
      return projectPage ? projectPage(copy) : copy;
    },
  };
}

const row = (id: string, body: string, extra: Record<string, unknown> = {}): NormalizedRow =>
  ({ id, body, createdAt: '2026-07-19T01:00:00Z', ...extra });

describe('buildDriverReviewTimeline', () => {
  it('uses the adapter-provided category instead of interpreting the source key', async () => {
    const source: CommentSource = { key: 'gitlab-discussions', category: 'threaded' };
    const { items } = await buildDriverReviewTimeline({
      commentSources: [source],
      listComments: async () => [row('7', 'discussion', { path: 'a.ts', line: 3 })],
    }, 42);
    expect(items[0]).toMatchObject({ kind: 'review-comment', sourceKey: 'gitlab-discussions' });
  });

  it('keeps same-id rows from different sources as distinct threads', async () => {
    const { items } = await buildDriverReviewTimeline(driverWith({
      'issue-comments': [row('7', 'top-level')],
      'inline-comments': [row('7', 'inline root', { path: 'a.ts', line: 3 })],
      'reviews': [row('7', 'review body', { reviewState: 'COMMENTED' })],
    }), 42);
    expect(items).toHaveLength(3);
    const keys = new Set(items.map(i => i.threadKey));
    expect(keys.size).toBe(3);
    expect(items.every(i => i.sourceKey !== undefined)).toBe(true);
  });

  it('marks verdict rows from the token line and strips marker lines from the display body', async () => {
    const pass = buildReviewTokenLine({ kind: 'pass', anchorSha: SHA, token: 'abcdef123456' });
    const { items } = await buildDriverReviewTimeline(driverWith({
      'reviews': [row('r1', `LGTM overall\n${pass}`, { reviewState: 'APPROVED' })],
    }), 42);
    const verdict = items[0]!;
    expect(verdict.verdict).toBe('approve');
    expect(verdict.roundToken).toBe('abcdef123456');
    expect(verdict.anchorSha).toBe(SHA);
    expect(verdict.reviewState).toBe('APPROVED');
    expect(verdict.body).toBe('LGTM overall');
    expect(verdict.body).not.toContain('baxian:review');
  });

  it('maps fail tokens to request-changes even on a COMMENTED degraded carrier', async () => {
    const fail = buildReviewTokenLine({ kind: 'fail', anchorSha: SHA, token: '123456abcdef' });
    const { items } = await buildDriverReviewTimeline(driverWith({
      'reviews': [row('r1', `needs work\n${fail}`, { reviewState: 'COMMENTED' })],
    }), 42);
    expect(items[0]!.verdict).toBe('request-changes');
    expect(items[0]!.roundToken).toBe('123456abcdef');
  });

  it('projects inline threading, line coalescing, and ghost authors', async () => {
    const { items } = await buildDriverReviewTimeline(driverWith({
      'inline-comments': [
        row('10', 'root', { path: 'a.ts', line: null, originalLine: 5, author: 'qa-bot' }),
        row('11', 'reply', { path: 'a.ts', line: 8, discussionId: '10', parentId: '10', createdAt: '2026-07-19T01:05:00Z' }),
      ],
    }), 42);
    const root = items.find(i => i.id === '10')!;
    const reply = items.find(i => i.id === '11')!;
    expect(root.line).toBe(5);
    expect(root.author).toBe('qa-bot');
    expect(reply.inReplyTo).toBe(true);
    expect(reply.threadKey).toBe(root.threadKey);
    expect(reply.author).toBeUndefined();
  });

  it('truncates oversized bodies at the display projection cap', async () => {
    const { items } = await buildDriverReviewTimeline(driverWith({
      'issue-comments': [row('c1', 'x'.repeat(11 * 1024))],
    }), 42);
    expect(items[0]!.bodyTruncated).toBe(true);
    expect(Buffer.byteLength(items[0]!.body ?? '', 'utf8')).toBeLessThanOrEqual(10 * 1024);
  });

  it('compacts rows inside the page hook: full bodies are released while a beyond-cap token still marks the verdict', async () => {
    const pass = buildReviewTokenLine({ kind: 'pass', anchorSha: SHA, token: 'abcdef123456' });
    const huge = `${'x'.repeat(11 * 1024)}\n${pass}`;
    const driver = driverWith({ 'reviews': [row('r1', huge, { reviewState: 'APPROVED' })] });
    const pageRows: NormalizedRow[][] = [];
    const spyingDriver = {
      commentSources: driver.commentSources,
      listComments: async (
        source: CommentSource,
        prNumber: number,
        projectPage?: (rows: NormalizedRow[]) => NormalizedRow[],
      ) => {
        const rows = await driver.listComments(source, prNumber, projectPage);
        pageRows.push(rows);
        return rows;
      },
    };
    const { items } = await buildDriverReviewTimeline(spyingDriver, 42);
    for (const rows of pageRows) {
      expect(rows.every(r => r.body === undefined)).toBe(true);
    }
    const verdict = items[0]!;
    expect(verdict.verdict).toBe('approve');
    expect(verdict.roundToken).toBe('abcdef123456');
    expect(verdict.bodyTruncated).toBe(true);
    expect(Buffer.byteLength(verdict.body ?? '', 'utf8')).toBeLessThanOrEqual(10 * 1024);
  });

  it('stops scanning on a rate-limited source and declares it instead of flattening to a retryable error', async () => {
    const touched: string[] = [];
    const driver = {
      commentSources: SOURCES,
      listComments: async (source: CommentSource) => {
        touched.push(source.key);
        if (source.key === 'issue-comments') {
          throw new DriverOpError('op listComments failed (exit 1, class RATE_LIMIT): HTTP 429', {
            opName: 'listComments', errorClass: 'RATE_LIMIT',
          });
        }
        return [] as NormalizedRow[];
      },
    };
    const { rateLimited, error } = await buildDriverReviewTimeline(driver, 42);
    expect(rateLimited).toBe(true);
    expect(error).toContain('issue-comments');
    expect(touched).toEqual(['issue-comments']);
  });

  it('caps the aggregate across pages and sources, declaring the truncation', async () => {
    const big = 'y'.repeat(9 * 1024);
    const many = Array.from({ length: 400 }, (_, i) => row(`c${i}`, big));
    const { items, truncated } = await buildDriverReviewTimeline(driverWith({
      'issue-comments': many,
      'inline-comments': many,
    }), 42);
    expect(truncated).toBe(true);
    expect(items.length).toBeLessThan(800);
    const bytes = items.reduce((n, i) => n + Buffer.byteLength(i.body ?? '', 'utf8'), 0);
    expect(bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it('bounds and redacts non-driver errors too (schema errors carry the offending value)', async () => {
    const huge = 'S'.repeat(3 * 1024 * 1024);
    const { error } = await buildDriverReviewTimeline({
      commentSources: SOURCES,
      listComments: async () => {
        throw new Error(`row schema violation: ${JSON.stringify({ author: huge, sentinel: 'SECRET123' })}`);
      },
    }, 42);
    expect(error).toBeDefined();
    expect(error!.length).toBeLessThan(2_000);
    expect(error).not.toContain('SECRET123');
  });

  it('declares truncation the moment a source hits its quota, even without one more row', async () => {
    const pages = Array.from({ length: 30 }, (_, p) =>
      Array.from({ length: 100 }, (_, i) => row(`p${p}-${i}`, 'x')));
    let requested = 0;
    const driver = {
      commentSources: [SOURCES[0]],
      listComments: async (
        _source: CommentSource,
        _prNumber: number,
        projectPage?: (rows: NormalizedRow[]) => NormalizedRow[],
        shouldStop?: (rows: NormalizedRow[], page: number) => boolean,
      ) => {
        for (const [i, page] of pages.entries()) {
          requested = i + 1;
          const copy = page.map(r => ({ ...r }));
          projectPage?.(copy);
          if (shouldStop?.(copy, i + 1) === true) break;
        }
        return [] as NormalizedRow[];
      },
    };
    const { items, truncated } = await buildDriverReviewTimeline(driver, 42);
    expect(items.length).toBe(2_000);
    expect(truncated).toBe(true);
    expect(requested).toBeLessThan(pages.length);
  });

  it('carries a body digest on the slim paged row so cross-page body conflicts stay detectable', async () => {
    const seenPages: NormalizedRow[][] = [];
    const driver = {
      commentSources: [SOURCES[0]],
      listComments: async (
        _source: CommentSource,
        _prNumber: number,
        projectPage?: (rows: NormalizedRow[]) => NormalizedRow[],
      ) => {
        const slim = projectPage?.([row('c1', 'first version')]) ?? [];
        seenPages.push(slim);
        return [] as NormalizedRow[];
      },
    };
    await buildDriverReviewTimeline(driver, 42);
    expect(seenPages[0]?.[0]?.bodyDigest).toBeTypeOf('string');
    expect(String(seenPages[0]?.[0]?.bodyDigest ?? '')).not.toBe('');
  });

  it('never leaks driver stderr tails into the response error', async () => {
    const { error } = await buildDriverReviewTimeline({
      commentSources: SOURCES,
      listComments: async () => {
        throw new DriverOpError(
          'op listComments failed (exit 1, class ACCESS_DENIED): token-like-diagnostic=SECRET123',
          { opName: 'listComments', errorClass: 'ACCESS_DENIED', exitCode: 1 },
        );
      },
    }, 42);
    expect(error).toBeDefined();
    expect(error).not.toContain('SECRET123');
    expect(error).toContain('ACCESS_DENIED');
  });

  it('keeps every source in the aggregate budget so a busy first source cannot hide the verdicts', async () => {
    const big = 'y'.repeat(9 * 1024);
    const { items, truncated } = await buildDriverReviewTimeline(driverWith({
      'issue-comments': Array.from({ length: 500 }, (_, i) => row(`c${i}`, big)),
      'reviews': [row('r1', 'verdict here', { reviewState: 'APPROVED' })],
    }), 42);
    expect(truncated).toBe(true);
    expect(items.some(i => i.sourceKey === 'reviews')).toBe(true);
  });

  it('counts the whole projected item, not just the body, against the budget', async () => {
    const longPath = 'p'.repeat(3 * 1024 * 1024);
    const { items, truncated } = await buildDriverReviewTimeline(driverWith({
      'inline-comments': [row('c1', '', { path: longPath })],
    }), 42);
    const bytes = Buffer.byteLength(JSON.stringify(items), 'utf8');
    expect(truncated || bytes <= 2 * 1024 * 1024).toBe(true);
  });

  it('lets a later source page past the first even after an earlier source hit its quota', async () => {
    const big = 'y'.repeat(9 * 1024);
    const pages: Record<string, NormalizedRow[][]> = {
      'issue-comments': [Array.from({ length: 200 }, (_, i) => row(`i${i}`, big))],
      'reviews': [
        [row('r1', 'page one verdict', { reviewState: 'COMMENTED' })],
        [row('r2', 'page two verdict', { reviewState: 'APPROVED' })],
      ],
    };
    const driver = {
      commentSources: SOURCES,
      listComments: async (
        source: CommentSource,
        _prNumber: number,
        projectPage?: (rows: NormalizedRow[]) => NormalizedRow[],
        shouldStop?: (rows: NormalizedRow[], page: number) => boolean,
      ) => {
        for (const [i, page] of (pages[source.key] ?? []).entries()) {
          const copy = page.map(r => ({ ...r }));
          projectPage?.(copy);
          if (shouldStop?.(copy, i + 1) === true) break;
        }
        return [] as NormalizedRow[];
      },
    };
    const { items } = await buildDriverReviewTimeline(driver, 42);
    expect(items.some(i => i.id === 'r2')).toBe(true);
  });

  it('collapses rows repeated across overlapping pages instead of double-counting them', async () => {
    const dup = row('c1', 'same row twice');
    const driver = {
      commentSources: SOURCES,
      listComments: async (
        source: CommentSource,
        _prNumber: number,
        projectPage?: (rows: NormalizedRow[]) => NormalizedRow[],
      ) => {
        if (source.key === 'issue-comments') {
          projectPage?.([{ ...dup }]);
          projectPage?.([{ ...dup }]);
        }
        return [] as NormalizedRow[];
      },
    };
    const { items } = await buildDriverReviewTimeline(driver, 42);
    expect(items.filter(i => i.id === 'c1')).toHaveLength(1);
  });

  it('keeps the serialized payload under the hard limit including JSON framing', async () => {
    const body = 'z'.repeat(927);
    const many = Array.from({ length: 3_000 }, (_, i) => row(`x${i}`, body));
    const result = await buildDriverReviewTimeline(driverWith({
      'issue-comments': many, 'inline-comments': many, 'reviews': many,
    }), 42);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it('reports partial-source failures while keeping the successful sources', async () => {
    const { items, error } = await buildDriverReviewTimeline(driverWith({
      'issue-comments': [row('c1', 'alive')],
      'reviews': new Error('HTTP 500'),
    }), 42);
    expect(items).toHaveLength(1);
    expect(error).toContain('reviews');
  });

  it('orders edited rows by revision time so a late-added token closes the latest round', async () => {
    const pass = buildReviewTokenLine({ kind: 'pass', anchorSha: SHA, token: 'abcdef123456' });
    const { items } = await buildDriverReviewTimeline(driverWith({
      'issue-comments': [
        row('early-edited', `old comment now carrying
${pass}`, {
          createdAt: '2026-07-19T01:00:00Z', updatedAt: '2026-07-19T05:00:00Z',
        }),
        row('later-plain', 'round two feedback', { createdAt: '2026-07-19T03:00:00Z' }),
      ],
    }), 42);
    expect(items.map(i => i.id)).toEqual(['later-plain', 'early-edited']);
    expect(items[1]!.verdict).toBe('approve');
  });

  it('compares RFC3339 offsets numerically, not lexically', async () => {
    const { items } = await buildDriverReviewTimeline(driverWith({
      'issue-comments': [
        row('plus-one', 'earlier instant', { createdAt: '2026-07-19T02:00:00+01:00' }),
        row('zulu', 'later instant', { createdAt: '2026-07-19T01:30:00Z' }),
      ],
    }), 42);
    expect(items.map(i => i.id)).toEqual(['plus-one', 'zulu']);
  });

  it('trusts only an explicit parentId for reply identity, never timestamps', async () => {
    const { items } = await buildDriverReviewTimeline(driverWith({
      'inline-comments': [
        row('n2', 'reply note', { discussionId: 'D1', parentId: 'n1', createdAt: undefined, updatedAt: '2026-07-19T01:00:00Z' }),
        row('n1', 'root note', { discussionId: 'D1', createdAt: undefined, updatedAt: '2026-07-19T02:00:00Z' }),
      ],
    }), 42);
    const root = items.find(i => i.id === 'n1')!;
    const reply = items.find(i => i.id === 'n2')!;
    expect(root.inReplyTo).toBeUndefined();
    expect(reply.inReplyTo).toBe(true);
    expect(root.threadKey).toBe(reply.threadKey);
  });

  it('leaves rows of a source without a parentId mapping unmarked instead of guessing', async () => {
    const { items } = await buildDriverReviewTimeline(driverWith({
      'inline-comments': [
        row('n2', 'later-updated first', { discussionId: 'D1', updatedAt: '2026-07-19T01:00:00Z', createdAt: undefined }),
        row('n1', 'earlier-updated root', { discussionId: 'D1', updatedAt: '2026-07-19T02:00:00Z', createdAt: undefined }),
      ],
    }), 42);
    expect(items.every(i => i.inReplyTo === undefined)).toBe(true);
  });

  it('sorts a same-instant degraded verdict carrier after plain comments so it closes its own round', async () => {
    const fail = buildReviewTokenLine({ kind: 'fail', anchorSha: SHA, token: '123456abcdef' });
    const { items } = await buildDriverReviewTimeline(driverWith({
      'issue-comments': [
        row('z-verdict', `needs work\n${fail}`),
        row('a-comment', 'same second finding detail'),
      ],
    }), 42);
    expect(items.map(i => i.id)).toEqual(['a-comment', 'z-verdict']);
    expect(items[1]!.verdict).toBe('request-changes');
  });

  it('orders rows by timestamp with reviews after same-second comments', async () => {
    const { items } = await buildDriverReviewTimeline(driverWith({
      'reviews': [row('r1', 'verdict', { reviewState: 'APPROVED' })],
      'inline-comments': [row('10', 'same second inline')],
    }), 42);
    expect(items.map(i => i.kind)).toEqual(['review-comment', 'review']);
  });
});
