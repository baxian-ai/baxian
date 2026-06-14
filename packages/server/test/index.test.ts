import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  migrateLegacyPollerStateFile,
  pickExistingPath,
} from '../src/index.js';
import { readFile, writeFile, access } from 'node:fs/promises';

let tempDir: string;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let warns: string[];
let errors: unknown[][];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-startup-test-'));
  warns = [];
  errors = [];
  warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warns.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  });
  errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
});

afterEach(async () => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  await rm(tempDir, { recursive: true });
});


describe('migrateLegacyPollerStateFile', () => {
  let stateRoot: string;
  beforeEach(async () => {
    stateRoot = join(tempDir, 'state');
    await mkdir(stateRoot, { recursive: true });
  });

  it('renames a legacy `poller-${projectId}.json` to the new repo-keyed path', async () => {
    const legacy = join(stateRoot, 'poller-proj-a.json');
    const target = join(stateRoot, 'poller-owner%2Frepo.json');
    await writeFile(legacy, JSON.stringify({ pullsByHead: { 'bx/x': 'sha' } }));

    await migrateLegacyPollerStateFile(tempDir, ['proj-a'], target);

    await expect(readFile(target, 'utf-8')).resolves.toContain('bx/x');
    await expect(access(legacy)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the existing new-style file and does not clobber it when both exist', async () => {
    const legacy = join(stateRoot, 'poller-proj-b.json');
    const target = join(stateRoot, 'poller-owner%2Frepo2.json');
    await writeFile(legacy, JSON.stringify({ legacy: true }));
    await writeFile(target, JSON.stringify({ current: true }));

    await migrateLegacyPollerStateFile(tempDir, ['proj-b'], target);

    // Target unchanged; legacy NOT renamed away (so a manual cleanup path stays explicit).
    await expect(readFile(target, 'utf-8')).resolves.toContain('"current":true');
    await expect(readFile(legacy, 'utf-8')).resolves.toContain('"legacy":true');
  });

  it('is a silent no-op when no candidate legacy files exist (steady-state boot)', async () => {
    const target = join(stateRoot, 'poller-owner%2Frepo3.json');
    await expect(
      migrateLegacyPollerStateFile(tempDir, ['no-such-project'], target),
    ).resolves.toBeUndefined();
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('picks the first candidate that has a legacy file (shared-repo migration covers all duplicate projects)', async () => {
    // Operator added project `x` ahead of original `a` between deploys.
    // The legacy cursor lives under `poller-a.json`; dedupe now picks
    // `x` as the attribution project, but the migration must still find
    // and rename the file from `a`.
    const legacyForA = join(stateRoot, 'poller-a.json');
    await writeFile(legacyForA, JSON.stringify({ pullsByHead: { 'bx/old': 'sha-old' } }));
    const target = join(stateRoot, 'poller-shared%2Frepo.json');

    // Candidate list mirrors `config.project` declaration order for that repo:
    // newly-added `x` first, then `a`.
    await migrateLegacyPollerStateFile(tempDir, ['x', 'a'], target);

    await expect(readFile(target, 'utf-8')).resolves.toContain('sha-old');
    await expect(access(legacyForA)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('first-found-wins: if multiple candidates have legacy files, only the first is migrated; the rest are left for manual cleanup', async () => {
    // Defensive: in practice only one cursor file should exist at a time
    // (the original "first match" project for that repo), but the helper
    // shouldn't merge or shadow secondaries — explicit cleanup path.
    const legacyForX = join(stateRoot, 'poller-x.json');
    const legacyForA = join(stateRoot, 'poller-a.json');
    await writeFile(legacyForX, JSON.stringify({ from: 'x' }));
    await writeFile(legacyForA, JSON.stringify({ from: 'a' }));
    const target = join(stateRoot, 'poller-shared%2Frepo2.json');

    await migrateLegacyPollerStateFile(tempDir, ['x', 'a'], target);

    await expect(readFile(target, 'utf-8')).resolves.toContain('"from":"x"');
    await expect(access(legacyForX)).rejects.toMatchObject({ code: 'ENOENT' });
    // `a`'s legacy file is intentionally untouched — operator decides.
    await expect(readFile(legacyForA, 'utf-8')).resolves.toContain('"from":"a"');
  });
});

describe('pickExistingPath', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'pick-path-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true });
  });

  it('returns the first candidate that exists', async () => {
    await mkdir(join(base, 'a'));
    await mkdir(join(base, 'b'));
    expect(pickExistingPath(base, ['./a', './b'])).toBe(join(base, 'a'));
  });

  it('skips missing candidates and returns the first existing one', async () => {
    await mkdir(join(base, 'b'));
    expect(pickExistingPath(base, ['./missing', './b'])).toBe(join(base, 'b'));
  });

  it('falls back to the first candidate when none exist (caller surfaces ENOENT explicitly)', () => {
    // Resolver shouldn't silently guess a working alternative — bad path should reach the caller.
    expect(pickExistingPath(base, ['./nope-1', './nope-2'])).toBe(join(base, 'nope-1'));
  });

  it('treats files (not just dirs) as existing', async () => {
    await writeFile(join(base, 'a.txt'), 'hi');
    expect(pickExistingPath(base, ['./a.txt', './b'])).toBe(join(base, 'a.txt'));
  });
});
