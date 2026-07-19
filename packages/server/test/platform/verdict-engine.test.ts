import { describe, it, expect } from 'vitest';
import { VerdictEngine, type VerdictSourceScan } from '../../src/platform/verdict-engine.js';
import { buildReviewTokenLine } from '../../src/platform/markers.js';
import { bodyDigest } from '../../src/platform/body-digest.js';
import type { NormalizedRow } from '../../src/platform/row-schema.js';

const ANCHOR = 'c'.repeat(40);
const PASS = 'aaaaaaaaaaaa';
const FAIL = 'bbbbbbbbbbbb';
const NOW = Date.parse('2026-07-17T12:00:00Z');
const LAG_MS = 5000;
const OLD = '2026-07-17T11:58:00Z';
const FRESH = '2026-07-17T11:59:59Z';

const passLine = buildReviewTokenLine({ kind: 'pass', anchorSha: ANCHOR, token: PASS });
const failLine = buildReviewTokenLine({ kind: 'fail', anchorSha: ANCHOR, token: FAIL });

const row = (id: string, body: string, t: string = OLD, extra: Record<string, unknown> = {}): NormalizedRow =>
  ({ id, body, createdAt: t, updatedAt: t, ...extra });
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

const scan = (
  key: string, sourceClass: 'reviews' | 'threaded' | 'top-level', rows: NormalizedRow[],
  over: Partial<VerdictSourceScan> = {},
): VerdictSourceScan => ({ key, sourceClass, ok: true, scanStartedAt: NOW, rows, ...over });

const input = (sources: VerdictSourceScan[], over: Record<string, unknown> = {}) => ({
  taskId: 'task-1', prNumber: 42, anchorSha: ANCHOR,
  pair: { passToken: PASS, failToken: FAIL },
  sources, visibilityLagMs: LAG_MS, ...over,
});

describe('VerdictEngine: fail decisions', () => {
  it('produces fail on the first full-source-success cycle from any carrier', () => {
    for (const cls of ['top-level', 'threaded', 'reviews'] as const) {
      const engine = new VerdictEngine();
      const d = engine.evaluate(input([scan('src', cls, [row('1', `findings\n${failLine}`)])]));
      expect(d).toMatchObject({ kind: 'fail', token: FAIL, anchorSha: ANCHOR, conflict: false });
      expect(d!.carrier).toEqual({ sourceKey: 'src', id: '1', bodyDigest: bodyDigest(`findings\n${failLine}`) });
    }
  });

  it('prefers fail over pass regardless of timing, carrier, or injection order', () => {
    const engine = new VerdictEngine();
    const d = engine.evaluate(input([
      scan('issue-comments', 'top-level', [row('2', `replayed\n${passLine}`, FRESH)]),
      scan('reviews', 'reviews', [row('1', `nope\n${failLine}`, OLD)]),
    ]));
    expect(d).toMatchObject({ kind: 'fail', conflict: true });
  });

  it('does not decide while any source scan failed, then lets the late fail win', () => {
    const engine = new VerdictEngine();
    const withFailedSource = input([
      scan('issue-comments', 'top-level', [row('2', `old pass\n${passLine}`)]),
      scan('reviews', 'reviews', [], { ok: false }),
    ]);
    expect(engine.evaluate(withFailedSource)).toBe(undefined);
    const d = engine.evaluate(input([
      scan('issue-comments', 'top-level', [row('2', `old pass\n${passLine}`)], { scanStartedAt: NOW + 30_000 }),
      scan('reviews', 'reviews', [row('9', `newer\n${failLine}`)], { scanStartedAt: NOW + 30_000 }),
    ]));
    expect(d).toMatchObject({ kind: 'fail' });
  });
});

describe('VerdictEngine: pass confirmation cycle', () => {
  it('holds a below-fence pass one cycle and confirms on the next full-source success', () => {
    const engine = new VerdictEngine();
    const cycle1 = input([scan('reviews', 'reviews', [row('1', `LGTM\n${passLine}`, OLD)])]);
    expect(engine.evaluate(cycle1)).toBe(undefined);
    const cycle2 = input([scan('reviews', 'reviews', [row('1', `LGTM\n${passLine}`, OLD)], { scanStartedAt: NOW + 30_000 })]);
    const d = engine.evaluate(cycle2);
    expect(d).toMatchObject({ kind: 'pass', token: PASS, conflict: false });
    expect(d!.submittedAt).toBe(OLD);
  });

  it('does not candidate a pass whose versionTime is inside the visibility window', () => {
    const engine = new VerdictEngine();
    const fresh = input([scan('reviews', 'reviews', [row('1', `LGTM\n${passLine}`, FRESH)])]);
    expect(engine.evaluate(fresh)).toBe(undefined);
    const later = input([scan('reviews', 'reviews', [row('1', `LGTM\n${passLine}`, FRESH)], { scanStartedAt: NOW + 30_000 })]);
    expect(engine.evaluate(later)).toBe(undefined);
    const confirm = input([scan('reviews', 'reviews', [row('1', `LGTM\n${passLine}`, FRESH)], { scanStartedAt: NOW + 60_000 })]);
    expect(engine.evaluate(confirm)).toMatchObject({ kind: 'pass' });
  });

  it('converts to fail when a lagging fail surfaces during the confirmation cycle', () => {
    const engine = new VerdictEngine();
    expect(engine.evaluate(input([
      scan('reviews', 'reviews', [row('1', `LGTM\n${passLine}`, OLD)]),
      scan('issue-comments', 'top-level', []),
    ]))).toBe(undefined);
    const d = engine.evaluate(input([
      scan('reviews', 'reviews', [row('1', `LGTM\n${passLine}`, OLD)], { scanStartedAt: NOW + 30_000 }),
      scan('issue-comments', 'top-level', [row('7', `correction\n${failLine}`, OLD)], { scanStartedAt: NOW + 30_000 }),
    ]));
    expect(d).toMatchObject({ kind: 'fail', conflict: true });
  });

  it('is invariant to source declaration order', () => {
    const rows = [
      scan('a', 'top-level', [row('1', `LGTM\n${passLine}`, OLD)]),
      scan('b', 'reviews', [row('2', 'chatter', OLD)]),
    ];
    const e1 = new VerdictEngine();
    const e2 = new VerdictEngine();
    e1.evaluate(input(rows));
    e2.evaluate(input([...rows].reverse()));
    const d1 = e1.evaluate(input(rows.map(s => ({ ...s, scanStartedAt: NOW + 30_000 }))));
    const d2 = e2.evaluate(input([...rows].reverse().map(s => ({ ...s, scanStartedAt: NOW + 30_000 }))));
    expect(d1).toMatchObject({ kind: 'pass' });
    expect(d2).toMatchObject({ kind: 'pass' });
  });

  it('yields a correcting fail after a pass was already produced', () => {
    const engine = new VerdictEngine();
    engine.evaluate(input([scan('reviews', 'reviews', [row('1', `LGTM\n${passLine}`, OLD)])]));
    engine.evaluate(input([scan('reviews', 'reviews', [row('1', `LGTM\n${passLine}`, OLD)], { scanStartedAt: NOW + 30_000 })]));
    const d = engine.evaluate(input([scan('reviews', 'reviews', [
      row('1', `LGTM\n${passLine}`, OLD),
      row('2', `revoke\n${failLine}`, FRESH),
    ], { scanStartedAt: NOW + 60_000 })]));
    expect(d).toMatchObject({ kind: 'fail', conflict: true });
  });

  it('drops a stale candidate when the pass marker disappears', () => {
    const engine = new VerdictEngine();
    engine.evaluate(input([scan('reviews', 'reviews', [row('1', `LGTM\n${passLine}`, OLD)])]));
    engine.evaluate(input([scan('reviews', 'reviews', [row('1', 'edited away', OLD)], { scanStartedAt: NOW + 30_000 })]));
    const d = engine.evaluate(input([scan('reviews', 'reviews', [row('1', `LGTM\n${passLine}`, OLD)], { scanStartedAt: NOW + 60_000 })]));
    expect(d).toBe(undefined);
  });
});

describe('VerdictEngine: token hygiene', () => {
  it('ignores the legacy single-token format and anchor mismatches', () => {
    const engine = new VerdictEngine();
    expect(engine.evaluate(input([scan('s', 'top-level', [
      row('1', '<!-- baxian:pr-approved:deadbeef1234 -->'),
      row('2', buildReviewTokenLine({ kind: 'pass', anchorSha: 'd'.repeat(40), token: PASS })),
    ])]))).toBe(undefined);
  });

  it('ignores tokens from a rotated-out pair so a no-code recheck can pass', () => {
    const engine = new VerdictEngine();
    const oldFail = buildReviewTokenLine({ kind: 'fail', anchorSha: ANCHOR, token: 'dddddddddddd' });
    engine.evaluate(input([scan('s', 'top-level', [row('1', oldFail), row('2', `LGTM\n${passLine}`, OLD)])]));
    const d = engine.evaluate(input([
      scan('s', 'top-level', [row('1', oldFail), row('2', `LGTM\n${passLine}`, OLD)], { scanStartedAt: NOW + 30_000 }),
    ]));
    expect(d).toMatchObject({ kind: 'pass' });
  });

  it('kills a dismissed token on every carrier, not just the dismissed row', () => {
    const engine = new VerdictEngine();
    const sources = [
      scan('reviews', 'reviews', [row('1', `LGTM\n${passLine}`, OLD, { reviewState: 'DISMISSED' })]),
      scan('issue-comments', 'top-level', [row('2', `copied\n${passLine}`, OLD)]),
    ];
    expect(engine.evaluate(input(sources))).toBe(undefined);
    expect(engine.evaluate(input(sources.map(s => ({ ...s, scanStartedAt: NOW + 30_000 }))))).toBe(undefined);
  });
});

describe('VerdictEngine: pass provenance recheck', () => {
  const record = () => ({
    token: PASS, failToken: FAIL, anchorSha: ANCHOR,
    carrier: { sourceKey: 'reviews', id: '1', bodyDigest: bodyDigest(`LGTM\n${passLine}`) },
  });
  const engine = new VerdictEngine();

  it('passes when the carrier is intact, undismissed, and no fail exists', () => {
    expect(engine.recheckPassProvenance(record(), [
      scan('reviews', 'reviews', [row('1', `LGTM\n${passLine}`)]),
      scan('issue-comments', 'top-level', []),
    ])).toEqual({ ok: true });
  });

  it('fails on edited body, missing row, dismissal, cross-carrier dismissal, late fail, or failed scans', () => {
    const cases: Array<[VerdictSourceScan[], string]> = [
      [[scan('reviews', 'reviews', [row('1', `edited\n${passLine}`)])], 'carrier-body-edited'],
      [[scan('reviews', 'reviews', [])], 'carrier-row-missing'],
      [[scan('reviews', 'reviews', [row('1', `LGTM\n${passLine}`, OLD, { reviewState: 'DISMISSED' })])], 'token-dismissed'],
      [[
        scan('reviews', 'reviews', [
          row('1', `LGTM\n${passLine}`),
          row('3', `dup\n${passLine}`, OLD, { reviewState: 'DISMISSED' }),
        ]),
      ], 'token-dismissed'],
      [[scan('reviews', 'reviews', [row('1', `LGTM\n${passLine}`), row('4', `stop\n${failLine}`, FRESH)])], 'fail-token-present'],
      [[scan('reviews', 'reviews', [row('1', `LGTM\n${passLine}`)], { ok: false })], 'source-scan-incomplete'],
    ];
    for (const [sources, reason] of cases) {
      expect(engine.recheckPassProvenance(record(), sources)).toEqual({ ok: false, reason });
    }
  });
});

describe('VerdictEngine: at-least-once pass delivery', () => {
  it('keeps re-producing a confirmed pass so a failed delivery retries next cycle', () => {
    const engine = new VerdictEngine();
    const at = (t: number) => input([scan('reviews', 'reviews', [row('1', `LGTM\n${passLine}`, OLD)], { scanStartedAt: t })]);
    expect(engine.evaluate(at(NOW))).toBe(undefined);
    expect(engine.evaluate(at(NOW + 30_000))).toMatchObject({ kind: 'pass' });
    expect(engine.evaluate(at(NOW + 60_000))).toMatchObject({ kind: 'pass' });
  });
});

describe('VerdictEngine: unpublished and system rows are not protocol carriers', () => {
  it('ignores undated rows for both directions until they gain a timestamp', () => {
    const engine = new VerdictEngine();
    const pending: NormalizedRow = { id: '1', body: `draft findings\n${failLine}`, reviewState: 'PENDING' };
    expect(engine.evaluate(input([scan('reviews', 'reviews', [pending])]))).toBe(undefined);
    const submitted = engine.evaluate(input([scan('reviews', 'reviews', [row('1', `draft findings\n${failLine}`, OLD)])]));
    expect(submitted).toMatchObject({ kind: 'fail' });
  });

  it('ignores system rows even when they carry the current fail token', () => {
    const engine = new VerdictEngine();
    const sys = row('1', `pipeline note\n${failLine}`, OLD, { system: true });
    expect(engine.evaluate(input([scan('src', 'threaded', [sys])]))).toBe(undefined);
  });

  it('rejects undated rows as provenance carriers', () => {
    const engine = new VerdictEngine();
    const record = { token: PASS, failToken: FAIL, anchorSha: ANCHOR, carrier: { sourceKey: 'reviews', id: '1', bodyDigest: bodyDigest(`LGTM\n${passLine}`) } };
    const undatedFail = { id: '9', body: `late\n${failLine}` };
    const sources = [scan('reviews', 'reviews', [row('1', `LGTM\n${passLine}`), undatedFail])];
    expect(engine.recheckPassProvenance(record, sources)).toEqual({ ok: true });
  });
});

describe('VerdictEngine: candidate stability', () => {
  it('restarts confirmation when the pass carrier re-enters the visibility fence', () => {
    const engine = new VerdictEngine();
    const stable = (t: number) => input([scan('reviews', 'reviews', [row('1', `LGTM\n${passLine}`, OLD)], { scanStartedAt: t })]);
    const unstable = (t: number) => input([scan('reviews', 'reviews', [row('1', `LGTM edited\n${passLine}`, iso(t))], { scanStartedAt: t })]);
    expect(engine.evaluate(stable(NOW))).toBe(undefined);
    expect(engine.evaluate(unstable(NOW + 30_000))).toBe(undefined);
    expect(engine.evaluate(stable(NOW + 60_000))).toBe(undefined);
    expect(engine.evaluate(stable(NOW + 90_000))).toMatchObject({ kind: 'pass' });
  });

  it('dropCandidate forces a fresh two-cycle confirmation', () => {
    const engine = new VerdictEngine();
    const at = (t: number) => input([scan('reviews', 'reviews', [row('1', `LGTM\n${passLine}`, OLD)], { scanStartedAt: t })]);
    expect(engine.evaluate(at(NOW))).toBe(undefined);
    engine.dropCandidate('task-1', 42);
    expect(engine.evaluate(at(NOW + 30_000))).toBe(undefined);
    expect(engine.evaluate(at(NOW + 60_000))).toMatchObject({ kind: 'pass' });
  });
});
