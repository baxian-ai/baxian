import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { CommentCursorStore, platformPollerStatePath } from '../../src/platform/comment-cursor.js';
import { bodyDigest } from '../../src/platform/body-digest.js';
import { repoIdentityKey } from '../../src/shared/git-url.js';
import type { NormalizedRow } from '../../src/platform/row-schema.js';

const REPO = 'https://github.com/owner/repo';
const T0 = Date.parse('2026-07-17T00:00:05Z');
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const comment = (id: string, body: string, atMs: number): NormalizedRow =>
  ({ id, body, createdAt: iso(atMs), updatedAt: iso(atMs) });
const FAR_CUTOFF = T0 + 3_600_000;

let dir = '';
let store: CommentCursorStore;
let path = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bx-cursor-'));
  path = platformPollerStatePath(dir, REPO);
  store = new CommentCursorStore(path, REPO);
  await store.load();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('platformPollerStatePath', () => {
  it('derives the file name from the sha256 of the repo identity key', () => {
    const expected = createHash('sha256').update(repoIdentityKey(REPO), 'utf8').digest('hex');
    expect(basename(path)).toBe(`poller-git-${expected}.json`);
    expect(path).toContain(join(dir, 'state'));
  });
});

describe('same-second boundary bucket', () => {
  it('detects a same-second edit once and never again after commit', async () => {
    const r200 = comment('200', 'first', T0);
    const first = store.classify(store.source('t1', 42, 'issue-comments'), [r200], FAR_CUTOFF);
    expect(first.fresh.map(r => r.id)).toEqual(['200']);
    await store.commitSource('t1', 42, 'issue-comments', [r200], FAR_CUTOFF);

    const r100 = comment('100', 'edited same second', T0);
    const second = store.classify(store.source('t1', 42, 'issue-comments'), [r200, r100], FAR_CUTOFF);
    expect(second.fresh.map(r => r.id)).toEqual(['100']);
    await store.commitSource('t1', 42, 'issue-comments', [r200, r100], FAR_CUTOFF);

    const third = store.classify(store.source('t1', 42, 'issue-comments'), [r200, r100], FAR_CUTOFF);
    expect(third.fresh).toEqual([]);
  });

  it('re-detects a same-second digest change even when the watermark does not move', async () => {
    const v1 = comment('100', 'body v1', T0);
    await store.commitSource('t1', 42, 'issue-comments', [v1], FAR_CUTOFF);
    const v2 = comment('100', 'body v2', T0);
    const c = store.classify(store.source('t1', 42, 'issue-comments'), [v2], FAR_CUTOFF);
    expect(c.fresh.map(r => r.id)).toEqual(['100']);
    await store.commitSource('t1', 42, 'issue-comments', [v2], FAR_CUTOFF);
    expect(store.classify(store.source('t1', 42, 'issue-comments'), [v2], FAR_CUTOFF).fresh).toEqual([]);
  });
});

describe('stable cutoff', () => {
  it('holds back rows beyond the cutoff so a lagging earlier row is not shadowed', async () => {
    const late = comment('2', 'seen first', T0 + 2000);
    const cutoff = T0 + 1000;
    const cycleN = store.classify(store.source('t1', 42, 'c'), [late], cutoff);
    expect(cycleN.fresh).toEqual([]);
    await store.commitSource('t1', 42, 'c', [], FAR_CUTOFF);

    const early = comment('1', 'lagged replica row', T0 + 500);
    const cycleN1 = store.classify(store.source('t1', 42, 'c'), [early, late], FAR_CUTOFF);
    expect(cycleN1.fresh.map(r => r.id)).toEqual(['1', '2']);
  });

  it('skips undated rows without failing the source', () => {
    const pending: NormalizedRow = { id: 'r-1', body: 'pending review' };
    const c = store.classify(store.source('t1', 42, 'reviews'), [pending, comment('5', 'x', T0)], FAR_CUTOFF);
    expect(c.fresh.map(r => r.id)).toEqual(['5']);
    expect(c.undated).toBe(1);
  });
});

describe('delivered ledger', () => {
  it('survives a reload and shields delivered rows while the watermark is held back', async () => {
    const a = comment('a1', 'delivered', T0);
    const b = comment('b1', 'failed delivery', T0);
    expect(store.classify(store.source('t1', 42, 'c'), [a, b], FAR_CUTOFF).fresh).toHaveLength(2);
    await store.markDelivered('t1', 42, 'c', 'a1', bodyDigest('delivered'));

    const reloaded = new CommentCursorStore(path, REPO);
    await reloaded.load();
    const view = reloaded.source('t1', 42, 'c');
    expect(reloaded.isDelivered(view, 'a1', bodyDigest('delivered'))).toBe(true);
    expect(reloaded.isDelivered(view, 'b1', bodyDigest('failed delivery'))).toBe(false);
    expect(reloaded.classify(view, [a, b], FAR_CUTOFF).fresh).toHaveLength(2);

    await reloaded.markDelivered('t1', 42, 'c', 'b1', bodyDigest('failed delivery'));
    await reloaded.commitSource('t1', 42, 'c', [a, b], FAR_CUTOFF);
    const committed = reloaded.source('t1', 42, 'c');
    expect(committed.ledger).toEqual({});
    expect(reloaded.classify(committed, [a, b], FAR_CUTOFF).fresh).toEqual([]);
  });
});

describe('generations and cross-source independence', () => {
  it('keeps watermarks independent per task generation and per source', async () => {
    const rowA = comment('1', 'x', T0);
    await store.commitSource('task-a', 42, 'issue-comments', [rowA], FAR_CUTOFF);
    expect(store.classify(store.source('task-b', 42, 'issue-comments'), [rowA], FAR_CUTOFF).fresh).toHaveLength(1);
    expect(store.classify(store.source('task-a', 42, 'reviews'), [rowA], FAR_CUTOFF).fresh).toHaveLength(1);
  });

  it('dropGeneration resets the namespace durably', async () => {
    await store.commitSource('task-a', 42, 'c', [comment('1', 'x', T0)], FAR_CUTOFF);
    expect(store.generations()).toEqual(['task-a']);
    await store.dropGeneration('task-a');
    expect(store.generations()).toEqual([]);
    const reloaded = new CommentCursorStore(path, REPO);
    await reloaded.load();
    expect(reloaded.classify(reloaded.source('task-a', 42, 'c'), [comment('1', 'x', T0)], FAR_CUTOFF).fresh).toHaveLength(1);
  });

  it('persists PR adoption delivery and drops it with the task generation', async () => {
    await store.markAdoptionDelivered('task-a', 42);
    const reloaded = new CommentCursorStore(path, REPO);
    await reloaded.load();
    expect(reloaded.isAdoptionDelivered('task-a', 42)).toBe(true);
    expect(reloaded.generations()).toContain('task-a');
    await reloaded.dropGeneration('task-a');
    expect(reloaded.isAdoptionDelivered('task-a', 42)).toBe(false);
  });

  it('persists pending adoption work and clears it on delivery or generation cleanup', async () => {
    await store.markAdoptionPending('task-a', 42);
    const reloaded = new CommentCursorStore(path, REPO);
    await reloaded.load();
    expect(reloaded.pendingAdoptions()).toEqual([{ taskId: 'task-a', prNumber: 42 }]);
    expect(reloaded.isAdoptionPending('task-a', 42)).toBe(true);

    await reloaded.markAdoptionDelivered('task-a', 42);
    expect(reloaded.isAdoptionPending('task-a', 42)).toBe(false);
    await reloaded.markAdoptionPending('task-b', 43);
    await reloaded.dropGeneration('task-b');
    expect(reloaded.pendingAdoptions()).toEqual([]);
  });

  it('clears only the matching pending adoption generation', async () => {
    await store.markAdoptionPending('task-a', 42);
    await store.clearAdoptionPending('task-a', 43);
    expect(store.isAdoptionPending('task-a', 42)).toBe(true);

    await store.clearAdoptionPending('task-a', 42);
    const reloaded = new CommentCursorStore(path, REPO);
    await reloaded.load();
    expect(reloaded.isAdoptionPending('task-a', 42)).toBe(false);
  });
});

describe('listPrs cursor', () => {
  it('round-trips the watermark', async () => {
    expect(store.listPrsCursor()).toEqual({ watermarkTime: null });
    await store.commitListPrs([comment('42', 'seed', T0)], FAR_CUTOFF);
    const reloaded = new CommentCursorStore(path, REPO);
    await reloaded.load();
    expect(reloaded.listPrsCursor()).toEqual({ watermarkTime: T0 });
  });
});

describe('state file integrity', () => {
  it('starts fresh on ENOENT and refuses corrupted or mismatched files', async () => {
    const corrupt = new CommentCursorStore(join(dir, 'state', 'poller-git-x.json'), REPO);
    await mkdir(join(dir, 'state'), { recursive: true });
    await writeFile(join(dir, 'state', 'poller-git-x.json'), '{not json');
    await expect(corrupt.load()).rejects.toThrow();

    await store.commitListPrs([comment('42', 'seed', T0)], FAR_CUTOFF);
    const raw = JSON.parse(await readFile(path, 'utf8')) as { repoUrl: string };
    expect(raw.repoUrl).toBe(REPO);
    const mismatched = new CommentCursorStore(path, 'https://github.com/other/repo');
    await expect(mismatched.load()).rejects.toThrow(/repo mismatch/);
  });

  it('accepts spelling variants of the same repo identity', async () => {
    await store.commitListPrs([comment('42', 'seed', T0)], FAR_CUTOFF);
    for (const variant of ['git@github.com:owner/repo.git', 'https://github.com/owner/repo.git']) {
      const sibling = new CommentCursorStore(path, variant);
      await sibling.load();
      expect(sibling.listPrsCursor()).toEqual({ watermarkTime: T0 });
    }
  });
});

describe('source key pruning', () => {
  it('drops cursors for source keys the driver no longer declares, durably', async () => {
    await store.commitSource('t1', 42, 'kept', [comment('1', 'x', T0)], FAR_CUTOFF);
    await store.commitSource('t1', 42, 'removed', [comment('2', 'y', T0)], FAR_CUTOFF);
    await store.pruneSources(new Set(['kept']));
    const reloaded = new CommentCursorStore(path, REPO);
    await reloaded.load();
    expect(reloaded.source('t1', 42, 'kept').watermarkTime).not.toBe(null);
    expect(reloaded.source('t1', 42, 'removed').watermarkTime).toBe(null);
    expect(reloaded.classify(reloaded.source('t1', 42, 'removed'), [comment('2', 'y', T0)], FAR_CUTOFF).fresh).toHaveLength(1);
  });

  it('is a no-op when every stored key is still declared', async () => {
    await store.commitSource('t1', 42, 'kept', [comment('1', 'x', T0)], FAR_CUTOFF);
    await store.pruneSources(new Set(['kept', 'other']));
    expect(store.source('t1', 42, 'kept').watermarkTime).not.toBe(null);
  });
});

describe('state file structural validation', () => {
  const writeState = async (state: unknown) => {
    await mkdir(join(dir, 'state'), { recursive: true });
    await writeFile(path, JSON.stringify(state));
    const fresh = new CommentCursorStore(path, REPO);
    return fresh.load();
  };
  const VALID = {
    version: 3, repoUrl: REPO,
    listPrs: { watermarkTime: T0 },
    adoptions: { t1: 42 },
    pendingAdoptions: { t2: 43 },
    generations: { t1: { '42': { c: { watermarkTime: T0, bucket: { '1': 'a'.repeat(64) }, ledger: {} } } } },
  };

  it('accepts a well-formed file', async () => {
    await writeState(VALID);
  });

  it('rejects wrong versions and structurally corrupt fields', async () => {
    await expect(writeState({ ...VALID, version: 2 })).rejects.toThrow(/version/);
    await expect(writeState({ ...VALID, listPrs: { watermarkTime: '999' } })).rejects.toThrow(/structure/);
    await expect(writeState({ ...VALID, listPrs: 42 })).rejects.toThrow(/structure/);
    await expect(writeState({ ...VALID, adoptions: { t1: 0 } })).rejects.toThrow(/structure/);
    await expect(writeState({ ...VALID, pendingAdoptions: { t2: 0 } })).rejects.toThrow(/structure/);
    await expect(writeState({
      ...VALID,
      generations: { t1: { '42': { c: { watermarkTime: 'soon', bucket: {}, ledger: {} } } } },
    })).rejects.toThrow(/structure/);
    await expect(writeState({
      ...VALID,
      generations: { t1: { '42': { c: { watermarkTime: null, bucket: { '1': 7 }, ledger: {} } } } },
    })).rejects.toThrow(/structure/);
  });

  it('rejects finite watermarks outside the Date range and non-digest bucket/ledger values', async () => {
    await expect(writeState({ ...VALID, listPrs: { watermarkTime: 1e300 } })).rejects.toThrow(/structure/);
    await expect(writeState({
      ...VALID,
      generations: { t1: { '42': { c: { watermarkTime: 1e300, bucket: {}, ledger: {} } } } },
    })).rejects.toThrow(/structure/);
    await expect(writeState({
      ...VALID,
      generations: { t1: { '42': { c: { watermarkTime: T0, bucket: { '1': 'abcd' }, ledger: {} } } } },
    })).rejects.toThrow(/structure/);
    await expect(writeState({
      ...VALID,
      generations: { t1: { '42': { c: { watermarkTime: T0, bucket: {}, ledger: { '1': 'A'.repeat(64) } } } } },
    })).rejects.toThrow(/structure/);
  });

  it('flushIfDirty re-writes state after a failed persist once the filesystem recovers', async () => {
    await store.commitListPrs([comment('42', 'seed', T0)], FAR_CUTOFF);
    const stateDir = join(dir, 'state');
    await rm(stateDir, { recursive: true, force: true });
    await writeFile(stateDir, 'blocking regular file');
    await expect(store.commitListPrs([comment('42', 'seed', T0 + 1000)], FAR_CUTOFF)).rejects.toThrow();

    await rm(stateDir);
    await store.flushIfDirty();
    const reloaded = new CommentCursorStore(path, REPO);
    await reloaded.load();
    expect(reloaded.listPrsCursor()).toEqual({ watermarkTime: T0 + 1000 });
    await store.flushIfDirty();
  });

  it('keeps prototype-named protocol keys off shared prototypes', async () => {
    const fresh = new CommentCursorStore(path, REPO);
    await fresh.commitSource('t1', 42, 'constructor', [comment('__proto__', 'x', T0)], FAR_CUTOFF);
    await fresh.markDelivered('t1', 42, 'constructor', '__proto__', 'b'.repeat(64));
    const view = fresh.source('t1', 42, 'constructor');
    expect(view.watermarkTime).toBe(T0);
    expect(view.bucket['__proto__']).toBe(bodyDigest('x'));
    expect(fresh.isDelivered(view, '__proto__', 'b'.repeat(64))).toBe(true);
    expect((Object as unknown as Record<string, unknown>).watermarkTime).toBeUndefined();
    expect(({} as Record<string, unknown>).watermarkTime).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);

    const reloaded = new CommentCursorStore(path, REPO);
    await reloaded.load();
    const persisted = reloaded.source('t1', 42, 'constructor');
    expect(persisted.bucket['__proto__']).toBe(bodyDigest('x'));
    expect(reloaded.classify(persisted, [comment('__proto__', 'x', T0)], FAR_CUTOFF).fresh).toHaveLength(0);
  });
});
