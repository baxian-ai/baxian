import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../../src/state/task-store.js';
import { initStateDir } from '../../src/state/init.js';
import type { TaskState } from '../../src/shared/index.js';

let tempDir: string;
let tasksDir: string;
let store: TaskStore;
const NOW = '2026-04-28T10:00:00Z';

function makeTask(id: string, overrides: Partial<TaskState> = {}): TaskState {
  return {
    id,
    projectId: 'proj',
    title: `Task ${id}`,
    description: 'sample',
    preferredAgentId: 'dev-1',
    agentId: 'dev-1',
    reviewRound: 0,
    status: 'pending',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

async function writeRawTask(id: string, raw: Record<string, unknown>): Promise<void> {
  await writeFile(join(tasksDir, `${id}.json`), JSON.stringify(raw, null, 2) + '\n');
}

// On-disk shape with the common required fields pre-filled; overrides win, and an explicit
// `undefined` deletes a key so callers can exercise the "field absent on disk" sanitize paths.
async function writeLegacyTask(id: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const raw: Record<string, unknown> = {
    id,
    projectId: 'proj',
    preferredAgentId: 'dev-1',
    agentId: 'dev-1',
    reviewRound: 0,
    status: 'pending',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
  for (const key of Object.keys(raw)) {
    if (raw[key] === undefined) delete raw[key];
  }
  await writeRawTask(id, raw);
}

async function readRawTask(id: string): Promise<Record<string, unknown>> {
  const content = await readFile(join(tasksDir, `${id}.json`), 'utf-8');
  return JSON.parse(content);
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-test-'));
  await initStateDir(tempDir);
  tasksDir = join(tempDir, 'state', 'tasks');
  store = new TaskStore(tasksDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

describe('TaskStore', () => {
  it('writes and reads task state', async () => {
    const task = makeTask('task-001');
    await store.set(task);
    const loaded = await store.get('task-001');
    expect(loaded).toEqual(task);
  });

  it('preserves images[] across persistence round-trip', async () => {
    const task = makeTask('task-img', { images: ['a.png', 'b.webp'] });
    await store.set(task);
    const loaded = await store.get('task-img');
    expect(loaded?.images).toEqual(['a.png', 'b.webp']);
  });

  it('preserves server review mode fields across persistence round-trip', async () => {
    // The sanitize allowlist silently strips unknown fields — a missing entry
    // here turns every persisted server-mode task back into github mode.
    const task = makeTask('task-srv', {
      reviewMode: 'server',
      batchIndex: 1,
      batchTotal: 3,
      maxRoundsContinues: 2,
    });
    await store.set(task);
    const loaded = await store.get('task-srv');
    expect(loaded?.reviewMode).toBe('server');
    expect(loaded?.batchIndex).toBe(1);
    expect(loaded?.batchTotal).toBe(3);
    expect(loaded?.maxRoundsContinues).toBe(2);
  });

  it('returns null for nonexistent task', async () => {
    expect(await store.get('nope')).toBeNull();
  });

  it('throws on unparseable JSON instead of reporting the task as missing', async () => {
    await writeFile(join(tasksDir, 'task-bad.json'), '{ not valid json');
    await expect(store.get('task-bad')).rejects.toThrow();
  });

  it('lists all tasks', async () => {
    await store.set(makeTask('task-001'));
    await store.set(makeTask('task-002', { projectId: 'other' }));
    const all = await store.list();
    expect(all).toHaveLength(2);
  });

  it('filters by projectId', async () => {
    await store.set(makeTask('task-001', { projectId: 'p1' }));
    await store.set(makeTask('task-002', { projectId: 'p2' }));
    const filtered = await store.list({ projectId: 'p1' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('task-001');
  });

  it('filters by status', async () => {
    await store.set(makeTask('task-001', { status: 'in_progress' }));
    await store.set(makeTask('task-002', { status: 'pending' }));
    const filtered = await store.list({ status: 'in_progress' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('task-001');
  });

  it('generates sequential IDs', async () => {
    const id1 = await store.nextId();
    expect(id1).toBe('task-001');
    await store.set(makeTask('task-001'));
    const id2 = await store.nextId();
    expect(id2).toBe('task-002');
  });

  it('generates IDs that skip existing numbers', async () => {
    await store.set(makeTask('task-005'));
    const id = await store.nextId();
    expect(id).toBe('task-006');
  });

  it('deletes task', async () => {
    await store.set(makeTask('task-001'));
    await store.delete('task-001');
    expect(await store.get('task-001')).toBeNull();
  });

  it('delete fires onChange on success and on ENOENT (idempotent), not on EPERM', async () => {
    const fired: Array<['set' | 'delete', string]> = [];
    store.onChange((kind, id) => fired.push([kind, id]));
    await store.set(makeTask('task-005'));
    fired.length = 0;
    await store.delete('task-005');
    expect(fired).toEqual([['delete', 'task-005']]);

    fired.length = 0;
    await store.delete('task-missing');
    expect(fired).toEqual([['delete', 'task-missing']]);

    // Substitute a directory at the would-be unlink path to force a non-ENOENT
    // error; broadcasting `delete` would lie about persistence.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(tempDir, 'state', 'tasks', 'task-stuck.json'), { recursive: true });
    fired.length = 0;
    await store.delete('task-stuck');
    expect(fired).toEqual([]);
  });
});

describe('TaskStore sanitize', () => {
  it('strips legacy issueNumber/issueUrl on get', async () => {
    await writeLegacyTask('task-100', {
      title: 'Old task',
      description: 'desc',
      issueNumber: 42,
      issueUrl: 'https://github.com/foo/bar/issues/42',
    });

    const loaded = await store.get('task-100');
    expect(loaded).not.toBeNull();
    expect(loaded!).not.toHaveProperty('issueNumber');
    expect(loaded!).not.toHaveProperty('issueUrl');
  });

  it('strips schema-foreign fields on set', async () => {
    const taskWithExtras = {
      ...makeTask('task-101'),
      issueNumber: 7,
      issueUrl: 'https://github.com/foo/bar/issues/7',
    } as TaskState & { issueNumber: number; issueUrl: string };

    await store.set(taskWithExtras);
    const onDisk = await readRawTask('task-101');
    expect(onDisk).not.toHaveProperty('issueNumber');
    expect(onDisk).not.toHaveProperty('issueUrl');
  });

  it('double-sanitizes across get -> set -> get', async () => {
    await writeLegacyTask('task-102', {
      title: 'Round-trip',
      description: 'desc',
      issueNumber: 99,
      issueUrl: 'https://github.com/foo/bar/issues/99',
    });

    const first = await store.get('task-102');
    expect(first).not.toBeNull();
    await store.set(first!);
    const second = await store.get('task-102');
    expect(second).not.toBeNull();
    expect(second!).not.toHaveProperty('issueNumber');
    expect(second!).not.toHaveProperty('issueUrl');

    const onDisk = await readRawTask('task-102');
    expect(onDisk).not.toHaveProperty('issueNumber');
    expect(onDisk).not.toHaveProperty('issueUrl');
  });

  it('list also sanitizes legacy entries', async () => {
    await writeLegacyTask('task-103', {
      issueNumber: 21,
      issueUrl: 'https://github.com/foo/bar/issues/21',
    });
    await store.set(makeTask('task-104'));

    const all = await store.list();
    expect(all).toHaveLength(2);
    for (const t of all) {
      expect(t).not.toHaveProperty('issueNumber');
      expect(t).not.toHaveProperty('issueUrl');
    }
    const legacy = all.find((t) => t.id === 'task-103')!;
    expect(legacy.title).toBe('(legacy) Issue #21');
  });

  it('falls back to (legacy) Issue #N title when issueNumber present', async () => {
    await writeLegacyTask('task-200', { issueNumber: 42 });
    const loaded = await store.get('task-200');
    expect(loaded!.title).toBe('(legacy) Issue #42');
  });

  it('falls back to (legacy) ${id} title when issueNumber missing', async () => {
    await writeLegacyTask('task-201');
    const loaded = await store.get('task-201');
    expect(loaded!.title).toBe('(legacy) task-201');
  });

  it('falls back description to "Migrated from <issueUrl>." when issueUrl present', async () => {
    await writeLegacyTask('task-202', {
      title: 'has title',
      issueUrl: 'https://github.com/foo/bar/issues/42',
    });
    const loaded = await store.get('task-202');
    expect(loaded!.description).toContain('Migrated from https://github.com/foo/bar/issues/42');
  });

  it('falls back description to empty string when issueUrl missing', async () => {
    await writeLegacyTask('task-203', { title: 'has title' });
    const loaded = await store.get('task-203');
    expect(loaded!.description).toBe('');
  });

  it('falls back preferredAgentId to agentId when preferredAgentId missing', async () => {
    await writeLegacyTask('task-204', {
      title: 'has title',
      description: 'desc',
      preferredAgentId: undefined,
      agentId: 'dev1',
      status: 'in_progress',
    });
    const loaded = await store.get('task-204');
    expect(loaded!.preferredAgentId).toBe('dev1');
  });

  it('coerces whitespace-only title/preferredAgentId via fallback', async () => {
    await writeLegacyTask('task-ws', {
      title: '   ',
      description: '',
      preferredAgentId: '   ',
    });
    const loaded = await store.get('task-ws');
    expect(loaded!.title).toBe('(legacy) task-ws'); // ' ' 不算合法 title
    expect(loaded!.preferredAgentId).toBe('dev-1'); // ' ' fallback 到 agentId
  });

  it('coerces null/wrong-typed fields via fallback (hand-edit corruption)', async () => {
    await writeLegacyTask('task-corrupt', {
      title: null, // wrong type
      description: 42, // wrong type
      preferredAgentId: null,
    });
    const loaded = await store.get('task-corrupt');
    expect(loaded!.title).toBe('(legacy) task-corrupt');
    expect(loaded!.description).toBe('');
    expect(loaded!.preferredAgentId).toBe('dev-1');
  });

  it('falls back preferredAgentId to empty when both preferredAgentId and agentId empty', async () => {
    await writeLegacyTask('task-205', {
      title: 'has title',
      description: 'desc',
      preferredAgentId: undefined,
      agentId: '',
    });
    const loaded = await store.get('task-205');
    expect(loaded!.preferredAgentId).toBe('');
  });

  it('preserves all schema fields on set for a fresh task', async () => {
    const task: TaskState = {
      id: 'task-300',
      projectId: 'proj',
      title: 'fresh',
      description: 'desc',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      qaAgentId: 'qa-1',
      prNumber: 123,
      prUrl: 'https://github.com/foo/bar/pull/123',
      branch: 'feat/xyz',
      reviewRound: 1,
      status: 'in_progress',
      createdAt: NOW,
      updatedAt: NOW,
    };
    await store.set(task);
    const onDisk = await readRawTask('task-300');
    expect(onDisk).toEqual(task);
  });
});

describe('TaskStore.migrateLegacyFiles', () => {
  it('rewrites files containing issueNumber/issueUrl to clean shape', async () => {
    await writeLegacyTask('task-leg-1', {
      issueNumber: 42,
      issueUrl: 'https://github.com/foo/bar/issues/42',
      preferredAgentId: undefined,
      status: 'in_progress',
    });

    const result = await store.migrateLegacyFiles();
    expect(result.migrated).toBe(1);
    expect(result.failed).toBe(0);

    const onDisk = await readRawTask('task-leg-1');
    expect(onDisk).not.toHaveProperty('issueNumber');
    expect(onDisk).not.toHaveProperty('issueUrl');
    expect(onDisk.title).toBe('(legacy) Issue #42');
    expect(onDisk.description).toBe('Migrated from https://github.com/foo/bar/issues/42.');
    expect(onDisk.preferredAgentId).toBe('dev-1');
  });

  it('skips clean files (no rewrite, no IO churn)', async () => {
    await store.set(makeTask('task-clean', { branch: 'feat/x' }));
    const beforeMtime = (await readRawTask('task-clean')).updatedAt;

    const result = await store.migrateLegacyFiles();
    expect(result.migrated).toBe(0);

    const after = await readRawTask('task-clean');
    expect(after.updatedAt).toBe(beforeMtime); // unchanged
  });

  it('counts failed migrations without aborting the rest', async () => {
    await writeFile(join(tasksDir, 'task-bad.json'), '{ this is not valid json');
    await writeLegacyTask('task-leg-2', {
      issueNumber: 7,
      preferredAgentId: undefined,
      agentId: undefined,
    });

    const result = await store.migrateLegacyFiles();
    expect(result.migrated).toBe(1);
    expect(result.failed).toBe(1);

    const migrated = await readRawTask('task-leg-2');
    expect(migrated).not.toHaveProperty('issueNumber');
  });

  it('returns zero counts on empty directory', async () => {
    const result = await store.migrateLegacyFiles();
    expect(result).toEqual({ migrated: 0, failed: 0 });
  });

  it('raw missing id: title fallback uses filename id, not "(legacy) unknown"', async () => {
    await writeLegacyTask('task-noid', { id: undefined, preferredAgentId: undefined });

    const result = await store.migrateLegacyFiles();
    expect(result.migrated).toBe(1);

    const onDisk = await readRawTask('task-noid');
    expect(onDisk.id).toBe('task-noid');
    expect(onDisk.title).toBe('(legacy) task-noid'); // 不是 '(legacy) unknown'
  });

  it('uses filename as authoritative id; rewrites raw.id mismatch instead of writing to undefined.json', async () => {
    await writeLegacyTask('task-fix', {
      id: 'wrong-id',
      issueNumber: 5,
      preferredAgentId: undefined,
      agentId: undefined,
    });

    const result = await store.migrateLegacyFiles();
    expect(result.migrated).toBe(1);
    const onDisk = await readRawTask('task-fix');
    expect(onDisk.id).toBe('task-fix');
    expect(onDisk).not.toHaveProperty('issueNumber');
    await expect(readRawTask('wrong-id')).rejects.toThrow();
  });

  it('migrates files with null/whitespace fields (predicate aligned with sanitize)', async () => {
    await writeLegacyTask('task-corrupt-disk', {
      title: null, // wrong type
      description: 42, // wrong type
      preferredAgentId: '   ', // whitespace-only
    });

    const result = await store.migrateLegacyFiles();
    expect(result.migrated).toBe(1);

    const onDisk = await readRawTask('task-corrupt-disk');
    expect(typeof onDisk.title).toBe('string');
    expect(onDisk.title).toBe('(legacy) task-corrupt-disk');
    expect(typeof onDisk.description).toBe('string');
    expect(onDisk.preferredAgentId).toBe('dev-1');
  });

  it('migrates partial-migration files missing required fields (no longer has issue keys)', async () => {
    await writeLegacyTask('task-partial', { preferredAgentId: undefined });

    const result = await store.migrateLegacyFiles();
    expect(result.migrated).toBe(1);
    expect(result.failed).toBe(0);

    const onDisk = await readRawTask('task-partial');
    expect(onDisk.title).toBe('(legacy) task-partial'); // sanitize fallback
    expect(onDisk.description).toBe('');
    expect(onDisk.preferredAgentId).toBe('dev-1'); // 从 agentId fallback
  });
});
