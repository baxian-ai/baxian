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
    devAgentId: 'dev-1',
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

async function writeUnsanitizedTask(id: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const raw: Record<string, unknown> = {
    id,
    projectId: 'proj',
    title: `Task ${id}`,
    description: 'sample',
    preferredAgentId: 'dev-1',
    agentId: 'dev-1',
    devAgentId: 'dev-1',
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
    const task = makeTask('task-srv', {
      reviewMode: 'server',
      reviewCheckoutMode: 'base',
      batchIndex: 1,
      batchTotal: 3,
      maxRoundsContinues: 2,
    });
    await store.set(task);
    const loaded = await store.get('task-srv');
    expect(loaded?.reviewMode).toBe('server');
    expect(loaded?.reviewCheckoutMode).toBe('base');
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

  it('nextId never reuses the id of an unreadable task file', async () => {
    await writeFile(join(tasksDir, 'task-007.json'), '{corrupt');
    expect(await store.nextId()).toBe('task-008');
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

    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(tempDir, 'state', 'tasks', 'task-stuck.json'), { recursive: true });
    fired.length = 0;
    await store.delete('task-stuck');
    expect(fired).toEqual([]);
  });

  it('get/delete reject path-like ids so a store key cannot escape its dir', async () => {
    await store.set(makeTask('task-001'));
    for (const bad of ['../../../secret', '../task-001', 'a/b', '..', 'task 001', '中文']) {
      expect(await store.get(bad)).toBeNull();
    }
    const fired: Array<['set' | 'delete', string]> = [];
    store.onChange((kind, id) => fired.push([kind, id]));
    await store.delete('../../../secret');
    expect(fired).toEqual([]);
    expect(await store.get('task-001')).not.toBeNull();
  });
});

describe('TaskStore sanitize', () => {
  it('strips schema-foreign fields on get', async () => {
    await writeUnsanitizedTask('task-100', {
      title: 'Old task',
      description: 'desc',
      strayField: 42,
      anotherStray: 'https://example.com/x',
    });

    const loaded = await store.get('task-100');
    expect(loaded).not.toBeNull();
    expect(loaded!).not.toHaveProperty('strayField');
    expect(loaded!).not.toHaveProperty('anotherStray');
  });

  it('strips schema-foreign fields on set', async () => {
    const taskWithExtras = {
      ...makeTask('task-101'),
      strayField: 7,
      anotherStray: 'https://example.com/y',
    } as TaskState & { strayField: number; anotherStray: string };

    await store.set(taskWithExtras);
    const onDisk = await readRawTask('task-101');
    expect(onDisk).not.toHaveProperty('strayField');
    expect(onDisk).not.toHaveProperty('anotherStray');
  });

  it('double-sanitizes across get -> set -> get', async () => {
    await writeUnsanitizedTask('task-102', {
      title: 'Round-trip',
      description: 'desc',
      strayField: 99,
    });

    const first = await store.get('task-102');
    expect(first).not.toBeNull();
    await store.set(first!);
    const second = await store.get('task-102');
    expect(second).not.toBeNull();
    expect(second!).not.toHaveProperty('strayField');

    const onDisk = await readRawTask('task-102');
    expect(onDisk).not.toHaveProperty('strayField');
  });

  it('list also sanitizes unsanitized entries', async () => {
    await writeUnsanitizedTask('task-103', {
      strayField: 21,
    });
    await store.set(makeTask('task-104'));

    const all = await store.list();
    expect(all).toHaveLength(2);
    for (const t of all) {
      expect(t).not.toHaveProperty('strayField');
    }
    const sanitized = all.find((t) => t.id === 'task-103')!;
    expect(sanitized.title).toBe('Task task-103');
  });

  it('rejects a task whose required title is missing', async () => {
    await writeUnsanitizedTask('task-201', { title: undefined });
    await expect(store.get('task-201')).rejects.toThrow('title');
  });

  it('rejects a task whose required description is missing', async () => {
    await writeUnsanitizedTask('task-203', { description: undefined });
    await expect(store.get('task-203')).rejects.toThrow('description');
  });

  it('does not map the removed specMarkerToken field', async () => {
    await writeUnsanitizedTask('task-smt', {
      title: 'dormant pre-rename task',
      description: '',
      specMarkerToken: 'tok-123',
    });
    const loaded = await store.get('task-smt');
    expect(loaded!.signalToken).toBeUndefined();
    expect(loaded!).not.toHaveProperty('specMarkerToken');
  });

  it('does not map the removed reviewWorktreeMode field', async () => {
    await writeUnsanitizedTask('task-review-checkout', {
      title: 'legacy review checkout',
      reviewWorktreeMode: 'base',
    });

    const loaded = await store.get('task-review-checkout');

    expect(loaded?.reviewCheckoutMode).toBeUndefined();
    expect(loaded).not.toHaveProperty('reviewWorktreeMode');
  });

  it('keeps signalToken when both signalToken and specMarkerToken are on disk', async () => {
    await writeUnsanitizedTask('task-smt2', {
      title: 'dormant pre-rename task',
      description: '',
      signalToken: 'new-tok',
      specMarkerToken: 'old-tok',
    });
    const loaded = await store.get('task-smt2');
    expect(loaded!.signalToken).toBe('new-tok');
  });

  it('get treats the filename as the authoritative id when the file body omits it', async () => {
    await writeUnsanitizedTask('task-noid', { id: undefined, title: 'has title' });
    const loaded = await store.get('task-noid');
    expect(loaded!.id).toBe('task-noid');
    expect(loaded!.title).toBe('has title');
  });

  it('get overrides a mismatching id in the file body with the filename id', async () => {
    await writeUnsanitizedTask('task-fixed-id', { id: 'wrong-id', title: 'has title' });
    const loaded = await store.get('task-fixed-id');
    expect(loaded!.id).toBe('task-fixed-id');
  });

  it('list carries the filename id for entries whose body omits it, and nextId survives non-numeric ids', async () => {
    await writeUnsanitizedTask('task-noid2', { id: undefined, title: 'x' });
    await store.set(makeTask('task-007'));
    const all = await store.list();
    expect(all.map((t) => t.id)).toContain('task-noid2');
    expect(await store.nextId()).toBe('task-008');
  });

  it('rejects a task whose preferredAgentId is missing', async () => {
    await writeUnsanitizedTask('task-204', {
      title: 'has title',
      description: 'desc',
      preferredAgentId: undefined,
      agentId: 'dev1',
      status: 'in_progress',
    });
    await expect(store.get('task-204')).rejects.toThrow('preferredAgentId');
  });

  it('rejects a whitespace-only title', async () => {
    await writeUnsanitizedTask('task-ws', {
      title: '   ',
      description: '',
      preferredAgentId: '   ',
    });
    await expect(store.get('task-ws')).rejects.toThrow('title');
  });

  it('rejects null or wrongly typed required fields', async () => {
    await writeUnsanitizedTask('task-corrupt', {
      title: null,
      description: 42,
      preferredAgentId: null,
    });
    await expect(store.get('task-corrupt')).rejects.toThrow('title');
  });

  it('rejects a missing preferredAgentId even when agentId is empty', async () => {
    await writeUnsanitizedTask('task-205', {
      title: 'has title',
      description: 'desc',
      preferredAgentId: undefined,
      agentId: '',
    });
    await expect(store.get('task-205')).rejects.toThrow('preferredAgentId');
  });

  it.each([
    ['unknown phase', { phase: 'analysis' }, 'phase'],
    ['missing devAgentId', { devAgentId: undefined }, 'devAgentId'],
    ['duplicate participants', { qaAgentId: 'dev-1' }, 'participants'],
    ['non-participant agentId', { agentId: 'qa-1' }, 'agentId'],
    ['research phase without Research', { phase: 'research', researchAgentId: undefined }, 'researchAgentId'],
  ])('rejects strict task schema violation: %s', async (_case, overrides, field) => {
    await writeUnsanitizedTask(`task-strict-${field}`, overrides);
    await expect(store.get(`task-strict-${field}`)).rejects.toThrow(field);
  });

  it('accepts an unphased Dev task as the initial Dev-SDD state', async () => {
    await writeUnsanitizedTask('task-dev-sdd', {
      qaAgentId: 'qa-1',
      phase: undefined,
      status: 'in_progress',
    });

    await expect(store.get('task-dev-sdd')).resolves.toMatchObject({
      agentId: 'dev-1',
      devAgentId: 'dev-1',
      qaAgentId: 'qa-1',
      status: 'in_progress',
    });
    expect((await store.get('task-dev-sdd'))?.phase).toBeUndefined();
  });

  it('rejects an unphased task that records a Research participant', async () => {
    await writeUnsanitizedTask('task-research-no-phase', {
      preferredAgentId: 'research-1',
      agentId: 'research-1',
      researchAgentId: 'research-1',
      phase: undefined,
      status: 'in_progress',
    });

    await expect(store.get('task-research-no-phase')).rejects.toThrow('phase');
  });

  it('accepts a Research task with distinct stable participants', async () => {
    await writeUnsanitizedTask('task-research', {
      preferredAgentId: 'research-1',
      agentId: 'research-1',
      devAgentId: 'dev-1',
      qaAgentId: 'qa-1',
      researchAgentId: 'research-1',
      phase: 'research',
      status: 'in_progress',
    });

    await expect(store.get('task-research')).resolves.toMatchObject({
      agentId: 'research-1',
      devAgentId: 'dev-1',
      qaAgentId: 'qa-1',
      researchAgentId: 'research-1',
      phase: 'research',
    });
  });

  it('preserves all schema fields on set for a fresh task', async () => {
    const task: TaskState = {
      id: 'task-300',
      projectId: 'proj',
      title: 'fresh',
      description: 'desc',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      devAgentId: 'dev-1',
      qaAgentId: 'qa-1',
      prNumber: 123,
      prUrl: 'https://github.com/foo/bar/pull/123',
      branch: 'feat/xyz',
      latestHeadSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      reviewHeadAnchorSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      reviewDispatchedAt: '2026-04-28T10:01:00Z',
      prFeedbackReceivedAt: '2026-04-28T10:02:00Z',
      fixDispatchedAt: '2026-04-28T10:03:00Z',
      reviewRound: 1,
      phase: 'code',
      status: 'in_progress',
      createdAt: NOW,
      updatedAt: NOW,
    };
    await store.set(task);
    const onDisk = await readRawTask('task-300');
    expect(onDisk).toEqual(task);
  });
});

describe('TaskStore git review fields', () => {
  const gitFields: Partial<TaskState> = {
    reviewMode: 'git',
    passToken: 'abcdef123456',
    failToken: '123456abcdef',
    baseBranch: 'main',
    replyActorId: '77',
    replyActorStatus: 'verified',
    closedUnmergedAnchor: { prNumber: 42, generation: 1 },
    passProvenance: {
      sourceKey: 'reviews', id: '900', bodyDigest: 'a'.repeat(64),
      token: 'abcdef123456', failToken: '123456abcdef', anchorSha: 'a'.repeat(40),
    },
    consumedFeedback: { 'issue-comments:100:aa': 1700000000000 },
    outbox: [{ key: 't1:42:mr-closed-unmerged:1', type: 'human.intervention', data: { phase: 'mr-closed-unmerged' } }],
    pendingRedispatch: true,
    redispatchCount: 2,
  };

  it('round-trips the git field family through set and get', async () => {
    await store.set(makeTask('task-400', gitFields));
    const loaded = await store.get('task-400');
    expect(loaded).toMatchObject(gitFields);
  });

  it('accepts reviewMode git on load', async () => {
    await writeUnsanitizedTask('task-401', { reviewMode: 'git' });
    const loaded = await store.get('task-401');
    expect(loaded?.reviewMode).toBe('git');
  });

  it('rejects malformed git field shapes on load', async () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ['replyActorStatus', { replyActorStatus: 'trusted' }],
      ['passToken', { passToken: 'short' }],
      ['failToken', { failToken: 42 }],
      ['closedUnmergedAnchor', { closedUnmergedAnchor: { prNumber: 0, generation: 1 } }],
      ['closedUnmergedAnchor', { closedUnmergedAnchor: { prNumber: 42 } }],
      ['passProvenance', { passProvenance: { sourceKey: 'reviews', id: '1' } }],
      ['consumedFeedback', { consumedFeedback: { key: 'not-a-number' } }],
      ['consumedFeedback', { consumedFeedback: ['issue-comments:1:aa'] }],
      ['outbox', { outbox: [{ key: '', type: 'human.intervention', data: {} }] }],
      ['outbox', { outbox: [{ key: 'k', type: 'other', data: {} }] }],
      ['outbox', { outbox: { key: 'k' } }],
      ['pendingRedispatch', { pendingRedispatch: 'yes' }],
      ['redispatchCount', { redispatchCount: -1 }],
    ];
    for (const [field, raw] of bad) {
      await writeUnsanitizedTask(`task-bad-${field}-${JSON.stringify(raw).length}`, raw);
      await expect(store.get(`task-bad-${field}-${JSON.stringify(raw).length}`), field).rejects.toThrow(field);
    }
  });
});
