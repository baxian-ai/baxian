import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReviewStore } from '../../src/state/review-store.js';
import type { ReviewRound } from '../../src/shared/index.js';

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
