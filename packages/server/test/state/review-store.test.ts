import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ReviewStore,
  reviewFindingsDigest,
  serverResponseFailureSignature,
  sha256Hex,
} from '../../src/state/review-store.js';
import type { ReviewFindings, ReviewRound, ServerResponseFailure } from '../../src/shared/index.js';

function round(overrides: Partial<ReviewRound> = {}): ReviewRound {
  return {
    round: 1,
    phase: 'code',
    content: 'diff --git a/x b/x',
    startedAt: '2026-06-10T00:00:00.000Z',
    ...overrides,
  };
}

function specRound(roundNumber = 1, content = 'SPEC'): ReviewRound {
  return {
    round: roundNumber,
    phase: 'spec',
    content,
    documents: [{ relPath: '.baxian/spec.md', content }],
    startedAt: '2026-06-10T00:00:00.000Z',
  };
}

const FINDINGS: ReviewFindings = {
  round: 1,
  verdict: 'request-changes',
  findings: [
    { id: 'f-2', severity: 'major', message: 'second' },
    { id: 'f-1', severity: 'major', message: 'first' },
  ],
};

function failure(
  sourceToken: string,
  failureSignature: string,
  overrides: Partial<Omit<ServerResponseFailure, 'disposition'>> = {},
): Omit<ServerResponseFailure, 'disposition'> {
  return {
    signalKind: 'code-fixed',
    sourceToken,
    successorToken: `${sourceToken.slice(0, 11)}f`,
    failureSignature,
    reason: 'coverage-gap',
    missingFindingIds: ['f-1'],
    unknownFindingIds: [],
    schemaViolationCodes: [],
    createdAt: '2026-06-10T00:01:00.000Z',
    ...overrides,
  };
}

describe.each([
  { label: 'disk', useDir: true },
  { label: 'memory', useDir: false },
])('ReviewStore ($label)', ({ useDir }) => {
  let dir: string | undefined;
  let store: ReviewStore;

  beforeEach(async () => {
    dir = useDir ? await mkdtemp(join(tmpdir(), 'baxian-review-')) : undefined;
    store = new ReviewStore(dir);
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a round per phase', async () => {
    await store.putRound('t1', 'code', round());
    const got = await store.getRound('t1', 'code', 1);
    expect(got?.content).toBe('diff --git a/x b/x');
  });

  it('same round number in spec vs code does not collide', async () => {
    await store.putRound('t1', 'spec', specRound());
    await store.putRound('t1', 'code', round({ phase: 'code', content: 'CODE' }));
    expect((await store.getRound('t1', 'spec', 1))?.content).toBe('SPEC');
    expect((await store.getRound('t1', 'code', 1))?.content).toBe('CODE');
  });

  it('getRound returns null for missing data', async () => {
    expect(await store.getRound('t1', 'code', 9)).toBeNull();
  });

  it('putRound overwrites the same round', async () => {
    await store.putRound('t1', 'code', round());
    await store.putRound('t1', 'code', round({ content: 'v2', completedAt: '2026-06-10T01:00:00.000Z' }));
    const got = await store.getRound('t1', 'code', 1);
    expect(got?.content).toBe('v2');
    expect(got?.completedAt).toBe('2026-06-10T01:00:00.000Z');
  });

  it('listRounds filters by phase and sorts by round', async () => {
    await store.putRound('t1', 'code', round({ round: 2 }));
    await store.putRound('t1', 'code', round({ round: 1 }));
    await store.putRound('t1', 'spec', specRound());
    const codeRounds = await store.listRounds('t1', 'code');
    expect(codeRounds.map(r => r.round)).toEqual([1, 2]);
    expect(codeRounds.every(r => r.phase === 'code')).toBe(true);
  });

  it('listRounds without phase merges spec first then code', async () => {
    await store.putRound('t1', 'code', round({ round: 1 }));
    await store.putRound('t1', 'spec', specRound(2));
    await store.putRound('t1', 'spec', specRound(1));
    const all = await store.listRounds('t1');
    expect(all.map(r => `${r.phase}-${r.round}`)).toEqual(['spec-1', 'spec-2', 'code-1']);
  });

  it('listRounds returns [] for unknown task', async () => {
    expect(await store.listRounds('nope')).toEqual([]);
  });

  it('clear removes all rounds for the task only', async () => {
    await store.putRound('t1', 'code', round());
    await store.putRound('t2', 'code', round());
    await store.clear('t1');
    expect(await store.getRound('t1', 'code', 1)).toBeNull();
    expect((await store.getRound('t2', 'code', 1))?.content).toBeTruthy();
  });

  it('round-trips structured spec documents in deterministic order', async () => {
    const documents = [
      { relPath: '.baxian/spec.md', content: '# Spec' },
      { relPath: '.baxian/research/options.md', content: '# Options' },
    ];
    const content = '=== .baxian/spec.md ===\n# Spec\n=== .baxian/research/options.md ===\n# Options';
    await store.putRound('t1', 'spec', { ...specRound(), content, documents });

    expect(await store.getRound('t1', 'spec', 1)).toMatchObject({ content, documents });
  });

  it('rejects a spec round whose rendered content diverges from its documents', async () => {
    await expect(store.putRound('t1', 'spec', {
      ...specRound(),
      content: 'tampered',
    })).rejects.toThrow('does not match documents');
  });

  it('digests the exact persisted aggregate findings JSON bytes', async () => {
    await store.putRound('t1', 'code', round({ findings: FINDINGS }));
    const persisted = (await store.getRound('t1', 'code', 1))!.findings!;
    expect(reviewFindingsDigest(persisted)).toBe(sha256Hex(JSON.stringify(persisted)));
    expect(reviewFindingsDigest(persisted)).not.toBe(
      reviewFindingsDigest({ ...persisted, findings: [...persisted.findings].reverse() }),
    );
  });

  it('uses a stable logical signature independent of raw response presentation', () => {
    const digest = reviewFindingsDigest(FINDINGS);
    const first = serverResponseFailureSignature({
      phase: 'code', round: 1, findingsDigest: digest, reason: 'coverage-gap',
      missingFindingIds: ['f-2', 'f-1'], unknownFindingIds: ['old-2', 'old-1'],
    });
    const rewritten = serverResponseFailureSignature({
      phase: 'code', round: 1, findingsDigest: digest, reason: 'coverage-gap',
      missingFindingIds: ['f-1', 'f-2'], unknownFindingIds: ['old-1', 'old-2'],
    });
    expect(rewritten).toBe(first);
  });

  it('archives exact raw responses idempotently and stops a repeated logical failure', async () => {
    await store.putRound('t1', 'code', round({ findings: FINDINGS }));
    const signature = serverResponseFailureSignature({
      phase: 'code', round: 1, findingsDigest: reviewFindingsDigest(FINDINGS), reason: 'coverage-gap',
      missingFindingIds: ['f-1'],
    });
    const raw = '{\n  "round": 1, "responses": []\n}\n';
    const first = await store.recordServerResponseFailure('t1', 'code', 1, failure(
      '000000000001', signature, { rawResponse: raw, responseDigest: sha256Hex(raw) },
    ));
    const duplicateDelivery = await store.recordServerResponseFailure('t1', 'code', 1, failure(
      '000000000001', 'f'.repeat(64), { rawResponse: 'changed after retry' },
    ));
    const rewritten = await store.recordServerResponseFailure('t1', 'code', 1, failure(
      '000000000002', signature, { rawResponse: '{"responses":[]}', responseDigest: sha256Hex('{"responses":[]}') },
    ));

    expect(first.disposition).toBe('auto-correct');
    expect(first.rawResponse).toBe(raw);
    expect(duplicateDelivery).toEqual(first);
    expect(rewritten.disposition).toBe('hold-repeated-signature');
    expect((await store.getRound('t1', 'code', 1))?.serverResponseFailures).toHaveLength(2);
  });

  it.each([
    ['phase-mismatched signal kind', { signalKind: 'spec-fixed' }],
    ['unknown failure reason', { reason: 'handler-failed' }],
    ['reused successor token', { sourceToken: '00000000000f', successorToken: '00000000000f' }],
  ])('rejects %s in persisted response-failure audit data', async (_label, override) => {
    const signature = serverResponseFailureSignature({
      phase: 'code',
      round: 1,
      findingsDigest: reviewFindingsDigest(FINDINGS),
      reason: 'coverage-gap',
      missingFindingIds: ['f-1'],
    });
    await expect(store.putRound('t1', 'code', round({
      findings: FINDINGS,
      serverResponseFailures: [{
        ...failure('000000000001', signature),
        disposition: 'auto-correct',
        ...override,
      } as ServerResponseFailure],
    }))).rejects.toThrow();
  });

  it('allows at most three distinct automatic corrections under concurrent writes', async () => {
    await store.putRound('t1', 'code', round({ findings: FINDINGS }));
    const digest = reviewFindingsDigest(FINDINGS);
    const entries = await Promise.all(Array.from({ length: 4 }, (_, index) => {
      const missingFindingIds = [`f-${index + 10}`];
      const signature = serverResponseFailureSignature({
        phase: 'code', round: 1, findingsDigest: digest, reason: 'coverage-gap', missingFindingIds,
      });
      return store.recordServerResponseFailure('t1', 'code', 1, failure(
        `00000000000${index + 1}`,
        signature,
        { missingFindingIds },
      ));
    }));

    expect(entries.filter(entry => entry.disposition === 'auto-correct')).toHaveLength(3);
    expect(entries.filter(entry => entry.disposition === 'hold-correction-limit')).toHaveLength(1);
    expect((await store.getRound('t1', 'code', 1))?.serverResponseFailures).toHaveLength(4);
  });
});

describe('ReviewStore (disk only)', () => {
  it('corrupted JSON surfaces as an error, not null', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'baxian-review-'));
    try {
      const store = new ReviewStore(dir);
      await mkdir(join(dir, 't1', 'code'), { recursive: true });
      await writeFile(join(dir, 't1', 'code', 'round-1.json'), '{not json');
      await expect(store.getRound('t1', 'code', 1)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
