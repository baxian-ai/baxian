import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PetStore } from '../../src/state/pet-store.js';
import type { CreatePetInput } from '../../src/state/pet-store.js';

function petInput(displayName: string): CreatePetInput {
  return { displayName, description: `${displayName} desc`, spritesheet: { bytes: Buffer.from(`px-${displayName}`), ext: 'webp' } };
}

describe.each([
  ['disk', true],
  ['memory', false],
] as const)('PetStore (%s)', (_label, useDisk) => {
  let tempDir: string | undefined;
  let store: PetStore;

  beforeEach(async () => {
    if (useDisk) {
      tempDir = await mkdtemp(join(tmpdir(), 'baxian-pet-store-'));
      store = new PetStore(join(tempDir, 'state', 'pets'));
    } else {
      store = new PetStore();
    }
  });

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    tempDir = undefined;
  });

  it('creates, lists (createdAt order), and reads back a pet', async () => {
    const a = await store.create(petInput('alpha'));
    const b = await store.create(petInput('beta'));
    expect(a.id).not.toBe(b.id);
    const list = await store.list();
    expect(list.map((p) => p.displayName)).toEqual(['alpha', 'beta']);
    expect((await store.getMeta(a.id))?.displayName).toBe('alpha');
    const sprite = await store.readSpritesheet(a.id);
    expect(sprite?.ext).toBe('webp');
    expect(sprite?.bytes.toString()).toBe('px-alpha');
  });

  it('keeps list order deterministic when createdAt ties', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-09T00:00:00.000Z'));
    try {
      await store.create(petInput('beta'));
      await store.create(petInput('alpha'));
    } finally {
      vi.useRealTimers();
    }
    const list = await store.list();
    expect(list.map((p) => p.displayName)).toEqual(['alpha', 'beta']);
  });

  it('returns null for unknown / unsafe pet ids', async () => {
    expect(await store.getMeta('nope')).toBeNull();
    expect(await store.getMeta('../escape')).toBeNull();
    expect(await store.readSpritesheet('../escape')).toBeNull();
  });

  it('lists empty before any pet exists', async () => {
    expect(await store.list()).toEqual([]);
    expect(await store.listAssignments()).toEqual({});
  });

  it('set / get / clear assignment and validates the pet exists', async () => {
    const pet = await store.create(petInput('alpha'));
    await store.setAssignment('dev-1', pet.id);
    expect(await store.getAssignment('dev-1')).toBe(pet.id);
    expect(await store.listAssignments()).toEqual({ 'dev-1': pet.id });

    await store.setAssignment('dev-1', null);
    expect(await store.getAssignment('dev-1')).toBeNull();
    expect(await store.listAssignments()).toEqual({});

    await expect(store.setAssignment('dev-1', 'ghost')).rejects.toThrow(/not found/);
  });

  it('delete removes the pet and cascades to every assignment referencing it', async () => {
    const pet = await store.create(petInput('alpha'));
    const other = await store.create(petInput('beta'));
    await store.setAssignment('dev-1', pet.id);
    await store.setAssignment('qa-1', pet.id);
    await store.setAssignment('dev-2', other.id);

    await store.delete(pet.id);

    expect(await store.getMeta(pet.id)).toBeNull();
    expect(await store.getAssignment('dev-1')).toBeNull();
    expect(await store.getAssignment('qa-1')).toBeNull();
    expect(await store.getAssignment('dev-2')).toBe(other.id);
  });

  it('onChange fires for setAssignment, once per affected agent on delete, never on create', async () => {
    const fired: string[] = [];
    store.onChange((id) => fired.push(id));

    const pet = await store.create(petInput('alpha'));
    expect(fired).toEqual([]);

    await store.setAssignment('dev-1', pet.id);
    await store.setAssignment('qa-1', pet.id);
    expect(fired).toEqual(['dev-1', 'qa-1']);

    fired.length = 0;
    await store.delete(pet.id);
    expect(fired.sort()).toEqual(['dev-1', 'qa-1']);
  });

  it('serializes concurrent assignment writes without losing entries', async () => {
    const pet = await store.create(petInput('alpha'));
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => store.setAssignment(`agent-${i}`, pet.id)),
    );
    const map = await store.listAssignments();
    expect(Object.keys(map)).toHaveLength(8);
  });

  it('mirrors the production wiring: onChange → publishAgentChange(\'set\', id)', async () => {
    const publishAgentChange = vi.fn();
    store.onChange((id) => publishAgentChange('set', id));
    const pet = await store.create(petInput('alpha'));
    await store.setAssignment('dev-1', pet.id);
    expect(publishAgentChange).toHaveBeenCalledWith('set', 'dev-1');
  });

  it('never leaves a dangling assignment under concurrent delete/setAssignment', async () => {
    for (let i = 0; i < 40; i++) {
      const pet = await store.create(petInput(`p${i}`));
      await Promise.allSettled([
        store.delete(pet.id),
        store.setAssignment('racer', pet.id),
      ]);
      const assigned = await store.getAssignment('racer');
      if (assigned !== null) {
        expect(await store.getMeta(assigned)).not.toBeNull();
      }
      await store.setAssignment('racer', null);
    }
  });
});

describe('PetStore corrupt assignments.json', () => {
  let tempDir: string;
  let petsDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'baxian-pet-corrupt-'));
    petsDir = join(tempDir, 'state', 'pets');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  async function writeAssignments(raw: string): Promise<void> {
    await rm(petsDir, { recursive: true, force: true });
    await (await import('node:fs/promises')).mkdir(petsDir, { recursive: true });
    await writeFile(join(petsDir, 'assignments.json'), raw);
  }

  it('propagates invalid JSON instead of silently returning empty', async () => {
    await writeAssignments('{ not valid json');
    await expect(new PetStore(petsDir).listAssignments()).rejects.toThrow();
  });

  it('propagates a valid-JSON-but-non-object payload', async () => {
    await writeAssignments('[1,2,3]');
    await expect(new PetStore(petsDir).getAssignment('dev-1')).rejects.toThrow(/corrupt/);
  });
});
