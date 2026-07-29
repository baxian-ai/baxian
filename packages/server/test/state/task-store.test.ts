import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskSchemaError, TaskStore } from '../../src/state/task-store.js';
import { initStateDir } from '../../src/state/init.js';
import type { TaskState } from '../../src/shared/index.js';
import { makeTask } from '../helpers/fixtures.js';

let tempDir: string;
let tasksDir: string;
let store: TaskStore;
const NOW = '2026-04-28T10:00:00Z';

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
    qaAgentId: 'qa-1',
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
    const task = makeTask({ id: 'task-001', status: 'pending' });
    await store.set(task);
    const loaded = await store.get('task-001');
    expect(loaded).toEqual(task);
  });

  it('preserves images[] across persistence round-trip', async () => {
    const task = makeTask({ id: 'task-img', status: 'pending', images: ['a.png', 'b.webp'] });
    await store.set(task);
    const loaded = await store.get('task-img');
    expect(loaded?.images).toEqual(['a.png', 'b.webp']);
  });

  it('strips retired task fields instead of migrating them', async () => {
    const task = {
      ...makeTask({ id: 'task-retired-fields', status: 'pending' }),
      reviewMode: 'server',
      afterDone: 'pr',
      reviewCheckoutMode: 'base',
      reviewWorktreeMode: 'head',
      batchIndex: 1,
      batchTotal: 3,
      maxRoundsContinues: 2,
      serverSignalRecovery: { signalKind: 'code-done' },
    } as TaskState & Record<string, unknown>;
    await store.set(task);
    const loaded = await store.get(task.id);
    for (const field of [
      'reviewMode', 'afterDone', 'reviewCheckoutMode', 'reviewWorktreeMode',
      'batchIndex', 'batchTotal', 'serverSignalRecovery',
    ]) {
      expect(loaded).not.toHaveProperty(field);
    }
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
    await store.set(makeTask({ id: 'task-001', status: 'pending' }));
    await store.set(makeTask({ id: 'task-002', status: 'pending', projectId: 'other' }));
    const all = await store.list();
    expect(all).toHaveLength(2);
  });

  it('filters by projectId', async () => {
    await store.set(makeTask({ id: 'task-001', status: 'pending', projectId: 'p1' }));
    await store.set(makeTask({ id: 'task-002', status: 'pending', projectId: 'p2' }));
    const filtered = await store.list({ projectId: 'p1' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('task-001');
  });

  it('filters by status', async () => {
    await store.set(makeTask({ id: 'task-001', status: 'in_progress' }));
    await store.set(makeTask({ id: 'task-002', status: 'pending' }));
    const filtered = await store.list({ status: 'in_progress' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('task-001');
  });

  it('generates sequential IDs', async () => {
    const id1 = await store.nextId();
    expect(id1).toBe('task-001');
    await store.set(makeTask({ id: 'task-001', status: 'pending' }));
    const id2 = await store.nextId();
    expect(id2).toBe('task-002');
  });

  it('generates IDs that skip existing numbers', async () => {
    await store.set(makeTask({ id: 'task-005', status: 'pending' }));
    const id = await store.nextId();
    expect(id).toBe('task-006');
  });

  it('nextId never reuses the id of an unreadable task file', async () => {
    await writeFile(join(tasksDir, 'task-007.json'), '{corrupt');
    expect(await store.nextId()).toBe('task-008');
  });

  it('deletes task', async () => {
    await store.set(makeTask({ id: 'task-001', status: 'pending' }));
    await store.delete('task-001');
    expect(await store.get('task-001')).toBeNull();
  });

  it('delete fires onChange on success and on ENOENT (idempotent), not on EPERM', async () => {
    const fired: Array<['set' | 'delete', string]> = [];
    store.onChange((kind, id) => fired.push([kind, id]));
    await store.set(makeTask({ id: 'task-005', status: 'pending' }));
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
    await store.set(makeTask({ id: 'task-001', status: 'pending' }));
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
  it('reviewRoundPending 持久化并校验类型：boolean 通过、字符串 "true" 抛错', async () => {
    await store.set({ ...makeTask({ id: 'task-rrp', status: 'pending' }), reviewRoundPending: true });
    const loaded = await store.get('task-rrp');
    expect(loaded?.reviewRoundPending).toBe(true);

    await writeUnsanitizedTask('task-rrp-bad', {
      title: 'T', description: 'D',
      status: 'review', reviewRound: 1,
      reviewRoundPending: 'true',
    });
    await expect(store.get('task-rrp-bad')).rejects.toThrow(/reviewRoundPending/);
  });

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
      ...makeTask({ id: 'task-101', status: 'pending' }),
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
    await store.set(makeTask({ id: 'task-104', status: 'pending' }));

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
    await store.set(makeTask({ id: 'task-007', status: 'pending' }));
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
    ['research phase', { phase: 'research' }, 'phase'],
    ['missing devAgentId', { devAgentId: undefined }, 'devAgentId'],
    ['duplicate participants', { qaAgentId: 'dev-1' }, 'participants'],
    ['assigned Dev without QA', { qaAgentId: undefined }, 'participants'],
    ['unassigned Dev with QA', { agentId: '', devAgentId: '' }, 'participants'],
    ['non-participant agentId', { agentId: 'qa-1' }, 'agentId'],
  ])('rejects strict task schema violation: %s', async (_case, overrides, field) => {
    await writeUnsanitizedTask(`task-strict-${field}`, overrides);
    await expect(store.get(`task-strict-${field}`)).rejects.toThrow(field);
  });

  it('accepts an unassigned task only when both participant slots are empty', async () => {
    await writeUnsanitizedTask('task-unassigned', {
      preferredAgentId: '',
      agentId: '',
      devAgentId: '',
      qaAgentId: undefined,
      status: 'pending',
    });

    await expect(store.get('task-unassigned')).resolves.toMatchObject({
      preferredAgentId: '',
      agentId: '',
      devAgentId: '',
      status: 'pending',
    });
    expect((await store.get('task-unassigned'))?.qaAgentId).toBeUndefined();
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
    reviewConversationUpdatedAt: '2026-07-19T08:00:00Z',
  };

  it('round-trips the git field family through set and get', async () => {
    await store.set(makeTask({ id: 'task-400', status: 'pending', ...gitFields }));
    const loaded = await store.get('task-400');
    expect(loaded).toMatchObject(gitFields);
  });

  it('round-trips a task with its immutable platform binding', async () => {
    const task = makeTask({
      id: 'task-platform-bound',
      status: 'pending',
      platformBinding: { mode: 'git', repoKey: 'github.com/owner/repo', tool: 'gh' },
    });
    await store.set(task);
    expect(await store.get(task.id)).toEqual(task);
  });

  it("rejects the retired 'ready' status on get and list", async () => {
    await writeUnsanitizedTask('task-ready', { status: 'ready' });
    await expect(store.get('task-ready')).rejects.toThrow(/status/);
    await expect(store.listStrict()).rejects.toThrow(/status/);
  });

  it('list() still skips a genuinely corrupt file rather than failing the whole store', async () => {
    await writeUnsanitizedTask('task-ok');
    await writeFile(join(tasksDir, 'task-corrupt.json'), '{ not json', 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const loaded = await store.list();
    expect(loaded.map(t => t.id)).toContain('task-ok');
    expect(loaded.map(t => t.id)).not.toContain('task-corrupt');
    warn.mockRestore();
  });

  it('listStrict() returns valid tasks but fails closed when any task file is corrupt', async () => {
    await writeUnsanitizedTask('task-ok');
    expect((await store.listStrict()).map(task => task.id)).toEqual(['task-ok']);

    await writeFile(join(tasksDir, 'task-corrupt.json'), '{ not json', 'utf-8');
    await expect(store.listStrict()).rejects.toBeInstanceOf(SyntaxError);
  });

  it('listStrict() identifies the task file in parse and schema failures', async () => {
    await writeFile(join(tasksDir, 'task-broken-json.json'), '{ not json');
    await expect(store.listStrict()).rejects.toMatchObject({
      name: 'SyntaxError',
      message: expect.stringContaining('task-broken-json.json'),
    });

    await rm(join(tasksDir, 'task-broken-json.json'));
    await writeUnsanitizedTask('task-broken-schema', { status: 'ready' });
    await expect(store.listStrict()).rejects.toSatisfy((error: unknown) =>
      error instanceof TaskSchemaError
      && error.message.includes('task-broken-schema.json')
      && error.message.includes('status'));
  });

  it('listStrict() skips an entry that disappears after the directory scan', async () => {
    await writeUnsanitizedTask('task-ok');
    await symlink(join(tasksDir, 'already-gone.json'), join(tasksDir, 'vanished.json'));

    await expect(store.listStrict()).resolves.toEqual([
      expect.objectContaining({ id: 'task-ok' }),
    ]);
  });

  it('listStrict() propagates task-directory scan failures while list() remains tolerant', async () => {
    const missingStore = new TaskStore(join(tempDir, 'missing-tasks'));
    await expect(missingStore.listStrict()).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(missingStore.list()).resolves.toEqual([]);
  });

  it('round-trips a complete active post-approve episode', async () => {
    const episode: Partial<TaskState> = {
      status: 'approved',
      postApproveGeneration: 'feedfeedfeed',
      postApproveHeadSha: 'a'.repeat(40),
      postApproveToken: 'post-pass-1',
      postApprovePhase: 'delivered',
      pendingRedispatch: true,
      redispatchCount: 2,
    };
    await store.set(makeTask({ id: 'task-episode', status: 'pending', ...episode }));
    expect(await store.get('task-episode')).toMatchObject(episode);
  });

  it('rejects generationless approved episodes', async () => {
    await writeUnsanitizedTask('task-legacy-active-episode', {
      status: 'approved',
      postApproveHeadSha: 'a'.repeat(40),
      postApproveToken: 'abcdef123456',
      postApprovePhase: 'delivered',
      pendingRedispatch: true,
    });
    await writeUnsanitizedTask('task-legacy-revoked-episode', {
      status: 'approved',
      postApproveHeadSha: 'a'.repeat(40),
      postApproveRevoked: { reason: 'request-changes', at: NOW },
    });

    await expect(store.get('task-legacy-active-episode')).rejects.toThrow('postApproveGeneration');
    await expect(store.get('task-legacy-revoked-episode')).rejects.toThrow('postApproveRevoked');
  });

  it('rejects post-approve effects outside approved even with a complete episode', async () => {
    await writeUnsanitizedTask('task-effects-outside-approved', {
      status: 'max_rounds',
      postApproveGeneration: 'feedfeedfeed',
      postApproveHeadSha: 'a'.repeat(40),
      postApproveToken: 'abcdef123456',
      postApprovePhase: 'installed',
      pendingRedispatch: true,
    });

    await expect(store.get('task-effects-outside-approved'))
      .rejects.toThrow('postApproveGeneration');
  });

  it('round-trips a durable remote cleanup intent', async () => {
    const remoteCleanup = {
      generation: 'abc123abc123',
      stage: 'delete-pending' as const,
      prNumber: 42,
      branch: 'bx/task-remote',
      expectedHeadSha: 'a'.repeat(40),
      remoteProjectId: 'R_repo',
      updatedAt: NOW,
    };
    await store.set(makeTask({
      id: 'task-remote',
      status: 'cancelled', remoteCleanup,
    }));
    expect((await store.get('task-remote'))?.remoteCleanup).toEqual(remoteCleanup);
  });

  it('rejects remote cleanup intents with an invalid stage contract', async () => {
    await writeUnsanitizedTask('task-remote-delete-incomplete', {
      status: 'cancelled',
      remoteCleanup: {
        generation: 'abc123abc123', stage: 'delete-pending', prNumber: 42,
        branch: 'bx/task-remote-delete-incomplete', updatedAt: NOW,
      },
    });
    await expect(store.get('task-remote-delete-incomplete')).rejects.toThrow('remoteCleanup');

    await writeUnsanitizedTask('task-remote-manual-incomplete', {
      status: 'cancelled',
      remoteCleanup: {
        generation: 'abc123abc123', stage: 'manual', prNumber: 42,
        branch: 'bx/task-remote-manual-incomplete', updatedAt: NOW,
      },
    });
    await expect(store.get('task-remote-manual-incomplete')).rejects.toThrow('remoteCleanup.failure');

  });

  it('round-trips a pending review lease bound to the current pass tuple', async () => {
    const lease = {
      generation: 'decafdecaf12',
      phase: 'pending' as const,
      qaPhase: 'recheck' as const,
      signalToken: 'abcdef123456',
      headSha: 'a'.repeat(40),
      passToken: '111111111111',
      failToken: '222222222222',
      effectiveRound: 2,
      updatedAt: NOW,
    };
    await store.set(makeTask({
      id: 'task-lease',
      status: 'review', reviewRound: 1, reviewRoundPending: true,
      signalToken: lease.signalToken, reviewHeadAnchorSha: lease.headSha,
      passToken: lease.passToken, failToken: lease.failToken, reviewDispatch: lease,
    }));
    expect((await store.get('task-lease'))?.reviewDispatch).toEqual(lease);
  });

  it('rejects the retired legacy boolean pending marker', async () => {
    await writeUnsanitizedTask('task-legacy-lease', {
      status: 'review', reviewDispatchPending: true,
    });
    await expect(store.get('task-legacy-lease')).rejects.toThrow('reviewDispatchPending');
  });

  it('rejects incomplete episodes and leases detached from the current tuple', async () => {
    await writeUnsanitizedTask('task-incomplete-episode', {
      status: 'approved', postApproveGeneration: 'feedfeedfeed',
    });
    await expect(store.get('task-incomplete-episode')).rejects.toThrow('postApproveGeneration');

    await writeUnsanitizedTask('task-detached-lease', {
      status: 'review', reviewRound: 1,
      signalToken: 'abcdef123456', reviewHeadAnchorSha: 'a'.repeat(40),
      passToken: '111111111111', failToken: '222222222222',
      reviewDispatch: {
        generation: 'decafdecaf12', phase: 'pending', qaPhase: 'recheck', signalToken: 'abcdef123456',
        headSha: 'b'.repeat(40), passToken: '111111111111', failToken: '222222222222',
        effectiveRound: 1, updatedAt: NOW,
      },
    });
    await expect(store.get('task-detached-lease')).rejects.toThrow('reviewDispatch');

    await writeUnsanitizedTask('task-invalid-lease-phase', {
      status: 'review', reviewRound: 1,
      signalToken: 'abcdef123456', reviewHeadAnchorSha: 'a'.repeat(40),
      passToken: '111111111111', failToken: '222222222222',
      reviewDispatch: {
        generation: 'decafdecaf12', phase: 'pending', qaPhase: 'initial', signalToken: 'abcdef123456',
        headSha: 'a'.repeat(40), passToken: '111111111111', failToken: '222222222222',
        effectiveRound: 1, updatedAt: NOW,
      },
    });
    await expect(store.get('task-invalid-lease-phase')).rejects.toThrow('reviewDispatch.qaPhase');
  });

  it('rejects malformed git field shapes on load', async () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ['reviewConversationUpdatedAt', { reviewConversationUpdatedAt: 123 }],
      ['reviewConversationUpdatedAt', { reviewConversationUpdatedAt: '' }],
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
      ['outbox', { outbox: [{ key: 'abc123abc123', type: 'git.spec-verdict', data: { prNumber: 42, comments: 'change' } }] }],
      ['outbox', { outbox: [{ key: 'k', type: 'human.intervention', data: {} }, { key: 'k', type: 'human.intervention', data: {} }] }],
      ['pendingRedispatch', { pendingRedispatch: 'yes' }],
      ['redispatchCount', { redispatchCount: -1 }],
    ];
    for (const [field, raw] of bad) {
      await writeUnsanitizedTask(`task-bad-${field}-${JSON.stringify(raw).length}`, raw);
      await expect(store.get(`task-bad-${field}-${JSON.stringify(raw).length}`), field).rejects.toThrow(field);
    }
  });
});
