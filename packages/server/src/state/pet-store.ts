import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isRecord } from '../shared/index.js';
import type { PetMeta, PetSpritesheetExt } from '../shared/index.js';

export type PetStoreListener = (agentId: string) => void;

const SAFE_PET_ID = /^[A-Za-z0-9_-]+$/;
const ASSIGNMENTS_FILE = 'assignments.json';

export interface CreatePetInput {
  displayName: string;
  description: string;
  spritesheet: { bytes: Buffer; ext: PetSpritesheetExt };
}

// Persists the shared Pet library (state/pets/<id>/) and per-agent assignments
// (state/pets/assignments.json). onChange fires for the agents whose petId changed
// so the EventPublisher can re-broadcast their snapshots (wired in index.ts).
export class PetStore {
  private readonly listeners = new Set<PetStoreListener>();
  private readonly memLibrary = new Map<string, { meta: PetMeta; bytes: Buffer }>();
  private memAssignments: Record<string, string> = {};
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir?: string) {}

  onChange(fn: PetStoreListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async list(): Promise<PetMeta[]> {
    if (!this.dir) {
      return [...this.memLibrary.values()].map((e) => e.meta).sort(byCreatedAt);
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(this.dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return [];
      throw err;
    }
    const out: PetMeta[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const meta = await this.getMeta(e.name);
      if (meta) out.push(meta);
    }
    return out.sort(byCreatedAt);
  }

  async create(input: CreatePetInput): Promise<PetMeta> {
    const id = randomUUID();
    const meta: PetMeta = {
      id,
      displayName: input.displayName,
      description: input.description,
      ext: input.spritesheet.ext,
      createdAt: new Date().toISOString(),
    };
    if (!this.dir) {
      this.memLibrary.set(id, { meta, bytes: input.spritesheet.bytes });
      return meta;
    }
    const petDir = join(this.dir, id);
    await mkdir(petDir, { recursive: true });
    await writeFile(join(petDir, `spritesheet.${meta.ext}`), input.spritesheet.bytes);
    await writeJsonAtomic(join(petDir, 'meta.json'), meta);
    return meta;
  }

  async getMeta(petId: string): Promise<PetMeta | null> {
    if (!SAFE_PET_ID.test(petId)) return null;
    if (!this.dir) return this.memLibrary.get(petId)?.meta ?? null;
    try {
      const content = await readFile(join(this.dir, petId, 'meta.json'), 'utf-8');
      return JSON.parse(content) as PetMeta;
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
      throw err;
    }
  }

  async readSpritesheet(petId: string): Promise<{ bytes: Buffer; ext: PetSpritesheetExt } | null> {
    const meta = await this.getMeta(petId);
    if (!meta) return null;
    if (!this.dir) {
      const entry = this.memLibrary.get(petId);
      return entry ? { bytes: entry.bytes, ext: entry.meta.ext } : null;
    }
    try {
      const bytes = await readFile(join(this.dir, petId, `spritesheet.${meta.ext}`));
      return { bytes, ext: meta.ext };
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(petId: string): Promise<void> {
    if (!SAFE_PET_ID.test(petId)) return;
    // Library removal happens INSIDE the lock together with the assignment cascade so a
    // concurrent setAssignment(samePetId) either runs before us (we then clear its entry)
    // or after us (its in-lock getMeta sees the pet gone and rejects) — never dangling.
    const affected = await this.withLock(async () => {
      const map = await this.readAssignments();
      const ids = Object.keys(map).filter((agentId) => map[agentId] === petId);
      if (ids.length) {
        for (const agentId of ids) delete map[agentId];
        await this.writeAssignments(map);
      }
      if (!this.dir) this.memLibrary.delete(petId);
      else await rm(join(this.dir, petId), { recursive: true, force: true });
      return ids;
    });
    for (const agentId of affected) this.emit(agentId);
  }

  async getAssignment(agentId: string): Promise<string | null> {
    const map = await this.readAssignments();
    return map[agentId] ?? null;
  }

  async listAssignments(): Promise<Record<string, string>> {
    return this.readAssignments();
  }

  async setAssignment(agentId: string, petId: string | null): Promise<void> {
    // Existence check is INSIDE the lock so it can't pass against a pet that a concurrent
    // delete() is removing under the same lock (TOCTOU → dangling assignment otherwise).
    await this.withLock(async () => {
      if (petId !== null) {
        const meta = await this.getMeta(petId);
        if (!meta) throw new Error(`pet ${petId} not found`);
      }
      const map = await this.readAssignments();
      if (petId === null) delete map[agentId];
      else map[agentId] = petId;
      await this.writeAssignments(map);
    });
    this.emit(agentId);
  }

  private emit(agentId: string): void {
    for (const fn of this.listeners) fn(agentId);
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.then(noop, noop);
    return run;
  }

  private async readAssignments(): Promise<Record<string, string>> {
    if (!this.dir) return { ...this.memAssignments };
    let content: string;
    try {
      content = await readFile(join(this.dir, ASSIGNMENTS_FILE), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return {};
      throw err;
    }
    // Only a missing file means "no assignments". Invalid JSON or a non-object payload is
    // corruption — propagate so a later write can't silently overwrite tampered state.
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) throw new Error(`corrupt ${ASSIGNMENTS_FILE}: expected a JSON object`);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
    return out;
  }

  private async writeAssignments(map: Record<string, string>): Promise<void> {
    if (!this.dir) {
      this.memAssignments = { ...map };
      return;
    }
    await mkdir(this.dir, { recursive: true });
    await writeJsonAtomic(join(this.dir, ASSIGNMENTS_FILE), map);
  }
}

function byCreatedAt(a: PetMeta, b: PetMeta): number {
  return a.createdAt.localeCompare(b.createdAt);
}

function noop(): void {}

async function writeJsonAtomic(finalPath: string, data: unknown): Promise<void> {
  const tmp = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await rename(tmp, finalPath);
}
