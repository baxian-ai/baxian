import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskSchemaError, TaskStore } from '../../src/state/task-store.js';
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
    reviewMode: 'git',
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
    reviewMode: 'git',
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

  it('round-trips a generation-fenced server signal recovery intent', async () => {
    const task = makeTask('task-recovery', {
      phase: 'code',
      status: 'fixing',
      reviewRound: 2,
      signalToken: '222222222222',
      serverSignalRecovery: {
        mode: 'correct-response',
        signalKind: 'code-fixed',
        phase: 'code',
        round: 2,
        sourceToken: '111111111111',
        findingsDigest: 'a'.repeat(64),
        failureSignature: 'b'.repeat(64),
        responseDigest: 'c'.repeat(64),
        reason: 'coverage-gap',
        missingFindingIds: ['f-1'],
        unknownFindingIds: ['old-1'],
        schemaViolationCodes: [],
        createdAt: NOW,
      },
    });

    await store.set(task);
    expect(await store.get(task.id)).toEqual(task);
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
  it.each([
    ['source token is not superseded', {
      signalToken: '111111111111',
    }],
    ['task round drifted', {
      reviewRound: 3,
    }],
    ['task phase drifted', {
      phase: 'spec', specReviewRound: 2,
    }],
    ['failure ids are not sorted', {
      missingFindingIds: ['f-2', 'f-1'],
    }],
    ['response recovery has no digest', {
      findingsDigest: undefined,
    }],
  ])('rejects malformed server recovery intent when %s', async (_label, mutation) => {
    const recovery = {
      mode: 'classify-response',
      signalKind: 'code-fixed',
      phase: 'code',
      round: 2,
      sourceToken: '111111111111',
      findingsDigest: 'a'.repeat(64),
      failureSignature: 'b'.repeat(64),
      responseDigest: 'c'.repeat(64),
      reason: 'coverage-gap',
      missingFindingIds: ['f-1'],
      unknownFindingIds: [],
      schemaViolationCodes: [],
      createdAt: NOW,
      ...(Object.hasOwn(mutation, 'missingFindingIds') ? mutation : {}),
      ...(Object.hasOwn(mutation, 'findingsDigest') ? mutation : {}),
    };
    await writeUnsanitizedTask(`task-bad-recovery-${_label.length}`, {
      phase: 'code',
      status: 'fixing',
      reviewRound: 2,
      signalToken: '222222222222',
      serverSignalRecovery: recovery,
      ...(!Object.hasOwn(mutation, 'missingFindingIds') && !Object.hasOwn(mutation, 'findingsDigest')
        ? mutation
        : {}),
    });
    await expect(store.get(`task-bad-recovery-${_label.length}`)).rejects.toThrow(/serverSignalRecovery/);
  });

  it('accepts code recovery for a legacy direct task whose phase is undefined', async () => {
    await writeUnsanitizedTask('task-direct-recovery', {
      phase: undefined,
      status: 'in_progress',
      reviewRound: 0,
      signalToken: '222222222222',
      serverSignalRecovery: {
        mode: 'hold',
        signalKind: 'code-done',
        phase: 'code',
        round: 0,
        sourceToken: '111111111111',
        reason: 'handler-failed',
        failurePhase: 'server-code-content-read-failed',
        createdAt: NOW,
      },
    });
    const loaded = await store.get('task-direct-recovery');
    expect(loaded?.phase).toBeUndefined();
    expect(loaded?.serverSignalRecovery).toMatchObject({ phase: 'code', round: 0 });
  });

  it('accepts spec-entry recovery before a legacy task has materialized its phase and round', async () => {
    await writeUnsanitizedTask('task-direct-spec-recovery', {
      phase: undefined,
      status: 'in_progress',
      reviewRound: 0,
      specReviewRound: undefined,
      signalToken: '222222222222',
      serverSignalRecovery: {
        mode: 'hold',
        signalKind: 'spec-done',
        phase: 'spec',
        round: 0,
        sourceToken: '111111111111',
        reason: 'handler-failed',
        failurePhase: 'server-spec-content-read-failed',
        createdAt: NOW,
      },
    });
    const loaded = await store.get('task-direct-spec-recovery');
    expect(loaded?.phase).toBeUndefined();
    expect(loaded?.serverSignalRecovery).toMatchObject({ phase: 'spec', round: 0 });
  });

  it('reviewRoundPending 持久化并校验类型：boolean 通过、字符串 "true" 抛错（#563 R24）', async () => {
    await store.set({ ...makeTask('task-rrp'), reviewRoundPending: true });
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

  it('maps the legacy reviewWorktreeMode field to reviewCheckoutMode on read', async () => {
    await writeUnsanitizedTask('task-review-checkout', {
      title: 'legacy review checkout',
      reviewWorktreeMode: 'base',
    });

    const loaded = await store.get('task-review-checkout');

    expect(loaded?.reviewCheckoutMode).toBe('base');
    expect(loaded).not.toHaveProperty('reviewWorktreeMode');
  });

  it('keeps an explicit reviewCheckoutMode over the legacy reviewWorktreeMode field', async () => {
    await writeUnsanitizedTask('task-review-checkout-both', {
      title: 'both checkout fields',
      reviewCheckoutMode: 'head',
      reviewWorktreeMode: 'base',
    });

    const loaded = await store.get('task-review-checkout-both');

    expect(loaded?.reviewCheckoutMode).toBe('head');
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
      reviewMode: 'git',
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
    reviewConversationUpdatedAt: '2026-07-19T08:00:00Z',
  };

  it('round-trips the git field family through set and get', async () => {
    await store.set(makeTask('task-400', gitFields));
    const loaded = await store.get('task-400');
    expect(loaded).toMatchObject(gitFields);
  });

  it("fails loud on an unsupported 'github' reviewMode", async () => {
    await writeUnsanitizedTask('task-invalid-mode', { reviewMode: 'github' });
    await expect(store.get('task-invalid-mode')).rejects.toThrow(/reviewMode/);
  });

  it("list() propagates an unsupported 'github' reviewMode", async () => {
    await writeUnsanitizedTask('task-invalid-mode-list', { reviewMode: 'github' });
    await expect(store.list()).rejects.toThrow(/reviewMode/);
  });

  it('fails loud when reviewMode is missing', async () => {
    await writeUnsanitizedTask('task-missing-mode', { reviewMode: undefined });
    await expect(store.get('task-missing-mode')).rejects.toThrow(/reviewMode/);
  });

  it('round-trips a server PR task with its immutable platform binding', async () => {
    const task = makeTask('task-server-pr', {
      reviewMode: 'server',
      afterDone: 'pr',
      platformBinding: { mode: 'server', repoKey: 'github.com/owner/repo', tool: 'gh' },
    });
    await store.set(task);
    expect(await store.get(task.id)).toEqual(task);
  });

  it('rejects afterDone pr without a platform binding instead of accepting a live-config backfill', async () => {
    await writeUnsanitizedTask('task-server-pr-unbound', {
      reviewMode: 'server',
      afterDone: 'pr',
    });
    await expect(store.get('task-server-pr-unbound')).rejects.toThrow(/platformBinding/);
    await expect(store.set(makeTask('task-server-pr-set', {
      reviewMode: 'server',
      afterDone: 'pr',
    }))).rejects.toThrow(/platformBinding/);
  });

  it('list() propagates a missing reviewMode', async () => {
    await writeUnsanitizedTask('task-missing-mode-list', { reviewMode: undefined });
    await expect(store.list()).rejects.toThrow(/reviewMode/);
  });

  it('list() still skips a genuinely corrupt file rather than failing the whole store', async () => {
    await writeUnsanitizedTask('task-ok', { reviewMode: 'git' });
    await writeFile(join(tasksDir, 'task-corrupt.json'), '{ not json', 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const loaded = await store.list();
    expect(loaded.map(t => t.id)).toContain('task-ok');
    expect(loaded.map(t => t.id)).not.toContain('task-corrupt');
    warn.mockRestore();
  });

  it('listStrict() returns valid tasks but fails closed when any task file is corrupt', async () => {
    await writeUnsanitizedTask('task-ok', { reviewMode: 'git' });
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
    await writeUnsanitizedTask('task-broken-schema', { reviewMode: 'github' });
    await expect(store.listStrict()).rejects.toSatisfy((error: unknown) =>
      error instanceof TaskSchemaError
      && error.message.includes('task-broken-schema.json')
      && error.message.includes('reviewMode'));
  });

  it('listStrict() skips an entry that disappears after the directory scan', async () => {
    await writeUnsanitizedTask('task-ok', { reviewMode: 'git' });
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

  it('accepts reviewMode git on load', async () => {
    await writeUnsanitizedTask('task-401', { reviewMode: 'git' });
    const loaded = await store.get('task-401');
    expect(loaded?.reviewMode).toBe('git');
  });

  it('round-trips a complete active post-approve episode', async () => {
    const episode: Partial<TaskState> = {
      reviewMode: 'git',
      status: 'approved',
      postApproveGeneration: 'feedfeedfeed',
      postApproveHeadSha: 'a'.repeat(40),
      postApproveToken: 'post-pass-1',
      postApprovePhase: 'delivered',
      pendingRedispatch: true,
      redispatchCount: 2,
    };
    await store.set(makeTask('task-episode', episode));
    expect(await store.get('task-episode')).toMatchObject(episode);
  });

  it('rejects post-approve state on a server review task', async () => {
    await writeUnsanitizedTask('task-server-episode', {
      reviewMode: 'server',
      status: 'approved',
      postApproveGeneration: 'feedfeedfeed',
      postApproveHeadSha: 'a'.repeat(40),
      postApproveToken: 'abcdef123456',
      postApprovePhase: 'installed',
      pendingRedispatch: true,
      redispatchCount: 0,
    });

    await expect(store.get('task-server-episode')).rejects.toThrow('postApproveGeneration');
  });

  it('rejects generationless legacy approved episodes', async () => {
    await writeUnsanitizedTask('task-legacy-active-episode', {
      reviewMode: 'git',
      status: 'approved',
      postApproveHeadSha: 'a'.repeat(40),
      postApproveToken: 'abcdef123456',
      postApprovePhase: 'delivered',
      pendingRedispatch: true,
    });
    await writeUnsanitizedTask('task-legacy-revoked-episode', {
      reviewMode: 'git',
      status: 'approved',
      postApproveHeadSha: 'a'.repeat(40),
      postApproveRevoked: { reason: 'request-changes', at: NOW },
    });

    await expect(store.get('task-legacy-active-episode')).rejects.toThrow('postApproveGeneration');
    await expect(store.get('task-legacy-revoked-episode')).rejects.toThrow('postApproveRevoked');
  });

  it('rejects post-approve effects outside approved even with a complete episode', async () => {
    await writeUnsanitizedTask('task-effects-outside-approved', {
      reviewMode: 'git',
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
    await store.set(makeTask('task-remote', {
      reviewMode: 'git', status: 'cancelled', remoteCleanup,
    }));
    expect((await store.get('task-remote'))?.remoteCleanup).toEqual(remoteCleanup);
  });

  it('rejects remote cleanup intents with an invalid stage contract', async () => {
    await writeUnsanitizedTask('task-remote-delete-incomplete', {
      reviewMode: 'git', status: 'cancelled',
      remoteCleanup: {
        generation: 'abc123abc123', stage: 'delete-pending', prNumber: 42,
        branch: 'bx/task-remote-delete-incomplete', updatedAt: NOW,
      },
    });
    await expect(store.get('task-remote-delete-incomplete')).rejects.toThrow('remoteCleanup');

    await writeUnsanitizedTask('task-remote-manual-incomplete', {
      reviewMode: 'git', status: 'cancelled',
      remoteCleanup: {
        generation: 'abc123abc123', stage: 'manual', prNumber: 42,
        branch: 'bx/task-remote-manual-incomplete', updatedAt: NOW,
      },
    });
    await expect(store.get('task-remote-manual-incomplete')).rejects.toThrow('remoteCleanup.failure');

    await writeUnsanitizedTask('task-remote-non-git', {
      reviewMode: 'server', status: 'cancelled',
      remoteCleanup: {
        generation: 'abc123abc123', stage: 'close-pending', prNumber: 42,
        branch: 'bx/task-remote-non-git', updatedAt: NOW,
      },
    });
    await expect(store.get('task-remote-non-git')).rejects.toThrow('remoteCleanup');
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
    await store.set(makeTask('task-lease', {
      reviewMode: 'git', status: 'review', reviewRound: 1, reviewRoundPending: true,
      signalToken: lease.signalToken, reviewHeadAnchorSha: lease.headSha,
      passToken: lease.passToken, failToken: lease.failToken, reviewDispatch: lease,
    }));
    expect((await store.get('task-lease'))?.reviewDispatch).toEqual(lease);
  });

  it('rejects the retired legacy boolean pending marker', async () => {
    await writeUnsanitizedTask('task-legacy-lease', {
      reviewMode: 'git', status: 'review', reviewDispatchPending: true,
    });
    await expect(store.get('task-legacy-lease')).rejects.toThrow('reviewDispatchPending');
  });

  it('rejects incomplete episodes and leases detached from the current tuple', async () => {
    await writeUnsanitizedTask('task-incomplete-episode', {
      reviewMode: 'git', status: 'approved', postApproveGeneration: 'feedfeedfeed',
    });
    await expect(store.get('task-incomplete-episode')).rejects.toThrow('postApproveGeneration');

    await writeUnsanitizedTask('task-detached-lease', {
      reviewMode: 'git', status: 'review', reviewRound: 1,
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
      reviewMode: 'git', status: 'review', reviewRound: 1,
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
      ['pendingRedispatch', { pendingRedispatch: 'yes' }],
      ['redispatchCount', { redispatchCount: -1 }],
    ];
    for (const [field, raw] of bad) {
      await writeUnsanitizedTask(`task-bad-${field}-${JSON.stringify(raw).length}`, raw);
      await expect(store.get(`task-bad-${field}-${JSON.stringify(raw).length}`), field).rejects.toThrow(field);
    }
  });
});
